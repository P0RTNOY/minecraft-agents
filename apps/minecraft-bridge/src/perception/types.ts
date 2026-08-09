import type { InventoryItemSnapshot } from '../skills/inventory.js'

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
}
