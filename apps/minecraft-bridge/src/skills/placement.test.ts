import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Entity } from 'prismarine-entity'
import type { Item } from 'prismarine-item'
import { Vec3 } from 'vec3'

import { createAgentState } from '../agent/state.js'
import {
  findPlacementTarget,
  inspectPlaceableBlocks,
  placeInventoryBlock
} from './placement.js'

describe('placement capabilities', () => {
  it('reports only safe solid same-name inventory blocks', () => {
    const fixture = createPlacementBot({
      items: [
        item(1, 'crafting_table', 1, 5),
        item(2, 'stick', 3, 6),
        item(3, 'tnt', 1, 7)
      ]
    })

    assert.deepEqual(inspectPlaceableBlocks(fixture.bot), [
      { name: 'crafting_table', count: 1 }
    ])
  })

  it('chooses a supported empty local target outside entity space', () => {
    const fixture = createPlacementBot()
    const target = findPlacementTarget(fixture.bot)

    assert.ok(target)
    assert.equal(target.position.distanceTo(fixture.bot.entity.position) < 4, true)
    assert.equal(target.support.position.equals(target.position.offset(0, -1, 0)), true)
  })

  it('rejects fluid, unsupported, and entity-occupied local targets', () => {
    const fluid = createPlacementBot({ allTargetsFluid: true })
    const unsupported = createPlacementBot({ missingSupport: true })
    const occupied = createPlacementBot({ occupyAllTargets: true })

    assert.equal(findPlacementTarget(fluid.bot), null)
    assert.equal(findPlacementTarget(unsupported.bot), null)
    assert.equal(findPlacementTarget(occupied.bot), null)
  })
})

describe('placeInventoryBlock', () => {
  it('equips an exact live stack, places locally, and verifies the world block', async () => {
    const fixture = createPlacementBot()
    const state = createAgentState('Alice')

    const result = await placeInventoryBlock(
      fixture.bot,
      state,
      'crafting_table',
      'autonomous'
    )

    assert.equal(result.success, true)
    assert.equal(result.placed, true)
    assert.deepEqual(fixture.events, ['equip:crafting_table', 'place:crafting_table'])
    assert.equal(state.busy, false)
  })

  it('rejects unavailable and unsafe inventory targets', async () => {
    const fixture = createPlacementBot()

    assert.equal((await placeInventoryBlock(
      fixture.bot,
      createAgentState('Alice'),
      'oak_planks'
    )).reason, 'block_unavailable')
    assert.equal((await placeInventoryBlock(
      createPlacementBot({
        items: [item(3, 'tnt', 1, 7)]
      }).bot,
      createAgentState('Alice'),
      'tnt'
    )).reason, 'block_unavailable')
  })

  it('revalidates item, target, and cancellation after equip', async () => {
    const missingItem = createPlacementBot({ removeItemDuringEquip: true })
    const changedTarget = createPlacementBot({ occupyTargetDuringEquip: true })
    const cancelled = createPlacementBot()
    const cancelledState = createAgentState('Alice')
    cancelled.bot.equip = async selected => {
      if (typeof selected === 'number') assert.fail('expected an item stack')
      cancelled.events.push(`equip:${selected.name}`)
      cancelledState.actionVersion += 1
    }

    const missingItemResult = await placeInventoryBlock(
      missingItem.bot,
      createAgentState('Alice'),
      'crafting_table'
    )
    const changedTargetResult = await placeInventoryBlock(
      changedTarget.bot,
      createAgentState('Alice'),
      'crafting_table'
    )
    const cancelledResult = await placeInventoryBlock(
      cancelled.bot,
      cancelledState,
      'crafting_table'
    )

    assert.equal(missingItemResult.reason, 'block_unavailable')
    assert.equal(changedTargetResult.reason, 'target_changed')
    assert.equal(cancelledResult.reason, 'action_cancelled')
    assert.equal(cancelledResult.status, 'cancelled')
    assert.equal(missingItem.events.some(event => event.startsWith('place:')), false)
    assert.equal(changedTarget.events.some(event => event.startsWith('place:')), false)
    assert.equal(cancelled.events.some(event => event.startsWith('place:')), false)
  })

  it('reports equip, placement, and verification failures safely', async () => {
    const equipFailure = createPlacementBot({ equipError: true })
    const placeFailure = createPlacementBot({ placeError: true })
    const noConfirmation = createPlacementBot({ suppressWorldUpdate: true })

    assert.equal((await placeInventoryBlock(
      equipFailure.bot,
      createAgentState('Alice'),
      'crafting_table'
    )).reason, 'equip_failed')
    assert.equal((await placeInventoryBlock(
      placeFailure.bot,
      createAgentState('Alice'),
      'crafting_table'
    )).reason, 'place_failed')
    assert.equal((await placeInventoryBlock(
      noConfirmation.bot,
      createAgentState('Alice'),
      'crafting_table'
    )).reason, 'placement_not_confirmed')
  })
})

interface PlacementOptions {
  items?: Item[]
  allTargetsFluid?: boolean
  missingSupport?: boolean
  occupyAllTargets?: boolean
  removeItemDuringEquip?: boolean
  occupyTargetDuringEquip?: boolean
  equipError?: boolean
  placeError?: boolean
  suppressWorldUpdate?: boolean
}

function createPlacementBot(options: PlacementOptions = {}): {
  bot: Bot
  items: Item[]
  events: string[]
} {
  const items = options.items ?? [item(1, 'crafting_table', 1, 5)]
  const events: string[] = []
  const origin = new Vec3(0, 64, 0)
  const placed = new Map<string, string>()
  let occupyTargetDuringEquip = false
  const self = entity(1, origin, 'Alice')
  const occupyingEntities = Object.fromEntries(
    [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1],
      [2, 0], [-2, 0], [0, 2], [0, -2]
    ].map(([x, z], index) => [
      index + 2,
      entity(index + 2, new Vec3(x, 64, z), `Entity${index}`)
    ])
  )

  const bot = {
    username: 'Alice',
    entity: self,
    entities: options.occupyAllTargets
      ? { 1: self, ...occupyingEntities }
      : { 1: self },
    inventory: { items: () => items },
    registry: {
      blocksByName: {
        crafting_table: { name: 'crafting_table', boundingBox: 'block' },
        tnt: { name: 'tnt', boundingBox: 'block' }
      }
    },
    blockAt: (position: Vec3) => {
      const placedName = placed.get(position.toString())
      if (placedName) return block(placedName, position, 'block')
      if (position.y === 63) {
        return options.missingSupport
          ? block('air', position, 'empty')
          : block('stone', position, 'block')
      }
      if (position.y === 64) {
        if (options.allTargetsFluid) return block('water', position, 'empty')
        if (occupyTargetDuringEquip) return block('stone', position, 'block')
        return block('air', position, 'empty')
      }
      return block('air', position, 'empty')
    },
    equip: async (selected: Item) => {
      events.push(`equip:${selected.name}`)
      if (options.equipError) throw new Error('Equip failed')
      if (options.removeItemDuringEquip) items.splice(items.indexOf(selected), 1)
      if (options.occupyTargetDuringEquip) occupyTargetDuringEquip = true
    },
    placeBlock: async (support: Block, face: Vec3) => {
      events.push('place:crafting_table')
      if (options.placeError) throw new Error('Placement failed')
      if (!options.suppressWorldUpdate) {
        placed.set(support.position.plus(face).toString(), 'crafting_table')
      }
    },
    waitForTicks: async () => {}
  } as unknown as Bot

  return { bot, items, events }
}

function block(
  name: string,
  position: Vec3,
  boundingBox: 'block' | 'empty'
): Block {
  return { name, position, boundingBox } as Block
}

function item(type: number, name: string, count: number, slot: number): Item {
  return { type, name, count, slot } as Item
}

function entity(id: number, position: Vec3, username: string): Entity {
  return {
    id,
    type: 'player',
    name: 'player',
    username,
    position,
    width: 0.6,
    height: 1.8,
    isValid: true
  } as Entity
}
