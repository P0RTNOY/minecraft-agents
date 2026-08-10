import {
  DECISION_JSON_SCHEMA,
  serializeBrainInput,
  SYSTEM_INSTRUCTION
} from '../decisionContract.js'
import type { LLMProvider, LLMRequestTiming } from '../provider.js'
import type { BrainInput } from '../types.js'

export interface GroqProviderOptions {
  baseUrl: string
  apiKey: string
  model: string
  fetchImpl?: typeof fetch
  requestTimeoutMs?: number
}

const GROQ_DECISION_SCHEMA = {
  type: 'object',
  properties: {
    decision: DECISION_JSON_SCHEMA
  },
  required: ['decision'],
  additionalProperties: false
} as const

export class GroqProvider implements LLMProvider {
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly model: string
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number
  private lastTiming: LLMRequestTiming | null = null

  constructor(options: GroqProviderOptions) {
    this.endpoint = createEndpoint(options.baseUrl)
    this.apiKey = requireNonEmpty(options.apiKey, 'Groq API key')
    this.model = requireNonEmpty(options.model, 'Groq model')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000

    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1000) {
      throw new Error('Groq request timeout must be at least 1000 ms.')
    }
  }

  async decide(input: BrainInput): Promise<unknown> {
    this.lastTiming = null
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: SYSTEM_INSTRUCTION },
          { role: 'user', content: JSON.stringify(serializeBrainInput(input)) }
        ],
        stream: false,
        reasoning_effort: 'low',
        include_reasoning: false,
        temperature: 0.1,
        max_completion_tokens: 128,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'agent_decision',
            strict: true,
            schema: GROQ_DECISION_SCHEMA
          }
        }
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    })

    if (!response.ok) {
      throw new Error(`Groq request failed with HTTP ${response.status}.`)
    }

    let envelope: unknown
    try {
      envelope = await response.json()
    } catch {
      throw new Error('Groq returned an invalid JSON response envelope.')
    }

    this.lastTiming = readUsageTiming(envelope)
    const content = readMessageContent(envelope)

    let parsed: unknown
    try {
      parsed = JSON.parse(content) as unknown
    } catch {
      throw new Error('Groq model response contained invalid JSON.')
    }

    if (!isRecord(parsed) || !('decision' in parsed)) {
      throw new Error('Groq response is missing the decision object.')
    }

    return parsed.decision
  }

  getLastTiming(): LLMRequestTiming | null {
    return this.lastTiming ? { ...this.lastTiming } : null
  }
}

function readUsageTiming(envelope: unknown): LLMRequestTiming | null {
  if (!isRecord(envelope) || !isRecord(envelope.usage)) return null

  const promptTokens = readNonNegativeInteger(envelope.usage.prompt_tokens)
  const outputTokens = readNonNegativeInteger(
    envelope.usage.completion_tokens
  )
  if (promptTokens === null || outputTokens === null) return null

  return { promptTokens, outputTokens }
}

function readNonNegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0
    ? value as number
    : null
}

function readMessageContent(envelope: unknown): string {
  if (!isRecord(envelope) || !Array.isArray(envelope.choices)) {
    throw new Error('Groq response is missing message content.')
  }

  const firstChoice = envelope.choices[0]
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new Error('Groq response is missing message content.')
  }

  const content = firstChoice.message.content
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('Groq response is missing message content.')
  }

  if (content.length > 20_000) {
    throw new Error('Groq response message is unreasonably large.')
  }

  return content
}

function createEndpoint(baseUrl: string): string {
  const normalized = requireNonEmpty(baseUrl, 'Groq base URL')
  const parsed = new URL(normalized)

  if (parsed.protocol !== 'https:') {
    throw new Error('Groq base URL must use HTTPS.')
  }

  if (parsed.username || parsed.password) {
    throw new Error('Groq base URL must not contain credentials.')
  }

  return `${normalized.replace(/\/+$/, '')}/chat/completions`
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required.`)
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
