import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type {
  EntityObservation,
  PerceptionSnapshot
} from '../perception/types.js'
import {
  CREEPER_EMERGENCY_DISTANCE,
  CRITICAL_FOOD_THRESHOLD,
  HOSTILE_EMERGENCY_DISTANCE,
  LOW_HEALTH_THRESHOLD,
  evaluateReflex
} from './evaluateReflex.js'

describe('evaluateReflex', () => {
  it('flees a close observed Creeper even when health is normal', () => {
    const result = evaluateReflex(snapshot({
      nearbyEntities: [hostile(7, 'creeper', 3.5)]
    }))

    assert.deepEqual(result, {
      action: 'flee_from_entity',
      entityId: 7,
      entityName: 'creeper',
      reason: 'Creeper at 3.5m.'
    })
    assert.equal(CREEPER_EMERGENCY_DISTANCE, 4)
  })

  it('does not flee a Creeper outside the emergency distance', () => {
    assert.equal(evaluateReflex(snapshot({
      nearbyEntities: [hostile(7, 'creeper', 4.1)]
    })), null)
  })

  it('flees a close hostile while health is low', () => {
    const result = evaluateReflex(snapshot({
      health: LOW_HEALTH_THRESHOLD,
      nearbyEntities: [hostile(9, 'zombie', 4)]
    }))

    assert.deepEqual(result, {
      action: 'flee_from_entity',
      entityId: 9,
      entityName: 'zombie',
      reason: 'Low health with zombie at 4m.'
    })
    assert.equal(HOSTILE_EMERGENCY_DISTANCE, 5)
  })

  it('does not flee a distant hostile or a close hostile at healthy health', () => {
    assert.equal(evaluateReflex(snapshot({
      health: LOW_HEALTH_THRESHOLD,
      nearbyEntities: [hostile(9, 'zombie', 5.1)]
    })), null)
    assert.equal(evaluateReflex(snapshot({
      health: LOW_HEALTH_THRESHOLD + 1,
      nearbyEntities: [hostile(9, 'zombie', 3)]
    })), null)
  })

  it('never treats a player or passive entity as a hostile target', () => {
    assert.equal(evaluateReflex(snapshot({
      health: 1,
      nearbyEntities: [
        entity(1, 'Alice', 'player', 0, 'UNKNOWN'),
        entity(2, 'Steve', 'player', 2, 'UNKNOWN'),
        entity(3, 'cow', 'mob', 2, 'Passive mobs')
      ]
    })), null)
  })

  it('eats at critical food only when safe edible inventory exists', () => {
    assert.deepEqual(evaluateReflex(snapshot({
      food: CRITICAL_FOOD_THRESHOLD,
      edibleItemCount: 2
    })), {
      action: 'eat',
      reason: 'Food is critically low.'
    })
    assert.equal(evaluateReflex(snapshot({
      food: CRITICAL_FOOD_THRESHOLD,
      edibleItemCount: 0
    })), null)
    assert.equal(evaluateReflex(snapshot({
      food: CRITICAL_FOOD_THRESHOLD + 1,
      edibleItemCount: 2
    })), null)
  })

  it('prioritizes an immediate threat over hunger', () => {
    assert.equal(evaluateReflex(snapshot({
      food: 1,
      edibleItemCount: 3,
      nearbyEntities: [hostile(7, 'creeper', 2)]
    }))?.action, 'flee_from_entity')
  })

  it('does not stop to eat while a close hostile applies pressure', () => {
    assert.equal(evaluateReflex(snapshot({
      health: LOW_HEALTH_THRESHOLD + 1,
      food: 1,
      edibleItemCount: 3,
      nearbyEntities: [hostile(9, 'zombie', 3)]
    })), null)
  })

  it('selects the nearest threat deterministically', () => {
    const result = evaluateReflex(snapshot({
      nearbyEntities: [
        hostile(9, 'creeper', 3),
        hostile(7, 'creeper', 2),
        hostile(5, 'creeper', 2)
      ]
    }))

    assert.equal(result?.action, 'flee_from_entity')
    if (result?.action === 'flee_from_entity') {
      assert.equal(result.entityId, 5)
    }
  })
})

function snapshot(
  overrides: Partial<PerceptionSnapshot> = {}
): PerceptionSnapshot {
  return {
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
    equippedItem: null,
    ...overrides
  }
}

function hostile(
  id: number,
  name: string,
  distance: number
): EntityObservation {
  return entity(id, name, 'mob', distance, 'Hostile mobs')
}

function entity(
  id: number,
  name: string,
  type: string,
  distance: number,
  category: string
): EntityObservation {
  return {
    id,
    name,
    type,
    category,
    distance,
    position: { x: distance, y: 64, z: 0 }
  }
}
