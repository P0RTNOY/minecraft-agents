import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Item } from 'prismarine-item'

export interface HarvestToolSelection {
  required: boolean
  item: Item | null
  requiredTool: string | null
}

export function selectHarvestTool(
  bot: Bot,
  block: Block
): HarvestToolSelection {
  if (block.canHarvest(null)) {
    return { required: false, item: null, requiredTool: null }
  }

  const requiredTool = describeRequiredTool(bot, block)
  const validTools = bot.inventory.items()
    .filter(item => block.canHarvest(item.type))
    .map(item => ({
      item,
      digTime: block.digTime(
        item.type,
        false,
        false,
        false,
        item.enchants,
        bot.entity.effects
      )
    }))
    .sort((left, right) => (
      left.digTime - right.digTime ||
      left.item.name.localeCompare(right.item.name) ||
      left.item.slot - right.item.slot
    ))

  return {
    required: true,
    item: validTools[0]?.item ?? null,
    requiredTool
  }
}

function describeRequiredTool(bot: Bot, block: Block): string {
  const toolClasses = Object.entries(block.harvestTools ?? {})
    .filter(([, accepted]) => accepted)
    .map(([itemId]) => bot.registry.items[Number(itemId)]?.name)
    .filter((name): name is string => Boolean(name))
    .map(toolClass)
    .filter((name): name is string => Boolean(name))

  return [...new Set(toolClasses)].sort()[0] ?? materialTool(block.material)
}

function toolClass(itemName: string): string | null {
  if (itemName === 'shears') return 'shears'

  for (const suffix of ['pickaxe', 'shovel', 'axe', 'hoe', 'sword']) {
    if (itemName.endsWith(`_${suffix}`)) return suffix
  }

  return null
}

function materialTool(material: string | null | undefined): string {
  switch (material) {
    case 'rock': return 'pickaxe'
    case 'dirt': return 'shovel'
    case 'wood': return 'axe'
    case 'web': return 'shears'
    default: return 'appropriate_tool'
  }
}
