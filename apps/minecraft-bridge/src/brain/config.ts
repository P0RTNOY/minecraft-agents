export interface BrainConfig {
  autonomous: boolean
  tickIntervalMs: number
  reflexIntervalMs: number
  explorationRadius: number
  provider: string
  model: string
  ollamaBaseUrl: string
  groqBaseUrl: string
  groqApiKey: string
  debugTiming: boolean
}

type Environment = Readonly<Record<string, string | undefined>>

const DEFAULT_TICK_INTERVAL_MS = 5000
const MIN_TICK_INTERVAL_MS = 1000
const MAX_TICK_INTERVAL_MS = 300_000
const DEFAULT_REFLEX_INTERVAL_MS = 250
const MIN_REFLEX_INTERVAL_MS = 100
const MAX_REFLEX_INTERVAL_MS = 500
const DEFAULT_EXPLORATION_RADIUS = 24
const MIN_EXPLORATION_RADIUS = 8
const MAX_EXPLORATION_RADIUS = 32

export function loadBrainConfig(
  environment: Environment = process.env
): BrainConfig {
  const autonomous = parseBoolean(
    environment.AGENT_AUTONOMOUS,
    'AGENT_AUTONOMOUS',
    false
  )
  const tickIntervalMs = parseInterval(
    environment.AGENT_TICK_INTERVAL_MS,
    'AGENT_TICK_INTERVAL_MS',
    DEFAULT_TICK_INTERVAL_MS,
    MIN_TICK_INTERVAL_MS,
    MAX_TICK_INTERVAL_MS
  )
  const reflexIntervalMs = parseInterval(
    environment.AGENT_REFLEX_INTERVAL_MS,
    'AGENT_REFLEX_INTERVAL_MS',
    DEFAULT_REFLEX_INTERVAL_MS,
    MIN_REFLEX_INTERVAL_MS,
    MAX_REFLEX_INTERVAL_MS
  )
  const explorationRadius = parseInterval(
    environment.AGENT_EXPLORATION_RADIUS,
    'AGENT_EXPLORATION_RADIUS',
    DEFAULT_EXPLORATION_RADIUS,
    MIN_EXPLORATION_RADIUS,
    MAX_EXPLORATION_RADIUS
  )
  const debugTiming = parseBoolean(
    environment.LLM_DEBUG_TIMING,
    'LLM_DEBUG_TIMING',
    false
  )
  const model = environment.LLM_MODEL?.trim() ?? ''
  const provider = environment.LLM_PROVIDER?.trim().toLowerCase() || 'ollama'
  const groqApiKey = environment.GROQ_API_KEY?.trim() ?? ''

  if (autonomous && model.length === 0) {
    throw new Error('LLM_MODEL is required when AGENT_AUTONOMOUS=true.')
  }

  if (autonomous && provider === 'groq' && groqApiKey.length === 0) {
    throw new Error('GROQ_API_KEY is required when Groq autonomy is enabled.')
  }

  return {
    autonomous,
    tickIntervalMs,
    reflexIntervalMs,
    explorationRadius,
    provider,
    model,
    ollamaBaseUrl: environment.OLLAMA_BASE_URL?.trim() ||
      'http://127.0.0.1:11434',
    groqBaseUrl: environment.GROQ_BASE_URL?.trim() ||
      'https://api.groq.com/openai/v1',
    groqApiKey,
    debugTiming
  }
}

function parseBoolean(
  value: string | undefined,
  name: string,
  defaultValue: boolean
): boolean {
  if (value === undefined || value.trim() === '') {
    return defaultValue
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false

  throw new Error(`${name} must be either true or false.`)
}

function parseInterval(
  value: string | undefined,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue
  }

  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be an integer.`)
  }

  const interval = Number(value)

  if (interval < minimum) {
    throw new Error(`${name} must be at least ${minimum}.`)
  }

  if (interval > maximum) {
    throw new Error(`${name} must be at most ${maximum}.`)
  }

  return interval
}
