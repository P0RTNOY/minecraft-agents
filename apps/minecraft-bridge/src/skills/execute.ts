import type { Bot } from 'mineflayer'

import type { AgentState } from '../agent/state.js'
import type {
  AgentDecision,
  DecisionExecutionResult
} from '../brain/types.js'
import { perceive } from '../perception/perceive.js'
import { collectBlock } from './collection.js'
import { craftItem } from './crafting.js'
import { exploreArea } from './explore.js'
import { comeToPlayer, followPlayer, stopMovement } from './movement.js'
import { placeInventoryBlock } from './placement.js'
import { say } from './social.js'

export interface DecisionSkillBindings {
  perceive: typeof perceive
  collectBlock: typeof collectBlock
  craftItem: typeof craftItem
  placeInventoryBlock: typeof placeInventoryBlock
  exploreArea: typeof exploreArea
  comeToPlayer: typeof comeToPlayer
  followPlayer: typeof followPlayer
  stopMovement: typeof stopMovement
  say: typeof say
}

export type DecisionExecutor = (
  bot: Bot,
  decision: AgentDecision,
  state: AgentState
) => Promise<DecisionExecutionResult>

export interface DecisionExecutorOptions {
  explorationRadius?: number
}

const defaultSkills: DecisionSkillBindings = {
  perceive,
  collectBlock,
  craftItem,
  placeInventoryBlock,
  exploreArea,
  comeToPlayer,
  followPlayer,
  stopMovement,
  say
}

const defaultExecutor = createDefaultDecisionExecutor()

export function createDefaultDecisionExecutor(
  options: DecisionExecutorOptions = {}
): DecisionExecutor {
  return createDecisionExecutor(defaultSkills, options)
}

export function executeDecision(
  bot: Bot,
  decision: AgentDecision,
  state: AgentState
): Promise<DecisionExecutionResult> {
  return defaultExecutor(bot, decision, state)
}

export function createDecisionExecutor(
  skills: DecisionSkillBindings,
  options: DecisionExecutorOptions = {}
): DecisionExecutor {
  const explorationRadius = options.explorationRadius ?? 24

  return async (bot, decision, state) => {
    try {
      switch (decision.action) {
        case 'idle':
          return {
            success: true,
            action: 'idle',
            status: 'completed',
            summary: 'Alice remained idle.'
          }

        case 'scan': {
          const snapshot = skills.perceive(bot)
          return {
            success: true,
            action: 'scan',
            status: 'completed',
            summary: 'Environment scan completed.',
            details: {
              nearbyBlocks: snapshot.nearbyBlocks.length,
              nearbyEntities: snapshot.nearbyEntities.length,
              inventoryStacks: snapshot.inventory.length
            }
          }
        }

        case 'explore': {
          const result = await skills.exploreArea(
            bot,
            state,
            explorationRadius,
            'autonomous'
          )
          return {
            success: result.success,
            action: 'explore',
            status: result.status,
            summary: result.success
              ? `Explored ${result.distanceTraveled} blocks.`
              : 'Could not find a safe exploration route.',
            details: {
              distanceTraveled: result.distanceTraveled,
              ...(result.reason ? { reason: result.reason } : {}),
              ...(result.error ? { error: result.error } : {})
            }
          }
        }

        case 'follow_player':
          return movementExecutionResult(
            decision.action,
            decision.username,
            skills.followPlayer(
              bot,
              state,
              decision.username,
              'autonomous'
            )
          )

        case 'come_to_player':
          return movementExecutionResult(
            decision.action,
            decision.username,
            await skills.comeToPlayer(
              bot,
              state,
              decision.username,
              'autonomous'
            )
          )

        case 'stop': {
          const result = skills.stopMovement(bot, state)
          return {
            success: result.success,
            action: 'stop',
            status: result.status,
            summary: 'Movement stopped.'
          }
        }

        case 'collect_block': {
          const result = await skills.collectBlock(
            bot,
            state,
            decision.block,
            'autonomous'
          )
          return {
            success: result.success,
            action: 'collect_block',
            status: result.status,
            summary: result.success
              ? `Collected ${result.collected} ${decision.block}.`
              : `Could not collect ${decision.block}.`,
            details: {
              collected: result.collected,
              blockBroken: result.blockBroken,
              dropDetected: result.dropDetected,
              ...(result.requiredTool
                ? { requiredTool: result.requiredTool }
                : {}),
              ...(result.tool ? { tool: result.tool } : {}),
              ...(result.reason ? { reason: result.reason } : {})
            }
          }
        }

        case 'craft_item': {
          const result = await skills.craftItem(
            bot,
            state,
            decision.item,
            decision.amount,
            'autonomous'
          )
          return {
            success: result.success,
            action: 'craft_item',
            status: result.status,
            summary: result.success
              ? `Crafted ${result.crafted} ${decision.item}.`
              : `Could not craft ${decision.item}.`,
            details: {
              requested: result.requested,
              crafted: result.crafted,
              ...(result.reason ? { reason: result.reason } : {}),
              ...(result.error ? { error: result.error } : {})
            }
          }
        }

        case 'place_block': {
          const result = await skills.placeInventoryBlock(
            bot,
            state,
            decision.block,
            'autonomous'
          )
          return {
            success: result.success,
            action: 'place_block',
            status: result.status,
            summary: result.success
              ? `Placed ${decision.block}.`
              : `Could not place ${decision.block}.`,
            details: {
              placed: result.placed,
              ...(result.reason ? { reason: result.reason } : {}),
              ...(result.error ? { error: result.error } : {})
            }
          }
        }

        case 'say': {
          const result = skills.say(bot, decision.message)
          return {
            success: result.success,
            action: 'say',
            status: result.success ? 'completed' : 'failed',
            summary: result.success
              ? `Said: ${result.message}`
              : 'Chat message was rejected.',
            ...(result.reason
              ? { details: { reason: result.reason } }
              : {})
          }
        }

        default:
          return assertNever(decision)
      }
    } catch (error) {
      return {
        success: false,
        action: decision.action,
        status: 'failed',
        summary: formatError(error)
      }
    }
  }
}

function movementExecutionResult(
  action: 'follow_player' | 'come_to_player',
  username: string,
  result: Awaited<ReturnType<typeof comeToPlayer>>
): DecisionExecutionResult {
  if (!result.success && result.reason === 'player_not_visible') {
    return {
      success: false,
      action,
      status: 'failed',
      summary: `Player ${username} is not visible.`,
      details: { reason: result.reason }
    }
  }

  return {
    success: result.success,
    action,
    status: result.status,
    summary: result.success
      ? `${action === 'follow_player' ? 'Following' : 'Reached'} ${username}.`
      : `Could not ${action === 'follow_player' ? 'follow' : 'reach'} ${username}.`,
    ...((result.reason || result.error)
      ? {
          details: {
            ...(result.reason ? { reason: result.reason } : {}),
            ...(result.error ? { error: result.error } : {})
          }
        }
      : {})
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled decision: ${JSON.stringify(value)}`)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
