import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  compactEpisode,
  compactFact,
  EMPTY_MEMORY_CONTEXT,
  rankEpisodes,
  rankSemanticFacts,
  reconcileFactWithPerception
} from './retrieval.js'
import type {
  EpisodicMemory,
  MemoryQuery,
  SemanticMemory
} from './types.js'

const MINUTE = 60_000
const NOW = 2_000_000

const query: MemoryQuery = {
  agentId: 'Alice',
  worldId: 'local-paper',
  now: NOW,
  region: '0:0',
  goalType: 'explore_for_resources',
  observedNames: [],
  recentFailureSignatures: [],
  episodeLimit: 4,
  factLimit: 4
}

describe('memory retrieval', () => {
  it('ranks bounded goal/category matches ahead of merely recent memories', () => {
    const recentFailure = episode({
      id: 'recent-failure',
      timestamp: NOW - MINUTE,
      type: 'action_failure',
      importance: 5,
      context: {
        region: '1:1',
        action: 'craft_item',
        target: 'stick',
        outcome: 'missing_materials'
      }
    })
    const olderOakDiscovery = episode({
      id: 'older-oak',
      timestamp: NOW - 10 * MINUTE,
      type: 'resource_discovery',
      importance: 6,
      context: { region: '0:0', resource: 'oak_log' }
    })

    const ranked = rankEpisodes(
      [recentFailure, olderOakDiscovery],
      { ...query, observedNames: ['oak_log'], episodeLimit: 1 }
    )

    assert.deepEqual(ranked.map(item => item.id), ['older-oak'])
  })

  it('uses region, failure signature, and recency buckets with stable ties', () => {
    const failures = [
      episode({
        id: 'region-only',
        type: 'action_failure',
        timestamp: NOW - 20 * MINUTE,
        context: { region: '0:0', action: 'collect_block', target: 'oak_log', outcome: 'blocked' }
      }),
      episode({
        id: 'failure-match',
        type: 'action_failure',
        timestamp: NOW - 20 * MINUTE,
        context: { region: '1:1', action: 'collect_block', target: 'oak_log', outcome: 'blocked' }
      }),
      episode({ id: 'tie-b', timestamp: NOW - 2 * MINUTE, importance: 4 }),
      episode({ id: 'tie-a', timestamp: NOW - 2 * MINUTE, importance: 4 })
    ]

    const ranked = rankEpisodes(failures, {
      ...query,
      recentFailureSignatures: ['collect_block:oak_log:blocked:1:1'],
      episodeLimit: 4
    })

    assert.equal(ranked[0]?.id, 'failure-match')
    assert.deepEqual(
      ranked.filter(item => item.id.startsWith('tie-')).map(item => item.id),
      ['tie-a', 'tie-b']
    )
  })

  it('enforces independent 1-6 retrieval limits and returns clones', () => {
    const original = episode({ id: 'clone-me' })
    assert.throws(
      () => rankEpisodes([original], { ...query, episodeLimit: 0 }),
      /1 to 6/
    )
    assert.throws(
      () => rankEpisodes([original], { ...query, episodeLimit: 7 }),
      /1 to 6/
    )

    const [retrieved] = rankEpisodes([original], {
      ...query,
      episodeLimit: 1
    })
    assert.ok(retrieved)
    retrieved.context.region = 'changed'
    assert.equal(original.context.region, '0:0')
  })

  it('penalizes stale semantic facts while preserving stable ordering', () => {
    const historical = fact({ id: 'historical', confidence: 0.6 })
    const stale = fact({ id: 'stale', confidence: 0.9, status: 'stale' })
    const tieB = fact({ id: 'tie-b', subject: 'bamboo', confidence: 0.4 })
    const tieA = fact({ id: 'tie-a', subject: 'bamboo', confidence: 0.4 })

    const ranked = rankSemanticFacts(
      [stale, historical, tieB, tieA],
      { ...query, observedNames: ['crafting_table'], factLimit: 4 }
    )

    assert.equal(ranked[0]?.id, 'historical')
    assert.deepEqual(
      ranked.filter(item => item.id.startsWith('tie-')).map(item => item.id),
      ['tie-a', 'tie-b']
    )
    ranked[0]!.evidenceEpisodeIds.push('mutated')
    assert.deepEqual(historical.evidenceEpisodeIds, ['episode'])
  })

  it('ranks semantic categories relevant to the active goal', () => {
    const resource = fact({
      id: 'resource',
      subject: 'oak_log',
      relation: 'resource_observed_near',
      confidence: 0.7
    })
    const player = fact({
      id: 'player',
      subject: 'Steve',
      relation: 'player_interacted_near',
      confidence: 0.8
    })

    assert.equal(
      rankSemanticFacts([player, resource], {
        ...query,
        factLimit: 1
      })[0]?.id,
      'resource'
    )
  })

  it('marks an absent remembered landmark stale only after two covered contradictions', () => {
    const table = fact({ confidence: 1 })
    const contradiction = {
      observedAt: NOW,
      region: '0:0',
      regionCovered: true,
      observedNames: ['oak_log']
    }

    const once = reconcileFactWithPerception(table, contradiction)
    const twice = reconcileFactWithPerception(once, contradiction)

    assert.equal(once.status, 'historical')
    assert.equal(once.contradictionCount, 1)
    assert.equal(once.confidence, 0.8)
    assert.equal(twice.status, 'stale')
    assert.equal(twice.contradictionCount, 2)
    assert.equal(twice.confidence, 0.6)
  })

  it('does not contradict facts outside current perception coverage', () => {
    const table = fact()

    assert.deepEqual(
      reconcileFactWithPerception(table, {
        observedAt: NOW,
        region: '0:0',
        regionCovered: false,
        observedNames: []
      }),
      table
    )
    assert.deepEqual(
      reconcileFactWithPerception(table, {
        observedAt: NOW,
        region: '1:1',
        regionCovered: true,
        observedNames: []
      }),
      table
    )
  })

  it('refreshes matching live evidence and clears stale state', () => {
    const stale = fact({
      confidence: 0.4,
      status: 'stale',
      contradictionCount: 3,
      lastObservedAt: NOW - 1000
    })

    const refreshed = reconcileFactWithPerception(stale, {
      observedAt: NOW,
      region: '0:0',
      regionCovered: true,
      observedNames: ['crafting_table']
    })

    assert.equal(refreshed.status, 'historical')
    assert.equal(refreshed.contradictionCount, 0)
    assert.equal(refreshed.confidence, 0.6)
    assert.equal(refreshed.lastObservedAt, NOW)
  })

  it('does not infer contradictions for relation types without bounded spatial coverage', () => {
    const danger = fact({
      relation: 'danger_observed_near',
      subject: 'creeper'
    })
    assert.deepEqual(
      reconcileFactWithPerception(danger, {
        observedAt: NOW,
        region: '0:0',
        regionCovered: true,
        observedNames: []
      }),
      danger
    )
  })

  it('compacts records without persistence metadata and labels historical age', () => {
    const compactedEpisode = compactEpisode(
      episode({ timestamp: NOW - 2 * 60 * MINUTE }),
      NOW
    )
    const compactedFact = compactFact(
      fact({ lastObservedAt: NOW - 2 * 24 * 60 * MINUTE, status: 'stale' }),
      NOW
    )

    assert.deepEqual(compactedEpisode, {
      type: 'resource_discovery',
      summary: 'Oak logs were observed in this region.',
      importance: 6,
      age: 'today',
      region: '0:0'
    })
    assert.deepEqual(compactedFact, {
      subject: 'crafting_table',
      relation: 'landmark_observed_near',
      object: 'region:0:0',
      confidence: 0.8,
      status: 'stale',
      age: 'older'
    })
    assert.equal('id' in compactedEpisode, false)
    assert.equal('agentId' in compactedFact, false)
  })

  it('provides a stable empty bounded Brain context', () => {
    assert.deepEqual(EMPTY_MEMORY_CONTEXT, {
      recentEpisodes: [],
      relevantFacts: []
    })
    assert.equal(Object.isFrozen(EMPTY_MEMORY_CONTEXT), true)
    assert.equal(Object.isFrozen(EMPTY_MEMORY_CONTEXT.recentEpisodes), true)
    assert.equal(Object.isFrozen(EMPTY_MEMORY_CONTEXT.relevantFacts), true)
  })
})

function episode(
  overrides: Partial<EpisodicMemory> = {}
): EpisodicMemory {
  return {
    id: 'episode',
    agentId: query.agentId,
    worldId: query.worldId,
    timestamp: NOW - 30 * MINUTE,
    type: 'resource_discovery',
    summary: 'Oak logs were observed in this region.',
    importance: 6,
    source: 'perception',
    context: { region: '0:0', resource: 'oak_log' },
    ...overrides
  }
}

function fact(
  overrides: Partial<SemanticMemory> = {}
): SemanticMemory {
  return {
    id: 'fact',
    agentId: query.agentId,
    worldId: query.worldId,
    createdAt: NOW - 60 * MINUTE,
    lastObservedAt: NOW - 30 * MINUTE,
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
