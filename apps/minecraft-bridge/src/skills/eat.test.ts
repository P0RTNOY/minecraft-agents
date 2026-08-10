import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'

import {
  createAgentState,
  stopAgentAction
} from '../agent/state.js'
import { eatFood, findSafeFood } from './eat.js'

describe('eatFood', () => {
  it('deterministically consumes the highest-value safe food in inventory', async () => {
    const apple = item('apple', 1, 10)
    const cookedBeef = item('cooked_beef', 2, 11)
    const bot = createBot([apple, cookedBeef])
    const state = createAgentState('Alice')
    let equipped: Item | null = null
    bot.equip = async selected => {
      equipped = selected as Item
    }
    bot.consume = async () => {
      bot.food += 8
    }

    const result = await eatFood(bot, state)

    assert.equal(equipped, cookedBeef)
    assert.deepEqual(result, {
      success: true,
      action: 'eat',
      status: 'completed',
      item: 'cooked_beef',
      foodBefore: 6,
      foodAfter: 14
    })
    assert.equal(state.busy, false)
  })

  it('returns no_food without equipping a non-food item', async () => {
    const bot = createBot([item('cobblestone', 64, 1)])
    let equipped = false
    bot.equip = async () => {
      equipped = true
    }

    const result = await eatFood(bot, createAgentState('Alice'))

    assert.equal(result.success, false)
    assert.equal(result.reason, 'no_food')
    assert.equal(equipped, false)
  })

  it('excludes foods with harmful or unpredictable effects', () => {
    const bot = createBot([
      item('pufferfish', 1, 20),
      item('rotten_flesh', 1, 21),
      item('chorus_fruit', 1, 22),
      item('cobblestone', 1, 23)
    ])

    assert.equal(findSafeFood(bot), null)
  })

  it('fails safely when the selected stack disappears before equip', async () => {
    const apple = item('apple', 1, 10)
    let reads = 0
    const bot = createBot([apple])
    bot.inventory.items = () => {
      reads += 1
      return reads === 1 ? [apple] : []
    }
    let equipped = false
    bot.equip = async () => {
      equipped = true
    }

    const result = await eatFood(bot, createAgentState('Alice'))

    assert.equal(result.success, false)
    assert.equal(result.reason, 'item_unavailable')
    assert.equal(equipped, false)
  })

  it('reports consumption failure and clears the busy state', async () => {
    const state = createAgentState('Alice')
    const bot = createBot([item('bread', 1, 12)])
    bot.consume = async () => {
      throw new Error('Consumption interrupted')
    }

    const result = await eatFood(bot, state)

    assert.equal(result.success, false)
    assert.equal(result.reason, 'consume_failed')
    assert.equal(result.error, 'Consumption interrupted')
    assert.equal(state.busy, false)
  })

  it('reports equip failure without attempting consumption', async () => {
    const bot = createBot([item('bread', 1, 12)])
    let consumed = false
    bot.equip = async () => {
      throw new Error('Cannot equip item')
    }
    bot.consume = async () => {
      consumed = true
    }

    const result = await eatFood(bot, createAgentState('Alice'))

    assert.equal(result.success, false)
    assert.equal(result.reason, 'equip_failed')
    assert.equal(result.error, 'Cannot equip item')
    assert.equal(consumed, false)
  })

  it('fails when Mineflayer cannot confirm that food increased', async () => {
    const bot = createBot([item('bread', 1, 12)])

    const result = await eatFood(bot, createAgentState('Alice'))

    assert.equal(result.success, false)
    assert.equal(result.reason, 'consumption_not_confirmed')
    assert.equal(result.foodBefore, 6)
    assert.equal(result.foodAfter, 6)
  })

  it('stops before consumption when a manual override cancels equip', async () => {
    const state = createAgentState('Alice')
    const bot = createBot([item('bread', 1, 12)])
    let consumed = false
    bot.equip = async () => {
      stopAgentAction(state)
    }
    bot.consume = async () => {
      consumed = true
    }

    const result = await eatFood(bot, state)

    assert.equal(result.success, false)
    assert.equal(result.status, 'cancelled')
    assert.equal(result.reason, 'action_cancelled')
    assert.equal(consumed, false)
  })

  it('does not consume food when hunger is already full', async () => {
    const bot = createBot([item('bread', 1, 12)])
    bot.food = 20
    let consumed = false
    bot.consume = async () => {
      consumed = true
    }

    const result = await eatFood(bot, createAgentState('Alice'))

    assert.equal(result.success, false)
    assert.equal(result.reason, 'not_hungry')
    assert.equal(consumed, false)
  })
})

function createBot(items: Item[]): Bot {
  return {
    food: 6,
    inventory: {
      items: () => items
    },
    registry: {
      foodsByName: {
        apple: { name: 'apple', foodPoints: 4 },
        cooked_beef: { name: 'cooked_beef', foodPoints: 8 },
        bread: { name: 'bread', foodPoints: 5 },
        pufferfish: { name: 'pufferfish', foodPoints: 1 },
        rotten_flesh: { name: 'rotten_flesh', foodPoints: 4 },
        chorus_fruit: { name: 'chorus_fruit', foodPoints: 4 }
      }
    },
    equip: async () => {},
    consume: async () => {}
  } as unknown as Bot
}

function item(name: string, count: number, type: number): Item {
  return { name, count, type } as Item
}
