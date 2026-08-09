import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAX_REASON_LENGTH,
  MAX_SAY_MESSAGE_LENGTH,
  validateDecision
} from './validateDecision.js'

describe('validateDecision', () => {
  it('accepts every approved action and returns normalized decisions', () => {
    const cases = [
      [{ action: 'idle', reason: ' Wait safely. ' }, {
        action: 'idle', reason: 'Wait safely.'
      }],
      [{ action: 'scan', reason: 'Observe nearby terrain.' }, {
        action: 'scan', reason: 'Observe nearby terrain.'
      }],
      [{ action: 'follow_player', username: 'Steve_1', reason: 'Stay nearby.' }, {
        action: 'follow_player', username: 'Steve_1', reason: 'Stay nearby.'
      }],
      [{ action: 'come_to_player', username: 'Alex', reason: 'Meet Alex.' }, {
        action: 'come_to_player', username: 'Alex', reason: 'Meet Alex.'
      }],
      [{ action: 'stop', reason: 'Pause movement.' }, {
        action: 'stop', reason: 'Pause movement.'
      }],
      [{ action: 'collect_block', block: 'oak_log', reason: 'Gather wood.' }, {
        action: 'collect_block', block: 'oak_log', reason: 'Gather wood.'
      }],
      [{ action: 'say', message: 'Hello, Steve!', reason: 'Be friendly.' }, {
        action: 'say', message: 'Hello, Steve!', reason: 'Be friendly.'
      }]
    ] as const

    for (const [input, expected] of cases) {
      assert.deepEqual(validateDecision(input), {
        success: true,
        decision: expected
      })
    }
  })

  it('rejects unknown actions without casting them', () => {
    const result = validateDecision({
      action: 'run_javascript',
      code: 'process.exit()',
      reason: 'Do something unsafe.'
    })

    assert.equal(result.success, false)
    if (!result.success) {
      assert.equal(result.issues.some(issue => issue.path === 'action'), true)
    }
  })

  it('rejects missing required fields', () => {
    const result = validateDecision({
      action: 'collect_block',
      reason: 'Gather a resource.'
    })

    assert.equal(result.success, false)
    if (!result.success) {
      assert.equal(result.issues.some(issue => issue.path === 'block'), true)
    }
  })

  it('rejects fields with the wrong primitive type', () => {
    const result = validateDecision({
      action: 'follow_player',
      username: 42,
      reason: false
    })

    assert.equal(result.success, false)
    if (!result.success) {
      assert.deepEqual(
        result.issues.map(issue => issue.path).sort(),
        ['reason', 'username']
      )
    }
  })

  it('enforces reason and chat-message length limits', () => {
    const longReason = validateDecision({
      action: 'idle',
      reason: 'r'.repeat(MAX_REASON_LENGTH + 1)
    })
    const longMessage = validateDecision({
      action: 'say',
      message: 'm'.repeat(MAX_SAY_MESSAGE_LENGTH + 1),
      reason: 'Speak.'
    })

    assert.equal(longReason.success, false)
    assert.equal(longMessage.success, false)
  })

  it('rejects unsafe names, command-like chat, and extra fields', () => {
    const invalidBlock = validateDecision({
      action: 'collect_block',
      block: '../server.properties',
      reason: 'Unsafe target.'
    })
    const commandMessage = validateDecision({
      action: 'say',
      message: '/op Alice',
      reason: 'Unsafe chat command.'
    })
    const extraField = validateDecision({
      action: 'idle',
      reason: 'Wait.',
      coordinates: [0, 64, 0]
    })

    assert.equal(invalidBlock.success, false)
    assert.equal(commandMessage.success, false)
    assert.equal(extraField.success, false)
  })

  it('accepts only visible external players when context is provided', () => {
    const context = {
      selfUsername: 'Alice',
      visibleExternalPlayers: ['Steve']
    }
    const selfTarget = validateDecision({
      action: 'come_to_player',
      username: 'Alice',
      reason: 'Meet Alice.'
    }, context)
    const hallucinatedTarget = validateDecision({
      action: 'follow_player',
      username: 'Alex',
      reason: 'Follow Alex.'
    }, context)
    const externalTarget = validateDecision({
      action: 'follow_player',
      username: 'steve',
      reason: 'Follow the visible player.'
    }, context)

    assert.equal(selfTarget.success, false)
    assert.equal(hallucinatedTarget.success, false)
    assert.deepEqual(externalTarget, {
      success: true,
      decision: {
        action: 'follow_player',
        username: 'Steve',
        reason: 'Follow the visible player.'
      }
    })
  })
})
