import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'

import {
  beginAgentAction,
  finishAgentAction,
  AgentActionSource,
  AgentState
} from '../agent/state.js'

export type EatFailureReason =
  | 'no_food'
  | 'not_hungry'
  | 'item_unavailable'
  | 'equip_failed'
  | 'consume_failed'
  | 'consumption_not_confirmed'
  | 'action_cancelled'

export interface EatResult {
  success: boolean
  action: 'eat'
  status: 'completed' | 'cancelled' | 'failed'
  item?: string
  foodBefore: number
  foodAfter: number
  reason?: EatFailureReason
  error?: string
}

const UNSAFE_FOOD_NAMES = new Set([
  'chicken',
  'chorus_fruit',
  'poisonous_potato',
  'pufferfish',
  'rotten_flesh',
  'spider_eye',
  'suspicious_stew'
])

export function findSafeFood(bot: Bot): Item | null {
  return bot.inventory.items()
    .filter(item => isSafeFood(bot, item))
    .sort((left, right) => {
      const foodDifference = foodPoints(bot, right) - foodPoints(bot, left)
      return foodDifference || left.name.localeCompare(right.name)
    })[0] ?? null
}

export async function eatFood(
  bot: Bot,
  state: AgentState,
  source: AgentActionSource = 'reflex'
): Promise<EatResult> {
  const foodBefore = bot.food
  if (foodBefore >= 20) {
    return failedResult(foodBefore, bot.food, 'not_hungry')
  }

  const selected = findSafeFood(bot)
  if (!selected) {
    return failedResult(foodBefore, bot.food, 'no_food')
  }

  const liveItem = bot.inventory.items().find(item => (
    item.type === selected.type &&
    item.name === selected.name &&
    item.count > 0 &&
    isSafeFood(bot, item)
  ))
  if (!liveItem) {
    return failedResult(
      foodBefore,
      bot.food,
      'item_unavailable',
      selected.name
    )
  }

  const actionVersion = beginAgentAction(
    state,
    'eating',
    'eat',
    `Eat ${liveItem.name}`,
    source
  )

  try {
    try {
      await bot.equip(liveItem, 'hand')
    } catch (error) {
      if (state.actionVersion !== actionVersion) {
        return cancelledResult(foodBefore, bot.food, liveItem.name)
      }

      return failedResult(
        foodBefore,
        bot.food,
        'equip_failed',
        liveItem.name,
        formatError(error)
      )
    }

    if (state.actionVersion !== actionVersion) {
      return cancelledResult(foodBefore, bot.food, liveItem.name)
    }

    try {
      await bot.consume()
    } catch (error) {
      if (state.actionVersion !== actionVersion) {
        return cancelledResult(foodBefore, bot.food, liveItem.name)
      }

      return failedResult(
        foodBefore,
        bot.food,
        'consume_failed',
        liveItem.name,
        formatError(error)
      )
    }

    if (state.actionVersion !== actionVersion) {
      return cancelledResult(foodBefore, bot.food, liveItem.name)
    }

    if (bot.food <= foodBefore) {
      return failedResult(
        foodBefore,
        bot.food,
        'consumption_not_confirmed',
        liveItem.name
      )
    }

    return {
      success: true,
      action: 'eat',
      status: 'completed',
      item: liveItem.name,
      foodBefore,
      foodAfter: bot.food
    }
  } finally {
    finishAgentAction(state, actionVersion)
  }
}

function isSafeFood(bot: Bot, item: Item): boolean {
  return item.count > 0 &&
    !UNSAFE_FOOD_NAMES.has(item.name) &&
    foodPoints(bot, item) > 0
}

function foodPoints(bot: Bot, item: Item): number {
  return bot.registry.foodsByName[item.name]?.foodPoints ?? 0
}

function cancelledResult(
  foodBefore: number,
  foodAfter: number,
  item: string
): EatResult {
  return {
    success: false,
    action: 'eat',
    status: 'cancelled',
    item,
    foodBefore,
    foodAfter,
    reason: 'action_cancelled'
  }
}

function failedResult(
  foodBefore: number,
  foodAfter: number,
  reason: EatFailureReason,
  item?: string,
  error?: string
): EatResult {
  return {
    success: false,
    action: 'eat',
    status: 'failed',
    ...(item ? { item } : {}),
    foodBefore,
    foodAfter,
    reason,
    ...(error ? { error } : {})
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
