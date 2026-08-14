import {
  DECISION_JSON_SCHEMA,
  serializeBrainInput,
  systemInstructionFor
} from '../decisionContract.js'
import {
  abortError,
  composeCancellation,
  releaseUnusedResponseBody
} from '../cancellation.js'
import type { LLMProvider, LLMRequestTiming } from '../provider.js'
import type { BrainInput } from '../types.js'

export interface OpenAIProviderOptions {
  baseUrl: string
  apiKey: string
  model: string
  fetchImpl?: typeof fetch
  requestTimeoutMs?: number
}

const OPENAI_DECISION_SCHEMA = {
  type: 'object',
  properties: {
    decision: DECISION_JSON_SCHEMA
  },
  required: ['decision'],
  additionalProperties: false
} as const

export class OpenAIProvider implements LLMProvider {
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly model: string
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number
  private lastTiming: LLMRequestTiming | null = null

  constructor(options: OpenAIProviderOptions) {
    this.endpoint = createEndpoint(options.baseUrl)
    this.apiKey = requireNonEmpty(options.apiKey, 'OpenAI API key')
    this.model = requireNonEmpty(options.model, 'OpenAI model')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000

    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1000) {
      throw new Error('OpenAI request timeout must be at least 1000 ms.')
    }
  }

  async decide(input: BrainInput, signal?: AbortSignal): Promise<unknown> {
    this.lastTiming = null
    const cancellation = composeCancellation([signal], this.requestTimeoutMs)
    try {
      let response: Response
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: this.model,
            instructions: systemInstructionFor(input.state.agentName),
            input: JSON.stringify(serializeBrainInput(input)),
            store: false,
            reasoning: { effort: 'low' },
            max_output_tokens: 512,
            text: {
              format: {
                type: 'json_schema',
                name: 'agent_decision',
                strict: true,
                schema: OPENAI_DECISION_SCHEMA
              }
            }
          }),
          signal: cancellation.signal
        })
      } catch {
        if (cancellation.signal.aborted) {
          throw abortError('OpenAI request was aborted.')
        }
        throw new Error('OpenAI request failed.')
      }

      if (!response.ok) {
        releaseUnusedResponseBody(response)
        throw new Error(`OpenAI request failed with HTTP ${response.status}.`)
      }

      let envelope: unknown
      try {
        envelope = await response.json()
      } catch {
        if (cancellation.signal.aborted) {
          throw abortError('OpenAI request was aborted.')
        }
        throw new Error('OpenAI returned an invalid JSON response envelope.')
      }

      this.lastTiming = readUsageTiming(envelope)
      const content = readDecisionContent(envelope)

      let parsed: unknown
      try {
        parsed = JSON.parse(content) as unknown
      } catch {
        throw new Error('OpenAI model response contained invalid JSON.')
      }

      if (!isRecord(parsed) || !('decision' in parsed)) {
        throw new Error('OpenAI response is missing the decision object.')
      }

      return parsed.decision
    } finally {
      cancellation.dispose()
    }
  }

  getLastTiming(): LLMRequestTiming | null {
    return this.lastTiming ? { ...this.lastTiming } : null
  }
}

function readUsageTiming(envelope: unknown): LLMRequestTiming | null {
  if (!isRecord(envelope) || !isRecord(envelope.usage)) return null

  const promptTokens = readNonNegativeInteger(envelope.usage.input_tokens)
  const outputTokens = readNonNegativeInteger(envelope.usage.output_tokens)
  if (promptTokens === null || outputTokens === null) return null

  return { promptTokens, outputTokens }
}

function readDecisionContent(envelope: unknown): string {
  if (!isRecord(envelope)) {
    throw new Error('OpenAI response is missing decision output.')
  }

  if (envelope.status !== 'completed') {
    throw new Error('OpenAI returned an incomplete response.')
  }

  if (!Array.isArray(envelope.output)) {
    throw new Error('OpenAI response is missing decision output.')
  }

  const outputText: string[] = []
  let refused = false

  for (const output of envelope.output) {
    if (!isRecord(output) || output.type !== 'message') continue
    if (!Array.isArray(output.content)) continue

    for (const content of output.content) {
      if (!isRecord(content)) continue
      if (content.type === 'refusal') {
        refused = true
        continue
      }
      if (
        content.type === 'output_text' &&
        typeof content.text === 'string' &&
        content.text.length > 0
      ) {
        outputText.push(content.text)
      }
    }
  }

  if (refused) {
    throw new Error('OpenAI refused to produce a decision.')
  }

  const joined = outputText.join('')
  if (joined.trim().length === 0) {
    throw new Error('OpenAI response is missing decision output.')
  }
  if (joined.length > 20_000) {
    throw new Error('OpenAI response decision output is unreasonably large.')
  }

  return joined
}

function readNonNegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0
    ? value as number
    : null
}

function createEndpoint(baseUrl: string): string {
  const normalized = requireNonEmpty(baseUrl, 'OpenAI base URL')
  const parsed = new URL(normalized)

  if (parsed.protocol !== 'https:') {
    throw new Error('OpenAI base URL must use HTTPS.')
  }
  if (parsed.username || parsed.password) {
    throw new Error('OpenAI base URL must not contain credentials.')
  }

  return `${normalized.replace(/\/+$/, '')}/responses`
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required.`)
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
