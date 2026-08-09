import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  beginAgentAction,
  createAgentState,
  finishAgentAction,
  stopAgentAction
} from './state.js'

describe('agent state', () => {
  it('starts idle with no current action or goal', () => {
    const state = createAgentState('Alice')

    assert.deepEqual(state, {
      agentName: 'Alice',
      status: 'idle',
      currentAction: null,
      currentGoal: null,
      busy: false,
      actionVersion: 0
    })
  })

  it('rejects a missing runtime agent name', () => {
    assert.throws(
      () => createAgentState(undefined as unknown as string),
      /Agent name is required/
    )
  })

  it('does not let a cancelled action clear the action that replaced it', () => {
    const state = createAgentState('Alice')
    const firstVersion = beginAgentAction(
      state,
      'moving',
      'come_to_player',
      'Reach Steve'
    )
    const secondVersion = beginAgentAction(
      state,
      'following',
      'follow_player',
      'Follow Steve'
    )

    assert.equal(finishAgentAction(state, firstVersion), false)
    assert.equal(state.status, 'following')
    assert.equal(state.currentAction, 'follow_player')
    assert.equal(state.actionVersion, secondVersion)
  })

  it('clears the current action when it completes or is stopped', () => {
    const state = createAgentState('Alice')
    const version = beginAgentAction(
      state,
      'collecting',
      'collect_block',
      'Collect bamboo'
    )

    assert.equal(finishAgentAction(state, version), true)
    assert.equal(state.status, 'idle')
    assert.equal(state.busy, false)

    beginAgentAction(state, 'moving', 'come_to_player', 'Reach Steve')
    stopAgentAction(state)

    assert.equal(state.status, 'idle')
    assert.equal(state.currentAction, null)
    assert.equal(state.currentGoal, null)
    assert.equal(state.busy, false)
  })
})
