import type {
  CompactEpisode,
  CompactFact,
  EpisodicMemory,
  FactPerceptionEvidence,
  MemoryAge,
  MemoryContext,
  MemoryQuery,
  SemanticMemory
} from './types.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MAX_RETRIEVAL_LIMIT = 6

const GOAL_EPISODE_TYPES: Readonly<Record<string, ReadonlySet<EpisodicMemory['type']>>> = {
  establish_basic_resources: new Set([
    'resource_discovery',
    'successful_craft',
    'goal_milestone'
  ]),
  improve_tooling: new Set([
    'resource_discovery',
    'successful_craft',
    'action_failure'
  ]),
  improve_safety: new Set([
    'threat_encounter',
    'action_failure',
    'goal_milestone'
  ]),
  explore_for_resources: new Set([
    'resource_discovery',
    'landmark_discovery',
    'exploration_discovery'
  ])
}

const GOAL_FACT_RELATIONS: Readonly<Record<string, ReadonlySet<SemanticMemory['relation']>>> = {
  establish_basic_resources: new Set([
    'resource_observed_near',
    'landmark_observed_near',
    'outcome_repeated_near'
  ]),
  improve_tooling: new Set([
    'resource_observed_near',
    'outcome_repeated_near'
  ]),
  improve_safety: new Set([
    'danger_observed_near',
    'outcome_repeated_near'
  ]),
  explore_for_resources: new Set([
    'resource_observed_near',
    'landmark_observed_near',
    'danger_observed_near'
  ])
}

const SPATIALLY_RECONCILABLE_RELATIONS = new Set<SemanticMemory['relation']>([
  'resource_observed_near',
  'landmark_observed_near'
])

export const EMPTY_MEMORY_CONTEXT: MemoryContext = Object.freeze({
  recentEpisodes: Object.freeze([] as CompactEpisode[]),
  relevantFacts: Object.freeze([] as CompactFact[])
})

export function rankEpisodes(
  episodes: readonly EpisodicMemory[],
  query: MemoryQuery
): EpisodicMemory[] {
  const limit = retrievalLimit(query.episodeLimit)
  return episodes
    .filter(episode => matchesIdentity(episode, query))
    .map(episode => ({ episode, score: episodeScore(episode, query) }))
    .sort((left, right) => (
      right.score - left.score ||
      right.episode.timestamp - left.episode.timestamp ||
      left.episode.id.localeCompare(right.episode.id)
    ))
    .slice(0, limit)
    .map(({ episode }) => cloneEpisode(episode))
}

export function rankSemanticFacts(
  facts: readonly SemanticMemory[],
  query: MemoryQuery
): SemanticMemory[] {
  const limit = retrievalLimit(query.factLimit)
  return facts
    .filter(fact => matchesIdentity(fact, query))
    .map(fact => ({ fact, score: factScore(fact, query) }))
    .sort((left, right) => (
      right.score - left.score ||
      right.fact.lastObservedAt - left.fact.lastObservedAt ||
      left.fact.id.localeCompare(right.fact.id)
    ))
    .slice(0, limit)
    .map(({ fact }) => cloneFact(fact))
}

export function compactEpisode(
  episode: EpisodicMemory,
  now: number
): CompactEpisode {
  return {
    type: episode.type,
    summary: episode.summary,
    importance: episode.importance,
    age: ageBucket(episode.timestamp, now),
    ...(episode.context.region ? { region: episode.context.region } : {})
  }
}

export function compactFact(
  fact: SemanticMemory,
  now: number
): CompactFact {
  return {
    subject: fact.subject,
    relation: fact.relation,
    object: fact.object,
    confidence: fact.confidence,
    status: fact.status,
    age: ageBucket(fact.lastObservedAt, now)
  }
}

export function reconcileFactWithPerception(
  fact: SemanticMemory,
  evidence: FactPerceptionEvidence
): SemanticMemory {
  const result = cloneFact(fact)
  if (
    !SPATIALLY_RECONCILABLE_RELATIONS.has(fact.relation) ||
    !evidence.regionCovered ||
    rememberedRegion(fact) !== evidence.region
  ) {
    return result
  }

  if (evidence.observedNames.includes(fact.subject)) {
    return {
      ...result,
      lastObservedAt: evidence.observedAt,
      confidence: boundedConfidence(fact.confidence + 0.2),
      status: 'historical',
      contradictionCount: 0
    }
  }

  const contradictionCount = Math.min(fact.contradictionCount + 1, 1000)
  return {
    ...result,
    confidence: boundedConfidence(fact.confidence - 0.2),
    status: contradictionCount >= 2 ? 'stale' : fact.status,
    contradictionCount
  }
}

function episodeScore(
  episode: EpisodicMemory,
  query: MemoryQuery
): number {
  const goalTypes = query.goalType ? GOAL_EPISODE_TYPES[query.goalType] : undefined
  const contextNames = episodeContextNames(episode)
  return episode.importance * 100 +
    (goalTypes?.has(episode.type) ? 60 : 0) +
    (contextNames.some(name => query.observedNames.includes(name)) ? 50 : 0) +
    (episode.context.region === query.region ? 40 : 0) +
    (query.recentFailureSignatures.includes(failureSignature(episode)) ? 80 : 0) +
    recencyScore(episode.timestamp, query.now)
}

function factScore(fact: SemanticMemory, query: MemoryQuery): number {
  const goalRelations = query.goalType
    ? GOAL_FACT_RELATIONS[query.goalType]
    : undefined
  return Math.round(fact.confidence * 100) +
    (goalRelations?.has(fact.relation) ? 40 : 0) +
    (query.observedNames.includes(fact.subject) ? 60 : 0) +
    (rememberedRegion(fact) === query.region ? 40 : 0) +
    (fact.status === 'stale' ? -60 : 0) +
    recencyScore(fact.lastObservedAt, query.now)
}

function episodeContextNames(episode: EpisodicMemory): string[] {
  return [
    episode.context.resource,
    episode.context.landmark,
    episode.context.player,
    episode.context.target,
    episode.context.goalType
  ].filter((value): value is string => value !== undefined)
}

function failureSignature(episode: EpisodicMemory): string {
  if (episode.type !== 'action_failure') return ''
  return [
    episode.context.action ?? '',
    episode.context.target ?? '',
    episode.context.outcome ?? '',
    episode.context.region
  ].join(':')
}

function rememberedRegion(fact: SemanticMemory): string | null {
  if (fact.object.startsWith('region:')) return fact.object.slice('region:'.length)
  return /^-?\d+:-?\d+$/.test(fact.object) ? fact.object : null
}

function recencyScore(timestamp: number, now: number): number {
  const age = Math.max(0, now - timestamp)
  if (age <= 5 * MINUTE) return 30
  if (age <= HOUR) return 20
  if (age <= DAY) return 10
  return 0
}

function ageBucket(timestamp: number, now: number): MemoryAge {
  const age = Math.max(0, now - timestamp)
  if (age <= 5 * MINUTE) return 'current'
  if (age <= HOUR) return 'recent'
  if (age <= DAY) return 'today'
  return 'older'
}

function retrievalLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_RETRIEVAL_LIMIT) {
    throw new RangeError('Memory retrieval limit must be an integer from 1 to 6.')
  }
  return value
}

function boundedConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 10) / 10
}

function matchesIdentity(
  value: { agentId: string; worldId: string },
  query: MemoryQuery
): boolean {
  return value.agentId === query.agentId && value.worldId === query.worldId
}

function cloneEpisode(episode: EpisodicMemory): EpisodicMemory {
  return {
    ...episode,
    context: {
      ...episode.context,
      ...(episode.context.position
        ? { position: { ...episode.context.position } }
        : {})
    }
  }
}

function cloneFact(fact: SemanticMemory): SemanticMemory {
  return {
    ...fact,
    evidenceEpisodeIds: [...fact.evidenceEpisodeIds]
  }
}
