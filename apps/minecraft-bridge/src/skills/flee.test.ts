import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'

import { createAgentState } from '../agent/state.js'
import type { FleeDecision } from '../survival/types.js'
import {
  createFleeSkill,
  type FleeNavigator
} from './flee.js'

const decision: FleeDecision = {
  action: 'flee_from_entity',
  entityId: 7,
  entityName: 'creeper',
  reason: 'Creeper is dangerously close.'
}

describe('fleeFromEntity', () => {
  it('moves to safe ground away from the grounded live hostile', async () => {
    const state = createAgentState('Alice')
    const navigation: { destination?: Vec3 } = {}
    const flee = createFleeSkill({
      prepare: () => {},
      goto: async (_bot, selected) => {
        navigation.destination = selected
        assert.equal(state.status, 'fleeing')
        assert.equal(state.actionSource, 'reflex')
      }
    })
    const bot = createBot()

    const result = await flee(bot, state, decision)

    assert.equal(result.success, true)
    assert.equal(result.status, 'completed')
    assert.equal(result.targetId, 7)
    assert.equal(result.targetName, 'creeper')
    assert.ok(navigation.destination)
    assert.ok(navigation.destination.x > bot.entity.position.x)
    assert.equal(state.busy, false)
  })

  it('fails safely when the observed hostile disappeared', async () => {
    const bot = createBot()
    delete bot.entities[decision.entityId]

    assert.deepEqual(
      await createFleeSkill(unusedNavigator())(
        bot,
        createAgentState('Alice'),
        decision
      ),
      {
        success: false,
        action: 'flee_from_entity',
        status: 'failed',
        targetId: 7,
        targetName: 'creeper',
        reason: 'entity_not_found'
      }
    )
  })

  it('rejects a mismatched entity name instead of retargeting by ID', async () => {
    const result = await createFleeSkill(unusedNavigator())(
      createBot(),
      createAgentState('Alice'),
      { ...decision, entityName: 'zombie' }
    )

    assert.equal(result.success, false)
    assert.equal(result.reason, 'entity_not_found')
  })

  it('rejects players and the agent itself as hostile targets', async () => {
    const player = entity(8, 'player', new Vec3(-2, 64, 0), 'Steve')
    const bot = createBot({ 8: player })
    const flee = createFleeSkill(unusedNavigator())

    const playerResult = await flee(bot, createAgentState('Alice'), {
      ...decision,
      entityId: 8,
      entityName: 'player'
    })
    const selfResult = await flee(bot, createAgentState('Alice'), {
      ...decision,
      entityId: bot.entity.id,
      entityName: 'player'
    })

    assert.equal(playerResult.success, false)
    assert.equal(playerResult.reason, 'target_not_hostile')
    assert.equal(selfResult.success, false)
    assert.equal(selfResult.reason, 'target_not_hostile')
  })

  it('does not start pathfinding without a safe supported destination', async () => {
    let navigationStarted = false
    const bot = createBot()
    bot.blockAt = () => null

    const result = await createFleeSkill({
      prepare: () => {
        navigationStarted = true
      },
      goto: async () => {
        navigationStarted = true
      }
    })(bot, createAgentState('Alice'), decision)

    assert.equal(result.success, false)
    assert.equal(result.reason, 'no_safe_destination')
    assert.equal(navigationStarted, false)
  })

  it('reports path replacement as cancellation', async () => {
    const cancellation = new Error('The goal was changed before completion')
    cancellation.name = 'GoalChanged'
    const result = await createFleeSkill({
      prepare: () => {},
      goto: async () => {
        throw cancellation
      }
    })(createBot(), createAgentState('Alice'), decision)

    assert.equal(result.success, false)
    assert.equal(result.status, 'cancelled')
    assert.equal(result.reason, 'goal_replaced')
  })

  it('reports route failures without leaving the agent busy', async () => {
    const state = createAgentState('Alice')
    const result = await createFleeSkill({
      prepare: () => {},
      goto: async () => {
        throw new Error('No path to the goal')
      }
    })(createBot(), state, decision)

    assert.equal(result.success, false)
    assert.equal(result.status, 'failed')
    assert.equal(result.reason, 'navigation_failed')
    assert.equal(result.error, 'No path to the goal')
    assert.equal(state.busy, false)
  })
})

function createBot(
  extraEntities: Record<number, Entity> = {}
): Bot {
  const self = entity(1, 'player', new Vec3(0, 64, 0), 'Alice')
  const creeper = entity(7, 'mob', new Vec3(-2, 64, 0), 'creeper')

  return {
    username: 'Alice',
    entity: self,
    entities: {
      [self.id]: self,
      [creeper.id]: creeper,
      ...extraEntities
    },
    registry: {
      entitiesByName: {
        creeper: { category: 'Hostile mobs' },
        zombie: { category: 'Hostile mobs' },
        player: { category: 'UNKNOWN' }
      }
    },
    blockAt: (position: Vec3) => ({
      boundingBox: position.y < 64 ? 'block' : 'empty'
    })
  } as unknown as Bot
}

function entity(
  id: number,
  type: Entity['type'],
  position: Vec3,
  name: string
): Entity {
  return {
    id,
    type,
    name,
    position,
    isValid: true
  } as Entity
}

function unusedNavigator(): FleeNavigator {
  return {
    prepare: () => {
      assert.fail('navigation must not start')
    },
    goto: async () => {
      assert.fail('navigation must not start')
    }
  }
}
