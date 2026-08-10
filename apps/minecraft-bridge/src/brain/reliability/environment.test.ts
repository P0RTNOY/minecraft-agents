import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  bootstrapPlatformCommands,
  bootstrapRunResetCommands,
  bootstrapWorldCleanupCommands,
  isBootstrapStartState
} from './environment.js'

describe('bootstrap environment commands', () => {
  it('force-loads every chunk touched by the inclusive test volume', () => {
    assert.equal(
      bootstrapPlatformCommands().includes('forceload add -16 -16 16 16'),
      true
    )
  })

  it('clears run artifacts and reverses the complete platform setup', () => {
    assert.equal(
      bootstrapRunResetCommands()[0],
      'fill -15 200 -15 15 202 15 air'
    )
    assert.deepEqual(bootstrapWorldCleanupCommands(), [
      'fill -16 199 -16 16 202 16 air',
      'forceload remove -16 -16 16 16',
      'difficulty easy'
    ])
  })

  it('requires the exact healthy inventory, position, and support floor', () => {
    const snapshot = {
      health: 20,
      food: 20,
      position: { x: 0.5, y: 200, z: 0.5 },
      inventory: [{ name: 'oak_log', count: 3 }]
    }

    assert.equal(isBootstrapStartState(snapshot, 'stone'), true)
    assert.equal(isBootstrapStartState({
      ...snapshot,
      position: { x: 0.5, y: 199.9, z: 0.5 }
    }, 'stone'), false)
    assert.equal(isBootstrapStartState(snapshot, 'air'), false)
    assert.equal(isBootstrapStartState({
      ...snapshot,
      inventory: [{ name: 'oak_log', count: 2 }]
    }, 'stone'), false)
  })
})
