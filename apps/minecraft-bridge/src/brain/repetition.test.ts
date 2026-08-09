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
    inventory: []
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
  recentDecisions: []
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
