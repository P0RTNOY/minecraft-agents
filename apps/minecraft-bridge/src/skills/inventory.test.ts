import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatInventory, inspectInventory } from './inventory.js'

describe('inventory skill', () => {
  it('returns machine-readable stack and item totals', () => {
    const bot = {
      inventory: {
        items: () => [
          { name: 'bamboo', count: 3 },
          { name: 'oak_log', count: 2 }
        ]
      }
    }

    assert.deepEqual(inspectInventory(bot), {
      items: [
        { name: 'bamboo', count: 3 },
        { name: 'oak_log', count: 2 }
      ],
      stackCount: 2,
      itemCount: 5
    })
  })

  it('formats empty and populated inventory snapshots for logs', () => {
    assert.deepEqual(
      formatInventory({ items: [], stackCount: 0, itemCount: 0 }),
      ['- Empty']
    )
    assert.deepEqual(
      formatInventory({
        items: [{ name: 'bamboo', count: 3 }],
        stackCount: 1,
        itemCount: 3
      }),
      ['- bamboo x3']
    )
  })
})
