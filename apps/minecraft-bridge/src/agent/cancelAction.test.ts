import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Bot } from 'mineflayer'

import { cancelAgentAction } from './cancelAction.js'
import { beginAgentAction, createAgentState } from './state.js'

describe('cancelAgentAction', () => {
  it('cancels collection navigation and digging before clearing state', () => {
    const calls: string[] = []
    const bot = createBot(calls)
    const state = createAgentState('Alice')
    beginAgentAction(state, 'collecting', 'collect_block', 'Collect bamboo')

    cancelAgentAction(bot, state)

    assert.deepEqual(calls, ['setGoal:null', 'stopDigging'])
    assert.equal(state.busy, false)
    assert.equal(state.currentAction, null)
  })

  it('deactivates a held item when cancelling eating', () => {
    const calls: string[] = []
    const bot = createBot(calls)
    const state = createAgentState('Alice')
    beginAgentAction(state, 'eating', 'eat', 'Eat bread', 'reflex')

    cancelAgentAction(bot, state)

    assert.deepEqual(calls, ['setGoal:null', 'deactivateItem'])
    assert.equal(state.busy, false)
  })

  it('stops navigation when cancelling movement or fleeing', () => {
    const calls: string[] = []
    const bot = createBot(calls)
    const state = createAgentState('Alice')
    beginAgentAction(
      state,
      'fleeing',
      'flee_from_entity',
      'Escape creeper',
      'reflex'
    )

    cancelAgentAction(bot, state)

    assert.deepEqual(calls, ['setGoal:null'])
    assert.equal(state.busy, false)
  })
})

function createBot(calls: string[]): Bot {
  return {
    pathfinder: {
      setGoal(goal: unknown) {
        calls.push(`setGoal:${String(goal)}`)
      }
    },
    stopDigging() {
      calls.push('stopDigging')
    },
    deactivateItem() {
      calls.push('deactivateItem')
    }
  } as unknown as Bot
}
