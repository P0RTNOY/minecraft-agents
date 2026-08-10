import type { Bot } from 'mineflayer'

import { ActionArbiter } from '../agent/actionArbiter.js'
import { createAgentState, type AgentState } from '../agent/state.js'
import type { BrainConfig } from '../brain/config.js'
import type { LLMProvider } from '../brain/provider.js'
import type { AgentMemory } from '../memory/coordinator.js'
import type { AgentDefinition } from './config.js'
import type {
  AgentRuntimeServices,
  RuntimeLogger,
  RuntimeLoop,
  RuntimeTelemetry
} from './services.js'
import type {
  AgentTelemetrySnapshot,
  RuntimeAgentIdentity
} from './telemetry.js'

export type AgentRuntimePhase =
  | 'created'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'

export interface AgentRuntimeOptions {
  definition: AgentDefinition
  brainConfig: BrainConfig
  minecraft: {
    host: string
    port: number
    spawnTimeoutMs: number
  }
  brainStartDelayMs: number
  services: AgentRuntimeServices
}

export interface AgentRuntimeSnapshot {
  identity: RuntimeAgentIdentity
  phase: AgentRuntimePhase
  startedAt: number | null
  stoppedAt: number | null
  state: AgentState
  telemetry: AgentTelemetrySnapshot
}

export class AgentRuntime {
  readonly state: AgentState
  readonly arbiter = new ActionArbiter()
  readonly identity: RuntimeAgentIdentity

  private readonly definition: AgentDefinition
  private readonly config: BrainConfig
  private readonly minecraft: AgentRuntimeOptions['minecraft']
  private readonly brainStartDelayMs: number
  private readonly services: AgentRuntimeServices
  private readonly telemetry: RuntimeTelemetry
  private readonly logger: RuntimeLogger
  private readonly providerAbort = new AbortController()
  private phase: AgentRuntimePhase = 'created'
  private startedAt: number | null = null
  private stoppedAt: number | null = null
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private shutdownRequested = false
  private bot: Bot | null = null
  private memory: AgentMemory | null = null
  private provider: LLMProvider | null = null
  private brainLoop: RuntimeLoop | null = null
  private reflexLoop: RuntimeLoop | null = null
  private brainStartTimer: unknown = null
  private removeCommands: (() => void) | null = null
  private cancelSpawnWait: (() => void) | null = null
  private readonly removeRuntimeListeners: Array<() => void> = []

  constructor(options: AgentRuntimeOptions) {
    if (!Number.isSafeInteger(options.brainStartDelayMs) || options.brainStartDelayMs < 0) {
      throw new Error('Brain start delay must be a non-negative integer.')
    }
    this.definition = { ...options.definition }
    this.identity = {
      agentId: options.definition.id,
      username: options.definition.username
    }
    this.config = options.brainConfig
    this.minecraft = { ...options.minecraft }
    this.brainStartDelayMs = options.brainStartDelayMs
    this.services = options.services
    this.state = createAgentState(this.identity.username)
    this.telemetry = options.services.createTelemetry(this.identity)
    this.logger = prefixedLogger(options.services.logger, this.identity)
  }

  start(): Promise<void> {
    if (this.phase === 'running') return Promise.resolve()
    if (this.startPromise) return this.startPromise
    if (this.phase !== 'created') {
      return Promise.reject(new Error('Agent runtime cannot be restarted.'))
    }
    this.startPromise = this.startInternal()
    return this.startPromise
  }

  stop(): Promise<void> {
    if (!this.stopPromise) {
      this.shutdownRequested = true
      this.cancelSpawnWait?.()
      this.stopPromise = this.stopAfterStartup()
    }
    return this.stopPromise
  }

  snapshot(): AgentRuntimeSnapshot {
    return {
      identity: { ...this.identity },
      phase: this.phase,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      state: { ...this.state },
      telemetry: this.telemetry.snapshot()
    }
  }

  private async startInternal(): Promise<void> {
    this.phase = 'starting'
    try {
      const context = {
        identity: this.identity,
        definition: this.definition,
        config: this.config,
        logger: this.logger
      }
      const autonomous = this.definition.autonomous ?? this.config.autonomous
      const memoryEnabled = this.definition.memoryEnabled ?? this.config.memoryEnabled
      if (autonomous && memoryEnabled) {
        this.memory = await this.services.createMemory({
          ...context,
          memoryIdentity: {
            agentId: this.identity.agentId,
            worldId: this.config.memoryWorldId
          }
        })
        this.ensureStillStarting()
      }
      if (autonomous) {
        this.provider = this.services.createProvider({
          ...context,
          signal: this.providerAbort.signal,
          telemetry: this.telemetry
        })
      }

      const bot = this.services.createBot({
        host: this.minecraft.host,
        port: this.minecraft.port,
        username: this.identity.username
      })
      this.bot = bot
      this.attachRuntimeListeners(bot)
      await this.waitForSpawn(bot)
      this.ensureStillStarting()
      this.telemetry.recordSpawn()

      const loopContext = {
        ...context,
        bot,
        state: this.state,
        arbiter: this.arbiter,
        logger: this.logger
      }
      this.removeCommands = this.services.registerCommands(loopContext)
      this.reflexLoop = this.services.createReflexLoop(loopContext)
      if (this.provider) {
        this.brainLoop = this.services.createBrainLoop({
          ...loopContext,
          provider: this.provider,
          memory: this.memory
        })
      }

      this.reflexLoop.start()
      if (this.brainLoop) {
        this.brainStartTimer = this.services.scheduler.setTimeout(() => {
          this.brainStartTimer = null
          this.brainLoop?.start()
        }, this.brainStartDelayMs)
      }
      this.startedAt = this.services.now()
      this.phase = 'running'
      this.logger.log('runtime started')
    } catch (error) {
      if (!this.shutdownRequested) await this.stopInternal()
      throw error
    }
  }

  private async stopAfterStartup(): Promise<void> {
    if (this.startPromise && this.phase === 'starting') {
      try {
        await this.startPromise
      } catch {
        // Startup errors are reported to the start() caller; shutdown still cleans up.
      }
    }
    await this.stopInternal()
  }

  private async stopInternal(): Promise<void> {
    if (this.phase === 'stopped') return
    this.phase = 'stopping'
    const errors: unknown[] = []

    if (this.brainStartTimer !== null) {
      captureSync(errors, () => {
        this.services.scheduler.clearTimeout(this.brainStartTimer)
      })
      this.brainStartTimer = null
    }
    captureSync(errors, () => this.brainLoop?.stop())
    captureSync(errors, () => this.reflexLoop?.stop())
    this.providerAbort.abort()
    if (this.bot) {
      captureSync(errors, () => this.services.cancelAction(this.bot!, this.state))
    }
    await captureAsync(errors, async () => {
      await Promise.all([
        this.brainLoop?.waitForIdle(),
        this.reflexLoop?.waitForIdle()
      ])
    })
    if (this.memory) {
      captureSync(errors, () => this.telemetry.recordMemory(this.memory!.metrics()))
      await captureAsync(errors, () => this.memory!.flush())
    }
    await captureAsync(errors, () => this.telemetry.flush())
    if (this.bot) {
      captureSync(errors, () => this.bot!.quit('agent runtime stopped'))
    }
    captureSync(errors, () => this.removeCommands?.())
    this.removeCommands = null
    for (const remove of this.removeRuntimeListeners.splice(0)) {
      captureSync(errors, remove)
    }

    this.stoppedAt = this.services.now()
    this.phase = 'stopped'
    this.logger.log('runtime stopped')
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Agent runtime shutdown failed.')
    }
  }

  private attachRuntimeListeners(bot: Bot): void {
    const onError = (error: Error) => {
      this.telemetry.recordError()
      this.logger.error(`Minecraft error: ${safeError(error)}`)
    }
    const onKicked = (reason: unknown) => {
      this.telemetry.recordKick()
      this.logger.error(`Minecraft connection kicked: ${safeReason(reason)}`)
    }
    const onEnd = () => {
      if (this.phase === 'stopping' || this.phase === 'stopped') return
      this.telemetry.recordDisconnect()
      void this.stop().catch(error => {
        this.logger.error(`Shutdown after disconnect failed: ${safeError(error)}`)
      })
    }
    bot.on('error', onError)
    bot.on('kicked', onKicked)
    bot.on('end', onEnd)
    this.removeRuntimeListeners.push(
      () => bot.off('error', onError),
      () => bot.off('kicked', onKicked),
      () => bot.off('end', onEnd)
    )
  }

  private waitForSpawn(bot: Bot): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const timeout = this.services.scheduler.setTimeout(() => {
        finish(() => reject(new Error(
          `Minecraft spawn timed out after ${this.minecraft.spawnTimeoutMs} ms.`
        )))
      }, this.minecraft.spawnTimeoutMs)
      const onSpawn = () => finish(resolve)
      const onError = (error: Error) => finish(() => reject(error))
      const onEnd = () => finish(() => reject(new Error(
        'Minecraft connection ended before spawn.'
      )))
      const finish = (complete: () => void) => {
        if (settled) return
        settled = true
        this.cancelSpawnWait = null
        this.services.scheduler.clearTimeout(timeout)
        bot.off('spawn', onSpawn)
        bot.off('error', onError)
        bot.off('end', onEnd)
        complete()
      }
      this.cancelSpawnWait = () => finish(() => reject(new Error(
        'Agent runtime stopped during startup.'
      )))
      bot.once('spawn', onSpawn)
      bot.once('error', onError)
      bot.once('end', onEnd)
    })
  }

  private ensureStillStarting(): void {
    if (this.shutdownRequested || this.phase !== 'starting') {
      throw new Error('Agent runtime stopped during startup.')
    }
  }
}

function prefixedLogger(
  logger: RuntimeLogger,
  identity: RuntimeAgentIdentity
): RuntimeLogger {
  const prefix = `[${identity.agentId}/${identity.username}]`
  return {
    log: message => logger.log(`${prefix} ${message}`),
    error: message => logger.error(`${prefix} ${message}`)
  }
}

function captureSync(errors: unknown[], operation: () => void): void {
  try {
    operation()
  } catch (error) {
    errors.push(error)
  }
}

async function captureAsync(
  errors: unknown[],
  operation: () => Promise<void>
): Promise<void> {
  try {
    await operation()
  } catch (error) {
    errors.push(error)
  }
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 200)
    : 'Unknown Minecraft error.'
}

function safeReason(reason: unknown): string {
  return typeof reason === 'string' ? reason.slice(0, 200) : 'Unknown reason.'
}
