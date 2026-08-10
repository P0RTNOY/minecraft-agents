import { createHash } from 'node:crypto'

import type { GoalTransition } from '../brain/goals.js'
import type {
  AgentDecision,
  BrainInput,
  DecisionExecutionResult
} from '../brain/types.js'
import type { PerceptionSnapshot } from '../perception/types.js'
import {
  compactEpisode,
  compactFact,
  EMPTY_MEMORY_CONTEXT,
  reconcileFactWithPerception
} from './retrieval.js'
import {
  failureSignatureFor,
  MemoryEventRecorder,
  regionForPosition
} from './recorder.js'
import type {
  MemoryReflector,
  ReflectionAttemptResult
} from './reflection.js'
import type {
  EpisodicMemory,
  MemoryContext,
  MemoryIdentity,
  MemoryQuery,
  MemoryStore,
  SemanticMemory,
  SemanticRelation
} from './types.js'
import { MemoryStoreValidationError } from './validate.js'

const MAX_FACT_SCAN = 100
const MAX_EPISODE_SCAN = 200
const MAX_EVIDENCE_IDS = 8
const CONTROLLED_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

type BrainInputWithoutMemory = Omit<BrainInput, 'memory'>

export interface MemoryCycleEvent {
  before: PerceptionSnapshot
  after: PerceptionSnapshot
  decision: AgentDecision
  result: DecisionExecutionResult
  goalTransition: GoalTransition | null
}

export interface MemoryMetrics {
  episodesCreated: number
  episodesRetrieved: number
  semanticFactsCreated: number
  semanticFactsRetrieved: number
  retrievalFailures: number
  persistenceFailures: number
  reflectionCalls: number
  reflectionFailures: number
  reflectionInputTokens: number
  reflectionOutputTokens: number
  estimatedMemoryPromptTokens: number
}

export interface MemoryRetrievalResult {
  context: MemoryContext
  error?: string
}

export interface MemoryRecordResult {
  episodesCreated: number
  semanticFactsCreated: number
  error?: string
}

export interface AgentMemory {
  retrieve(input: BrainInputWithoutMemory): Promise<MemoryRetrievalResult>
  record(event: MemoryCycleEvent): Promise<MemoryRecordResult>
  metrics(): MemoryMetrics
}

export interface MemoryCoordinatorLogger {
  log(message: string): void
  error(message: string): void
}

export interface AgentMemoryCoordinatorOptions {
  store: MemoryStore
  recorder: Pick<MemoryEventRecorder, 'observe'>
  identity: MemoryIdentity
  episodeLimit?: number
  factLimit?: number
  debug?: boolean
  logger?: MemoryCoordinatorLogger
  reflector?: Pick<MemoryReflector, 'consider'>
}

export class AgentMemoryCoordinator implements AgentMemory {
  private readonly store: MemoryStore
  private readonly recorder: Pick<MemoryEventRecorder, 'observe'>
  private readonly identity: MemoryIdentity
  private readonly episodeLimit: number
  private readonly factLimit: number
  private readonly debug: boolean
  private readonly logger: MemoryCoordinatorLogger
  private readonly reflector: Pick<MemoryReflector, 'consider'> | null
  private readonly counters: MemoryMetrics = {
    episodesCreated: 0,
    episodesRetrieved: 0,
    semanticFactsCreated: 0,
    semanticFactsRetrieved: 0,
    retrievalFailures: 0,
    persistenceFailures: 0,
    reflectionCalls: 0,
    reflectionFailures: 0,
    reflectionInputTokens: 0,
    reflectionOutputTokens: 0,
    estimatedMemoryPromptTokens: 0
  }

  constructor(options: AgentMemoryCoordinatorOptions) {
    this.store = options.store
    this.recorder = options.recorder
    this.identity = { ...options.identity }
    this.episodeLimit = retrievalLimit(options.episodeLimit ?? 4)
    this.factLimit = retrievalLimit(options.factLimit ?? 4)
    this.debug = options.debug ?? false
    this.logger = options.logger ?? console
    this.reflector = options.reflector ?? null
  }

  async retrieve(
    input: BrainInputWithoutMemory
  ): Promise<MemoryRetrievalResult> {
    try {
      const query = buildMemoryQuery(
        input,
        this.identity,
        this.episodeLimit,
        this.factLimit
      )
      await this.reconcileCurrentPerception(input.perception)
      const [episodes, facts] = await Promise.all([
        this.store.findRelevantEpisodes(query),
        this.store.findRelevantFacts(query)
      ])
      const context: MemoryContext = {
        recentEpisodes: episodes.map(episode => compactEpisode(episode, query.now)),
        relevantFacts: facts.map(fact => compactFact(fact, query.now))
      }
      this.counters.episodesRetrieved += episodes.length
      this.counters.semanticFactsRetrieved += facts.length
      this.counters.estimatedMemoryPromptTokens += Math.ceil(
        JSON.stringify(context).length / 4
      )
      if (this.debug) {
        this.logger.log(
          `🧠 Memory: retrieved ${episodes.length} episodes / ${facts.length} facts`
        )
      }
      return { context }
    } catch (error) {
      this.counters.retrievalFailures += 1
      const message = safeMemoryError(error)
      if (this.debug) this.logger.error(`🧠 Memory retrieval failed: ${message}`)
      return { context: EMPTY_MEMORY_CONTEXT, error: message }
    }
  }

  async record(event: MemoryCycleEvent): Promise<MemoryRecordResult> {
    let episodesCreated = 0
    let semanticFactsCreated = 0
    try {
      const episodes = this.recorder.observe(
        event.before,
        event.after,
        event.decision,
        event.result,
        event.goalTransition
      )
      if (episodes.length === 0) {
        return { episodesCreated, semanticFactsCreated }
      }
      const knownEpisodes = await this.store.listRecentEpisodes(MAX_EPISODE_SCAN)
      const storedEpisodes: EpisodicMemory[] = []
      for (const episode of episodes) {
        const noveltyKey = episodeNoveltyKey(episode)
        const existing = knownEpisodes.find(known => (
          episodeNoveltyKey(known) === noveltyKey
        ))
        const persistedEpisode = existing ?? episode
        if (!existing) {
          await this.store.addEpisode(episode)
          knownEpisodes.push(episode)
          storedEpisodes.push(episode)
          episodesCreated += 1
        }
        const fact = semanticFactFromEpisode(persistedEpisode)
        if (!fact) continue
        const created = await this.upsertSemanticFact(fact)
        if (created) semanticFactsCreated += 1
      }
      this.counters.episodesCreated += episodesCreated
      this.counters.semanticFactsCreated += semanticFactsCreated
      if (this.debug) {
        for (const episode of storedEpisodes) {
          this.logger.log(`🧠 Memory: stored episode [${episode.type}]`)
        }
      }
      const reflection = await this.considerReflection()
      semanticFactsCreated += reflection.factsCreated
      this.counters.semanticFactsCreated += reflection.factsCreated
      if (this.debug && reflection.factsCreated > 0) {
        const label = reflection.factsCreated === 1 ? 'fact' : 'facts'
        this.logger.log(
          `🧠 Reflection: created ${reflection.factsCreated} semantic ${label}`
        )
      }
      return { episodesCreated, semanticFactsCreated }
    } catch (error) {
      this.counters.episodesCreated += episodesCreated
      this.counters.semanticFactsCreated += semanticFactsCreated
      this.counters.persistenceFailures += 1
      const message = safeMemoryError(error)
      if (this.debug) this.logger.error(`🧠 Memory persistence failed: ${message}`)
      return { episodesCreated, semanticFactsCreated, error: message }
    }
  }

  metrics(): MemoryMetrics {
    return { ...this.counters }
  }

  private async considerReflection(): Promise<ReflectionAttemptResult> {
    if (!this.reflector) {
      return {
        attempted: false,
        factsCreated: 0,
        rejectedCandidates: 0,
        inputTokens: 0,
        outputTokens: 0
      }
    }
    let result: ReflectionAttemptResult
    try {
      result = await this.reflector.consider()
    } catch {
      result = {
        attempted: true,
        factsCreated: 0,
        rejectedCandidates: 0,
        inputTokens: 0,
        outputTokens: 0,
        error: 'Memory reflection failed.'
      }
    }
    if (result.attempted) this.counters.reflectionCalls += 1
    if (result.error) this.counters.reflectionFailures += 1
    this.counters.reflectionInputTokens += result.inputTokens
    this.counters.reflectionOutputTokens += result.outputTokens
    if (this.debug && result.error) {
      this.logger.error(`🧠 Reflection failed: ${result.error}`)
    }
    return result
  }

  private async reconcileCurrentPerception(
    perception: PerceptionSnapshot
  ): Promise<void> {
    const current = await this.store.listSemanticFacts(MAX_FACT_SCAN)
    const observedNames = observedWorldNamesFrom(perception)
    const region = regionForPosition(perception.position)
    for (const fact of current) {
      const reconciled = reconcileFactWithPerception(fact, {
        observedAt: perception.timestamp,
        region,
        regionCovered: true,
        observedNames
      })
      if (!sameFactState(fact, reconciled)) {
        await this.store.addSemanticFact(reconciled)
      }
    }
  }

  private async upsertSemanticFact(
    candidate: SemanticMemory
  ): Promise<boolean> {
    const facts = await this.store.listSemanticFacts(MAX_FACT_SCAN)
    const existing = facts.find(fact => (
      fact.subject === candidate.subject &&
      fact.relation === candidate.relation &&
      fact.object === candidate.object
    ))
    if (!existing) {
      await this.store.addSemanticFact(candidate)
      return true
    }

    const mergedEvidence = [...new Set([
      ...existing.evidenceEpisodeIds,
      ...candidate.evidenceEpisodeIds
    ])].slice(-MAX_EVIDENCE_IDS)
    const hasNewEvidence = candidate.evidenceEpisodeIds.some(id => (
      !existing.evidenceEpisodeIds.includes(id)
    ))
    const updated: SemanticMemory = {
      ...existing,
      lastObservedAt: Math.max(existing.lastObservedAt, candidate.lastObservedAt),
      confidence: boundedConfidence(Math.max(
        candidate.confidence,
        existing.confidence + (hasNewEvidence ? 0.1 : 0)
      )),
      status: 'historical',
      contradictionCount: 0,
      evidenceEpisodeIds: mergedEvidence
    }
    if (!sameCompleteFact(existing, updated)) {
      await this.store.addSemanticFact(updated)
    }
    return false
  }
}

export function semanticFactFromEpisode(
  episode: EpisodicMemory
): SemanticMemory | null {
  const fields = semanticFields(episode)
  if (!fields) return null
  const object = `region:${episode.context.region}`
  const tuple = `${fields.subject}\0${fields.relation}\0${object}`
  return {
    id: `fact-${createHash('sha256').update(tuple).digest('hex').slice(0, 24)}`,
    agentId: episode.agentId,
    worldId: episode.worldId,
    createdAt: episode.timestamp,
    lastObservedAt: episode.timestamp,
    subject: fields.subject,
    relation: fields.relation,
    object,
    confidence: fields.confidence,
    status: 'historical',
    contradictionCount: 0,
    evidenceEpisodeIds: [episode.id]
  }
}

function semanticFields(episode: EpisodicMemory): {
  subject: string
  relation: SemanticRelation
  confidence: number
} | null {
  switch (episode.type) {
    case 'resource_discovery':
      return episode.context.resource
        ? {
            subject: episode.context.resource,
            relation: 'resource_observed_near',
            confidence: 0.8
          }
        : null
    case 'landmark_discovery':
      return episode.context.landmark
        ? {
            subject: episode.context.landmark,
            relation: 'landmark_observed_near',
            confidence: 0.9
          }
        : null
    case 'threat_encounter':
      return episode.context.target
        ? {
            subject: episode.context.target,
            relation: 'danger_observed_near',
            confidence: 0.8
          }
        : null
    case 'player_interaction':
      return episode.context.player
        ? {
            subject: episode.context.player,
            relation: 'player_interacted_near',
            confidence: 0.7
          }
        : null
    default:
      return null
  }
}

function episodeNoveltyKey(episode: EpisodicMemory): string {
  const region = episode.context.region
  switch (episode.type) {
    case 'resource_discovery':
      return `${episode.type}:${episode.context.resource ?? ''}:${region}`
    case 'landmark_discovery':
      return `${episode.type}:${episode.context.landmark ?? ''}:${region}`
    case 'threat_encounter':
      return `${episode.type}:${episode.context.target ?? ''}:${region}`
    case 'player_interaction':
      return `${episode.type}:${episode.context.player ?? ''}:${region}`
    case 'successful_craft':
      return `${episode.type}:${episode.context.target ?? ''}`
    case 'action_failure':
      return [
        episode.type,
        episode.context.action ?? '',
        episode.context.target ?? '',
        episode.context.outcome ?? '',
        region
      ].join(':')
    case 'goal_milestone':
      return `${episode.type}:${episode.context.goalType ?? ''}:${region}`
    case 'exploration_discovery':
      return `${episode.type}:${region}`
  }
}

function buildMemoryQuery(
  input: BrainInputWithoutMemory,
  identity: MemoryIdentity,
  episodeLimit: number,
  factLimit: number
): MemoryQuery {
  const region = regionForPosition(input.perception.position)
  return {
    ...identity,
    now: input.perception.timestamp,
    region,
    goalType: input.shortTermGoal?.type ?? null,
    observedNames: observedNamesFrom(input.perception),
    recentFailureSignatures: input.recentDecisions
      .filter(item => !item.result.success && item.result.status === 'failed')
      .map(item => failureSignatureFor(
        item.decision.action,
        decisionTarget(item.decision),
        controlledReason(item.result),
        region
      )),
    episodeLimit,
    factLimit
  }
}

function observedNamesFrom(perception: PerceptionSnapshot): string[] {
  return [...new Set([
    ...perception.nearbyBlocks.map(item => item.name),
    ...perception.nearbyEntities.map(item => item.name),
    ...perception.inventory.map(item => item.name),
    ...perception.craftableItems.map(item => item.item),
    ...perception.placeableBlocks.map(item => item.name),
    ...(perception.nearbyCraftingTable ? ['crafting_table'] : [])
  ])].sort((left, right) => left.localeCompare(right))
}

function observedWorldNamesFrom(perception: PerceptionSnapshot): string[] {
  return [...new Set([
    ...perception.nearbyBlocks.map(item => item.name),
    ...perception.nearbyEntities.map(item => item.name),
    ...(perception.nearbyCraftingTable ? ['crafting_table'] : [])
  ])].sort((left, right) => left.localeCompare(right))
}

function controlledReason(result: DecisionExecutionResult): string {
  const reason = result.details?.reason
  return typeof reason === 'string' && CONTROLLED_VALUE.test(reason)
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

function sameFactState(left: SemanticMemory, right: SemanticMemory): boolean {
  return left.lastObservedAt === right.lastObservedAt &&
    left.confidence === right.confidence &&
    left.status === right.status &&
    left.contradictionCount === right.contradictionCount
}

function sameCompleteFact(left: SemanticMemory, right: SemanticMemory): boolean {
  return sameFactState(left, right) &&
    left.evidenceEpisodeIds.length === right.evidenceEpisodeIds.length &&
    left.evidenceEpisodeIds.every((id, index) => (
      id === right.evidenceEpisodeIds[index]
    ))
}

function boundedConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 10) / 10
}

function retrievalLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 6) {
    throw new RangeError('Memory retrieval limit must be an integer from 1 to 6.')
  }
  return value
}

function safeMemoryError(error: unknown): string {
  return error instanceof MemoryStoreValidationError
    ? error.message
    : 'Memory store operation failed.'
}
