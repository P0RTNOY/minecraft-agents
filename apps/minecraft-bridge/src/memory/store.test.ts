import assert from 'node:assert/strict'
import {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  AtomicJsonMemoryStore,
  MemoryStoreValidationError,
  type AtomicMemoryFileSystem
} from './store.js'
import type {
  EpisodicMemory,
  MemoryIdentity,
  SemanticMemory
} from './types.js'

const identity: MemoryIdentity = {
  agentId: 'Alice',
  worldId: 'local-paper'
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})

describe('AtomicJsonMemoryStore', () => {
  it('creates a missing versioned store and persists episodes across reopen', async () => {
    const filePath = await memoryFile()
    const first = new AtomicJsonMemoryStore({ filePath, identity, now: () => 100 })

    await first.open()
    await first.addEpisode(episode({ id: 'episode-1', timestamp: 90 }))

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      schemaVersion: number
      identity: MemoryIdentity
    }
    assert.equal(persisted.schemaVersion, 1)
    assert.deepEqual(persisted.identity, identity)

    const reopened = new AtomicJsonMemoryStore({ filePath, identity })
    await reopened.open()
    assert.deepEqual(
      await reopened.listRecentEpisodes(4),
      [episode({ id: 'episode-1', timestamp: 90 })]
    )
  })

  it('persists semantic facts and reflection state across reopen', async () => {
    const filePath = await memoryFile()
    const store = new AtomicJsonMemoryStore({ filePath, identity })
    const fact = semanticFact({ id: 'fact-1' })

    await store.open()
    await store.addSemanticFact(fact)
    await store.updateReflectionState({
      lastReflectedEpisodeTimestamp: 80,
      lastReflectionAt: 100
    })

    const reopened = new AtomicJsonMemoryStore({ filePath, identity })
    await reopened.open()
    assert.deepEqual(await reopened.listSemanticFacts(4), [fact])
    assert.deepEqual(await reopened.reflectionState(), {
      lastReflectedEpisodeTimestamp: 80,
      lastReflectionAt: 100
    })
  })

  it('writes a complete same-directory temporary file before atomic replacement', async () => {
    const filePath = await memoryFile()
    const writes: string[] = []
    const renames: Array<{ source: string; destination: string }> = []
    const fileSystem = trackingFileSystem(writes, renames)
    const store = new AtomicJsonMemoryStore({ filePath, identity, fileSystem })

    await store.open()
    writes.length = 0
    renames.length = 0
    await store.addEpisode(episode({ id: 'atomic' }))

    assert.equal(writes.length, 1)
    assert.equal(renames.length, 1)
    assert.equal(dirname(writes[0] ?? ''), dirname(filePath))
    assert.notEqual(writes[0], filePath)
    assert.match(basename(writes[0] ?? ''), /^memory\.json\..+\.tmp$/)
    assert.deepEqual(renames[0], {
      source: writes[0],
      destination: filePath
    })
  })

  it('preserves the previous document when atomic replacement fails', async () => {
    const filePath = await memoryFile()
    const healthy = new AtomicJsonMemoryStore({ filePath, identity })
    await healthy.open()
    await healthy.addEpisode(episode({ id: 'preserved' }))
    const before = await readFile(filePath, 'utf8')

    const failing = new AtomicJsonMemoryStore({
      filePath,
      identity,
      fileSystem: {
        ...trackingFileSystem([], []),
        rename: async () => {
          throw new Error('simulated atomic rename failure')
        }
      }
    })
    await failing.open()

    await assert.rejects(
      () => failing.addEpisode(episode({ id: 'not-persisted' })),
      /simulated atomic rename failure/
    )
    assert.equal(await readFile(filePath, 'utf8'), before)
    assert.deepEqual(
      await failing.listRecentEpisodes(4),
      [episode({ id: 'preserved' })]
    )
  })

  it('removes its partial temporary file when the temporary write fails', async () => {
    const filePath = await memoryFile()
    const healthy = new AtomicJsonMemoryStore({ filePath, identity })
    await healthy.open()
    const before = await readFile(filePath, 'utf8')
    const baseFileSystem = trackingFileSystem([], [])
    const failing = new AtomicJsonMemoryStore({
      filePath,
      identity,
      fileSystem: {
        ...baseFileSystem,
        writeFile: async (path, _data, _options) => {
          await writeFile(path, 'partial', { encoding: 'utf8', mode: 0o600 })
          throw new Error('simulated temporary write failure')
        }
      }
    })
    await failing.open()

    await assert.rejects(
      () => failing.addEpisode(episode({ id: 'not-persisted' })),
      /simulated temporary write failure/
    )
    assert.equal(await readFile(filePath, 'utf8'), before)
    assert.deepEqual(await readdir(dirname(filePath)), ['memory.json'])
  })

  it('rejects malformed JSON without replacing or discarding it', async () => {
    const filePath = await memoryFile()
    await writeFile(filePath, '{broken', 'utf8')
    const store = new AtomicJsonMemoryStore({ filePath, identity })

    await assert.rejects(
      () => store.open(),
      (error: unknown) => (
        error instanceof MemoryStoreValidationError &&
        error.message === 'Memory store contains malformed JSON.'
      )
    )
    assert.equal(await readFile(filePath, 'utf8'), '{broken')
  })

  it('rejects unsupported schema versions without replacing the document', async () => {
    const filePath = await memoryFile()
    const encoded = JSON.stringify({
      schemaVersion: 2,
      identity,
      updatedAt: 1,
      episodes: [],
      semanticFacts: [],
      reflection: {
        lastReflectedEpisodeTimestamp: null,
        lastReflectionAt: null
      }
    })
    await writeFile(filePath, encoded, 'utf8')
    const store = new AtomicJsonMemoryStore({ filePath, identity })

    await assert.rejects(
      () => store.open(),
      (error: unknown) => (
        error instanceof MemoryStoreValidationError &&
        error.message === 'Memory store schema version 2 is unsupported.'
      )
    )
    assert.equal(await readFile(filePath, 'utf8'), encoded)
  })

  it('rejects invalid records and agent/world identity mismatches', async () => {
    const filePath = await memoryFile()
    const valid = new AtomicJsonMemoryStore({ filePath, identity })
    await valid.open()
    assert.throws(
      () => valid.addEpisode({
        ...episode({ id: 'invalid' }),
        importance: 11
      }),
      MemoryStoreValidationError
    )

    const wrongAgent = new AtomicJsonMemoryStore({
      filePath,
      identity: { agentId: 'Bob', worldId: identity.worldId }
    })
    await assert.rejects(() => wrongAgent.open(), /identity does not match/i)

    const wrongWorld = new AtomicJsonMemoryStore({
      filePath,
      identity: { agentId: identity.agentId, worldId: 'another-world' }
    })
    await assert.rejects(() => wrongWorld.open(), /identity does not match/i)
  })

  it('rejects persisted records from another agent or world', async () => {
    const filePath = await memoryFile()
    const store = new AtomicJsonMemoryStore({ filePath, identity })
    await store.open()
    await store.addEpisode(episode({ id: 'foreign-record' }))
    const document = JSON.parse(await readFile(filePath, 'utf8')) as {
      episodes: Array<{ agentId: string }>
    }
    const first = document.episodes[0]
    if (!first) throw new Error('Expected persisted episode fixture.')
    first.agentId = 'Bob'
    await writeFile(filePath, JSON.stringify(document), 'utf8')

    const reopened = new AtomicJsonMemoryStore({ filePath, identity })
    await assert.rejects(() => reopened.open(), /record identity does not match/i)
  })

  it('keeps agent/world files isolated', async () => {
    const directory = await temporaryDirectory()
    const alice = new AtomicJsonMemoryStore({
      filePath: join(directory, 'alice-local.json'),
      identity
    })
    const bob = new AtomicJsonMemoryStore({
      filePath: join(directory, 'bob-local.json'),
      identity: { agentId: 'Bob', worldId: identity.worldId }
    })
    const aliceOtherWorld = new AtomicJsonMemoryStore({
      filePath: join(directory, 'alice-other.json'),
      identity: { agentId: 'Alice', worldId: 'other-world' }
    })

    await Promise.all([alice.open(), bob.open(), aliceOtherWorld.open()])
    await alice.addEpisode(episode({ id: 'alice-only' }))

    assert.equal((await alice.listRecentEpisodes(4)).length, 1)
    assert.deepEqual(await bob.listRecentEpisodes(4), [])
    assert.deepEqual(await aliceOtherWorld.listRecentEpisodes(4), [])
  })

  it('bounds episodes and facts while retaining the most important records', async () => {
    const filePath = await memoryFile()
    const store = new AtomicJsonMemoryStore({
      filePath,
      identity,
      maxEpisodes: 2,
      maxFacts: 2
    })
    await store.open()

    await store.addEpisode(episode({ id: 'low-old', timestamp: 1, importance: 1 }))
    await store.addEpisode(episode({ id: 'high', timestamp: 2, importance: 9 }))
    await store.addEpisode(episode({ id: 'medium', timestamp: 3, importance: 5 }))
    await store.addSemanticFact(semanticFact({ id: 'stale-low', confidence: 0.2 }))
    await store.addSemanticFact(semanticFact({ id: 'strong', confidence: 0.9, subject: 'oak_log' }))
    await store.addSemanticFact(semanticFact({ id: 'medium', confidence: 0.6, subject: 'birch_log' }))

    assert.deepEqual(
      (await store.listRecentEpisodes(10)).map(item => item.id),
      ['medium', 'high']
    )
    assert.deepEqual(
      (await store.listSemanticFacts(10)).map(item => item.id),
      ['strong', 'medium']
    )
  })

  it('serializes concurrent additions without losing records', async () => {
    const filePath = await memoryFile()
    const store = new AtomicJsonMemoryStore({ filePath, identity })
    await store.open()

    await Promise.all(Array.from({ length: 20 }, (_, index) => (
      store.addEpisode(episode({
        id: `episode-${index}`,
        timestamp: index
      }))
    )))

    const reopened = new AtomicJsonMemoryStore({ filePath, identity })
    await reopened.open()
    assert.equal((await reopened.listRecentEpisodes(100)).length, 20)
  })
})

async function memoryFile(): Promise<string> {
  return join(await temporaryDirectory(), 'memory.json')
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'minecraft-agents-memory-'))
  temporaryDirectories.push(directory)
  return directory
}

function episode(
  overrides: Partial<EpisodicMemory> = {}
): EpisodicMemory {
  return {
    id: 'episode',
    agentId: identity.agentId,
    worldId: identity.worldId,
    timestamp: 50,
    type: 'resource_discovery',
    summary: 'Oak logs were observed in this region.',
    importance: 6,
    source: 'perception',
    context: {
      region: '0:0',
      position: { x: 4, y: 64, z: 4 },
      resource: 'oak_log'
    },
    ...overrides
  }
}

function semanticFact(
  overrides: Partial<SemanticMemory> = {}
): SemanticMemory {
  return {
    id: 'fact',
    agentId: identity.agentId,
    worldId: identity.worldId,
    createdAt: 50,
    lastObservedAt: 50,
    subject: 'crafting_table',
    relation: 'landmark_observed_near',
    object: 'region:0:0',
    confidence: 0.8,
    status: 'historical',
    contradictionCount: 0,
    evidenceEpisodeIds: ['episode'],
    ...overrides
  }
}

function trackingFileSystem(
  writes: string[],
  renames: Array<{ source: string; destination: string }>
): AtomicMemoryFileSystem {
  return {
    mkdir: async (path, options) => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(path, options)
    },
    readFile,
    writeFile: async (path, data, options) => {
      writes.push(path)
      await writeFile(path, data, options)
    },
    rename: async (source, destination) => {
      renames.push({ source, destination })
      await rename(source, destination)
    },
    unlink: async path => {
      const { unlink } = await import('node:fs/promises')
      await unlink(path)
    }
  }
}
