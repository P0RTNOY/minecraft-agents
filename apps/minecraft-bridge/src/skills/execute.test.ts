import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Bot } from 'mineflayer'

import { createAgentState } from '../agent/state.js'
import type { AgentDecision } from '../brain/types.js'
import {
  createDecisionExecutor,
  type DecisionSkillBindings
} from './execute.js'

const fakeBot = {} as Bot

describe('decision executor', () => {
  it('maps every approved decision through the explicit controlled skill set', async () => {
    const calls: string[] = []
    const skills: DecisionSkillBindings = {
      perceive: () => ({
        agent: 'Alice',
        timestamp: 1,
        position: { x: 0, y: 64, z: 0 },
        health: 20,
        food: 20,
        nearbyBlocks: [],
        nearbyEntities: [],
        inventory: [],
        edibleItemCount: 0
      }),
      followPlayer: (_bot, _state, username, source) => {
        calls.push(`follow:${username}:${source}`)
        return {
          success: true,
          action: 'follow_player',
          status: 'started',
          target: username
        }
      },
      comeToPlayer: async (_bot, _state, username, source) => {
        calls.push(`come:${username}:${source}`)
        return {
          success: true,
          action: 'come_to_player',
          status: 'completed',
          target: username
        }
      },
      stopMovement: () => {
        calls.push('stop')
        return {
          success: true,
          action: 'stop_movement',
          status: 'stopped'
        }
      },
      collectBlock: async (_bot, _state, block, source) => {
        calls.push(`collect:${block}:${source}`)
        return {
          success: true,
          action: 'collect_block',
          target: block,
          status: 'completed',
          collected: 1,
          blockBroken: true,
          dropDetected: true
        }
      },
      say: (_bot, message) => {
        calls.push(`say:${message}`)
        return { success: true, action: 'say', message }
      }
    }
    const execute = createDecisionExecutor(skills)
    const state = createAgentState('Alice')
    const decisions: AgentDecision[] = [
      { action: 'idle', reason: 'Wait.' },
      { action: 'scan', reason: 'Observe.' },
      { action: 'follow_player', username: 'Steve', reason: 'Follow.' },
      { action: 'come_to_player', username: 'Alex', reason: 'Meet.' },
      { action: 'stop', reason: 'Stop.' },
      { action: 'collect_block', block: 'oak_log', reason: 'Collect.' },
      { action: 'say', message: 'Hello!', reason: 'Greet.' }
    ]

    const results = []
    for (const decision of decisions) {
      results.push(await execute(fakeBot, decision, state))
    }

    assert.deepEqual(results.map(result => result.action), [
      'idle',
      'scan',
      'follow_player',
      'come_to_player',
      'stop',
      'collect_block',
      'say'
    ])
    assert.deepEqual(calls, [
      'follow:Steve:autonomous',
      'come:Alex:autonomous',
      'stop',
      'collect:oak_log:autonomous',
      'say:Hello!'
    ])
  })

  it('normalizes skill failures into a structured execution result', async () => {
    const skills = createFailingSkillBindings()
    const execute = createDecisionExecutor(skills)

    const result = await execute(
      fakeBot,
      { action: 'follow_player', username: 'Missing', reason: 'Try.' },
      createAgentState('Alice')
    )

    assert.deepEqual(result, {
      success: false,
      action: 'follow_player',
      status: 'failed',
      summary: 'Player Missing is not visible.',
      details: { reason: 'player_not_visible' }
    })
  })
})

function createFailingSkillBindings(): DecisionSkillBindings {
  return {
    perceive: () => {
      throw new Error('not used')
    },
    followPlayer: (_bot, _state, username) => ({
      success: false,
      action: 'follow_player',
      status: 'failed',
      target: username,
      reason: 'player_not_visible'
    }),
    comeToPlayer: async () => {
      throw new Error('not used')
    },
    stopMovement: () => {
      throw new Error('not used')
    },
    collectBlock: async () => {
      throw new Error('not used')
    },
    say: () => {
      throw new Error('not used')
    }
  }
}
