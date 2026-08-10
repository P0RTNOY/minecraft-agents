import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { serializeBrainInput } from './decisionContract.js'
import {
  buildBrainSemantics,
  buildDecisionContext
} from './semantics.js'
import type { BrainInput } from './types.js'

const input: BrainInput = {
  perception: {
    agent: 'Alice',
    timestamp: 123,
    position: { x: 1, y: 64, z: 2 },
    health: 7.95,
    food: 15,
    nearbyBlocks: [
      {
        name: 'grass_block',
        distance: 1,
        position: { x: 1, y: 63, z: 2 }
      },
      {
        name: 'dirt',
        distance: 2,
        position: { x: 2, y: 63, z: 2 }
      },
      {
        name: 'bamboo',
        distance: 3,
        position: { x: 3, y: 64, z: 2 }
      },
      {
        name: 'bamboo',
        distance: 4,
        position: { x: 4, y: 64, z: 2 }
      }
    ],
    nearbyEntities: [
      {
        id: 1,
        name: 'Alice',
        type: 'player',
        category: 'UNKNOWN',
        distance: 0,
        position: { x: 1, y: 64, z: 2 }
      },
      {
        id: 2,
        name: 'Steve',
        type: 'player',
        category: 'UNKNOWN',
        distance: 4.24,
        position: { x: 4, y: 64, z: 5 }
      },
      {
        id: 3,
        name: 'zombie',
        type: 'mob',
        category: 'Hostile mobs',
        distance: 6.25,
        position: { x: 6, y: 64, z: 3 }
      }
    ],
    inventory: [{ name: 'apple', count: 2 }],
    edibleItemCount: 2,
    craftableItems: [{
      item: 'oak_planks',
      maxCraftable: 8,
      requiresTable: false
    }],
    nearbyCraftingTable: false,
    equippedItem: null
  },
  state: {
    agentName: 'Alice',
    status: 'idle',
    currentAction: null,
    currentGoal: null,
    actionSource: null,
    busy: false
  },
  previousActionResult: null,
  recentDecisions: []
}

describe('buildBrainSemantics', () => {
  it('normalizes survival scales and separates self, players, and entities', () => {
    assert.deepEqual(buildBrainSemantics(input), {
      self: { username: 'Alice' },
      health: { current: 7.95, max: 20, status: 'low' },
      food: { current: 15, max: 20, status: 'healthy' },
      threats: {
        nearestHostile: { name: 'zombie', distance: 6.3 },
        nearestCreeper: null
      },
      inventory: {
        edibleItemCount: 2,
        hasFood: true,
        craftableItems: [{
          item: 'oak_planks',
          maxCraftable: 8,
          requiresTable: false
        }],
        nearbyCraftingTable: false,
        equippedItem: null
      },
      externalVisiblePlayers: [{ username: 'Steve', distance: 4.2 }],
      nearbyEntities: [{ name: 'zombie', type: 'mob', distance: 6.3 }]
    })
  })

  it('categorizes critical and healthy survival values deterministically', () => {
    const critical = buildBrainSemantics({
      ...input,
      perception: { ...input.perception, health: 5, food: 6 }
    })
    const healthy = buildBrainSemantics({
      ...input,
      perception: { ...input.perception, health: 20, food: 20 }
    })

    assert.equal(critical.health.status, 'critical')
    assert.equal(critical.food.status, 'critical')
    assert.equal(healthy.health.status, 'healthy')
    assert.equal(healthy.food.status, 'healthy')
  })

  it('serializes semantic state instead of ambiguous raw player entities', () => {
    const serialized = serializeBrainInput(input) as {
      perception: Record<string, unknown>
    }

    assert.deepEqual(serialized.perception.health, {
      current: 7.95,
      max: 20,
      status: 'low'
    })
    assert.deepEqual(serialized.perception.externalVisiblePlayers, [
      { username: 'Steve', distance: 4.2 }
    ])
    assert.deepEqual(serialized.perception.nearbyEntities, [
      { name: 'zombie', type: 'mob', distance: 6.3 }
    ])
    assert.deepEqual(serialized.perception.threats, {
      nearestHostile: { name: 'zombie', distance: 6.3 },
      nearestCreeper: null
    })
    assert.deepEqual(serialized.perception.inventory, {
      items: [{ name: 'apple', count: 2 }],
      edibleItemCount: 2,
      hasFood: true,
      craftableItems: [{
        item: 'oak_planks',
        maxCraftable: 8,
        requiresTable: false
      }],
      nearbyCraftingTable: false,
      equippedItem: null
    })
    assert.deepEqual(serialized.perception.self, { username: 'Alice' })
  })
})

describe('buildDecisionContext', () => {
  it('contains canonical visible players and deduplicated nearby blocks', () => {
    assert.deepEqual(buildDecisionContext(input), {
      selfUsername: 'Alice',
      visibleExternalPlayers: ['Steve'],
      visibleNearbyBlocks: ['grass_block', 'dirt', 'bamboo'],
      craftableItems: [{
        item: 'oak_planks',
        maxCraftable: 8,
        requiresTable: false
      }]
    })
  })
})
