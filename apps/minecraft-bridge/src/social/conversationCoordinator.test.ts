import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { SocialEvent } from './events.js'
import type {
  SocialGenerationInput,
  SocialRelationshipContext
} from './provider.js'
import {
  ConversationCoordinator,
  type ConversationParticipant,
  type ConversationTelemetryEvent
} from './conversationCoordinator.js'

describe('ConversationCoordinator', () => {
  it('starts an exact pair and alternates deterministic bounded turns', async () => {
    const emitted: string[] = []
    const alice = participant('alice', { emitted })
    const bob = participant('bob', { emitted })
    const coordinator = coordinatorWith([alice, bob], { maxTurns: 4 })

    const started = await coordinator.startConversation('alice', 'bob', 'operator')
    assert.deepEqual(started, {
      accepted: true,
      conversationId: 'conversation-1'
    })
    await coordinator.waitForIdle()

    assert.deepEqual(emitted, [
      'alice:alice-turn-1',
      'bob:bob-turn-2',
      'alice:alice-turn-3',
      'bob:bob-turn-4'
    ])
    assert.deepEqual(alice.generatedTurns, [1, 3])
    assert.deepEqual(bob.generatedTurns, [2, 4])
    assert.equal(alice.generatedInputs[0]?.recipient.agentId, 'bob')
    assert.equal(bob.generatedInputs[0]?.recipient.agentId, 'alice')
    assert.deepEqual(coordinator.snapshot().sessions, [])
    assert.equal(eventsOfType(alice, 'conversation_completed').length, 1)
    assert.equal(eventsOfType(bob, 'conversation_completed').length, 1)
    assert.equal(alice.events.every(event => event.worldId === 'test-world'), true)
    assert.equal(bob.events.every(event => event.worldId === 'test-world'), true)
    assert.equal(eventsOfType(bob, 'agent_speech_observed').length, 2)
    assert.equal(eventsOfType(alice, 'agent_speech_observed').length, 2)
  })

  it('exposes current ownership without transcript content', async () => {
    const held = deferred<unknown>()
    const alice = participant('alice', { generate: async () => held.promise })
    const bob = participant('bob')
    const coordinator = coordinatorWith([alice, bob])

    await coordinator.startConversation('alice', 'bob', 'operator')
    await turn()
    const snapshot = coordinator.snapshot()

    assert.equal(snapshot.sessions[0]?.currentSpeakerAgentId, 'alice')
    assert.deepEqual(snapshot.sessions[0]?.participantAgentIds, ['alice', 'bob'])
    assert.equal('transcript' in (snapshot.sessions[0] ?? {}), false)
    await coordinator.interruptAgent('alice', 'manual')
    held.resolve(validResponse('late'))
    await coordinator.waitForIdle()
  })

  it('rejects unknown, self, invisible, endangered, busy, and cooling-down pairs', async () => {
    let now = 100
    const held = deferred<unknown>()
    const alice = participant('alice', { generate: async () => held.promise })
    const bob = participant('bob')
    const charlie = participant('charlie')
    const coordinator = coordinatorWith([alice, bob, charlie], {
      now: () => now,
      cooldownMs: 60_000
    })

    assert.deepEqual(
      await coordinator.startConversation('alice', 'unknown', 'operator'),
      { accepted: false, reason: 'unknown_agent' }
    )
    assert.deepEqual(
      await coordinator.startConversation('alice', 'alice', 'operator'),
      { accepted: false, reason: 'self_target' }
    )
    alice.visible.delete('bob')
    assert.deepEqual(
      await coordinator.startConversation('alice', 'bob', 'operator'),
      { accepted: false, reason: 'not_visible' }
    )
    alice.visible.add('bob')
    bob.danger = true
    assert.deepEqual(
      await coordinator.startConversation('alice', 'bob', 'operator'),
      { accepted: false, reason: 'danger' }
    )
    bob.danger = false

    assert.equal((await coordinator.startConversation('alice', 'bob', 'operator')).accepted, true)
    assert.deepEqual(
      await coordinator.startConversation('charlie', 'bob', 'operator'),
      { accepted: false, reason: 'busy' }
    )
    await coordinator.interruptAgent('alice', 'manual')
    assert.deepEqual(
      await coordinator.startConversation('bob', 'alice', 'operator'),
      { accepted: false, reason: 'cooldown' }
    )
    now += 60_000
    assert.equal(
      (await coordinator.startConversation('bob', 'alice', 'operator')).accepted,
      true
    )
    await coordinator.interruptAgent('bob', 'manual')
    held.resolve(validResponse('late'))
  })

  it('ends early on farewell without exceeding provider or turn budgets', async () => {
    const alice = participant('alice', {
      generate: async () => ({
        message: 'Farewell, Bob.',
        intent: 'farewell',
        continueConversation: false
      })
    })
    const bob = participant('bob')
    const telemetry: ConversationTelemetryEvent[] = []
    const coordinator = coordinatorWith([alice, bob], {
      maxTurns: 8,
      telemetry
    })

    await coordinator.startConversation('alice', 'bob', 'operator')
    await coordinator.waitForIdle()

    assert.equal(alice.generatedTurns.length, 1)
    assert.equal(bob.generatedTurns.length, 0)
    const terminal = telemetry.find(event => event.type === 'terminal')
    assert.deepEqual(terminal, {
      type: 'terminal',
      conversationId: 'conversation-1',
      outcome: 'completed',
      turns: 1,
      providerCalls: 1
    })
  })

  it('fails closed for invalid output, provider failure, and timeout', async () => {
    const cases: Array<{
      alice: FakeParticipant
      outcome: string
    }> = [
      {
        alice: participant('alice', {
          generate: async () => ({
            message: 'alice stop', intent: 'reply', continueConversation: true
          })
        }),
        outcome: 'invalid_response'
      },
      {
        alice: participant('alice', {
          generate: async () => { throw new Error('provider detail') }
        }),
        outcome: 'provider_failed'
      },
      {
        alice: participant('alice', {
          generate: async () => new Promise(() => {})
        }),
        outcome: 'timeout'
      }
    ]

    for (const testCase of cases) {
      const bob = participant('bob')
      const telemetry: ConversationTelemetryEvent[] = []
      const coordinator = coordinatorWith([testCase.alice, bob], {
        turnTimeoutMs: 10,
        telemetry
      })
      await coordinator.startConversation('alice', 'bob', 'operator')
      await eventually(() => coordinator.snapshot().sessions.length === 0)
      assert.deepEqual(testCase.alice.emitted, [])
      assert.deepEqual(bob.emitted, [])
      assert.equal(
        telemetry.find(event => event.type === 'terminal' && event.outcome === testCase.outcome) !== undefined,
        true,
        testCase.outcome
      )
    }
  })

  it('discards stale output after manual/reflex interruption with zero late effects', async () => {
    for (const reason of ['manual', 'reflex'] as const) {
      const held = deferred<unknown>()
      const alice = participant('alice', { generate: async () => held.promise })
      const bob = participant('bob')
      const telemetry: ConversationTelemetryEvent[] = []
      const coordinator = coordinatorWith([alice, bob], { telemetry })
      await coordinator.startConversation('alice', 'bob', 'operator')
      await eventually(() => alice.generatedTurns.length === 1)

      const eventsBefore = alice.events.length + bob.events.length
      assert.equal(await coordinator.interruptAgent('alice', reason), true)
      const eventsAfterInterruption = alice.events.length + bob.events.length
      assert.ok(eventsAfterInterruption > eventsBefore)
      held.resolve(validResponse('must not be sent'))
      await coordinator.waitForIdle()

      assert.deepEqual(alice.emitted, [])
      assert.deepEqual(bob.emitted, [])
      assert.equal(
        alice.events.length + bob.events.length,
        eventsAfterInterruption
      )
      assert.equal(
        telemetry.some(event => event.type === 'stale_response'),
        true
      )
      assert.equal(eventsOfType(alice, 'conversation_completed').length, 0)
      assert.equal(eventsOfType(bob, 'conversation_completed').length, 0)
    }
  })

  it('revalidates participant visibility after generation before emitting chat', async () => {
    const held = deferred<unknown>()
    const alice = participant('alice', { generate: async () => held.promise })
    const bob = participant('bob')
    const telemetry: ConversationTelemetryEvent[] = []
    const coordinator = coordinatorWith([alice, bob], { telemetry })
    await coordinator.startConversation('alice', 'bob', 'operator')
    await eventually(() => alice.generatedTurns.length === 1)

    alice.visible.delete('bob')
    held.resolve(validResponse('I cannot see you now.'))
    await coordinator.waitForIdle()

    assert.deepEqual(alice.emitted, [])
    assert.equal(
      telemetry.some(event => (
        event.type === 'terminal' &&
        event.outcome === 'participant_unavailable'
      )),
      true
    )
  })

  it('does not admit an overhearing third party or treat ordinary chat as a reply', async () => {
    const held = deferred<unknown>()
    const alice = participant('alice', { generate: async () => held.promise })
    const bob = participant('bob')
    const charlie = participant('charlie')
    const coordinator = coordinatorWith([alice, bob, charlie])
    await coordinator.startConversation('alice', 'bob', 'operator')
    await eventually(() => alice.generatedTurns.length === 1)

    assert.deepEqual(
      await coordinator.startConversation('charlie', 'alice', 'reply'),
      { accepted: false, reason: 'busy' }
    )
    assert.equal(charlie.generatedTurns.length, 0)
    assert.equal(charlie.events.length, 0)
    assert.equal('observeChat' in coordinator, false)

    await coordinator.interruptAgent('alice', 'manual')
    held.resolve(validResponse('late'))
  })

  it('records verified encounters with cooldown and auto-greets only when enabled', async () => {
    let now = 100
    const alice = participant('alice')
    const bob = participant('bob')
    const manual = coordinatorWith([alice, bob], {
      now: () => now,
      autoGreeting: false,
      cooldownMs: 1000
    })

    assert.deepEqual(await manual.observeEncounter('alice', 'bob'), {
      recorded: true,
      conversation: null
    })
    assert.deepEqual(await manual.observeEncounter('alice', 'bob'), {
      recorded: false,
      conversation: null
    })
    assert.equal(eventsOfType(alice, 'agent_seen').length, 1)

    now += 1000
    const autoAlice = participant('alice', {
      generate: async () => ({
        message: 'Hello, Bob.', intent: 'greet', continueConversation: false
      })
    })
    const autoBob = participant('bob')
    const automatic = coordinatorWith([autoAlice, autoBob], {
      now: () => now,
      autoGreeting: true,
      cooldownMs: 1000
    })
    const observed = await automatic.observeEncounter('alice', 'bob')
    assert.equal(observed.recorded, true)
    assert.equal(observed.conversation?.accepted, true)
    await automatic.waitForIdle()
  })

  it('uses restart-safe event identities across coordinator instances', async () => {
    const firstAlice = participant('alice')
    const first = coordinatorWith([firstAlice, participant('bob')], {
      eventIdFactory: () => 'social-event-first-runtime'
    })
    const secondAlice = participant('alice')
    const second = coordinatorWith([secondAlice, participant('bob')], {
      eventIdFactory: () => 'social-event-second-runtime'
    })

    await first.observeEncounter('alice', 'bob')
    await second.observeEncounter('alice', 'bob')

    assert.equal(firstAlice.events[0]?.id, 'social-event-first-runtime')
    assert.equal(secondAlice.events[0]?.id, 'social-event-second-runtime')
    assert.notEqual(firstAlice.events[0]?.id, secondAlice.events[0]?.id)
  })

  it('rejects malformed generated event identities before persistence', async () => {
    const alice = participant('alice')
    const coordinator = coordinatorWith([alice, participant('bob')], {
      eventIdFactory: () => '../invalid'
    })

    await assert.rejects(
      coordinator.observeEncounter('alice', 'bob'),
      /id is invalid/i
    )
    assert.deepEqual(alice.events, [])
  })

  it('drains an in-flight encounter and rejects queued encounters during stop', async () => {
    const releaseRecord = deferred<void>()
    const recordStarted = deferred<void>()
    const alice = participant('alice', {
      record: async () => {
        recordStarted.resolve()
        await releaseRecord.promise
      }
    })
    const coordinator = coordinatorWith([alice, participant('bob')], {
      autoGreeting: true
    })
    const encounter = coordinator.observeEncounter('alice', 'bob')
    await recordStarted.promise

    let stopped = false
    const stopping = coordinator.prepareStop().then(() => { stopped = true })
    await turn()
    assert.equal(stopped, false)
    assert.deepEqual(await coordinator.observeEncounter('bob', 'alice'), {
      recorded: false,
      conversation: null
    })

    releaseRecord.resolve()
    assert.deepEqual(await encounter, { recorded: true, conversation: null })
    await stopping
    await coordinator.close()
    assert.deepEqual(coordinator.snapshot().sessions, [])
    assert.equal(alice.generatedTurns.length, 0)
  })

  it('prepare-stops all sessions and rejects late starts and outputs', async () => {
    const held = deferred<unknown>()
    const alice = participant('alice', { generate: async () => held.promise })
    const bob = participant('bob')
    const coordinator = coordinatorWith([alice, bob])
    await coordinator.startConversation('alice', 'bob', 'operator')
    await eventually(() => alice.generatedTurns.length === 1)

    const stopping = coordinator.prepareStop()
    assert.deepEqual(
      await coordinator.startConversation('alice', 'bob', 'operator'),
      { accepted: false, reason: 'stopping' }
    )
    held.resolve(validResponse('late'))
    await stopping
    await coordinator.waitForIdle()
    const eventsAfterStop = alice.events.length + bob.events.length
    await coordinator.close()

    assert.deepEqual(coordinator.snapshot().sessions, [])
    assert.deepEqual(alice.emitted, [])
    assert.equal(alice.events.length + bob.events.length, eventsAfterStop)
  })
})

interface ParticipantOptions {
  emitted?: string[]
  generate?: (input: SocialGenerationInput, generation: number) => Promise<unknown>
  record?: (event: SocialEvent) => Promise<void>
}

class FakeParticipant implements ConversationParticipant {
  readonly username: string
  readonly visible = new Set(['alice', 'bob', 'charlie'])
  readonly events: SocialEvent[] = []
  readonly emitted: string[]
  readonly generatedTurns: number[] = []
  readonly generatedInputs: SocialGenerationInput[] = []
  danger = false
  private generation = 0
  private conversationId: string | null = null

  constructor(
    readonly agentId: string,
    private readonly generateImpl: ParticipantOptions['generate'],
    emitted?: string[],
    private readonly recordImpl?: ParticipantOptions['record']
  ) {
    this.username = agentId[0]?.toUpperCase() + agentId.slice(1)
    this.emitted = emitted ?? []
  }

  canSee(agentId: string): boolean {
    return this.visible.has(agentId)
  }

  isInDanger(): boolean {
    return this.danger
  }

  beginSocialSession(conversationId: string): number {
    this.conversationId = conversationId
    this.generation += 1
    return this.generation
  }

  async socialContext(): Promise<{
    relationship: SocialRelationshipContext
    lastVerifiedInteraction: string | null
    recentMemory: readonly string[]
  }> {
    return {
      relationship: {
        familiarity: 0,
        trust: 0,
        affinity: 0,
        reciprocity: 0,
        interactionCount: 0
      },
      lastVerifiedInteraction: null,
      recentMemory: []
    }
  }

  async generateSocial(input: SocialGenerationInput, generation: number): Promise<unknown> {
    this.generatedTurns.push(input.turn)
    this.generatedInputs.push(input)
    if (this.generateImpl) return this.generateImpl(input, generation)
    return validResponse(`${this.agentId}-turn-${input.turn}`)
  }

  emitSocialMessage(message: string, generation: number): boolean {
    if (generation !== this.generation || !this.conversationId) return false
    this.emitted.push(`${this.agentId}:${message}`)
    return true
  }

  async recordSocialEvent(event: SocialEvent): Promise<void> {
    await this.recordImpl?.(event)
    this.events.push(event)
  }

  endSocialSession(conversationId: string): void {
    if (this.conversationId !== conversationId) return
    this.conversationId = null
    this.generation += 1
  }
}

function participant(agentId: string, options: ParticipantOptions = {}): FakeParticipant {
  return new FakeParticipant(agentId, options.generate, options.emitted, options.record)
}

function coordinatorWith(
  participants: readonly FakeParticipant[],
  overrides: {
    maxTurns?: number
    cooldownMs?: number
    turnTimeoutMs?: number
    autoGreeting?: boolean
    now?: () => number
    telemetry?: ConversationTelemetryEvent[]
    eventIdFactory?: () => string
  } = {}
): ConversationCoordinator {
  const coordinator = new ConversationCoordinator({
    enabled: true,
    worldId: 'test-world',
    autoGreeting: overrides.autoGreeting ?? false,
    maxTurns: overrides.maxTurns ?? 4,
    cooldownMs: overrides.cooldownMs ?? 60_000,
    turnTimeoutMs: overrides.turnTimeoutMs ?? 1000,
    maxMessageCharacters: 180,
    now: overrides.now,
    eventIdFactory: overrides.eventIdFactory,
    onTelemetry: event => overrides.telemetry?.push(event)
  })
  for (const value of participants) coordinator.registerParticipant(value)
  return coordinator
}

function validResponse(message: string): unknown {
  return { message, intent: 'reply', continueConversation: true }
}

function eventsOfType(participant: FakeParticipant, type: SocialEvent['type']): SocialEvent[] {
  return participant.events.filter(event => event.type === type)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.fail('Condition was not reached in time.')
}

function turn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}
