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
        edibleItemCount: 0,
        craftableItems: [],
        nearbyCraftingTable: false,
        equippedItem: null
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
      craftItem: async (_bot, _state, item, amount, source) => {
        calls.push(`craft:${item}:${amount}:${source}`)
        return {
          success: true,
          action: 'craft_item',
          target: item,
          requested: amount,
          crafted: amount,
          status: 'completed'
        }
      },
      exploreArea: async (_bot, _state, radius, source) => {
        calls.push(`explore:${radius}:${source}`)
        return {
          success: true,
          action: 'explore',
          status: 'completed',
          distanceTraveled: 9
        }
      },
      say: (_bot, message) => {
        calls.push(`say:${message}`)
        return { success: true, action: 'say', message }
      }
    }
    const execute = createDecisionExecutor(skills, { explorationRadius: 16 })
    const state = createAgentState('Alice')
    const decisions: AgentDecision[] = [
      { action: 'idle', reason: 'Wait.' },
      { action: 'scan', reason: 'Observe.' },
      { action: 'explore', reason: 'Search nearby.' },
      { action: 'follow_player', username: 'Steve', reason: 'Follow.' },
      { action: 'come_to_player', username: 'Alex', reason: 'Meet.' },
      { action: 'stop', reason: 'Stop.' },
      { action: 'collect_block', block: 'oak_log', reason: 'Collect.' },
      { action: 'craft_item', item: 'oak_planks', amount: 4, reason: 'Craft.' },
      { action: 'say', message: 'Hello!', reason: 'Greet.' }
    ]

    const results = []
    for (const decision of decisions) {
      results.push(await execute(fakeBot, decision, state))
    }

    assert.deepEqual(results.map(result => result.action), [
      'idle',
      'scan',
      'explore',
      'follow_player',
      'come_to_player',
      'stop',
      'collect_block',
      'craft_item',
      'say'
    ])
    assert.deepEqual(calls, [
      'explore:16:autonomous',
      'follow:Steve:autonomous',
      'come:Alex:autonomous',
      'stop',
      'collect:oak_log:autonomous',
      'craft:oak_planks:4:autonomous',
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
    craftItem: async () => {
      throw new Error('not used')
    },
    exploreArea: async () => {
      throw new Error('not used')
    },
    say: () => {
      throw new Error('not used')
    }
  }
}
