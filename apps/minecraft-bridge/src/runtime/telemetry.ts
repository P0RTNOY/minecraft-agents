import type { LLMProvider, LLMRequestTiming } from '../brain/provider.js'
import type { MemoryMetrics } from '../memory/coordinator.js'
import { ProviderConcurrencyLimiter } from './providerLimiter.js'

export interface RuntimeAgentIdentity {
  agentId: string
  username: string
}

export interface AgentTelemetrySnapshot extends RuntimeAgentIdentity {
  providerCalls: number
  providerFailures: number
  inputTokens: number
  outputTokens: number
  providerLatenciesMs: number[]
  providerQueueWaitMs: number[]
  spawned: number
  disconnects: number
  errors: number
  kicked: number
  memory: MemoryMetrics | null
}

export interface AggregateAgentTelemetry {
  agents: number
  providerCalls: number
  providerFailures: number
  inputTokens: number
  outputTokens: number
  meanProviderLatencyMs: number | null
  medianProviderLatencyMs: number | null
  meanProviderQueueWaitMs: number | null
}

export class AgentRuntimeTelemetry {
  private providerCalls = 0
  private providerFailures = 0
  private inputTokens = 0
  private outputTokens = 0
  private readonly providerLatenciesMs: number[] = []
  private readonly providerQueueWaitMs: number[] = []
  private spawned = 0
  private disconnects = 0
  private errors = 0
  private kicked = 0
  private memory: MemoryMetrics | null = null

  constructor(private readonly identity: RuntimeAgentIdentity) {}

  recordProviderCall(event: {
    succeeded: boolean
    providerLatencyMs: number
    queueWaitMs: number
    timing: LLMRequestTiming | null
  }): void {
    this.providerCalls += 1
    if (!event.succeeded) this.providerFailures += 1
    this.inputTokens += event.timing?.promptTokens ?? 0
    this.outputTokens += event.timing?.outputTokens ?? 0
    this.providerLatenciesMs.push(nonNegative(event.providerLatencyMs))
    this.providerQueueWaitMs.push(nonNegative(event.queueWaitMs))
  }

  recordSpawn(): void {
    this.spawned += 1
  }

  recordDisconnect(): void {
    this.disconnects += 1
  }

  recordError(): void {
    this.errors += 1
  }

  recordKick(): void {
    this.kicked += 1
  }

  recordMemory(metrics: MemoryMetrics): void {
    this.memory = { ...metrics }
  }

  async flush(): Promise<void> {}

  snapshot(): AgentTelemetrySnapshot {
    return {
      ...this.identity,
      providerCalls: this.providerCalls,
      providerFailures: this.providerFailures,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      providerLatenciesMs: [...this.providerLatenciesMs],
      providerQueueWaitMs: [...this.providerQueueWaitMs],
      spawned: this.spawned,
      disconnects: this.disconnects,
      errors: this.errors,
      kicked: this.kicked,
      memory: this.memory ? { ...this.memory } : null
    }
  }
}

export function instrumentAgentProvider(
  provider: LLMProvider,
  limiter: ProviderConcurrencyLimiter,
  telemetry: AgentRuntimeTelemetry,
  signal: AbortSignal,
  now: () => number = Date.now
): LLMProvider {
  let lastTiming: LLMRequestTiming | null = null
  return {
    decide(input) {
      return limiter.run(async queueWaitMs => {
        const startedAt = now()
        let succeeded = false
        try {
          const output = await provider.decide(input)
          succeeded = true
          return output
        } finally {
          const providerLatencyMs = Math.max(0, now() - startedAt)
          const providerTiming = provider.getLastTiming?.() ?? null
          lastTiming = {
            ...(providerTiming ?? {}),
            totalDurationMs: providerTiming?.totalDurationMs ?? providerLatencyMs,
            queueWaitMs
          }
          telemetry.recordProviderCall({
            succeeded,
            providerLatencyMs,
            queueWaitMs,
            timing: providerTiming
          })
        }
      }, signal)
    },
    getLastTiming: () => lastTiming ? { ...lastTiming } : null
  }
}

export function summarizeAgentTelemetry(
  snapshots: readonly AgentTelemetrySnapshot[]
): AggregateAgentTelemetry {
  const latencies = snapshots.flatMap(snapshot => snapshot.providerLatenciesMs)
  const queueWait = snapshots.flatMap(snapshot => snapshot.providerQueueWaitMs)
  return {
    agents: snapshots.length,
    providerCalls: sum(snapshots, snapshot => snapshot.providerCalls),
    providerFailures: sum(snapshots, snapshot => snapshot.providerFailures),
    inputTokens: sum(snapshots, snapshot => snapshot.inputTokens),
    outputTokens: sum(snapshots, snapshot => snapshot.outputTokens),
    meanProviderLatencyMs: mean(latencies),
    medianProviderLatencyMs: median(latencies),
    meanProviderQueueWaitMs: mean(queueWait)
  }
}

function sum<T>(values: readonly T[], read: (value: T) => number): number {
  return values.reduce((total, value) => total + read(value), 0)
}

function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? null
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}
