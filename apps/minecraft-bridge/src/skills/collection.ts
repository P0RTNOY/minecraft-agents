import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { goals, Movements } from 'mineflayer-pathfinder'
import type { Block } from 'prismarine-block'
import type { Item } from 'prismarine-item'
import type { Vec3 } from 'vec3'

import {
  beginAgentAction,
  finishAgentAction,
  type AgentActionSource,
  type AgentState
} from '../agent/state.js'
import { inspectInventory } from './inventory.js'
import { isExpectedNavigationCancellation } from './movement.js'
import { selectHarvestTool } from './tools.js'

export type CollectionFailureReason =
  | 'block_not_found'
  | 'goal_replaced'
  | 'navigation_failed'
  | 'target_disappeared'
  | 'cannot_dig'
  | 'missing_required_tool'
  | 'tool_unavailable'
  | 'action_cancelled'
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
  requiredTool?: string
  tool?: string
}

export interface CollectionNavigator {
  prepare(bot: Bot): void
  gotoBlock(bot: Bot, block: Block): Promise<void>
  gotoDrop(bot: Bot, entity: Entity): Promise<void>
}

export type CollectionSkill = (
  bot: Bot,
  state: AgentState,
  blockName: string,
  source?: AgentActionSource
) => Promise<CollectionResult>

const defaultNavigator: CollectionNavigator = {
  prepare(bot) {
    bot.pathfinder.setMovements(new Movements(bot))
  },
  async gotoBlock(bot, block) {
    await bot.pathfinder.goto(new goals.GoalNear(
      block.position.x,
      block.position.y,
      block.position.z,
      2
    ))
  },
  async gotoDrop(bot, entity) {
    await bot.pathfinder.goto(new goals.GoalFollow(entity, 0))
  }
}

export const collectBlock: CollectionSkill = createCollectionSkill(
  defaultNavigator
)

export function createCollectionSkill(
  navigator: CollectionNavigator
): CollectionSkill {
  return (bot, state, blockName, source = 'manual') => collectBlockWith(
    navigator,
    bot,
    state,
    blockName,
    source
  )
}

async function collectBlockWith(
  navigator: CollectionNavigator,
  bot: Bot,
  state: AgentState,
  blockName: string,
  source: AgentActionSource
): Promise<CollectionResult> {
  const target = bot.findBlock({
    matching: block => block.name === blockName,
    maxDistance: 32
  })

  if (!target) {
    return failedResult(blockName, 'block_not_found')
  }

  const selectedTool = selectHarvestTool(bot, target)
  if (selectedTool.required && !selectedTool.item) {
    return failedResult(blockName, 'missing_required_tool', {
      ...(selectedTool.requiredTool
        ? { requiredTool: selectedTool.requiredTool }
        : {})
    })
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
    try {
      navigator.prepare(bot)
      await navigator.gotoBlock(bot, target)
    } catch (error) {
      return navigationFailure(blockName, error, {
        ...(selectedTool.requiredTool
          ? { requiredTool: selectedTool.requiredTool }
          : {}),
        ...(selectedTool.item ? { tool: selectedTool.item.name } : {})
      })
    }

    if (state.actionVersion !== actionVersion) {
      return cancelledResult(blockName)
    }

    const block = bot.blockAt(target.position)

    if (!block || block.name !== blockName) {
      return failedResult(blockName, 'target_disappeared')
    }

    if (!bot.canDigBlock(block)) {
      return failedResult(blockName, 'cannot_dig')
    }

    const liveSelection = selectHarvestTool(bot, block)
    const tool = resolveLiveSelectedTool(bot, block, selectedTool.item)
    if (!selectedTool.required && liveSelection.required) {
      return failedResult(blockName, 'tool_unavailable', {
        ...(liveSelection.requiredTool
          ? { requiredTool: liveSelection.requiredTool }
          : {})
      })
    }
    if (selectedTool.required && !tool) {
      return failedResult(blockName, 'tool_unavailable', {
        ...(selectedTool.requiredTool
          ? { requiredTool: selectedTool.requiredTool }
          : {}),
        ...(selectedTool.item ? { tool: selectedTool.item.name } : {})
      })
    }

    if (tool) {
      try {
        await bot.equip(tool, 'hand')
      } catch (error) {
        return failedResult(blockName, 'tool_unavailable', {
          ...(selectedTool.requiredTool
            ? { requiredTool: selectedTool.requiredTool }
            : {}),
          tool: tool.name,
          error: formatError(error)
        })
      }
    }

    if (state.actionVersion !== actionVersion) {
      return cancelledResult(
        blockName,
        selectedTool.requiredTool,
        tool?.name
      )
    }

    try {
      await bot.dig(block)
    } catch (error) {
      return failedResult(blockName, 'dig_failed', {
        error: formatError(error)
      })
    }

    if (state.actionVersion !== actionVersion) {
      return cancelledResult(
        blockName,
        selectedTool.requiredTool,
        tool?.name,
        true
      )
    }

    await bot.waitForTicks(2)

    if (state.actionVersion !== actionVersion) {
      return cancelledResult(
        blockName,
        selectedTool.requiredTool,
        tool?.name,
        true
      )
    }

    const immediatelyCollected = getCollectedItemCount(
      initialItemCount,
      inspectInventory(bot).itemCount
    )

    if (immediatelyCollected > 0) {
      return completedResult(
        blockName,
        immediatelyCollected,
        false,
        selectedTool.requiredTool,
        tool?.name ?? null
      )
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
          false,
          selectedTool.requiredTool,
          tool?.name ?? null
        )
      }

      return failedResult(blockName, 'drop_not_found', {
        blockBroken: true
      })
    }

    if (state.actionVersion !== actionVersion) {
      return cancelledResult(
        blockName,
        selectedTool.requiredTool,
        tool?.name,
        true,
        true
      )
    }

    try {
      await navigator.gotoDrop(bot, droppedItem)
    } catch (error) {
      return navigationFailure(blockName, error, {
        blockBroken: true,
        dropDetected: true,
        ...(selectedTool.requiredTool
          ? { requiredTool: selectedTool.requiredTool }
          : {}),
        ...(tool ? { tool: tool.name } : {})
      })
    }

    if (state.actionVersion !== actionVersion) {
      return cancelledResult(
        blockName,
        selectedTool.requiredTool,
        tool?.name,
        true,
        true
      )
    }

    await bot.waitForTicks(10)

    if (state.actionVersion !== actionVersion) {
      return cancelledResult(
        blockName,
        selectedTool.requiredTool,
        tool?.name,
        true,
        true
      )
    }

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

    return completedResult(
      blockName,
      collected,
      true,
      selectedTool.requiredTool,
      tool?.name ?? null
    )
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
  details: Partial<CollectionResult> = {}
): CollectionResult {
  if (isExpectedNavigationCancellation(error)) {
    return failedResult(target, 'goal_replaced', {
      status: 'cancelled',
      ...details
    })
  }

  return failedResult(target, 'navigation_failed', {
    ...details,
    error: formatError(error)
  })
}

function completedResult(
  target: string,
  collected: number,
  dropDetected: boolean,
  requiredTool: string | null,
  tool: string | null
): CollectionResult {
  return {
    success: true,
    action: 'collect_block',
    target,
    status: 'completed',
    collected,
    blockBroken: true,
    dropDetected,
    ...(requiredTool ? { requiredTool } : {}),
    ...(tool ? { tool } : {})
  }
}

function resolveLiveSelectedTool(
  bot: Bot,
  block: Block,
  selectedTool: ReturnType<typeof selectHarvestTool>['item']
): Item | null {
  if (!selectedTool) return null

  const liveTool = bot.inventory.items().find(item => (
    item.slot === selectedTool.slot && item.type === selectedTool.type
  ))

  return liveTool && block.canHarvest(liveTool.type) ? liveTool : null
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

function cancelledResult(
  target: string,
  requiredTool?: string | null,
  tool?: string,
  blockBroken = false,
  dropDetected = false
): CollectionResult {
  return failedResult(target, 'action_cancelled', {
    status: 'cancelled',
    blockBroken,
    dropDetected,
    ...(requiredTool ? { requiredTool } : {}),
    ...(tool ? { tool } : {})
  })
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
