import type { InventoryItemSnapshot } from '../skills/inventory.js'
import type { CraftableItemSnapshot } from '../skills/crafting.js'

export interface PositionSnapshot {
  x: number
  y: number
  z: number
}

export interface BlockObservation {
  name: string
  distance: number
  position: PositionSnapshot
}

export interface EntityObservation {
  id: number
  name: string
  type: string
  category: string | null
  distance: number
  position: PositionSnapshot
}

export interface PerceptionSnapshot {
  agent: string
  timestamp: number

  position: PositionSnapshot
  health: number
  food: number

  nearbyBlocks: BlockObservation[]
  nearbyEntities: EntityObservation[]
  inventory: InventoryItemSnapshot[]
  edibleItemCount: number
  craftableItems: CraftableItemSnapshot[]
  nearbyCraftingTable: boolean
  equippedItem: string | null
  placeableBlocks: InventoryItemSnapshot[]
}
