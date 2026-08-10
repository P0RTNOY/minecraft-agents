import type { PerceptionSnapshot } from '../perception/types.js'
import { evaluateReflex } from '../survival/evaluateReflex.js'

export type ShortTermGoalType =
  | 'establish_basic_resources'
  | 'improve_tooling'
  | 'improve_safety'
  | 'explore_for_resources'

export type ShortTermGoalStatus = 'active' | 'completed' | 'abandoned'

export interface ShortTermGoal {
  id: string
  type: ShortTermGoalType
  description: string
  status: ShortTermGoalStatus
}

export interface GoalProgress {
  goalType: ShortTermGoalType
  hasWood: boolean
  hasPlanks: boolean
  hasSticks: boolean
  hasCraftingTableItem: boolean
  hasCraftingAccess: boolean
  hasBasicTool: boolean
  hasImprovedTool: boolean
  hasSafeFood: boolean
  survivalReady: boolean
  usefulResourcesNearby: boolean
  completed: boolean
}

export interface AvailableCapabilities {
  observedCollectableBlocks: string[]
  craftableItems: PerceptionSnapshot['craftableItems']
  placeableBlocks: PerceptionSnapshot['placeableBlocks']
  canExplore: true
}

export interface GoalTransition {
  completedGoal?: ShortTermGoal
  abandonedGoal?: ShortTermGoal
  nextGoal: ShortTermGoal | null
}

export interface GoalRuntimeSnapshot {
  shortTermGoal: ShortTermGoal | null
  goalProgress: GoalProgress | null
  availableCapabilities: AvailableCapabilities
  transition: GoalTransition | null
}

const GOAL_DESCRIPTIONS: Record<ShortTermGoalType, string> = {
  establish_basic_resources: 'Establish basic crafting capability.',
  improve_tooling: 'Improve available tools for useful work.',
  improve_safety: 'Improve immediate survival readiness.',
  explore_for_resources: 'Find useful resources for further progress.'
}

const WOOD_ITEMS = new Set([
  'acacia_log',
  'acacia_wood',
  'bamboo_block',
  'birch_log',
  'birch_wood',
  'cherry_log',
  'cherry_wood',
  'crimson_hyphae',
  'crimson_stem',
  'dark_oak_log',
  'dark_oak_wood',
  'jungle_log',
  'jungle_wood',
  'mangrove_log',
  'mangrove_wood',
  'oak_log',
  'oak_wood',
  'pale_oak_log',
  'pale_oak_wood',
  'spruce_log',
  'spruce_wood',
  'warped_hyphae',
  'warped_stem'
])

const BASIC_TOOLS = new Set([
  'diamond_axe',
  'diamond_hoe',
  'diamond_pickaxe',
  'diamond_shovel',
  'golden_axe',
  'golden_hoe',
  'golden_pickaxe',
  'golden_shovel',
  'iron_axe',
  'iron_hoe',
  'iron_pickaxe',
  'iron_shovel',
  'netherite_axe',
  'netherite_hoe',
  'netherite_pickaxe',
  'netherite_shovel',
  'stone_axe',
  'stone_hoe',
  'stone_pickaxe',
  'stone_shovel',
  'wooden_axe',
  'wooden_hoe',
  'wooden_pickaxe',
  'wooden_shovel'
])

const IMPROVED_TOOLS = new Set(
  [...BASIC_TOOLS].filter(name => !name.startsWith('wooden_'))
)

const IMPROVEMENT_RESOURCES = new Set([
  'cobblestone',
  'cobbled_deepslate',
  'diamond',
  'diamond_ore',
  'deepslate_diamond_ore',
  'deepslate_iron_ore',
  'iron_ingot',
  'iron_ore',
  'stone'
])

export function computeGoalProgress(
  perception: PerceptionSnapshot,
  goalType: ShortTermGoalType
): GoalProgress {
  const inventoryNames = positiveInventoryNames(perception.inventory)
  const nearbyNames = new Set(perception.nearbyBlocks.map(block => block.name))
  const hasWood = intersects(inventoryNames, WOOD_ITEMS)
  const hasPlanks = [...inventoryNames].some(name => name.endsWith('_planks'))
  const hasSticks = inventoryNames.has('stick')
  const hasCraftingTableItem = inventoryNames.has('crafting_table')
  const hasCraftingAccess = perception.nearbyCraftingTable
  const hasBasicTool = intersects(inventoryNames, BASIC_TOOLS)
  const hasImprovedTool = intersects(inventoryNames, IMPROVED_TOOLS)
  const hasSafeFood = perception.edibleItemCount > 0
  const survivalReady = perception.health >= 12 && perception.food >= 12
  const usefulResourcesNearby = [...nearbyNames].some(isUsefulResource)

  return {
    goalType,
    hasWood,
    hasPlanks,
    hasSticks,
    hasCraftingTableItem,
    hasCraftingAccess,
    hasBasicTool,
    hasImprovedTool,
    hasSafeFood,
    survivalReady,
    usefulResourcesNearby,
    completed: isGoalComplete(goalType, {
      hasWood,
      hasCraftingAccess,
      hasBasicTool,
      hasImprovedTool,
      survivalReady,
      usefulResourcesNearby
    })
  }
}

export function buildAvailableCapabilities(
  perception: PerceptionSnapshot
): AvailableCapabilities {
  return {
    observedCollectableBlocks: [...new Set(
      perception.nearbyBlocks.map(block => block.name)
    )].sort(),
    craftableItems: perception.craftableItems
      .filter(item => item.maxCraftable > 0)
      .map(item => ({ ...item }))
      .sort((left, right) => left.item.localeCompare(right.item)),
    placeableBlocks: perception.placeableBlocks
      .filter(item => item.count > 0)
      .map(item => ({ ...item }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    canExplore: true
  }
}

export class ShortTermGoalManager {
  private activeGoal: ShortTermGoal | null = null
  private nextId = 1

  update(perception: PerceptionSnapshot): GoalRuntimeSnapshot {
    const availableCapabilities = buildAvailableCapabilities(perception)

    if (evaluateReflex(perception)) {
      return {
        shortTermGoal: null,
        goalProgress: null,
        availableCapabilities,
        transition: null
      }
    }

    let completedGoal: ShortTermGoal | null = null
    let abandonedGoal: ShortTermGoal | null = null
    const safetyNeeded = perception.health < 12 || perception.food < 12

    if (
      this.activeGoal &&
      safetyNeeded &&
      this.activeGoal.type !== 'improve_safety'
    ) {
      abandonedGoal = { ...this.activeGoal, status: 'abandoned' }
      this.activeGoal = null
    } else if (this.activeGoal) {
      const currentProgress = computeGoalProgress(
        perception,
        this.activeGoal.type
      )
      if (!currentProgress.completed) {
        return {
          shortTermGoal: this.activeGoal,
          goalProgress: currentProgress,
          availableCapabilities,
          transition: null
        }
      }

      completedGoal = { ...this.activeGoal, status: 'completed' }
      this.activeGoal = null
    }

    const nextType = selectGoalType(perception)
    if (nextType) {
      this.activeGoal = {
        id: `goal-${this.nextId}`,
        type: nextType,
        description: GOAL_DESCRIPTIONS[nextType],
        status: 'active'
      }
      this.nextId += 1
    }

    const goalProgress = this.activeGoal
      ? computeGoalProgress(perception, this.activeGoal.type)
      : null

    return {
      shortTermGoal: this.activeGoal,
      goalProgress,
      availableCapabilities,
      transition: completedGoal
        ? { completedGoal, nextGoal: this.activeGoal }
        : abandonedGoal
          ? { abandonedGoal, nextGoal: this.activeGoal }
          : null
    }
  }
}

function selectGoalType(
  perception: PerceptionSnapshot
): ShortTermGoalType | null {
  if (perception.health < 12 || perception.food < 12) {
    return 'improve_safety'
  }

  const bootstrap = computeGoalProgress(
    perception,
    'establish_basic_resources'
  )
  if (!bootstrap.completed) {
    return bootstrap.hasWood ||
      bootstrap.hasPlanks ||
      bootstrap.hasCraftingTableItem ||
      bootstrap.usefulResourcesNearby
      ? 'establish_basic_resources'
      : 'explore_for_resources'
  }

  if (bootstrap.hasImprovedTool) return null

  const inventoryNames = positiveInventoryNames(perception.inventory)
  const canImprove = intersects(inventoryNames, IMPROVEMENT_RESOURCES) ||
    perception.nearbyBlocks.some(block => (
      IMPROVEMENT_RESOURCES.has(block.name)
    )) ||
    perception.craftableItems.some(item => IMPROVED_TOOLS.has(item.item))

  return canImprove ? 'improve_tooling' : 'explore_for_resources'
}

function isGoalComplete(
  goalType: ShortTermGoalType,
  facts: {
    hasWood: boolean
    hasCraftingAccess: boolean
    hasBasicTool: boolean
    hasImprovedTool: boolean
    survivalReady: boolean
    usefulResourcesNearby: boolean
  }
): boolean {
  switch (goalType) {
    case 'establish_basic_resources':
      return facts.hasCraftingAccess && facts.hasBasicTool
    case 'improve_tooling':
      return facts.hasImprovedTool
    case 'improve_safety':
      return facts.survivalReady
    case 'explore_for_resources':
      return facts.hasWood || facts.usefulResourcesNearby
  }
}

function positiveInventoryNames(
  inventory: PerceptionSnapshot['inventory']
): Set<string> {
  return new Set(
    inventory.filter(item => item.count > 0).map(item => item.name)
  )
}

function isUsefulResource(name: string): boolean {
  return WOOD_ITEMS.has(name) || IMPROVEMENT_RESOURCES.has(name)
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  return [...left].some(value => right.has(value))
}
