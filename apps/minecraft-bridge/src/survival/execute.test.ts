import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Bot } from 'mineflayer'

import { createAgentState } from '../agent/state.js'
import { createSurvivalExecutor } from './execute.js'

const bot = {} as Bot

describe('survival executor', () => {
  it('routes only grounded reflex decisions through survival skills', async () => {
    const calls: string[] = []
    const execute = createSurvivalExecutor({
      fleeFromEntity: async (_bot, _state, decision, source) => {
        calls.push(`flee:${decision.entityId}:${source}`)
        return {
          success: true,
          action: 'flee_from_entity',
          status: 'completed',
          targetId: decision.entityId,
          targetName: decision.entityName
        }
      },
      eatFood: async (_bot, _state, source) => {
        calls.push(`eat:${source}`)
        return {
          success: true,
          action: 'eat',
          status: 'completed',
          item: 'bread',
          foodBefore: 4,
          foodAfter: 9
        }
      }
    })
    const state = createAgentState('Alice')

    const flee = await execute(bot, state, {
      action: 'flee_from_entity',
      entityId: 42,
      entityName: 'creeper',
      reason: 'Creeper nearby.'
    })
    const eat = await execute(bot, state, {
      action: 'eat',
      reason: 'Food is critically low.'
    })

    assert.deepEqual(calls, ['flee:42:reflex', 'eat:reflex'])
    assert.equal(flee.action, 'flee_from_entity')
    assert.equal(eat.action, 'eat')
  })
})
