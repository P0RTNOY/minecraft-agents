import type { Bot } from 'mineflayer'

import type { AgentState } from '../agent/state.js'
import { eatFood, type EatResult } from '../skills/eat.js'
import {
  fleeFromEntity,
  type FleeResult,
  type FleeSkill
} from '../skills/flee.js'
import type { SurvivalDecision } from './types.js'

export type SurvivalExecutionResult = FleeResult | EatResult

export type SurvivalExecutor = (
  bot: Bot,
  state: AgentState,
  decision: SurvivalDecision
) => Promise<SurvivalExecutionResult>

export interface SurvivalSkillBindings {
  fleeFromEntity: FleeSkill
  eatFood: typeof eatFood
}

const defaultExecutor = createSurvivalExecutor({
  fleeFromEntity,
  eatFood
})

export function executeSurvivalDecision(
  bot: Bot,
  state: AgentState,
  decision: SurvivalDecision
): Promise<SurvivalExecutionResult> {
  return defaultExecutor(bot, state, decision)
}

export function createSurvivalExecutor(
  skills: SurvivalSkillBindings
): SurvivalExecutor {
  return (bot, state, decision) => {
    switch (decision.action) {
      case 'flee_from_entity':
        return skills.fleeFromEntity(bot, state, decision, 'reflex')
      case 'eat':
        return skills.eatFood(bot, state, 'reflex')
      default:
        return assertNever(decision)
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled survival decision: ${JSON.stringify(value)}`)
}
