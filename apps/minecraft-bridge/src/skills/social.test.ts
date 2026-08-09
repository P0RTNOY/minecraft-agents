import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { say } from './social.js'

describe('say skill', () => {
  it('sends a bounded chat message', () => {
    const messages: string[] = []
    const bot = { chat: (message: string) => messages.push(message) }

    assert.deepEqual(say(bot, 'Hello!'), {
      success: true,
      action: 'say',
      message: 'Hello!'
    })
    assert.deepEqual(messages, ['Hello!'])
  })

  it('refuses command-like or control-character messages defensively', () => {
    const messages: string[] = []
    const bot = { chat: (message: string) => messages.push(message) }

    assert.equal(say(bot, '/op Alice').success, false)
    assert.equal(say(bot, 'hello\nworld').success, false)
    assert.deepEqual(messages, [])
  })
})
