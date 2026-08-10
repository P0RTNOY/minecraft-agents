import {
  DEFAULT_MAX_EPISODES,
  DEFAULT_MAX_SEMANTIC_FACTS,
  MEMORY_SCHEMA_VERSION,
  type EpisodeContext,
  type EpisodeSource,
  type EpisodeType,
  type EpisodicMemory,
  type MemoryDocumentV1,
  type MemoryIdentity,
  type ReflectionCursor,
  type SemanticMemory,
  type SemanticRelation
} from './types.js'

const EPISODE_TYPES = new Set<EpisodeType>([
  'resource_discovery',
  'landmark_discovery',
  'successful_craft',
  'action_failure',
  'threat_encounter',
  'player_interaction',
  'goal_milestone',
  'exploration_discovery'
])

const EPISODE_SOURCES = new Set<EpisodeSource>([
  'perception',
  'action',
  'goal',
  'reflex',
  'player'
])

const SEMANTIC_RELATIONS = new Set<SemanticRelation>([
  'resource_observed_near',
  'landmark_observed_near',
  'danger_observed_near',
  'player_interacted_near',
  'outcome_repeated_near'
])

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const IDENTITY_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const REGION = /^-?\d+:-?\d+$/
const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER

export class MemoryStoreValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryStoreValidationError'
  }
}

export function decodeMemoryDocument(
  value: unknown,
  expectedIdentity: MemoryIdentity,
  limits: {
    maxEpisodes?: number
    maxFacts?: number
  } = {}
): MemoryDocumentV1 {
  const record = requireRecord(value, 'Memory store document')
  const version = record.schemaVersion
  if (version !== MEMORY_SCHEMA_VERSION) {
    const displayed = typeof version === 'number' || typeof version === 'string'
      ? String(version)
      : 'unknown'
    throw new MemoryStoreValidationError(
      `Memory store schema version ${displayed} is unsupported.`
    )
  }
  requireExactKeys(record, [
    'schemaVersion',
    'identity',
    'updatedAt',
    'episodes',
    'semanticFacts',
    'reflection'
  ], 'Memory store document')

  const identity = decodeIdentity(record.identity, 'identity')
  const normalizedExpected = decodeIdentity(expectedIdentity, 'expectedIdentity')
  if (
    identity.agentId !== normalizedExpected.agentId ||
    identity.worldId !== normalizedExpected.worldId
  ) {
    throw new MemoryStoreValidationError(
      'Memory store identity does not match the requested agent and world.'
    )
  }

  const episodes = requireArray(record.episodes, 'episodes')
  const semanticFacts = requireArray(record.semanticFacts, 'semanticFacts')
  const maxEpisodes = limits.maxEpisodes ?? DEFAULT_MAX_EPISODES
  const maxFacts = limits.maxFacts ?? DEFAULT_MAX_SEMANTIC_FACTS
  if (episodes.length > maxEpisodes) {
    fail(`episodes must contain at most ${maxEpisodes} records.`)
  }
  if (semanticFacts.length > maxFacts) {
    fail(`semanticFacts must contain at most ${maxFacts} records.`)
  }

  const decodedEpisodes = episodes.map((episode, index) => (
    decodeEpisode(episode, `episodes[${index}]`)
  ))
  const decodedFacts = semanticFacts.map((fact, index) => (
    decodeSemanticMemory(fact, `semanticFacts[${index}]`)
  ))
  for (const record of [...decodedEpisodes, ...decodedFacts]) {
    if (
      record.agentId !== identity.agentId ||
      record.worldId !== identity.worldId
    ) {
      fail('Memory record identity does not match the document agent and world.')
    }
  }
  requireUnique(decodedEpisodes.map(item => item.id), 'episode IDs')
  requireUnique(decodedFacts.map(item => item.id), 'semantic fact IDs')

  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    identity,
    updatedAt: requireTimestamp(record.updatedAt, 'updatedAt'),
    episodes: decodedEpisodes,
    semanticFacts: decodedFacts,
    reflection: decodeReflectionCursor(record.reflection)
  }
}

export function decodeEpisode(value: unknown, path = 'episode'): EpisodicMemory {
  const record = requireRecord(value, path)
  requireExactKeys(record, [
    'id',
    'agentId',
    'worldId',
    'timestamp',
    'type',
    'summary',
    'importance',
    'source',
    'context'
  ], path)
  const identity = decodeIdentity(record, path)
  const type = record.type
  if (!EPISODE_TYPES.has(type as EpisodeType)) fail(`${path}.type is invalid.`)
  const source = record.source
  if (!EPISODE_SOURCES.has(source as EpisodeSource)) fail(`${path}.source is invalid.`)

  return {
    id: requireIdentifier(record.id, `${path}.id`),
    ...identity,
    timestamp: requireTimestamp(record.timestamp, `${path}.timestamp`),
    type: type as EpisodeType,
    summary: requireBoundedText(record.summary, `${path}.summary`, 240),
    importance: requireInteger(record.importance, `${path}.importance`, 1, 10),
    source: source as EpisodeSource,
    context: decodeEpisodeContext(record.context, `${path}.context`)
  }
}

export function decodeSemanticMemory(
  value: unknown,
  path = 'semanticFact'
): SemanticMemory {
  const record = requireRecord(value, path)
  requireExactKeys(record, [
    'id',
    'agentId',
    'worldId',
    'createdAt',
    'lastObservedAt',
    'subject',
    'relation',
    'object',
    'confidence',
    'status',
    'contradictionCount',
    'evidenceEpisodeIds'
  ], path)
  const identity = decodeIdentity(record, path)
  const relation = record.relation
  if (!SEMANTIC_RELATIONS.has(relation as SemanticRelation)) {
    fail(`${path}.relation is invalid.`)
  }
  if (record.status !== 'historical' && record.status !== 'stale') {
    fail(`${path}.status is invalid.`)
  }
  const evidence = requireArray(
    record.evidenceEpisodeIds,
    `${path}.evidenceEpisodeIds`
  )
  if (evidence.length > 8) {
    fail(`${path}.evidenceEpisodeIds must contain at most 8 values.`)
  }
  const evidenceEpisodeIds = evidence.map((id, index) => (
    requireIdentifier(id, `${path}.evidenceEpisodeIds[${index}]`)
  ))
  requireUnique(evidenceEpisodeIds, `${path}.evidenceEpisodeIds`)

  return {
    id: requireIdentifier(record.id, `${path}.id`),
    ...identity,
    createdAt: requireTimestamp(record.createdAt, `${path}.createdAt`),
    lastObservedAt: requireTimestamp(
      record.lastObservedAt,
      `${path}.lastObservedAt`
    ),
    subject: requireIdentifier(record.subject, `${path}.subject`),
    relation: relation as SemanticRelation,
    object: requireBoundedText(record.object, `${path}.object`, 128),
    confidence: requireFiniteNumber(
      record.confidence,
      `${path}.confidence`,
      0,
      1
    ),
    status: record.status,
    contradictionCount: requireInteger(
      record.contradictionCount,
      `${path}.contradictionCount`,
      0,
      1000
    ),
    evidenceEpisodeIds
  }
}

export function decodeReflectionCursor(value: unknown): ReflectionCursor {
  const record = requireRecord(value, 'reflection')
  requireExactKeys(record, [
    'lastReflectedEpisodeTimestamp',
    'lastReflectionAt'
  ], 'reflection')
  return {
    lastReflectedEpisodeTimestamp: nullableTimestamp(
      record.lastReflectedEpisodeTimestamp,
      'reflection.lastReflectedEpisodeTimestamp'
    ),
    lastReflectionAt: nullableTimestamp(
      record.lastReflectionAt,
      'reflection.lastReflectionAt'
    )
  }
}

function decodeIdentity(value: unknown, path: string): MemoryIdentity {
  const record = requireRecord(value, path)
  if (path === 'identity' || path === 'expectedIdentity') {
    requireExactKeys(record, ['agentId', 'worldId'], path)
  }
  return {
    agentId: requireIdentityPart(record.agentId, `${path}.agentId`),
    worldId: requireIdentityPart(record.worldId, `${path}.worldId`)
  }
}

function decodeEpisodeContext(value: unknown, path: string): EpisodeContext {
  const record = requireRecord(value, path)
  requireAllowedKeys(record, [
    'region',
    'position',
    'resource',
    'landmark',
    'player',
    'action',
    'target',
    'outcome',
    'goalType'
  ], path)
  const region = requireString(valueAt(record, 'region'), `${path}.region`)
  if (!REGION.test(region) || region.length > 32) {
    fail(`${path}.region is invalid.`)
  }

  return {
    region,
    ...optionalPosition(record.position, `${path}.position`),
    ...optionalIdentifier(record, 'resource', path),
    ...optionalIdentifier(record, 'landmark', path),
    ...optionalIdentifier(record, 'player', path),
    ...optionalIdentifier(record, 'action', path),
    ...optionalIdentifier(record, 'target', path),
    ...optionalIdentifier(record, 'outcome', path),
    ...optionalIdentifier(record, 'goalType', path)
  }
}

function optionalPosition(value: unknown, path: string): { position?: EpisodeContext['position'] } {
  if (value === undefined) return {}
  const record = requireRecord(value, path)
  requireExactKeys(record, ['x', 'y', 'z'], path)
  return {
    position: {
      x: requireFiniteNumber(record.x, `${path}.x`, -30_000_000, 30_000_000),
      y: requireFiniteNumber(record.y, `${path}.y`, -4096, 4096),
      z: requireFiniteNumber(record.z, `${path}.z`, -30_000_000, 30_000_000)
    }
  }
}

function optionalIdentifier(
  record: Record<string, unknown>,
  key: keyof EpisodeContext,
  path: string
): Partial<EpisodeContext> {
  const value = record[key]
  return value === undefined
    ? {}
    : { [key]: requireIdentifier(value, `${path}.${key}`) }
}

function nullableTimestamp(value: unknown, path: string): number | null {
  return value === null ? null : requireTimestamp(value, path)
}

function requireTimestamp(value: unknown, path: string): number {
  return requireInteger(value, path, 0, MAX_TIMESTAMP)
}

function requireIdentityPart(value: unknown, path: string): string {
  const normalized = requireString(value, path)
  if (!IDENTITY_PART.test(normalized)) fail(`${path} is invalid.`)
  return normalized
}

function requireIdentifier(value: unknown, path: string): string {
  const normalized = requireString(value, path)
  if (!IDENTIFIER.test(normalized)) fail(`${path} is invalid.`)
  return normalized
}

function requireBoundedText(
  value: unknown,
  path: string,
  maximum: number
): string {
  const normalized = requireString(value, path)
  if (
    normalized.length > maximum ||
    normalized.trim() !== normalized ||
    /[\u0000-\u001F\u007F]/.test(normalized)
  ) {
    fail(`${path} is invalid.`)
  }
  return normalized
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${path} must be a non-empty string.`)
  }
  return value
}

function requireInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    fail(`${path} must be an integer from ${minimum} to ${maximum}.`)
  }
  return value as number
}

function requireFiniteNumber(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(`${path} must be a finite number from ${minimum} to ${maximum}.`)
  }
  return value
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${path} must be an object.`)
  }
  return value as Record<string, unknown>
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array.`)
  return value
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string
): void {
  requireAllowedKeys(record, keys, path)
  for (const key of keys) {
    if (!(key in record)) fail(`${path}.${key} is required.`)
  }
}

function requireAllowedKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string
): void {
  const allowed = new Set(keys)
  const extra = Object.keys(record).find(key => !allowed.has(key))
  if (extra) fail(`${path}.${extra} is not allowed.`)
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    fail(`${label} must be unique.`)
  }
}

function valueAt(record: Record<string, unknown>, key: string): unknown {
  return record[key]
}

function fail(message: string): never {
  throw new MemoryStoreValidationError(message)
}
