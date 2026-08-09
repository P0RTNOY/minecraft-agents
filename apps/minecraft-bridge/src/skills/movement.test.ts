import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Bot } from 'mineflayer'

import { createAgentState } from '../agent/state.js'
import {
  followPlayer,
  isExpectedNavigationCancellation
} from './movement.js'

describe('movement cancellation', () => {
  it('recognizes Pathfinder goal replacement as expected cancellation', () => {
    const error = new Error(
      'The goal was changed before it could be completed!'
    )
    error.name = 'GoalChanged'

    assert.equal(isExpectedNavigationCancellation(error), true)
  })

  it('does not hide real navigation failures', () => {
    const error = new Error('No path to the goal!')
    error.name = 'NoPath'

    assert.equal(isExpectedNavigationCancellation(error), false)
    assert.equal(isExpectedNavigationCancellation('GoalChanged'), false)
  })

  it('rejects the agent as a player target before starting pathfinding', () => {
    const bot = {
      username: 'Alice',
      players: { Alice: { entity: {} } }
    } as unknown as Bot
    const state = createAgentState('Alice')

    assert.deepEqual(followPlayer(bot, state, 'Alice'), {
      success: false,
      action: 'follow_player',
      status: 'failed',
      target: 'Alice',
      reason: 'player_not_visible'
    })
    assert.equal(state.busy, false)
  })
})
