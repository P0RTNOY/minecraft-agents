import type { AgentRuntimeSnapshot } from './agentRuntime.js'
import {
  decodeAgentConfigDocument,
  type AgentDefinition
} from './config.js'
import type { RuntimeAgentIdentity } from './telemetry.js'

export interface ManagedAgentRuntime {
  readonly identity: RuntimeAgentIdentity
  start(): Promise<void>
  stop(): Promise<void>
  snapshot(): AgentRuntimeSnapshot
}

export interface AgentManagerOptions {
  definitions: readonly AgentDefinition[]
  createRuntime(definition: AgentDefinition, index: number): ManagedAgentRuntime
  closeShared?: () => void | Promise<void>
}

export interface AgentLifecycleFailure {
  agentId: string
  username: string
  error: string
}

export interface AgentStartupSummary {
  started: string[]
  failures: AgentLifecycleFailure[]
}

export interface AgentShutdownSummary {
  stopped: string[]
  failures: AgentLifecycleFailure[]
}

export class AgentManager {
  private readonly definitions: readonly AgentDefinition[]
  private readonly createRuntime: AgentManagerOptions['createRuntime']
  private readonly closeShared: () => void | Promise<void>
  private readonly running: ManagedAgentRuntime[] = []
  private startPromise: Promise<AgentStartupSummary> | null = null
  private stopPromise: Promise<AgentShutdownSummary> | null = null
  private shutdownRequested = false
  private startingRuntime: ManagedAgentRuntime | null = null

  constructor(options: AgentManagerOptions) {
    this.definitions = decodeAgentConfigDocument({
      schemaVersion: 1,
      agents: options.definitions
    }).agents
    this.createRuntime = options.createRuntime
    this.closeShared = options.closeShared ?? (() => {})
  }

  startAll(): Promise<AgentStartupSummary> {
    if (!this.startPromise) this.startPromise = this.startInOrder()
    return this.startPromise
  }

  stopAll(): Promise<AgentShutdownSummary> {
    if (!this.stopPromise) {
      this.shutdownRequested = true
      const startingRuntime = this.startingRuntime
      const startingStop = startingRuntime?.stop() ?? null
      this.stopPromise = this.stopInReverseOrder(
        startingRuntime,
        startingStop
      )
    }
    return this.stopPromise
  }

  snapshots(): AgentRuntimeSnapshot[] {
    return this.running.map(runtime => runtime.snapshot())
  }

  private async startInOrder(): Promise<AgentStartupSummary> {
    const summary: AgentStartupSummary = { started: [], failures: [] }
    for (const [index, definition] of this.definitions.entries()) {
      if (this.shutdownRequested) break
      let runtime: ManagedAgentRuntime
      try {
        runtime = this.createRuntime({ ...definition }, index)
        requireMatchingIdentity(runtime.identity, definition)
        this.startingRuntime = runtime
        await runtime.start()
      } catch (error) {
        summary.failures.push(failureFor(definition, error))
        continue
      } finally {
        this.startingRuntime = null
      }
      if (this.shutdownRequested) continue
      this.running.push(runtime)
      summary.started.push(definition.id)
    }
    return cloneStartupSummary(summary)
  }

  private async stopInReverseOrder(
    startingRuntime: ManagedAgentRuntime | null,
    startingStop: Promise<void> | null
  ): Promise<AgentShutdownSummary> {
    if (this.startPromise) await this.startPromise
    const summary: AgentShutdownSummary = { stopped: [], failures: [] }
    if (startingRuntime && startingStop) {
      try {
        await startingStop
      } catch (error) {
        summary.failures.push({
          ...startingRuntime.identity,
          error: safeError(error)
        })
      }
    }
    for (const runtime of [...this.running].reverse()) {
      try {
        await runtime.stop()
        summary.stopped.push(runtime.identity.agentId)
      } catch (error) {
        summary.failures.push({
          ...runtime.identity,
          error: safeError(error)
        })
      }
    }
    try {
      await this.closeShared()
    } catch (error) {
      summary.failures.push({
        agentId: 'shared',
        username: 'shared',
        error: safeError(error)
      })
    }
    return cloneShutdownSummary(summary)
  }
}

function requireMatchingIdentity(
  actual: RuntimeAgentIdentity,
  expected: AgentDefinition
): void {
  if (
    actual.agentId !== expected.id ||
    actual.username !== expected.username
  ) {
    throw new Error('Runtime factory returned a mismatched agent identity.')
  }
}

function failureFor(
  definition: AgentDefinition,
  error: unknown
): AgentLifecycleFailure {
  return {
    agentId: definition.id,
    username: definition.username,
    error: safeError(error)
  }
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 300)
    : 'Unknown lifecycle error.'
}

function cloneStartupSummary(summary: AgentStartupSummary): AgentStartupSummary {
  return {
    started: [...summary.started],
    failures: summary.failures.map(failure => ({ ...failure }))
  }
}

function cloneShutdownSummary(summary: AgentShutdownSummary): AgentShutdownSummary {
  return {
    stopped: [...summary.stopped],
    failures: summary.failures.map(failure => ({ ...failure }))
  }
}
