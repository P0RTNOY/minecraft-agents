import type { PerceptionSnapshot } from './types.js'

export function formatPerception(snapshot: PerceptionSnapshot): string[] {
  const lines = [
    `\n===== 👁️ ${snapshot.agent.toUpperCase()} PERCEPTION =====`,
    `📍 Position: (${snapshot.position.x}, ${snapshot.position.y}, ${snapshot.position.z})`,
    `❤️ Health: ${snapshot.health}`,
    `🍗 Food: ${snapshot.food}`,
    '',
    '🧱 Nearby blocks:'
  ]

  if (snapshot.nearbyBlocks.length === 0) {
    lines.push('- None')
  } else {
    for (const block of snapshot.nearbyBlocks) {
      lines.push(
        `- ${block.name} | distance: ${block.distance.toFixed(1)} | ` +
        `(${block.position.x}, ${block.position.y}, ${block.position.z})`
      )
    }
  }

  lines.push('', '🐾 Nearby entities:')

  if (snapshot.nearbyEntities.length === 0) {
    lines.push('- None')
  } else {
    for (const entity of snapshot.nearbyEntities) {
      lines.push(
        `- ${entity.name} | ${entity.type} | ` +
        `distance: ${entity.distance.toFixed(1)}`
      )
    }
  }

  lines.push('', '🎒 Inventory:')

  if (snapshot.inventory.length === 0) {
    lines.push('- Empty')
  } else {
    for (const item of snapshot.inventory) {
      lines.push(`- ${item.name} x${item.count}`)
    }
  }

  lines.push('===============================\n')

  return lines
}
