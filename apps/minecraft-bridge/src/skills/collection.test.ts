import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Item } from 'prismarine-item'
import { Vec3 } from 'vec3'

import { createAgentState } from '../agent/state.js'
import { validateDecision } from '../brain/validateDecision.js'
import {
  collectBlock,
  createCollectionSkill,
  getCollectedItemCount,
  type CollectionNavigator
} from './collection.js'

describe('collection result accounting', () => {
  it('reports the positive inventory delta after a pickup', () => {
    assert.equal(getCollectedItemCount(2, 5), 3)
  })

  it('never reports a negative collected count', () => {
    assert.equal(getCollectedItemCount(5, 2), 0)
  })

  it('fails safely when an observed target is gone before collection starts', async () => {
    const validation = validateDecision({
      action: 'collect_block',
      block: 'bamboo',
      reason: 'Gather bamboo.'
    }, {
      selfUsername: 'Alice',
      visibleExternalPlayers: [],
      visibleNearbyBlocks: ['bamboo']
    })
    const bot = {
      findBlock: () => null
    } as unknown as Bot

    assert.equal(validation.success, true)
    assert.deepEqual(
      await collectBlock(bot, createAgentState('Alice'), 'bamboo', 'autonomous'),
      {
        success: false,
        action: 'collect_block',
        target: 'bamboo',
        status: 'failed',
        collected: 0,
        blockBroken: false,
        dropDetected: false,
        reason: 'block_not_found'
      }
    )
  })

  it('rejects a required harvest tool before navigation when none is available', async () => {
    const fixture = createToolCollectionFixture([])

    const result = await createCollectionSkill(unusedNavigator())(
      fixture.bot,
      createAgentState('Alice'),
      'stone',
      'autonomous'
    )

    assert.equal(result.success, false)
    assert.equal(result.reason, 'missing_required_tool')
    assert.equal(result.requiredTool, 'pickaxe')
    assert.equal(fixture.events.length, 0)
  })

  it('equips the fastest valid exact tool before digging', async () => {
    const fixture = createToolCollectionFixture([
      tool(10, 'wooden_pickaxe', 5),
      tool(11, 'iron_pickaxe', 6)
    ])
    const collect = createCollectionSkill(navigator(fixture.events))

    const result = await collect(
      fixture.bot,
      createAgentState('Alice'),
      'stone',
      'autonomous'
    )

    assert.equal(result.success, true)
    assert.equal(result.tool, 'iron_pickaxe')
    assert.deepEqual(fixture.events.slice(0, 4), [
      'prepare',
      'goto:block',
      'equip:iron_pickaxe',
      'dig:stone'
    ])
  })

  it('fails before equip and dig when the selected tool disappears en route', async () => {
    const fixture = createToolCollectionFixture([
      tool(10, 'wooden_pickaxe', 5),
      tool(11, 'iron_pickaxe', 6)
    ])
    const collect = createCollectionSkill({
      prepare: () => fixture.events.push('prepare'),
      gotoBlock: async () => {
        fixture.events.push('goto:block')
        fixture.items.splice(
          fixture.items.findIndex(item => item.name === 'iron_pickaxe'),
          1
        )
      },
      gotoDrop: async () => assert.fail('drop navigation must not start')
    })

    const result = await collect(
      fixture.bot,
      createAgentState('Alice'),
      'stone',
      'autonomous'
    )

    assert.equal(result.success, false)
    assert.equal(result.reason, 'tool_unavailable')
    assert.equal(result.tool, 'iron_pickaxe')
    assert.deepEqual(fixture.events, ['prepare', 'goto:block'])
  })

  it('reports equip failure and cancellation without digging', async () => {
    const equipFailure = createToolCollectionFixture([
      tool(11, 'iron_pickaxe', 6)
    ])
    equipFailure.bot.equip = async () => {
      equipFailure.events.push('equip:iron_pickaxe')
      throw new Error('Inventory changed')
    }
    const failed = await createCollectionSkill(navigator(equipFailure.events))(
      equipFailure.bot,
      createAgentState('Alice'),
      'stone'
    )

    const cancelledFixture = createToolCollectionFixture([
      tool(11, 'iron_pickaxe', 6)
    ])
    const state = createAgentState('Alice')
    cancelledFixture.bot.equip = async () => {
      cancelledFixture.events.push('equip:iron_pickaxe')
      state.actionVersion += 1
    }
    const cancelled = await createCollectionSkill(
      navigator(cancelledFixture.events)
    )(cancelledFixture.bot, state, 'stone')

    assert.equal(failed.reason, 'tool_unavailable')
    assert.equal(failed.error, 'Inventory changed')
    assert.equal(cancelled.reason, 'action_cancelled')
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(equipFailure.events.includes('dig:stone'), false)
    assert.equal(cancelledFixture.events.includes('dig:stone'), false)
  })

  it('does not pursue drops after cancellation during digging', async () => {
    const fixture = createToolCollectionFixture([
      tool(11, 'iron_pickaxe', 6)
    ])
    const state = createAgentState('Alice')
    fixture.bot.dig = async () => {
      fixture.events.push('dig:stone')
      state.actionVersion += 1
    }

    const result = await createCollectionSkill(navigator(fixture.events))(
      fixture.bot,
      state,
      'stone'
    )

    assert.equal(result.reason, 'action_cancelled')
    assert.equal(result.status, 'cancelled')
    assert.equal(result.blockBroken, true)
    assert.equal(fixture.events.includes('goto:drop'), false)
  })
})

function createToolCollectionFixture(initialItems: Item[]): {
  bot: Bot
  items: Item[]
  events: string[]
} {
  const items = [...initialItems]
  const events: string[] = []
  const position = new Vec3(2, 64, 0)
  const block = {
    name: 'stone',
    position,
    harvestTools: { 10: true, 11: true },
    canHarvest: (type: number | null) => type === 10 || type === 11,
    digTime: (type: number | null) => type === 11 ? 250 : 900
  } as unknown as Block
  const bot = {
    entity: { position: new Vec3(0, 64, 0), effects: [] },
    entities: {},
    registry: {
      items: {
        10: { id: 10, name: 'wooden_pickaxe' },
        11: { id: 11, name: 'iron_pickaxe' }
      }
    },
    inventory: { items: () => items },
    findBlock: () => block,
    blockAt: () => block,
    canDigBlock: () => true,
    equip: async (selected: Item) => {
      events.push(`equip:${selected.name}`)
    },
    dig: async () => {
      events.push('dig:stone')
      items.push({
        type: 20,
        name: 'cobblestone',
        slot: 7,
        count: 1
      } as Item)
    },
    waitForTicks: async () => {}
  } as unknown as Bot

  return { bot, items, events }
}

function tool(type: number, name: string, slot: number): Item {
  return { type, name, slot, count: 1, enchants: [] } as unknown as Item
}

function navigator(events: string[]): CollectionNavigator {
  return {
    prepare: () => events.push('prepare'),
    gotoBlock: async () => {
      events.push('goto:block')
    },
    gotoDrop: async () => {
      events.push('goto:drop')
    }
  }
}

function unusedNavigator(): CollectionNavigator {
  return {
    prepare: () => assert.fail('navigation must not start'),
    gotoBlock: async () => assert.fail('navigation must not start'),
    gotoDrop: async () => assert.fail('navigation must not start')
  }
}
