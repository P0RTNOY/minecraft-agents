import type { LLMProvider } from '../provider.js'
import type { BrainInput } from '../types.js'
import {
  MAX_BLOCK_NAME_LENGTH,
  MAX_REASON_LENGTH,
  MAX_SAY_MESSAGE_LENGTH,
  MAX_USERNAME_LENGTH
} from '../validateDecision.js'

export interface OllamaProviderOptions {
  baseUrl: string
  model: string
  debugTiming?: boolean
  fetchImpl?: typeof fetch
  logger?: OllamaLogger
  requestTimeoutMs?: number
}

export interface OllamaLogger {
  log(message: string): void
}

interface OllamaTiming {
  totalDuration: number
  loadDuration: number
  promptEvalCount: number
  promptEvalDuration: number
  evalCount: number
  evalDuration: number
}

const SYSTEM_INSTRUCTION = [
  'You are Alice, an autonomous inhabitant of a Minecraft world.',
  'Choose exactly one approved high-level action from the supplied world state.',
  'Your drives are to stay alive, obtain useful resources, maintain health and food, explore when safe, and interact appropriately with nearby players.',
  'Approved actions: idle, scan, follow_player(username), come_to_player(username), stop, collect_block(block), say(message).',
  'Return only one JSON object matching the requested schema. Never propose code, shell commands, coordinates, or unlisted actions.'
].join(' ')

const DECISION_JSON_SCHEMA = {
  oneOf: [
    simpleDecisionSchema('idle'),
    simpleDecisionSchema('scan'),
    simpleDecisionSchema('stop'),
    targetedDecisionSchema('follow_player', 'username', MAX_USERNAME_LENGTH),
    targetedDecisionSchema('come_to_player', 'username', MAX_USERNAME_LENGTH),
    targetedDecisionSchema('collect_block', 'block', MAX_BLOCK_NAME_LENGTH),
    targetedDecisionSchema('say', 'message', MAX_SAY_MESSAGE_LENGTH)
  ]
} as const

export class OllamaProvider implements LLMProvider {
  private readonly endpoint: string
  private readonly model: string
  private readonly debugTiming: boolean
  private readonly fetchImpl: typeof fetch
  private readonly logger: OllamaLogger
  private readonly requestTimeoutMs: number

  constructor(options: OllamaProviderOptions) {
    this.endpoint = createEndpoint(options.baseUrl)
    this.model = requireNonEmpty(options.model, 'Ollama model')
    this.debugTiming = options.debugTiming ?? false
    this.fetchImpl = options.fetchImpl ?? fetch
    this.logger = options.logger ?? console
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000

    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1000) {
      throw new Error('Ollama request timeout must be at least 1000 ms.')
    }
  }

  async decide(input: BrainInput): Promise<unknown> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: SYSTEM_INSTRUCTION },
          { role: 'user', content: JSON.stringify(compactBrainInput(input)) }
        ],
        stream: false,
        think: false,
        keep_alive: '10m',
        format: DECISION_JSON_SCHEMA,
        options: {
          temperature: 0.1,
          num_predict: 128,
          num_ctx: 4096
        }
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    })

    if (!response.ok) {
      throw new Error(`Ollama request failed with HTTP ${response.status}.`)
    }

    let envelope: unknown
    try {
      envelope = await response.json()
    } catch {
      throw new Error('Ollama returned an invalid JSON response envelope.')
    }

    const timing = readTiming(envelope)
    if (this.debugTiming && timing) {
      this.logger.log(formatTiming(timing))
    }

    const content = readMessageContent(envelope)

    try {
      return JSON.parse(content) as unknown
    } catch {
      throw new Error('Ollama model response contained invalid JSON.')
    }
  }
}

function readTiming(envelope: unknown): OllamaTiming | null {
  if (!isRecord(envelope)) return null

  const totalDuration = readNonNegativeNumber(envelope.total_duration)
  const loadDuration = readNonNegativeNumber(envelope.load_duration)
  const promptEvalCount = readNonNegativeNumber(envelope.prompt_eval_count)
  const promptEvalDuration = readNonNegativeNumber(
    envelope.prompt_eval_duration
  )
  const evalCount = readNonNegativeNumber(envelope.eval_count)
  const evalDuration = readNonNegativeNumber(envelope.eval_duration)

  if (
    totalDuration === null ||
    loadDuration === null ||
    promptEvalCount === null ||
    promptEvalDuration === null ||
    evalCount === null ||
    evalDuration === null
  ) {
    return null
  }

  return {
    totalDuration,
    loadDuration,
    promptEvalCount,
    promptEvalDuration,
    evalCount,
    evalDuration
  }
}

function formatTiming(timing: OllamaTiming): string {
  const tokensPerSecond = timing.evalDuration === 0
    ? 0
    : Math.round(timing.evalCount / (timing.evalDuration / 1_000_000_000))

  return [
    `🧠 LLM: ${nanosecondsToMilliseconds(timing.totalDuration)}ms total`,
    `${nanosecondsToMilliseconds(timing.loadDuration)}ms load`,
    `prompt ${timing.promptEvalCount} tok`,
    `output ${timing.evalCount} tok`,
    `${tokensPerSecond} tok/s`
  ].join(' | ')
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null
}

function nanosecondsToMilliseconds(nanoseconds: number): number {
  return Math.round(nanoseconds / 1_000_000)
}

function compactBrainInput(input: BrainInput): unknown {
  const blockSummary = new Map<string, { count: number; nearestDistance: number }>()

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
      agent: input.perception.agent,
      position: {
        x: round(input.perception.position.x),
        y: round(input.perception.position.y),
        z: round(input.perception.position.z)
      },
      health: input.perception.health,
      food: input.perception.food,
      nearbyBlocks: [...blockSummary.entries()].map(([name, summary]) => ({
        name,
        ...summary
      })),
      nearbyEntities: input.perception.nearbyEntities.map(entity => ({
        name: entity.name,
        type: entity.type,
        distance: round(entity.distance)
      })),
      inventory: input.perception.inventory
    },
    state: input.state,
    previousActionResult: input.previousActionResult
  }
}

function readMessageContent(envelope: unknown): string {
  if (!isRecord(envelope) || !isRecord(envelope.message)) {
    throw new Error('Ollama response is missing message content.')
  }

  const content = envelope.message.content
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('Ollama response is missing message content.')
  }

  if (content.length > 20_000) {
    throw new Error('Ollama response message is unreasonably large.')
  }

  return content
}

function createEndpoint(baseUrl: string): string {
  const normalized = requireNonEmpty(baseUrl, 'Ollama base URL')
  const parsed = new URL(normalized)

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Ollama base URL must use HTTP or HTTPS.')
  }

  if (parsed.username || parsed.password) {
    throw new Error('Ollama base URL must not contain credentials.')
  }

  return `${normalized.replace(/\/+$/, '')}/api/chat`
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required.`)
  return normalized
}

function round(value: number): number {
  return Math.round(value * 10) / 10
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
