import type { Bot } from 'mineflayer'
import { goals, Movements } from 'mineflayer-pathfinder'
import type { Vec3 } from 'vec3'
import { Vec3 as Vector } from 'vec3'

import {
  beginAgentAction,
  finishAgentAction,
  type AgentActionSource,
  type AgentState
} from '../agent/state.js'
import { isExpectedNavigationCancellation } from './movement.js'

export type ExploreFailureReason =
  | 'no_safe_destination'
  | 'goal_replaced'
  | 'navigation_failed'

export interface ExploreResult {
  success: boolean
  action: 'explore'
  status: 'completed' | 'cancelled' | 'failed'
  distanceTraveled: number
  reason?: ExploreFailureReason
  error?: string
}

export interface ExploreNavigator {
  prepare(bot: Bot): void
  goto(bot: Bot, destination: Vec3): Promise<void>
}

export type ExploreSkill = (
  bot: Bot,
  state: AgentState,
  radius: number,
  source?: AgentActionSource
) => Promise<ExploreResult>

const MIN_DESTINATION_DISTANCE = 6
const ANGLE_COUNT = 16
const UNSAFE_PASSABLE_BLOCKS = new Set([
  'cobweb',
  'fire',
  'lava',
  'powder_snow',
  'sweet_berry_bush',
  'water'
])
const UNSAFE_SUPPORT_BLOCKS = new Set([
  'cactus',
  'campfire',
  'fire',
  'lava',
  'magma_block',
  'powder_snow',
  'soul_campfire',
  'water'
])

const defaultNavigator: ExploreNavigator = {
  prepare(bot) {
    bot.pathfinder.setMovements(new Movements(bot))
  },
  async goto(bot, destination) {
    await bot.pathfinder.goto(
      new goals.GoalNear(destination.x, destination.y, destination.z, 1)
    )
  }
}

export const exploreArea = createExploreSkill(defaultNavigator)

export function createExploreSkill(navigator: ExploreNavigator): ExploreSkill {
  return async (bot, state, radius, source = 'autonomous') => {
    const origin = bot.entity.position.clone()
    const destination = findExplorationDestination(bot, radius)

    if (!destination) {
      return failedResult('no_safe_destination')
    }

    const actionVersion = beginAgentAction(
      state,
      'exploring',
      'explore',
      `Explore within ${radius} blocks`,
      source
    )

    try {
      navigator.prepare(bot)
      await navigator.goto(bot, destination)

      return {
        success: true,
        action: 'explore',
        status: 'completed',
        distanceTraveled: round(horizontalDistance(origin, bot.entity.position))
      }
    } catch (error) {
      if (isExpectedNavigationCancellation(error)) {
        return failedResult('goal_replaced', { status: 'cancelled' })
      }

      return failedResult('navigation_failed', { error: formatError(error) })
    } finally {
      finishAgentAction(state, actionVersion)
    }
  }
}

export function findExplorationDestination(
  bot: Bot,
  radius: number
): Vec3 | null {
  if (!Number.isInteger(radius) || radius < MIN_DESTINATION_DISTANCE) {
    return null
  }

  const origin = bot.entity.position
  const distances = [radius, Math.floor(radius * 0.75), Math.floor(radius * 0.5)]
  const verticalOffsets = [0, 1, -1, 2, -2]

  for (const distance of distances) {
    if (distance < MIN_DESTINATION_DISTANCE) continue

    for (let index = 0; index < ANGLE_COUNT; index += 1) {
      const angle = (index / ANGLE_COUNT) * Math.PI * 2
      const base = new Vector(
        Math.floor(origin.x + (Math.cos(angle) * distance)),
        Math.floor(origin.y),
        Math.floor(origin.z + (Math.sin(angle) * distance))
      )

      for (const offsetY of verticalOffsets) {
        const candidate = base.offset(0, offsetY, 0)
        if (
          horizontalDistance(origin, candidate) <= radius &&
          isSafeDestination(bot, candidate)
        ) {
          return candidate
        }
      }
    }
  }

  return null
}

function isSafeDestination(bot: Bot, position: Vec3): boolean {
  const support = bot.blockAt(position.offset(0, -1, 0))
  const feet = bot.blockAt(position)
  const head = bot.blockAt(position.offset(0, 1, 0))

  return Boolean(
    support?.boundingBox === 'block' &&
    !UNSAFE_SUPPORT_BLOCKS.has(support.name) &&
    isPassable(feet) &&
    isPassable(head)
  )
}

function isPassable(block: ReturnType<Bot['blockAt']>): boolean {
  return Boolean(
    block &&
    block.boundingBox === 'empty' &&
    !UNSAFE_PASSABLE_BLOCKS.has(block.name)
  )
}

function horizontalDistance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.z - right.z)
}

function failedResult(
  reason: ExploreFailureReason,
  details: Partial<ExploreResult> = {}
): ExploreResult {
  return {
    success: false,
    action: 'explore',
    status: 'failed',
    distanceTraveled: 0,
    reason,
    ...details
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
