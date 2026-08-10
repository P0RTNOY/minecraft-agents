import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'

import { createAgentState } from '../agent/state.js'
import {
  createExploreSkill,
  findExplorationDestination,
  type ExploreNavigator
} from './explore.js'

describe('exploreArea', () => {
  it('selects supported terrain within the configured radius', async () => {
    const state = createAgentState('Alice')
    const navigation: { destination?: Vec3 } = {}
    const explore = createExploreSkill({
      prepare: () => {},
      goto: async (_bot, destination) => {
        navigation.destination = destination
        assert.equal(state.status, 'exploring')
        assert.equal(state.actionSource, 'autonomous')
      }
    })
    const bot = createBot()

    const result = await explore(bot, state, 12)

    assert.equal(result.success, true)
    assert.equal(result.status, 'completed')
    assert.ok(navigation.destination)
    assert.ok(horizontalDistance(bot.entity.position, navigation.destination) <= 12)
    assert.ok(horizontalDistance(bot.entity.position, navigation.destination) >= 6)
    assert.equal(state.busy, false)
  })

  it('returns no destination when the bounded terrain is unsafe', () => {
    const bot = createBot()
    bot.blockAt = position => ({
      name: position.y === 64 ? 'water' : 'stone',
      boundingBox: position.y < 64 ? 'block' : 'empty'
    }) as ReturnType<Bot['blockAt']>

    assert.equal(findExplorationDestination(bot, 12), null)
  })

  it('does not start navigation without a safe destination', async () => {
    const bot = createBot()
    bot.blockAt = () => null

    const result = await createExploreSkill(unusedNavigator())(
      bot,
      createAgentState('Alice'),
      12
    )

    assert.equal(result.success, false)
    assert.equal(result.reason, 'no_safe_destination')
  })

  it('reports path replacement as cancellation', async () => {
    const cancellation = new Error('The goal was changed before completion')
    cancellation.name = 'GoalChanged'

    const result = await createExploreSkill({
      prepare: () => {},
      goto: async () => {
        throw cancellation
      }
    })(createBot(), createAgentState('Alice'), 12)

    assert.equal(result.success, false)
    assert.equal(result.status, 'cancelled')
    assert.equal(result.reason, 'goal_replaced')
  })

  it('reports route failures without leaving the agent busy', async () => {
    const state = createAgentState('Alice')
    const result = await createExploreSkill({
      prepare: () => {},
      goto: async () => {
        throw new Error('No path to the goal')
      }
    })(createBot(), state, 12)

    assert.equal(result.success, false)
    assert.equal(result.status, 'failed')
    assert.equal(result.reason, 'navigation_failed')
    assert.equal(result.error, 'No path to the goal')
    assert.equal(state.busy, false)
  })
})

function createBot(): Bot {
  const self = {
    id: 1,
    type: 'player',
    name: 'player',
    username: 'Alice',
    position: new Vec3(0, 64, 0),
    isValid: true
  } as Entity

  return {
    username: 'Alice',
    entity: self,
    blockAt: (position: Vec3) => ({
      name: position.y < 64 ? 'stone' : 'air',
      boundingBox: position.y < 64 ? 'block' : 'empty'
    })
  } as unknown as Bot
}

function horizontalDistance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.z - right.z)
}

function unusedNavigator(): ExploreNavigator {
  return {
    prepare: () => {
      assert.fail('navigation must not start')
    },
    goto: async () => {
      assert.fail('navigation must not start')
    }
  }
}
