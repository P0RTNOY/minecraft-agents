import { readFile as readFileFromDisk } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

export interface AgentDefinition {
  id: string
  username: string
  autonomous?: boolean
  memoryEnabled?: boolean
}

export interface AgentConfigDocument {
  schemaVersion: 1
  agents: readonly AgentDefinition[]
}

export interface AgentConfiguration {
  agents: readonly AgentDefinition[]
  maxProviderConcurrency: number
  brainStaggerMs: number
  operatorUsernames: readonly string[]
  minecraft: {
    host: string
    port: number
    spawnTimeoutMs: number
  }
}

interface LoadAgentConfigurationOptions {
  appDirectory?: string
  readFile?: (path: string) => Promise<string>
}

type Environment = Readonly<Record<string, string | undefined>>

const AGENT_ID = /^[a-z][a-z0-9_-]{0,31}$/
const USERNAME = /^[A-Za-z0-9_]{1,16}$/
const DEFAULT_CONFIG_PATH = 'configs/agents.json'

export async function loadAgentConfiguration(
  environment: Environment = process.env,
  options: LoadAgentConfigurationOptions = {}
): Promise<AgentConfiguration> {
  const appDirectory = resolve(options.appDirectory ?? resolve(__dirname, '../../../..'))
  const configPath = resolveConfigPath(
    appDirectory,
    environment.AGENT_CONFIG_PATH?.trim() || DEFAULT_CONFIG_PATH
  )
  const readFile = options.readFile ?? (async path => readFileFromDisk(path, 'utf8'))
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(configPath)) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Agent configuration contains malformed JSON.')
    }
    throw error
  }
  const document = decodeAgentConfigDocument(parsed)

  return {
    agents: selectAgents(document.agents, environment.AGENTS),
    maxProviderConcurrency: parseInteger(
      environment.AGENT_LLM_MAX_CONCURRENCY,
      'AGENT_LLM_MAX_CONCURRENCY',
      2,
      1,
      8
    ),
    brainStaggerMs: parseInteger(
      environment.AGENT_BRAIN_STAGGER_MS,
      'AGENT_BRAIN_STAGGER_MS',
      1000,
      0,
      60_000
    ),
    operatorUsernames: parseOperators(environment.AGENT_OPERATOR_USERNAMES),
    minecraft: {
      host: parseHost(environment.MINECRAFT_HOST),
      port: parseInteger(environment.MINECRAFT_PORT, 'MINECRAFT_PORT', 25_565, 1, 65_535),
      spawnTimeoutMs: parseInteger(
        environment.AGENT_SPAWN_TIMEOUT_MS,
        'AGENT_SPAWN_TIMEOUT_MS',
        30_000,
        1000,
        120_000
      )
    }
  }
}

export function decodeAgentConfigDocument(value: unknown): AgentConfigDocument {
  const document = requireRecord(value, 'Agent configuration')
  rejectExtraFields(document, ['schemaVersion', 'agents'], 'Agent configuration')
  if (document.schemaVersion !== 1) {
    throw new Error('Unsupported agent configuration schema version.')
  }
  if (!Array.isArray(document.agents) || document.agents.length === 0) {
    throw new Error('Agent configuration must contain at least one agent.')
  }

  const ids = new Set<string>()
  const usernames = new Set<string>()
  const agents = document.agents.map((candidate, index) => {
    const record = requireRecord(candidate, `Agent ${index}`)
    rejectExtraFields(
      record,
      ['id', 'username', 'autonomous', 'memoryEnabled'],
      `Agent ${index}`
    )
    if (typeof record.id !== 'string' || !AGENT_ID.test(record.id)) {
      throw new Error(`Agent ${index} has an invalid agent id.`)
    }
    if (typeof record.username !== 'string' || !USERNAME.test(record.username)) {
      throw new Error(`Agent ${index} has an invalid username.`)
    }
    if (record.autonomous !== undefined && typeof record.autonomous !== 'boolean') {
      throw new Error(`Agent ${index} autonomous must be boolean.`)
    }
    if (
      record.memoryEnabled !== undefined &&
      typeof record.memoryEnabled !== 'boolean'
    ) {
      throw new Error(`Agent ${index} memoryEnabled must be boolean.`)
    }

    const normalizedId = record.id.toLowerCase()
    const normalizedUsername = record.username.toLowerCase()
    if (ids.has(normalizedId)) throw new Error(`Duplicate agent id: ${record.id}.`)
    if (usernames.has(normalizedUsername)) {
      throw new Error(`Duplicate agent username: ${record.username}.`)
    }
    ids.add(normalizedId)
    usernames.add(normalizedUsername)

    return {
      id: record.id,
      username: record.username,
      ...(record.autonomous === undefined ? {} : { autonomous: record.autonomous }),
      ...(record.memoryEnabled === undefined
        ? {}
        : { memoryEnabled: record.memoryEnabled })
    }
  })

  return { schemaVersion: 1, agents }
}

function selectAgents(
  configured: readonly AgentDefinition[],
  encodedSelection: string | undefined
): AgentDefinition[] {
  const selection = encodedSelection?.trim() || 'alice'
  if (selection.toLowerCase() === 'all') return configured.map(agent => ({ ...agent }))
  const ids = selection.split(',').map(value => value.trim()).filter(Boolean)
  if (ids.length === 0) throw new Error('AGENTS must select at least one agent.')

  const seen = new Set<string>()
  return ids.map(id => {
    const normalized = id.toLowerCase()
    if (seen.has(normalized)) throw new Error(`Duplicate selected agent: ${id}.`)
    seen.add(normalized)
    const agent = configured.find(candidate => candidate.id.toLowerCase() === normalized)
    if (!agent) throw new Error(`Unknown agent id selected by AGENTS: ${id}.`)
    return { ...agent }
  })
}

function parseOperators(value: string | undefined): string[] {
  if (!value?.trim()) return []
  const seen = new Set<string>()
  return value.split(',').map(operator => operator.trim()).filter(Boolean).map(operator => {
    if (!USERNAME.test(operator)) {
      throw new Error(`AGENT_OPERATOR_USERNAMES contains invalid username: ${operator}.`)
    }
    const normalized = operator.toLowerCase()
    if (seen.has(normalized)) {
      throw new Error(`AGENT_OPERATOR_USERNAMES contains duplicate username: ${operator}.`)
    }
    seen.add(normalized)
    return operator
  })
}

function parseHost(value: string | undefined): string {
  const host = value?.trim() || 'localhost'
  if (host.length > 253 || /[\u0000-\u0020\u007f]/.test(host)) {
    throw new Error('MINECRAFT_HOST is invalid.')
  }
  return host
}

function resolveConfigPath(appDirectory: string, configuredPath: string): string {
  if (
    configuredPath.length === 0 ||
    configuredPath.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(configuredPath)
  ) {
    throw new Error('Agent config path is invalid.')
  }
  const resolved = resolve(appDirectory, configuredPath)
  const pathFromRoot = relative(appDirectory, resolved)
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('Agent config path must stay within the application workspace.')
  }
  return resolved
}

function parseInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || value.trim() === '') return defaultValue
  if (!/^\d+$/.test(value.trim())) throw new Error(`${name} must be an integer.`)
  const parsed = Number(value)
  if (parsed < minimum) throw new Error(`${name} must be at least ${minimum}.`)
  if (parsed > maximum) throw new Error(`${name} must be at most ${maximum}.`)
  return parsed
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function rejectExtraFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key))
  if (unexpected) throw new Error(`${label} has unexpected field: ${unexpected}.`)
}
