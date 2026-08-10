import type { Bot } from 'mineflayer'
import { goals, Movements } from 'mineflayer-pathfinder'
import type { Block } from 'prismarine-block'
import type { Recipe } from 'prismarine-recipe'
import type { Item } from 'prismarine-item'

import {
  beginAgentAction,
  finishAgentAction,
  type AgentActionSource,
  type AgentState
} from '../agent/state.js'
import { isExpectedNavigationCancellation } from './movement.js'

export interface CraftableItemSnapshot {
  item: string
  maxCraftable: number
  requiresTable: boolean
}

export interface CraftingCapabilities {
  craftableItems: CraftableItemSnapshot[]
  nearbyCraftingTable: boolean
}

export type CraftFailureReason =
  | 'invalid_amount'
  | 'unknown_item'
  | 'recipe_unavailable'
  | 'insufficient_ingredients'
  | 'crafting_table_unavailable'
  | 'goal_replaced'
  | 'navigation_failed'
  | 'action_cancelled'
  | 'craft_failed'
  | 'inventory_changed'
  | 'output_not_confirmed'

export interface CraftResult {
  success: boolean
  action: 'craft_item'
  target: string
  requested: number
  crafted: number
  status: 'completed' | 'cancelled' | 'failed'
  reason?: CraftFailureReason
  error?: string
}

export interface CraftNavigator {
  prepare(bot: Bot): void
  goto(bot: Bot, table: Block): Promise<void>
}

interface InventoryCountItem {
  type: number
  metadata: number
  count: number
}

export type CraftSkill = (
  bot: Bot,
  state: AgentState,
  itemName: string,
  amount: number,
  source?: AgentActionSource
) => Promise<CraftResult>

const DEFAULT_CRAFTING_TABLE_RADIUS = 16
const MAX_CRAFT_CONFIRMATION_TICKS = 10

const defaultNavigator: CraftNavigator = {
  prepare(bot) {
    bot.pathfinder.setMovements(new Movements(bot))
  },
  async goto(bot, table) {
    await bot.pathfinder.goto(new goals.GoalNear(
      table.position.x,
      table.position.y,
      table.position.z,
      2
    ))
  }
}

export function inspectCraftingCapabilities(
  bot: Bot,
  radius = DEFAULT_CRAFTING_TABLE_RADIUS,
  inventoryItems: readonly Item[] = bot.inventory.items()
): CraftingCapabilities {
  const craftingTable = findNearbyCraftingTable(bot, radius)
  const recipeAccess = craftingTable ?? false
  const craftableItems: CraftableItemSnapshot[] = []

  for (const item of Object.values(bot.registry.itemsByName)) {
    const recipes = bot.recipesFor(item.id, null, 1, recipeAccess)
    let best: CraftableItemSnapshot | null = null

    for (const recipe of recipes) {
      const maxCraftable = maximumCraftableOutput(inventoryItems, recipe)
      if (maxCraftable < 1) continue

      const candidate = {
        item: item.name,
        maxCraftable,
        requiresTable: recipe.requiresTable
      }
      if (
        !best ||
        candidate.maxCraftable > best.maxCraftable ||
        (
          candidate.maxCraftable === best.maxCraftable &&
          !candidate.requiresTable && best.requiresTable
        )
      ) {
        best = candidate
      }
    }

    if (best) craftableItems.push(best)
  }

  craftableItems.sort((left, right) => left.item.localeCompare(right.item))

  return {
    craftableItems,
    nearbyCraftingTable: craftingTable !== null
  }
}

export const craftItem: CraftSkill = createCraftingSkill(defaultNavigator)

export function createCraftingSkill(navigator: CraftNavigator): CraftSkill {
  return (bot, state, itemName, amount, source = 'manual') => craftItemWith(
    navigator,
    bot,
    state,
    itemName,
    amount,
    source
  )
}

async function craftItemWith(
  navigator: CraftNavigator,
  bot: Bot,
  state: AgentState,
  itemName: string,
  amount: number,
  source: AgentActionSource
): Promise<CraftResult> {
  if (!Number.isInteger(amount) || amount < 1 || amount > 64) {
    return failedResult(itemName, amount, 'invalid_amount')
  }

  const registryItem = Object.hasOwn(bot.registry.itemsByName, itemName)
    ? bot.registry.itemsByName[itemName]
    : undefined
  if (!registryItem) {
    return failedResult(itemName, amount, 'unknown_item')
  }

  const allRecipes = bot.recipesAll(registryItem.id, null, true)
  if (allRecipes.length === 0) {
    return failedResult(itemName, amount, 'recipe_unavailable')
  }

  let craftingTable = findNearbyCraftingTable(
    bot,
    DEFAULT_CRAFTING_TABLE_RADIUS
  )
  let recipe = selectRecipe(
    bot,
    registryItem.id,
    amount,
    craftingTable ?? false
  )

  if (!recipe) {
    const tableRecipeAvailable = bot
      .recipesFor(registryItem.id, null, amount, true)
      .some(candidate => candidate.requiresTable)

    return failedResult(
      itemName,
      amount,
      tableRecipeAvailable && !craftingTable
        ? 'crafting_table_unavailable'
        : 'insufficient_ingredients'
    )
  }

  const actionVersion = beginAgentAction(
    state,
    'crafting',
    'craft_item',
    `Craft ${amount} ${itemName}`,
    source
  )

  try {
    if (recipe.requiresTable) {
      if (!craftingTable) {
        return failedResult(itemName, amount, 'crafting_table_unavailable')
      }

      try {
        navigator.prepare(bot)
        await navigator.goto(bot, craftingTable)
      } catch (error) {
        return navigationFailure(itemName, amount, error)
      }

      if (state.actionVersion !== actionVersion) {
        return failedResult(itemName, amount, 'action_cancelled', {
          status: 'cancelled'
        })
      }

      const liveTable = bot.blockAt(craftingTable.position)
      if (!liveTable || liveTable.name !== 'crafting_table') {
        return failedResult(itemName, amount, 'crafting_table_unavailable')
      }
      craftingTable = liveTable
      recipe = selectRecipe(bot, registryItem.id, amount, craftingTable)
      if (!recipe) {
        return failedResult(itemName, amount, 'insufficient_ingredients')
      }
    }

    if (state.actionVersion !== actionVersion) {
      return failedResult(itemName, amount, 'action_cancelled', {
        status: 'cancelled'
      })
    }

    const applications = Math.ceil(amount / recipe.result.count)
    const inventoryBeforeCraft = snapshotInventoryCounts(bot.inventory.items())
    const initialCount = countItemStacks(
      inventoryBeforeCraft,
      registryItem.id,
      null
    )
    try {
      await bot.craft(
        recipe,
        applications,
        recipe.requiresTable ? craftingTable ?? undefined : undefined
      )
    } catch (error) {
      return failedResult(itemName, amount, 'craft_failed', {
        error: formatError(error)
      })
    }

    let inventoryAfterCraft = snapshotInventoryCounts(bot.inventory.items())
    for (let tick = 0; tick < MAX_CRAFT_CONFIRMATION_TICKS; tick += 1) {
      await bot.waitForTicks(1)
      inventoryAfterCraft = snapshotInventoryCounts(bot.inventory.items())
      if (matchesRecipeDelta(
        inventoryBeforeCraft,
        inventoryAfterCraft,
        recipe,
        applications
      )) break

      if (state.actionVersion !== actionVersion) break
    }
    const crafted = Math.max(
      0,
      countItemStacks(inventoryAfterCraft, registryItem.id, null) - initialCount
    )

    if (state.actionVersion !== actionVersion) {
      return failedResult(itemName, amount, 'action_cancelled', {
        status: 'cancelled',
        crafted
      })
    }

    if (crafted < amount) {
      return failedResult(itemName, amount, 'output_not_confirmed', { crafted })
    }

    if (!matchesRecipeDelta(
      inventoryBeforeCraft,
      inventoryAfterCraft,
      recipe,
      applications
    )) {
      return failedResult(itemName, amount, 'inventory_changed', { crafted })
    }

    return {
      success: true,
      action: 'craft_item',
      target: itemName,
      requested: amount,
      crafted,
      status: 'completed'
    }
  } finally {
    finishAgentAction(state, actionVersion)
  }
}

export function findNearbyCraftingTable(
  bot: Bot,
  radius = DEFAULT_CRAFTING_TABLE_RADIUS
): Block | null {
  return bot.findBlock({
    matching: block => block.name === 'crafting_table',
    maxDistance: radius
  })
}

function selectRecipe(
  bot: Bot,
  itemType: number,
  amount: number,
  craftingTable: Block | boolean
): Recipe | null {
  return [...bot.recipesFor(itemType, null, amount, craftingTable)]
    .sort((left, right) => (
      Number(left.requiresTable) - Number(right.requiresTable) ||
      right.result.count - left.result.count
    ))[0] ?? null
}

function maximumCraftableOutput(
  inventoryItems: readonly Item[],
  recipe: Recipe
): number {
  const ingredientDeltas = recipe.delta.filter(delta => delta.count < 0)
  if (ingredientDeltas.length === 0 || recipe.result.count < 1) return 0

  const applications = Math.min(...ingredientDeltas.map(delta => Math.floor(
    countItemStacks(inventoryItems, delta.id, delta.metadata) / -delta.count
  )))

  return applications * recipe.result.count
}

function countItemStacks(
  inventoryItems: readonly InventoryCountItem[],
  itemType: number,
  metadata: number | null
): number {
  return inventoryItems
    .filter(item => (
      item.type === itemType &&
      (metadata === null || item.metadata === metadata)
    ))
    .reduce((total, item) => total + item.count, 0)
}

function snapshotInventoryCounts(
  inventoryItems: readonly Item[]
): InventoryCountItem[] {
  return inventoryItems.map(item => ({
    type: item.type,
    metadata: item.metadata,
    count: item.count
  }))
}

function matchesRecipeDelta(
  before: readonly InventoryCountItem[],
  after: readonly InventoryCountItem[],
  recipe: Recipe,
  applications: number
): boolean {
  return recipe.delta.every(delta => {
    const actualDelta = countItemStacks(after, delta.id, delta.metadata) -
      countItemStacks(before, delta.id, delta.metadata)

    return actualDelta === delta.count * applications
  })
}

function navigationFailure(
  target: string,
  requested: number,
  error: unknown
): CraftResult {
  if (isExpectedNavigationCancellation(error)) {
    return failedResult(target, requested, 'goal_replaced', {
      status: 'cancelled'
    })
  }

  return failedResult(target, requested, 'navigation_failed', {
    error: formatError(error)
  })
}

function failedResult(
  target: string,
  requested: number,
  reason: CraftFailureReason,
  details: Partial<CraftResult> = {}
): CraftResult {
  return {
    success: false,
    action: 'craft_item',
    target,
    requested,
    crafted: 0,
    status: 'failed',
    reason,
    ...details
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
