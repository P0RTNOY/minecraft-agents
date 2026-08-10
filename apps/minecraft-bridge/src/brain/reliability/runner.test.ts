import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { BrainCycleResult } from '../../agent/loop.js'
import type { PerceptionSnapshot } from '../../perception/types.js'
import type { MemoryMetrics } from '../../memory/coordinator.js'
import { runBootstrapTrials } from './runner.js'

describe('runBootstrapTrials', () => {
  it('stops immediately on goal completion and cleans up before the next run', async () => {
    const events: string[] = []
    let completed = false
    const results = await runBootstrapTrials({
      runs: 2,
      provider: 'openai',
      model: 'gpt-5-mini',
      maxDecisions: 4,
      timeoutMs: 1_000,
      prepare: async runId => { completed = false; events.push(`prepare:${runId}`) },
      cleanup: async runId => { events.push(`cleanup:${runId}`) },
      createTrial: runId => ({
        runCycle: async () => {
          events.push(`cycle:${runId}`)
          completed = true
          return executed()
        },
        observe: () => perception(completed),
        memoryMetrics: () => memoryMetrics({ episodesCreated: 1 })
      })
    })

    assert.deepEqual(events, [
      'prepare:run-1', 'cycle:run-1', 'cleanup:run-1',
      'prepare:run-2', 'cycle:run-2', 'cleanup:run-2'
    ])
    assert.equal(results.runs.length, 2)
    assert.equal(results.runs.every(run => run.goalCompleted), true)
    assert.equal(results.runs.every(run => run.memoryEpisodesCreated === 1), true)
  })

  it('records timeout, provider failure, cleanup failure, and every attempted run', async () => {
    let index = 0
    const results = await runBootstrapTrials({
      runs: 3,
      provider: 'openai', model: 'gpt-5-mini', maxDecisions: 1, timeoutMs: 100,
      prepare: async () => {},
      cleanup: async runId => { if (runId === 'run-3') throw new Error('cleanup failed') },
      createTrial: () => {
        index += 1
        if (index === 1) return { runCycle: async () => new Promise(() => {}), observe: () => perception(false) }
        if (index === 2) return { runCycle: async () => ({ status: 'provider_failed', error: 'HTTP 500' }), observe: () => perception(false) }
        return { runCycle: async () => executed(), observe: () => perception(true) }
      }
    })

    assert.equal(results.runs.length, 3)
    assert.equal(results.runs[0]?.failureReason, 'timeout')
    assert.equal(results.runs[1]?.failureReason, 'provider_error')
    assert.equal(results.runs[2]?.failureReason, 'infrastructure_invalid')
  })
})

function executed(): BrainCycleResult {
  return { status: 'executed', decision: { action: 'idle', reason: 'Done.' }, result: { success: true, action: 'idle', status: 'completed', summary: 'done' } }
}

function memoryMetrics(overrides: Partial<MemoryMetrics> = {}): MemoryMetrics {
  return {
    episodesCreated: 0,
    episodesRetrieved: 0,
    semanticFactsCreated: 0,
    semanticFactsRetrieved: 0,
    retrievalFailures: 0,
    persistenceFailures: 0,
    reflectionCalls: 0,
    reflectionFailures: 0,
    reflectionInputTokens: 0,
    reflectionOutputTokens: 0,
    estimatedMemoryPromptTokens: 0,
    ...overrides
  }
}

function perception(completed: boolean): PerceptionSnapshot {
  return {
    agent: 'Alice', timestamp: Date.now(), position: { x: 0, y: 200, z: 0 }, health: 20, food: 20,
    nearbyBlocks: [], nearbyEntities: [],
    inventory: completed ? [{ name: 'wooden_pickaxe', count: 1 }] : [{ name: 'oak_log', count: 3 }],
    edibleItemCount: 0, craftableItems: [], nearbyCraftingTable: completed,
    equippedItem: null, placeableBlocks: []
  }
}
