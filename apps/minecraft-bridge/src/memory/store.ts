import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

import {
  DEFAULT_MAX_EPISODES,
  DEFAULT_MAX_SEMANTIC_FACTS,
  MEMORY_SCHEMA_VERSION,
  type EpisodicMemory,
  type MemoryDocumentV1,
  type MemoryIdentity,
  type MemoryQuery,
  type MemoryStore,
  type ReflectionCursor,
  type SemanticMemory
} from './types.js'
import { rankEpisodes, rankSemanticFacts } from './retrieval.js'
import {
  decodeEpisode,
  decodeMemoryDocument,
  decodeReflectionCursor,
  decodeSemanticMemory,
  MemoryStoreValidationError
} from './validate.js'

export { MemoryStoreValidationError } from './validate.js'

export interface AtomicMemoryFileSystem {
  mkdir(
    path: string,
    options: { recursive: true; mode: number }
  ): Promise<unknown>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(
    path: string,
    data: string,
    options: { encoding: 'utf8'; mode: number }
  ): Promise<void>
  rename(source: string, destination: string): Promise<void>
  unlink(path: string): Promise<void>
}

export interface AtomicJsonMemoryStoreOptions {
  filePath: string
  identity: MemoryIdentity
  maxEpisodes?: number
  maxFacts?: number
  now?: () => number
  fileSystem?: AtomicMemoryFileSystem
}

const defaultFileSystem: AtomicMemoryFileSystem = {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink
}

export class AtomicJsonMemoryStore implements MemoryStore {
  private readonly filePath: string
  private readonly identity: MemoryIdentity
  private readonly maxEpisodes: number
  private readonly maxFacts: number
  private readonly now: () => number
  private readonly fileSystem: AtomicMemoryFileSystem
  private document: MemoryDocumentV1 | null = null
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(options: AtomicJsonMemoryStoreOptions) {
    if (!options.filePath.trim()) {
      throw new MemoryStoreValidationError('Memory store file path is required.')
    }
    this.filePath = options.filePath
    this.identity = { ...options.identity }
    this.maxEpisodes = positiveLimit(
      options.maxEpisodes,
      DEFAULT_MAX_EPISODES,
      'maxEpisodes'
    )
    this.maxFacts = positiveLimit(
      options.maxFacts,
      DEFAULT_MAX_SEMANTIC_FACTS,
      'maxFacts'
    )
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
      const initial = this.validated({
        schemaVersion: MEMORY_SCHEMA_VERSION,
        identity: { ...this.identity },
        updatedAt: this.currentTimestamp(),
        episodes: [],
        semanticFacts: [],
        reflection: {
          lastReflectedEpisodeTimestamp: null,
          lastReflectionAt: null
        }
      })
      await this.persist(initial)
      this.document = initial
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(encoded) as unknown
    } catch {
      throw new MemoryStoreValidationError(
        'Memory store contains malformed JSON.'
      )
    }
    this.document = this.validated(parsed)
  }

  addEpisode(episode: EpisodicMemory): Promise<void> {
    const decoded = decodeEpisode(episode)
    this.requireMatchingIdentity(decoded)
    return this.mutate(document => {
      document.episodes = retainEpisodes([
        ...document.episodes.filter(item => item.id !== decoded.id),
        decoded
      ], this.maxEpisodes)
    })
  }

  async listRecentEpisodes(limit: number): Promise<EpisodicMemory[]> {
    await this.mutationQueue
    const document = this.requireOpen()
    return [...document.episodes]
      .sort((left, right) => (
        right.timestamp - left.timestamp || left.id.localeCompare(right.id)
      ))
      .slice(0, listLimit(limit))
      .map(cloneEpisode)
  }

  async findRelevantEpisodes(query: MemoryQuery): Promise<EpisodicMemory[]> {
    await this.mutationQueue
    this.requireMatchingIdentity(query)
    return rankEpisodes(this.requireOpen().episodes, query)
  }

  addSemanticFact(fact: SemanticMemory): Promise<void> {
    const decoded = decodeSemanticMemory(fact)
    this.requireMatchingIdentity(decoded)
    return this.mutate(document => {
      document.semanticFacts = retainFacts([
        ...document.semanticFacts.filter(item => item.id !== decoded.id),
        decoded
      ], this.maxFacts)
    })
  }

  async listSemanticFacts(limit: number): Promise<SemanticMemory[]> {
    await this.mutationQueue
    const document = this.requireOpen()
    return [...document.semanticFacts]
      .sort((left, right) => (
        right.confidence - left.confidence ||
        right.lastObservedAt - left.lastObservedAt ||
        left.id.localeCompare(right.id)
      ))
      .slice(0, listLimit(limit))
      .map(cloneFact)
  }

  async findRelevantFacts(query: MemoryQuery): Promise<SemanticMemory[]> {
    await this.mutationQueue
    this.requireMatchingIdentity(query)
    return rankSemanticFacts(this.requireOpen().semanticFacts, query)
  }

  async reflectionState(): Promise<ReflectionCursor> {
    await this.mutationQueue
    return { ...this.requireOpen().reflection }
  }

  updateReflectionState(state: ReflectionCursor): Promise<void> {
    const decoded = decodeReflectionCursor(state)
    return this.mutate(document => {
      document.reflection = decoded
    })
  }

  private mutate(
    update: (document: MemoryDocumentV1) => void
  ): Promise<void> {
    const operation = this.mutationQueue.then(async () => {
      const next = cloneDocument(this.requireOpen())
      update(next)
      next.updatedAt = this.currentTimestamp()
      const validated = this.validated(next)
      await this.persist(validated)
      this.document = validated
    })
    this.mutationQueue = operation.catch(() => {})
    return operation
  }

  private async persist(document: MemoryDocumentV1): Promise<void> {
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
            'Memory persistence and temporary-file cleanup both failed.'
          )
        }
      }
      throw persistenceError
    }
  }

  private validated(value: unknown): MemoryDocumentV1 {
    return decodeMemoryDocument(value, this.identity, {
      maxEpisodes: this.maxEpisodes,
      maxFacts: this.maxFacts
    })
  }

  private requireOpen(): MemoryDocumentV1 {
    if (!this.document) {
      throw new Error('Memory store must be opened before use.')
    }
    return this.document
  }

  private requireMatchingIdentity(value: MemoryIdentity): void {
    if (
      value.agentId !== this.identity.agentId ||
      value.worldId !== this.identity.worldId
    ) {
      throw new MemoryStoreValidationError(
        'Memory record identity does not match the store agent and world.'
      )
    }
  }

  private currentTimestamp(): number {
    const value = this.now()
    if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      throw new MemoryStoreValidationError(
        'Memory store clock must return a non-negative safe integer.'
      )
    }
    return value
  }
}

function retainEpisodes(
  episodes: readonly EpisodicMemory[],
  limit: number
): EpisodicMemory[] {
  return [...episodes]
    .sort((left, right) => (
      right.importance - left.importance ||
      right.timestamp - left.timestamp ||
      left.id.localeCompare(right.id)
    ))
    .slice(0, limit)
    .map(cloneEpisode)
}

function retainFacts(
  facts: readonly SemanticMemory[],
  limit: number
): SemanticMemory[] {
  return [...facts]
    .sort((left, right) => (
      right.confidence - left.confidence ||
      right.lastObservedAt - left.lastObservedAt ||
      left.id.localeCompare(right.id)
    ))
    .slice(0, limit)
    .map(cloneFact)
}

function cloneDocument(document: MemoryDocumentV1): MemoryDocumentV1 {
  return {
    ...document,
    identity: { ...document.identity },
    episodes: document.episodes.map(cloneEpisode),
    semanticFacts: document.semanticFacts.map(cloneFact),
    reflection: { ...document.reflection }
  }
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

function positiveLimit(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 10_000) {
    throw new MemoryStoreValidationError(
      `${label} must be an integer from 1 to 10000.`
    )
  }
  return resolved
}

function listLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new MemoryStoreValidationError(
      'Memory list limit must be an integer from 1 to 10000.'
    )
  }
  return value
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
}
