import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getCollectedItemCount } from './collection.js'

describe('collection result accounting', () => {
  it('reports the positive inventory delta after a pickup', () => {
    assert.equal(getCollectedItemCount(2, 5), 3)
  })

  it('never reports a negative collected count', () => {
    assert.equal(getCollectedItemCount(5, 2), 0)
  })
})
