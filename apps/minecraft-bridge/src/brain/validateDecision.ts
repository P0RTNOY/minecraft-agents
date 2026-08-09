import type { AgentDecision } from './types.js'

export const MAX_REASON_LENGTH = 160
export const MAX_SAY_MESSAGE_LENGTH = 256
export const MAX_BLOCK_NAME_LENGTH = 64
export const MAX_USERNAME_LENGTH = 16

export interface DecisionValidationIssue {
  path: string
  message: string
}

export interface DecisionValidationContext {
  selfUsername: string
  visibleExternalPlayers: readonly string[]
  visibleNearbyBlocks: readonly string[]
}

export type DecisionValidationResult =
  | { success: true; decision: AgentDecision }
  | { success: false; issues: DecisionValidationIssue[] }

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const BLOCK_NAME = /^[a-z0-9_]+$/
const USERNAME = /^[A-Za-z0-9_]+$/

export function validateDecision(
  input: unknown,
  context?: DecisionValidationContext
): DecisionValidationResult {
  if (!isRecord(input)) {
    return failure('', 'Decision must be a JSON object.')
  }

  const issues: DecisionValidationIssue[] = []
  const action = input.action

  if (typeof action !== 'string') {
    issues.push({ path: 'action', message: 'Action must be a string.' })
    return { success: false, issues }
  }

  const reason = readBoundedString(
    input,
    'reason',
    MAX_REASON_LENGTH,
    issues
  )

  switch (action) {
    case 'idle':
    case 'scan':
    case 'stop': {
      rejectExtraFields(input, ['action', 'reason'], issues)
      if (!reason || issues.length > 0) return { success: false, issues }
      return { success: true, decision: { action, reason } }
    }

    case 'follow_player':
    case 'come_to_player': {
      let username = readBoundedString(
        input,
        'username',
        MAX_USERNAME_LENGTH,
        issues
      )
      rejectExtraFields(input, ['action', 'username', 'reason'], issues)

      if (username && !USERNAME.test(username)) {
        issues.push({
          path: 'username',
          message: 'Username may contain only letters, numbers, and underscores.'
        })
      }

      if (username && context && USERNAME.test(username)) {
        const normalizedUsername = username.toLowerCase()
        if (normalizedUsername === context.selfUsername.toLowerCase()) {
          issues.push({
            path: 'username',
            message: 'Player target must not be the agent itself.'
          })
        } else {
          const visiblePlayer = context.visibleExternalPlayers.find(
            player => player.toLowerCase() === normalizedUsername
          )
          if (!visiblePlayer) {
            issues.push({
              path: 'username',
              message: 'Player target must be a visible external player.'
            })
          } else {
            username = visiblePlayer
          }
        }
      }

      if (!reason || !username || issues.length > 0) {
        return { success: false, issues }
      }

      return { success: true, decision: { action, username, reason } }
    }

    case 'collect_block': {
      const block = readBoundedString(
        input,
        'block',
        MAX_BLOCK_NAME_LENGTH,
        issues
      )
      rejectExtraFields(input, ['action', 'block', 'reason'], issues)

      if (block && !BLOCK_NAME.test(block)) {
        issues.push({
          path: 'block',
          message: 'Block must be a lowercase Minecraft registry name.'
        })
      }

      if (
        block &&
        context &&
        BLOCK_NAME.test(block) &&
        !context.visibleNearbyBlocks.includes(block)
      ) {
        issues.push({
          path: 'block',
          message: 'Block target must be an observed nearby block.'
        })
      }

      if (!reason || !block || issues.length > 0) {
        return { success: false, issues }
      }

      return { success: true, decision: { action, block, reason } }
    }

    case 'say': {
      const message = readBoundedString(
        input,
        'message',
        MAX_SAY_MESSAGE_LENGTH,
        issues
      )
      rejectExtraFields(input, ['action', 'message', 'reason'], issues)

      if (message?.startsWith('/')) {
        issues.push({
          path: 'message',
          message: 'Chat messages must not execute Minecraft commands.'
        })
      }

      if (!reason || !message || issues.length > 0) {
        return { success: false, issues }
      }

      return { success: true, decision: { action, message, reason } }
    }

    default:
      issues.push({
        path: 'action',
        message: `Unsupported action: ${action}`
      })
      return { success: false, issues }
  }
}

function readBoundedString(
  input: Record<string, unknown>,
  field: string,
  maxLength: number,
  issues: DecisionValidationIssue[]
): string | null {
  const value = input[field]

  if (typeof value !== 'string') {
    issues.push({ path: field, message: `${field} must be a string.` })
    return null
  }

  const normalized = value.trim()

  if (normalized.length === 0) {
    issues.push({ path: field, message: `${field} must not be empty.` })
    return null
  }

  if (normalized.length > maxLength) {
    issues.push({
      path: field,
      message: `${field} must be at most ${maxLength} characters.`
    })
    return null
  }

  if (CONTROL_CHARACTERS.test(normalized)) {
    issues.push({
      path: field,
      message: `${field} must not contain control characters.`
    })
    return null
  }

  return normalized
}

function rejectExtraFields(
  input: Record<string, unknown>,
  allowedFields: readonly string[],
  issues: DecisionValidationIssue[]
): void {
  const allowed = new Set(allowedFields)

  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) {
      issues.push({
        path: field,
        message: `Unexpected field: ${field}`
      })
    }
  }
}

function failure(path: string, message: string): DecisionValidationResult {
  return { success: false, issues: [{ path, message }] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
