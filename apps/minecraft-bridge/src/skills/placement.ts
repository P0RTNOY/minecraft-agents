import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Item } from 'prismarine-item'
import type { Vec3 } from 'vec3'
import { Vec3 as Vector } from 'vec3'

import {
  beginAgentAction,
  finishAgentAction,
  type AgentActionSource,
  type AgentState
} from '../agent/state.js'
import type { InventoryItemSnapshot } from './inventory.js'

export type PlacementFailureReason =
  | 'block_unavailable'
  | 'no_safe_position'
  | 'equip_failed'
  | 'target_changed'
  | 'action_cancelled'
  | 'place_failed'
  | 'placement_not_confirmed'

export interface PlacementTarget {
  support: Block
  position: Vec3
}

export interface PlacementResult {
  success: boolean
  action: 'place_block'
  target: string
  placed: boolean
  status: 'completed' | 'cancelled' | 'failed'
  reason?: PlacementFailureReason
  error?: string
}

const UP = new Vector(0, 1, 0)
const PLACEMENT_OFFSETS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
  [2, 0], [-2, 0], [0, 2], [0, -2]
] as const
const REPLACEABLE_BLOCKS = new Set(['air', 'cave_air', 'void_air'])
const UNSAFE_SUPPORT_BLOCKS = new Set([
  'cactus',
  'fire',
  'lava',
  'magma_block',
  'powder_snow',
  'water'
])
const UNSAFE_PLACEABLE_BLOCKS = new Set([
  'bedrock',
  'chain_command_block',
  'command_block',
  'jigsaw',
  'repeating_command_block',
  'respawn_anchor',
  'structure_block',
  'tnt'
])

export function inspectPlaceableBlocks(
  bot: Bot,
  inventoryItems: readonly Item[] = bot.inventory.items()
): InventoryItemSnapshot[] {
  const totals = new Map<string, number>()

  for (const item of inventoryItems) {
    if (!isSafePlaceableBlock(bot, item.name)) continue
    totals.set(item.name, (totals.get(item.name) ?? 0) + item.count)
  }

  return [...totals.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function findPlacementTarget(bot: Bot): PlacementTarget | null {
  const origin = bot.entity.position
  const y = Math.floor(origin.y)

  for (const [offsetX, offsetZ] of PLACEMENT_OFFSETS) {
    const position = new Vector(
      Math.floor(origin.x) + offsetX,
      y,
      Math.floor(origin.z) + offsetZ
    )
    const target = placementTargetAt(bot, position)
    if (target) return target
  }

  return null
}

export async function placeInventoryBlock(
  bot: Bot,
  state: AgentState,
  blockName: string,
  source: AgentActionSource = 'manual'
): Promise<PlacementResult> {
  if (!isSafePlaceableBlock(bot, blockName)) {
    return failedResult(blockName, 'block_unavailable')
  }

  const selectedItem = selectInventoryBlock(bot, blockName)
  if (!selectedItem) {
    return failedResult(blockName, 'block_unavailable')
  }

  const target = findPlacementTarget(bot)
  if (!target) {
    return failedResult(blockName, 'no_safe_position')
  }

  const actionVersion = beginAgentAction(
    state,
    'placing',
    'place_block',
    `Place ${blockName}`,
    source
  )

  try {
    try {
      await bot.equip(selectedItem, 'hand')
    } catch (error) {
      return failedResult(blockName, 'equip_failed', {
        error: formatError(error)
      })
    }

    if (state.actionVersion !== actionVersion) {
      return failedResult(blockName, 'action_cancelled', {
        status: 'cancelled'
      })
    }

    const liveItem = bot.inventory.items().find(item => (
      item.slot === selectedItem.slot &&
      item.type === selectedItem.type &&
      item.name === blockName &&
      item.count > 0
    ))
    if (!liveItem) {
      return failedResult(blockName, 'block_unavailable')
    }

    const liveTarget = placementTargetAt(bot, target.position)
    if (!liveTarget) {
      return failedResult(blockName, 'target_changed')
    }

    try {
      await bot.placeBlock(liveTarget.support, UP)
    } catch (error) {
      return failedResult(blockName, 'place_failed', {
        error: formatError(error)
      })
    }

    await bot.waitForTicks(2)
    const placed = bot.blockAt(target.position)?.name === blockName

    if (state.actionVersion !== actionVersion) {
      return failedResult(blockName, 'action_cancelled', {
        status: 'cancelled',
        placed
      })
    }

    if (!placed) {
      return failedResult(blockName, 'placement_not_confirmed')
    }

    return {
      success: true,
      action: 'place_block',
      target: blockName,
      placed: true,
      status: 'completed'
    }
  } finally {
    finishAgentAction(state, actionVersion)
  }
}

function isSafePlaceableBlock(bot: Bot, blockName: string): boolean {
  if (
    !/^[a-z0-9_]+$/.test(blockName) ||
    UNSAFE_PLACEABLE_BLOCKS.has(blockName) ||
    !Object.hasOwn(bot.registry.blocksByName, blockName)
  ) {
    return false
  }

  return bot.registry.blocksByName[blockName]?.boundingBox === 'block'
}

function selectInventoryBlock(bot: Bot, blockName: string): Item | null {
  return bot.inventory.items()
    .filter(item => item.name === blockName && item.count > 0)
    .sort((left, right) => left.slot - right.slot)[0] ?? null
}

function placementTargetAt(
  bot: Bot,
  position: Vec3
): PlacementTarget | null {
  const support = bot.blockAt(position.offset(0, -1, 0))
  const target = bot.blockAt(position)

  if (
    !support ||
    support.boundingBox !== 'block' ||
    UNSAFE_SUPPORT_BLOCKS.has(support.name) ||
    !target ||
    target.boundingBox !== 'empty' ||
    !REPLACEABLE_BLOCKS.has(target.name) ||
    isOccupiedByEntity(bot, position)
  ) {
    return null
  }

  return { support, position }
}

function isOccupiedByEntity(bot: Bot, position: Vec3): boolean {
  const centerX = position.x + 0.5
  const centerZ = position.z + 0.5
  const blockBottom = position.y
  const blockTop = position.y + 1

  return Object.values(bot.entities).some(entity => {
    if (entity.isValid === false) return false
    const entityBottom = entity.position.y
    const entityTop = entityBottom + (entity.height ?? 1.8)
    const collisionRadius = ((entity.width ?? 0.6) / 2) + Math.SQRT1_2

    return entityBottom < blockTop &&
      entityTop > blockBottom &&
      Math.hypot(
        entity.position.x - centerX,
        entity.position.z - centerZ
      ) < collisionRadius
  })
}

function failedResult(
  target: string,
  reason: PlacementFailureReason,
  details: Partial<PlacementResult> = {}
): PlacementResult {
  return {
    success: false,
    action: 'place_block',
    target,
    placed: false,
    status: 'failed',
    reason,
    ...details
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
