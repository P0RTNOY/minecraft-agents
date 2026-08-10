import type { LLMRequestTiming } from '../../brain/provider.js'
import {
  serializeSocialGenerationInput,
  socialSystemInstruction,
  type SocialGenerationInput,
  type SocialProvider
} from '../provider.js'
import { SOCIAL_RESPONSE_JSON_SCHEMA } from '../response.js'

export interface OpenAISocialProviderOptions {
  baseUrl: string
  apiKey: string
  model: string
  fetchImpl?: typeof fetch
  requestTimeoutMs?: number
  now?: () => number
}

export class OpenAISocialProvider implements SocialProvider {
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly model: string
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number
  private readonly now: () => number
  private lastTiming: LLMRequestTiming | null = null

  constructor(options: OpenAISocialProviderOptions) {
    this.endpoint = createEndpoint(options.baseUrl)
    this.apiKey = requireNonEmpty(options.apiKey, 'OpenAI social API key')
    this.model = requireNonEmpty(options.model, 'OpenAI social model')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000
    this.now = options.now ?? Date.now
    if (
      !Number.isInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 1000 ||
      this.requestTimeoutMs > 60_000
    ) {
      throw new Error('OpenAI social request timeout must be from 1000 to 60000 ms.')
    }
  }

  async generate(input: SocialGenerationInput, signal?: AbortSignal): Promise<unknown> {
    this.lastTiming = null
    const startedAt = this.now()
    const cancellation = composeCancellation(signal, this.requestTimeoutMs)
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
            instructions: socialSystemInstruction(input),
            input: JSON.stringify(serializeSocialGenerationInput(input)),
            store: false,
            reasoning: { effort: 'low' },
            max_output_tokens: 256,
            text: {
              format: {
                type: 'json_schema',
                name: 'social_response',
                strict: true,
                schema: SOCIAL_RESPONSE_JSON_SCHEMA
              }
            }
          }),
          signal: cancellation.signal
        })
      } catch {
        if (cancellation.signal.aborted) throw abortedError()
        throw new Error('OpenAI social request failed.')
      }

      if (!response.ok) {
        throw new Error(`OpenAI social request failed with HTTP ${response.status}.`)
      }

      let envelope: unknown
      try {
        envelope = await response.json()
      } catch {
        if (cancellation.signal.aborted) throw abortedError()
        throw new Error('OpenAI social provider returned an invalid JSON response envelope.')
      }
      this.lastTiming = readTiming(envelope, Math.max(0, this.now() - startedAt))
      const content = readSocialContent(envelope)
      try {
        return JSON.parse(content) as unknown
      } catch {
        throw new Error('OpenAI social model response contained invalid JSON.')
      }
    } finally {
      cancellation.dispose()
    }
  }

  getLastTiming(): LLMRequestTiming | null {
    return this.lastTiming ? { ...this.lastTiming } : null
  }
}

function readTiming(envelope: unknown, totalDurationMs: number): LLMRequestTiming {
  const timing: LLMRequestTiming = { totalDurationMs }
  if (!isRecord(envelope) || !isRecord(envelope.usage)) return timing
  const promptTokens = nonNegativeInteger(envelope.usage.input_tokens)
  const outputTokens = nonNegativeInteger(envelope.usage.output_tokens)
  return {
    ...timing,
    ...(promptTokens === null ? {} : { promptTokens }),
    ...(outputTokens === null ? {} : { outputTokens })
  }
}

function readSocialContent(envelope: unknown): string {
  if (!isRecord(envelope) || envelope.status !== 'completed') {
    throw new Error('OpenAI social provider returned an incomplete response.')
  }
  if (!Array.isArray(envelope.output)) {
    throw new Error('OpenAI social provider response is missing social output.')
  }
  const outputText: string[] = []
  let refused = false
  for (const output of envelope.output) {
    if (!isRecord(output) || output.type !== 'message' || !Array.isArray(output.content)) {
      continue
    }
    for (const content of output.content) {
      if (!isRecord(content)) continue
      if (content.type === 'refusal') {
        refused = true
      } else if (
        content.type === 'output_text' &&
        typeof content.text === 'string' &&
        content.text.length > 0
      ) {
        outputText.push(content.text)
      }
    }
  }
  if (refused) throw new Error('OpenAI social provider refused the request.')
  const joined = outputText.join('')
  if (!joined.trim()) {
    throw new Error('OpenAI social provider response is missing social output.')
  }
  if (joined.length > 10_000) {
    throw new Error('OpenAI social provider output is unreasonably large.')
  }
  return joined
}

function composeCancellation(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (callerSignal?.aborted) controller.abort()
  else callerSignal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeoutMs)
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', abort)
    }
  }
}

function abortedError(): Error {
  const error = new Error('OpenAI social request was aborted.')
  error.name = 'AbortError'
  return error
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : null
}

function createEndpoint(baseUrl: string): string {
  const normalized = requireNonEmpty(baseUrl, 'OpenAI social base URL')
  const parsed = new URL(normalized)
  if (parsed.protocol !== 'https:') {
    throw new Error('OpenAI social base URL must use HTTPS.')
  }
  if (parsed.username || parsed.password) {
    throw new Error('OpenAI social base URL must not contain credentials.')
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
