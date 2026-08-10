import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { BrainCycleResult } from '../../agent/loop.js'
import type { GoalProgress } from '../goals.js'
import type { LLMProvider } from '../provider.js'
import type { BrainInput } from '../types.js'
import {
  BootstrapRunTelemetry,
  instrumentProvider,
  summarizeBootstrapRuns
} from './telemetry.js'

describe('BootstrapRunTelemetry', () => {
  it('aggregates actual provider usage, latency, actions, progress, and failures', async () => {
    let timing = { promptTokens: 120, outputTokens: 20 }
    const provider: LLMProvider = {
      decide: async () => ({ action: 'idle', reason: 'wait' }),
      getLastTiming: () => timing
    }
    const telemetry = new BootstrapRunTelemetry({
      runId: 'run-1', provider: 'openai', model: 'gpt-5-mini', startedAt: 100
    })
    const wrapped = instrumentProvider(provider, telemetry, (() => {
      let now = 100
      return () => (now += 25)
    })())

    await wrapped.decide(providerInput())
    telemetry.recordMemoryMetrics({
      episodesCreated: 2,
      episodesRetrieved: 3,
      semanticFactsCreated: 1,
      semanticFactsRetrieved: 2,
      retrievalFailures: 0,
      persistenceFailures: 0,
      reflectionCalls: 1,
      reflectionFailures: 0,
      reflectionInputTokens: 90,
      reflectionOutputTokens: 12,
      estimatedMemoryPromptTokens: 44
    })
    telemetry.recordCycle(executed('craft_item', true, undefined, {
      requested: 4,
      recipeOutput: 4,
      executionCount: 1,
      retryCount: 1,
      retryResult: 'succeeded'
    }), progress(false), progress(true))
    timing = { promptTokens: 80, outputTokens: 10 }
    await wrapped.decide(providerInput())
    telemetry.recordCycle(executed('craft_item', false, 'inventory_changed', {
      requested: 1,
      recipeOutput: 1,
      executionCount: 1,
      retryCount: 0,
      retryResult: 'not_needed'
    }), progress(true), progress(true))

    const result = telemetry.finish({
      completedAt: 250,
      finalProgress: progress(true),
      finalInventory: [{ name: 'wooden_pickaxe', count: 1 }]
    })

    assert.equal(result.providerCalls, 2)
    assert.equal(result.decisionCount, 2)
    assert.equal(result.inputTokens, 200)
    assert.equal(result.outputTokens, 30)
    assert.equal(result.memoryEpisodesCreated, 2)
    assert.equal(result.memoryEpisodesRetrieved, 3)
    assert.equal(result.memorySemanticFactsCreated, 1)
    assert.equal(result.memorySemanticFactsRetrieved, 2)
    assert.equal(result.reflectionCalls, 1)
    assert.equal(result.reflectionFailures, 0)
    assert.equal(result.reflectionInputTokens, 90)
    assert.equal(result.reflectionOutputTokens, 12)
    assert.equal(result.estimatedMemoryPromptTokens, 44)
    assert.deepEqual(result.memoryRetrievalQuality, {
      directlyRelevant: 2,
      weaklyRelevant: 0,
      irrelevant: 0,
      staleOrContradicted: 2,
      total: 4
    })
    assert.equal(result.memoryRetrievalTrace.length, 2)
    assert.equal(
      JSON.stringify(result.memoryRetrievalTrace).includes('Remembered oak_log'),
      false
    )
    assert.deepEqual(result.decisionTrace, [
      {
        providerCall: 1,
        status: 'executed',
        action: 'craft_item',
        target: 'wooden_pickaxe',
        success: true,
        progress: true,
        failureReason: null
      },
      {
        providerCall: 2,
        status: 'executed',
        action: 'craft_item',
        target: 'wooden_pickaxe',
        success: false,
        progress: false,
        failureReason: 'inventory_changed'
      }
    ])
    assert.equal(JSON.stringify(result.decisionTrace).includes('Build.'), false)
    assert.equal(JSON.stringify(result.decisionTrace).includes('summary'), false)
    assert.equal('memoryPrompt' in result, false)
    assert.equal('providerResponse' in result, false)
    assert.deepEqual(result.llmLatenciesMs, [25, 25])
    assert.equal(result.progressActionCount, 1)
    assert.equal(result.noProgressCount, 1)
    assert.equal(result.skillFailures, 1)
    assert.deepEqual(result.actionCounts, { craft_item: 2 })
    assert.deepEqual(result.skillFailureReasons, {
      'craft_item:inventory_changed': 1
    })
    assert.deepEqual(result.craftEvents, [{
      requestedAmount: 4,
      recipeOutput: 4,
      executionCount: 1,
      retryCount: 1,
      retryResult: 'succeeded',
      success: true,
      failureReason: null
    }, {
      requestedAmount: 1,
      recipeOutput: 1,
      executionCount: 1,
      retryCount: 0,
      retryResult: 'not_needed',
      success: false,
      failureReason: 'inventory_changed'
    }])
    const summary = summarizeBootstrapRuns([result])
    assert.equal(summary.craftRetryRate, 0.5)
    assert.equal(summary.craftRetrySuccessRate, 1)
    assert.equal(summary.totalMemoryEpisodesCreated, 2)
    assert.equal(summary.totalMemoryEpisodesRetrieved, 3)
    assert.equal(summary.totalReflectionCalls, 1)
    assert.equal(summary.reflectionFailureRate, 0)
    assert.equal(summary.totalEstimatedMemoryPromptTokens, 44)
    assert.equal(summary.totalProviderCalls, 2)
    assert.equal(summary.meanProviderLatencyMs, 25)
    assert.equal(summary.medianProviderLatencyMs, 25)
    assert.equal(summary.averageMemoryPromptTokensPerProviderCall, 22)
    assert.deepEqual(summary.memoryRetrievalQuality, {
      directlyRelevant: 2,
      weaklyRelevant: 0,
      irrelevant: 0,
      staleOrContradicted: 2,
      total: 4
    })
    assert.equal(result.goalCompleted, true)
    assert.equal(result.success, true)
  })

  it('classifies provider, grounding, repetition, crafting, timeout, and infrastructure failures', () => {
    const cases: Array<[BrainCycleResult, string]> = [
      [{ status: 'provider_failed', error: 'HTTP 500' }, 'provider_error'],
      [{ status: 'validation_failed', issues: ['decision.item: Item target must be currently craftable.'] }, 'grounding_rejection'],
      [{ status: 'policy_rejected', reason: 'stagnant_action', decision: { action: 'idle', reason: 'Wait.' } }, 'repetition_stagnation'],
      [executed('craft_item', false, 'inventory_changed'), 'crafting_failure']
    ]

    for (const [cycle, expected] of cases) {
      const telemetry = createTelemetry()
      telemetry.recordCycle(cycle, progress(false), progress(false))
      assert.equal(telemetry.finish({
        completedAt: 2,
        finalProgress: progress(false),
        finalInventory: []
      }).failureReason, expected)
    }

    assert.equal(createTelemetry().finish({
      completedAt: 2, finalProgress: progress(false), finalInventory: [], timedOut: true
    }).failureReason, 'timeout')
    assert.equal(createTelemetry().finish({
      completedAt: 2, finalProgress: progress(false), finalInventory: [], infrastructureInvalid: true
    }).failureReason, 'infrastructure_invalid')
  })

  it('does not associate a skipped cycle with an earlier provider call', () => {
    const telemetry = createTelemetry()
    telemetry.recordProviderCall({
      latencyMs: 10,
      succeeded: true,
      timing: null
    })
    telemetry.recordCycle(
      executed('craft_item', true),
      progress(false),
      progress(true)
    )
    telemetry.recordCycle(
      { status: 'skipped', reason: 'action_in_progress' },
      progress(true),
      progress(true)
    )

    const result = telemetry.finish({
      completedAt: 2,
      finalProgress: progress(true),
      finalInventory: []
    })
    assert.deepEqual(
      result.decisionTrace.map(event => event.providerCall),
      [1, null]
    )
  })

  it('keeps failed and infrastructure-invalid attempts in raw summaries', () => {
    const completed = createTelemetry('completed').finish({
      completedAt: 2, finalProgress: progress(true), finalInventory: []
    })
    const failed = createTelemetry('failed').finish({
      completedAt: 4, finalProgress: progress(false), finalInventory: [], timedOut: true
    })
    const invalidTelemetry = createTelemetry('invalid')
    invalidTelemetry.recordMemoryMetrics({
      episodesCreated: 99,
      episodesRetrieved: 99,
      semanticFactsCreated: 99,
      semanticFactsRetrieved: 99,
      retrievalFailures: 99,
      persistenceFailures: 99,
      reflectionCalls: 99,
      reflectionFailures: 99,
      reflectionInputTokens: 99,
      reflectionOutputTokens: 99,
      estimatedMemoryPromptTokens: 99
    })
    const invalid = invalidTelemetry.finish({
      completedAt: 6, finalProgress: progress(false), finalInventory: [], infrastructureInvalid: true
    })

    const summary = summarizeBootstrapRuns([completed, failed, invalid])

    assert.equal(summary.rawRuns, 3)
    assert.equal(summary.validRuns, 2)
    assert.equal(summary.infrastructureInvalidRuns, 1)
    assert.equal(summary.goalCompletionRate, 0.5)
    assert.equal(summary.mostCommonFailureReason, 'timeout')
    assert.deepEqual(summary.failureCounts, { timeout: 1 })
    assert.equal(summary.totalMemoryEpisodesCreated, 0)
    assert.equal(summary.reflectionFailureRate, 0)
    assert.equal(summary.memoryRetrievalQuality.total, 0)
  })
})

function providerInput(): BrainInput {
  return {
    perception: {
      agent: 'Alice', timestamp: 1, position: { x: 0, y: 200, z: 0 },
      health: 20, food: 20,
      nearbyBlocks: [{
        name: 'oak_log', distance: 1, position: { x: 1, y: 200, z: 0 }
      }],
      nearbyEntities: [], inventory: [{ name: 'oak_log', count: 3 }],
      edibleItemCount: 0, craftableItems: [], nearbyCraftingTable: false,
      equippedItem: null, placeableBlocks: []
    },
    state: {
      agentName: 'Alice', status: 'idle', currentAction: null,
      currentGoal: null, actionSource: null, busy: false
    },
    previousActionResult: null,
    recentDecisions: [],
    shortTermGoal: {
      id: 'goal-1', type: 'establish_basic_resources',
      description: 'Establish basic crafting capability.', status: 'active'
    },
    goalProgress: null,
    availableCapabilities: {
      observedCollectableBlocks: ['oak_log'], craftableItems: [],
      placeableBlocks: [], canExplore: true
    },
    memory: {
      recentEpisodes: [{
        type: 'resource_discovery', summary: 'Remembered oak_log nearby.',
        importance: 7, age: 'recent', region: '0:0'
      }],
      relevantFacts: [{
        subject: 'crafting_table', relation: 'landmark_observed_near',
        object: 'region:0:0', confidence: 0.2, status: 'stale', age: 'older'
      }]
    }
  }
}

function createTelemetry(runId = 'run'): BootstrapRunTelemetry {
  return new BootstrapRunTelemetry({ runId, provider: 'openai', model: 'gpt-5-mini', startedAt: 1 })
}

function progress(completed: boolean): GoalProgress {
  return {
    goalType: 'establish_basic_resources', hasWood: !completed, hasPlanks: completed,
    hasSticks: completed, hasCraftingTableItem: false, hasCraftingAccess: completed,
    hasBasicTool: completed, hasImprovedTool: false, hasSafeFood: false,
    survivalReady: true, usefulResourcesNearby: false, completed
  }
}

function executed(
  action: 'craft_item',
  success: boolean,
  reason?: string,
  details: Record<string, unknown> = {}
): BrainCycleResult {
  return {
    status: 'executed',
    decision: { action, item: 'wooden_pickaxe', amount: 1, reason: 'Build.' },
    result: {
      success, action, status: success ? 'completed' : 'failed', summary: 'craft',
      ...(reason || Object.keys(details).length > 0
        ? { details: { ...details, ...(reason ? { reason } : {}) } }
        : {})
    }
  }
}
