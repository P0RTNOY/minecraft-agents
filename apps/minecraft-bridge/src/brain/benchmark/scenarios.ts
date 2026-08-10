import type { BrainInput, DecisionExecutionResult } from '../types.js'
import type { BrainBenchmarkScenario } from './run.js'
import { ShortTermGoalManager } from '../goals.js'

const position = { x: 0, y: 64, z: 0 }

export const BRAIN_BENCHMARK_SCENARIOS: readonly BrainBenchmarkScenario[] = [
  scenario('healthy_safe_resources', 'Healthy and safe with basic resources.', {
    nearbyBlocks: [block('oak_log', 3)],
    inventory: [{ name: 'apple', count: 2 }],
    edibleItemCount: 2
  }),
  scenario('low_health', 'Health is low on the Minecraft 0-20 scale.', {
    health: 7,
    food: 14
  }),
  scenario('nearby_hostile', 'A hostile zombie is nearby.', {
    nearbyEntities: [entity(1, 'zombie', 'mob', 5, 'Hostile mobs')]
  }),
  scenario('nearby_external_player', 'An external player is visible.', {
    nearbyEntities: [entity(2, 'Steve', 'player', 4, 'UNKNOWN')]
  }),
  scenario('no_nearby_player', 'No external player is visible.', {
    nearbyEntities: [entity(3, 'cow', 'mob', 6, 'Passive mobs')]
  }),
  scenario('useful_blocks_nearby', 'Several useful blocks are nearby.', {
    nearbyBlocks: [
      block('oak_log', 2),
      block('coal_ore', 6),
      block('cobblestone', 4)
    ]
  }),
  scenario('craftable_planks', 'A log can currently be crafted into planks.', {
    inventory: [{ name: 'oak_log', count: 1 }],
    craftableItems: [{
      item: 'oak_planks',
      maxCraftable: 4,
      requiresTable: false
    }]
  }),
  scenario('craftable_table', 'Inventory planks can currently form a crafting table.', {
    inventory: [{ name: 'oak_planks', count: 4 }],
    craftableItems: [{
      item: 'crafting_table',
      maxCraftable: 1,
      requiresTable: false
    }]
  }),
  scenario('table_recipe_available', 'A nearby table enables a table recipe.', {
    inventory: [
      { name: 'oak_planks', count: 3 },
      { name: 'stick', count: 2 }
    ],
    craftableItems: [{
      item: 'wooden_pickaxe',
      maxCraftable: 1,
      requiresTable: true
    }],
    nearbyCraftingTable: true
  }),
  scenario('safe_exploration', 'No useful resource or player is currently visible.', {}),
  scenario('previous_say', 'The previous action sent a chat message.', {
    previousActionResult: previousResult('say')
  }),
  {
    ...scenario('repeated_idle', 'The same unchanged state is sampled three times.', {
      previousActionResult: previousResult('idle')
    }),
    samples: 3
  },
  scenario('self_only_player_identity', 'Alice is the only player-like identity.', {
    nearbyEntities: [entity(4, 'Alice', 'player', 0, 'UNKNOWN')]
  })
]

interface ScenarioOverrides {
  health?: number
  food?: number
  nearbyBlocks?: BrainInput['perception']['nearbyBlocks']
  nearbyEntities?: BrainInput['perception']['nearbyEntities']
  inventory?: BrainInput['perception']['inventory']
  edibleItemCount?: number
  craftableItems?: BrainInput['perception']['craftableItems']
  nearbyCraftingTable?: boolean
  previousActionResult?: DecisionExecutionResult
}

function scenario(
  id: string,
  description: string,
  overrides: ScenarioOverrides
) {
  const perception: BrainInput['perception'] = {
    agent: 'Alice',
    timestamp: 0,
    position,
    health: overrides.health ?? 20,
    food: overrides.food ?? 20,
    nearbyBlocks: overrides.nearbyBlocks ?? [],
    nearbyEntities: overrides.nearbyEntities ?? [],
    inventory: overrides.inventory ?? [],
    edibleItemCount: overrides.edibleItemCount ?? 0,
    craftableItems: overrides.craftableItems ?? [],
    nearbyCraftingTable: overrides.nearbyCraftingTable ?? false,
    equippedItem: null,
    placeableBlocks: []
  }
  const goalSnapshot = new ShortTermGoalManager().update(perception)

  return {
    id,
    description,
    input: {
      perception,
      state: {
        agentName: 'Alice',
        status: 'idle',
        currentAction: null,
        currentGoal: null,
        actionSource: null,
        busy: false
      },
      previousActionResult: overrides.previousActionResult ?? null,
      recentDecisions: [],
      shortTermGoal: goalSnapshot.shortTermGoal,
      goalProgress: goalSnapshot.goalProgress,
      availableCapabilities: goalSnapshot.availableCapabilities
    } satisfies BrainInput
  }
}

function block(name: string, distance: number) {
  return { name, distance, position }
}

function entity(
  id: number,
  name: string,
  type: string,
  distance: number,
  category: string
) {
  return { id, name, type, category, distance, position }
}

function previousResult(
  action: DecisionExecutionResult['action']
): DecisionExecutionResult {
  return {
    success: true,
    action,
    status: 'completed',
    summary: `Previous ${action} completed.`
  }
}
