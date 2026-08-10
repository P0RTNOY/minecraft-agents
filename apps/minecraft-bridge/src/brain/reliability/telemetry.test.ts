import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { BrainCycleResult } from '../../agent/loop.js'
import type { GoalProgress } from '../goals.js'
import type { LLMProvider } from '../provider.js'
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

    await wrapped.decide({} as never)
    timing = { promptTokens: 80, outputTokens: 10 }
    await wrapped.decide({} as never)
    telemetry.recordCycle(executed('craft_item', true), progress(false), progress(true))
    telemetry.recordCycle(executed('craft_item', false, 'inventory_changed'), progress(true), progress(true))

    const result = telemetry.finish({
      completedAt: 250,
      finalProgress: progress(true),
      finalInventory: [{ name: 'wooden_pickaxe', count: 1 }]
    })

    assert.equal(result.providerCalls, 2)
    assert.equal(result.decisionCount, 2)
    assert.equal(result.inputTokens, 200)
    assert.equal(result.outputTokens, 30)
    assert.deepEqual(result.llmLatenciesMs, [25, 25])
    assert.equal(result.progressActionCount, 1)
    assert.equal(result.noProgressCount, 1)
    assert.equal(result.skillFailures, 1)
    assert.deepEqual(result.actionCounts, { craft_item: 2 })
    assert.deepEqual(result.skillFailureReasons, {
      'craft_item:inventory_changed': 1
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

  it('keeps failed and infrastructure-invalid attempts in raw summaries', () => {
    const completed = createTelemetry('completed').finish({
      completedAt: 2, finalProgress: progress(true), finalInventory: []
    })
    const failed = createTelemetry('failed').finish({
      completedAt: 4, finalProgress: progress(false), finalInventory: [], timedOut: true
    })
    const invalid = createTelemetry('invalid').finish({
      completedAt: 6, finalProgress: progress(false), finalInventory: [], infrastructureInvalid: true
    })

    const summary = summarizeBootstrapRuns([completed, failed, invalid])

    assert.equal(summary.rawRuns, 3)
    assert.equal(summary.validRuns, 2)
    assert.equal(summary.infrastructureInvalidRuns, 1)
    assert.equal(summary.goalCompletionRate, 0.5)
    assert.equal(summary.mostCommonFailureReason, 'timeout')
  })
})

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

function executed(action: 'craft_item', success: boolean, reason?: string): BrainCycleResult {
  return {
    status: 'executed',
    decision: { action, item: 'wooden_pickaxe', amount: 1, reason: 'Build.' },
    result: {
      success, action, status: success ? 'completed' : 'failed', summary: 'craft',
      ...(reason ? { details: { reason } } : {})
    }
  }
}
