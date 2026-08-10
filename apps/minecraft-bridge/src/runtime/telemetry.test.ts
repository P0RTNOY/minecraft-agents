import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createBootstrapBrainInput } from '../brain/benchmark/bootstrap.js'
import type { LLMProvider } from '../brain/provider.js'
import { ProviderConcurrencyLimiter } from './providerLimiter.js'
import {
  AgentRuntimeTelemetry,
  instrumentAgentProvider,
  summarizeAgentTelemetry
} from './telemetry.js'

describe('AgentRuntimeTelemetry', () => {
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
      memory: null
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
