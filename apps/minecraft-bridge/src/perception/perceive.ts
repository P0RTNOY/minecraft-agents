import type { Bot } from 'mineflayer'
import type {
  BlockObservation,
  EntityObservation,
  PerceptionSnapshot
} from './types.js'
import { getEntityName } from '../survival/hostility.js'
import { countSafeFoodItems } from '../skills/eat.js'
import { inspectInventoryItems } from '../skills/inventory.js'
import { inspectCraftingCapabilities } from '../skills/crafting.js'
import { inspectPlaceableBlocks } from '../skills/placement.js'

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
    .map(entity => {
      const registryName = getEntityName(entity)

      return {
        id: entity.id,
        name: entity.username ?? registryName ?? entity.type,
        type: entity.type,
        category: registryName
          ? bot.registry.entitiesByName[registryName]?.category ?? null
          : null,
        distance: bot.entity.position.distanceTo(entity.position),
        position: {
          x: entity.position.x,
          y: entity.position.y,
          z: entity.position.z
        }
      }
    })
    .filter(entity => entity.distance <= entityRadius)
    .sort((a, b) => a.distance - b.distance)

  const inventoryItems = bot.inventory.items()
  const inventory = inspectInventoryItems(inventoryItems).items
  const crafting = inspectCraftingCapabilities(bot, 16, inventoryItems)

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
    inventory,
    edibleItemCount: countSafeFoodItems(bot, inventory),
    ...crafting,
    equippedItem: bot.heldItem?.name ?? null,
    placeableBlocks: inspectPlaceableBlocks(bot, inventoryItems)
  }
}
