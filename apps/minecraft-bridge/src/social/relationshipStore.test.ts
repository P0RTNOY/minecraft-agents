import assert from 'node:assert/strict'
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  AtomicJsonRelationshipStore,
  RelationshipStoreValidationError,
  relationshipFilePath,
  type RelationshipStoreFileSystem
} from './relationshipStore.js'
import {
  createEmptyRelationship,
  type RelationshipIdentity,
  type RelationshipRecord
} from './relationships.js'

const identity: RelationshipIdentity = {
  observerAgentId: 'alice',
  worldId: 'local-paper'
}
const targets = ['bob', 'charlie'] as const
const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})

describe('AtomicJsonRelationshipStore', () => {
  it('creates a missing versioned store and persists directed records across reopen', async () => {
    const filePath = await relationshipFile()
    const first = store(filePath, { now: () => 100 })
    await first.open()
    await first.put(relationship('bob', { familiarity: 3, updatedAt: 100 }))

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      schemaVersion: number
      identity: RelationshipIdentity
    }
    assert.equal(persisted.schemaVersion, 1)
    assert.deepEqual(persisted.identity, identity)

    const reopened = store(filePath)
    await reopened.open()
    assert.equal((await reopened.get('bob'))?.familiarity, 3)
    assert.equal(await reopened.get('charlie'), null)
  })

  it('writes a complete same-directory temporary file before atomic replacement', async () => {
    const filePath = await relationshipFile()
    const writes: string[] = []
    const renames: Array<{ source: string; destination: string }> = []
    const fileSystem = trackingFileSystem(writes, renames)
    const tracked = store(filePath, { fileSystem })
    await tracked.open()
    writes.length = 0
    renames.length = 0

    await tracked.put(relationship('bob'))

    assert.equal(writes.length, 1)
    assert.equal(renames.length, 1)
    assert.equal(dirname(writes[0] ?? ''), dirname(filePath))
    assert.notEqual(writes[0], filePath)
    assert.match(basename(writes[0] ?? ''), /^alice\.json\..+\.tmp$/)
    assert.deepEqual(renames[0], { source: writes[0], destination: filePath })
  })

  it('preserves the previous document when atomic replacement fails', async () => {
    const filePath = await relationshipFile()
    const healthy = store(filePath)
    await healthy.open()
    await healthy.put(relationship('bob', { familiarity: 2 }))
    const before = await readFile(filePath, 'utf8')
    const failing = store(filePath, {
      fileSystem: {
        ...trackingFileSystem([], []),
        rename: async () => { throw new Error('simulated rename failure') }
      }
    })
    await failing.open()

    await assert.rejects(
      () => failing.put(relationship('bob', { familiarity: 9 })),
      /simulated rename failure/
    )
    await assert.rejects(() => failing.flush(), /simulated rename failure/)
    assert.equal(await readFile(filePath, 'utf8'), before)
    assert.equal((await failing.get('bob'))?.familiarity, 2)
  })

  it('fails closed for malformed JSON and unsupported schema versions', async () => {
    const malformedPath = await relationshipFile()
    await writeFile(malformedPath, '{broken', 'utf8')
    await assert.rejects(
      () => store(malformedPath).open(),
      (error: unknown) => error instanceof RelationshipStoreValidationError &&
        error.message === 'Relationship store contains malformed JSON.'
    )
    assert.equal(await readFile(malformedPath, 'utf8'), '{broken')

    const versionPath = join(await temporaryDirectory(), 'alice.json')
    const encoded = JSON.stringify({
      schemaVersion: 2,
      identity,
      updatedAt: 1,
      relationships: []
    })
    await writeFile(versionPath, encoded, 'utf8')
    await assert.rejects(
      () => store(versionPath).open(),
      /schema version 2 is unsupported/
    )
    assert.equal(await readFile(versionPath, 'utf8'), encoded)
  })

  it('rejects observer/world identity mismatches and unconfigured targets', async () => {
    const filePath = await relationshipFile()
    const healthy = store(filePath)
    await healthy.open()
    await healthy.put(relationship('bob'))

    await assert.rejects(
      () => new AtomicJsonRelationshipStore({
        filePath,
        identity: { observerAgentId: 'bob', worldId: 'local-paper' },
        configuredTargetAgentIds: ['alice']
      }).open(),
      /identity does not match/
    )
    assert.throws(
      () => healthy.put(relationship('dave')),
      /configured target/
    )
  })

  it('keeps observers and worlds isolated and contains one corrupt document', async () => {
    const directory = await temporaryDirectory()
    const alice = new AtomicJsonRelationshipStore({
      filePath: join(directory, 'alice.json'),
      identity,
      configuredTargetAgentIds: targets
    })
    const bobIdentity = { observerAgentId: 'bob', worldId: 'local-paper' }
    const bob = new AtomicJsonRelationshipStore({
      filePath: join(directory, 'bob.json'),
      identity: bobIdentity,
      configuredTargetAgentIds: ['alice', 'charlie']
    })
    const otherWorld = new AtomicJsonRelationshipStore({
      filePath: join(directory, 'other.json'),
      identity: { observerAgentId: 'alice', worldId: 'other-world' },
      configuredTargetAgentIds: targets
    })
    await Promise.all([alice.open(), bob.open(), otherWorld.open()])
    await alice.put(relationship('bob', { familiarity: 4 }))

    assert.equal((await alice.get('bob'))?.familiarity, 4)
    assert.deepEqual(await bob.list(), [])
    assert.deepEqual(await otherWorld.list(), [])

    await writeFile(join(directory, 'bob.json'), '{broken', 'utf8')
    await assert.rejects(
      () => new AtomicJsonRelationshipStore({
        filePath: join(directory, 'bob.json'),
        identity: bobIdentity,
        configuredTargetAgentIds: ['alice', 'charlie']
      }).open(),
      /malformed JSON/
    )
    assert.equal((await alice.get('bob'))?.familiarity, 4)
  })

  it('bounds records and serializes concurrent updates', async () => {
    const filePath = await relationshipFile()
    const bounded = store(filePath, { maxRecords: 1 })
    await bounded.open()
    await bounded.put(relationship('bob', { updatedAt: 10 }))
    await bounded.put(relationship('charlie', { updatedAt: 20 }))
    assert.deepEqual((await bounded.list()).map(item => item.targetAgentId), ['charlie'])

    const concurrentPath = join(await temporaryDirectory(), 'alice.json')
    const concurrent = store(concurrentPath)
    await concurrent.open()
    await Promise.all([
      concurrent.put(relationship('bob', { familiarity: 1 })),
      concurrent.put(relationship('charlie', { familiarity: 2 }))
    ])
    assert.equal((await concurrent.list()).length, 2)
  })

  it('derives contained paths only from safe identities', () => {
    const base = '/tmp/minecraft-agents-social'
    assert.equal(
      relationshipFilePath(base, identity),
      join(base, 'local-paper', 'alice.json')
    )
    assert.throws(
      () => relationshipFilePath(base, {
        observerAgentId: '../alice', worldId: 'local-paper'
      }),
      /observer identity/
    )
    assert.throws(
      () => relationshipFilePath(base, {
        observerAgentId: 'alice', worldId: '../other'
      }),
      /world identity/
    )
  })
})

function store(
  filePath: string,
  overrides: Partial<ConstructorParameters<typeof AtomicJsonRelationshipStore>[0]> = {}
): AtomicJsonRelationshipStore {
  return new AtomicJsonRelationshipStore({
    filePath,
    identity,
    configuredTargetAgentIds: targets,
    ...overrides
  })
}

function relationship(
  targetAgentId: string,
  overrides: Partial<RelationshipRecord> = {}
): RelationshipRecord {
  return {
    ...createEmptyRelationship({
      ...identity,
      targetAgentId,
      timestamp: 1
    }),
    ...overrides
  }
}

async function relationshipFile(): Promise<string> {
  return join(await temporaryDirectory(), 'alice.json')
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'minecraft-agents-social-'))
  temporaryDirectories.push(directory)
  return directory
}

function trackingFileSystem(
  writes: string[],
  renames: Array<{ source: string; destination: string }>
): RelationshipStoreFileSystem {
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
