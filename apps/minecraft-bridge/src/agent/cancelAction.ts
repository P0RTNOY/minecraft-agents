import type { Bot } from 'mineflayer'

import { stopAgentAction, type AgentState } from './state.js'

export function cancelAgentAction(bot: Bot, state: AgentState): void {
  const action = state.currentAction

  bot.pathfinder.setGoal(null)

  if (action === 'collect_block') {
    bot.stopDigging()
  }

  if (action === 'eat') {
    bot.deactivateItem()
  }

  stopAgentAction(state)
}
