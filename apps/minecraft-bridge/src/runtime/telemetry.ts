import type { LLMProvider, LLMRequestTiming } from '../brain/provider.js'
import type { MemoryMetrics } from '../memory/coordinator.js'
import type { ConversationTelemetryEvent } from '../social/conversationCoordinator.js'
import type { SocialEventType } from '../social/events.js'
import type { SocialProvider } from '../social/provider.js'
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
  social: SocialTelemetrySnapshot
}

export interface SocialTelemetrySnapshot {
  providerCalls: number
  providerFailures: number
  inputTokens: number
  outputTokens: number
  providerLatenciesMs: number[]
  providerQueueWaitMs: number[]
  conversationsStarted: number
  conversationsCompleted: number
  conversationsTimedOut: number
  conversationsInterrupted: number
  turnsCompleted: number
  invalidOutputs: number
  budgetExhaustions: number
  loopRejections: number
  staleResponses: number
  terminalConversationTurns: number[]
  relationshipUpdates: {
    agentSeen: number
    conversationCompleted: number
  }
  episodesCreated: number
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

export interface AgentProviderTelemetry {
  recordProviderCall(event: {
    succeeded: boolean
    providerLatencyMs: number
    queueWaitMs: number
    timing: LLMRequestTiming | null
  }): void
}

export interface SocialProviderTelemetry {
  recordSocialProviderCall(event: {
    succeeded: boolean
    providerLatencyMs: number
    queueWaitMs: number
    timing: LLMRequestTiming | null
  }): void
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
  private readonly social: SocialTelemetrySnapshot = createEmptySocialTelemetry()

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

  recordSocialProviderCall(event: {
    succeeded: boolean
    providerLatencyMs: number
    queueWaitMs: number
    timing: LLMRequestTiming | null
  }): void {
    this.social.providerCalls += 1
    if (!event.succeeded) this.social.providerFailures += 1
    this.social.inputTokens += event.timing?.promptTokens ?? 0
    this.social.outputTokens += event.timing?.outputTokens ?? 0
    this.social.providerLatenciesMs.push(nonNegative(event.providerLatencyMs))
    this.social.providerQueueWaitMs.push(nonNegative(event.queueWaitMs))
  }

  recordConversationTelemetry(event: ConversationTelemetryEvent): void {
    switch (event.type) {
      case 'started':
        this.social.conversationsStarted += 1
        return
      case 'turn_completed':
        this.social.turnsCompleted += 1
        return
      case 'stale_response':
        this.social.staleResponses += 1
        return
      case 'budget_exhausted':
        this.social.budgetExhaustions += 1
        return
      case 'terminal':
        this.social.terminalConversationTurns.push(event.turns)
        if (event.outcome === 'completed') {
          this.social.conversationsCompleted += 1
        } else if (event.outcome === 'timeout') {
          this.social.conversationsTimedOut += 1
        } else {
          this.social.conversationsInterrupted += 1
        }
        if (event.outcome === 'invalid_response') {
          this.social.invalidOutputs += 1
        }
    }
  }

  recordSocialEvent(
    type: SocialEventType,
    relationshipChanged: boolean,
    episodesCreated: number
  ): void {
    if (relationshipChanged && type === 'agent_seen') {
      this.social.relationshipUpdates.agentSeen += 1
    }
    if (relationshipChanged && type === 'conversation_completed') {
      this.social.relationshipUpdates.conversationCompleted += 1
    }
    this.social.episodesCreated += Math.max(0, episodesCreated)
  }

  recordSocialLoopRejection(): void {
    this.social.loopRejections += 1
  }

  recordSocialBudgetExhaustion(): void {
    this.social.budgetExhaustions += 1
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
      memory: this.memory ? { ...this.memory } : null,
      social: cloneSocialTelemetry(this.social)
    }
  }
}

export function instrumentAgentProvider(
  provider: LLMProvider,
  limiter: ProviderConcurrencyLimiter,
  telemetry: AgentProviderTelemetry,
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

export function instrumentSocialProvider(
  provider: SocialProvider,
  limiter: ProviderConcurrencyLimiter,
  telemetry: SocialProviderTelemetry,
  runtimeSignal: AbortSignal,
  now: () => number = Date.now
): SocialProvider {
  let lastTiming: LLMRequestTiming | null = null
  return {
    generate(input, callSignal) {
      const cancellation = composeSignals(runtimeSignal, callSignal)
      return limiter.run(async queueWaitMs => {
        const startedAt = now()
        let succeeded = false
        try {
          const output = await provider.generate(input, cancellation.signal)
          succeeded = true
          return output
        } finally {
          cancellation.dispose()
          const providerLatencyMs = Math.max(0, now() - startedAt)
          const providerTiming = provider.getLastTiming?.() ?? null
          lastTiming = {
            ...(providerTiming ?? {}),
            totalDurationMs: providerTiming?.totalDurationMs ?? providerLatencyMs,
            queueWaitMs
          }
          telemetry.recordSocialProviderCall({
            succeeded,
            providerLatencyMs,
            queueWaitMs,
            timing: providerTiming
          })
        }
      }, cancellation.signal).catch(error => {
        cancellation.dispose()
        throw error
      })
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

export function createEmptySocialTelemetry(): SocialTelemetrySnapshot {
  return {
    providerCalls: 0,
    providerFailures: 0,
    inputTokens: 0,
    outputTokens: 0,
    providerLatenciesMs: [],
    providerQueueWaitMs: [],
    conversationsStarted: 0,
    conversationsCompleted: 0,
    conversationsTimedOut: 0,
    conversationsInterrupted: 0,
    turnsCompleted: 0,
    invalidOutputs: 0,
    budgetExhaustions: 0,
    loopRejections: 0,
    staleResponses: 0,
    terminalConversationTurns: [],
    relationshipUpdates: { agentSeen: 0, conversationCompleted: 0 },
    episodesCreated: 0
  }
}

function cloneSocialTelemetry(value: SocialTelemetrySnapshot): SocialTelemetrySnapshot {
  return {
    ...value,
    providerLatenciesMs: [...value.providerLatenciesMs],
    providerQueueWaitMs: [...value.providerQueueWaitMs],
    terminalConversationTurns: [...value.terminalConversationTurns],
    relationshipUpdates: { ...value.relationshipUpdates }
  }
}

function composeSignals(
  first: AbortSignal,
  second?: AbortSignal
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const abort = () => controller.abort()
  for (const signal of [first, second]) {
    if (!signal) continue
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', abort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      first.removeEventListener('abort', abort)
      second?.removeEventListener('abort', abort)
    }
  }
}
