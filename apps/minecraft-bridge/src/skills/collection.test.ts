import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Bot } from 'mineflayer'

import { createAgentState } from '../agent/state.js'
import { validateDecision } from '../brain/validateDecision.js'
import { collectBlock, getCollectedItemCount } from './collection.js'

describe('collection result accounting', () => {
  it('reports the positive inventory delta after a pickup', () => {
    assert.equal(getCollectedItemCount(2, 5), 3)
  })

  it('never reports a negative collected count', () => {
    assert.equal(getCollectedItemCount(5, 2), 0)
  })

  it('fails safely when an observed target is gone before collection starts', async () => {
    const validation = validateDecision({
      action: 'collect_block',
      block: 'bamboo',
      reason: 'Gather bamboo.'
    }, {
      selfUsername: 'Alice',
      visibleExternalPlayers: [],
      visibleNearbyBlocks: ['bamboo']
    })
    const bot = {
      findBlock: () => null
    } as unknown as Bot

    assert.equal(validation.success, true)
    assert.deepEqual(
      await collectBlock(bot, createAgentState('Alice'), 'bamboo', 'autonomous'),
      {
        success: false,
        action: 'collect_block',
        target: 'bamboo',
        status: 'failed',
        collected: 0,
        blockBroken: false,
        dropDetected: false,
        reason: 'block_not_found'
      }
    )
  })
})
