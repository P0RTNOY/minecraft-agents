import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DECISION_JSON_SCHEMA,
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
  recentDecisions: [{
    decision: { action: 'scan', reason: 'Check the area.' },
    result: {
      success: true,
      action: 'scan',
      status: 'completed',
      summary: 'Scan completed.'
    },
    worldStateFingerprint: 'internal-only'
  }],
  shortTermGoal: {
    id: 'goal-1',
    type: 'establish_basic_resources',
    description: 'Establish basic crafting capability.',
    status: 'active'
  },
  goalProgress: {
    goalType: 'establish_basic_resources',
    hasWood: true,
    hasPlanks: false,
    hasSticks: false,
    hasCraftingTableItem: false,
    hasCraftingAccess: false,
    hasBasicTool: false,
    hasImprovedTool: false,
    hasSafeFood: false,
    survivalReady: true,
    usefulResourcesNearby: false,
    completed: false
  },
  availableCapabilities: {
    observedCollectableBlocks: [],
    craftableItems: [],
    placeableBlocks: [],
    canExplore: true
  }
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
    assert.match(prompt, /active short-term goal/)
    assert.match(prompt, /change.*goal progress/)
    assert.match(prompt, /avoid idle.*grounded action/i)
    assert.match(prompt, /exact target.*availablecapabilities/i)
    assert.match(prompt, /do not (invent|fabricate).*items.*blocks.*players.*recipes/i)
    assert.match(prompt, /do not repeat.*no progress/i)
    assert.doesNotMatch(prompt, /log.*plank.*crafting table.*tool/i)
    assert.doesNotMatch(prompt, /if you have (a )?log/i)
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

  it('exposes compact application-owned goal progress and capabilities', () => {
    const serialized = serializeBrainInput(input) as {
      shortTermGoal: unknown
      goalProgress: unknown
      availableCapabilities: unknown
    }

    assert.deepEqual(serialized.shortTermGoal, input.shortTermGoal)
    assert.deepEqual(serialized.goalProgress, input.goalProgress)
    assert.deepEqual(
      serialized.availableCapabilities,
      input.availableCapabilities
    )
  })

  it('keeps survival actions out of the deliberate Brain vocabulary', () => {
    const contract = JSON.stringify(DECISION_JSON_SCHEMA)

    assert.doesNotMatch(contract, /flee_from_entity/)
    assert.doesNotMatch(contract, /"eat"/)
    assert.doesNotMatch(SYSTEM_INSTRUCTION, /flee_from_entity/)
  })

  it('allows bounded exploration without accepting model-authored coordinates', () => {
    const contract = JSON.stringify(DECISION_JSON_SCHEMA)

    assert.match(contract, /\"explore\"/)
    assert.doesNotMatch(contract, /coordinates|destination|position/)
    assert.match(SYSTEM_INSTRUCTION, /explore/)
  })

  it('bounds grounded crafting to a registry name and a small integer amount', () => {
    const contract = JSON.stringify(DECISION_JSON_SCHEMA)

    assert.match(contract, /\"craft_item\"/)
    assert.match(contract, /\"amount\"/)
    assert.match(contract, /\"maximum\":64/)
    assert.match(contract, /\"type\":\"integer\"/)
    assert.match(SYSTEM_INSTRUCTION, /craft_item/)
  })

  it('allows inventory-grounded placement without model coordinates', () => {
    const contract = JSON.stringify(DECISION_JSON_SCHEMA)

    assert.match(contract, /\"place_block\"/)
    assert.match(SYSTEM_INSTRUCTION, /place_block/)
    assert.doesNotMatch(contract, /coordinates|destination|position/)
  })
})
