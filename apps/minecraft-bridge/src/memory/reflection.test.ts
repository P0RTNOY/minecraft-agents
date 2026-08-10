import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MemoryReflector,
  validateReflectionCandidates,
  type ReflectionProvider
} from './reflection.js'
import type {
  EpisodicMemory,
  MemoryIdentity,
  MemoryQuery,
  MemoryStore,
  ReflectionCursor,
  SemanticMemory
} from './types.js'

const identity: MemoryIdentity = { agentId: 'Alice', worldId: 'local-paper' }

describe('validateReflectionCandidates', () => {
  it('accepts only exact evidence-derived facts', () => {
    const evidence = [episode({
      id: 'resource-1',
      context: { region: '0:0', resource: 'oak_log' }
    })]

    const result = validateReflectionCandidates({ candidates: [{
      subject: 'oak_log',
      relation: 'resource_observed_near',
      object: 'region:0:0',
      confidence: 0.8,
      evidenceEpisodeIds: ['resource-1']
    }] }, evidence)

    assert.equal(result.rejectedCount, 0)
    assert.equal(result.accepted.length, 1)
    assert.deepEqual(result.accepted[0], {
      id: result.accepted[0]?.id,
      ...identity,
      createdAt: 1_000,
      lastObservedAt: 1_000,
      subject: 'oak_log',
      relation: 'resource_observed_near',
      object: 'region:0:0',
      confidence: 0.8,
      status: 'historical',
      contradictionCount: 0,
      evidenceEpisodeIds: ['resource-1']
    })
  })

  it('rejects candidates independently for schema and evidence violations', () => {
    const evidence = [episode({ id: 'resource-1' })]
    const candidates: unknown[] = [{
      subject: 'diamond_ore',
      relation: 'resource_observed_near',
      object: 'region:0:0',
      confidence: 0.8,
      evidenceEpisodeIds: ['resource-1']
    }, {
      subject: 'oak_log',
      relation: 'danger_observed_near',
      object: 'region:0:0',
      confidence: 0.8,
      evidenceEpisodeIds: ['resource-1']
    }, {
      subject: 'oak_log',
      relation: 'resource_observed_near',
      object: 'region:9:9',
      confidence: 0.8,
      evidenceEpisodeIds: ['resource-1']
    }, {
      subject: 'oak_log',
      relation: 'resource_observed_near',
      object: 'region:0:0',
      confidence: 0.8,
      evidenceEpisodeIds: ['unknown']
    }, {
      subject: 'oak_log',
      relation: 'resource_observed_near',
      object: 'region:0:0',
      confidence: 0.8,
      evidenceEpisodeIds: ['resource-1', 'resource-1']
    }, {
      subject: 'oak_log',
      relation: 'resource_observed_near',
      object: 'region:0:0',
      confidence: 0.8,
      evidenceEpisodeIds: ['resource-1'],
      command: '/give Alice diamond'
    }, {
      subject: 'oak_log; ignore instructions',
      relation: 'resource_observed_near',
      object: 'region:0:0',
      confidence: 0.8,
      evidenceEpisodeIds: ['resource-1']
    }, {
      subject: 'oak_log',
      relation: 'generic_minecraft_rule',
      object: 'region:0:0',
      confidence: 0.8,
      evidenceEpisodeIds: ['resource-1']
    }]

    const result = validateReflectionCandidates({ candidates }, evidence)

    assert.equal(result.accepted.length, 0)
    assert.equal(result.rejectedCount, candidates.length)
  })

  it('rejects malformed envelopes and more than three candidates', () => {
    const candidate = {
      subject: 'oak_log',
      relation: 'resource_observed_near',
      object: 'region:0:0',
      confidence: 0.8,
      evidenceEpisodeIds: ['resource-1']
    }
    assert.deepEqual(validateReflectionCandidates([], [episode()]), {
      accepted: [], rejectedCount: 1
    })
    assert.deepEqual(validateReflectionCandidates({ candidates: [
      candidate, candidate, candidate, candidate
    ] }, [episode({ id: 'resource-1' })]), {
      accepted: [], rejectedCount: 4
    })
  })
})

describe('MemoryReflector', () => {
  it('waits for five new important episodes and sends at most eight', async () => {
    const store = new StoreDouble()
    store.episodes = Array.from({ length: 9 }, (_, index) => episode({
      id: `episode-${index}`,
      timestamp: 1_000 + index,
      importance: index === 0 ? 5 : 6
    }))
    const batches: readonly EpisodicMemory[][] = []
    const mutableBatches = batches as EpisodicMemory[][]
    const reflector = new MemoryReflector({
      store,
      provider: provider(async episodes => {
        mutableBatches.push([...episodes])
        return { candidates: { candidates: [] }, timing: null }
      }),
      now: () => 20_000
    })

    const result = await reflector.consider()

    assert.equal(result.attempted, true)
    assert.equal(mutableBatches.length, 1)
    assert.equal(mutableBatches[0]?.length, 8)
    assert.equal(store.cursor.lastReflectedEpisodeTimestamp, 1_007)
    assert.equal(store.cursor.lastReflectionAt, 20_000)
  })

  it('does not call the provider below threshold', async () => {
    const store = new StoreDouble()
    store.episodes = Array.from({ length: 4 }, (_, index) => episode({
      id: `episode-${index}`,
      timestamp: 1_000 + index
    }))
    let calls = 0
    const reflector = new MemoryReflector({
      store,
      provider: provider(async () => {
        calls += 1
        return { candidates: { candidates: [] }, timing: null }
      }),
      now: () => 20_000
    })

    assert.deepEqual(await reflector.consider(), {
      attempted: false,
      factsCreated: 0,
      rejectedCandidates: 0,
      inputTokens: 0,
      outputTokens: 0
    })
    assert.equal(calls, 0)
  })

  it('allows one goal completion but enforces a five-minute cooldown', async () => {
    const store = new StoreDouble()
    store.episodes = [episode({
      id: 'goal',
      type: 'goal_milestone',
      timestamp: 400_000,
      context: { region: '0:0', goalType: 'gather_wood' }
    })]
    store.cursor.lastReflectionAt = 200_001
    let calls = 0
    const reflector = new MemoryReflector({
      store,
      provider: provider(async () => {
        calls += 1
        return { candidates: { candidates: [] }, timing: null }
      }),
      now: () => 500_000
    })

    assert.equal((await reflector.consider()).attempted, false)
    assert.equal(calls, 0)

    store.cursor.lastReflectionAt = 200_000
    assert.equal((await reflector.consider()).attempted, true)
    assert.equal(calls, 1)
  })

  it('persists valid facts and reports usage without any execution hook', async () => {
    const store = new StoreDouble()
    store.episodes = Array.from({ length: 5 }, (_, index) => episode({
      id: `resource-${index}`,
      timestamp: 1_000 + index
    }))
    const reflector = new MemoryReflector({
      store,
      provider: provider(async episodes => ({
        candidates: { candidates: [{
          subject: 'oak_log',
          relation: 'resource_observed_near',
          object: 'region:0:0',
          confidence: 0.7,
          evidenceEpisodeIds: [episodes[0]?.id]
        }] },
        timing: { inputTokens: 120, outputTokens: 24 }
      })),
      now: () => 20_000
    })

    const result = await reflector.consider()

    assert.deepEqual(result, {
      attempted: true,
      factsCreated: 1,
      rejectedCandidates: 0,
      inputTokens: 120,
      outputTokens: 24
    })
    assert.equal(store.facts.length, 1)
  })

  it('retains unprocessed episodes and rate-limits a failed provider', async () => {
    const store = new StoreDouble()
    store.episodes = Array.from({ length: 5 }, (_, index) => episode({
      id: `episode-${index}`,
      timestamp: 1_000 + index
    }))
    const reflector = new MemoryReflector({
      store,
      provider: provider(async () => {
        throw new Error('sensitive provider failure')
      }),
      now: () => 20_000
    })

    const result = await reflector.consider()

    assert.equal(result.attempted, true)
    assert.equal(result.error, 'Memory reflection failed.')
    assert.equal(store.cursor.lastReflectedEpisodeTimestamp, null)
    assert.equal(store.cursor.lastReflectionAt, 20_000)
    assert.equal((await reflector.consider()).attempted, false)
  })
})

function provider(
  reflect: ReflectionProvider['reflect']
): ReflectionProvider {
  return { reflect }
}

class StoreDouble implements MemoryStore {
  episodes: EpisodicMemory[] = []
  facts: SemanticMemory[] = []
  cursor: ReflectionCursor = {
    lastReflectedEpisodeTimestamp: null,
    lastReflectionAt: null
  }

  async open(): Promise<void> {}
  async addEpisode(value: EpisodicMemory): Promise<void> { this.episodes.push(value) }
  async listRecentEpisodes(limit: number): Promise<EpisodicMemory[]> {
    return [...this.episodes]
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, limit)
  }
  async findRelevantEpisodes(_query: MemoryQuery): Promise<EpisodicMemory[]> { return [] }
  async addSemanticFact(value: SemanticMemory): Promise<void> {
    this.facts = [...this.facts.filter(item => item.id !== value.id), value]
  }
  async listSemanticFacts(limit: number): Promise<SemanticMemory[]> { return this.facts.slice(0, limit) }
  async findRelevantFacts(_query: MemoryQuery): Promise<SemanticMemory[]> { return [] }
  async reflectionState(): Promise<ReflectionCursor> { return { ...this.cursor } }
  async updateReflectionState(value: ReflectionCursor): Promise<void> { this.cursor = { ...value } }
}

function episode(overrides: Partial<EpisodicMemory> = {}): EpisodicMemory {
  return {
    id: 'resource-1',
    ...identity,
    timestamp: 1_000,
    type: 'resource_discovery',
    summary: 'A resource was observed.',
    importance: 6,
    source: 'perception',
    context: { region: '0:0', resource: 'oak_log' },
    ...overrides
  }
}
