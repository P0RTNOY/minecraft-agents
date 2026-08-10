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

export type ChatCommand =
  | { type: 'come' }
  | { type: 'follow' }
  | { type: 'stop' }
  | { type: 'scan' }
  | { type: 'inventory' }
  | { type: 'collect'; blockName: string }

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
  arbiter: ActionArbiter = new ActionArbiter()
): void {
  bot.on('chat', (username, message) => {
    if (username === bot.username) {
      return
    }

    console.log(`💬 ${username}: ${message}`)

    const command = parseChatCommand(message, state.agentName)
    if (!command) {
      return
    }

    markManualOverride(state)

    void arbiter.run({
      source: 'manual',
      cancel: () => cancelAgentAction(bot, state),
      execute: () => executeChatCommand(bot, state, username, command)
    }).then(result => {
      if (result.status === 'rejected') {
        console.log(`ℹ️ Manual command skipped: ${result.reason}`)
      }
    }).catch(error => {
      console.error('❌ Unhandled chat command error:', error)
    })
  })
}

async function executeChatCommand(
  bot: Bot,
  state: AgentState,
  username: string,
  command: ChatCommand
): Promise<void> {
  switch (command.type) {
    case 'come': {
      if (!bot.players[username]?.entity) {
        bot.chat(`I can't see you, ${username}.`)
        return
      }

      console.log(`🚶 ${state.agentName} is going to ${username}`)
      bot.chat(`Coming, ${username}!`)

      const result = await comeToPlayer(bot, state, username)

      if (result.success) {
        console.log(`✅ ${state.agentName} reached ${username}`)
      } else if (result.status === 'cancelled') {
        console.log('ℹ️ Previous movement goal was replaced by a new goal')
      } else {
        console.error(`❌ Failed to reach ${username}:`, result.error)
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

      console.log(`🚶 ${state.agentName} is now following ${username}`)
      bot.chat(`I'm following you, ${username}.`)
      return
    }

    case 'stop':
      stopMovement(bot, state)
      console.log(`🛑 ${state.agentName} stopped moving`)
      bot.chat('Stopped.')
      return

    case 'scan':
      console.log(formatPerception(perceive(bot)).join('\n'))
      bot.chat('I scanned the area.')
      return

    case 'inventory': {
      const inventory = inspectInventory(bot)

      console.log('\n🎒 INVENTORY REQUEST')
      console.log(formatInventory(inventory).join('\n'))
      bot.chat(`I have ${inventory.stackCount} item stack(s).`)
      return
    }

    case 'collect':
      if (!command.blockName) {
        bot.chat('Tell me which block to collect.')
        return
      }

      console.log(
        `\n⛏️ ${state.agentName} wants to collect: ${command.blockName}`
      )
      reportCollectionResult(
        bot,
        await collectBlock(bot, state, command.blockName)
      )
  }
}

function reportCollectionResult(bot: Bot, result: CollectionResult): void {
  console.log('Collection result:', result)

  if (result.success) {
    bot.chat(`Collected ${result.collected} ${result.target}.`)
    return
  }

  if (result.status === 'cancelled') {
    console.log('ℹ️ Collection movement was replaced by a new goal')
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
      console.error(`❌ Failed to collect ${result.target}:`, result.error)
      bot.chat(`I couldn't collect ${result.target}.`)
  }
}
