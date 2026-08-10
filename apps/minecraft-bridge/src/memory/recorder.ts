import type { GoalTransition } from '../brain/goals.js'
import type {
  AgentDecision,
  DecisionExecutionResult
} from '../brain/types.js'
import type { PerceptionSnapshot } from '../perception/types.js'
import type {
  EpisodeContext,
  EpisodeType,
  EpisodicMemory,
  MemoryIdentity
} from './types.js'

const REGION_SIZE = 32
const REGISTRY_NAME = /^[a-z0-9][a-z0-9_.:-]{0,127}$/
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/

const IGNORED_FAILURE_REASONS = new Set([
  'cancelled',
  'manual_override',
  'priority_override',
  'reflex_override',
  'replaced'
])

const NON_MATERIAL_FAILURE_ACTIONS = new Set<AgentDecision['action']>([
  'idle',
  'scan',
  'say',
  'stop'
])

export interface MemoryEventRecorderOptions {
  identity: MemoryIdentity
  idFactory?: (type: EpisodeType, timestamp: number) => string
}

export class MemoryEventRecorder {
  private readonly identity: MemoryIdentity
  private readonly idFactory: (type: EpisodeType, timestamp: number) => string
  private readonly observedDiscoveries = new Set<string>()
  private readonly visitedRegions = new Set<string>()
  private readonly craftedCapabilities = new Set<string>()
  private readonly completedGoals = new Set<string>()
  private readonly failureCounts = new Map<string, number>()
  private readonly recordedFailures = new Set<string>()
  private sequence = 0

  constructor(options: MemoryEventRecorderOptions) {
    this.identity = { ...options.identity }
    this.idFactory = options.idFactory ?? ((type, timestamp) => (
      `${type}-${timestamp}-${++this.sequence}`
    ))
  }

  observe(
    before: PerceptionSnapshot,
    after: PerceptionSnapshot,
    decision: AgentDecision,
    result: DecisionExecutionResult,
    goalTransition: GoalTransition | null
  ): EpisodicMemory[] {
    return [
      ...this.observeDiscovery(after),
      ...this.observeOutcome(before, after, decision, result, goalTransition)
    ]
  }

  observeDiscovery(perception: PerceptionSnapshot): EpisodicMemory[] {
    const region = regionForPosition(perception.position)
    const enteringNewRegion = !this.visitedRegions.has(region) &&
      this.visitedRegions.size > 0
    this.visitedRegions.add(region)
    const episodes: EpisodicMemory[] = []

    const resources = uniqueSorted(perception.nearbyBlocks
      .map(block => block.name)
      .filter(isUsefulResource))
    for (const resource of resources) {
      const noveltyKey = `resource:${resource}:${region}`
      if (!this.observedDiscoveries.has(noveltyKey)) {
        this.observedDiscoveries.add(noveltyKey)
        episodes.push(this.createEpisode(
          perception,
          'resource_discovery',
          `${resource} was observed in this region.`,
          6,
          { region, resource }
        ))
      }
    }

    if (perception.nearbyBlocks.some(block => block.name === 'crafting_table')) {
      const noveltyKey = `landmark:crafting_table:${region}`
      if (!this.observedDiscoveries.has(noveltyKey)) {
        this.observedDiscoveries.add(noveltyKey)
        episodes.push(this.createEpisode(
          perception,
          'landmark_discovery',
          'A crafting table was observed in this region.',
          7,
          { region, landmark: 'crafting_table' }
        ))
      }
    }

    const threats = uniqueSorted(perception.nearbyEntities
      .filter(entity => entity.category === 'hostile')
      .map(entity => entity.name)
      .filter(isRegistryName))
    for (const threat of threats) {
      const noveltyKey = `threat:${threat}:${region}`
      if (!this.observedDiscoveries.has(noveltyKey)) {
        this.observedDiscoveries.add(noveltyKey)
        const closest = perception.nearbyEntities.find(entity => (
          entity.category === 'hostile' && entity.name === threat
        ))
        episodes.push(this.createEpisode(
          perception,
          'threat_encounter',
          `${threat} was encountered in this region.`,
          threat === 'creeper' && (closest?.distance ?? Infinity) <= 6 ? 9 : 7,
          { region, target: threat }
        ))
      }
    }

    const players = uniqueSorted(perception.nearbyEntities
      .filter(entity => entity.type === 'player' && entity.name !== perception.agent)
      .map(entity => entity.name)
      .filter(isPlayerName))
    for (const player of players) {
      const noveltyKey = `player:${player}:${region}`
      if (!this.observedDiscoveries.has(noveltyKey)) {
        this.observedDiscoveries.add(noveltyKey)
        episodes.push(this.createEpisode(
          perception,
          'player_interaction',
          `Player ${player} was observed in this region.`,
          4,
          { region, player }
        ))
      }
    }

    if (enteringNewRegion && episodes.length > 0) {
      episodes.push(this.createEpisode(
        perception,
        'exploration_discovery',
        'A new region with useful observations was explored.',
        5,
        { region }
      ))
    }

    return episodes
  }

  observeOutcome(
    before: PerceptionSnapshot,
    after: PerceptionSnapshot,
    decision: AgentDecision,
    result: DecisionExecutionResult,
    goalTransition: GoalTransition | null
  ): EpisodicMemory[] {
    const episodes: EpisodicMemory[] = []
    const region = regionForPosition(after.position)

    if (
      decision.action === 'craft_item' &&
      result.success &&
      result.status === 'completed' &&
      isCapabilityItem(decision.item) &&
      inventoryCount(after, decision.item) > inventoryCount(before, decision.item) &&
      !this.craftedCapabilities.has(decision.item)
    ) {
      this.craftedCapabilities.add(decision.item)
      episodes.push(this.createEpisode(
        after,
        'successful_craft',
        `${decision.item} was crafted successfully.`,
        7,
        { region, action: decision.action, target: decision.item, outcome: 'completed' }
      ))
    }

    const completedGoal = goalTransition?.completedGoal
    if (completedGoal) {
      const goalKey = `${completedGoal.type}:${region}`
      if (!this.completedGoals.has(goalKey)) {
        this.completedGoals.add(goalKey)
        episodes.push(this.createEpisode(
          after,
          'goal_milestone',
          `${completedGoal.type} was completed in this region.`,
          8,
          { region, goalType: completedGoal.type, outcome: 'completed' }
        ))
      }
    }

    const failureReason = controlledFailureReason(result)
    if (
      !result.success &&
      result.status === 'failed' &&
      !NON_MATERIAL_FAILURE_ACTIONS.has(decision.action) &&
      !IGNORED_FAILURE_REASONS.has(failureReason)
    ) {
      const target = decisionTarget(decision)
      const signature = failureSignatureFor(
        decision.action,
        target,
        failureReason,
        region
      )
      const count = (this.failureCounts.get(signature) ?? 0) + 1
      this.failureCounts.set(signature, count)
      if (count >= 2 && !this.recordedFailures.has(signature)) {
        this.recordedFailures.add(signature)
        episodes.push(this.createEpisode(
          after,
          'action_failure',
          `${decision.action} repeatedly failed for ${target} in this region.`,
          6,
          {
            region,
            action: decision.action,
            target,
            outcome: failureReason
          }
        ))
      }
    }

    return episodes
  }

  private createEpisode(
    perception: PerceptionSnapshot,
    type: EpisodeType,
    summary: string,
    importance: number,
    context: EpisodeContext
  ): EpisodicMemory {
    return {
      id: this.idFactory(type, perception.timestamp),
      ...this.identity,
      timestamp: perception.timestamp,
      type,
      summary,
      importance,
      source: type === 'successful_craft' ||
        type === 'action_failure' ||
        type === 'goal_milestone'
        ? type === 'goal_milestone' ? 'goal' : 'action'
        : 'perception',
      context: {
        ...context,
        position: { ...perception.position }
      }
    }
  }
}

export function regionForPosition(
  position: Pick<PerceptionSnapshot['position'], 'x' | 'z'>
): string {
  return `${Math.floor(position.x / REGION_SIZE)}:${Math.floor(position.z / REGION_SIZE)}`
}

export function failureSignatureFor(
  action: string,
  target: string,
  reason: string,
  region: string
): string {
  return `${action}:${target}:${reason}:${region}`
}

function isUsefulResource(name: string): boolean {
  return isRegistryName(name) && (
    name === 'bamboo' ||
    name === 'bamboo_block' ||
    name === 'stone' ||
    name === 'cobblestone' ||
    name.endsWith('_log') ||
    name.endsWith('_wood') ||
    name.endsWith('_stem') ||
    name.endsWith('_hyphae') ||
    name.endsWith('_ore')
  )
}

function isCapabilityItem(name: string): boolean {
  return isRegistryName(name) && (
    name === 'crafting_table' ||
    name === 'furnace' ||
    name === 'shield' ||
    /_(?:axe|hoe|pickaxe|shovel|sword)$/.test(name)
  )
}

function isRegistryName(value: string): boolean {
  return REGISTRY_NAME.test(value)
}

function isPlayerName(value: string): boolean {
  return PLAYER_NAME.test(value)
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function inventoryCount(perception: PerceptionSnapshot, item: string): number {
  return perception.inventory
    .filter(entry => entry.name === item)
    .reduce((total, entry) => total + entry.count, 0)
}

function controlledFailureReason(result: DecisionExecutionResult): string {
  const reason = result.details?.reason
  return typeof reason === 'string' && isRegistryName(reason)
    ? reason
    : 'failed'
}

function decisionTarget(decision: AgentDecision): string {
  switch (decision.action) {
    case 'collect_block':
    case 'place_block':
      return decision.block
    case 'craft_item':
      return decision.item
    case 'follow_player':
    case 'come_to_player':
      return decision.username
    default:
      return decision.action
  }
}
