import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import {
  validateRelationshipRecord,
  type RelationshipIdentity,
  type RelationshipRecord,
  type RelationshipStore
} from './relationships.js'

const RELATIONSHIP_SCHEMA_VERSION = 1 as const
const DEFAULT_MAX_RELATIONSHIPS = 32

interface RelationshipDocumentV1 {
  schemaVersion: typeof RELATIONSHIP_SCHEMA_VERSION
  identity: RelationshipIdentity
  updatedAt: number
  relationships: RelationshipRecord[]
}

export interface RelationshipStoreFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(
    path: string,
    data: string,
    options: { encoding: 'utf8'; mode: number }
  ): Promise<void>
  rename(source: string, destination: string): Promise<void>
  unlink(path: string): Promise<void>
}

export interface AtomicJsonRelationshipStoreOptions {
  filePath: string
  identity: RelationshipIdentity
  configuredTargetAgentIds: readonly string[]
  maxRecords?: number
  now?: () => number
  fileSystem?: RelationshipStoreFileSystem
}

const defaultFileSystem: RelationshipStoreFileSystem = {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink
}

export class RelationshipStoreValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelationshipStoreValidationError'
  }
}

export class AtomicJsonRelationshipStore implements RelationshipStore {
  private readonly filePath: string
  private readonly identity: RelationshipIdentity
  private readonly configuredTargetAgentIds: ReadonlySet<string>
  private readonly maxRecords: number
  private readonly now: () => number
  private readonly fileSystem: RelationshipStoreFileSystem
  private document: RelationshipDocumentV1 | null = null
  private mutationQueue: Promise<void> = Promise.resolve()
  private flushBoundary: Promise<void> = Promise.resolve()

  constructor(options: AtomicJsonRelationshipStoreOptions) {
    if (!options.filePath.trim()) {
      throw new RelationshipStoreValidationError(
        'Relationship store file path is required.'
      )
    }
    this.filePath = options.filePath
    this.identity = decodeIdentity(options.identity, 'requested identity')
    this.configuredTargetAgentIds = decodeConfiguredTargets(
      options.configuredTargetAgentIds,
      this.identity.observerAgentId
    )
    this.maxRecords = positiveLimit(options.maxRecords)
    this.now = options.now ?? Date.now
    this.fileSystem = options.fileSystem ?? defaultFileSystem
  }

  async open(): Promise<void> {
    if (this.document) return
    await this.fileSystem.mkdir(dirname(this.filePath), {
      recursive: true,
      mode: 0o700
    })

    let encoded: string
    try {
      encoded = await this.fileSystem.readFile(this.filePath, 'utf8')
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
      const initial = this.decodeDocument({
        schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
        identity: { ...this.identity },
        updatedAt: this.currentTimestamp(),
        relationships: []
      })
      await this.persist(initial)
      this.document = initial
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(encoded) as unknown
    } catch {
      throw new RelationshipStoreValidationError(
        'Relationship store contains malformed JSON.'
      )
    }
    this.document = this.decodeDocument(parsed)
  }

  async flush(): Promise<void> {
    await this.flushBoundary
  }

  async get(targetAgentId: string): Promise<RelationshipRecord | null> {
    validateAgentId(targetAgentId, 'relationship target')
    await this.mutationQueue
    const found = this.requireOpen().relationships.find(
      item => item.targetAgentId === targetAgentId
    )
    return found ? { ...found } : null
  }

  async list(): Promise<RelationshipRecord[]> {
    await this.mutationQueue
    return [...this.requireOpen().relationships]
      .sort((left, right) => left.targetAgentId.localeCompare(right.targetAgentId))
      .map(item => ({ ...item }))
  }

  put(record: RelationshipRecord): Promise<void> {
    const decoded = decodeRelationship(record)
    this.requireMatchingIdentity(decoded)
    this.requireConfiguredTarget(decoded.targetAgentId)
    return this.mutate(document => {
      document.relationships = retainRelationships([
        ...document.relationships.filter(
          item => item.targetAgentId !== decoded.targetAgentId
        ),
        decoded
      ], this.maxRecords)
    })
  }

  private mutate(update: (document: RelationshipDocumentV1) => void): Promise<void> {
    const operation = this.mutationQueue.then(async () => {
      const next = cloneDocument(this.requireOpen())
      update(next)
      next.updatedAt = this.currentTimestamp()
      const validated = this.decodeDocument(next)
      await this.persist(validated)
      this.document = validated
    })
    this.mutationQueue = operation.catch(() => {})
    this.flushBoundary = operation
    return operation
  }

  private async persist(document: RelationshipDocumentV1): Promise<void> {
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    const encoded = `${JSON.stringify(document, null, 2)}\n`
    try {
      await this.fileSystem.writeFile(temporaryPath, encoded, {
        encoding: 'utf8',
        mode: 0o600
      })
      await this.fileSystem.rename(temporaryPath, this.filePath)
    } catch (persistenceError) {
      try {
        await this.fileSystem.unlink(temporaryPath)
      } catch (cleanupError) {
        if (!isNodeError(cleanupError, 'ENOENT')) {
          throw new AggregateError(
            [persistenceError, cleanupError],
            'Relationship persistence and temporary-file cleanup both failed.'
          )
        }
      }
      throw persistenceError
    }
  }

  private decodeDocument(value: unknown): RelationshipDocumentV1 {
    const record = requireRecord(value, 'Relationship store document')
    const version = record.schemaVersion
    if (version !== RELATIONSHIP_SCHEMA_VERSION) {
      const displayed = typeof version === 'number' || typeof version === 'string'
        ? String(version)
        : 'unknown'
      throw new RelationshipStoreValidationError(
        `Relationship store schema version ${displayed} is unsupported.`
      )
    }
    requireExactKeys(record, [
      'schemaVersion',
      'identity',
      'updatedAt',
      'relationships'
    ], 'Relationship store document')
    const identity = decodeIdentity(record.identity, 'stored identity')
    if (
      identity.observerAgentId !== this.identity.observerAgentId ||
      identity.worldId !== this.identity.worldId
    ) {
      throw new RelationshipStoreValidationError(
        'Relationship store identity does not match the requested observer and world.'
      )
    }
    const values = requireArray(record.relationships, 'relationships')
    if (values.length > this.maxRecords) {
      throw new RelationshipStoreValidationError(
        `relationships must contain at most ${this.maxRecords} records.`
      )
    }
    const relationships = values.map((value, index) => {
      const relationship = decodeRelationship(value, `relationships[${index}]`)
      this.requireMatchingIdentity(relationship)
      this.requireConfiguredTarget(relationship.targetAgentId)
      return relationship
    })
    requireUniqueTargets(relationships)
    return {
      schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
      identity,
      updatedAt: requireTimestamp(record.updatedAt, 'updatedAt'),
      relationships
    }
  }

  private requireOpen(): RelationshipDocumentV1 {
    if (!this.document) {
      throw new Error('Relationship store must be opened before use.')
    }
    return this.document
  }

  private requireMatchingIdentity(record: RelationshipRecord): void {
    if (
      record.observerAgentId !== this.identity.observerAgentId ||
      record.worldId !== this.identity.worldId
    ) {
      throw new RelationshipStoreValidationError(
        'Relationship record identity does not match the store observer and world.'
      )
    }
  }

  private requireConfiguredTarget(targetAgentId: string): void {
    if (!this.configuredTargetAgentIds.has(targetAgentId)) {
      throw new RelationshipStoreValidationError(
        'Relationship record must name a configured target agent.'
      )
    }
  }

  private currentTimestamp(): number {
    return requireTimestamp(this.now(), 'store clock')
  }
}

export function relationshipFilePath(
  baseDirectory: string,
  identity: RelationshipIdentity
): string {
  if (!baseDirectory.trim()) {
    throw new RelationshipStoreValidationError(
      'Relationship store base directory is required.'
    )
  }
  const decoded = decodeIdentity(identity, 'relationship identity')
  const root = resolve(baseDirectory)
  const path = join(root, decoded.worldId, `${decoded.observerAgentId}.json`)
  const contained = relative(root, path)
  if (contained.startsWith('..') || contained === '') {
    throw new RelationshipStoreValidationError(
      'Relationship store path must remain inside its base directory.'
    )
  }
  return path
}

function decodeRelationship(
  value: unknown,
  path = 'relationship'
): RelationshipRecord {
  const record = requireRecord(value, path)
  requireExactKeys(record, [
    'observerAgentId',
    'targetAgentId',
    'worldId',
    'familiarity',
    'trust',
    'affinity',
    'reciprocity',
    'interactionCount',
    'lastInteractionAt',
    'lastVerifiedEventAt',
    'updatedAt'
  ], path)
  const decoded: RelationshipRecord = {
    observerAgentId: requireAgentId(record.observerAgentId, `${path}.observerAgentId`),
    targetAgentId: requireAgentId(record.targetAgentId, `${path}.targetAgentId`),
    worldId: requireWorldId(record.worldId, `${path}.worldId`),
    familiarity: requireInteger(record.familiarity, `${path}.familiarity`, -100, 100),
    trust: requireInteger(record.trust, `${path}.trust`, -100, 100),
    affinity: requireInteger(record.affinity, `${path}.affinity`, -100, 100),
    reciprocity: requireInteger(record.reciprocity, `${path}.reciprocity`, -100, 100),
    interactionCount: requireInteger(
      record.interactionCount,
      `${path}.interactionCount`,
      0,
      Number.MAX_SAFE_INTEGER
    ),
    lastInteractionAt: requireNullableTimestamp(
      record.lastInteractionAt,
      `${path}.lastInteractionAt`
    ),
    lastVerifiedEventAt: requireNullableTimestamp(
      record.lastVerifiedEventAt,
      `${path}.lastVerifiedEventAt`
    ),
    updatedAt: requireTimestamp(record.updatedAt, `${path}.updatedAt`)
  }
  try {
    validateRelationshipRecord(decoded)
  } catch (error) {
    throw new RelationshipStoreValidationError(
      error instanceof Error ? error.message : `${path} is invalid.`
    )
  }
  return decoded
}

function decodeIdentity(value: unknown, path: string): RelationshipIdentity {
  const record = requireRecord(value, path)
  requireExactKeys(record, ['observerAgentId', 'worldId'], path)
  return {
    observerAgentId: requireAgentId(
      record.observerAgentId,
      `${path} observer identity`
    ),
    worldId: requireWorldId(record.worldId, `${path} world identity`)
  }
}

function decodeConfiguredTargets(
  values: readonly string[],
  observerAgentId: string
): ReadonlySet<string> {
  const targets = new Set<string>()
  for (const value of values) {
    const target = requireAgentId(value, 'configured target')
    if (target === observerAgentId) {
      throw new RelationshipStoreValidationError(
        'Configured relationship target must be external to its observer.'
      )
    }
    if (targets.has(target)) {
      throw new RelationshipStoreValidationError(
        'Configured relationship targets must be unique.'
      )
    }
    targets.add(target)
  }
  return targets
}

function retainRelationships(
  relationships: readonly RelationshipRecord[],
  limit: number
): RelationshipRecord[] {
  return [...relationships]
    .sort((left, right) => (
      right.updatedAt - left.updatedAt ||
      left.targetAgentId.localeCompare(right.targetAgentId)
    ))
    .slice(0, limit)
    .map(item => ({ ...item }))
}

function cloneDocument(document: RelationshipDocumentV1): RelationshipDocumentV1 {
  return {
    ...document,
    identity: { ...document.identity },
    relationships: document.relationships.map(item => ({ ...item }))
  }
}

function positiveLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_RELATIONSHIPS
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 10_000) {
    throw new RelationshipStoreValidationError(
      'maxRecords must be an integer from 1 to 10000.'
    )
  }
  return resolved
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelationshipStoreValidationError(`${path} must be an object.`)
  }
  return value as Record<string, unknown>
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new RelationshipStoreValidationError(`${path} must be an array.`)
  }
  return value
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  path: string
): void {
  const actual = Object.keys(record).sort()
  const sortedExpected = [...expected].sort()
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new RelationshipStoreValidationError(
      `${path} contains missing or unsupported fields.`
    )
  }
}

function requireAgentId(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new RelationshipStoreValidationError(`${path} is invalid.`)
  }
  validateAgentId(value, path)
  return value
}

function validateAgentId(value: string, path: string): void {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(value)) {
    throw new RelationshipStoreValidationError(`${path} is invalid.`)
  }
}

function requireWorldId(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
  ) {
    throw new RelationshipStoreValidationError(`${path} is invalid.`)
  }
  return value
}

function requireInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RelationshipStoreValidationError(`${path} is invalid.`)
  }
  return value as number
}

function requireTimestamp(value: unknown, path: string): number {
  return requireInteger(value, path, 0, Number.MAX_SAFE_INTEGER)
}

function requireNullableTimestamp(value: unknown, path: string): number | null {
  return value === null ? null : requireTimestamp(value, path)
}

function requireUniqueTargets(relationships: readonly RelationshipRecord[]): void {
  const targets = new Set<string>()
  for (const relationship of relationships) {
    if (targets.has(relationship.targetAgentId)) {
      throw new RelationshipStoreValidationError(
        'Relationship target records must be unique.'
      )
    }
    targets.add(relationship.targetAgentId)
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
}
