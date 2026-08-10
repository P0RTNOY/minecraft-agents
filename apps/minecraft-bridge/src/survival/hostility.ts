import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'

import type { EntityObservation } from '../perception/types.js'

export const HOSTILE_ENTITY_CATEGORY = 'Hostile mobs'

export function getEntityName(entity: Entity): string | null {
  return entity.name ?? entity.mobType?.toLowerCase() ?? null
}

export function isLiveHostileEntity(bot: Bot, entity: Entity): boolean {
  if (
    entity === bot.entity ||
    entity.type === 'player' ||
    entity.isValid === false
  ) {
    return false
  }

  const entityName = getEntityName(entity)
  if (!entityName) return false

  return bot.registry.entitiesByName[entityName]?.category ===
    HOSTILE_ENTITY_CATEGORY
}

export function isObservedHostileEntity(
  entity: EntityObservation
): boolean {
  return entity.type.toLowerCase() !== 'player' &&
    entity.category === HOSTILE_ENTITY_CATEGORY
}
