import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LLMProvider } from '../provider.js'
import type { BrainInput } from '../types.js'
import {
  AUTONOMOUS_BOOTSTRAP_SCENARIOS,
  BRAIN_BENCHMARK_SCENARIOS
} from './scenarios.js'
import {
  runBrainBenchmark,
  summarizeBrainBenchmark,
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
    edibleItemCount: 0,
    craftableItems: [],
    nearbyCraftingTable: false,
    equippedItem: null,
    placeableBlocks: []
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
  recentDecisions: [],
  shortTermGoal: null,
  goalProgress: null,
  availableCapabilities: {
    observedCollectableBlocks: [],
    craftableItems: [],
    placeableBlocks: [],
    canExplore: true
  }
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
        error: 'duplicate_say'
      }
    ])
    assert.equal(results[0]?.provider, 'scripted')
    assert.equal(results[0]?.model, 'test-model')
    assert.equal(observedInputs[0]?.recentDecisions.length, 0)
    assert.equal(observedInputs[1]?.recentDecisions.length, 1)
    assert.equal(observedInputs[1]?.recentDecisions[0]?.decision.action, 'say')
  })

  it('distinguishes schema failures and unsafe grounded targets', async () => {
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
      scenario('visible_target', playerInput),
      scenario('uncraftable_item', baseInput),
      scenario('unavailable_block', baseInput)
    ]
    const provider = scriptedProvider([
      { action: 'teleport', reason: 'Move quickly.' },
      { action: 'come_to_player', username: 'Alice', reason: 'Meet Alice.' },
      { action: 'follow_player', username: 'Alex', reason: 'Follow Alex.' },
      { action: 'follow_player', username: 'Steve', reason: 'Follow Steve.' },
      { action: 'craft_item', item: 'diamond_pickaxe', amount: 1, reason: 'Upgrade.' },
      { action: 'place_block', block: 'tnt', reason: 'Place it.' }
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
      { scenario: 'self_target', valid: true, schemaFailure: false, unsafeTarget: true },
      { scenario: 'hallucinated_target', valid: true, schemaFailure: false, unsafeTarget: true },
      { scenario: 'visible_target', valid: true, schemaFailure: false, unsafeTarget: false },
      { scenario: 'uncraftable_item', valid: true, schemaFailure: false, unsafeTarget: true },
      { scenario: 'unavailable_block', valid: true, schemaFailure: false, unsafeTarget: true }
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

  it('simulates grounded bootstrap progress and goal completion sequentially', async () => {
    const bootstrap = AUTONOMOUS_BOOTSTRAP_SCENARIOS[0]
    assert.ok(bootstrap)
    const observedInputs: BrainInput[] = []
    const outputs = [
      { action: 'craft_item', item: 'oak_planks', amount: 12, reason: 'Create materials.' },
      { action: 'craft_item', item: 'stick', amount: 4, reason: 'Create components.' },
      { action: 'craft_item', item: 'crafting_table', amount: 1, reason: 'Create crafting access.' },
      { action: 'place_block', block: 'crafting_table', reason: 'Enable table recipes.' },
      { action: 'craft_item', item: 'wooden_pickaxe', amount: 1, reason: 'Create a basic tool.' }
    ]
    let call = 0
    const results = await runBrainBenchmark({
      provider: {
        async decide(input) {
          observedInputs.push(input)
          const output = outputs[call]
          call += 1
          return output
        },
        getLastTiming: () => ({
          promptTokens: 100,
          outputTokens: 10,
          loadDurationMs: 2,
          outputTokensPerSecond: 20
        })
      },
      providerName: 'scripted',
      model: 'bootstrap-model',
      scenarios: [{ ...bootstrap, samples: 5 }],
      now: steppingClock(5)
    })

    assert.deepEqual(results.map(result => ({
      action: result.action,
      grounded: result.grounded,
      policyAccepted: result.policyAccepted,
      progressProduced: result.progressProduced,
      goalCompleted: result.goalCompleted
    })), [
      { action: 'craft_item', grounded: true, policyAccepted: true, progressProduced: true, goalCompleted: false },
      { action: 'craft_item', grounded: true, policyAccepted: true, progressProduced: true, goalCompleted: false },
      { action: 'craft_item', grounded: true, policyAccepted: true, progressProduced: true, goalCompleted: false },
      { action: 'place_block', grounded: true, policyAccepted: true, progressProduced: true, goalCompleted: false },
      { action: 'craft_item', grounded: true, policyAccepted: true, progressProduced: true, goalCompleted: true }
    ])
    assert.deepEqual(observedInputs.map(input => ({
      inventory: input.perception.inventory,
      nearbyCraftingTable: input.perception.nearbyCraftingTable
    })), [
      { inventory: [{ name: 'oak_log', count: 3 }], nearbyCraftingTable: false },
      { inventory: [{ name: 'oak_planks', count: 12 }], nearbyCraftingTable: false },
      { inventory: [{ name: 'oak_planks', count: 10 }, { name: 'stick', count: 4 }], nearbyCraftingTable: false },
      { inventory: [{ name: 'crafting_table', count: 1 }, { name: 'oak_planks', count: 6 }, { name: 'stick', count: 4 }], nearbyCraftingTable: false },
      { inventory: [{ name: 'oak_planks', count: 6 }, { name: 'stick', count: 4 }], nearbyCraftingTable: true }
    ])

    assert.deepEqual(summarizeBrainBenchmark(results), {
      provider: 'scripted',
      model: 'bootstrap-model',
      samples: 5,
      validDecisions: 5,
      groundedDecisions: 5,
      policyAcceptedDecisions: 5,
      actionDiversity: 2,
      progressProducingDecisions: 5,
      noProgressDecisions: 0,
      idleDecisions: 0,
      idleRate: 0,
      repeatedNoProgressDecisions: 0,
      completedGoals: 1,
      goalScenarios: 1,
      goalCompletionRate: 1,
      meanLatencyMs: 5,
      medianLatencyMs: 5,
      promptTokens: 500,
      outputTokens: 50,
      meanLoadDurationMs: 2,
      meanOutputTokensPerSecond: 20
    })
  })

  it('records repeated no-progress decisions and applies repetition policy', async () => {
    const bootstrap = AUTONOMOUS_BOOTSTRAP_SCENARIOS[0]
    assert.ok(bootstrap)
    const results = await runBrainBenchmark({
      provider: scriptedProvider([
        { action: 'idle', reason: 'Wait once.' },
        { action: 'idle', reason: 'Wait twice.' },
        { action: 'idle', reason: 'Wait again.' }
      ]),
      providerName: 'scripted',
      model: 'idle-model',
      scenarios: [{ ...bootstrap, samples: 3 }],
      now: () => 0
    })

    assert.deepEqual(results.map(result => ({
      policyAccepted: result.policyAccepted,
      noProgress: result.noProgress,
      repeatedNoProgress: result.repeatedNoProgress
    })), [
      { policyAccepted: true, noProgress: true, repeatedNoProgress: false },
      { policyAccepted: true, noProgress: true, repeatedNoProgress: true },
      { policyAccepted: false, noProgress: true, repeatedNoProgress: true }
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
      'craftable_planks',
      'craftable_table',
      'table_recipe_available',
      'safe_exploration',
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
    assert.deepEqual(
      BRAIN_BENCHMARK_SCENARIOS.find(item => item.id === 'craftable_planks')
        ?.input.perception.craftableItems,
      [{ item: 'oak_planks', maxCraftable: 4, requiresTable: false }]
    )
    assert.equal(
      BRAIN_BENCHMARK_SCENARIOS.find(item => item.id === 'table_recipe_available')
        ?.input.perception.nearbyCraftingTable,
      true
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

function steppingClock(step: number): () => number {
  let time = 0
  return () => {
    time += step
    return time
  }
}
