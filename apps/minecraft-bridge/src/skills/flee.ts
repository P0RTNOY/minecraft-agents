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
import {
  getEntityName,
  isLiveHostileEntity
} from '../survival/hostility.js'
import type { FleeDecision } from '../survival/types.js'
import { isExpectedNavigationCancellation } from './movement.js'

export type FleeFailureReason =
  | 'entity_not_found'
  | 'target_not_hostile'
  | 'no_safe_destination'
  | 'goal_replaced'
  | 'navigation_failed'

export interface FleeResult {
  success: boolean
  action: 'flee_from_entity'
  status: 'completed' | 'cancelled' | 'failed'
  targetId: number
  targetName: string
  reason?: FleeFailureReason
  error?: string
}

export interface FleeNavigator {
  prepare(bot: Bot): void
  goto(bot: Bot, destination: Vec3): Promise<void>
}

export type FleeSkill = (
  bot: Bot,
  state: AgentState,
  decision: FleeDecision,
  source?: AgentActionSource
) => Promise<FleeResult>

const defaultNavigator: FleeNavigator = {
  prepare(bot) {
    bot.pathfinder.setMovements(new Movements(bot))
  },
  async goto(bot, destination) {
    await bot.pathfinder.goto(
      new goals.GoalNear(destination.x, destination.y, destination.z, 1)
    )
  }
}

export const fleeFromEntity = createFleeSkill(defaultNavigator)

export function createFleeSkill(navigator: FleeNavigator): FleeSkill {
  return async (bot, state, decision, source = 'reflex') => {
    const target = bot.entities[decision.entityId]

    if (!target || target.isValid === false) {
      return failedResult(decision, 'entity_not_found')
    }

    if (target === bot.entity || target.type === 'player') {
      return failedResult(decision, 'target_not_hostile')
    }

    if (getEntityName(target) !== decision.entityName) {
      return failedResult(decision, 'entity_not_found')
    }

    if (!isLiveHostileEntity(bot, target)) {
      return failedResult(decision, 'target_not_hostile')
    }

    const destination = findSafeEscapeDestination(bot, target.position)
    if (!destination) {
      return failedResult(decision, 'no_safe_destination')
    }

    const actionVersion = beginAgentAction(
      state,
      'fleeing',
      'flee_from_entity',
      `Escape ${decision.entityName} (${decision.entityId})`,
      source
    )

    try {
      navigator.prepare(bot)
      await navigator.goto(bot, destination)

      return {
        success: true,
        action: 'flee_from_entity',
        status: 'completed',
        targetId: decision.entityId,
        targetName: decision.entityName
      }
    } catch (error) {
      if (isExpectedNavigationCancellation(error)) {
        return failedResult(decision, 'goal_replaced', {
          status: 'cancelled'
        })
      }

      return failedResult(decision, 'navigation_failed', {
        error: formatError(error)
      })
    } finally {
      finishAgentAction(state, actionVersion)
    }
  }
}

export function findSafeEscapeDestination(
  bot: Bot,
  threatPosition: Vec3
): Vec3 | null {
  const origin = bot.entity.position
  const awayX = origin.x - threatPosition.x
  const awayZ = origin.z - threatPosition.z
  const magnitude = Math.hypot(awayX, awayZ)
  const directionX = magnitude === 0 ? 1 : awayX / magnitude
  const directionZ = magnitude === 0 ? 0 : awayZ / magnitude
  const angleOffsets = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]
  const distances = [12, 8, 5]
  const horizontalOffsets = [
    [0, 0],
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
    [2, 0], [-2, 0], [0, 2], [0, -2]
  ] as const
  const verticalOffsets = [0, 1, -1, 2, -2]

  for (const distance of distances) {
    for (const angle of angleOffsets) {
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const rotatedX = (directionX * cos) - (directionZ * sin)
      const rotatedZ = (directionX * sin) + (directionZ * cos)
      const base = new Vector(
        Math.floor(origin.x + (rotatedX * distance)),
        Math.floor(origin.y),
        Math.floor(origin.z + (rotatedZ * distance))
      )

      for (const [offsetX, offsetZ] of horizontalOffsets) {
        for (const offsetY of verticalOffsets) {
          const candidate = base.offset(offsetX, offsetY, offsetZ)

          if (
            isFartherFromThreat(candidate, origin, threatPosition) &&
            isSafeDestination(bot, candidate)
          ) {
            return candidate
          }
        }
      }
    }
  }

  return null
}

function isFartherFromThreat(
  candidate: Vec3,
  origin: Vec3,
  threat: Vec3
): boolean {
  return horizontalDistance(candidate, threat) >
    horizontalDistance(origin, threat)
}

function horizontalDistance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.z - right.z)
}

function isSafeDestination(bot: Bot, position: Vec3): boolean {
  const support = bot.blockAt(position.offset(0, -1, 0))
  const feet = bot.blockAt(position)
  const head = bot.blockAt(position.offset(0, 1, 0))

  return support?.boundingBox === 'block' &&
    isPassable(feet) &&
    isPassable(head)
}

function isPassable(block: ReturnType<Bot['blockAt']>): boolean {
  return Boolean(
    block &&
    block.boundingBox === 'empty' &&
    block.name !== 'water' &&
    block.name !== 'lava'
  )
}

function failedResult(
  decision: FleeDecision,
  reason: FleeFailureReason,
  details: Partial<FleeResult> = {}
): FleeResult {
  return {
    success: false,
    action: 'flee_from_entity',
    status: 'failed',
    targetId: decision.entityId,
    targetName: decision.entityName,
    reason,
    ...details
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
