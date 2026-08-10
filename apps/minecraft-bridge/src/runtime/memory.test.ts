import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { createBootstrapBrainInput } from '../brain/benchmark/bootstrap.js'
import type { MemoryIdentity } from '../memory/types.js'
import { createAgentMemory, memoryFilePath } from './memory.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})

describe('runtime memory isolation', () => {
  it('does not retrieve Alice episodes or facts through Bob in the same world', async () => {
    const directory = await temporaryDirectory()
    const alice = await createAgentMemory(options(directory, 'alice'))
    const bob = await createAgentMemory(options(directory, 'bob'))
    const input = createBootstrapBrainInput()
    const observed = {
      ...input.perception,
      timestamp: 100,
      nearbyBlocks: [{
        name: 'oak_log',
        distance: 2,
        position: { x: 2, y: 64, z: 0 }
      }]
    }

    const recorded = await alice.record({
      before: input.perception,
      after: observed,
      decision: { action: 'scan', reason: 'Observe resources.' },
      result: {
        success: true,
        action: 'scan',
        status: 'completed',
        summary: 'Scanned.'
      },
      goalTransition: null
    })
    await alice.flush()
    const bobResult = await bob.retrieve({
      ...input,
      perception: observed
    })

    assert.equal(recorded.episodesCreated, 1)
    assert.equal(recorded.semanticFactsCreated, 1)
    assert.deepEqual(bobResult.context, {
      recentEpisodes: [],
      relevantFacts: []
    })
    assert.notEqual(
      memoryFilePath(directory, identity('alice')),
      memoryFilePath(directory, identity('bob'))
    )
  })

  it('keeps Alice usable when Bob memory is malformed', async () => {
    const directory = await temporaryDirectory()
    const alice = await createAgentMemory(options(directory, 'alice'))
    await alice.flush()
    const aliceBefore = await readFile(
      memoryFilePath(directory, identity('alice')),
      'utf8'
    )
    const bobPath = memoryFilePath(directory, identity('bob'))
    await writeFile(bobPath, '{broken', 'utf8')

    await assert.rejects(
      createAgentMemory(options(directory, 'bob')),
      /malformed JSON/
    )
    const reopenedAlice = await createAgentMemory(options(directory, 'alice'))
    await reopenedAlice.flush()

    assert.equal(
      await readFile(memoryFilePath(directory, identity('alice')), 'utf8'),
      aliceBefore
    )
    assert.equal(await readFile(bobPath, 'utf8'), '{broken')
  })

  it('rejects traversal-shaped runtime identities before constructing a path', () => {
    assert.throws(
      () => memoryFilePath('/memory', { agentId: '../bob', worldId: 'local-paper' }),
      /invalid agent memory identity/i
    )
    assert.throws(
      () => memoryFilePath('/memory', { agentId: 'bob', worldId: '../world' }),
      /invalid world memory identity/i
    )
  })
})

function options(directory: string, agentId: string) {
  return {
    baseDirectory: directory,
    identity: identity(agentId),
    episodeLimit: 4,
    factLimit: 4,
    debug: false
  }
}

function identity(agentId: string): MemoryIdentity {
  return { agentId, worldId: 'local-paper' }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'minecraft-agent-memory-'))
  temporaryDirectories.push(directory)
  return directory
}
