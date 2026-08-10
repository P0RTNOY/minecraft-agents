import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Bot } from 'mineflayer'

import { ActionArbiter } from '../agent/actionArbiter.js'
import { cancelAgentAction } from '../agent/cancelAction.js'
import { beginAgentAction, createAgentState } from '../agent/state.js'
import {
  parseChatCommand,
  registerChatCommands
} from './chatCommands.js'

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

describe('registerChatCommands', () => {
  it('lets manual stop cancel an active reflex before executing', async () => {
    const events: string[] = []
    let chatHandler!: (username: string, message: string) => void
    const bot = {
      username: 'Alice',
      pathfinder: {
        setGoal(goal: unknown) {
          events.push(`setGoal:${String(goal)}`)
        }
      },
      stopDigging() {},
      deactivateItem() {},
      chat(message: string) {
        events.push(`chat:${message}`)
      },
      on(event: string, handler: typeof chatHandler) {
        if (event === 'chat') chatHandler = handler
      }
    } as unknown as Bot
    const state = createAgentState('Alice')
    beginAgentAction(
      state,
      'fleeing',
      'flee_from_entity',
      'Escape creeper',
      'reflex'
    )
    const arbiter = new ActionArbiter()
    const cancelled = deferred<void>()
    const reflex = arbiter.run({
      source: 'reflex',
      cancel: () => {
        events.push('reflex:cancel')
        cancelAgentAction(bot, state)
        cancelled.resolve()
      },
      execute: async () => {
        await cancelled.promise
        events.push('reflex:finished')
      }
    })
    registerChatCommands(bot, state, arbiter)

    chatHandler('Steve', 'alice stop')
    await reflex
    await new Promise(resolve => setImmediate(resolve))

    assert.deepEqual(events, [
      'reflex:cancel',
      'setGoal:null',
      'reflex:finished',
      'setGoal:null',
      'chat:Stopped.'
    ])
    assert.equal(state.busy, false)
    assert.equal(state.manualOverrideVersion, 1)
  })
})

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve
  })

  return { promise, resolve: resolvePromise }
}
