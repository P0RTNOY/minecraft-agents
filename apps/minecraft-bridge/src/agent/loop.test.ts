import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Bot } from 'mineflayer'

import {
  beginAgentAction,
  createAgentState,
  markManualOverride
} from './state.js'
import { ActionArbiter } from './actionArbiter.js'
import type { AgentDecision, BrainInput } from '../brain/types.js'
import type { LLMProvider } from '../brain/provider.js'
import {
  AutonomousAgentLoop,
  type AgentLoopOptions
} from './loop.js'
import type {
  AgentMemory,
  MemoryCycleEvent
} from '../memory/coordinator.js'

const fakeBot = {} as Bot

describe('AutonomousAgentLoop', () => {
  it('retrieves memory before provider input and records after execution', async () => {
    const order: string[] = []
    const recorded: MemoryCycleEvent[] = []
    const loop = createLoop({
      memory: memoryDouble({
        retrieve: async () => {
          order.push('retrieve')
          return {
            context: {
              recentEpisodes: [{
                type: 'action_failure',
                summary: 'A prior attempt failed.',
                importance: 6,
                age: 'recent',
                region: '0:0'
              }],
              relevantFacts: []
            }
          }
        },
        record: async event => {
          order.push('record')
          recorded.push(event)
          return { episodesCreated: 1, semanticFactsCreated: 0 }
        }
      }),
      provider: {
        decide: async input => {
          order.push('provider')
          assert.equal(input.memory.recentEpisodes.length, 1)
          return { action: 'idle', reason: 'Wait.' }
        }
      },
      execute: async (_bot, decision) => {
        order.push('execute')
        return executionFor(decision)
      }
    })

    const result = await loop.runCycle()

    assert.equal(result.status, 'executed')
    assert.deepEqual(order, ['retrieve', 'provider', 'execute', 'record'])
    assert.equal(recorded[0]?.decision.action, 'idle')
    assert.equal(recorded[0]?.result.success, true)
  })

  it('records failed controlled outcomes and completed goal transitions', async () => {
    const recorded: MemoryCycleEvent[] = []
    const loop = createLoop({
      memory: memoryDouble({
        record: async event => {
          recorded.push(event)
          return { episodesCreated: 1, semanticFactsCreated: 0 }
        }
      }),
      goalManager: {
        update: () => ({
          shortTermGoal: null,
          goalProgress: null,
          availableCapabilities: {
            observedCollectableBlocks: [],
            craftableItems: [],
            placeableBlocks: [],
            canExplore: true
          },
          transition: {
            completedGoal: {
              id: 'goal-1',
              type: 'establish_basic_resources',
              description: 'Bootstrap.',
              status: 'completed'
            },
            nextGoal: null
          }
        })
      },
      provider: {
        decide: async () => ({ action: 'explore', reason: 'Explore.' })
      },
      execute: async () => ({
        success: false,
        action: 'explore',
        status: 'failed',
        summary: 'Navigation failed.',
        details: { reason: 'navigation_failed' }
      })
    })

    await loop.runCycle()

    assert.equal(recorded.length, 1)
    assert.equal(recorded[0]?.result.success, false)
    assert.equal(
      recorded[0]?.goalTransition?.completedGoal?.type,
      'establish_basic_resources'
    )
  })

  it('uses empty history after a memory failure without bypassing decisions', async () => {
    let executions = 0
    const loop = createLoop({
      memory: memoryDouble({
        retrieve: async () => {
          throw new Error('memory unavailable')
        }
      }),
      provider: {
        decide: async input => {
          assert.deepEqual(input.memory, {
            recentEpisodes: [],
            relevantFacts: []
          })
          return { action: 'idle', reason: 'Wait.' }
        }
      },
      execute: async (_bot, decision) => {
        executions += 1
        return executionFor(decision)
      }
    })

    assert.equal((await loop.runCycle()).status, 'executed')
    assert.equal(executions, 1)
  })

  it('does not change a successful cycle when memory persistence fails', async () => {
    const loop = createLoop({
      memory: memoryDouble({
        record: async () => {
          throw new Error('memory write unavailable')
        }
      })
    })

    const result = await loop.runCycle()

    assert.equal(result.status, 'executed')
    if (result.status === 'executed') {
      assert.equal(result.result.success, true)
    }
  })

  it('does not ground a target that exists only in memory', async () => {
    let executions = 0
    const loop = createLoop({
      memory: memoryDouble({
        retrieve: async () => ({
          context: {
            recentEpisodes: [],
            relevantFacts: [{
              subject: 'diamond_ore',
              relation: 'resource_observed_near',
              object: 'region:0:0',
              confidence: 1,
              status: 'historical',
              age: 'recent'
            }]
          }
        })
      }),
      provider: {
        decide: async () => ({
          action: 'collect_block',
          block: 'diamond_ore',
          reason: 'Collect remembered ore.'
        })
      },
      execute: async () => {
        executions += 1
        return successfulIdleResult()
      }
    })

    assert.equal((await loop.runCycle()).status, 'validation_failed')
    assert.equal(executions, 0)
  })

  it('provides current goal progress and grounded capabilities to the Brain', async () => {
    const observedInputs: BrainInput[] = []
    const loop = createLoop({
      provider: {
        decide: async input => {
          observedInputs.push(input)
          return { action: 'idle', reason: 'Wait.' }
        }
      },
      observe: () => ({
        agent: 'Alice',
        timestamp: 1,
        position: { x: 0, y: 64, z: 0 },
        health: 20,
        food: 20,
        nearbyBlocks: [{
          name: 'oak_log',
          distance: 3,
          position: { x: 3, y: 64, z: 0 }
        }],
        nearbyEntities: [],
        inventory: [{ name: 'oak_log', count: 1 }],
        edibleItemCount: 0,
        craftableItems: [{
          item: 'oak_planks',
          recipeOutput: 4,
          maxCraftable: 4,
          requiresTable: false
        }],
        nearbyCraftingTable: false,
        equippedItem: null,
        placeableBlocks: []
      })
    })

    await loop.runCycle()
    const observedInput = observedInputs[0]

    assert.ok(observedInput)
    assert.equal(
      observedInput?.shortTermGoal?.type,
      'establish_basic_resources'
    )
    assert.equal(observedInput?.goalProgress?.hasWood, true)
    assert.deepEqual(observedInput?.availableCapabilities, {
      observedCollectableBlocks: ['oak_log'],
      craftableItems: [{
        item: 'oak_planks',
        recipeOutput: 4,
        maxCraftable: 4,
        requiresTable: false
      }],
      placeableBlocks: [],
      canExplore: true
    })
  })

  it('withholds an advisory goal from the Brain during an emergency', async () => {
    const observedInputs: BrainInput[] = []
    const loop = createLoop({
      provider: {
        decide: async input => {
          observedInputs.push(input)
          return { action: 'idle', reason: 'Wait.' }
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
          id: 9,
          name: 'creeper',
          type: 'mob',
          category: 'Hostile mobs',
          distance: 3,
          position: { x: 3, y: 64, z: 0 }
        }],
        inventory: [],
        edibleItemCount: 0,
        craftableItems: [],
        nearbyCraftingTable: false,
        equippedItem: null,
        placeableBlocks: []
      })
    })

    await loop.runCycle()
    const observedInput = observedInputs[0]

    assert.ok(observedInput)
    assert.equal(observedInput?.shortTermGoal, null)
    assert.equal(observedInput?.goalProgress, null)
  })

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
          category: 'UNKNOWN',
          distance: 4,
          position: { x: 4, y: 64, z: 0 }
        }],
        inventory: [],
        edibleItemCount: 0,
        craftableItems: [],
        nearbyCraftingTable: false,
        equippedItem: null,
        placeableBlocks: []
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

  it('does not execute an unobserved collection target', async () => {
    let executions = 0
    const loop = createLoop({
      provider: {
        decide: async () => ({
          action: 'collect_block',
          block: 'oak_log',
          reason: 'Gather wood.'
        })
      },
      observe: () => ({
        agent: 'Alice',
        timestamp: 1,
        position: { x: 0, y: 64, z: 0 },
        health: 20,
        food: 20,
        nearbyBlocks: [{
          name: 'bamboo',
          distance: 3,
          position: { x: 3, y: 64, z: 0 }
        }],
        nearbyEntities: [],
        inventory: [],
        edibleItemCount: 0,
        craftableItems: [],
        nearbyCraftingTable: false,
        equippedItem: null,
        placeableBlocks: []
      }),
      execute: async (_bot, decision) => {
        executions += 1
        return executionFor(decision)
      }
    })

    const result = await loop.runCycle()

    assert.equal(result.status, 'validation_failed')
    assert.equal(executions, 0)
  })

  it('does not execute an item outside the current craftability context', async () => {
    let executions = 0
    const loop = createLoop({
      provider: {
        decide: async () => ({
          action: 'craft_item',
          item: 'diamond_pickaxe',
          amount: 1,
          reason: 'Upgrade tools.'
        })
      },
      execute: async () => {
        executions += 1
        return successfulIdleResult()
      }
    })

    const result = await loop.runCycle()

    assert.equal(result.status, 'validation_failed')
    assert.equal(executions, 0)
  })

  it('does not execute a block outside the current placement context', async () => {
    let executions = 0
    const loop = createLoop({
      provider: {
        decide: async () => ({
          action: 'place_block',
          block: 'tnt',
          reason: 'Place TNT.'
        })
      },
      execute: async () => {
        executions += 1
        return successfulIdleResult()
      }
    })

    const result = await loop.runCycle()

    assert.equal(result.status, 'validation_failed')
    assert.equal(executions, 0)
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

  it('discards a pending decision after a reflex interrupts its generation', async () => {
    const decision = deferred<unknown>()
    const arbiter = new ActionArbiter()
    let executions = 0
    const loop = createLoop({
      arbiter,
      provider: { decide: async () => decision.promise },
      execute: async () => {
        executions += 1
        return successfulIdleResult()
      }
    })

    const cycle = loop.runCycle()
    await Promise.resolve()
    arbiter.interrupt('reflex')
    decision.resolve({ action: 'idle', reason: 'Wait.' })

    assert.deepEqual(await cycle, {
      status: 'skipped',
      reason: 'priority_override'
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

  for (const source of ['reflex', 'autonomous'] as const) {
    it(`does not start an LLM cycle during an active ${source} skill`, async () => {
      const state = createAgentState('Alice')
      let providerCalls = 0
      beginAgentAction(
        state,
        source === 'reflex' ? 'fleeing' : 'following',
        source === 'reflex' ? 'flee_from_entity' : 'follow_player',
        source === 'reflex' ? 'Escape creeper' : 'Follow Steve',
        source
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
        reason: 'action_in_progress'
      })
      assert.equal(providerCalls, 0)
    })
  }

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

  it('does not execute a third identical progress action without observed progress', async () => {
    let executions = 0
    const loop = createLoop({
      provider: {
        decide: async () => ({
          action: 'explore',
          reason: `Explore attempt ${executions + 1}.`
        })
      },
      execute: async (_bot, decision) => {
        executions += 1
        return executionFor(decision)
      }
    })

    assert.equal((await loop.runCycle()).status, 'executed')
    assert.equal((await loop.runCycle()).status, 'executed')
    assert.deepEqual(await loop.runCycle(), {
      status: 'policy_rejected',
      reason: 'stagnant_action',
      decision: {
        action: 'explore',
        reason: 'Explore attempt 3.'
      }
    })
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
      inventory: [],
      edibleItemCount: 0,
      craftableItems: [],
      nearbyCraftingTable: false,
      equippedItem: null,
      placeableBlocks: []
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

function memoryDouble(overrides: Partial<AgentMemory> = {}): AgentMemory {
  return {
    retrieve: async () => ({
      context: { recentEpisodes: [], relevantFacts: [] }
    }),
    record: async () => ({ episodesCreated: 0, semanticFactsCreated: 0 }),
    metrics: () => ({
      episodesCreated: 0,
      episodesRetrieved: 0,
      semanticFactsCreated: 0,
      semanticFactsRetrieved: 0,
      retrievalFailures: 0,
      persistenceFailures: 0,
      reflectionCalls: 0,
      reflectionFailures: 0,
      reflectionInputTokens: 0,
      reflectionOutputTokens: 0
    }),
    ...overrides
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve
  })

  return { promise, resolve: resolvePromise }
}
