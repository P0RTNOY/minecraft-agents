import type { LLMProvider, LLMRequestTiming } from '../provider.js'
import { ShortTermGoalManager } from '../goals.js'
import {
  appendRecentDecision,
  assessRepetition,
  createRecentDecision,
  decisionSignature
} from '../repetition.js'
import { buildDecisionContext } from '../semantics.js'
import type {
  AgentDecision,
  AgentDecisionAction,
  BrainInput,
  DecisionExecutionResult
} from '../types.js'
import { validateDecision } from '../validateDecision.js'

export type BrainBenchmarkScenarioKind = 'static' | 'sequential_goal'

export interface BrainBenchmarkTransitionResult {
  perception: BrainInput['perception']
  result: DecisionExecutionResult
}

export interface BrainBenchmarkScenario {
  id: string
  description: string
  input: BrainInput
  samples?: number
  kind?: BrainBenchmarkScenarioKind
  transition?: (
    input: BrainInput,
    decision: AgentDecision
  ) => BrainBenchmarkTransitionResult
}

export interface BrainBenchmarkResult {
  scenario: string
  scenarioKind: BrainBenchmarkScenarioKind
  sample: number
  provider: string
  model: string
  latencyMs: number
  timing: LLMRequestTiming | null
  valid: boolean
  grounded: boolean
  policyAccepted: boolean
  action: AgentDecisionAction | null
  reason: string | null
  repeated: boolean
  progressProduced: boolean
  noProgress: boolean
  goalCompleted: boolean
  repeatedNoProgress: boolean
  unsafeTarget: boolean
  schemaFailure: boolean
  error: string | null
}

export interface BrainBenchmarkSummary {
  provider: string
  model: string
  samples: number
  validDecisions: number
  groundedDecisions: number
  policyAcceptedDecisions: number
  actionDiversity: number
  progressProducingDecisions: number
  noProgressDecisions: number
  idleDecisions: number
  idleRate: number
  repeatedNoProgressDecisions: number
  completedGoals: number
  goalScenarios: number
  goalCompletionRate: number
  meanLatencyMs: number
  medianLatencyMs: number
  promptTokens: number | null
  outputTokens: number | null
  meanLoadDurationMs: number | null
  meanOutputTokensPerSecond: number | null
}

export interface BrainBenchmarkOptions {
  provider: LLMProvider
  providerName: string
  model: string
  scenarios: readonly BrainBenchmarkScenario[]
  now?: () => number
}

export async function runBrainBenchmark(
  options: BrainBenchmarkOptions
): Promise<BrainBenchmarkResult[]> {
  const now = options.now ?? performance.now.bind(performance)
  const results: BrainBenchmarkResult[] = []

  for (const scenario of options.scenarios) {
    const samples = scenario.samples ?? 1
    const kind = scenario.kind ?? 'static'
    const goalManager = new ShortTermGoalManager()
    let input = withGoalSnapshot(
      scenario.input,
      goalManager.update(scenario.input.perception)
    )
    let previousSignature: string | null = null

    for (let sample = 1; sample <= samples; sample += 1) {
      const startedAt = now()
      let output: unknown

      try {
        output = await options.provider.decide(input)
      } catch (error) {
        results.push(baseResult(
          options,
          scenario.id,
          kind,
          sample,
          elapsedMilliseconds(startedAt, now()),
          formatError(error)
        ))
        continue
      }

      const latencyMs = elapsedMilliseconds(startedAt, now())
      const timing = readProviderTiming(options.provider)
      const validation = validateDecision(output)

      if (!validation.success) {
        results.push({
          ...baseResult(
            options,
            scenario.id,
            kind,
            sample,
            latencyMs,
            null
          ),
          timing,
          schemaFailure: true,
          error: formatValidationIssues(validation.issues)
        })
        continue
      }

      const proposedDecision = validation.decision
      const signature = decisionSignature(proposedDecision)
      const repeated = signature === previousSignature
      previousSignature = signature

      const contextualValidation = validateDecision(
        output,
        buildDecisionContext(input)
      )

      if (!contextualValidation.success) {
        results.push({
          ...baseResult(
            options,
            scenario.id,
            kind,
            sample,
            latencyMs,
            null
          ),
          timing,
          valid: true,
          action: proposedDecision.action,
          reason: proposedDecision.reason,
          repeated,
          noProgress: true,
          repeatedNoProgress: repeated,
          unsafeTarget: true,
          error: formatValidationIssues(contextualValidation.issues)
        })
        continue
      }

      const decision = contextualValidation.decision
      const repetition = assessRepetition(decision, input)

      if (!repetition.allowed) {
        results.push({
          scenario: scenario.id,
          scenarioKind: kind,
          sample,
          provider: options.providerName,
          model: options.model,
          latencyMs,
          timing,
          valid: true,
          grounded: true,
          policyAccepted: false,
          action: decision.action,
          reason: decision.reason,
          repeated,
          progressProduced: false,
          noProgress: true,
          goalCompleted: false,
          repeatedNoProgress: repeated,
          unsafeTarget: false,
          schemaFailure: false,
          error: repetition.reason
        })
        continue
      }

      const transition = scenario.transition?.(input, decision) ?? {
        perception: input.perception,
        result: simulatedResult(decision)
      }
      const goalSnapshot = goalManager.update(transition.perception)
      const nextInput: BrainInput = {
        ...input,
        perception: transition.perception,
        previousActionResult: transition.result,
        recentDecisions: appendRecentDecision(
          input.recentDecisions,
          createRecentDecision(input, decision, transition.result)
        ),
        shortTermGoal: goalSnapshot.shortTermGoal,
        goalProgress: goalSnapshot.goalProgress,
        availableCapabilities: goalSnapshot.availableCapabilities
      }
      const progressProduced = transition.result.success &&
        goalProgressChanged(input, nextInput)
      const goalCompleted = goalSnapshot.transition?.completedGoal !== undefined

      results.push({
        scenario: scenario.id,
        scenarioKind: kind,
        sample,
        provider: options.providerName,
        model: options.model,
        latencyMs,
        timing,
        valid: true,
        grounded: true,
        policyAccepted: true,
        action: decision.action,
        reason: decision.reason,
        repeated,
        progressProduced,
        noProgress: !progressProduced,
        goalCompleted,
        repeatedNoProgress: repeated && !progressProduced,
        unsafeTarget: false,
        schemaFailure: false,
        error: null
      })

      input = nextInput
    }
  }

  return results
}

export function summarizeBrainBenchmark(
  results: readonly BrainBenchmarkResult[]
): BrainBenchmarkSummary {
  const first = results[0]
  const latencies = results.map(result => result.latencyMs)
  const grounded = results.filter(result => result.grounded)
  const goalScenarioIds = new Set(
    results
      .filter(result => result.scenarioKind === 'sequential_goal')
      .map(result => result.scenario)
  )
  const completedGoalScenarioIds = new Set(
    results
      .filter(result => result.goalCompleted)
      .map(result => result.scenario)
  )

  return {
    provider: first?.provider ?? '',
    model: first?.model ?? '',
    samples: results.length,
    validDecisions: count(results, result => result.valid),
    groundedDecisions: grounded.length,
    policyAcceptedDecisions: count(
      results,
      result => result.policyAccepted
    ),
    actionDiversity: new Set(
      results.flatMap(result => result.action ? [result.action] : [])
    ).size,
    progressProducingDecisions: count(
      results,
      result => result.progressProduced
    ),
    noProgressDecisions: count(results, result => result.noProgress),
    idleDecisions: count(results, result => result.action === 'idle'),
    idleRate: rate(
      count(results, result => result.action === 'idle'),
      grounded.length
    ),
    repeatedNoProgressDecisions: count(
      results,
      result => result.repeatedNoProgress
    ),
    completedGoals: count(results, result => result.goalCompleted),
    goalScenarios: goalScenarioIds.size,
    goalCompletionRate: rate(
      completedGoalScenarioIds.size,
      goalScenarioIds.size
    ),
    meanLatencyMs: mean(latencies),
    medianLatencyMs: median(latencies),
    promptTokens: sumTiming(results, 'promptTokens'),
    outputTokens: sumTiming(results, 'outputTokens'),
    meanLoadDurationMs: meanTiming(results, 'loadDurationMs'),
    meanOutputTokensPerSecond: meanTiming(
      results,
      'outputTokensPerSecond'
    )
  }
}

function baseResult(
  options: BrainBenchmarkOptions,
  scenario: string,
  scenarioKind: BrainBenchmarkScenarioKind,
  sample: number,
  latencyMs: number,
  error: string | null
): BrainBenchmarkResult {
  return {
    scenario,
    scenarioKind,
    sample,
    provider: options.providerName,
    model: options.model,
    latencyMs,
    timing: null,
    valid: false,
    grounded: false,
    policyAccepted: false,
    action: null,
    reason: null,
    repeated: false,
    progressProduced: false,
    noProgress: false,
    goalCompleted: false,
    repeatedNoProgress: false,
    unsafeTarget: false,
    schemaFailure: false,
    error
  }
}

function withGoalSnapshot(
  input: BrainInput,
  snapshot: ReturnType<ShortTermGoalManager['update']>
): BrainInput {
  return {
    ...input,
    shortTermGoal: snapshot.shortTermGoal,
    goalProgress: snapshot.goalProgress,
    availableCapabilities: snapshot.availableCapabilities
  }
}

function goalProgressChanged(before: BrainInput, after: BrainInput): boolean {
  return JSON.stringify(before.goalProgress) !== JSON.stringify(after.goalProgress)
}

function simulatedResult(decision: AgentDecision): DecisionExecutionResult {
  return {
    success: true,
    action: decision.action,
    status: 'completed',
    summary: 'Benchmark simulated execution.'
  }
}

function readProviderTiming(provider: LLMProvider): LLMRequestTiming | null {
  const timing = provider.getLastTiming?.() ?? null
  return timing ? { ...timing } : null
}

function formatValidationIssues(
  issues: readonly { path: string; message: string }[]
): string {
  return issues.map(issue => (
    `${issue.path || 'decision'}: ${issue.message}`
  )).join('; ')
}

function elapsedMilliseconds(start: number, end: number): number {
  return Math.max(0, Math.round((end - start) * 10) / 10)
}

function count<T>(values: readonly T[], predicate: (value: T) => boolean) {
  return values.filter(predicate).length
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator)
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : sorted[middle] ?? 0
}

function sumTiming(
  results: readonly BrainBenchmarkResult[],
  field: 'promptTokens' | 'outputTokens'
): number | null {
  const values = timingValues(results, field)
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0)
}

function meanTiming(
  results: readonly BrainBenchmarkResult[],
  field: 'loadDurationMs' | 'outputTokensPerSecond'
): number | null {
  const values = timingValues(results, field)
  return values.length === 0 ? null : mean(values)
}

function timingValues(
  results: readonly BrainBenchmarkResult[],
  field: keyof LLMRequestTiming
): number[] {
  return results.flatMap(result => {
    const value = result.timing?.[field]
    return typeof value === 'number' ? [value] : []
  })
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
