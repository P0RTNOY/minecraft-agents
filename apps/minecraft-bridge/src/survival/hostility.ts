import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'

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
