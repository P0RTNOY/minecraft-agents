import type { BrainCycleResult } from '../../agent/loop.js'
import type { InventoryItemSnapshot } from '../../skills/inventory.js'
import type { GoalProgress } from '../goals.js'
import type { LLMProvider, LLMRequestTiming } from '../provider.js'
import type { MemoryMetrics } from '../../memory/coordinator.js'

export type BootstrapFailureReason =
  | 'model_decision_failure'
  | 'crafting_failure'
  | 'navigation_failure'
  | 'grounding_rejection'
  | 'validation_failure'
  | 'repetition_stagnation'
  | 'provider_error'
  | 'timeout'
  | 'reflex_interruption'
  | 'world_state_failure'
  | 'infrastructure_invalid'

export interface CraftTelemetryEvent {
  requestedAmount: number | null
  recipeOutput: number | null
  executionCount: number
  retryCount: 0 | 1
  retryResult: 'not_needed' | 'succeeded' | 'failed'
  success: boolean
  failureReason: string | null
}

export interface BootstrapRunResult {
  runId: string
  provider: string
  model: string
  startedAt: number
  completedAt: number
  durationMs: number
  success: boolean
  goalCompleted: boolean
  infrastructureInvalid: boolean
  decisionCount: number
  providerCalls: number
  progressActionCount: number
  noProgressCount: number
  skillFailures: number
  craftFailures: number
  validationFailures: number
  groundingRejections: number
  repetitionRejections: number
  providerErrors: number
  reflexes: number
  manualOverrides: number
  inputTokens: number
  outputTokens: number
  memoryEpisodesCreated: number
  memoryEpisodesRetrieved: number
  memorySemanticFactsCreated: number
  memorySemanticFactsRetrieved: number
  memoryRetrievalFailures: number
  memoryPersistenceFailures: number
  reflectionCalls: number
  reflectionFailures: number
  reflectionInputTokens: number
  reflectionOutputTokens: number
  estimatedMemoryPromptTokens: number
  llmLatenciesMs: number[]
  actionCounts: Record<string, number>
  skillFailureReasons: Record<string, number>
  craftEvents: CraftTelemetryEvent[]
  failureReason: BootstrapFailureReason | null
  finalProgress: GoalProgress | null
  finalInventory: InventoryItemSnapshot[]
}

export interface BootstrapReliabilitySummary {
  rawRuns: number
  validRuns: number
  infrastructureInvalidRuns: number
  successes: number
  goalCompletionRate: number
  successRate: number
  medianCompletionTimeMs: number | null
  meanCompletionTimeMs: number | null
  medianDecisions: number | null
  meanDecisions: number | null
  progressActionRate: number
  noProgressRate: number
  craftFailureRate: number
  craftRetryRate: number
  craftRetrySuccessRate: number
  groundingRejectionRate: number
  validationRejectionRate: number
  providerFailureRate: number
  reflexTriggerRate: number
  totalInputTokens: number
  totalOutputTokens: number
  averageInputTokens: number
  averageOutputTokens: number
  totalMemoryEpisodesCreated: number
  totalMemoryEpisodesRetrieved: number
  totalMemorySemanticFactsCreated: number
  totalMemorySemanticFactsRetrieved: number
  totalMemoryRetrievalFailures: number
  totalMemoryPersistenceFailures: number
  totalReflectionCalls: number
  totalReflectionFailures: number
  reflectionFailureRate: number
  totalReflectionInputTokens: number
  totalReflectionOutputTokens: number
  totalEstimatedMemoryPromptTokens: number
  mostCommonFailureReason: BootstrapFailureReason | null
}

export class BootstrapRunTelemetry {
  private readonly identity: Pick<BootstrapRunResult, 'runId' | 'provider' | 'model' | 'startedAt'>
  private firstFailure: BootstrapFailureReason | null = null
  private providerCalls = 0
  private decisionCount = 0
  private inputTokens = 0
  private outputTokens = 0
  private memoryMetrics: MemoryMetrics = emptyMemoryMetrics()
  private readonly llmLatenciesMs: number[] = []
  private progressActionCount = 0
  private noProgressCount = 0
  private skillFailures = 0
  private craftFailures = 0
  private validationFailures = 0
  private groundingRejections = 0
  private repetitionRejections = 0
  private providerErrors = 0
  private reflexes = 0
  private manualOverrides = 0
  private readonly actionCounts: Record<string, number> = {}
  private readonly skillFailureReasons: Record<string, number> = {}
  private readonly craftEvents: CraftTelemetryEvent[] = []

  constructor(identity: Pick<BootstrapRunResult, 'runId' | 'provider' | 'model' | 'startedAt'>) {
    this.identity = identity
  }

  recordProviderCall(event: {
    latencyMs: number
    succeeded: boolean
    timing: LLMRequestTiming | null
  }): void {
    this.providerCalls += 1
    if (event.succeeded) this.decisionCount += 1
    if (Number.isFinite(event.latencyMs) && event.latencyMs >= 0) {
      this.llmLatenciesMs.push(event.latencyMs)
    }
    this.inputTokens += event.timing?.promptTokens ?? 0
    this.outputTokens += event.timing?.outputTokens ?? 0
  }

  recordCycle(
    cycle: BrainCycleResult,
    beforeProgress: GoalProgress | null,
    afterProgress: GoalProgress | null
  ): void {
    if (cycle.status === 'executed') {
      this.actionCounts[cycle.decision.action] =
        (this.actionCounts[cycle.decision.action] ?? 0) + 1
      if (cycle.result.action === 'craft_item') {
        this.recordCraftEvent(cycle.result)
      }
      if (progressChanged(beforeProgress, afterProgress)) {
        this.progressActionCount += 1
      } else {
        this.noProgressCount += 1
      }
      if (!cycle.result.success) {
        this.recordSkillFailure(cycle.result)
        this.noteFailure(classifyExecutionFailure(cycle))
      }
      return
    }

    if (cycle.status === 'execution_failed') {
      if (cycle.result.action === 'craft_item') {
        this.recordCraftEvent(cycle.result)
      }
      this.recordSkillFailure(cycle.result)
      this.noteFailure(classifyResultDetails(cycle.result))
    } else if (cycle.status === 'provider_failed') {
      this.providerErrors += 1
      this.noteFailure('provider_error')
    } else if (cycle.status === 'validation_failed') {
      this.validationFailures += 1
      const grounded = cycle.issues.some(isGroundingIssue)
      if (grounded) this.groundingRejections += 1
      this.noteFailure(grounded ? 'grounding_rejection' : 'validation_failure')
    } else if (cycle.status === 'policy_rejected') {
      this.repetitionRejections += 1
      this.noteFailure('repetition_stagnation')
    } else if (cycle.status === 'observation_failed') {
      this.noteFailure('world_state_failure')
    } else if (cycle.status === 'skipped' && cycle.reason === 'manual_override') {
      this.manualOverrides += 1
      this.noteFailure('model_decision_failure')
    }
  }

  recordReflex(): void {
    this.reflexes += 1
    this.noteFailure('reflex_interruption')
  }

  recordMemoryMetrics(metrics: MemoryMetrics): void {
    this.memoryMetrics = { ...metrics }
  }

  finish(options: {
    completedAt: number
    finalProgress: GoalProgress | null
    finalInventory: InventoryItemSnapshot[]
    timedOut?: boolean
    infrastructureInvalid?: boolean
  }): BootstrapRunResult {
    const infrastructureInvalid = options.infrastructureInvalid ?? false
    const goalCompleted = options.finalProgress?.completed ?? false
    const failureReason = infrastructureInvalid
      ? 'infrastructure_invalid'
      : goalCompleted
        ? null
        : options.timedOut
          ? 'timeout'
          : this.firstFailure ?? 'model_decision_failure'

    return {
      ...this.identity,
      completedAt: options.completedAt,
      durationMs: Math.max(0, options.completedAt - this.identity.startedAt),
      success: goalCompleted && !infrastructureInvalid,
      goalCompleted,
      infrastructureInvalid,
      decisionCount: this.decisionCount,
      providerCalls: this.providerCalls,
      progressActionCount: this.progressActionCount,
      noProgressCount: this.noProgressCount,
      skillFailures: this.skillFailures,
      craftFailures: this.craftFailures,
      validationFailures: this.validationFailures,
      groundingRejections: this.groundingRejections,
      repetitionRejections: this.repetitionRejections,
      providerErrors: this.providerErrors,
      reflexes: this.reflexes,
      manualOverrides: this.manualOverrides,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      memoryEpisodesCreated: this.memoryMetrics.episodesCreated,
      memoryEpisodesRetrieved: this.memoryMetrics.episodesRetrieved,
      memorySemanticFactsCreated: this.memoryMetrics.semanticFactsCreated,
      memorySemanticFactsRetrieved: this.memoryMetrics.semanticFactsRetrieved,
      memoryRetrievalFailures: this.memoryMetrics.retrievalFailures,
      memoryPersistenceFailures: this.memoryMetrics.persistenceFailures,
      reflectionCalls: this.memoryMetrics.reflectionCalls,
      reflectionFailures: this.memoryMetrics.reflectionFailures,
      reflectionInputTokens: this.memoryMetrics.reflectionInputTokens,
      reflectionOutputTokens: this.memoryMetrics.reflectionOutputTokens,
      estimatedMemoryPromptTokens:
        this.memoryMetrics.estimatedMemoryPromptTokens,
      llmLatenciesMs: [...this.llmLatenciesMs],
      actionCounts: { ...this.actionCounts },
      skillFailureReasons: { ...this.skillFailureReasons },
      craftEvents: this.craftEvents.map(event => ({ ...event })),
      failureReason,
      finalProgress: options.finalProgress ? { ...options.finalProgress } : null,
      finalInventory: options.finalInventory.map(item => ({ ...item }))
    }
  }

  private noteFailure(reason: BootstrapFailureReason): void {
    this.firstFailure ??= reason
  }

  private recordSkillFailure(result: {
    action: string
    details?: Record<string, unknown>
  }): void {
    this.skillFailures += 1
    if (result.action === 'craft_item') this.craftFailures += 1
    const reason = typeof result.details?.reason === 'string'
      ? result.details.reason
      : 'unknown'
    const key = `${result.action}:${reason}`
    this.skillFailureReasons[key] = (this.skillFailureReasons[key] ?? 0) + 1
  }

  private recordCraftEvent(result: {
    success: boolean
    details?: Record<string, unknown>
  }): void {
    const retryCount = result.details?.retryCount === 1 ? 1 : 0
    const retryResult = isRetryResult(result.details?.retryResult)
      ? result.details.retryResult
      : 'not_needed'
    this.craftEvents.push({
      requestedAmount: positiveIntegerOrNull(result.details?.requested),
      recipeOutput: positiveIntegerOrNull(result.details?.recipeOutput),
      executionCount: positiveIntegerOrZero(result.details?.executionCount),
      retryCount,
      retryResult,
      success: result.success,
      failureReason: typeof result.details?.reason === 'string'
        ? result.details.reason
        : null
    })
  }
}

export function instrumentProvider(
  provider: LLMProvider,
  telemetry: BootstrapRunTelemetry,
  now: () => number = Date.now
): LLMProvider {
  return {
    async decide(input) {
      const startedAt = now()
      let succeeded = false
      try {
        const output = await provider.decide(input)
        succeeded = true
        return output
      } finally {
        telemetry.recordProviderCall({
          latencyMs: Math.max(0, now() - startedAt),
          succeeded,
          timing: provider.getLastTiming?.() ?? null
        })
      }
    },
    getLastTiming: () => provider.getLastTiming?.() ?? null
  }
}

export function summarizeBootstrapRuns(
  runs: readonly BootstrapRunResult[]
): BootstrapReliabilitySummary {
  const valid = runs.filter(run => !run.infrastructureInvalid)
  const completed = valid.filter(run => run.goalCompleted)
  const totalActions = sum(valid, run => run.progressActionCount + run.noProgressCount)
  const totalCalls = sum(valid, run => run.providerCalls)
  const craftEvents = valid.flatMap(run => run.craftEvents ?? [])
  const retriedCrafts = craftEvents.filter(event => event.retryCount === 1)
  const failureCounts = new Map<BootstrapFailureReason, number>()
  for (const run of valid) {
    if (run.failureReason) failureCounts.set(
      run.failureReason,
      (failureCounts.get(run.failureReason) ?? 0) + 1
    )
  }

  return {
    rawRuns: runs.length,
    validRuns: valid.length,
    infrastructureInvalidRuns: runs.length - valid.length,
    successes: valid.filter(run => run.success).length,
    goalCompletionRate: ratio(completed.length, valid.length),
    successRate: ratio(valid.filter(run => run.success).length, valid.length),
    medianCompletionTimeMs: median(completed.map(run => run.durationMs)),
    meanCompletionTimeMs: mean(completed.map(run => run.durationMs)),
    medianDecisions: median(completed.map(run => run.decisionCount)),
    meanDecisions: mean(completed.map(run => run.decisionCount)),
    progressActionRate: ratio(sum(valid, run => run.progressActionCount), totalActions),
    noProgressRate: ratio(sum(valid, run => run.noProgressCount), totalActions),
    craftFailureRate: ratio(
      sum(valid, run => run.craftFailures),
      sum(valid, run => run.actionCounts.craft_item ?? 0)
    ),
    craftRetryRate: ratio(retriedCrafts.length, craftEvents.length),
    craftRetrySuccessRate: ratio(
      retriedCrafts.filter(event => event.retryResult === 'succeeded').length,
      retriedCrafts.length
    ),
    groundingRejectionRate: ratio(sum(valid, run => run.groundingRejections), totalCalls),
    validationRejectionRate: ratio(sum(valid, run => run.validationFailures), totalCalls),
    providerFailureRate: ratio(sum(valid, run => run.providerErrors), totalCalls),
    reflexTriggerRate: ratio(sum(valid, run => run.reflexes), totalActions),
    totalInputTokens: sum(valid, run => run.inputTokens),
    totalOutputTokens: sum(valid, run => run.outputTokens),
    averageInputTokens: ratio(sum(valid, run => run.inputTokens), valid.length),
    averageOutputTokens: ratio(sum(valid, run => run.outputTokens), valid.length),
    totalMemoryEpisodesCreated: sum(valid, run => run.memoryEpisodesCreated),
    totalMemoryEpisodesRetrieved: sum(valid, run => run.memoryEpisodesRetrieved),
    totalMemorySemanticFactsCreated: sum(
      valid,
      run => run.memorySemanticFactsCreated
    ),
    totalMemorySemanticFactsRetrieved: sum(
      valid,
      run => run.memorySemanticFactsRetrieved
    ),
    totalMemoryRetrievalFailures: sum(valid, run => run.memoryRetrievalFailures),
    totalMemoryPersistenceFailures: sum(
      valid,
      run => run.memoryPersistenceFailures
    ),
    totalReflectionCalls: sum(valid, run => run.reflectionCalls),
    totalReflectionFailures: sum(valid, run => run.reflectionFailures),
    reflectionFailureRate: ratio(
      sum(valid, run => run.reflectionFailures),
      sum(valid, run => run.reflectionCalls)
    ),
    totalReflectionInputTokens: sum(valid, run => run.reflectionInputTokens),
    totalReflectionOutputTokens: sum(valid, run => run.reflectionOutputTokens),
    totalEstimatedMemoryPromptTokens: sum(
      valid,
      run => run.estimatedMemoryPromptTokens
    ),
    mostCommonFailureReason: [...failureCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? null
  }
}

function emptyMemoryMetrics(): MemoryMetrics {
  return {
    episodesCreated: 0,
    episodesRetrieved: 0,
    semanticFactsCreated: 0,
    semanticFactsRetrieved: 0,
    retrievalFailures: 0,
    persistenceFailures: 0,
    reflectionCalls: 0,
    reflectionFailures: 0,
    reflectionInputTokens: 0,
    reflectionOutputTokens: 0,
    estimatedMemoryPromptTokens: 0
  }
}

function classifyExecutionFailure(cycle: Extract<BrainCycleResult, { status: 'executed' }>): BootstrapFailureReason {
  return classifyResultDetails(cycle.result)
}

function classifyResultDetails(result: { action: string, details?: Record<string, unknown> }): BootstrapFailureReason {
  const reason = typeof result.details?.reason === 'string' ? result.details.reason : ''
  if (result.action === 'craft_item') return 'crafting_failure'
  if (reason.includes('navigation') || reason.includes('route')) return 'navigation_failure'
  return 'world_state_failure'
}

function isGroundingIssue(issue: string): boolean {
  return /currently (craftable|observed|placeable)|target must be/i.test(issue)
}

function progressChanged(left: GoalProgress | null, right: GoalProgress | null): boolean {
  return JSON.stringify(left) !== JSON.stringify(right)
}

function sum<T>(items: readonly T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0)
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
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

function positiveIntegerOrNull(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) > 0
    ? value as number
    : null
}

function positiveIntegerOrZero(value: unknown): number {
  return positiveIntegerOrNull(value) ?? 0
}

function isRetryResult(
  value: unknown
): value is CraftTelemetryEvent['retryResult'] {
  return value === 'not_needed' || value === 'succeeded' || value === 'failed'
}
