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
  recipeOutput: number
  maxCraftable: number
  requiresTable: boolean
}

export interface CraftingCapabilities {
  craftableItems: CraftableItemSnapshot[]
  nearbyCraftingTable: boolean
}

export type CraftFailureReason =
  | 'invalid_amount'
  | 'invalid_output_amount'
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
  recipeOutput: number | null
  executionCount: number
  retryCount: 0 | 1
  retryResult: 'not_needed' | 'succeeded' | 'failed'
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
        recipeOutput: recipe.result.count,
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

  if (!isOutputAmountAligned(amount, recipe)) {
    return failedResult(itemName, amount, 'invalid_output_amount', {
      recipeOutput: recipe.result.count
    })
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
      if (!isOutputAmountAligned(amount, recipe)) {
        return failedResult(itemName, amount, 'invalid_output_amount', {
          recipeOutput: recipe.result.count
        })
      }
    }

    if (state.actionVersion !== actionVersion) {
      return failedResult(itemName, amount, 'action_cancelled', {
        status: 'cancelled'
      })
    }

    const applications = amount / recipe.result.count
    const inventoryBeforeCraft = snapshotInventoryCounts(bot.inventory.items())
    const initialCount = countItemStacks(
      inventoryBeforeCraft,
      registryItem.id,
      null
    )
    const firstAttempt = await performCraftAttempt(
      bot,
      state,
      actionVersion,
      recipe,
      applications,
      recipe.requiresTable ? craftingTable ?? undefined : undefined,
      inventoryBeforeCraft,
      registryItem.id,
      initialCount
    )
    const baseDetails: Partial<CraftResult> = {
      recipeOutput: recipe.result.count,
      executionCount: applications
    }

    if (firstAttempt.success) {
      return completedResult(itemName, amount, firstAttempt.crafted, baseDetails)
    }
    if (firstAttempt.reason === 'action_cancelled') {
      return failedResult(itemName, amount, firstAttempt.reason, {
        ...baseDetails,
        status: 'cancelled',
        crafted: firstAttempt.crafted
      })
    }

    const retryable = recipe.requiresTable && firstAttempt.inventoryUnchanged && (
      firstAttempt.reason === 'output_not_confirmed' ||
      (
        firstAttempt.reason === 'craft_failed' &&
        firstAttempt.transientTableSyncFailure
      )
    )
    if (!retryable) {
      return failedResult(itemName, amount, firstAttempt.reason, {
        ...baseDetails,
        crafted: firstAttempt.crafted,
        ...(firstAttempt.error ? { error: firstAttempt.error } : {})
      })
    }

    if (state.actionVersion !== actionVersion) {
      return failedResult(itemName, amount, 'action_cancelled', {
        ...baseDetails,
        status: 'cancelled'
      })
    }

    const refreshedTable = reacquireCraftingTable(bot)
    if (!refreshedTable) {
      return failedResult(itemName, amount, 'crafting_table_unavailable', baseDetails)
    }
    const retryRecipe = selectRecipe(
      bot,
      registryItem.id,
      amount,
      refreshedTable
    )
    if (!retryRecipe) {
      return failedResult(itemName, amount, 'insufficient_ingredients', baseDetails)
    }
    if (!isOutputAmountAligned(amount, retryRecipe)) {
      return failedResult(itemName, amount, 'invalid_output_amount', {
        recipeOutput: retryRecipe.result.count
      })
    }

    const inventoryBeforeRetry = snapshotInventoryCounts(bot.inventory.items())
    if (!inventoryCountsEqual(inventoryBeforeCraft, inventoryBeforeRetry)) {
      return failedResult(itemName, amount, 'inventory_changed', baseDetails)
    }

    const retryApplications = amount / retryRecipe.result.count
    const retryDetails: Partial<CraftResult> = {
      recipeOutput: retryRecipe.result.count,
      executionCount: retryApplications,
      retryCount: 1
    }
    const retryAttempt = await performCraftAttempt(
      bot,
      state,
      actionVersion,
      retryRecipe,
      retryApplications,
      refreshedTable,
      inventoryBeforeRetry,
      registryItem.id,
      initialCount
    )
    if (retryAttempt.success) {
      return completedResult(itemName, amount, retryAttempt.crafted, {
        ...retryDetails,
        retryResult: 'succeeded'
      })
    }

    return failedResult(itemName, amount, retryAttempt.reason, {
      ...retryDetails,
      retryResult: 'failed',
      crafted: retryAttempt.crafted,
      ...(retryAttempt.reason === 'action_cancelled'
        ? { status: 'cancelled' }
        : {}),
      ...(retryAttempt.error ? { error: retryAttempt.error } : {})
    })
  } finally {
    finishAgentAction(state, actionVersion)
  }
}

interface CraftAttemptResult {
  success: boolean
  crafted: number
  reason: Extract<
    CraftFailureReason,
    'action_cancelled' | 'craft_failed' | 'inventory_changed' | 'output_not_confirmed'
  >
  inventoryUnchanged: boolean
  transientTableSyncFailure: boolean
  error?: string
}

async function performCraftAttempt(
  bot: Bot,
  state: AgentState,
  actionVersion: number,
  recipe: Recipe,
  applications: number,
  craftingTable: Block | undefined,
  inventoryBeforeCraft: readonly InventoryCountItem[],
  resultItemType: number,
  initialCount: number
): Promise<CraftAttemptResult> {
  let craftError: unknown = null
  try {
    await bot.craft(recipe, applications, craftingTable)
  } catch (error) {
    craftError = error
  }

  let inventoryAfterCraft = snapshotInventoryCounts(bot.inventory.items())
  const shouldWaitForReconciliation = craftError === null ||
    isTransientTableSyncError(craftError)
  for (
    let tick = 0;
    shouldWaitForReconciliation &&
      tick < MAX_CRAFT_CONFIRMATION_TICKS &&
      !matchesRecipeDelta(
        inventoryBeforeCraft,
        inventoryAfterCraft,
        recipe,
        applications
      ) &&
      state.actionVersion === actionVersion;
    tick += 1
  ) {
    await bot.waitForTicks(1)
    inventoryAfterCraft = snapshotInventoryCounts(bot.inventory.items())
  }

  const crafted = Math.max(
    0,
    countItemStacks(inventoryAfterCraft, resultItemType, null) - initialCount
  )
  const inventoryUnchanged = inventoryCountsEqual(
    inventoryBeforeCraft,
    inventoryAfterCraft
  )

  if (state.actionVersion !== actionVersion) {
    return {
      success: false,
      crafted,
      reason: 'action_cancelled',
      inventoryUnchanged,
      transientTableSyncFailure: false
    }
  }
  if (matchesRecipeDelta(
    inventoryBeforeCraft,
    inventoryAfterCraft,
    recipe,
    applications
  )) {
    return {
      success: true,
      crafted,
      reason: 'output_not_confirmed',
      inventoryUnchanged: false,
      transientTableSyncFailure: false
    }
  }
  if (!inventoryUnchanged) {
    return {
      success: false,
      crafted,
      reason: 'inventory_changed',
      inventoryUnchanged: false,
      transientTableSyncFailure: false
    }
  }
  if (craftError !== null) {
    return {
      success: false,
      crafted,
      reason: 'craft_failed',
      inventoryUnchanged: true,
      transientTableSyncFailure: isTransientTableSyncError(craftError),
      error: formatError(craftError)
    }
  }
  return {
    success: false,
    crafted,
    reason: 'output_not_confirmed',
    inventoryUnchanged: true,
    transientTableSyncFailure: true
  }
}

function reacquireCraftingTable(bot: Bot): Block | null {
  const found = findNearbyCraftingTable(bot, DEFAULT_CRAFTING_TABLE_RADIUS)
  if (!found) return null
  const current = bot.blockAt(found.position)
  return current?.name === 'crafting_table' ? current : null
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

function isOutputAmountAligned(amount: number, recipe: Recipe): boolean {
  return recipe.result.count > 0 && amount % recipe.result.count === 0
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

function inventoryCountsEqual(
  left: readonly InventoryCountItem[],
  right: readonly InventoryCountItem[]
): boolean {
  const keys = new Set([
    ...left.map(item => `${item.type}:${item.metadata}`),
    ...right.map(item => `${item.type}:${item.metadata}`)
  ])

  return [...keys].every(key => {
    const [type, metadata] = key.split(':').map(Number)
    return countItemStacks(left, type ?? -1, metadata ?? -1) ===
      countItemStacks(right, type ?? -1, metadata ?? -1)
  })
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

function completedResult(
  target: string,
  requested: number,
  crafted: number,
  details: Partial<CraftResult>
): CraftResult {
  return {
    success: true,
    action: 'craft_item',
    target,
    requested,
    crafted,
    recipeOutput: null,
    executionCount: 0,
    retryCount: 0,
    retryResult: 'not_needed',
    status: 'completed',
    ...details
  }
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
    recipeOutput: null,
    executionCount: 0,
    retryCount: 0,
    retryResult: 'not_needed',
    status: 'failed',
    reason,
    ...details
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTransientTableSyncError(error: unknown): boolean {
  return /windowOpen/i.test(formatError(error))
}
