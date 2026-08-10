import type { PerceptionSnapshot } from '../perception/types.js'
import {
  isObservedHostileEntity
} from './hostility.js'
import type { SurvivalDecision } from './types.js'

export const CREEPER_EMERGENCY_DISTANCE = 4
export const HOSTILE_EMERGENCY_DISTANCE = 5
export const LOW_HEALTH_THRESHOLD = 10
export const CRITICAL_FOOD_THRESHOLD = 6

export function evaluateReflex(
  perception: PerceptionSnapshot
): SurvivalDecision | null {
  const hostiles = perception.nearbyEntities
    .filter(isObservedHostileEntity)
    .sort(compareThreats)
  const creeper = hostiles.find(entity => (
    entity.name === 'creeper' &&
    entity.distance <= CREEPER_EMERGENCY_DISTANCE
  ))
  const closeHostile = hostiles.find(entity => (
    entity.distance <= HOSTILE_EMERGENCY_DISTANCE
  ))

  if (creeper) {
    return {
      action: 'flee_from_entity',
      entityId: creeper.id,
      entityName: creeper.name,
      reason: `Creeper at ${formatDistance(creeper.distance)}m.`
    }
  }

  if (perception.health <= LOW_HEALTH_THRESHOLD) {
    if (closeHostile) {
      return {
        action: 'flee_from_entity',
        entityId: closeHostile.id,
        entityName: closeHostile.name,
        reason: `Low health with ${closeHostile.name} at ${formatDistance(closeHostile.distance)}m.`
      }
    }
  }

  if (
    perception.food <= CRITICAL_FOOD_THRESHOLD &&
    perception.edibleItemCount > 0 &&
    !closeHostile
  ) {
    return {
      action: 'eat',
      reason: 'Food is critically low.'
    }
  }

  return null
}

function compareThreats(
  left: PerceptionSnapshot['nearbyEntities'][number],
  right: PerceptionSnapshot['nearbyEntities'][number]
): number {
  return (left.distance - right.distance) || (left.id - right.id)
}

function formatDistance(distance: number): string {
  return String(Math.round(distance * 10) / 10)
}
