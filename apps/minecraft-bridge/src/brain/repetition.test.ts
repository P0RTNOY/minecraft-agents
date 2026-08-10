import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  appendRecentDecision,
  assessRepetition,
  createRecentDecision,
  fingerprintBrainState
} from './repetition.js'
import type {
  AgentDecision,
  BrainInput,
  DecisionExecutionResult,
  RecentDecision
} from './types.js'

const baseInput: BrainInput = {
  perception: {
    agent: 'Alice',
    timestamp: 1,
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    nearbyBlocks: [],
    nearbyEntities: [],
    inventory: [],
    edibleItemCount: 0,
    craftableItems: [],
    nearbyCraftingTable: false,
    equippedItem: null,
    placeableBlocks: []
  },
  state: {
    agentName: 'Alice',
    status: 'idle',
    currentAction: null,
    currentGoal: null,
    actionSource: null,
    busy: false
  },
  previousActionResult: null,
  recentDecisions: [],
  shortTermGoal: {
    id: 'goal-1',
    type: 'explore_for_resources',
    description: 'Find useful resources for further progress.',
    status: 'active'
  },
  goalProgress: progress(),
  availableCapabilities: {
    observedCollectableBlocks: [],
    craftableItems: [],
    placeableBlocks: [],
    canExplore: true
  },
  memory: { recentEpisodes: [], relevantFacts: [] }
}

describe('assessRepetition', () => {
  it('rejects a duplicate say message within the recent window', () => {
    const prior = record(
      { action: 'say', message: 'Hello Steve!', reason: 'Greet Steve.' },
      baseInput
    )
    const input = { ...baseInput, recentDecisions: [prior] }

    assert.deepEqual(assessRepetition({
      action: 'say',
      message: '  hello steve!  ',
      reason: 'Greet Steve again.'
    }, input), { allowed: false, reason: 'duplicate_say' })
    assert.deepEqual(assessRepetition({
      action: 'say',
      message: 'Need any help?',
      reason: 'Ask a useful question.'
    }, input), { allowed: true })
  })

  it('rejects a third consecutive idle when the world is unchanged', () => {
    const first = record({ action: 'idle', reason: 'Wait.' }, baseInput)
    const second = record({ action: 'idle', reason: 'Still wait.' }, baseInput)
    const input = { ...baseInput, recentDecisions: [first, second] }

    assert.deepEqual(
      assessRepetition({ action: 'idle', reason: 'Continue waiting.' }, input),
      { allowed: false, reason: 'stagnant_idle' }
    )
  })

  it('permits idle after the semantic world state changes', () => {
    const priorInput = {
      ...baseInput,
      perception: { ...baseInput.perception, health: 20 }
    }
    const first = record({ action: 'idle', reason: 'Wait.' }, priorInput)
    const second = record({ action: 'idle', reason: 'Still wait.' }, priorInput)
    const changedInput = {
      ...baseInput,
      perception: { ...baseInput.perception, health: 7 },
      recentDecisions: [first, second]
    }

    assert.deepEqual(
      assessRepetition({ action: 'idle', reason: 'Pause safely.' }, changedInput),
      { allowed: true }
    )
  })

  it('permits a repeated decision after meaningful goal progress changes', () => {
    const first = record({ action: 'idle', reason: 'Wait.' }, baseInput)
    const second = record({ action: 'idle', reason: 'Still wait.' }, baseInput)
    const changedInput: BrainInput = {
      ...baseInput,
      goalProgress: progress({ hasWood: true }),
      recentDecisions: [first, second]
    }

    assert.deepEqual(
      assessRepetition({ action: 'idle', reason: 'Reassess.' }, changedInput),
      { allowed: true }
    )
  })

  it('rejects a third identical successful progress action when state is unchanged', () => {
    const decisions: AgentDecision[] = [
      { action: 'explore', reason: 'Look north.' },
      { action: 'craft_item', item: 'oak_planks', amount: 4, reason: 'Make planks.' },
      { action: 'place_block', block: 'crafting_table', reason: 'Set up.' },
      { action: 'collect_block', block: 'oak_log', reason: 'Gather wood.' }
    ]

    for (const decision of decisions) {
      const first = record(decision, baseInput)
      const second = record({ ...decision, reason: 'Reworded reason.' }, baseInput)
      const input = { ...baseInput, recentDecisions: [first, second] }

      assert.deepEqual(
        assessRepetition({ ...decision, reason: 'Another reason.' }, input),
        { allowed: false, reason: 'stagnant_action' }
      )
    }
  })

  it('permits a repeated progress action after state or capability progress', () => {
    const decision: AgentDecision = {
      action: 'craft_item',
      item: 'oak_planks',
      amount: 4,
      reason: 'Make planks.'
    }
    const first = record(decision, baseInput)
    const second = record(decision, baseInput)
    const changedInput: BrainInput = {
      ...baseInput,
      perception: {
        ...baseInput.perception,
        inventory: [{ name: 'oak_planks', count: 4 }],
        craftableItems: [{
          item: 'stick',
          recipeOutput: 4,
          maxCraftable: 8,
          requiresTable: false
        }]
      },
      recentDecisions: [first, second]
    }

    assert.deepEqual(assessRepetition(decision, changedInput), { allowed: true })
  })

  it('permits different grounded parameters and ignores failed history', () => {
    const prior = record({
      action: 'craft_item',
      item: 'oak_planks',
      amount: 4,
      reason: 'Make planks.'
    }, baseInput)
    const failed = {
      ...prior,
      result: { ...prior.result, success: false }
    }
    const input = { ...baseInput, recentDecisions: [prior, failed] }

    assert.deepEqual(assessRepetition({
      action: 'craft_item',
      item: 'stick',
      amount: 4,
      reason: 'Make sticks.'
    }, { ...baseInput, recentDecisions: [prior, prior] }), { allowed: true })
    assert.deepEqual(assessRepetition(prior.decision, input), { allowed: true })
  })
})

describe('recent decision history', () => {
  it('records the world fingerprint and keeps only four decisions', () => {
    let history: readonly RecentDecision[] = []

    for (let index = 0; index < 6; index += 1) {
      const decision = { action: 'scan', reason: `Scan ${index}.` } as const
      history = appendRecentDecision(
        history,
        createRecentDecision(baseInput, decision, resultFor(decision))
      )
    }

    assert.equal(history.length, 4)
    assert.equal(history[0]?.decision.reason, 'Scan 2.')
    assert.equal(history[3]?.worldStateFingerprint, fingerprintBrainState(baseInput))
  })
})

function record(decision: AgentDecision, input: BrainInput): RecentDecision {
  return createRecentDecision(input, decision, resultFor(decision))
}

function resultFor(decision: AgentDecision): DecisionExecutionResult {
  return {
    success: true,
    action: decision.action,
    status: 'completed',
    summary: `${decision.action} completed.`
  }
}

function progress(overrides: Partial<BrainInput['goalProgress']> = {}) {
  return {
    goalType: 'explore_for_resources' as const,
    hasWood: false,
    hasPlanks: false,
    hasSticks: false,
    hasCraftingTableItem: false,
    hasCraftingAccess: false,
    hasBasicTool: false,
    hasImprovedTool: false,
    hasSafeFood: false,
    survivalReady: true,
    usefulResourcesNearby: false,
    completed: false,
    ...overrides
  }
}
