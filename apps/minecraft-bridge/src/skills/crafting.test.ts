import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Item } from 'prismarine-item'
import type { Recipe } from 'prismarine-recipe'
import { Vec3 } from 'vec3'

import { createAgentState } from '../agent/state.js'
import {
  craftItem,
  createCraftingSkill,
  inspectCraftingCapabilities
} from './crafting.js'

describe('crafting capabilities', () => {
  it('reports only inventory-satisfied registry recipes with maximum output', () => {
    const fixture = createCraftingBot({ logCount: 2 })

    assert.deepEqual(inspectCraftingCapabilities(fixture.bot, 16), {
      craftableItems: [{
        item: 'oak_planks',
        maxCraftable: 8,
        requiresTable: false
      }],
      nearbyCraftingTable: false
    })
  })

  it('reports table recipes only when a real nearby table is available', () => {
    const withoutTable = createCraftingBot({
      includeTableRecipe: true,
      plankCount: 3,
      stickCount: 2
    })
    const withTable = createCraftingBot({
      includeTableRecipe: true,
      plankCount: 3,
      stickCount: 2,
      tableAvailable: true
    })

    assert.equal(
      inspectCraftingCapabilities(withoutTable.bot, 16).craftableItems
        .some(entry => entry.item === 'wooden_pickaxe'),
      false
    )
    assert.deepEqual(
      inspectCraftingCapabilities(withTable.bot, 16).craftableItems
        .find(entry => entry.item === 'wooden_pickaxe'),
      { item: 'wooden_pickaxe', maxCraftable: 1, requiresTable: true }
    )
  })
})

describe('craftItem', () => {
  it('crafts the requested registry item and confirms its inventory delta', async () => {
    const fixture = createCraftingBot({ logCount: 1 })

    const result = await craftItem(
      fixture.bot,
      createAgentState('Alice'),
      'oak_planks',
      4,
      'autonomous'
    )

    assert.equal(result.success, true)
    assert.equal(result.crafted, 4)
    assert.deepEqual(fixture.craftCalls, [{ item: 'oak_planks', count: 1 }])
  })

  it('rejects unknown items and items without recipes', async () => {
    const fixture = createCraftingBot()
    const state = createAgentState('Alice')

    assert.equal(
      (await craftItem(fixture.bot, state, 'invented_pickaxe', 1)).reason,
      'unknown_item'
    )
    assert.equal(
      (await craftItem(fixture.bot, state, 'diamond', 1)).reason,
      'recipe_unavailable'
    )
    assert.equal(
      (await craftItem(fixture.bot, state, '__proto__', 1)).reason,
      'unknown_item'
    )
    assert.equal(
      (await craftItem(fixture.bot, state, 'oak_planks', 65)).reason,
      'invalid_amount'
    )
  })

  it('distinguishes insufficient ingredients from a missing table', async () => {
    const insufficient = createCraftingBot({ logCount: 0 })
    const missingTable = createCraftingBot({
      includeTableRecipe: true,
      plankCount: 3,
      stickCount: 2
    })

    assert.equal(
      (await craftItem(
        insufficient.bot,
        createAgentState('Alice'),
        'oak_planks',
        4
      )).reason,
      'insufficient_ingredients'
    )
    assert.equal(
      (await createTestCraftSkill()(
        missingTable.bot,
        createAgentState('Alice'),
        'wooden_pickaxe',
        1
      )).reason,
      'crafting_table_unavailable'
    )
  })

  it('revalidates the crafting table and ingredients after navigation', async () => {
    const missingTable = createCraftingBot({
      includeTableRecipe: true,
      plankCount: 3,
      stickCount: 2,
      tableAvailable: true,
      removeTableDuringNavigation: true
    })
    const missingIngredients = createCraftingBot({
      includeTableRecipe: true,
      plankCount: 3,
      stickCount: 2,
      tableAvailable: true,
      removeIngredientsDuringNavigation: true
    })

    assert.equal(
      (await createTestCraftSkill()(
        missingTable.bot,
        createAgentState('Alice'),
        'wooden_pickaxe',
        1
      )).reason,
      'crafting_table_unavailable'
    )
    assert.equal(
      (await createTestCraftSkill()(
        missingIngredients.bot,
        createAgentState('Alice'),
        'wooden_pickaxe',
        1
      )).reason,
      'insufficient_ingredients'
    )
    assert.equal(missingTable.craftCalls.length, 0)
    assert.equal(missingIngredients.craftCalls.length, 0)
  })

  it('reports craft failures and an unconfirmed output delta safely', async () => {
    const failing = createCraftingBot({ logCount: 1, craftError: true })
    const noDelta = createCraftingBot({ logCount: 1, suppressOutput: true })

    assert.equal(
      (await craftItem(
        failing.bot,
        createAgentState('Alice'),
        'oak_planks',
        4
      )).reason,
      'craft_failed'
    )
    assert.equal(
      (await craftItem(
        noDelta.bot,
        createAgentState('Alice'),
        'oak_planks',
        4
      )).reason,
      'output_not_confirmed'
    )
  })

  it('rejects a craft whose observed ingredient delta does not match the selected recipe', async () => {
    const fixture = createCraftingBot({
      includeTableRecipe: true,
      plankCount: 6,
      stickCount: 4,
      tableAvailable: true,
      corruptIngredientDelta: true
    })

    const result = await createTestCraftSkill()(
      fixture.bot,
      createAgentState('Alice'),
      'wooden_pickaxe',
      1
    )

    assert.equal(result.success, false)
    assert.equal(result.reason, 'inventory_changed')
    assert.equal(result.crafted, 1)
  })

  it('crafts representative table-required tools from exact grounded recipes', async () => {
    for (const target of ['wooden_pickaxe', 'wooden_axe']) {
      const fixture = createCraftingBot({
        includeTableRecipe: true,
        plankCount: 3,
        stickCount: 2,
        tableAvailable: true
      })

      const result = await createTestCraftSkill()(
        fixture.bot,
        createAgentState('Alice'),
        target,
        1
      )

      assert.equal(result.success, true)
      assert.equal(result.crafted, 1)
    }
  })

  it('maps table path replacement and cancellation before crafting safely', async () => {
    const fixture = createCraftingBot({
      includeTableRecipe: true,
      plankCount: 3,
      stickCount: 2,
      tableAvailable: true
    })
    const navigationCancelled = new Error('Goal was replaced')
    navigationCancelled.name = 'GoalChanged'
    const replaced = createCraftingSkill({
      prepare: () => {},
      goto: async () => {
        throw navigationCancelled
      }
    })
    const state = createAgentState('Alice')
    const cancelled = createCraftingSkill({
      prepare: () => {},
      goto: async () => {
        state.actionVersion += 1
      }
    })

    const replacedResult = await replaced(
      fixture.bot,
      createAgentState('Alice'),
      'wooden_pickaxe',
      1
    )
    const cancelledResult = await cancelled(
      fixture.bot,
      state,
      'wooden_pickaxe',
      1
    )

    assert.equal(replacedResult.status, 'cancelled')
    assert.equal(replacedResult.reason, 'goal_replaced')
    assert.equal(cancelledResult.status, 'cancelled')
    assert.equal(cancelledResult.reason, 'action_cancelled')
    assert.equal(fixture.craftCalls.length, 0)
  })
})

interface CraftingFixtureOptions {
  logCount?: number
  plankCount?: number
  stickCount?: number
  includeTableRecipe?: boolean
  tableAvailable?: boolean
  removeTableDuringNavigation?: boolean
  removeIngredientsDuringNavigation?: boolean
  craftError?: boolean
  suppressOutput?: boolean
  corruptIngredientDelta?: boolean
}

function createCraftingBot(options: CraftingFixtureOptions = {}): {
  bot: Bot
  craftCalls: Array<{ item: string; count: number }>
} {
  const items = [
    item(1, 'oak_log', options.logCount ?? 0),
    item(2, 'oak_planks', options.plankCount ?? 0),
    item(5, 'stick', options.stickCount ?? 0)
  ].filter(stack => stack.count > 0)
  const plankRecipe = recipe(2, 4, [{ id: 1, count: -1 }], false)
  const pickaxeRecipe = recipe(3, 1, [
    { id: 2, count: -3 },
    { id: 5, count: -2 }
  ], true)
  const axeRecipe = recipe(6, 1, [
    { id: 2, count: -3 },
    { id: 5, count: -2 }
  ], true)
  const recipes = new Map<number, Recipe[]>([
    [2, [plankRecipe]],
    [3, options.includeTableRecipe ? [pickaxeRecipe] : []],
    [6, options.includeTableRecipe ? [axeRecipe] : []]
  ])
  const tablePosition = new Vec3(2, 64, 0)
  let tableAvailable = options.tableAvailable ?? false
  const table = {
    name: 'crafting_table',
    position: tablePosition,
    boundingBox: 'block'
  } as Block
  const craftCalls: Array<{ item: string; count: number }> = []

  const bot = {
    username: 'Alice',
    entity: { position: new Vec3(0, 64, 0) },
    entities: {},
    registry: {
      itemsByName: {
        oak_log: { id: 1, name: 'oak_log' },
        oak_planks: { id: 2, name: 'oak_planks' },
        wooden_pickaxe: { id: 3, name: 'wooden_pickaxe' },
        diamond: { id: 4, name: 'diamond' },
        stick: { id: 5, name: 'stick' },
        wooden_axe: { id: 6, name: 'wooden_axe' }
      }
    },
    inventory: {
      items: () => items,
      count: (type: number) => items
        .filter(stack => stack.type === type)
        .reduce((total, stack) => total + stack.count, 0)
    },
    findBlock: () => tableAvailable ? table : null,
    blockAt: (position: Vec3) => (
      tableAvailable && position.equals(tablePosition) ? table : null
    ),
    recipesAll: (itemType: number, _metadata: number | null, tableAllowed: boolean) => (
      (recipes.get(itemType) ?? []).filter(candidate => (
        !candidate.requiresTable || tableAllowed
      ))
    ),
    recipesFor: (
      itemType: number,
      _metadata: number | null,
      minimum: number,
      craftingTable: Block | boolean | null
    ) => (recipes.get(itemType) ?? []).filter(candidate => {
      if (candidate.requiresTable && !craftingTable) return false
      const applications = Math.ceil(minimum / candidate.result.count)
      return candidate.delta.every(delta => (
        delta.count >= 0 || count(items, delta.id) >= -delta.count * applications
      ))
    }),
    pathfinder: {
      setMovements: () => {},
      goto: async () => {
        if (options.removeTableDuringNavigation) tableAvailable = false
        if (options.removeIngredientsDuringNavigation) {
          const planks = items.find(stack => stack.name === 'oak_planks')
          if (planks) planks.count = 0
        }
      }
    },
    craft: async (selected: Recipe, applications: number) => {
      const outputName = selected.result.id === 2
        ? 'oak_planks'
        : selected.result.id === 3
          ? 'wooden_pickaxe'
          : 'wooden_axe'
      craftCalls.push({ item: outputName, count: applications })
      if (options.craftError) throw new Error('Crafting window closed')
      if (!options.suppressOutput) {
        for (const delta of selected.delta.filter(entry => entry.count < 0)) {
          const ingredient = items.find(stack => stack.type === delta.id)
          if (ingredient) {
            ingredient.count += delta.count * applications
            if (options.corruptIngredientDelta && delta.id === 2) {
              ingredient.count += delta.count * applications
            }
          }
        }
        const existing = items.find(stack => stack.type === selected.result.id)
        if (existing) {
          existing.count += selected.result.count * applications
        } else {
          items.push(item(selected.result.id, outputName, selected.result.count * applications))
        }
      }
    },
    waitForTicks: async () => {}
  } as unknown as Bot

  return { bot, craftCalls }
}

function recipe(
  resultId: number,
  resultCount: number,
  ingredients: Array<{ id: number; count: number }>,
  requiresTable: boolean
): Recipe {
  return {
    result: { id: resultId, metadata: null, count: resultCount },
    delta: [
      ...ingredients.map(ingredient => ({ ...ingredient, metadata: null })),
      { id: resultId, metadata: null, count: resultCount }
    ],
    requiresTable
  } as Recipe
}

function item(type: number, name: string, count: number): Item {
  return { type, name, count, metadata: 0, enchants: [] } as unknown as Item
}

function count(items: Item[], type: number): number {
  return items
    .filter(stack => stack.type === type)
    .reduce((total, stack) => total + stack.count, 0)
}

function createTestCraftSkill() {
  return createCraftingSkill({
    prepare: () => {},
    goto: async bot => {
      await bot.pathfinder.goto(null as never)
    }
  })
}
