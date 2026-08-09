import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isExpectedNavigationCancellation } from './movement.js'

describe('movement cancellation', () => {
  it('recognizes Pathfinder goal replacement as expected cancellation', () => {
    const error = new Error(
      'The goal was changed before it could be completed!'
    )
    error.name = 'GoalChanged'

    assert.equal(isExpectedNavigationCancellation(error), true)
  })

  it('does not hide real navigation failures', () => {
    const error = new Error('No path to the goal!')
    error.name = 'NoPath'

    assert.equal(isExpectedNavigationCancellation(error), false)
    assert.equal(isExpectedNavigationCancellation('GoalChanged'), false)
  })
})
