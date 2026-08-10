import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryEventRecorder } from './recorder.js'
import type { GoalTransition } from '../brain/goals.js'
import type {
  AgentDecision,
  DecisionExecutionResult
} from '../brain/types.js'
import type { PerceptionSnapshot } from '../perception/types.js'

const identity = { agentId: 'Alice', worldId: 'local-paper' }

describe('MemoryEventRecorder', () => {
  it('records the first useful resource in a region but not unchanged perception', () => {
    const recorder = createRecorder()
    const perception = snapshot({
      nearbyBlocks: [block('oak_log')]
    })

    const first = recorder.observeDiscovery(perception)
    const unchanged = recorder.observeDiscovery(perception)

    assert.deepEqual(first.map(item => item.type), ['resource_discovery'])
    assert.equal(first[0]?.context.resource, 'oak_log')
    assert.deepEqual(unchanged, [])
  })

  it('records first landmark, hostile, and player without chat content', () => {
    const recorder = createRecorder()
    const episodes = recorder.observeDiscovery(snapshot({
      nearbyBlocks: [block('crafting_table')],
      nearbyEntities: [
        entity('creeper', 'hostile'),
        entity('Steve', null, 'player')
      ]
    }))

    assert.deepEqual(episodes.map(item => item.type), [
      'landmark_discovery',
      'threat_encounter',
      'player_interaction'
    ])
    assert.equal(episodes[1]?.context.target, 'creeper')
    assert.equal(episodes[2]?.context.player, 'Steve')
    assert.equal(episodes.every(item => !item.summary.includes('hello')), true)
  })

  it('records exploration only after entering a new useful region', () => {
    const recorder = createRecorder()
    recorder.observeDiscovery(snapshot({ position: { x: 1, y: 64, z: 1 } }))

    const entered = recorder.observeDiscovery(snapshot({
      position: { x: 33, y: 64, z: 1 },
      nearbyBlocks: [block('bamboo', 33)]
    }))
    const repeated = recorder.observeDiscovery(snapshot({
      position: { x: 34, y: 64, z: 1 },
      nearbyBlocks: [block('bamboo', 34)]
    }))

    assert.deepEqual(entered.map(item => item.type), [
      'resource_discovery',
      'exploration_discovery'
    ])
    assert.deepEqual(repeated, [])
  })

  it('records a repeated material failure and ignores cancellation', () => {
    const recorder = createRecorder()
    const decision: AgentDecision = {
      action: 'collect_block',
      block: 'stone',
      reason: 'Model-authored text must not be stored.'
    }
    const failure = result({
      success: false,
      action: 'collect_block',
      status: 'failed',
      summary: 'Arbitrary runtime failure text.',
      details: { reason: 'missing_tool' }
    })

    assert.deepEqual(
      recorder.observeOutcome(snapshot(), snapshot(), decision, failure, null),
      []
    )
    const repeated = recorder.observeOutcome(
      snapshot(),
      snapshot(),
      decision,
      failure,
      null
    )
    assert.equal(repeated[0]?.type, 'action_failure')
    assert.equal(repeated[0]?.context.outcome, 'missing_tool')
    assert.equal(repeated[0]?.summary.includes(decision.reason), false)
    assert.equal(repeated[0]?.summary.includes(failure.summary), false)

    assert.deepEqual(recorder.observeOutcome(
      snapshot(),
      snapshot(),
      { action: 'explore', reason: 'Explore.' },
      result({
        success: false,
        action: 'explore',
        status: 'cancelled',
        summary: 'Cancelled.'
      }),
      null
    ), [])
  })

  it('records only the first successful crafted capability with confirmed inventory gain', () => {
    const recorder = createRecorder()
    const decision: AgentDecision = {
      action: 'craft_item',
      item: 'wooden_pickaxe',
      amount: 1,
      reason: 'Craft a tool.'
    }
    const before = snapshot()
    const after = snapshot({
      inventory: [{ name: 'wooden_pickaxe', count: 1 }]
    })
    const success = result({
      success: true,
      action: 'craft_item',
      status: 'completed',
      summary: 'Crafted.'
    })

    assert.equal(
      recorder.observeOutcome(before, after, decision, success, null)[0]?.type,
      'successful_craft'
    )
    assert.deepEqual(
      recorder.observeOutcome(before, after, decision, success, null),
      []
    )
    assert.deepEqual(recorder.observeOutcome(
      before,
      snapshot({ inventory: [{ name: 'oak_planks', count: 4 }] }),
      { action: 'craft_item', item: 'oak_planks', amount: 4, reason: 'Materials.' },
      success,
      null
    ), [])
  })

  it('requires confirmed craft progress instead of trusting a success flag', () => {
    const recorder = createRecorder()
    assert.deepEqual(recorder.observeOutcome(
      snapshot(),
      snapshot(),
      { action: 'craft_item', item: 'stone_axe', amount: 1, reason: 'Tool.' },
      result({
        success: true,
        action: 'craft_item',
        status: 'completed',
        summary: 'Claimed success.'
      }),
      null
    ), [])
  })

  it('records each completed goal once per region', () => {
    const recorder = createRecorder()
    const transition: GoalTransition = {
      completedGoal: {
        id: 'goal-1',
        type: 'establish_basic_resources',
        description: 'Bootstrap.',
        status: 'completed'
      },
      nextGoal: null
    }

    const first = recorder.observeOutcome(
      snapshot(),
      snapshot(),
      { action: 'idle', reason: 'Done.' },
      result(),
      transition
    )
    const duplicate = recorder.observeOutcome(
      snapshot(),
      snapshot(),
      { action: 'idle', reason: 'Done.' },
      result(),
      transition
    )

    assert.equal(first[0]?.type, 'goal_milestone')
    assert.equal(first[0]?.context.goalType, 'establish_basic_resources')
    assert.deepEqual(duplicate, [])
  })

  it('does not record idle, scan, routine materials, or priority outcomes', () => {
    const recorder = createRecorder()
    assert.deepEqual(recorder.observeOutcome(
      snapshot(),
      snapshot(),
      { action: 'idle', reason: 'Wait.' },
      result(),
      null
    ), [])
    assert.deepEqual(recorder.observeOutcome(
      snapshot(),
      snapshot(),
      { action: 'scan', reason: 'Look.' },
      result({ action: 'scan' }),
      null
    ), [])
    const priorityFailure = result({
      success: false,
      action: 'collect_block',
      status: 'failed',
      summary: 'Superseded.',
      details: { reason: 'priority_override' }
    })
    const collect: AgentDecision = {
      action: 'collect_block',
      block: 'oak_log',
      reason: 'Collect.'
    }
    recorder.observeOutcome(snapshot(), snapshot(), collect, priorityFailure, null)
    assert.deepEqual(
      recorder.observeOutcome(snapshot(), snapshot(), collect, priorityFailure, null),
      []
    )
  })

  it('combines sparse discovery and outcome episodes in one cycle', () => {
    const recorder = createRecorder()
    const before = snapshot()
    const after = snapshot({ nearbyBlocks: [block('oak_log')] })
    const episodes = recorder.observe(
      before,
      after,
      { action: 'scan', reason: 'Observe.' },
      result({ action: 'scan' }),
      null
    )

    assert.deepEqual(episodes.map(item => item.type), ['resource_discovery'])
  })
})

function createRecorder(): MemoryEventRecorder {
  let nextId = 0
  return new MemoryEventRecorder({
    identity,
    idFactory: type => `${type}-${++nextId}`
  })
}

function snapshot(
  overrides: Partial<PerceptionSnapshot> = {}
): PerceptionSnapshot {
  return {
    agent: identity.agentId,
    timestamp: 1_000,
    position: { x: 1, y: 64, z: 1 },
    health: 20,
    food: 20,
    nearbyBlocks: [],
    nearbyEntities: [],
    inventory: [],
    edibleItemCount: 0,
    craftableItems: [],
    nearbyCraftingTable: false,
    equippedItem: null,
    placeableBlocks: [],
    ...overrides
  }
}

function block(name: string, x = 1) {
  return {
    name,
    distance: 2,
    position: { x, y: 64, z: 1 }
  }
}

function entity(name: string, category: string | null, type = 'mob') {
  return {
    id: name.length,
    name,
    type,
    category,
    distance: 4,
    position: { x: 2, y: 64, z: 2 }
  }
}

function result(
  overrides: Partial<DecisionExecutionResult> = {}
): DecisionExecutionResult {
  return {
    success: true,
    action: 'idle',
    status: 'completed',
    summary: 'Completed.',
    ...overrides
  }
}
