import type { LLMProvider } from '../provider.js'
import {
  appendRecentDecision,
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

export interface BrainBenchmarkScenario {
  id: string
  description: string
  input: BrainInput
  samples?: number
}

export interface BrainBenchmarkResult {
  scenario: string
  sample: number
  provider: string
  model: string
  latencyMs: number
  valid: boolean
  action: AgentDecisionAction | null
  reason: string | null
  repeated: boolean
  unsafeTarget: boolean
  schemaFailure: boolean
  error: string | null
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
    let input = scenario.input
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
          sample,
          elapsedMilliseconds(startedAt, now()),
          formatError(error)
        ))
        continue
      }

      const latencyMs = elapsedMilliseconds(startedAt, now())
      const validation = validateDecision(output)

      if (!validation.success) {
        results.push({
          ...baseResult(options, scenario.id, sample, latencyMs, null),
          schemaFailure: true,
          error: validation.issues.map(issue => (
            `${issue.path || 'decision'}: ${issue.message}`
          )).join('; ')
        })
        continue
      }

      const contextualValidation = validateDecision(
        output,
        buildDecisionContext(input)
      )

      if (!contextualValidation.success) {
        results.push({
          ...baseResult(options, scenario.id, sample, latencyMs, null),
          unsafeTarget: true,
          error: contextualValidation.issues.map(issue => (
            `${issue.path || 'decision'}: ${issue.message}`
          )).join('; ')
        })
        continue
      }

      const decision = contextualValidation.decision
      const signature = decisionSignature(decision)
      results.push({
        scenario: scenario.id,
        sample,
        provider: options.providerName,
        model: options.model,
        latencyMs,
        valid: true,
        action: decision.action,
        reason: decision.reason,
        repeated: signature === previousSignature,
        unsafeTarget: false,
        schemaFailure: false,
        error: null
      })

      previousSignature = signature
      const result = simulatedResult(decision)
      input = {
        ...input,
        previousActionResult: result,
        recentDecisions: appendRecentDecision(
          input.recentDecisions,
          createRecentDecision(input, decision, result)
        )
      }
    }
  }

  return results
}

function baseResult(
  options: BrainBenchmarkOptions,
  scenario: string,
  sample: number,
  latencyMs: number,
  error: string | null
): BrainBenchmarkResult {
  return {
    scenario,
    sample,
    provider: options.providerName,
    model: options.model,
    latencyMs,
    valid: false,
    action: null,
    reason: null,
    repeated: false,
    unsafeTarget: false,
    schemaFailure: false,
    error
  }
}

function simulatedResult(decision: AgentDecision): DecisionExecutionResult {
  return {
    success: true,
    action: decision.action,
    status: 'completed',
    summary: 'Benchmark simulated execution.'
  }
}

function elapsedMilliseconds(start: number, end: number): number {
  return Math.max(0, Math.round((end - start) * 10) / 10)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
