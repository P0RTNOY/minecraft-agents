import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseChatCommand } from './chatCommands.js'

describe('parseChatCommand', () => {
  it('recognizes the fixed developer command whitelist case-insensitively', () => {
    assert.deepEqual(parseChatCommand('  ALICE COME  '), { type: 'come' })
    assert.deepEqual(parseChatCommand('alice follow'), { type: 'follow' })
    assert.deepEqual(parseChatCommand('alice stop'), { type: 'stop' })
    assert.deepEqual(parseChatCommand('alice scan'), { type: 'scan' })
    assert.deepEqual(parseChatCommand('alice inventory'), { type: 'inventory' })
  })

  it('returns a structured collect command with a normalized block name', () => {
    assert.deepEqual(parseChatCommand('Alice collect OAK_LOG'), {
      type: 'collect',
      blockName: 'oak_log'
    })
  })

  it('keeps an empty collect target so the handler can provide useful feedback', () => {
    assert.deepEqual(parseChatCommand('alice collect '), {
      type: 'collect',
      blockName: ''
    })
  })

  it('rejects messages outside the controlled command whitelist', () => {
    assert.equal(parseChatCommand('alice eval process.exit()'), null)
    assert.equal(parseChatCommand('bob come'), null)
  })

  it('uses the configured agent name as the command prefix', () => {
    assert.deepEqual(parseChatCommand('bob scan', 'Bob'), { type: 'scan' })
    assert.equal(parseChatCommand('alice scan', 'Bob'), null)
  })
})
