import { ShortTermGoalManager } from '../goals.js'
import type {
  AgentDecision,
  BrainInput,
  DecisionExecutionResult
} from '../types.js'
import type { BrainBenchmarkTransitionResult } from './run.js'

const position = { x: 0, y: 64, z: 0 }

export function createBootstrapBrainInput(): BrainInput {
  const perception: BrainInput['perception'] = {
    agent: 'Alice',
    timestamp: 0,
    position,
    health: 20,
    food: 20,
    nearbyBlocks: [],
    nearbyEntities: [],
    inventory: [{ name: 'oak_log', count: 3 }],
    edibleItemCount: 0,
    craftableItems: [{
      item: 'oak_planks',
      recipeOutput: 4,
      maxCraftable: 12,
      requiresTable: false
    }],
    nearbyCraftingTable: false,
    equippedItem: null,
    placeableBlocks: []
  }
  const snapshot = new ShortTermGoalManager().update(perception)

  return {
    perception,
    state: {
      agentName: 'Alice',
      status: 'idle',
      currentAction: null,
      currentGoal: null,
      actionSource: null,
      busy: false
    },
    previousActionResult: null,
    recentDecisions: [],
    shortTermGoal: snapshot.shortTermGoal,
    goalProgress: snapshot.goalProgress,
    availableCapabilities: snapshot.availableCapabilities
  }
}

export function simulateBootstrapDecision(
  input: BrainInput,
  decision: AgentDecision
): BrainBenchmarkTransitionResult {
  const inventory = new Map(
    input.perception.inventory.map(item => [item.name, item.count])
  )
  let nearbyCraftingTable = input.perception.nearbyCraftingTable

  if (decision.action === 'craft_item') {
    applyCraft(inventory, decision.item, decision.amount)
  } else if (
    decision.action === 'place_block' &&
    decision.block === 'crafting_table'
  ) {
    remove(inventory, 'crafting_table', 1)
    nearbyCraftingTable = true
  }

  const inventorySnapshot = [...inventory.entries()]
    .filter(([, count]) => count > 0)
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const perception: BrainInput['perception'] = {
    ...input.perception,
    timestamp: input.perception.timestamp + 1,
    inventory: inventorySnapshot,
    craftableItems: computeCraftableItems(
      inventory,
      nearbyCraftingTable
    ),
    nearbyCraftingTable,
    placeableBlocks: (inventory.get('crafting_table') ?? 0) > 0
      ? [{ name: 'crafting_table', count: inventory.get('crafting_table') ?? 0 }]
      : []
  }

  return {
    perception,
    result: simulatedResult(decision)
  }
}

function applyCraft(
  inventory: Map<string, number>,
  item: string,
  amount: number
): void {
  switch (item) {
    case 'oak_planks': {
      const applications = amount / 4
      remove(inventory, 'oak_log', applications)
      add(inventory, 'oak_planks', applications * 4)
      return
    }
    case 'stick': {
      const applications = amount / 4
      remove(inventory, 'oak_planks', applications * 2)
      add(inventory, 'stick', applications * 4)
      return
    }
    case 'crafting_table':
      remove(inventory, 'oak_planks', amount * 4)
      add(inventory, 'crafting_table', amount)
      return
    case 'wooden_pickaxe':
      remove(inventory, 'oak_planks', amount * 3)
      remove(inventory, 'stick', amount * 2)
      add(inventory, 'wooden_pickaxe', amount)
  }
}

function computeCraftableItems(
  inventory: Map<string, number>,
  nearbyCraftingTable: boolean
): BrainInput['perception']['craftableItems'] {
  const oakLogs = inventory.get('oak_log') ?? 0
  const planks = inventory.get('oak_planks') ?? 0
  const sticks = inventory.get('stick') ?? 0
  const craftable: BrainInput['perception']['craftableItems'] = []

  if (oakLogs > 0) {
    craftable.push({
      item: 'oak_planks',
      recipeOutput: 4,
      maxCraftable: oakLogs * 4,
      requiresTable: false
    })
  }
  if (planks >= 4) {
    craftable.push({
      item: 'crafting_table',
      recipeOutput: 1,
      maxCraftable: Math.floor(planks / 4),
      requiresTable: false
    })
  }
  if (planks >= 2) {
    craftable.push({
      item: 'stick',
      recipeOutput: 4,
      maxCraftable: Math.floor(planks / 2) * 4,
      requiresTable: false
    })
  }
  if (nearbyCraftingTable && planks >= 3 && sticks >= 2) {
    craftable.push({
      item: 'wooden_pickaxe',
      recipeOutput: 1,
      maxCraftable: Math.min(
        Math.floor(planks / 3),
        Math.floor(sticks / 2)
      ),
      requiresTable: true
    })
  }

  return craftable.sort((left, right) => left.item.localeCompare(right.item))
}

function add(inventory: Map<string, number>, item: string, count: number): void {
  inventory.set(item, (inventory.get(item) ?? 0) + count)
}

function remove(
  inventory: Map<string, number>,
  item: string,
  count: number
): void {
  inventory.set(item, Math.max(0, (inventory.get(item) ?? 0) - count))
}

function simulatedResult(decision: AgentDecision): DecisionExecutionResult {
  return {
    success: true,
    action: decision.action,
    status: 'completed',
    summary: 'Bootstrap benchmark simulated execution.'
  }
}
