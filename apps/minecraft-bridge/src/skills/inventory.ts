export interface InventoryItemSnapshot {
  name: string
  count: number
}

export interface InventorySnapshot {
  items: InventoryItemSnapshot[]
  stackCount: number
  itemCount: number
}

interface InventoryReadable {
  inventory: {
    items(): ReadonlyArray<InventoryItemSnapshot>
  }
}

export function inspectInventory(bot: InventoryReadable): InventorySnapshot {
  return inspectInventoryItems(bot.inventory.items())
}

export function inspectInventoryItems(
  inventoryItems: ReadonlyArray<InventoryItemSnapshot>
): InventorySnapshot {
  const items = inventoryItems.map(item => ({
    name: item.name,
    count: item.count
  }))

  return {
    items,
    stackCount: items.length,
    itemCount: items.reduce((total, item) => total + item.count, 0)
  }
}

export function formatInventory(snapshot: InventorySnapshot): string[] {
  if (snapshot.items.length === 0) {
    return ['- Empty']
  }

  return snapshot.items.map(item => `- ${item.name} x${item.count}`)
}
