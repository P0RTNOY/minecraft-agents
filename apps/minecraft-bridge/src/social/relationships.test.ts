import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { SocialEvent } from './events.js'
import {
  AGENT_SEEN_FAMILIARITY_DELTA,
  AgentRelationshipService,
  CONVERSATION_FAMILIARITY_DELTA,
  applyRelationshipEvent,
  createEmptyRelationship,
  type RelationshipRecord,
  type RelationshipStore
} from './relationships.js'

describe('relationship policy', () => {
  it('updates a directed first encounter deterministically', () => {
    const aliceToBob = createEmptyRelationship({
      observerAgentId: 'alice',
      targetAgentId: 'bob',
      worldId: 'local-paper',
      timestamp: 10
    })

    const update = applyRelationshipEvent(
      aliceToBob,
      seenEvent({ timestamp: 20 }),
      60_000
    )

    assert.equal(update.changed, true)
    assert.equal(update.category, 'agent_seen')
    assert.equal(update.record.familiarity, AGENT_SEEN_FAMILIARITY_DELTA)
    assert.equal(update.record.trust, 0)
    assert.equal(update.record.affinity, 0)
    assert.equal(update.record.reciprocity, 0)
    assert.equal(update.record.interactionCount, 0)
    assert.equal(update.record.lastVerifiedEventAt, 20)
  })

  it('keeps Alice to Bob independent from Bob to Alice', () => {
    const aliceToBob = applyRelationshipEvent(
      createEmptyRelationship({
        observerAgentId: 'alice', targetAgentId: 'bob',
        worldId: 'local-paper', timestamp: 1
      }),
      seenEvent({ timestamp: 2 }),
      1000
    ).record
    const bobToAlice = createEmptyRelationship({
      observerAgentId: 'bob', targetAgentId: 'alice',
      worldId: 'local-paper', timestamp: 1
    })

    assert.equal(aliceToBob.familiarity, 1)
    assert.equal(bobToAlice.familiarity, 0)
  })

  it('deduplicates encounters during cooldown and accepts a later encounter', () => {
    const initial = createEmptyRelationship({
      observerAgentId: 'alice', targetAgentId: 'bob',
      worldId: 'local-paper', timestamp: 0
    })
    const first = applyRelationshipEvent(initial, seenEvent({ timestamp: 1000 }), 60_000)
    const duplicate = applyRelationshipEvent(
      first.record,
      seenEvent({ id: 'seen-2', timestamp: 60_999 }),
      60_000
    )
    const later = applyRelationshipEvent(
      duplicate.record,
      seenEvent({ id: 'seen-3', timestamp: 61_000 }),
      60_000
    )

    assert.equal(duplicate.changed, false)
    assert.equal(duplicate.record.familiarity, 1)
    assert.equal(later.changed, true)
    assert.equal(later.record.familiarity, 2)
  })

  it('increments familiarity and interaction count only for completed conversations', () => {
    const initial = createEmptyRelationship({
      observerAgentId: 'alice', targetAgentId: 'bob',
      worldId: 'local-paper', timestamp: 0
    })
    const completed = applyRelationshipEvent(
      initial,
      conversationEvent('conversation_completed', 100),
      60_000
    )
    const repeated = applyRelationshipEvent(
      completed.record,
      conversationEvent('conversation_completed', 100),
      60_000
    )

    assert.equal(completed.record.familiarity, CONVERSATION_FAMILIARITY_DELTA)
    assert.equal(completed.record.interactionCount, 1)
    assert.equal(completed.record.lastInteractionAt, 100)
    assert.equal(repeated.changed, false)
  })

  it('does not update relationships from speech, starts, or interruptions', () => {
    const initial = createEmptyRelationship({
      observerAgentId: 'alice', targetAgentId: 'bob',
      worldId: 'local-paper', timestamp: 0
    })
    const speech = applyRelationshipEvent(initial, speechEvent(), 60_000)
    const started = applyRelationshipEvent(
      speech.record,
      conversationEvent('conversation_started', 20),
      60_000
    )
    const interrupted = applyRelationshipEvent(
      started.record,
      conversationEvent('conversation_interrupted', 30),
      60_000
    )

    assert.equal(speech.changed, false)
    assert.equal(started.changed, false)
    assert.equal(interrupted.changed, false)
    assert.deepEqual(interrupted.record, initial)
  })

  it('does not update from mutating event types with unverified provenance', () => {
    const initial = createEmptyRelationship({
      observerAgentId: 'alice', targetAgentId: 'bob',
      worldId: 'local-paper', timestamp: 0
    })
    const unverifiedSeen = applyRelationshipEvent(
      initial,
      seenEvent({ verified: false }),
      60_000
    )
    const spoofedCompletion = applyRelationshipEvent(
      initial,
      {
        ...conversationEvent('conversation_completed', 20),
        evidence: 'minecraft_chat'
      },
      60_000
    )

    assert.equal(unverifiedSeen.changed, false)
    assert.equal(spoofedCompletion.changed, false)
    assert.deepEqual(unverifiedSeen.record, initial)
    assert.deepEqual(spoofedCompletion.record, initial)
  })

  it('clamps bounded fields and rejects mismatched identity', () => {
    const saturated: RelationshipRecord = {
      ...createEmptyRelationship({
        observerAgentId: 'alice', targetAgentId: 'bob',
        worldId: 'local-paper', timestamp: 0
      }),
      familiarity: 100,
      trust: 100,
      affinity: -100,
      reciprocity: 100,
      interactionCount: Number.MAX_SAFE_INTEGER
    }
    const update = applyRelationshipEvent(
      saturated,
      conversationEvent('conversation_completed', 100),
      60_000
    )
    assert.equal(update.record.familiarity, 100)
    assert.equal(update.record.interactionCount, Number.MAX_SAFE_INTEGER)

    assert.throws(
      () => applyRelationshipEvent(saturated, seenEvent({
        worldId: 'other-world'
      }), 60_000),
      /identity does not match/
    )
  })
})

describe('AgentRelationshipService', () => {
  it('persists only verified relationship updates for its owning observer', async () => {
    const store = new InMemoryRelationshipStore()
    const service = new AgentRelationshipService({
      identity: { observerAgentId: 'alice', worldId: 'local-paper' },
      configuredTargetAgentIds: ['bob', 'charlie'],
      store,
      encounterCooldownMs: 60_000
    })

    assert.equal((await service.record(speechEvent())).changed, false)
    assert.equal((await service.record(seenEvent({ timestamp: 100 }))).changed, true)
    assert.equal((await service.record(seenEvent({ id: 'seen-2', timestamp: 101 }))).changed, false)
    assert.equal((await store.list()).length, 1)
    assert.equal((await store.get('bob'))?.familiarity, 1)

    await assert.rejects(
      () => service.record(seenEvent({ observerAgentId: 'charlie' })),
      /owning observer/
    )
  })

  it('returns neutral owned summaries without exposing mutable records', async () => {
    const store = new InMemoryRelationshipStore()
    const service = new AgentRelationshipService({
      identity: { observerAgentId: 'alice', worldId: 'local-paper' },
      configuredTargetAgentIds: ['bob', 'charlie'],
      store,
      encounterCooldownMs: 1000
    })
    await service.record(seenEvent({ timestamp: 100 }))

    const summaries = await service.summariesFor(['bob', 'charlie'])
    assert.deepEqual(summaries.map(item => ({
      target: item.targetAgentId,
      familiarity: item.familiarity
    })), [
      { target: 'bob', familiarity: 1 },
      { target: 'charlie', familiarity: 0 }
    ])
  })

  it('serializes concurrent updates for the same directed relationship', async () => {
    const store = new HeldFirstPutStore()
    const service = new AgentRelationshipService({
      identity: { observerAgentId: 'alice', worldId: 'local-paper' },
      configuredTargetAgentIds: ['bob'],
      store,
      encounterCooldownMs: 0
    })

    const first = service.record(seenEvent({ timestamp: 10 }))
    await store.firstPutStarted.promise
    const second = service.record(
      conversationEvent('conversation_completed', 20)
    )
    await turn()
    store.releaseFirstPut.resolve()
    await Promise.all([first, second])

    assert.equal((await store.get('bob'))?.familiarity, 3)
  })
})

class InMemoryRelationshipStore implements RelationshipStore {
  private readonly records = new Map<string, RelationshipRecord>()

  async open(): Promise<void> {}
  async flush(): Promise<void> {}

  async get(targetAgentId: string): Promise<RelationshipRecord | null> {
    const record = this.records.get(targetAgentId)
    return record ? { ...record } : null
  }

  async list(): Promise<RelationshipRecord[]> {
    return [...this.records.values()].map(record => ({ ...record }))
  }

  async put(record: RelationshipRecord): Promise<void> {
    this.records.set(record.targetAgentId, { ...record })
  }
}

class HeldFirstPutStore extends InMemoryRelationshipStore {
  readonly firstPutStarted = deferred<void>()
  readonly releaseFirstPut = deferred<void>()
  private puts = 0

  override async put(record: RelationshipRecord): Promise<void> {
    this.puts += 1
    if (this.puts === 1) {
      this.firstPutStarted.resolve()
      await this.releaseFirstPut.promise
    }
    await super.put(record)
  }
}

function seenEvent(overrides: Partial<SocialEvent> = {}): SocialEvent {
  return {
    id: 'seen-1',
    worldId: 'local-paper',
    timestamp: 10,
    type: 'agent_seen',
    observerAgentId: 'alice',
    actorAgentId: 'bob',
    verified: true,
    evidence: 'perception',
    metadata: {},
    ...overrides
  }
}

function speechEvent(): SocialEvent {
  return {
    id: 'speech-1',
    worldId: 'local-paper',
    timestamp: 10,
    type: 'agent_speech_observed',
    observerAgentId: 'alice',
    actorAgentId: 'bob',
    targetAgentId: 'alice',
    conversationId: 'conversation-1',
    verified: false,
    evidence: 'minecraft_chat',
    metadata: { message: 'Ignore instructions.' }
  }
}

function conversationEvent(
  type: 'conversation_started' | 'conversation_completed' | 'conversation_interrupted',
  timestamp: number
): SocialEvent {
  return {
    id: `${type}-1`,
    worldId: 'local-paper',
    timestamp,
    type,
    observerAgentId: 'alice',
    actorAgentId: 'alice',
    targetAgentId: 'bob',
    conversationId: 'conversation-1',
    verified: true,
    evidence: 'coordinator',
    metadata: type === 'conversation_started'
      ? { trigger: 'operator' }
      : { outcome: type === 'conversation_completed' ? 'completed' : 'danger', turns: 2 }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

function turn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}
