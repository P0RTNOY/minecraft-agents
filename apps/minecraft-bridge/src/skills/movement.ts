import type { Bot } from 'mineflayer'
import { goals, Movements } from 'mineflayer-pathfinder'

import {
  beginAgentAction,
  finishAgentAction,
  stopAgentAction,
  type AgentActionSource,
  type AgentState
} from '../agent/state.js'

export type MovementAction =
  | 'come_to_player'
  | 'follow_player'
  | 'follow_nearest_player'
  | 'stop_movement'

export interface MovementResult {
  success: boolean
  action: MovementAction
  status: 'completed' | 'started' | 'stopped' | 'cancelled' | 'failed'
  target?: string
  reason?: 'player_not_visible' | 'goal_replaced' | 'navigation_failed'
  error?: string
}

function prepareMovement(bot: Bot): void {
  const movements = new Movements(bot)
  bot.pathfinder.setMovements(movements)
}

export function isExpectedNavigationCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return (
    error.name === 'GoalChanged' ||
    error.message.toLowerCase().includes('goal was changed')
  )
}

export async function comeToPlayer(
  bot: Bot,
  state: AgentState,
  username: string,
  source: AgentActionSource = 'manual'
): Promise<MovementResult> {
  const player = bot.players[username]?.entity

  if (!player) {
    return {
      success: false,
      action: 'come_to_player',
      status: 'failed',
      target: username,
      reason: 'player_not_visible'
    }
  }

  prepareMovement(bot)
  const actionVersion = beginAgentAction(
    state,
    'moving',
    'come_to_player',
    `Reach ${username}`,
    source
  )

  try {
    await bot.pathfinder.goto(
      new goals.GoalNear(
        player.position.x,
        player.position.y,
        player.position.z,
        2
      )
    )

    finishAgentAction(state, actionVersion)

    return {
      success: true,
      action: 'come_to_player',
      status: 'completed',
      target: username
    }
  } catch (error) {
    if (isExpectedNavigationCancellation(error)) {
      finishAgentAction(state, actionVersion)

      return {
        success: false,
        action: 'come_to_player',
        status: 'cancelled',
        target: username,
        reason: 'goal_replaced'
      }
    }

    finishAgentAction(state, actionVersion)

    return {
      success: false,
      action: 'come_to_player',
      status: 'failed',
      target: username,
      reason: 'navigation_failed',
      error: formatError(error)
    }
  }
}

export function followPlayer(
  bot: Bot,
  state: AgentState,
  username: string,
  source: AgentActionSource = 'manual'
): MovementResult {
  const player = bot.players[username]?.entity

  if (!player) {
    return {
      success: false,
      action: 'follow_player',
      status: 'failed',
      target: username,
      reason: 'player_not_visible'
    }
  }

  prepareMovement(bot)
  beginAgentAction(
    state,
    'following',
    'follow_player',
    `Follow ${username}`,
    source
  )

  bot.pathfinder.setGoal(
    new goals.GoalFollow(player, 2),
    true
  )

  return {
    success: true,
    action: 'follow_player',
    status: 'started',
    target: username
  }
}

export function followNearestPlayer(
  bot: Bot,
  state: AgentState,
  source: AgentActionSource = 'manual'
): MovementResult {
  const player = bot.nearestEntity(entity =>
    entity.type === 'player' &&
    entity.username !== bot.username
  )

  if (!player?.username) {
    return {
      success: false,
      action: 'follow_nearest_player',
      status: 'failed',
      reason: 'player_not_visible'
    }
  }

  prepareMovement(bot)
  beginAgentAction(
    state,
    'following',
    'follow_nearest_player',
    `Follow ${player.username}`,
    source
  )

  bot.pathfinder.setGoal(
    new goals.GoalFollow(player, 2),
    true
  )

  return {
    success: true,
    action: 'follow_nearest_player',
    status: 'started',
    target: player.username
  }
}

export function stopMovement(
  bot: Bot,
  state: AgentState
): MovementResult {
  bot.pathfinder.setGoal(null)
  stopAgentAction(state)

  return {
    success: true,
    action: 'stop_movement',
    status: 'stopped'
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
