import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  bootstrapPlatformCommands,
  bootstrapRunResetCommands,
  bootstrapWorldCleanupCommands
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
      'forceload remove all',
      'difficulty easy'
    ])
  })
})
