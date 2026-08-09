import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  serializeBrainInput,
  SYSTEM_INSTRUCTION
} from './decisionContract.js'
import type { BrainInput } from './types.js'
import { MAX_REASON_LENGTH } from './validateDecision.js'

const input: BrainInput = {
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
  recentDecisions: [{
    decision: { action: 'scan', reason: 'Check the area.' },
    result: {
      success: true,
      action: 'scan',
      status: 'completed',
      summary: 'Scan completed.'
    },
    worldStateFingerprint: 'internal-only'
  }]
}

describe('Brain decision contract', () => {
  it('uses a concise Minecraft-specific non-chatbot instruction', () => {
    const prompt = SYSTEM_INSTRUCTION.toLowerCase()

    assert.match(prompt, /autonomous.*minecraft.*survival/)
    assert.match(prompt, /not (a )?(chatbot|assistant)/)
    assert.match(prompt, /current (game )?(state|observations)/)
    assert.match(prompt, /one.*action/)
    assert.match(prompt, /do not greet/)
    assert.match(prompt, /do not (invent|fabricate).*players.*resources/)
    assert.match(prompt, /avoid.*repet/)
    assert.match(prompt, /health.*food.*0.?20/)
    assert.match(prompt, /low health.*dangerous/)
    assert.match(prompt, /reason.*very short/)
    assert.ok(SYSTEM_INSTRUCTION.length < 1_200)
    assert.equal(MAX_REASON_LENGTH, 160)
  })

  it('exposes bounded recent outcomes without internal fingerprints', () => {
    const serialized = serializeBrainInput(input) as {
      recentDecisions: unknown[]
    }
    const json = JSON.stringify(serialized.recentDecisions)

    assert.deepEqual(serialized.recentDecisions, [{
      decision: { action: 'scan', reason: 'Check the area.' },
      outcome: {
        success: true,
        status: 'completed',
        summary: 'Scan completed.'
      }
    }])
    assert.doesNotMatch(json, /internal-only/)
  })
})
