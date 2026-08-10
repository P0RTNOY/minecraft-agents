export type SocialIntent =
  | 'greet'
  | 'reply'
  | 'acknowledge'
  | 'thank'
  | 'decline'
  | 'farewell'

export interface SocialResponse {
  message: string
  intent: SocialIntent
  continueConversation: boolean
}

export type SocialResponseValidationResult =
  | { success: true; response: SocialResponse }
  | { success: false; issues: string[] }

const SOCIAL_INTENTS: readonly SocialIntent[] = [
  'greet',
  'reply',
  'acknowledge',
  'thank',
  'decline',
  'farewell'
]
const INTENTS = new Set<SocialIntent>(SOCIAL_INTENTS)
const RESPONSE_KEYS = ['message', 'intent', 'continueConversation'] as const
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const OPERATOR_COMMAND = /^[A-Za-z][A-Za-z0-9_-]{0,31}\s+(?:stop|come|follow|scan|collect|inventory|talk)\b/i
const COORDINATE_TRIPLE = /(?:\b[xyz]\s*=\s*-?\d+(?:\.\d+)?\s*){3}|-?\d+(?:\.\d+)?\s*[, ]\s*-?\d+(?:\.\d+)?\s*[, ]\s*-?\d+(?:\.\d+)?/i
const URL = /(?:https?:\/\/|www\.)\S+/i
const CODE_OR_SHELL = /```|`[^`]+`|\$\(|\|\||&&|\b(?:sudo|curl|wget|chmod|node|python|npm|bash|powershell|rm\s+-)\b|\b[A-Za-z_$][\w$]*\s*\([^)]*\)/i
const PROMPT_INJECTION = /\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+(?:instructions?|messages?)\b|\b(?:reveal|show|repeat)\s+(?:the\s+)?system\s+prompt\b|\bfollow\s+(?:the\s+)?developer\s+message\b/i

export const SOCIAL_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string', minLength: 1, maxLength: 256 },
    intent: { type: 'string', enum: SOCIAL_INTENTS },
    continueConversation: { type: 'boolean' }
  },
  required: RESPONSE_KEYS,
  additionalProperties: false
} as const

export function validateSocialResponse(
  value: unknown,
  maximumMessageCharacters: number
): SocialResponseValidationResult {
  if (
    !Number.isInteger(maximumMessageCharacters) ||
    maximumMessageCharacters < 1 ||
    maximumMessageCharacters > 256
  ) {
    throw new Error('Social response message limit must be an integer from 1 to 256.')
  }
  if (!isRecord(value)) {
    return invalid('response must be an object')
  }
  const keys = Object.keys(value).sort()
  const expected = [...RESPONSE_KEYS].sort()
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    return invalid('response contains missing or unsupported fields')
  }
  if (typeof value.message !== 'string') {
    return invalid('message must be a string')
  }
  const message = value.message.trim()
  if (!message) return invalid('message must not be empty')
  if (message.length > maximumMessageCharacters) {
    return invalid('message exceeds the configured limit')
  }
  if (CONTROL_CHARACTERS.test(message)) {
    return invalid('message contains control characters')
  }
  if (message.startsWith('/') || OPERATOR_COMMAND.test(message)) {
    return invalid('message resembles an operator command')
  }
  if (COORDINATE_TRIPLE.test(message)) {
    return invalid('message contains coordinates')
  }
  if (URL.test(message)) return invalid('message contains a URL')
  if (CODE_OR_SHELL.test(message)) {
    return invalid('message contains code or shell syntax')
  }
  if (PROMPT_INJECTION.test(message)) {
    return invalid('message contains instruction-injection language')
  }
  if (typeof value.intent !== 'string' || !INTENTS.has(value.intent as SocialIntent)) {
    return invalid('intent is unsupported')
  }
  if (typeof value.continueConversation !== 'boolean') {
    return invalid('continueConversation must be boolean')
  }

  return {
    success: true,
    response: {
      message,
      intent: value.intent as SocialIntent,
      continueConversation: value.continueConversation
    }
  }
}

function invalid(issue: string): SocialResponseValidationResult {
  return { success: false, issues: [issue] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
