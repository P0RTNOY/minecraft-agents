import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Bot } from 'mineflayer'

import { ActionArbiter } from '../agent/actionArbiter.js'
import { beginAgentAction, createAgentState } from '../agent/state.js'
import type { PerceptionSnapshot } from '../perception/types.js'
import {
  ReflexLoop,
  type ReflexLoopOptions
} from './reflexLoop.js'

describe('ReflexLoop', () => {
  it('stays quiet and does not execute when there is no urgent decision', async () => {
    const messages: string[] = []
    let executions = 0
    const loop = createLoop({
      logger: logger(messages),
      execute: async () => {
        executions += 1
        return completedEatResult()
      }
    })

    assert.deepEqual(await loop.runCycle(), { status: 'no_action' })
    assert.equal(executions, 0)
    assert.deepEqual(messages, [])
  })

  it('executes and reports a grounded urgent reflex', async () => {
    const messages: string[] = []
    const loop = createLoop({
      observe: () => snapshot({ food: 4, edibleItemCount: 2 }),
      logger: logger(messages)
    })

    const result = await loop.runCycle()

    assert.equal(result.status, 'executed')
    assert.deepEqual(messages, [
      '⚡ Reflex: Food is critically low.',
      '⚙️ Executing reflex: eat',
      '✅ Reflex result: ate bread.'
    ])
  })

  it('does not let a reflex override an active manual action', async () => {
    const state = createAgentState('Alice')
    beginAgentAction(state, 'following', 'follow_player', 'Follow Steve')
    let observations = 0
    const loop = createLoop({
      state,
      observe: () => {
        observations += 1
        return snapshot({ food: 4, edibleItemCount: 2 })
      }
    })

    assert.deepEqual(await loop.runCycle(), {
      status: 'skipped',
      reason: 'manual_action_active'
    })
    assert.equal(observations, 0)
  })

  it('cancels a persistent autonomous action before executing a reflex', async () => {
    const events: string[] = []
    const state = createAgentState('Alice')
    beginAgentAction(
      state,
      'following',
      'follow_player',
      'Follow Steve',
      'autonomous'
    )
    const bot = createBot(events)
    const loop = createLoop({
      bot,
      state,
      observe: () => snapshot({ food: 4, edibleItemCount: 1 }),
      execute: async () => {
        events.push(`execute:busy=${state.busy}`)
        return completedEatResult()
      }
    })

    assert.equal((await loop.runCycle()).status, 'executed')
    assert.deepEqual(events, ['setGoal:null', 'execute:busy=false'])
  })

  it('does not overlap concurrent reflex cycles', async () => {
    const execution = deferred<ReturnType<typeof completedEatResult>>()
    let executions = 0
    const loop = createLoop({
      observe: () => snapshot({ food: 4, edibleItemCount: 1 }),
      execute: async () => {
        executions += 1
        return execution.promise
      }
    })

    const first = loop.runCycle()
    await Promise.resolve()
    assert.deepEqual(await loop.runCycle(), {
      status: 'skipped',
      reason: 'cycle_in_progress'
    })
    execution.resolve(completedEatResult())
    assert.equal((await first).status, 'executed')
    assert.equal(executions, 1)
  })

  it('reports observation failures and allows the next tick to recover', async () => {
    let observations = 0
    const loop = createLoop({
      observe: () => {
        observations += 1
        if (observations === 1) throw new Error('world unavailable')
        return snapshot()
      }
    })

    assert.deepEqual(await loop.runCycle(), {
      status: 'observation_failed',
      error: 'world unavailable'
    })
    assert.deepEqual(await loop.runCycle(), { status: 'no_action' })
  })

  it('accepts only conservative reflex intervals', () => {
    assert.throws(() => createLoop({ intervalMs: 99 }), /at least 100/)
    assert.throws(() => createLoop({ intervalMs: 501 }), /at most 500/)
  })
})

function createLoop(
  overrides: Partial<ReflexLoopOptions> = {}
): ReflexLoop {
  return new ReflexLoop({
    bot: createBot([]),
    state: createAgentState('Alice'),
    arbiter: new ActionArbiter(),
    intervalMs: 250,
    observe: () => snapshot(),
    execute: async () => completedEatResult(),
    logger: logger([]),
    ...overrides
  })
}

function snapshot(
  overrides: Partial<PerceptionSnapshot> = {}
): PerceptionSnapshot {
  return {
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
    ...overrides
  }
}

function completedEatResult() {
  return {
    success: true,
    action: 'eat' as const,
    status: 'completed' as const,
    item: 'bread',
    foodBefore: 4,
    foodAfter: 9
  }
}

function createBot(events: string[]): Bot {
  return {
    pathfinder: {
      setGoal(goal: unknown) {
        events.push(`setGoal:${String(goal)}`)
      }
    },
    stopDigging() {},
    deactivateItem() {}
  } as unknown as Bot
}

function logger(messages: string[]) {
  return {
    log(message: string) {
      messages.push(message)
    },
    error(message: string) {
      messages.push(message)
    }
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve
  })

  return { promise, resolve: resolvePromise }
}
