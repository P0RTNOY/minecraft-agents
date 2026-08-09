import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Bot } from 'mineflayer'

import {
  beginAgentAction,
  createAgentState,
  markManualOverride
} from './state.js'
import type { AgentDecision } from '../brain/types.js'
import type { LLMProvider } from '../brain/provider.js'
import {
  AutonomousAgentLoop,
  type AgentLoopOptions
} from './loop.js'

const fakeBot = {} as Bot

describe('AutonomousAgentLoop', () => {
  it('does not execute invalid provider output', async () => {
    let executions = 0
    const loop = createLoop({
      provider: { decide: async () => ({ action: 'run_shell', command: 'rm' }) },
      execute: async () => {
        executions += 1
        return successfulIdleResult()
      }
    })

    const result = await loop.runCycle()

    assert.equal(result.status, 'validation_failed')
    assert.equal(executions, 0)
  })

  it('does not execute self or hallucinated player targets', async () => {
    const decisions = [
      { action: 'come_to_player', username: 'Alice', reason: 'Meet Alice.' },
      { action: 'follow_player', username: 'Alex', reason: 'Follow Alex.' },
      { action: 'follow_player', username: 'Steve', reason: 'Follow Steve.' }
    ]
    let providerCalls = 0
    let executions = 0
    const loop = createLoop({
      provider: {
        decide: async () => {
          const decision = decisions[providerCalls]
          providerCalls += 1
          return decision
        }
      },
      observe: () => ({
        agent: 'Alice',
        timestamp: 1,
        position: { x: 0, y: 64, z: 0 },
        health: 20,
        food: 20,
        nearbyBlocks: [],
        nearbyEntities: [{
          id: 1,
          name: 'Steve',
          type: 'player',
          distance: 4,
          position: { x: 4, y: 64, z: 0 }
        }],
        inventory: []
      }),
      execute: async (_bot, decision) => {
        executions += 1
        return executionFor(decision)
      }
    })

    const selfTarget = await loop.runCycle()
    const hallucinatedTarget = await loop.runCycle()
    const externalTarget = await loop.runCycle()

    assert.equal(selfTarget.status, 'validation_failed')
    assert.equal(hallucinatedTarget.status, 'validation_failed')
    assert.equal(externalTarget.status, 'executed')
    assert.equal(executions, 1)
  })

  it('does not overlap provider calls or skill execution', async () => {
    const decision = deferred<unknown>()
    let providerCalls = 0
    let executions = 0
    const loop = createLoop({
      provider: {
        decide: async () => {
          providerCalls += 1
          return decision.promise
        }
      },
      execute: async () => {
        executions += 1
        return successfulIdleResult()
      }
    })

    const firstCycle = loop.runCycle()
    await Promise.resolve()
    const overlappingCycle = await loop.runCycle()
    decision.resolve({ action: 'idle', reason: 'Wait.' })
    const completedCycle = await firstCycle

    assert.deepEqual(overlappingCycle, {
      status: 'skipped',
      reason: 'cycle_in_progress'
    })
    assert.equal(completedCycle.status, 'executed')
    assert.equal(providerCalls, 1)
    assert.equal(executions, 1)
  })

  it('handles provider failure and allows a future cycle to retry', async () => {
    let attempts = 0
    const provider: LLMProvider = {
      decide: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('Ollama unavailable')
        return { action: 'idle', reason: 'Wait.' }
      }
    }
    const loop = createLoop({ provider })

    const failed = await loop.runCycle()
    const retried = await loop.runCycle()

    assert.equal(failed.status, 'provider_failed')
    assert.equal(retried.status, 'executed')
    assert.equal(attempts, 2)
  })

  it('discards a pending decision when a manual command takes priority', async () => {
    const decision = deferred<unknown>()
    const state = createAgentState('Alice')
    let executions = 0
    const loop = createLoop({
      state,
      provider: { decide: async () => decision.promise },
      execute: async () => {
        executions += 1
        return successfulIdleResult()
      }
    })

    const cycle = loop.runCycle()
    await Promise.resolve()
    markManualOverride(state)
    decision.resolve({ action: 'idle', reason: 'Wait.' })

    assert.deepEqual(await cycle, {
      status: 'skipped',
      reason: 'manual_override'
    })
    assert.equal(executions, 0)
  })

  it('does not interrupt an active manual skill on a later cycle', async () => {
    const state = createAgentState('Alice')
    let providerCalls = 0
    beginAgentAction(
      state,
      'following',
      'follow_player',
      'Follow Steve',
      'manual'
    )
    const loop = createLoop({
      state,
      provider: {
        decide: async () => {
          providerCalls += 1
          return { action: 'idle', reason: 'Wait.' }
        }
      }
    })

    assert.deepEqual(await loop.runCycle(), {
      status: 'skipped',
      reason: 'manual_action_active'
    })
    assert.equal(providerCalls, 0)
  })

  it('rejects repeated chat without executing it twice', async () => {
    let executions = 0
    const loop = createLoop({
      provider: {
        decide: async () => ({
          action: 'say',
          message: 'Hello there!',
          reason: 'Greet the area.'
        })
      },
      execute: async (_bot, decision) => {
        executions += 1
        return executionFor(decision)
      }
    })

    assert.equal((await loop.runCycle()).status, 'executed')
    assert.deepEqual(await loop.runCycle(), {
      status: 'policy_rejected',
      reason: 'duplicate_say',
      decision: {
        action: 'say',
        message: 'Hello there!',
        reason: 'Greet the area.'
      }
    })
    assert.equal(executions, 1)
  })

  it('rejects a third idle in unchanged observations', async () => {
    let executions = 0
    const loop = createLoop({
      provider: { decide: async () => ({ action: 'idle', reason: 'Wait.' }) },
      execute: async (_bot, decision) => {
        executions += 1
        return executionFor(decision)
      }
    })

    assert.equal((await loop.runCycle()).status, 'executed')
    assert.equal((await loop.runCycle()).status, 'executed')
    assert.equal((await loop.runCycle()).status, 'policy_rejected')
    assert.equal(executions, 2)
  })
})

function createLoop(
  overrides: Partial<AgentLoopOptions> = {}
): AutonomousAgentLoop {
  return new AutonomousAgentLoop({
    bot: fakeBot,
    state: createAgentState('Alice'),
    provider: { decide: async () => ({ action: 'idle', reason: 'Wait.' }) },
    intervalMs: 5000,
    observe: () => ({
      agent: 'Alice',
      timestamp: 1,
      position: { x: 0, y: 64, z: 0 },
      health: 20,
      food: 20,
      nearbyBlocks: [],
      nearbyEntities: [],
      inventory: []
    }),
    execute: async (_bot, decision) => executionFor(decision),
    logger: { log: () => {}, error: () => {} },
    ...overrides
  })
}

function executionFor(decision: AgentDecision) {
  return {
    success: true,
    action: decision.action,
    status: 'completed' as const,
    summary: `${decision.action} completed.`
  }
}

function successfulIdleResult() {
  return {
    success: true,
    action: 'idle' as const,
    status: 'completed' as const,
    summary: 'Idle completed.'
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve
  })

  return { promise, resolve: resolvePromise }
}
