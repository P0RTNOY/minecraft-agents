import type { Bot } from 'mineflayer'

import { ActionArbiter } from '../agent/actionArbiter.js'
import { cancelAgentAction } from '../agent/cancelAction.js'
import {
  markManualOverride,
  type AgentState
} from '../agent/state.js'
import { formatPerception } from '../perception/format.js'
import { perceive } from '../perception/perceive.js'
import {
  collectBlock,
  comeToPlayer,
  followPlayer,
  formatInventory,
  inspectInventory,
  stopMovement,
  type CollectionResult
} from '../skills/index.js'

const PLAYER_USERNAME = /^[A-Za-z0-9_]{1,16}$/

export type ChatCommand =
  | { type: 'come' }
  | { type: 'follow' }
  | { type: 'stop' }
  | { type: 'scan' }
  | { type: 'inventory' }
  | { type: 'collect'; blockName: string }

export interface ChatCommandLogger {
  log(message: string): void
  error(message: string): void
}

export interface RegisterChatCommandOptions {
  arbiter?: ActionArbiter
  isAuthorizedOperator?: (username: string) => boolean
  logger?: ChatCommandLogger
}

export function parseChatCommand(
  message: string,
  agentName = 'Alice'
): ChatCommand | null {
  const command = message.trim().toLowerCase()
  const commandPrefix = agentName.trim().toLowerCase()

  switch (command) {
    case `${commandPrefix} come`:
      return { type: 'come' }
    case `${commandPrefix} follow`:
      return { type: 'follow' }
    case `${commandPrefix} stop`:
      return { type: 'stop' }
    case `${commandPrefix} scan`:
      return { type: 'scan' }
    case `${commandPrefix} inventory`:
      return { type: 'inventory' }
  }

  if (command === `${commandPrefix} collect`) {
    return { type: 'collect', blockName: '' }
  }

  const collectPrefix = `${commandPrefix} collect `
  if (command.startsWith(collectPrefix)) {
    return {
      type: 'collect',
      blockName: command.slice(collectPrefix.length).trim()
    }
  }

  return null
}

export function registerChatCommands(
  bot: Bot,
  state: AgentState,
  options: RegisterChatCommandOptions = {}
): () => void {
  const arbiter = options.arbiter ?? new ActionArbiter()
  const isAuthorizedOperator = options.isAuthorizedOperator ?? (() => true)
  const logger = options.logger ?? console
  const onChat = (username: string, message: string) => {
    if (
      username.toLowerCase() === bot.username.toLowerCase() ||
      !isAuthorizedOperator(username)
    ) return

    const command = parseChatCommand(message, state.agentName)
    if (!command) return
    logger.log(`💬 ${username}: ${message}`)

    markManualOverride(state)

    void arbiter.run({
      source: 'manual',
      cancel: () => cancelAgentAction(bot, state),
      execute: () => executeChatCommand(
        bot,
        state,
        username,
        command,
        logger
      )
    }).then(result => {
      if (result.status === 'rejected') {
        logger.log(`ℹ️ Manual command skipped: ${result.reason}`)
      }
    }).catch(error => {
      logger.error(`❌ Unhandled chat command error: ${safeError(error)}`)
    })
  }
  bot.on('chat', onChat)
  return () => bot.off('chat', onChat)
}

export function createOperatorAuthorizer(
  operatorUsernames: readonly string[],
  agentUsernames: readonly string[]
): (username: string) => boolean {
  const operators = normalizedNames(operatorUsernames)
  const agents = normalizedNames(agentUsernames)
  return username => {
    if (!PLAYER_USERNAME.test(username)) return false
    const normalized = username.toLowerCase()
    return !agents.has(normalized) && (
      operators.size === 0 || operators.has(normalized)
    )
  }
}

async function executeChatCommand(
  bot: Bot,
  state: AgentState,
  username: string,
  command: ChatCommand,
  logger: ChatCommandLogger
): Promise<void> {
  switch (command.type) {
    case 'come': {
      if (!bot.players[username]?.entity) {
        bot.chat(`I can't see you, ${username}.`)
        return
      }

      logger.log(`🚶 ${state.agentName} is going to ${username}`)
      bot.chat(`Coming, ${username}!`)

      const result = await comeToPlayer(bot, state, username)

      if (result.success) {
        logger.log(`✅ ${state.agentName} reached ${username}`)
      } else if (result.status === 'cancelled') {
        logger.log('ℹ️ Previous movement goal was replaced by a new goal')
      } else {
        logger.error(`❌ Failed to reach ${username}: ${result.error}`)
        bot.chat("I couldn't reach you.")
      }
      return
    }

    case 'follow': {
      const result = followPlayer(bot, state, username)

      if (!result.success) {
        bot.chat(`I can't see you, ${username}.`)
        return
      }

      logger.log(`🚶 ${state.agentName} is now following ${username}`)
      bot.chat(`I'm following you, ${username}.`)
      return
    }

    case 'stop':
      stopMovement(bot, state)
      logger.log(`🛑 ${state.agentName} stopped moving`)
      bot.chat('Stopped.')
      return

    case 'scan':
      logger.log(formatPerception(perceive(bot)).join('\n'))
      bot.chat('I scanned the area.')
      return

    case 'inventory': {
      const inventory = inspectInventory(bot)

      logger.log('\n🎒 INVENTORY REQUEST')
      logger.log(formatInventory(inventory).join('\n'))
      bot.chat(`I have ${inventory.stackCount} item stack(s).`)
      return
    }

    case 'collect':
      if (!command.blockName) {
        bot.chat('Tell me which block to collect.')
        return
      }

      logger.log(
        `\n⛏️ ${state.agentName} wants to collect: ${command.blockName}`
      )
      reportCollectionResult(
        bot,
        await collectBlock(bot, state, command.blockName),
        logger
      )
  }
}

function reportCollectionResult(
  bot: Bot,
  result: CollectionResult,
  logger: ChatCommandLogger
): void {
  logger.log(`Collection result: ${JSON.stringify(result)}`)

  if (result.success) {
    bot.chat(`Collected ${result.collected} ${result.target}.`)
    return
  }

  if (result.status === 'cancelled') {
    logger.log('ℹ️ Collection movement was replaced by a new goal')
    return
  }

  switch (result.reason) {
    case 'block_not_found':
      bot.chat(`I couldn't find ${result.target}.`)
      return
    case 'target_disappeared':
      bot.chat(`The ${result.target} disappeared before I could dig it.`)
      return
    case 'cannot_dig':
      bot.chat(`I can't dig that ${result.target} from here.`)
      return
    case 'drop_not_found':
      bot.chat(`I broke the ${result.target}, but couldn't find its drop.`)
      return
    case 'pickup_not_confirmed':
      bot.chat(`I reached the drop, but couldn't confirm the pickup.`)
      return
    default:
      logger.error(`❌ Failed to collect ${result.target}: ${result.error}`)
      bot.chat(`I couldn't collect ${result.target}.`)
  }
}

function normalizedNames(values: readonly string[]): Set<string> {
  return new Set(values.map(value => value.toLowerCase()))
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'Unknown error.'
}
