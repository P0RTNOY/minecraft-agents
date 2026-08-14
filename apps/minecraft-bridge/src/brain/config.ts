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
  openaiBaseUrl: string
  openaiApiKey: string
  debugTiming: boolean
  memoryEnabled: boolean
  memoryWorldId: string
  memoryDirectory: string
  memoryEpisodeLimit: number
  memoryFactLimit: number
  debugMemory: boolean
  memoryReflection: boolean
  memoryReflectionModel: string
  socialEnabled: boolean
  socialAutoGreeting: boolean
  socialModel: string
  socialMaxTurns: number
  socialCooldownMs: number
  socialTurnTimeoutMs: number
  socialMaxMessageChars: number
  socialDirectory: string
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
const DEFAULT_MEMORY_LIMIT = 4
const MIN_MEMORY_LIMIT = 1
const MAX_MEMORY_LIMIT = 6
const MEMORY_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MEMORY_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

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
  const memoryEnabled = parseBoolean(
    environment.AGENT_MEMORY_ENABLED,
    'AGENT_MEMORY_ENABLED',
    true
  )
  const memoryWorldId = environment.AGENT_MEMORY_WORLD_ID?.trim() ||
    'local-paper'
  const memoryDirectory = environment.AGENT_MEMORY_DIR?.trim() || 'data/memory'
  const memoryEpisodeLimit = parseInterval(
    environment.AGENT_MEMORY_EPISODE_LIMIT,
    'AGENT_MEMORY_EPISODE_LIMIT',
    DEFAULT_MEMORY_LIMIT,
    MIN_MEMORY_LIMIT,
    MAX_MEMORY_LIMIT
  )
  const memoryFactLimit = parseInterval(
    environment.AGENT_MEMORY_FACT_LIMIT,
    'AGENT_MEMORY_FACT_LIMIT',
    DEFAULT_MEMORY_LIMIT,
    MIN_MEMORY_LIMIT,
    MAX_MEMORY_LIMIT
  )
  const debugMemory = parseBoolean(
    environment.AGENT_DEBUG_MEMORY,
    'AGENT_DEBUG_MEMORY',
    false
  )
  const memoryReflection = parseBoolean(
    environment.AGENT_MEMORY_REFLECTION,
    'AGENT_MEMORY_REFLECTION',
    false
  )
  const memoryReflectionModel = environment.AGENT_MEMORY_REFLECTION_MODEL === undefined
    ? 'gpt-5-mini'
    : environment.AGENT_MEMORY_REFLECTION_MODEL.trim()
  const socialEnabled = parseBoolean(
    environment.AGENT_SOCIAL_ENABLED,
    'AGENT_SOCIAL_ENABLED',
    false
  )
  const socialAutoGreeting = parseBoolean(
    environment.AGENT_SOCIAL_AUTO_GREETING,
    'AGENT_SOCIAL_AUTO_GREETING',
    false
  )
  const socialModel = environment.AGENT_SOCIAL_MODEL === undefined
    ? 'gpt-5-mini'
    : environment.AGENT_SOCIAL_MODEL.trim()
  const socialMaxTurns = parseInterval(
    environment.AGENT_SOCIAL_MAX_TURNS,
    'AGENT_SOCIAL_MAX_TURNS',
    4,
    1,
    8
  )
  const socialCooldownMs = parseInterval(
    environment.AGENT_SOCIAL_COOLDOWN_MS,
    'AGENT_SOCIAL_COOLDOWN_MS',
    60_000,
    1000,
    3_600_000
  )
  const socialTurnTimeoutMs = parseInterval(
    environment.AGENT_SOCIAL_TURN_TIMEOUT_MS,
    'AGENT_SOCIAL_TURN_TIMEOUT_MS',
    15_000,
    1000,
    60_000
  )
  const socialMaxMessageChars = parseInterval(
    environment.AGENT_SOCIAL_MAX_MESSAGE_CHARS,
    'AGENT_SOCIAL_MAX_MESSAGE_CHARS',
    180,
    32,
    256
  )
  const socialDirectory = environment.AGENT_SOCIAL_DIR?.trim() || 'data/social'
  const model = environment.LLM_MODEL?.trim() ?? ''
  const provider = environment.LLM_PROVIDER?.trim().toLowerCase() || 'ollama'
  const groqApiKey = environment.GROQ_API_KEY?.trim() ?? ''
  const openaiApiKey = environment.OPENAI_API_KEY?.trim() ?? ''

  if (!MEMORY_IDENTITY.test(memoryWorldId)) {
    throw new Error('AGENT_MEMORY_WORLD_ID is invalid.')
  }
  if (
    memoryDirectory.length === 0 ||
    memoryDirectory.length > 512 ||
    /[\u0000-\u001F\u007F]/.test(memoryDirectory)
  ) {
    throw new Error('AGENT_MEMORY_DIR is invalid.')
  }
  if (memoryReflection && memoryReflectionModel.length === 0) {
    throw new Error(
      'AGENT_MEMORY_REFLECTION_MODEL is required when memory reflection is enabled.'
    )
  }
  if (memoryReflection && !MEMORY_MODEL.test(memoryReflectionModel)) {
    throw new Error('AGENT_MEMORY_REFLECTION_MODEL is invalid.')
  }
  if (memoryReflection && openaiApiKey.length === 0) {
    throw new Error(
      'OPENAI_API_KEY is required when memory reflection is enabled.'
    )
  }
  if (!MEMORY_MODEL.test(socialModel)) {
    throw new Error('AGENT_SOCIAL_MODEL is invalid.')
  }
  if (
    socialDirectory.length === 0 ||
    socialDirectory.length > 512 ||
    /[\u0000-\u001F\u007F]/.test(socialDirectory)
  ) {
    throw new Error('AGENT_SOCIAL_DIR is invalid.')
  }
  if (socialEnabled && openaiApiKey.length === 0) {
    throw new Error(
      'OPENAI_API_KEY is required when social behavior is enabled.'
    )
  }

  if (autonomous && model.length === 0) {
    throw new Error('LLM_MODEL is required when AGENT_AUTONOMOUS=true.')
  }

  if (autonomous && provider === 'groq' && groqApiKey.length === 0) {
    throw new Error('GROQ_API_KEY is required when Groq autonomy is enabled.')
  }

  if (autonomous && provider === 'openai' && openaiApiKey.length === 0) {
    throw new Error(
      'OPENAI_API_KEY is required when OpenAI autonomy is enabled.'
    )
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
    openaiBaseUrl: environment.OPENAI_BASE_URL?.trim() ||
      'https://api.openai.com/v1',
    openaiApiKey,
    debugTiming,
    memoryEnabled,
    memoryWorldId,
    memoryDirectory,
    memoryEpisodeLimit,
    memoryFactLimit,
    debugMemory,
    memoryReflection,
    memoryReflectionModel,
    socialEnabled,
    socialAutoGreeting,
    socialModel,
    socialMaxTurns,
    socialCooldownMs,
    socialTurnTimeoutMs,
    socialMaxMessageChars,
    socialDirectory
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
