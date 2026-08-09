import type { BrainInput } from './types.js'
import type { DecisionValidationContext } from './validateDecision.js'

export type SurvivalStatus = 'critical' | 'low' | 'healthy'

export interface SurvivalMetric {
  current: number
  max: 20
  status: SurvivalStatus
}

export interface BrainSemantics {
  self: { username: string }
  health: SurvivalMetric
  food: SurvivalMetric
  externalVisiblePlayers: Array<{ username: string; distance: number }>
  nearbyEntities: Array<{ name: string; type: string; distance: number }>
}

export function buildBrainSemantics(input: BrainInput): BrainSemantics {
  const selfUsername = input.state.agentName
  const normalizedSelf = selfUsername.toLowerCase()

  return {
    self: { username: selfUsername },
    health: survivalMetric(input.perception.health, 'health'),
    food: survivalMetric(input.perception.food, 'food'),
    externalVisiblePlayers: input.perception.nearbyEntities
      .filter(entity => (
        entity.type.toLowerCase() === 'player' &&
        entity.name.toLowerCase() !== normalizedSelf
      ))
      .map(entity => ({
        username: entity.name,
        distance: round(entity.distance)
      })),
    nearbyEntities: input.perception.nearbyEntities
      .filter(entity => entity.type.toLowerCase() !== 'player')
      .map(entity => ({
        name: entity.name,
        type: entity.type,
        distance: round(entity.distance)
      }))
  }
}

export function buildDecisionContext(
  input: BrainInput
): DecisionValidationContext {
  const semantics = buildBrainSemantics(input)
  return {
    selfUsername: semantics.self.username,
    visibleExternalPlayers: semantics.externalVisiblePlayers.map(
      player => player.username
    )
  }
}

function survivalMetric(
  current: number,
  kind: 'health' | 'food'
): SurvivalMetric {
  const criticalMaximum = 6
  const lowMaximum = kind === 'health' ? 10 : 12
  const status: SurvivalStatus = current <= criticalMaximum
    ? 'critical'
    : current < lowMaximum
      ? 'low'
      : 'healthy'

  return { current, max: 20, status }
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
