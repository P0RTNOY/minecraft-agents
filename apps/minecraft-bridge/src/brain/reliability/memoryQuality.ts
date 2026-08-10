import type { BrainInput } from '../types.js'
import type {
  CompactEpisode,
  CompactFact,
  EpisodeType,
  SemanticRelation
} from '../../memory/types.js'
import { regionForPosition } from '../../memory/recorder.js'

export type MemoryRelevanceClassification =
  | 'directly_relevant'
  | 'weakly_relevant'
  | 'irrelevant'
  | 'stale_or_contradicted'

export type MemoryRelevanceSignal =
  | 'current_region'
  | 'observed_name'
  | 'active_goal_category'
  | 'stale_status'

export interface MemoryRetrievalTraceItem {
  kind: 'episode' | 'fact'
  label: EpisodeType | SemanticRelation
  classification: MemoryRelevanceClassification
  signals: MemoryRelevanceSignal[]
}

export interface MemoryRetrievalQualityCounts {
  directlyRelevant: number
  weaklyRelevant: number
  irrelevant: number
  staleOrContradicted: number
  total: number
}

export interface MemoryRetrievalAssessment {
  counts: MemoryRetrievalQualityCounts
  items: MemoryRetrievalTraceItem[]
}

const GOAL_EPISODES: Record<
  NonNullable<BrainInput['shortTermGoal']>['type'],
  ReadonlySet<EpisodeType>
> = {
  establish_basic_resources: new Set([
    'resource_discovery',
    'landmark_discovery',
    'successful_craft',
    'action_failure',
    'exploration_discovery'
  ]),
  improve_tooling: new Set([
    'resource_discovery',
    'landmark_discovery',
    'successful_craft',
    'action_failure',
    'exploration_discovery'
  ]),
  improve_safety: new Set([
    'landmark_discovery',
    'threat_encounter',
    'action_failure',
    'goal_milestone'
  ]),
  explore_for_resources: new Set([
    'resource_discovery',
    'landmark_discovery',
    'threat_encounter',
    'action_failure',
    'exploration_discovery'
  ])
}

const GOAL_FACTS: Record<
  NonNullable<BrainInput['shortTermGoal']>['type'],
  ReadonlySet<SemanticRelation>
> = {
  establish_basic_resources: new Set([
    'resource_observed_near',
    'landmark_observed_near',
    'outcome_repeated_near'
  ]),
  improve_tooling: new Set([
    'resource_observed_near',
    'landmark_observed_near',
    'outcome_repeated_near'
  ]),
  improve_safety: new Set([
    'landmark_observed_near',
    'danger_observed_near',
    'outcome_repeated_near'
  ]),
  explore_for_resources: new Set([
    'resource_observed_near',
    'landmark_observed_near',
    'danger_observed_near',
    'outcome_repeated_near'
  ])
}

export function assessMemoryRetrieval(
  input: BrainInput
): MemoryRetrievalAssessment {
  const activeNames = observedNames(input)
  const currentRegion = regionForPosition(input.perception.position)
  const items = [
    ...input.memory.recentEpisodes.map(episode => assessEpisode(
      episode,
      activeNames,
      currentRegion,
      input.shortTermGoal?.type ?? null
    )),
    ...input.memory.relevantFacts.map(fact => assessFact(
      fact,
      activeNames,
      currentRegion,
      input.shortTermGoal?.type ?? null
    ))
  ]
  const counts: MemoryRetrievalQualityCounts = {
    directlyRelevant: 0,
    weaklyRelevant: 0,
    irrelevant: 0,
    staleOrContradicted: 0,
    total: items.length
  }
  for (const item of items) {
    switch (item.classification) {
      case 'directly_relevant': counts.directlyRelevant += 1; break
      case 'weakly_relevant': counts.weaklyRelevant += 1; break
      case 'irrelevant': counts.irrelevant += 1; break
      case 'stale_or_contradicted': counts.staleOrContradicted += 1; break
    }
  }
  return { counts, items }
}

function assessEpisode(
  episode: CompactEpisode,
  activeNames: ReadonlySet<string>,
  currentRegion: string,
  goalType: NonNullable<BrainInput['shortTermGoal']>['type'] | null
): MemoryRetrievalTraceItem {
  const signals: MemoryRelevanceSignal[] = []
  if (episode.region === currentRegion) signals.push('current_region')
  if (tokens(episode.summary).some(token => activeNames.has(token))) {
    signals.push('observed_name')
  }
  if (
    signals.length === 0 &&
    goalType &&
    GOAL_EPISODES[goalType].has(episode.type)
  ) {
    signals.push('active_goal_category')
  }
  return {
    kind: 'episode',
    label: episode.type,
    classification: classifySignals(signals),
    signals
  }
}

function assessFact(
  fact: CompactFact,
  activeNames: ReadonlySet<string>,
  currentRegion: string,
  goalType: NonNullable<BrainInput['shortTermGoal']>['type'] | null
): MemoryRetrievalTraceItem {
  if (fact.status === 'stale') {
    return {
      kind: 'fact',
      label: fact.relation,
      classification: 'stale_or_contradicted',
      signals: ['stale_status']
    }
  }
  const signals: MemoryRelevanceSignal[] = []
  if (fact.object === `region:${currentRegion}`) signals.push('current_region')
  if (activeNames.has(fact.subject)) signals.push('observed_name')
  if (
    signals.length === 0 &&
    goalType &&
    GOAL_FACTS[goalType].has(fact.relation)
  ) {
    signals.push('active_goal_category')
  }
  return {
    kind: 'fact',
    label: fact.relation,
    classification: classifySignals(signals),
    signals
  }
}

function classifySignals(
  signals: readonly MemoryRelevanceSignal[]
): MemoryRelevanceClassification {
  if (
    signals.includes('current_region') ||
    signals.includes('observed_name')
  ) {
    return 'directly_relevant'
  }
  return signals.includes('active_goal_category')
    ? 'weakly_relevant'
    : 'irrelevant'
}

function observedNames(input: BrainInput): ReadonlySet<string> {
  return new Set([
    ...input.perception.nearbyBlocks.map(item => item.name),
    ...input.perception.nearbyEntities.map(item => item.name),
    ...input.perception.inventory.map(item => item.name),
    ...input.perception.craftableItems.map(item => item.item),
    ...input.perception.placeableBlocks.map(item => item.name),
    ...input.availableCapabilities.observedCollectableBlocks,
    ...input.availableCapabilities.craftableItems.map(item => item.item),
    ...input.availableCapabilities.placeableBlocks.map(item => item.name),
    ...(input.perception.nearbyCraftingTable ? ['crafting_table'] : [])
  ])
}

function tokens(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9_]+/g) ?? []
}
