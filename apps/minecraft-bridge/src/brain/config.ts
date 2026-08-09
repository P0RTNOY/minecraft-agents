export interface BrainConfig {
  autonomous: boolean
  tickIntervalMs: number
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

export function loadBrainConfig(
  environment: Environment = process.env
): BrainConfig {
  const autonomous = parseBoolean(
    environment.AGENT_AUTONOMOUS,
    'AGENT_AUTONOMOUS',
    false
  )
  const tickIntervalMs = parseInterval(
    environment.AGENT_TICK_INTERVAL_MS
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

function parseInterval(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_TICK_INTERVAL_MS
  }

  if (!/^\d+$/.test(value.trim())) {
    throw new Error('AGENT_TICK_INTERVAL_MS must be an integer.')
  }

  const interval = Number(value)

  if (interval < MIN_TICK_INTERVAL_MS) {
    throw new Error(
      `AGENT_TICK_INTERVAL_MS must be at least ${MIN_TICK_INTERVAL_MS}.`
    )
  }

  if (interval > MAX_TICK_INTERVAL_MS) {
    throw new Error(
      `AGENT_TICK_INTERVAL_MS must be at most ${MAX_TICK_INTERVAL_MS}.`
    )
  }

  return interval
}
