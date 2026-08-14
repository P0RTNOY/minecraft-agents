import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type { AgentRuntimeSnapshot } from '../runtime/agentRuntime.js'
import type {
  AgentShutdownSummary,
  AgentStartupSummary
} from '../runtime/agentManager.js'
import type { RuntimeAgentIdentity } from '../runtime/telemetry.js'

const INPUT_USD_PER_MILLION = 0.25
const OUTPUT_USD_PER_MILLION = 2
const MAX_LIVE_PROVIDER_CALLS = 300
const MAX_LIVE_COST_USD = 1
const COHORTS = new Set<SocialReliabilityCohort>([
  'one_agent', 'two_agent', 'three_agent'
])

export type SocialReliabilityCohort =
  | 'one_agent'
  | 'two_agent'
  | 'three_agent'

export interface SocialSafetyCounters {
  runawayLoops: number | null
  commandRoutingFailures: number | null
  crossAgentMemoryLeaks: number | null
  crossAgentRelationshipLeaks: number | null
  unverifiedClaimsPromotedToFacts: number | null
}

export interface SocialReliabilityRunEvidence {
  id: string
  cohort: SocialReliabilityCohort
  startedAt: number
  endedAt: number
  requestedAgents: readonly RuntimeAgentIdentity[]
  startup: AgentStartupSummary
  shutdown: AgentShutdownSummary
  snapshots: readonly AgentRuntimeSnapshot[]
  safety: SocialSafetyCounters
}

export interface SocialReliabilityAgentMetrics extends RuntimeAgentIdentity {
  providerCalls: number
  providerFailures: number
  brainProviderCalls: number
  socialProviderCalls: number
  inputTokens: number
  outputTokens: number
  meanProviderLatencyMs: number | null
  meanProviderQueueWaitMs: number | null
  relationshipUpdates: {
    agentSeen: number
    conversationCompleted: number
  }
  socialEpisodesRecorded: number
}

export interface SocialReliabilityRun {
  id: string
  cohort: SocialReliabilityCohort
  durationMs: number
  requestedAgents: number
  startedAgents: number
  stoppedAgents: number
  valid: boolean
  conversationsStarted: number
  conversationsCompleted: number
  conversationsTimedOut: number
  conversationsInterrupted: number
  turns: number[]
  providerCalls: number
  providerFailures: number
  brainProviderCalls: number
  socialProviderCalls: number
  agents: SocialReliabilityAgentMetrics[]
  safety: SocialSafetyCounters
}

export interface SocialReliabilityReport {
  schemaVersion: 1
  pricing: {
    model: 'gpt-5-mini'
    inputUsdPerMillion: 0.25
    outputUsdPerMillion: 2
    cachedInputDiscountApplied: false
  }
  limits: {
    maximumProviderCalls: 300
    maximumEstimatedCostUsd: 1
  }
  runs: SocialReliabilityRun[]
  aggregate: {
    validSessions: {
      oneAgent: number
      twoAgent: number
      threeAgent: number
    }
    startupSuccessRate: number
    cleanShutdownRate: number
    conversationCompletionRate: number | null
    meanTurns: number | null
    medianTurns: number | null
    timeoutInterruptionRate: number | null
    providerCalls: number
    providerFailures: number
    brainProviderCalls: number
    socialProviderCalls: number
    providerFailureRate: number | null
    meanProviderLatencyMs: number | null
    meanProviderQueueWaitMs: number | null
    inputTokens: number
    outputTokens: number
    socialCallsPerSession: number | null
    totalEstimatedCostUsd: number
    runawayLoopCount: number | null
    commandRoutingFailures: number | null
    crossAgentMemoryLeaks: number | null
    crossAgentRelationshipLeaks: number | null
    invalidSocialOutputRate: number | null
    relationshipUpdates: {
      agentSeen: number
      conversationCompleted: number
    }
    socialEpisodesRecorded: number
    staleSocialOutputsDiscarded: number
    sessionBudgetExhaustions: number
    loopPreventionRejections: number
    unverifiedClaimsPromotedToFacts: number | null
  }
}

export interface ReliabilityReportWriteOptions {
  temporarySuffix?: string
  beforeRename?: (temporaryPath: string) => void | Promise<void>
}

export function createSocialReliabilityReport(
  evidence: readonly SocialReliabilityRunEvidence[]
): SocialReliabilityReport {
  if (evidence.length < 1 || evidence.length > 32) {
    throw new Error('M6 social reliability evidence must contain 1 to 32 runs.')
  }
  const runs = evidence.map(summarizeRun)
  const snapshots = evidence.flatMap(run => run.snapshots)
  const social = snapshots.map(snapshot => snapshot.telemetry.social)
  const brainProviderCalls = sum(snapshots, item => item.telemetry.providerCalls)
  const socialProviderCalls = sum(social, item => item.providerCalls)
  const providerCalls = brainProviderCalls + socialProviderCalls
  const providerFailures = sum(snapshots, item => item.telemetry.providerFailures) +
    sum(social, item => item.providerFailures)
  const inputTokens = sum(snapshots, item => item.telemetry.inputTokens) +
    sum(social, item => item.inputTokens)
  const outputTokens = sum(snapshots, item => item.telemetry.outputTokens) +
    sum(social, item => item.outputTokens)
  const conversationsStarted = sum(runs, run => run.conversationsStarted)
  const terminalConversations = sum(runs, run => (
    run.conversationsCompleted +
    run.conversationsTimedOut +
    run.conversationsInterrupted
  ))
  const turns = runs.flatMap(run => run.turns)
  const requestedAgents = sum(runs, run => run.requestedAgents)
  const startedAgents = sum(runs, run => run.startedAgents)
  const stoppedAgents = sum(runs, run => run.stoppedAgents)
  const invalidOutputs = pairwiseCounter(social, item => item.invalidOutputs)
  const latencies = snapshots.flatMap(item => [
    ...item.telemetry.providerLatenciesMs,
    ...item.telemetry.social.providerLatenciesMs
  ])
  const queueWait = snapshots.flatMap(item => [
    ...item.telemetry.providerQueueWaitMs,
    ...item.telemetry.social.providerQueueWaitMs
  ])
  const relationshipUpdates = {
    agentSeen: sum(social, item => item.relationshipUpdates.agentSeen),
    conversationCompleted: sum(
      social,
      item => item.relationshipUpdates.conversationCompleted
    )
  }
  const report: SocialReliabilityReport = {
    schemaVersion: 1,
    pricing: {
      model: 'gpt-5-mini',
      inputUsdPerMillion: INPUT_USD_PER_MILLION,
      outputUsdPerMillion: OUTPUT_USD_PER_MILLION,
      cachedInputDiscountApplied: false
    },
    limits: {
      maximumProviderCalls: MAX_LIVE_PROVIDER_CALLS,
      maximumEstimatedCostUsd: MAX_LIVE_COST_USD
    },
    runs,
    aggregate: {
      validSessions: {
        oneAgent: runs.filter(run => run.cohort === 'one_agent' && run.valid).length,
        twoAgent: runs.filter(run => run.cohort === 'two_agent' && run.valid).length,
        threeAgent: runs.filter(run => run.cohort === 'three_agent' && run.valid).length
      },
      startupSuccessRate: ratio(startedAgents, requestedAgents) ?? 0,
      cleanShutdownRate: ratio(stoppedAgents, startedAgents) ?? 0,
      conversationCompletionRate: ratio(
        sum(runs, run => run.conversationsCompleted),
        terminalConversations
      ),
      meanTurns: mean(turns),
      medianTurns: median(turns),
      timeoutInterruptionRate: ratio(
        sum(runs, run => run.conversationsTimedOut + run.conversationsInterrupted),
        terminalConversations
      ),
      providerCalls,
      providerFailures,
      brainProviderCalls,
      socialProviderCalls,
      providerFailureRate: ratio(providerFailures, providerCalls),
      meanProviderLatencyMs: mean(latencies),
      meanProviderQueueWaitMs: mean(queueWait),
      inputTokens,
      outputTokens,
      socialCallsPerSession: ratio(socialProviderCalls, conversationsStarted),
      totalEstimatedCostUsd: estimateGpt5MiniCost(inputTokens, outputTokens),
      runawayLoopCount: sumMeasured(runs, run => run.safety.runawayLoops),
      commandRoutingFailures: sumMeasured(
        runs, run => run.safety.commandRoutingFailures
      ),
      crossAgentMemoryLeaks: sumMeasured(
        runs, run => run.safety.crossAgentMemoryLeaks
      ),
      crossAgentRelationshipLeaks: sumMeasured(
        runs,
        run => run.safety.crossAgentRelationshipLeaks
      ),
      invalidSocialOutputRate: ratio(invalidOutputs, socialProviderCalls),
      relationshipUpdates,
      socialEpisodesRecorded: sum(social, item => item.episodesCreated),
      staleSocialOutputsDiscarded: sum(social, item => item.staleResponses),
      sessionBudgetExhaustions: pairwiseCounter(
        social,
        item => item.budgetExhaustions
      ),
      loopPreventionRejections: sum(social, item => item.loopRejections),
      unverifiedClaimsPromotedToFacts: sumMeasured(
        runs,
        run => run.safety.unverifiedClaimsPromotedToFacts
      )
    }
  }
  assertM6LiveBudget(
    {
      providerCalls: report.aggregate.providerCalls,
      estimatedCostUsd: report.aggregate.totalEstimatedCostUsd
    },
    { providerCalls: 0, estimatedCostUsd: 0 }
  )
  return decodeSocialReliabilityReport(report)
}

export function assertM6LiveBudget(
  used: { providerCalls: number; estimatedCostUsd: number },
  projected: { providerCalls: number; estimatedCostUsd: number }
): void {
  requireNonNegativeInteger(used.providerCalls, 'used provider calls')
  requireNonNegativeInteger(projected.providerCalls, 'projected provider calls')
  requireCost(used.estimatedCostUsd, 'used cost')
  requireCost(projected.estimatedCostUsd, 'projected cost')
  if (used.providerCalls + projected.providerCalls > MAX_LIVE_PROVIDER_CALLS) {
    throw new Error('M6 live provider call budget would be exceeded.')
  }
  if (used.estimatedCostUsd + projected.estimatedCostUsd >= MAX_LIVE_COST_USD) {
    throw new Error('M6 live provider cost budget would be reached or exceeded.')
  }
}

export function resolveSocialReliabilityOutputPath(
  configuredPath: string | undefined
): string {
  const candidate = configuredPath?.trim() ||
    '/tmp/minecraft-agents-m6-social-validation.json'
  if (
    candidate.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(candidate) ||
    !candidate.toLowerCase().endsWith('.json')
  ) {
    throw new Error('M6_SOCIAL_OUTPUT must name a JSON file.')
  }
  return resolve(candidate)
}

export function readM6SessionMs(value: string | undefined): number {
  return readBoundedInteger(value, 30_000, 'M6_SESSION_MS', 5_000, 120_000)
}

export function readM6UsedCalls(value: string | undefined): number {
  return readBoundedInteger(value, 0, 'M6_USED_PROVIDER_CALLS', 0, 300)
}

export function readM6UsedCost(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 1) {
    throw new Error('M6_USED_COST_USD must be a number from 0 up to but not including 1.')
  }
  return parsed
}

export async function writeSocialReliabilityReport(
  filePath: string,
  report: SocialReliabilityReport,
  options: ReliabilityReportWriteOptions = {}
): Promise<void> {
  const validated = decodeSocialReliabilityReport(report)
  if (!filePath.toLowerCase().endsWith('.json')) {
    throw new Error('M6 social reliability output must be a JSON file.')
  }
  await rejectSymbolicLink(filePath)
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const suffix = options.temporarySuffix ?? `.${process.pid}.${randomUUID()}.tmp`
  if (!/^\.[A-Za-z0-9._-]{1,128}$/.test(suffix)) {
    throw new Error('M6 reliability temporary suffix is invalid.')
  }
  const temporaryPath = `${filePath}${suffix}`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
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

export function decodeSocialReliabilityReport(value: unknown): SocialReliabilityReport {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Unsupported M6 social reliability schema version.')
  }
  try {
    const encoded = JSON.stringify(value)
    if (encoded.length > 1_000_000) throw new Error()
    const parsed = JSON.parse(encoded) as unknown
    if (!isRecord(parsed) || !Array.isArray(parsed.runs)) throw new Error()
    if (parsed.runs.length < 1 || parsed.runs.length > 32) throw new Error()
    requireExactKeys(parsed, ['schemaVersion', 'pricing', 'limits', 'runs', 'aggregate'])
    if (!isRecord(parsed.aggregate) || !isRecord(parsed.pricing)) throw new Error()
    if (!isRecord(parsed.limits)) throw new Error()
    requireExactKeys(parsed.pricing, [
      'model', 'inputUsdPerMillion', 'outputUsdPerMillion',
      'cachedInputDiscountApplied'
    ])
    if (
      parsed.pricing.model !== 'gpt-5-mini' ||
      parsed.pricing.inputUsdPerMillion !== INPUT_USD_PER_MILLION ||
      parsed.pricing.outputUsdPerMillion !== OUTPUT_USD_PER_MILLION ||
      parsed.pricing.cachedInputDiscountApplied !== false
    ) throw new Error()
    requireExactKeys(parsed.limits, [
      'maximumProviderCalls', 'maximumEstimatedCostUsd'
    ])
    if (parsed.limits.maximumProviderCalls !== MAX_LIVE_PROVIDER_CALLS) throw new Error()
    if (parsed.limits.maximumEstimatedCostUsd !== MAX_LIVE_COST_USD) throw new Error()
    for (const run of parsed.runs) validateRun(run)
    validateAggregate(parsed.aggregate)
    return structuredClone(parsed) as unknown as SocialReliabilityReport
  } catch {
    throw new Error('Invalid M6 social reliability report.')
  }
}

function summarizeRun(evidence: SocialReliabilityRunEvidence): SocialReliabilityRun {
  validateEvidence(evidence)
  const social = evidence.snapshots.map(snapshot => snapshot.telemetry.social)
  const started = pairwiseCounter(social, item => item.conversationsStarted)
  const completed = pairwiseCounter(social, item => item.conversationsCompleted)
  const timedOut = pairwiseCounter(social, item => item.conversationsTimedOut)
  const interrupted = pairwiseCounter(social, item => item.conversationsInterrupted)
  const turns = collapsePairwiseTurns(
    social.flatMap(item => item.terminalConversationTurns)
  )
  const brainProviderCalls = sum(
    evidence.snapshots,
    item => item.telemetry.providerCalls
  )
  const socialProviderCalls = sum(social, item => item.providerCalls)
  const providerCalls = brainProviderCalls + socialProviderCalls
  const providerFailures = sum(
    evidence.snapshots,
    item => item.telemetry.providerFailures
  ) + sum(social, item => item.providerFailures)
  const agents = evidence.snapshots.map(snapshot => agentMetrics(snapshot))
  const safe = Object.values(evidence.safety).every(value => value === 0)
  const lifecycleClean = (
    evidence.startup.failures.length === 0 &&
    evidence.shutdown.failures.length === 0 &&
    evidence.startup.started.length === evidence.requestedAgents.length &&
    evidence.shutdown.stopped.length === evidence.startup.started.length
  )
  const conversationValid = evidence.cohort === 'one_agent'
    ? started === 0 && socialProviderCalls === 0
    : completed > 0 && timedOut === 0 && interrupted === 0
  return {
    id: evidence.id,
    cohort: evidence.cohort,
    durationMs: evidence.endedAt - evidence.startedAt,
    requestedAgents: evidence.requestedAgents.length,
    startedAgents: evidence.startup.started.length,
    stoppedAgents: evidence.shutdown.stopped.length,
    valid: lifecycleClean && safe && conversationValid,
    conversationsStarted: started,
    conversationsCompleted: completed,
    conversationsTimedOut: timedOut,
    conversationsInterrupted: interrupted,
    turns,
    providerCalls,
    providerFailures,
    brainProviderCalls,
    socialProviderCalls,
    agents,
    safety: { ...evidence.safety }
  }
}

function agentMetrics(snapshot: AgentRuntimeSnapshot): SocialReliabilityAgentMetrics {
  const social = snapshot.telemetry.social
  const brainCalls = snapshot.telemetry.providerCalls
  return {
    ...snapshot.identity,
    providerCalls: brainCalls + social.providerCalls,
    providerFailures: snapshot.telemetry.providerFailures + social.providerFailures,
    brainProviderCalls: brainCalls,
    socialProviderCalls: social.providerCalls,
    inputTokens: snapshot.telemetry.inputTokens + social.inputTokens,
    outputTokens: snapshot.telemetry.outputTokens + social.outputTokens,
    meanProviderLatencyMs: mean([
      ...snapshot.telemetry.providerLatenciesMs,
      ...social.providerLatenciesMs
    ]),
    meanProviderQueueWaitMs: mean([
      ...snapshot.telemetry.providerQueueWaitMs,
      ...social.providerQueueWaitMs
    ]),
    relationshipUpdates: { ...social.relationshipUpdates },
    socialEpisodesRecorded: social.episodesCreated
  }
}

function validateEvidence(evidence: SocialReliabilityRunEvidence): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(evidence.id)) {
    throw new Error('M6 reliability run identity is invalid.')
  }
  if (!COHORTS.has(evidence.cohort)) throw new Error('M6 reliability cohort is invalid.')
  requireNonNegativeInteger(evidence.startedAt, 'startedAt')
  requireNonNegativeInteger(evidence.endedAt, 'endedAt')
  if (evidence.endedAt < evidence.startedAt) throw new Error('M6 run time is invalid.')
  for (const value of Object.values(evidence.safety)) {
    requireNonNegativeIntegerOrNull(value, 'safety counter')
  }
}

function validateRun(value: unknown): void {
  if (!isRecord(value) || !COHORTS.has(value.cohort as SocialReliabilityCohort)) {
    throw new Error()
  }
  requireExactKeys(value, [
    'id', 'cohort', 'durationMs', 'requestedAgents', 'startedAgents',
    'stoppedAgents', 'valid', 'conversationsStarted',
    'conversationsCompleted', 'conversationsTimedOut',
    'conversationsInterrupted', 'turns', 'providerCalls',
    'providerFailures', 'brainProviderCalls', 'socialProviderCalls',
    'agents', 'safety'
  ])
  if (typeof value.id !== 'string' || typeof value.valid !== 'boolean') throw new Error()
  if (!Array.isArray(value.turns) || !Array.isArray(value.agents)) throw new Error()
  for (const field of [
    'durationMs', 'requestedAgents', 'startedAgents', 'stoppedAgents',
    'conversationsStarted', 'conversationsCompleted', 'conversationsTimedOut',
    'conversationsInterrupted', 'providerCalls', 'providerFailures',
    'brainProviderCalls', 'socialProviderCalls'
  ]) requireNonNegativeInteger(value[field], field)
  value.turns.forEach(turn => {
    requireNonNegativeInteger(turn, 'turn')
    if ((turn as number) > 8) throw new Error()
  })
  value.agents.forEach(validateAgentMetrics)
  if (!isRecord(value.safety)) throw new Error()
  validateSafety(value.safety)
}

function validateAggregate(value: Record<string, unknown>): void {
  if (!isRecord(value.validSessions) || !isRecord(value.relationshipUpdates)) {
    throw new Error()
  }
  requireExactKeys(value, [
    'validSessions', 'startupSuccessRate', 'cleanShutdownRate',
    'conversationCompletionRate', 'meanTurns', 'medianTurns',
    'timeoutInterruptionRate', 'providerCalls', 'providerFailures',
    'brainProviderCalls', 'socialProviderCalls', 'providerFailureRate',
    'meanProviderLatencyMs', 'meanProviderQueueWaitMs', 'inputTokens',
    'outputTokens', 'socialCallsPerSession', 'totalEstimatedCostUsd',
    'runawayLoopCount', 'commandRoutingFailures', 'crossAgentMemoryLeaks',
    'crossAgentRelationshipLeaks', 'invalidSocialOutputRate',
    'relationshipUpdates', 'socialEpisodesRecorded',
    'staleSocialOutputsDiscarded', 'sessionBudgetExhaustions',
    'loopPreventionRejections', 'unverifiedClaimsPromotedToFacts'
  ])
  requireExactKeys(value.validSessions, ['oneAgent', 'twoAgent', 'threeAgent'])
  requireExactKeys(value.relationshipUpdates, [
    'agentSeen', 'conversationCompleted'
  ])
  for (const field of [
    'providerCalls', 'providerFailures', 'brainProviderCalls',
    'socialProviderCalls', 'inputTokens', 'outputTokens',
    'socialEpisodesRecorded',
    'staleSocialOutputsDiscarded', 'sessionBudgetExhaustions',
    'loopPreventionRejections'
  ]) requireNonNegativeInteger(value[field], field)
  for (const field of [
    'runawayLoopCount', 'commandRoutingFailures', 'crossAgentMemoryLeaks',
    'crossAgentRelationshipLeaks', 'unverifiedClaimsPromotedToFacts'
  ]) requireNonNegativeIntegerOrNull(value[field], field)
  for (const field of ['oneAgent', 'twoAgent', 'threeAgent']) {
    requireNonNegativeInteger(value.validSessions[field], field)
  }
  for (const field of ['agentSeen', 'conversationCompleted']) {
    requireNonNegativeInteger(value.relationshipUpdates[field], field)
  }
  for (const field of [
    'startupSuccessRate', 'cleanShutdownRate', 'conversationCompletionRate',
    'timeoutInterruptionRate', 'providerFailureRate', 'invalidSocialOutputRate'
  ]) requireRateOrNull(value[field])
  for (const field of [
    'meanTurns', 'medianTurns', 'meanProviderLatencyMs',
    'meanProviderQueueWaitMs', 'socialCallsPerSession'
  ]) requireNonNegativeNumberOrNull(value[field])
  requireCost(value.totalEstimatedCostUsd, 'estimated cost')
}

function validateAgentMetrics(value: unknown): void {
  if (!isRecord(value)) throw new Error()
  requireExactKeys(value, [
    'agentId', 'username', 'providerCalls', 'providerFailures',
    'brainProviderCalls', 'socialProviderCalls', 'inputTokens', 'outputTokens',
    'meanProviderLatencyMs', 'meanProviderQueueWaitMs',
    'relationshipUpdates', 'socialEpisodesRecorded'
  ])
  if (
    typeof value.agentId !== 'string' ||
    !/^[a-z][a-z0-9_-]{0,31}$/.test(value.agentId) ||
    typeof value.username !== 'string' ||
    !/^[A-Za-z0-9_]{1,16}$/.test(value.username)
  ) throw new Error()
  for (const field of [
    'providerCalls', 'providerFailures', 'brainProviderCalls',
    'socialProviderCalls', 'inputTokens', 'outputTokens',
    'socialEpisodesRecorded'
  ]) requireNonNegativeInteger(value[field], field)
  requireNonNegativeNumberOrNull(value.meanProviderLatencyMs)
  requireNonNegativeNumberOrNull(value.meanProviderQueueWaitMs)
  if (!isRecord(value.relationshipUpdates)) throw new Error()
  requireExactKeys(value.relationshipUpdates, ['agentSeen', 'conversationCompleted'])
  requireNonNegativeInteger(value.relationshipUpdates.agentSeen, 'agentSeen')
  requireNonNegativeInteger(
    value.relationshipUpdates.conversationCompleted,
    'conversationCompleted'
  )
}

function validateSafety(value: Record<string, unknown>): void {
  requireExactKeys(value, [
    'runawayLoops', 'commandRoutingFailures', 'crossAgentMemoryLeaks',
    'crossAgentRelationshipLeaks', 'unverifiedClaimsPromotedToFacts'
  ])
  for (const candidate of Object.values(value)) {
    requireNonNegativeIntegerOrNull(candidate, 'safety counter')
  }
}

function sumMeasured<T>(
  values: readonly T[],
  read: (value: T) => number | null
): number | null {
  let total = 0
  for (const value of values) {
    const measurement = read(value)
    if (measurement === null) return null
    total += measurement
  }
  return total
}

function pairwiseCounter<T>(values: readonly T[], read: (value: T) => number): number {
  const total = sum(values, read)
  if (total % 2 !== 0) {
    throw new Error('Pairwise conversation telemetry is incomplete.')
  }
  return total / 2
}

function collapsePairwiseTurns(values: readonly number[]): number[] {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length % 2 !== 0) {
    throw new Error('Pairwise terminal-turn telemetry is incomplete.')
  }
  const turns: number[] = []
  for (let index = 0; index < sorted.length; index += 2) {
    if (sorted[index] !== sorted[index + 1]) {
      throw new Error('Pairwise terminal-turn telemetry does not match.')
    }
    turns.push(sorted[index] ?? 0)
  }
  return turns
}

export function estimateGpt5MiniCost(inputTokens: number, outputTokens: number): number {
  return roundCost(
    inputTokens * INPUT_USD_PER_MILLION / 1_000_000 +
    outputTokens * OUTPUT_USD_PER_MILLION / 1_000_000
  )
}

function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || value.trim() === '') return fallback
  if (!/^\d+$/.test(value.trim())) throw new Error(`${label} must be an integer.`)
  const parsed = Number(value)
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be from ${minimum} to ${maximum}.`)
  }
  return parsed
}

function sum<T>(values: readonly T[], read: (value: T) => number): number {
  return values.reduce((total, value) => total + read(value), 0)
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : sum(values, value => value) / values.length
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? null
}

function roundCost(value: number): number {
  return Number(value.toFixed(8))
}

function requireNonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`M6 reliability ${label} is invalid.`)
  }
}

function requireNonNegativeIntegerOrNull(value: unknown, label: string): void {
  if (value === null) return
  requireNonNegativeInteger(value, label)
}

function requireCost(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`M6 reliability ${label} is invalid.`)
  }
}

function requireRateOrNull(value: unknown): void {
  if (value === null) return
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('M6 reliability rate is invalid.')
  }
}

function requireNonNegativeNumberOrNull(value: unknown): void {
  if (value === null) return
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('M6 reliability numeric metric is invalid.')
  }
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): void {
  const keys = Object.keys(value).sort()
  const sorted = [...expected].sort()
  if (
    keys.length !== sorted.length ||
    keys.some((key, index) => key !== sorted[index])
  ) throw new Error()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function rejectSymbolicLink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error('M6 social reliability output cannot be a symbolic link.')
    }
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
}
