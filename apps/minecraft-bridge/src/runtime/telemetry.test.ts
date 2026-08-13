import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createBootstrapBrainInput } from '../brain/benchmark/bootstrap.js'
import type { LLMProvider } from '../brain/provider.js'
import type { SocialProvider } from '../social/provider.js'
import { ProviderConcurrencyLimiter } from './providerLimiter.js'
import {
  AgentRuntimeTelemetry,
  createEmptySocialTelemetry,
  instrumentAgentProvider,
  instrumentSocialProvider,
  summarizeAgentTelemetry
} from './telemetry.js'

describe('AgentRuntimeTelemetry', () => {
  it('records privacy-safe social counters without transcript content', () => {
    const telemetry = new AgentRuntimeTelemetry({
      agentId: 'alice', username: 'Alice'
    })
    telemetry.recordSocialProviderCall({
      succeeded: true,
      providerLatencyMs: 18,
      queueWaitMs: 2,
      timing: { promptTokens: 20, outputTokens: 4 }
    })
    telemetry.recordConversationTelemetry({
      type: 'started',
      conversationId: 'conversation-1',
      initiatorAgentId: 'alice',
      targetAgentId: 'bob',
      trigger: 'operator'
    })
    telemetry.recordConversationTelemetry({
      type: 'turn_completed',
      conversationId: 'conversation-1',
      speakerAgentId: 'alice',
      turn: 1,
      providerCalls: 1
    })
    telemetry.recordConversationTelemetry({
      type: 'terminal',
      conversationId: 'conversation-1',
      outcome: 'completed',
      turns: 1,
      providerCalls: 1
    })
    telemetry.recordSocialEvent('conversation_completed', true, 1)

    const encoded = JSON.stringify(telemetry.snapshot())
    assert.equal(encoded.includes('message'), false)
    assert.deepEqual(telemetry.snapshot().social, {
      providerCalls: 1,
      providerFailures: 0,
      inputTokens: 20,
      outputTokens: 4,
      providerLatenciesMs: [18],
      providerQueueWaitMs: [2],
      conversationsStarted: 1,
      conversationsCompleted: 1,
      conversationsTimedOut: 0,
      conversationsInterrupted: 0,
      turnsCompleted: 1,
      invalidOutputs: 0,
      budgetExhaustions: 0,
      loopRejections: 0,
      staleResponses: 0,
      terminalConversationTurns: [1],
      relationshipUpdates: {
        agentSeen: 0,
        conversationCompleted: 1
      },
      episodesCreated: 1
    })
  })

  it('instruments social generation through the shared limiter', async () => {
    const limiter = new ProviderConcurrencyLimiter(1)
    const telemetry = new AgentRuntimeTelemetry({
      agentId: 'alice', username: 'Alice'
    })
    const social: SocialProvider = {
      generate: async () => ({
        message: 'Hello.', intent: 'greet', continueConversation: false
      }),
      getLastTiming: () => ({ promptTokens: 12, outputTokens: 3 })
    }
    const provider = instrumentSocialProvider(
      social,
      limiter,
      telemetry,
      new AbortController().signal
    )

    await provider.generate({} as never)

    assert.equal(telemetry.snapshot().social.providerCalls, 1)
    assert.equal(telemetry.snapshot().social.inputTokens, 12)
  })

  it('records immutable provider metrics under one agent identity', () => {
    const telemetry = new AgentRuntimeTelemetry({
      agentId: 'alice',
      username: 'Alice'
    })
    telemetry.recordProviderCall({
      succeeded: true,
      providerLatencyMs: 30,
      queueWaitMs: 5,
      timing: { promptTokens: 100, outputTokens: 20 }
    })
    telemetry.recordProviderCall({
      succeeded: false,
      providerLatencyMs: 10,
      queueWaitMs: 0,
      timing: null
    })

    const first = telemetry.snapshot()
    first.providerLatenciesMs.push(999)
    const second = telemetry.snapshot()

    assert.deepEqual(second, {
      agentId: 'alice',
      username: 'Alice',
      providerCalls: 2,
      providerFailures: 1,
      inputTokens: 100,
      outputTokens: 20,
      providerLatenciesMs: [30, 10],
      providerQueueWaitMs: [5, 0],
      spawned: 0,
      disconnects: 0,
      errors: 0,
      kicked: 0,
      memory: null,
      social: createEmptySocialTelemetry()
    })
  })

  it('keeps agent inputs and provider timing isolated behind one limiter', async () => {
    const limiter = new ProviderConcurrencyLimiter(1)
    const aliceTelemetry = new AgentRuntimeTelemetry({
      agentId: 'alice', username: 'Alice'
    })
    const bobTelemetry = new AgentRuntimeTelemetry({
      agentId: 'bob', username: 'Bob'
    })
    const received: unknown[] = []
    const providers = [provider('alice'), provider('bob')]
    const alice = instrumentAgentProvider(
      providers[0] as LLMProvider,
      limiter,
      aliceTelemetry,
      new AbortController().signal
    )
    const bob = instrumentAgentProvider(
      providers[1] as LLMProvider,
      limiter,
      bobTelemetry,
      new AbortController().signal
    )
    const aliceInput = createBootstrapBrainInput()
    const bobInput = {
      ...createBootstrapBrainInput(),
      state: { ...createBootstrapBrainInput().state, agentName: 'Bob' }
    }
    providers.forEach(item => item.received = received)

    assert.equal(await alice.decide(aliceInput), 'alice')
    assert.equal(await bob.decide(bobInput), 'bob')
    assert.equal(received[0], aliceInput)
    assert.equal(received[1], bobInput)
    assert.equal(aliceTelemetry.snapshot().inputTokens, 10)
    assert.equal(bobTelemetry.snapshot().inputTokens, 10)
  })

  it('propagates call cancellation and releases a permit when a provider ignores abort', async () => {
    const limiter = new ProviderConcurrencyLimiter(1)
    const telemetry = new AgentRuntimeTelemetry({ agentId: 'alice', username: 'Alice' })
    const held = deferred<unknown>()
    const receivedSignals: AbortSignal[] = []
    let calls = 0
    const underlying: LLMProvider = {
      async decide(_input, signal) {
        calls += 1
        if (signal) receivedSignals.push(signal)
        return calls === 1 ? held.promise : { action: 'idle', reason: 'Wait.' }
      }
    }
    const provider = instrumentAgentProvider(
      underlying,
      limiter,
      telemetry,
      new AbortController().signal
    )
    const controller = new AbortController()
    const first = provider.decide(createBootstrapBrainInput(), controller.signal)
    void first.catch(() => {})
    await turn()

    controller.abort()
    const second = provider.decide(createBootstrapBrainInput())
    try {
      await eventually(() => calls === 2)
      assert.equal(receivedSignals[0]?.aborted, true)
      await assert.rejects(first, error => (error as Error).name === 'AbortError')
      assert.deepEqual(await second, { action: 'idle', reason: 'Wait.' })
    } finally {
      held.resolve({ action: 'idle', reason: 'late' })
    }
  })

  it('aggregates only numeric per-agent measurements', () => {
    const alice = new AgentRuntimeTelemetry({ agentId: 'alice', username: 'Alice' })
    const bob = new AgentRuntimeTelemetry({ agentId: 'bob', username: 'Bob' })
    alice.recordProviderCall({
      succeeded: true,
      providerLatencyMs: 20,
      queueWaitMs: 0,
      timing: { promptTokens: 8, outputTokens: 2 }
    })
    bob.recordProviderCall({
      succeeded: false,
      providerLatencyMs: 40,
      queueWaitMs: 10,
      timing: null
    })

    assert.deepEqual(summarizeAgentTelemetry([alice.snapshot(), bob.snapshot()]), {
      agents: 2,
      providerCalls: 2,
      providerFailures: 1,
      inputTokens: 8,
      outputTokens: 2,
      meanProviderLatencyMs: 30,
      medianProviderLatencyMs: 30,
      meanProviderQueueWaitMs: 5
    })
  })
})

function provider(label: string): LLMProvider & { received?: unknown[] } {
  const value: LLMProvider & { received?: unknown[] } = {
    async decide(input) {
      value.received?.push(input)
      return label
    },
    getLastTiming: () => ({ promptTokens: 10, outputTokens: 2 })
  }
  return value
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

function turn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.fail('Condition was not reached in time.')
}
