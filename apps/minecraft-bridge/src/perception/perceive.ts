import type { Bot } from 'mineflayer'
import type {
  BlockObservation,
  EntityObservation,
  PerceptionSnapshot
} from './types.js'
import { inspectInventory } from '../skills/inventory.js'

export function perceive(
  bot: Bot,
  blockRadius = 8,
  entityRadius = 20
): PerceptionSnapshot {
  const blockPositions = bot.findBlocks({
    matching: () => true,
    maxDistance: blockRadius,
    count: 20
  })

  const nearbyBlocks: BlockObservation[] = []

  for (const position of blockPositions) {
    const block = bot.blockAt(position)

    if (!block || block.name === 'air') {
      continue
    }

    nearbyBlocks.push({
      name: block.name,
      distance: bot.entity.position.distanceTo(position),
      position: {
        x: position.x,
        y: position.y,
        z: position.z
      }
    })
  }

  const nearbyEntities: EntityObservation[] = Object.values(bot.entities)
    .filter(entity => entity !== bot.entity)
    .map(entity => ({
      id: entity.id,
      name: entity.username ?? entity.name ?? entity.type,
      type: entity.type,
      distance: bot.entity.position.distanceTo(entity.position),
      position: {
        x: entity.position.x,
        y: entity.position.y,
        z: entity.position.z
      }
    }))
    .filter(entity => entity.distance <= entityRadius)
    .sort((a, b) => a.distance - b.distance)

  const inventory = inspectInventory(bot).items

  return {
    agent: bot.username,
    timestamp: Date.now(),

    position: {
      x: bot.entity.position.x,
      y: bot.entity.position.y,
      z: bot.entity.position.z
    },

    health: bot.health,
    food: bot.food,

    nearbyBlocks,
    nearbyEntities,
    inventory
  }
}
