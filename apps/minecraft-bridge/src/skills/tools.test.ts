import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Item } from 'prismarine-item'

import { selectHarvestTool } from './tools.js'

describe('selectHarvestTool', () => {
  it('uses an empty hand for blocks that are safely hand-harvestable', () => {
    const block = createBlock({ handHarvestable: true })

    assert.deepEqual(selectHarvestTool(createBot([]), block), {
      required: false,
      item: null,
      requiredTool: null
    })
  })

  it('chooses the fastest live inventory tool that can harvest the block', () => {
    const wooden = item(10, 'wooden_pickaxe', 5)
    const iron = item(11, 'iron_pickaxe', 2)
    const block = createBlock({
      validTools: [10, 11],
      digTimes: new Map([[10, 900], [11, 250]]),
      harvestTools: { 10: true, 11: true }
    })

    assert.deepEqual(selectHarvestTool(createBot([wooden, iron]), block), {
      required: true,
      item: iron,
      requiredTool: 'pickaxe'
    })
  })

  it('respects harvest tiers and reports the required tool class when absent', () => {
    const wooden = item(10, 'wooden_pickaxe', 5)
    const block = createBlock({
      validTools: [11],
      digTimes: new Map([[11, 250]]),
      harvestTools: { 11: true, 12: true }
    })
    const bot = createBot([wooden])

    assert.deepEqual(selectHarvestTool(bot, block), {
      required: true,
      item: null,
      requiredTool: 'pickaxe'
    })
  })
})

interface BlockOptions {
  handHarvestable?: boolean
  validTools?: number[]
  digTimes?: Map<number, number>
  harvestTools?: Record<number, boolean>
}

function createBlock(options: BlockOptions): Block {
  return {
    name: 'stone',
    harvestTools: options.harvestTools,
    canHarvest: (itemType: number | null) => itemType === null
      ? options.handHarvestable ?? false
      : options.validTools?.includes(itemType) ?? false,
    digTime: (itemType: number | null) => (
      itemType === null ? 10_000 : options.digTimes?.get(itemType) ?? Infinity
    )
  } as unknown as Block
}

function createBot(items: Item[]): Bot {
  return {
    entity: { effects: [] },
    inventory: { items: () => items },
    registry: {
      items: {
        10: { id: 10, name: 'wooden_pickaxe' },
        11: { id: 11, name: 'iron_pickaxe' },
        12: { id: 12, name: 'diamond_pickaxe' }
      }
    }
  } as unknown as Bot
}

function item(type: number, name: string, slot: number): Item {
  return {
    type,
    name,
    slot,
    count: 1,
    enchants: []
  } as unknown as Item
}
