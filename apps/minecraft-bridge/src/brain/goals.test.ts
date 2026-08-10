import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ShortTermGoalManager,
  buildAvailableCapabilities,
  computeGoalProgress
} from './goals.js'
import type { PerceptionSnapshot } from '../perception/types.js'

describe('goal progress', () => {
  it('computes bootstrap facts from canonical inventory and world semantics', () => {
    const perception = snapshot({
      inventory: [
        { name: 'oak_log', count: 1 },
        { name: 'oak_planks', count: 4 },
        { name: 'crafting_table', count: 1 },
        { name: 'wooden_pickaxe', count: 1 }
      ],
      nearbyCraftingTable: true,
      edibleItemCount: 2
    })

    assert.deepEqual(
      computeGoalProgress(perception, 'establish_basic_resources'),
      {
        goalType: 'establish_basic_resources',
        hasWood: true,
        hasPlanks: true,
        hasSticks: false,
        hasCraftingTableItem: true,
        hasCraftingAccess: true,
        hasBasicTool: true,
        hasImprovedTool: false,
        hasSafeFood: true,
        survivalReady: true,
        usefulResourcesNearby: false,
        completed: true
      }
    )
  })

  it('changes deterministically when simulated world state changes', () => {
    const before = snapshot({
      inventory: [{ name: 'oak_log', count: 1 }],
      craftableItems: [{
        item: 'oak_planks',
        recipeOutput: 4,
        maxCraftable: 4,
        requiresTable: false
      }]
    })
    const after = snapshot({
      inventory: [{ name: 'oak_planks', count: 4 }],
      craftableItems: [{
        item: 'crafting_table',
        recipeOutput: 1,
        maxCraftable: 1,
        requiresTable: false
      }]
    })

    assert.equal(
      computeGoalProgress(before, 'establish_basic_resources').hasWood,
      true
    )
    assert.equal(
      computeGoalProgress(before, 'establish_basic_resources').hasPlanks,
      false
    )
    assert.equal(
      computeGoalProgress(after, 'establish_basic_resources').hasPlanks,
      true
    )
  })

  it('exposes only exact current grounded capabilities', () => {
    const perception = snapshot({
      nearbyBlocks: [
        block('oak_log', 3),
        block('dirt', 1),
        block('oak_log', 5)
      ],
      craftableItems: [{
        item: 'oak_planks',
        recipeOutput: 4,
        maxCraftable: 4,
        requiresTable: false
      }],
      placeableBlocks: [{ name: 'crafting_table', count: 1 }]
    })

    assert.deepEqual(buildAvailableCapabilities(perception), {
      observedCollectableBlocks: ['dirt', 'oak_log'],
      craftableItems: [{
        item: 'oak_planks',
        recipeOutput: 4,
        maxCraftable: 4,
        requiresTable: false
      }],
      placeableBlocks: [{ name: 'crafting_table', count: 1 }],
      canExplore: true
    })
  })
})

describe('ShortTermGoalManager', () => {
  it('selects exploration without useful resources and bootstrap with wood', () => {
    const exploring = new ShortTermGoalManager().update(snapshot())
    const bootstrapping = new ShortTermGoalManager().update(snapshot({
      nearbyBlocks: [block('oak_log', 3)]
    }))

    assert.equal(exploring.shortTermGoal?.type, 'explore_for_resources')
    assert.equal(bootstrapping.shortTermGoal?.type, 'establish_basic_resources')
  })

  it('completes a goal from world facts and transitions to the next goal', () => {
    const manager = new ShortTermGoalManager()
    const started = manager.update(snapshot({
      inventory: [{ name: 'oak_log', count: 1 }]
    }))
    const transitioned = manager.update(snapshot({
      inventory: [{ name: 'wooden_pickaxe', count: 1 }],
      nearbyCraftingTable: true
    }))

    assert.equal(started.shortTermGoal?.type, 'establish_basic_resources')
    assert.deepEqual(transitioned.transition, {
      completedGoal: {
        ...started.shortTermGoal,
        status: 'completed'
      },
      nextGoal: transitioned.shortTermGoal
    })
    assert.equal(transitioned.shortTermGoal?.type, 'explore_for_resources')
    assert.notEqual(
      transitioned.shortTermGoal?.id,
      started.shortTermGoal?.id
    )
  })

  it('transitions from exploration when useful resources become available', () => {
    const manager = new ShortTermGoalManager()
    const exploring = manager.update(snapshot())
    const resourceFound = manager.update(snapshot({
      nearbyBlocks: [block('oak_log', 2)]
    }))
    const completedGoal = resourceFound.transition?.completedGoal

    assert.equal(exploring.shortTermGoal?.type, 'explore_for_resources')
    assert.ok(completedGoal)
    assert.equal(completedGoal.status, 'completed')
    assert.equal(resourceFound.shortTermGoal?.type, 'establish_basic_resources')
  })

  it('suppresses advisory goals during an immediate survival emergency', () => {
    const manager = new ShortTermGoalManager()
    const safe = manager.update(snapshot({
      inventory: [{ name: 'oak_log', count: 1 }]
    }))
    const emergency = manager.update(snapshot({
      inventory: [{ name: 'oak_log', count: 1 }],
      nearbyEntities: [{
        id: 7,
        name: 'creeper',
        type: 'mob',
        category: 'Hostile mobs',
        distance: 3,
        position: { x: 3, y: 64, z: 0 }
      }]
    }))
    const safeAgain = manager.update(snapshot({
      inventory: [{ name: 'oak_log', count: 1 }]
    }))

    assert.equal(emergency.shortTermGoal, null)
    assert.equal(emergency.goalProgress, null)
    assert.equal(safeAgain.shortTermGoal?.id, safe.shortTermGoal?.id)
  })

  it('abandons a lower-priority goal when non-urgent safety declines', () => {
    const manager = new ShortTermGoalManager()
    const exploring = manager.update(snapshot())
    const safety = manager.update(snapshot({ health: 9 }))

    assert.equal(exploring.shortTermGoal?.type, 'explore_for_resources')
    assert.deepEqual(safety.transition, {
      abandonedGoal: {
        ...exploring.shortTermGoal,
        status: 'abandoned'
      },
      nextGoal: safety.shortTermGoal
    })
    assert.equal(safety.shortTermGoal?.type, 'improve_safety')
  })

  it('keeps stable process-local ids and resets ids in a new manager', () => {
    const firstManager = new ShortTermGoalManager()
    const first = firstManager.update(snapshot())
    const unchanged = firstManager.update(snapshot())
    const anotherProcess = new ShortTermGoalManager().update(snapshot())

    assert.equal(first.shortTermGoal?.id, 'goal-1')
    assert.equal(unchanged.shortTermGoal?.id, 'goal-1')
    assert.equal(anotherProcess.shortTermGoal?.id, 'goal-1')
  })
})

interface SnapshotOverrides {
  health?: number
  food?: number
  nearbyBlocks?: PerceptionSnapshot['nearbyBlocks']
  nearbyEntities?: PerceptionSnapshot['nearbyEntities']
  inventory?: PerceptionSnapshot['inventory']
  edibleItemCount?: number
  craftableItems?: PerceptionSnapshot['craftableItems']
  nearbyCraftingTable?: boolean
  placeableBlocks?: PerceptionSnapshot['placeableBlocks']
}

function snapshot(overrides: SnapshotOverrides = {}): PerceptionSnapshot {
  return {
    agent: 'Alice',
    timestamp: 1,
    position: { x: 0, y: 64, z: 0 },
    health: overrides.health ?? 20,
    food: overrides.food ?? 20,
    nearbyBlocks: overrides.nearbyBlocks ?? [],
    nearbyEntities: overrides.nearbyEntities ?? [],
    inventory: overrides.inventory ?? [],
    edibleItemCount: overrides.edibleItemCount ?? 0,
    craftableItems: overrides.craftableItems ?? [],
    nearbyCraftingTable: overrides.nearbyCraftingTable ?? false,
    equippedItem: null,
    placeableBlocks: overrides.placeableBlocks ?? []
  }
}

function block(name: string, distance: number) {
  return {
    name,
    distance,
    position: { x: distance, y: 64, z: 0 }
  }
}
