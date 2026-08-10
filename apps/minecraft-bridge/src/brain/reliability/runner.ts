import type { BrainCycleResult } from '../../agent/loop.js'
import { computeGoalProgress } from '../goals.js'
import type { PerceptionSnapshot } from '../../perception/types.js'
import {
  BootstrapRunTelemetry,
  summarizeBootstrapRuns,
  type BootstrapReliabilitySummary,
  type BootstrapRunResult
} from './telemetry.js'

export interface BootstrapTrial {
  runCycle(): Promise<BrainCycleResult>
  observe(): PerceptionSnapshot
  infrastructureInvalid?(): boolean
}

export interface BootstrapTrialsOptions {
  runs: number
  provider: string
  model: string
  maxDecisions: number
  timeoutMs: number
  prepare(runId: string): Promise<void>
  cleanup(runId: string): Promise<void>
  createTrial(runId: string, telemetry: BootstrapRunTelemetry): BootstrapTrial
  now?: () => number
}

export interface BootstrapTrialsResult {
  runs: BootstrapRunResult[]
  summary: BootstrapReliabilitySummary
}

export async function runBootstrapTrials(
  options: BootstrapTrialsOptions
): Promise<BootstrapTrialsResult> {
  requirePositiveInteger(options.runs, 'runs')
  requirePositiveInteger(options.maxDecisions, 'maxDecisions')
  requirePositiveInteger(options.timeoutMs, 'timeoutMs')
  const now = options.now ?? Date.now
  const results: BootstrapRunResult[] = []

  for (let index = 0; index < options.runs; index += 1) {
    const runId = `run-${index + 1}`
    const startedAt = now()
    const telemetry = new BootstrapRunTelemetry({
      runId,
      provider: options.provider,
      model: options.model,
      startedAt
    })
    let trial: BootstrapTrial | null = null
    let finalSnapshot: PerceptionSnapshot | null = null
    let timedOut = false
    let infrastructureInvalid = false

    try {
      await options.prepare(runId)
      trial = options.createTrial(runId, telemetry)
      finalSnapshot = trial.observe()

      for (let decision = 0; decision < options.maxDecisions; decision += 1) {
        const before = finalSnapshot
        const remainingMs = options.timeoutMs - (now() - startedAt)
        if (remainingMs <= 0) {
          timedOut = true
          break
        }

        const cycle = await withTimeout(trial.runCycle(), remainingMs)
        if (cycle === null) {
          timedOut = true
          break
        }

        finalSnapshot = trial.observe()
        const beforeProgress = bootstrapProgress(before)
        const afterProgress = bootstrapProgress(finalSnapshot)
        telemetry.recordCycle(cycle, beforeProgress, afterProgress)
        if (afterProgress.completed) break
      }

      infrastructureInvalid ||= trial.infrastructureInvalid?.() ?? false
    } catch {
      infrastructureInvalid = true
    } finally {
      try {
        await options.cleanup(runId)
      } catch {
        infrastructureInvalid = true
      }
    }

    const finalProgress = finalSnapshot ? bootstrapProgress(finalSnapshot) : null
    results.push(telemetry.finish({
      completedAt: now(),
      finalProgress,
      finalInventory: finalSnapshot?.inventory ?? [],
      timedOut,
      infrastructureInvalid
    }))
  }

  return { runs: results, summary: summarizeBootstrapRuns(results) }
}

function bootstrapProgress(snapshot: PerceptionSnapshot) {
  return computeGoalProgress(snapshot, 'establish_basic_resources')
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
}
