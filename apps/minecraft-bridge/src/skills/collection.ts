import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { goals, Movements } from 'mineflayer-pathfinder'
import type { Vec3 } from 'vec3'

import {
  beginAgentAction,
  finishAgentAction,
  type AgentActionSource,
  type AgentState
} from '../agent/state.js'
import { inspectInventory } from './inventory.js'
import { isExpectedNavigationCancellation } from './movement.js'

export type CollectionFailureReason =
  | 'block_not_found'
  | 'goal_replaced'
  | 'navigation_failed'
  | 'target_disappeared'
  | 'cannot_dig'
  | 'dig_failed'
  | 'drop_not_found'
  | 'pickup_not_confirmed'

export interface CollectionResult {
  success: boolean
  action: 'collect_block'
  target: string
  status: 'completed' | 'cancelled' | 'failed'
  collected: number
  blockBroken: boolean
  dropDetected: boolean
  reason?: CollectionFailureReason
  error?: string
}

export async function collectBlock(
  bot: Bot,
  state: AgentState,
  blockName: string,
  source: AgentActionSource = 'manual'
): Promise<CollectionResult> {
  const target = bot.findBlock({
    matching: block => block.name === blockName,
    maxDistance: 32
  })

  if (!target) {
    return failedResult(blockName, 'block_not_found')
  }

  const initialItemCount = inspectInventory(bot).itemCount
  const existingDroppedItemIds = new Set(
    Object.values(bot.entities)
      .filter(entity => entity.name === 'item')
      .map(entity => entity.id)
  )
  const actionVersion = beginAgentAction(
    state,
    'collecting',
    'collect_block',
    `Collect ${blockName}`,
    source
  )

  try {
    const movements = new Movements(bot)
    bot.pathfinder.setMovements(movements)

    try {
      await bot.pathfinder.goto(
        new goals.GoalNear(
          target.position.x,
          target.position.y,
          target.position.z,
          2
        )
      )
    } catch (error) {
      return navigationFailure(blockName, error)
    }

    const block = bot.blockAt(target.position)

    if (!block || block.name !== blockName) {
      return failedResult(blockName, 'target_disappeared')
    }

    if (!bot.canDigBlock(block)) {
      return failedResult(blockName, 'cannot_dig')
    }

    try {
      await bot.dig(block)
    } catch (error) {
      return failedResult(blockName, 'dig_failed', {
        error: formatError(error)
      })
    }

    await bot.waitForTicks(2)

    const immediatelyCollected = getCollectedItemCount(
      initialItemCount,
      inspectInventory(bot).itemCount
    )

    if (immediatelyCollected > 0) {
      return completedResult(blockName, immediatelyCollected, false)
    }

    const droppedItem = await waitForNewDroppedItem(
      bot,
      existingDroppedItemIds,
      target.position
    )

    if (!droppedItem) {
      const collectedWithoutVisibleDrop = getCollectedItemCount(
        initialItemCount,
        inspectInventory(bot).itemCount
      )

      if (collectedWithoutVisibleDrop > 0) {
        return completedResult(
          blockName,
          collectedWithoutVisibleDrop,
          false
        )
      }

      return failedResult(blockName, 'drop_not_found', {
        blockBroken: true
      })
    }

    try {
      await bot.pathfinder.goto(new goals.GoalFollow(droppedItem, 0))
    } catch (error) {
      return navigationFailure(blockName, error, true, true)
    }

    await bot.waitForTicks(10)

    const collected = getCollectedItemCount(
      initialItemCount,
      inspectInventory(bot).itemCount
    )

    if (collected === 0) {
      return failedResult(blockName, 'pickup_not_confirmed', {
        blockBroken: true,
        dropDetected: true
      })
    }

    return completedResult(blockName, collected, true)
  } finally {
    finishAgentAction(state, actionVersion)
  }
}

export function getCollectedItemCount(
  initialItemCount: number,
  finalItemCount: number
): number {
  return Math.max(0, finalItemCount - initialItemCount)
}

async function waitForNewDroppedItem(
  bot: Bot,
  existingIds: ReadonlySet<number>,
  targetPosition: Vec3
): Promise<Entity | null> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const droppedItem = Object.values(bot.entities)
      .filter(entity => (
        entity.name === 'item' &&
        !existingIds.has(entity.id) &&
        targetPosition.distanceTo(entity.position) <= 10
      ))
      .sort((left, right) => (
        bot.entity.position.distanceTo(left.position) -
        bot.entity.position.distanceTo(right.position)
      ))[0]

    if (droppedItem) {
      return droppedItem
    }

    await bot.waitForTicks(1)
  }

  return null
}

function navigationFailure(
  target: string,
  error: unknown,
  blockBroken = false,
  dropDetected = false
): CollectionResult {
  if (isExpectedNavigationCancellation(error)) {
    return failedResult(target, 'goal_replaced', {
      status: 'cancelled',
      blockBroken,
      dropDetected
    })
  }

  return failedResult(target, 'navigation_failed', {
    blockBroken,
    dropDetected,
    error: formatError(error)
  })
}

function completedResult(
  target: string,
  collected: number,
  dropDetected: boolean
): CollectionResult {
  return {
    success: true,
    action: 'collect_block',
    target,
    status: 'completed',
    collected,
    blockBroken: true,
    dropDetected
  }
}

function failedResult(
  target: string,
  reason: CollectionFailureReason,
  details: Partial<CollectionResult> = {}
): CollectionResult {
  return {
    success: false,
    action: 'collect_block',
    target,
    status: 'failed',
    collected: 0,
    blockBroken: false,
    dropDetected: false,
    reason,
    ...details
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
