import type { BrainInput } from './types.js'
import { buildBrainSemantics } from './semantics.js'
import {
  MAX_BLOCK_NAME_LENGTH,
  MAX_REASON_LENGTH,
  MAX_SAY_MESSAGE_LENGTH,
  MAX_USERNAME_LENGTH
} from './validateDecision.js'

export const SYSTEM_INSTRUCTION = [
  'You are Alice, an autonomous inhabitant of a Minecraft world.',
  'Choose exactly one approved high-level action from the supplied world state.',
  'Your drives are to stay alive, obtain useful resources, maintain health and food, explore when safe, and interact appropriately with nearby players.',
  'Approved actions: idle, scan, follow_player(username), come_to_player(username), stop, collect_block(block), say(message).',
  'Return only one JSON object matching the requested schema. Never propose code, shell commands, coordinates, or unlisted actions.'
].join(' ')

export const DECISION_JSON_SCHEMA = {
  anyOf: [
    simpleDecisionSchema('idle'),
    simpleDecisionSchema('scan'),
    simpleDecisionSchema('stop'),
    targetedDecisionSchema('follow_player', 'username', MAX_USERNAME_LENGTH),
    targetedDecisionSchema('come_to_player', 'username', MAX_USERNAME_LENGTH),
    targetedDecisionSchema('collect_block', 'block', MAX_BLOCK_NAME_LENGTH),
    targetedDecisionSchema('say', 'message', MAX_SAY_MESSAGE_LENGTH)
  ]
} as const

export function serializeBrainInput(input: BrainInput): unknown {
  const semantics = buildBrainSemantics(input)
  const blockSummary = new Map<
    string,
    { count: number; nearestDistance: number }
  >()

  for (const block of input.perception.nearbyBlocks) {
    const current = blockSummary.get(block.name)
    if (!current) {
      blockSummary.set(block.name, {
        count: 1,
        nearestDistance: round(block.distance)
      })
      continue
    }

    current.count += 1
    current.nearestDistance = Math.min(
      current.nearestDistance,
      round(block.distance)
    )
  }

  return {
    perception: {
      self: semantics.self,
      position: {
        x: round(input.perception.position.x),
        y: round(input.perception.position.y),
        z: round(input.perception.position.z)
      },
      health: semantics.health,
      food: semantics.food,
      externalVisiblePlayers: semantics.externalVisiblePlayers,
      nearbyBlocks: [...blockSummary.entries()].map(([name, summary]) => ({
        name,
        ...summary
      })),
      nearbyEntities: semantics.nearbyEntities,
      inventory: input.perception.inventory
    },
    state: input.state,
    previousActionResult: input.previousActionResult
  }
}

function simpleDecisionSchema(action: 'idle' | 'scan' | 'stop') {
  return {
    type: 'object',
    properties: {
      action: { const: action },
      reason: { type: 'string', minLength: 1, maxLength: MAX_REASON_LENGTH }
    },
    required: ['action', 'reason'],
    additionalProperties: false
  }
}

function targetedDecisionSchema(
  action: 'follow_player' | 'come_to_player' | 'collect_block' | 'say',
  targetField: 'username' | 'block' | 'message',
  maxLength: number
) {
  return {
    type: 'object',
    properties: {
      action: { const: action },
      reason: { type: 'string', minLength: 1, maxLength: MAX_REASON_LENGTH },
      [targetField]: { type: 'string', minLength: 1, maxLength }
    },
    required: ['action', targetField, 'reason'],
    additionalProperties: false
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
