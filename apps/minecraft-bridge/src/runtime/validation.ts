import {
  lstat,
  mkdir,
  rename,
  unlink,
  writeFile
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import type { MemoryMetrics } from '../memory/coordinator.js'
import type { AgentRuntimePhase, AgentRuntimeSnapshot } from './agentRuntime.js'
import type {
  AgentShutdownSummary,
  AgentStartupSummary
} from './agentManager.js'
import {
  summarizeAgentTelemetry,
  type RuntimeAgentIdentity
} from './telemetry.js'

const AGENT_ID = /^[a-z][a-z0-9_-]{0,31}$/
const USERNAME = /^[A-Za-z0-9_]{1,16}$/
const PHASES = new Set<AgentRuntimePhase>([
  'created', 'starting', 'running', 'stopping', 'stopped'
])
const TERMINATIONS = new Set<ValidationTermination>([
  'duration', 'SIGINT', 'SIGTERM'
])
const INPUT_USD_PER_MILLION = 0.25
const OUTPUT_USD_PER_MILLION = 2

export type ValidationTermination = 'duration' | 'SIGINT' | 'SIGTERM'

export interface ValidationProviderMetrics {
  calls: number
  failures: number
  inputTokens: number
  outputTokens: number
  meanLatencyMs: number | null
  medianLatencyMs: number | null
  meanQueueWaitMs: number | null
  estimatedCostUsd: number
}

export interface ValidationAgentReport extends RuntimeAgentIdentity {
  phase: AgentRuntimePhase
  visibleExternalPlayers: string[]
  lifecycle: {
    startedAt: number | null
    stoppedAt: number | null
    spawned: number
    disconnects: number
    errors: number
    kicked: number
  }
  provider: ValidationProviderMetrics
  memory: MemoryMetrics | null
}

export interface MultiAgentValidationReport {
  schemaVersion: 1
  session: {
    startedAt: number
    endedAt: number
    durationMs: number
    termination: ValidationTermination
    pricing: {
      model: 'gpt-5-mini'
      inputUsdPerMillion: 0.25
      outputUsdPerMillion: 2
      cachedInputDiscountApplied: false
    }
  }
  startup: {
    requestedAgentIds: string[]
    startedAgentIds: string[]
    failedAgentIds: string[]
    successRate: number
  }
  shutdown: {
    stoppedAgentIds: string[]
    failedAgentIds: string[]
  }
  agents: ValidationAgentReport[]
  aggregate: {
    requestedAgents: number
    startedAgents: number
    startupSuccessRate: number
    providerCalls: number
    providerFailures: number
    inputTokens: number
    outputTokens: number
    meanProviderLatencyMs: number | null
    medianProviderLatencyMs: number | null
    meanProviderQueueWaitMs: number | null
    disconnects: number
    errors: number
    kicked: number
    memoryRetrievalFailures: number
    memoryPersistenceFailures: number
    estimatedCostUsd: number
  }
}

export interface CreateMultiAgentValidationReportInput {
  sessionStartedAt: number
  sessionEndedAt: number
  termination: ValidationTermination
  requestedAgents: readonly RuntimeAgentIdentity[]
  startup: AgentStartupSummary
  shutdown: AgentShutdownSummary
  snapshots: readonly AgentRuntimeSnapshot[]
}

export interface ValidationReportWriteOptions {
  temporarySuffix?: string
  beforeRename?: (temporaryPath: string) => void | Promise<void>
}

export function readValidationSessionMs(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 60_000
  if (!/^\d+$/.test(value.trim())) {
    throw new Error('MULTI_AGENT_SESSION_MS must be an integer.')
  }
  const parsed = Number(value)
  if (parsed < 1_000) {
    throw new Error('MULTI_AGENT_SESSION_MS must be at least 1000.')
  }
  if (parsed > 600_000) {
    throw new Error('MULTI_AGENT_SESSION_MS must be at most 600000.')
  }
  return parsed
}

export function resolveValidationOutputPath(
  configuredPath: string | undefined,
  workingDirectory: string,
  appDirectory: string
): string {
  const candidate = configuredPath?.trim() || join(
    appDirectory,
    'data/validation/latest.json'
  )
  if (
    candidate.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(candidate) ||
    !candidate.toLowerCase().endsWith('.json')
  ) {
    throw new Error('MULTI_AGENT_OUTPUT must name a JSON file.')
  }
  return isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(workingDirectory, candidate)
}

export function createMultiAgentValidationReport(
  input: CreateMultiAgentValidationReportInput
): MultiAgentValidationReport {
  requireTimestamp(input.sessionStartedAt, 'sessionStartedAt')
  requireTimestamp(input.sessionEndedAt, 'sessionEndedAt')
  if (input.sessionEndedAt < input.sessionStartedAt) {
    throw new Error('Validation session end must not precede its start.')
  }
  if (!TERMINATIONS.has(input.termination)) {
    throw new Error('Validation session termination is invalid.')
  }
  requireUniqueIdentities(input.requestedAgents)

  const agents = input.snapshots.map(snapshot => agentReport(snapshot))
  const telemetry = summarizeAgentTelemetry(
    input.snapshots.map(snapshot => snapshot.telemetry)
  )
  const requestedAgents = input.requestedAgents.length
  const startedAgents = input.startup.started.length
  const startupSuccessRate = requestedAgents === 0
    ? 0
    : startedAgents / requestedAgents

  const report: MultiAgentValidationReport = {
    schemaVersion: 1,
    session: {
      startedAt: input.sessionStartedAt,
      endedAt: input.sessionEndedAt,
      durationMs: input.sessionEndedAt - input.sessionStartedAt,
      termination: input.termination,
      pricing: {
        model: 'gpt-5-mini',
        inputUsdPerMillion: INPUT_USD_PER_MILLION,
        outputUsdPerMillion: OUTPUT_USD_PER_MILLION,
        cachedInputDiscountApplied: false
      }
    },
    startup: {
      requestedAgentIds: input.requestedAgents.map(agent => agent.agentId),
      startedAgentIds: [...input.startup.started],
      failedAgentIds: input.startup.failures.map(failure => failure.agentId),
      successRate: startupSuccessRate
    },
    shutdown: {
      stoppedAgentIds: [...input.shutdown.stopped],
      failedAgentIds: input.shutdown.failures.map(failure => failure.agentId)
    },
    agents,
    aggregate: {
      requestedAgents,
      startedAgents,
      startupSuccessRate,
      providerCalls: telemetry.providerCalls,
      providerFailures: telemetry.providerFailures,
      inputTokens: telemetry.inputTokens,
      outputTokens: telemetry.outputTokens,
      meanProviderLatencyMs: telemetry.meanProviderLatencyMs,
      medianProviderLatencyMs: telemetry.medianProviderLatencyMs,
      meanProviderQueueWaitMs: telemetry.meanProviderQueueWaitMs,
      disconnects: sum(agents, agent => agent.lifecycle.disconnects),
      errors: sum(agents, agent => agent.lifecycle.errors),
      kicked: sum(agents, agent => agent.lifecycle.kicked),
      memoryRetrievalFailures: sum(
        agents,
        agent => agent.memory?.retrievalFailures ?? 0
      ),
      memoryPersistenceFailures: sum(
        agents,
        agent => agent.memory?.persistenceFailures ?? 0
      ),
      estimatedCostUsd: estimateGpt5MiniCost(
        telemetry.inputTokens,
        telemetry.outputTokens
      )
    }
  }
  return decodeMultiAgentValidationReport(report)
}

export function estimateGpt5MiniCost(
  inputTokens: number,
  outputTokens: number
): number {
  requireNonNegativeInteger(inputTokens, 'inputTokens')
  requireNonNegativeInteger(outputTokens, 'outputTokens')
  return roundCost(
    (inputTokens * INPUT_USD_PER_MILLION / 1_000_000) +
    (outputTokens * OUTPUT_USD_PER_MILLION / 1_000_000)
  )
}

export async function writeMultiAgentValidationReport(
  filePath: string,
  report: MultiAgentValidationReport,
  options: ValidationReportWriteOptions = {}
): Promise<void> {
  const validated = decodeMultiAgentValidationReport(report)
  if (!filePath.endsWith('.json')) {
    throw new Error('Multi-agent validation output must be a JSON file.')
  }
  await rejectSymbolicLink(filePath)
  await mkdir(dirname(filePath), { recursive: true })
  const suffix = options.temporarySuffix ?? `.${process.pid}.${randomUUID()}.tmp`
  if (!/^\.[A-Za-z0-9._-]{1,128}$/.test(suffix)) {
    throw new Error('Validation report temporary suffix is invalid.')
  }
  const temporaryPath = `${filePath}${suffix}`
  const encoded = `${JSON.stringify(validated, null, 2)}\n`
  try {
    await writeFile(temporaryPath, encoded, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    await options.beforeRename?.(temporaryPath)
    await rename(temporaryPath, filePath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
}

export function decodeMultiAgentValidationReport(
  value: unknown
): MultiAgentValidationReport {
  const root = record(value)
  if (root?.schemaVersion !== 1) {
    throw new Error('Unsupported multi-agent validation schema version.')
  }
  try {
    requireKeys(root, ['schemaVersion', 'session', 'startup', 'shutdown', 'agents', 'aggregate'])
    validateSession(record(root.session))
    validateStartup(record(root.startup))
    validateShutdown(record(root.shutdown))
    if (!Array.isArray(root.agents)) throw new Error()
    root.agents.forEach(validateAgent)
    validateAggregate(record(root.aggregate))
  } catch {
    throw new Error('Invalid multi-agent validation report.')
  }
  return structuredClone(root) as unknown as MultiAgentValidationReport
}

function agentReport(snapshot: AgentRuntimeSnapshot): ValidationAgentReport {
  requireIdentity(snapshot.identity)
  const telemetry = summarizeAgentTelemetry([snapshot.telemetry])
  return {
    ...snapshot.identity,
    phase: snapshot.phase,
    visibleExternalPlayers: [...snapshot.visibleExternalPlayers],
    lifecycle: {
      startedAt: snapshot.startedAt,
      stoppedAt: snapshot.stoppedAt,
      spawned: snapshot.telemetry.spawned,
      disconnects: snapshot.telemetry.disconnects,
      errors: snapshot.telemetry.errors,
      kicked: snapshot.telemetry.kicked
    },
    provider: {
      calls: snapshot.telemetry.providerCalls,
      failures: snapshot.telemetry.providerFailures,
      inputTokens: snapshot.telemetry.inputTokens,
      outputTokens: snapshot.telemetry.outputTokens,
      meanLatencyMs: telemetry.meanProviderLatencyMs,
      medianLatencyMs: telemetry.medianProviderLatencyMs,
      meanQueueWaitMs: telemetry.meanProviderQueueWaitMs,
      estimatedCostUsd: estimateGpt5MiniCost(
        snapshot.telemetry.inputTokens,
        snapshot.telemetry.outputTokens
      )
    },
    memory: snapshot.telemetry.memory
      ? { ...snapshot.telemetry.memory }
      : null
  }
}

function validateSession(value: Record<string, unknown> | null): void {
  if (!value) throw new Error()
  requireKeys(value, ['startedAt', 'endedAt', 'durationMs', 'termination', 'pricing'])
  requireNonNegativeInteger(value.startedAt, 'startedAt')
  requireNonNegativeInteger(value.endedAt, 'endedAt')
  requireNonNegativeInteger(value.durationMs, 'durationMs')
  if (!TERMINATIONS.has(value.termination as ValidationTermination)) throw new Error()
  const pricing = record(value.pricing)
  if (!pricing) throw new Error()
  requireKeys(pricing, [
    'model', 'inputUsdPerMillion', 'outputUsdPerMillion',
    'cachedInputDiscountApplied'
  ])
  if (
    pricing.model !== 'gpt-5-mini' ||
    pricing.inputUsdPerMillion !== INPUT_USD_PER_MILLION ||
    pricing.outputUsdPerMillion !== OUTPUT_USD_PER_MILLION ||
    pricing.cachedInputDiscountApplied !== false
  ) throw new Error()
}

function validateStartup(value: Record<string, unknown> | null): void {
  if (!value) throw new Error()
  requireKeys(value, [
    'requestedAgentIds', 'startedAgentIds', 'failedAgentIds', 'successRate'
  ])
  requireAgentIds(value.requestedAgentIds)
  requireAgentIds(value.startedAgentIds)
  requireAgentIds(value.failedAgentIds)
  requireRate(value.successRate)
}

function validateShutdown(value: Record<string, unknown> | null): void {
  if (!value) throw new Error()
  requireKeys(value, ['stoppedAgentIds', 'failedAgentIds'])
  requireAgentIds(value.stoppedAgentIds)
  requireAgentIds(value.failedAgentIds)
}

function validateAgent(value: unknown): void {
  const agent = record(value)
  if (!agent) throw new Error()
  requireKeys(agent, [
    'agentId', 'username', 'phase', 'visibleExternalPlayers', 'lifecycle',
    'provider', 'memory'
  ])
  requireIdentity({ agentId: agent.agentId, username: agent.username })
  if (!PHASES.has(agent.phase as AgentRuntimePhase)) throw new Error()
  if (
    !Array.isArray(agent.visibleExternalPlayers) ||
    agent.visibleExternalPlayers.some(username => (
      typeof username !== 'string' || !USERNAME.test(username)
    ))
  ) throw new Error()

  const lifecycle = record(agent.lifecycle)
  if (!lifecycle) throw new Error()
  requireKeys(lifecycle, [
    'startedAt', 'stoppedAt', 'spawned', 'disconnects', 'errors', 'kicked'
  ])
  requireNullableInteger(lifecycle.startedAt)
  requireNullableInteger(lifecycle.stoppedAt)
  for (const key of ['spawned', 'disconnects', 'errors', 'kicked']) {
    requireNonNegativeInteger(lifecycle[key], key)
  }

  const provider = record(agent.provider)
  if (!provider) throw new Error()
  requireKeys(provider, [
    'calls', 'failures', 'inputTokens', 'outputTokens', 'meanLatencyMs',
    'medianLatencyMs', 'meanQueueWaitMs', 'estimatedCostUsd'
  ])
  for (const key of ['calls', 'failures', 'inputTokens', 'outputTokens']) {
    requireNonNegativeInteger(provider[key], key)
  }
  for (const key of [
    'meanLatencyMs', 'medianLatencyMs', 'meanQueueWaitMs'
  ]) requireNullableNumber(provider[key])
  requireNonNegativeNumber(provider.estimatedCostUsd)
  if (agent.memory !== null) validateMemory(record(agent.memory))
}

function validateMemory(value: Record<string, unknown> | null): void {
  if (!value) throw new Error()
  const keys: Array<keyof MemoryMetrics> = [
    'episodesCreated', 'episodesRetrieved', 'semanticFactsCreated',
    'semanticFactsRetrieved', 'retrievalFailures', 'persistenceFailures',
    'reflectionCalls', 'reflectionFailures', 'reflectionInputTokens',
    'reflectionOutputTokens', 'estimatedMemoryPromptTokens'
  ]
  requireKeys(value, keys)
  for (const key of keys) requireNonNegativeInteger(value[key], key)
}

function validateAggregate(value: Record<string, unknown> | null): void {
  if (!value) throw new Error()
  const integers = [
    'requestedAgents', 'startedAgents', 'providerCalls', 'providerFailures',
    'inputTokens', 'outputTokens', 'disconnects', 'errors', 'kicked',
    'memoryRetrievalFailures', 'memoryPersistenceFailures'
  ]
  const nullable = [
    'meanProviderLatencyMs', 'medianProviderLatencyMs',
    'meanProviderQueueWaitMs'
  ]
  requireKeys(value, [
    ...integers,
    'startupSuccessRate',
    ...nullable,
    'estimatedCostUsd'
  ])
  for (const key of integers) requireNonNegativeInteger(value[key], key)
  requireRate(value.startupSuccessRate)
  for (const key of nullable) requireNullableNumber(value[key])
  requireNonNegativeNumber(value.estimatedCostUsd)
}

function requireUniqueIdentities(
  identities: readonly RuntimeAgentIdentity[]
): void {
  const ids = new Set<string>()
  const usernames = new Set<string>()
  for (const identity of identities) {
    requireIdentity(identity)
    const id = identity.agentId.toLowerCase()
    const username = identity.username.toLowerCase()
    if (ids.has(id) || usernames.has(username)) {
      throw new Error('Validation agent identities must be unique.')
    }
    ids.add(id)
    usernames.add(username)
  }
}

function requireIdentity(value: {
  agentId: unknown
  username: unknown
}): asserts value is RuntimeAgentIdentity {
  if (
    typeof value.agentId !== 'string' || !AGENT_ID.test(value.agentId) ||
    typeof value.username !== 'string' || !USERNAME.test(value.username)
  ) throw new Error('Validation agent identity is invalid.')
}

function requireAgentIds(value: unknown): void {
  if (
    !Array.isArray(value) ||
    value.some(item => typeof item !== 'string' || !AGENT_ID.test(item))
  ) throw new Error()
}

function requireTimestamp(value: unknown, label: string): void {
  requireNonNegativeInteger(value, label)
}

function requireNonNegativeInteger(
  value: unknown,
  label: string
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer.`)
  }
}

function requireNonNegativeNumber(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error()
  }
}

function requireNullableInteger(value: unknown): void {
  if (value !== null) requireNonNegativeInteger(value, 'timestamp')
}

function requireNullableNumber(value: unknown): void {
  if (value !== null) requireNonNegativeNumber(value)
}

function requireRate(value: unknown): void {
  requireNonNegativeNumber(value)
  if (value > 1) throw new Error()
}

function requireKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): void {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) throw new Error()
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function sum<T>(values: readonly T[], read: (value: T) => number): number {
  return values.reduce((total, value) => total + read(value), 0)
}

function roundCost(value: number): number {
  return Number(value.toFixed(9))
}

async function rejectSymbolicLink(filePath: string): Promise<void> {
  try {
    if ((await lstat(filePath)).isSymbolicLink()) {
      throw new Error('Multi-agent validation output cannot be a symbolic link.')
    }
  } catch (error) {
    if (isMissingFile(error)) return
    throw error
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null &&
    'code' in error && error.code === 'ENOENT'
  )
}
