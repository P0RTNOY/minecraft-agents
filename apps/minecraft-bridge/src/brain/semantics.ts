import type { BrainInput } from './types.js'
import type { DecisionValidationContext } from './validateDecision.js'
import { isObservedHostileEntity } from '../survival/hostility.js'

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
  threats: {
    nearestHostile: ThreatSummary | null
    nearestCreeper: ThreatSummary | null
  }
  inventory: {
    edibleItemCount: number
    hasFood: boolean
    craftableItems: BrainInput['perception']['craftableItems']
    nearbyCraftingTable: boolean
    equippedItem: string | null
    placeableBlocks: BrainInput['perception']['placeableBlocks']
  }
  externalVisiblePlayers: Array<{ username: string; distance: number }>
  nearbyEntities: Array<{ name: string; type: string; distance: number }>
}

export interface VisibleExternalPlayer {
  username: string
  distance: number
}

interface ThreatSummary {
  name: string
  distance: number
}

export function buildBrainSemantics(input: BrainInput): BrainSemantics {
  const selfUsername = input.state.agentName
  const hostiles = input.perception.nearbyEntities
    .filter(isObservedHostileEntity)
    .sort((left, right) => (
      (left.distance - right.distance) || (left.id - right.id)
    ))
  const nearestHostile = hostiles[0] ?? null
  const nearestCreeper = hostiles.find(entity => entity.name === 'creeper') ?? null

  return {
    self: { username: selfUsername },
    health: survivalMetric(input.perception.health, 'health'),
    food: survivalMetric(input.perception.food, 'food'),
    threats: {
      nearestHostile: threatSummary(nearestHostile),
      nearestCreeper: threatSummary(nearestCreeper)
    },
    inventory: {
      edibleItemCount: input.perception.edibleItemCount,
      hasFood: input.perception.edibleItemCount > 0,
      craftableItems: input.perception.craftableItems,
      nearbyCraftingTable: input.perception.nearbyCraftingTable,
      equippedItem: input.perception.equippedItem,
      placeableBlocks: input.perception.placeableBlocks
    },
    externalVisiblePlayers: visibleExternalPlayers(
      input.perception,
      selfUsername
    ),
    nearbyEntities: input.perception.nearbyEntities
      .filter(entity => entity.type.toLowerCase() !== 'player')
      .map(entity => ({
        name: entity.name,
        type: entity.type,
        distance: round(entity.distance)
      }))
  }
}

export function visibleExternalPlayers(
  perception: BrainInput['perception'],
  selfUsername: string
): VisibleExternalPlayer[] {
  const normalizedSelf = selfUsername.toLowerCase()
  return perception.nearbyEntities
    .filter(entity => (
      entity.type.toLowerCase() === 'player' &&
      entity.name.toLowerCase() !== normalizedSelf
    ))
    .map(entity => ({
      username: entity.name,
      distance: round(entity.distance)
    }))
}

function threatSummary(
  entity: BrainInput['perception']['nearbyEntities'][number] | null
): ThreatSummary | null {
  if (!entity) return null

  return {
    name: entity.name,
    distance: round(entity.distance)
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
    ),
    visibleNearbyBlocks: [...new Set(
      input.perception.nearbyBlocks.map(block => block.name)
    )],
    craftableItems: input.perception.craftableItems,
    placeableBlocks: input.perception.placeableBlocks
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
