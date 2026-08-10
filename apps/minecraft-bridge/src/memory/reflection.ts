import { createHash } from 'node:crypto'

import type {
  EpisodicMemory,
  MemoryStore,
  ReflectionCursor,
  SemanticMemory,
  SemanticRelation
} from './types.js'

const IMPORTANT_EPISODE_THRESHOLD = 5
const MIN_IMPORTANCE = 6
const MAX_BATCH_SIZE = 8
const MAX_CANDIDATES = 3
const REFLECTION_COOLDOWN_MS = 5 * 60 * 1_000
const MAX_EPISODE_SCAN = 200
const MAX_FACT_SCAN = 100
const CONTROLLED_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CANDIDATE_KEYS = [
  'subject',
  'relation',
  'object',
  'confidence',
  'evidenceEpisodeIds'
] as const
const RELATIONS = new Set<SemanticRelation>([
  'resource_observed_near',
  'landmark_observed_near',
  'danger_observed_near',
  'player_interacted_near',
  'outcome_repeated_near'
])

export interface ReflectionProviderTiming {
  inputTokens: number
  outputTokens: number
}

export interface ReflectionProviderResult {
  candidates: unknown
  timing: ReflectionProviderTiming | null
}

export interface ReflectionProvider {
  reflect(episodes: readonly EpisodicMemory[]): Promise<ReflectionProviderResult>
}

export interface ReflectionValidationResult {
  accepted: SemanticMemory[]
  rejectedCount: number
}

export interface ReflectionAttemptResult {
  attempted: boolean
  factsCreated: number
  rejectedCandidates: number
  inputTokens: number
  outputTokens: number
  error?: string
}

export interface MemoryReflectorOptions {
  store: MemoryStore
  provider: ReflectionProvider
  now?: () => number
}

export class MemoryReflector {
  private readonly store: MemoryStore
  private readonly provider: ReflectionProvider
  private readonly now: () => number

  constructor(options: MemoryReflectorOptions) {
    this.store = options.store
    this.provider = options.provider
    this.now = options.now ?? Date.now
  }

  async consider(): Promise<ReflectionAttemptResult> {
    const empty = emptyAttempt(false)
    let failedAttemptCursor: ReflectionCursor | null = null
    let attemptedAt: number | null = null
    try {
      const now = this.now()
      const cursor = await this.store.reflectionState()
      if (
        cursor.lastReflectionAt !== null &&
        now - cursor.lastReflectionAt < REFLECTION_COOLDOWN_MS
      ) {
        return empty
      }

      const recent = await this.store.listRecentEpisodes(MAX_EPISODE_SCAN)
      const unreflected = recent.filter(episode => (
        cursor.lastReflectedEpisodeTimestamp === null ||
        episode.timestamp > cursor.lastReflectedEpisodeTimestamp
      ))
      const importantCount = unreflected.filter(
        episode => episode.importance >= MIN_IMPORTANCE
      ).length
      const hasGoalCompletion = unreflected.some(
        episode => episode.type === 'goal_milestone'
      )
      if (
        importantCount < IMPORTANT_EPISODE_THRESHOLD &&
        !hasGoalCompletion
      ) {
        return empty
      }

      const batch = [...unreflected]
        .sort((left, right) => (
          left.timestamp - right.timestamp || left.id.localeCompare(right.id)
        ))
        .slice(0, MAX_BATCH_SIZE)
      if (batch.length === 0) return empty

      failedAttemptCursor = cursor
      attemptedAt = now
      const response = await this.provider.reflect(batch)
      const validation = validateReflectionCandidates(
        response.candidates,
        batch
      )
      const existingById = new Map(
        (await this.store.listSemanticFacts(MAX_FACT_SCAN)).map(fact => [fact.id, fact])
      )
      let factsCreated = 0
      for (const fact of validation.accepted) {
        const existing = existingById.get(fact.id)
        const persisted = existing ? mergeFact(existing, fact) : fact
        await this.store.addSemanticFact(persisted)
        if (!existing) {
          factsCreated += 1
        }
        existingById.set(fact.id, persisted)
      }
      await this.store.updateReflectionState({
        lastReflectedEpisodeTimestamp: Math.max(
          ...batch.map(episode => episode.timestamp)
        ),
        lastReflectionAt: now
      })
      return {
        attempted: true,
        factsCreated,
        rejectedCandidates: validation.rejectedCount,
        inputTokens: response.timing?.inputTokens ?? 0,
        outputTokens: response.timing?.outputTokens ?? 0
      }
    } catch {
      if (failedAttemptCursor && attemptedAt !== null) {
        try {
          await this.store.updateReflectionState({
            lastReflectedEpisodeTimestamp:
              failedAttemptCursor.lastReflectedEpisodeTimestamp,
            lastReflectionAt: attemptedAt
          })
        } catch {
          // The original reflection or persistence failure remains the safe result.
        }
      }
      return {
        ...emptyAttempt(true),
        error: 'Memory reflection failed.'
      }
    }
  }
}

function mergeFact(
  existing: SemanticMemory,
  reflected: SemanticMemory
): SemanticMemory {
  return {
    ...existing,
    lastObservedAt: Math.max(existing.lastObservedAt, reflected.lastObservedAt),
    confidence: Math.max(existing.confidence, reflected.confidence),
    evidenceEpisodeIds: [...new Set([
      ...existing.evidenceEpisodeIds,
      ...reflected.evidenceEpisodeIds
    ])].slice(-MAX_BATCH_SIZE)
  }
}

export function validateReflectionCandidates(
  value: unknown,
  evidence: readonly EpisodicMemory[]
): ReflectionValidationResult {
  if (!isRecord(value) || !hasExactKeys(value, ['candidates'])) {
    return { accepted: [], rejectedCount: 1 }
  }
  if (!Array.isArray(value.candidates)) {
    return { accepted: [], rejectedCount: 1 }
  }
  if (value.candidates.length > MAX_CANDIDATES) {
    return { accepted: [], rejectedCount: value.candidates.length }
  }

  const evidenceById = new Map(evidence.map(episode => [episode.id, episode]))
  const accepted: SemanticMemory[] = []
  let rejectedCount = 0
  for (const untrusted of value.candidates) {
    const candidate = decodeCandidate(untrusted, evidenceById)
    if (!candidate) {
      rejectedCount += 1
      continue
    }
    accepted.push(candidate)
  }
  return { accepted, rejectedCount }
}

function decodeCandidate(
  value: unknown,
  evidenceById: ReadonlyMap<string, EpisodicMemory>
): SemanticMemory | null {
  if (!isRecord(value) || !hasExactKeys(value, CANDIDATE_KEYS)) return null
  if (
    typeof value.subject !== 'string' ||
    !CONTROLLED_VALUE.test(value.subject) ||
    typeof value.object !== 'string' ||
    !CONTROLLED_VALUE.test(value.object) ||
    typeof value.relation !== 'string' ||
    !RELATIONS.has(value.relation as SemanticRelation) ||
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    !Array.isArray(value.evidenceEpisodeIds) ||
    value.evidenceEpisodeIds.length === 0 ||
    value.evidenceEpisodeIds.length > MAX_BATCH_SIZE ||
    !value.evidenceEpisodeIds.every(id => (
      typeof id === 'string' && CONTROLLED_VALUE.test(id)
    )) ||
    new Set(value.evidenceEpisodeIds).size !== value.evidenceEpisodeIds.length
  ) {
    return null
  }

  const relation = value.relation as SemanticRelation
  if (
    relation === 'outcome_repeated_near' &&
    value.evidenceEpisodeIds.length < 2
  ) {
    return null
  }
  const episodes = value.evidenceEpisodeIds.map(id => evidenceById.get(id))
  if (episodes.some(episode => episode === undefined)) return null
  const typedEpisodes = episodes as EpisodicMemory[]
  const first = typedEpisodes[0]
  if (!first || typedEpisodes.some(episode => (
    episode.agentId !== first.agentId || episode.worldId !== first.worldId
  ))) {
    return null
  }

  const expected = typedEpisodes.map(semanticTupleFromEpisode)
  if (expected.some(tuple => tuple === null)) return null
  if (!expected.every(tuple => (
    tuple?.subject === value.subject &&
    tuple?.relation === relation &&
    tuple?.object === value.object
  ))) {
    return null
  }

  const timestamp = Math.max(...typedEpisodes.map(episode => episode.timestamp))
  const tupleKey = `${value.subject}\0${relation}\0${value.object}`
  return {
    id: `fact-${createHash('sha256').update(tupleKey).digest('hex').slice(0, 24)}`,
    agentId: first.agentId,
    worldId: first.worldId,
    createdAt: timestamp,
    lastObservedAt: timestamp,
    subject: value.subject,
    relation,
    object: value.object,
    confidence: value.confidence,
    status: 'historical',
    contradictionCount: 0,
    evidenceEpisodeIds: [...value.evidenceEpisodeIds]
  }
}

function semanticTupleFromEpisode(episode: EpisodicMemory): {
  subject: string
  relation: SemanticRelation
  object: string
} | null {
  const object = `region:${episode.context.region}`
  switch (episode.type) {
    case 'resource_discovery':
      return episode.context.resource
        ? { subject: episode.context.resource, relation: 'resource_observed_near', object }
        : null
    case 'landmark_discovery':
      return episode.context.landmark
        ? { subject: episode.context.landmark, relation: 'landmark_observed_near', object }
        : null
    case 'threat_encounter':
      return episode.context.target
        ? { subject: episode.context.target, relation: 'danger_observed_near', object }
        : null
    case 'player_interaction':
      return episode.context.player
        ? { subject: episode.context.player, relation: 'player_interacted_near', object }
        : null
    case 'action_failure':
      return episode.context.action
        ? { subject: episode.context.action, relation: 'outcome_repeated_near', object }
        : null
    default:
      return null
  }
}

function emptyAttempt(attempted: boolean): ReflectionAttemptResult {
  return {
    attempted,
    factsCreated: 0,
    rejectedCandidates: 0,
    inputTokens: 0,
    outputTokens: 0
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every(
    (key, index) => key === sortedExpected[index]
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
