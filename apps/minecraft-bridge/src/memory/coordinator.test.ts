import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  AgentMemoryCoordinator,
  type MemoryCycleEvent
} from './coordinator.js'
import { EMPTY_MEMORY_CONTEXT } from './retrieval.js'
import type {
  EpisodicMemory,
  MemoryIdentity,
  MemoryQuery,
  MemoryStore,
  ReflectionCursor,
  SemanticMemory
} from './types.js'
import type { BrainInput } from '../brain/types.js'
import type { PerceptionSnapshot } from '../perception/types.js'

const identity: MemoryIdentity = {
  agentId: 'Alice',
  worldId: 'local-paper'
}

describe('AgentMemoryCoordinator', () => {
  it('persists sparse episodes and consolidates world-specific semantic facts', async () => {
    const store = new MemoryStoreDouble()
    const coordinator = new AgentMemoryCoordinator({
      store,
      recorder: {
        observe: () => [
          episode({ id: 'resource', type: 'resource_discovery', context: { region: '0:0', resource: 'oak_log' } }),
          episode({ id: 'landmark', type: 'landmark_discovery', context: { region: '0:0', landmark: 'crafting_table' } }),
          episode({ id: 'danger', type: 'threat_encounter', context: { region: '0:0', target: 'creeper' } }),
          episode({ id: 'player', type: 'player_interaction', context: { region: '0:0', player: 'Steve' } })
        ]
      },
      identity
    })

    const recorded = await coordinator.record(cycleEvent())

    assert.deepEqual(recorded, {
      episodesCreated: 4,
      semanticFactsCreated: 4
    })
    assert.deepEqual(store.facts.map(fact => [
      fact.subject,
      fact.relation,
      fact.object
    ]), [
      ['oak_log', 'resource_observed_near', 'region:0:0'],
      ['crafting_table', 'landmark_observed_near', 'region:0:0'],
      ['creeper', 'danger_observed_near', 'region:0:0'],
      ['Steve', 'player_interacted_near', 'region:0:0']
    ])
  })

  it('upserts duplicate fact tuples and merges bounded evidence', async () => {
    const store = new MemoryStoreDouble()
    store.facts.push(fact({
      id: 'existing-fact',
      subject: 'oak_log',
      relation: 'resource_observed_near',
      confidence: 0.7,
      evidenceEpisodeIds: ['prior-evidence']
    }))
    const coordinator = new AgentMemoryCoordinator({
      store,
      recorder: {
        observe: () => [episode({
          id: 'new-evidence',
          timestamp: 1_002,
          context: { region: '0:0', resource: 'oak_log' }
        })]
      },
      identity
    })

    const recorded = await coordinator.record(cycleEvent())

    assert.equal(recorded.semanticFactsCreated, 0)
    assert.equal(store.facts.length, 1)
    assert.deepEqual(store.facts[0]?.evidenceEpisodeIds, [
      'prior-evidence',
      'new-evidence'
    ])
    assert.equal(store.facts[0]?.lastObservedAt, 1_002)
  })

  it('does not duplicate an existing episode after recorder restart', async () => {
    const store = new MemoryStoreDouble()
    const first = new AgentMemoryCoordinator({
      store,
      recorder: {
        observe: () => [episode({ id: 'before-restart' })]
      },
      identity
    })
    const restarted = new AgentMemoryCoordinator({
      store,
      recorder: {
        observe: () => [episode({ id: 'after-restart', timestamp: 2_000 })]
      },
      identity
    })

    await first.record(cycleEvent())
    const duplicate = await restarted.record(cycleEvent())

    assert.equal(duplicate.episodesCreated, 0)
    assert.equal(store.episodes.length, 1)
    assert.equal(store.episodes[0]?.id, 'before-restart')
  })

  it('repairs a missing semantic fact after an interrupted prior consolidation', async () => {
    const store = new MemoryStoreDouble()
    store.episodes.push(episode({ id: 'persisted-before-interruption' }))
    const restarted = new AgentMemoryCoordinator({
      store,
      recorder: {
        observe: () => [episode({ id: 'proposed-after-restart', timestamp: 2_000 })]
      },
      identity
    })

    const repaired = await restarted.record(cycleEvent())

    assert.equal(repaired.episodesCreated, 0)
    assert.equal(repaired.semanticFactsCreated, 1)
    assert.equal(store.episodes.length, 1)
    assert.deepEqual(store.facts[0]?.evidenceEpisodeIds, [
      'persisted-before-interruption'
    ])
  })

  it('retrieves compact bounded context and never returns live capabilities', async () => {
    const store = new MemoryStoreDouble()
    store.episodes.push(
      episode({ id: 'one', importance: 8 }),
      episode({ id: 'two', importance: 7 }),
      episode({ id: 'three', importance: 6 })
    )
    store.facts.push(
      fact({ id: 'fact-one', subject: 'diamond_ore', relation: 'resource_observed_near' }),
      fact({ id: 'fact-two', subject: 'crafting_table' })
    )
    const coordinator = new AgentMemoryCoordinator({
      store,
      recorder: { observe: () => [] },
      identity,
      episodeLimit: 2,
      factLimit: 1
    })

    const retrieved = await coordinator.retrieve(brainInput())

    assert.equal(retrieved.context.recentEpisodes.length, 2)
    assert.equal(retrieved.context.relevantFacts.length, 1)
    assert.equal('availableCapabilities' in retrieved.context, false)
    assert.equal('perception' in retrieved.context, false)
    assert.equal('id' in (retrieved.context.relevantFacts[0] ?? {}), false)
    assert.deepEqual(coordinator.metrics(), {
      episodesCreated: 0,
      episodesRetrieved: 2,
      semanticFactsCreated: 0,
      semanticFactsRetrieved: 1,
      retrievalFailures: 0,
      persistenceFailures: 0
    })
  })

  it('reconciles covered facts against current perception before retrieval', async () => {
    const store = new MemoryStoreDouble()
    store.facts.push(fact({ confidence: 1 }))
    const coordinator = new AgentMemoryCoordinator({
      store,
      recorder: { observe: () => [] },
      identity
    })

    await coordinator.retrieve(brainInput())
    await coordinator.retrieve(brainInput())

    assert.equal(store.facts[0]?.status, 'stale')
    assert.equal(store.facts[0]?.confidence, 0.6)
    assert.equal(store.facts[0]?.contradictionCount, 2)
  })

  it('refreshes a stale fact when current perception observes it', async () => {
    const store = new MemoryStoreDouble()
    store.facts.push(fact({
      status: 'stale',
      confidence: 0.4,
      contradictionCount: 2
    }))
    const coordinator = new AgentMemoryCoordinator({
      store,
      recorder: { observe: () => [] },
      identity
    })

    await coordinator.retrieve(brainInput({ nearbyCraftingTable: true }))

    assert.equal(store.facts[0]?.status, 'historical')
    assert.equal(store.facts[0]?.confidence, 0.6)
    assert.equal(store.facts[0]?.contradictionCount, 0)
  })

  it('fails closed to empty context and surfaces safe error metrics', async () => {
    const store = new MemoryStoreDouble()
    store.failure = new Error('raw store details must not escape')
    const coordinator = new AgentMemoryCoordinator({
      store,
      recorder: { observe: () => [episode()] },
      identity
    })

    const retrieved = await coordinator.retrieve(brainInput())
    const recorded = await coordinator.record(cycleEvent())

    assert.strictEqual(retrieved.context, EMPTY_MEMORY_CONTEXT)
    assert.equal(retrieved.error, 'Memory store operation failed.')
    assert.equal(recorded.error, 'Memory store operation failed.')
    assert.equal(coordinator.metrics().retrievalFailures, 1)
    assert.equal(coordinator.metrics().persistenceFailures, 1)
  })
})

class MemoryStoreDouble implements MemoryStore {
  episodes: EpisodicMemory[] = []
  facts: SemanticMemory[] = []
  cursor: ReflectionCursor = {
    lastReflectedEpisodeTimestamp: null,
    lastReflectionAt: null
  }
  failure: Error | null = null

  async open(): Promise<void> {}

  async addEpisode(value: EpisodicMemory): Promise<void> {
    this.maybeFail()
    this.episodes = [...this.episodes.filter(item => item.id !== value.id), value]
  }

  async listRecentEpisodes(limit: number): Promise<EpisodicMemory[]> {
    this.maybeFail()
    return this.episodes.slice(0, limit)
  }

  async findRelevantEpisodes(query: MemoryQuery): Promise<EpisodicMemory[]> {
    this.maybeFail()
    return this.episodes.slice(0, query.episodeLimit)
  }

  async addSemanticFact(value: SemanticMemory): Promise<void> {
    this.maybeFail()
    this.facts = [...this.facts.filter(item => item.id !== value.id), value]
  }

  async listSemanticFacts(limit: number): Promise<SemanticMemory[]> {
    this.maybeFail()
    return this.facts.slice(0, limit)
  }

  async findRelevantFacts(query: MemoryQuery): Promise<SemanticMemory[]> {
    this.maybeFail()
    return this.facts.slice(0, query.factLimit)
  }

  async reflectionState(): Promise<ReflectionCursor> {
    this.maybeFail()
    return { ...this.cursor }
  }

  async updateReflectionState(value: ReflectionCursor): Promise<void> {
    this.maybeFail()
    this.cursor = { ...value }
  }

  private maybeFail(): void {
    if (this.failure) throw this.failure
  }
}

function brainInput(
  perceptionOverrides: Partial<PerceptionSnapshot> = {}
): BrainInput {
  const perception = snapshot(perceptionOverrides)
  return {
    perception,
    state: {
      agentName: identity.agentId,
      status: 'idle',
      currentAction: null,
      currentGoal: null,
      actionSource: null,
      busy: false
    },
    previousActionResult: null,
    recentDecisions: [],
    shortTermGoal: {
      id: 'goal-1',
      type: 'explore_for_resources',
      description: 'Explore.',
      status: 'active'
    },
    goalProgress: null,
    availableCapabilities: {
      observedCollectableBlocks: perception.nearbyBlocks.map(item => item.name),
      craftableItems: [],
      placeableBlocks: [],
      canExplore: true
    },
    memory: { recentEpisodes: [], relevantFacts: [] }
  }
}

function cycleEvent(): MemoryCycleEvent {
  return {
    before: snapshot(),
    after: snapshot(),
    decision: { action: 'scan', reason: 'Observe.' },
    result: {
      success: true,
      action: 'scan',
      status: 'completed',
      summary: 'Scanned.'
    },
    goalTransition: null
  }
}

function snapshot(
  overrides: Partial<PerceptionSnapshot> = {}
): PerceptionSnapshot {
  return {
    agent: identity.agentId,
    timestamp: 2_000,
    position: { x: 1, y: 64, z: 1 },
    health: 20,
    food: 20,
    nearbyBlocks: [],
    nearbyEntities: [],
    inventory: [],
    edibleItemCount: 0,
    craftableItems: [],
    nearbyCraftingTable: false,
    equippedItem: null,
    placeableBlocks: [],
    ...overrides
  }
}

function block(name: string) {
  return { name, distance: 2, position: { x: 2, y: 64, z: 2 } }
}

function episode(overrides: Partial<EpisodicMemory> = {}): EpisodicMemory {
  return {
    id: 'episode',
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

function fact(overrides: Partial<SemanticMemory> = {}): SemanticMemory {
  return {
    id: 'fact',
    ...identity,
    createdAt: 1_000,
    lastObservedAt: 1_000,
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
