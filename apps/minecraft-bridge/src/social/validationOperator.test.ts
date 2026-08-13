import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { connectValidationOperator } from './validationOperator.js'

describe('connectValidationOperator', () => {
  it('disconnects and removes listeners after a spawn timeout', async () => {
    const bot = new FakeOperatorBot()

    await assert.rejects(connectValidationOperator({
      host: '127.0.0.1',
      port: 25565,
      timeoutMs: 5,
      createBot: () => bot
    }), /spawn timed out/i)

    assert.equal(bot.quitCalls, 1)
    assert.equal(bot.listenerCount('spawn'), 0)
    assert.equal(bot.listenerCount('error'), 0)
    bot.emit('spawn')
    assert.equal(bot.quitCalls, 1)
  })

  it('disconnects and removes listeners after a connection error', async () => {
    const bot = new FakeOperatorBot()
    const pending = connectValidationOperator({
      host: '127.0.0.1',
      port: 25565,
      timeoutMs: 1000,
      createBot: () => bot
    })

    bot.emit('error', new Error('connection failed'))

    await assert.rejects(pending, /connection failed/)
    assert.equal(bot.quitCalls, 1)
    assert.equal(bot.listenerCount('spawn'), 0)
    assert.equal(bot.listenerCount('error'), 0)
  })
})

class FakeOperatorBot extends EventEmitter {
  quitCalls = 0

  quit(): void {
    this.quitCalls += 1
  }
}
