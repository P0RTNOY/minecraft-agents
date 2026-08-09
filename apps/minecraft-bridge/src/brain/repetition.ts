import { buildBrainSemantics } from './semantics.js'
import type {
  AgentDecision,
  BrainInput,
  DecisionExecutionResult,
  RecentDecision
} from './types.js'

export const MAX_RECENT_DECISIONS = 4

export type RepetitionAssessment =
  | { allowed: true }
  | { allowed: false; reason: 'duplicate_say' | 'stagnant_idle' }

export function assessRepetition(
  decision: AgentDecision,
  input: BrainInput
): RepetitionAssessment {
  if (decision.action === 'say') {
    const normalizedMessage = normalizeMessage(decision.message)
    const duplicate = input.recentDecisions.some(recent => (
      recent.result.success &&
      recent.decision.action === 'say' &&
      normalizeMessage(recent.decision.message) === normalizedMessage
    ))

    if (duplicate) return { allowed: false, reason: 'duplicate_say' }
  }

  if (decision.action === 'idle') {
    const currentFingerprint = fingerprintBrainState(input)
    const recent = input.recentDecisions.slice(-2)
    const stagnant = recent.length === 2 && recent.every(record => (
      record.result.success &&
      record.decision.action === 'idle' &&
      record.worldStateFingerprint === currentFingerprint
    ))

    if (stagnant) return { allowed: false, reason: 'stagnant_idle' }
  }

  return { allowed: true }
}

export function createRecentDecision(
  input: BrainInput,
  decision: AgentDecision,
  result: DecisionExecutionResult
): RecentDecision {
  return {
    decision,
    result,
    worldStateFingerprint: fingerprintBrainState(input)
  }
}

export function appendRecentDecision(
  history: readonly RecentDecision[],
  recent: RecentDecision
): readonly RecentDecision[] {
  return [...history, recent].slice(-MAX_RECENT_DECISIONS)
}

export function fingerprintBrainState(input: BrainInput): string {
  const semantics = buildBrainSemantics(input)

  return JSON.stringify({
    self: semantics.self,
    position: roundedPosition(input),
    health: semantics.health,
    food: semantics.food,
    externalVisiblePlayers: [...semantics.externalVisiblePlayers]
      .sort(compareNamedDistance),
    nearbyEntities: [...semantics.nearbyEntities].sort(compareNamedDistance),
    nearbyBlocks: input.perception.nearbyBlocks
      .map(block => ({ name: block.name, distance: round(block.distance) }))
      .sort(compareNamedDistance),
    inventory: input.perception.inventory
      .map(item => ({ name: item.name, count: item.count }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    state: input.state
  })
}

function roundedPosition(input: BrainInput) {
  return {
    x: round(input.perception.position.x),
    y: round(input.perception.position.y),
    z: round(input.perception.position.z)
  }
}

function compareNamedDistance(
  left: { name?: string; username?: string; distance: number },
  right: { name?: string; username?: string; distance: number }
): number {
  const leftName = left.name ?? left.username ?? ''
  const rightName = right.name ?? right.username ?? ''
  return leftName.localeCompare(rightName) || left.distance - right.distance
}

function normalizeMessage(message: string): string {
  return message.trim().replace(/\s+/g, ' ').toLowerCase()
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
