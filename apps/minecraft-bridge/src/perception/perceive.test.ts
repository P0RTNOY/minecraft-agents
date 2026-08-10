import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { Item } from 'prismarine-item'
import { Vec3 } from 'vec3'

import { perceive } from './perceive.js'

describe('perceive', () => {
  it('attaches registry categories and counts only safe edible inventory', () => {
    const self = entity(1, 'player', 'Alice', new Vec3(0, 64, 0))
    const creeper = entity(7, 'mob', 'creeper', new Vec3(3, 64, 0))
    let inventoryReads = 0
    const bot = {
      username: 'Alice',
      entity: self,
      entities: { 1: self, 7: creeper },
      health: 20,
      food: 6,
      findBlocks: () => [],
      blockAt: () => null,
      inventory: {
        items: () => {
          inventoryReads += 1
          return [
            { name: 'apple', count: 2, type: 10 } as Item,
            { name: 'rotten_flesh', count: 3, type: 11 } as Item,
            { name: 'cobblestone', count: 4, type: 12 } as Item
          ]
        }
      },
      registry: {
        entitiesByName: {
          creeper: { category: 'Hostile mobs' }
        },
        foodsByName: {
          apple: { name: 'apple', foodPoints: 4 },
          rotten_flesh: { name: 'rotten_flesh', foodPoints: 4 }
        }
      }
    } as unknown as Bot

    const result = perceive(bot)

    assert.equal(result.edibleItemCount, 2)
    assert.equal(inventoryReads, 1)
    assert.deepEqual(result.nearbyEntities, [{
      id: 7,
      name: 'creeper',
      type: 'mob',
      category: 'Hostile mobs',
      distance: 3,
      position: { x: 3, y: 64, z: 0 }
    }])
  })
})

function entity(
  id: number,
  type: Entity['type'],
  name: string,
  position: Vec3
): Entity {
  return { id, type, name, username: name, position } as Entity
}
