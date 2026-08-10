import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LLMProvider } from '../provider.js'
import type { BrainInput } from '../types.js'
import { BRAIN_BENCHMARK_SCENARIOS } from './scenarios.js'
import {
  runBrainBenchmark,
  type BrainBenchmarkScenario
} from './run.js'

const baseInput: BrainInput = {
  perception: {
    agent: 'Alice',
    timestamp: 123,
    position: { x: 1, y: 64, z: 2 },
    health: 20,
    food: 18,
    nearbyBlocks: [],
    nearbyEntities: [],
    inventory: [],
    edibleItemCount: 0
  },
  state: {
    agentName: 'Alice',
    status: 'idle',
    currentAction: null,
    currentGoal: null,
    actionSource: null,
    busy: false
  },
  previousActionResult: null,
  recentDecisions: []
}

describe('runBrainBenchmark', () => {
  it('records latency, decisions, and repetition across scenario samples', async () => {
    const scenario: BrainBenchmarkScenario = {
      id: 'repeated_say',
      description: 'The provider repeats the same chat decision.',
      input: baseInput,
      samples: 2
    }
    const observedInputs: BrainInput[] = []
    const provider = scriptedProvider([
      { action: 'say', message: 'Hello!', reason: 'Greet nearby players.' },
      { action: 'say', message: 'Hello!', reason: 'Greet nearby players.' }
    ], observedInputs)
    let time = 0

    const results = await runBrainBenchmark({
      provider,
      providerName: 'scripted',
      model: 'test-model',
      scenarios: [scenario],
      now: () => {
        time += 5
        return time
      }
    })

    assert.equal(results.length, 2)
    assert.deepEqual(results.map(result => ({
      latencyMs: result.latencyMs,
      valid: result.valid,
      action: result.action,
      reason: result.reason,
      repeated: result.repeated,
      schemaFailure: result.schemaFailure,
      unsafeTarget: result.unsafeTarget,
      error: result.error
    })), [
      {
        latencyMs: 5,
        valid: true,
        action: 'say',
        reason: 'Greet nearby players.',
        repeated: false,
        schemaFailure: false,
        unsafeTarget: false,
        error: null
      },
      {
        latencyMs: 5,
        valid: true,
        action: 'say',
        reason: 'Greet nearby players.',
        repeated: true,
        schemaFailure: false,
        unsafeTarget: false,
        error: null
      }
    ])
    assert.equal(results[0]?.provider, 'scripted')
    assert.equal(results[0]?.model, 'test-model')
    assert.equal(observedInputs[0]?.recentDecisions.length, 0)
    assert.equal(observedInputs[1]?.recentDecisions.length, 1)
    assert.equal(observedInputs[1]?.recentDecisions[0]?.decision.action, 'say')
  })

  it('distinguishes schema failures and unsafe player targets', async () => {
    const playerInput: BrainInput = {
      ...baseInput,
      perception: {
        ...baseInput.perception,
        nearbyEntities: [{
          id: 7,
          name: 'Steve',
          type: 'player',
          category: 'UNKNOWN',
          distance: 4,
          position: { x: 4, y: 64, z: 2 }
        }]
      }
    }
    const scenarios: BrainBenchmarkScenario[] = [
      scenario('invalid', baseInput),
      scenario('self_target', baseInput),
      scenario('hallucinated_target', playerInput),
      scenario('visible_target', playerInput)
    ]
    const provider = scriptedProvider([
      { action: 'teleport', reason: 'Move quickly.' },
      { action: 'come_to_player', username: 'Alice', reason: 'Meet Alice.' },
      { action: 'follow_player', username: 'Alex', reason: 'Follow Alex.' },
      { action: 'follow_player', username: 'Steve', reason: 'Follow Steve.' }
    ])

    const results = await runBrainBenchmark({
      provider,
      providerName: 'scripted',
      model: 'test-model',
      scenarios,
      now: () => 0
    })

    assert.deepEqual(results.map(result => ({
      scenario: result.scenario,
      valid: result.valid,
      schemaFailure: result.schemaFailure,
      unsafeTarget: result.unsafeTarget
    })), [
      { scenario: 'invalid', valid: false, schemaFailure: true, unsafeTarget: false },
      { scenario: 'self_target', valid: false, schemaFailure: false, unsafeTarget: true },
      { scenario: 'hallucinated_target', valid: false, schemaFailure: false, unsafeTarget: true },
      { scenario: 'visible_target', valid: true, schemaFailure: false, unsafeTarget: false }
    ])
  })

  it('records provider failures without crashing later scenarios', async () => {
    let callCount = 0
    const provider: LLMProvider = {
      async decide() {
        callCount += 1
        if (callCount === 1) throw new Error('network unavailable')
        return { action: 'scan', reason: 'Inspect surroundings.' }
      }
    }

    const results = await runBrainBenchmark({
      provider,
      providerName: 'scripted',
      model: 'test-model',
      scenarios: [
        scenario('provider_failure', baseInput),
        scenario('recovery', baseInput)
      ],
      now: () => 0
    })

    assert.deepEqual(results.map(result => ({
      scenario: result.scenario,
      valid: result.valid,
      schemaFailure: result.schemaFailure,
      error: result.error
    })), [
      {
        scenario: 'provider_failure',
        valid: false,
        schemaFailure: false,
        error: 'network unavailable'
      },
      {
        scenario: 'recovery',
        valid: true,
        schemaFailure: false,
        error: null
      }
    ])
  })
})

describe('BRAIN_BENCHMARK_SCENARIOS', () => {
  it('covers the representative Brain situations without Minecraft', () => {
    assert.deepEqual(BRAIN_BENCHMARK_SCENARIOS.map(item => item.id), [
      'healthy_safe_resources',
      'low_health',
      'nearby_hostile',
      'nearby_external_player',
      'no_nearby_player',
      'useful_blocks_nearby',
      'previous_say',
      'repeated_idle',
      'self_only_player_identity'
    ])
    assert.equal(
      BRAIN_BENCHMARK_SCENARIOS.find(item => item.id === 'low_health')
        ?.input.perception.health,
      7
    )
    assert.equal(
      BRAIN_BENCHMARK_SCENARIOS.find(item => item.id === 'repeated_idle')
        ?.samples,
      3
    )
  })
})

function scenario(id: string, input: BrainInput): BrainBenchmarkScenario {
  return { id, description: id, input }
}

function scriptedProvider(
  outputs: unknown[],
  observedInputs: BrainInput[] = []
): LLMProvider {
  let index = 0
  return {
    async decide(input) {
      observedInputs.push(input)
      const output = outputs[index]
      index += 1
      return output
    }
  }
}
