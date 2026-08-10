import type { Bot } from 'mineflayer'

import { ActionArbiter } from '../agent/actionArbiter.js'
import { createAgentState, type AgentState } from '../agent/state.js'
import type { BrainConfig } from '../brain/config.js'
import type { LLMProvider } from '../brain/provider.js'
import type { AgentMemory } from '../memory/coordinator.js'
import { regionForPosition } from '../memory/recorder.js'
import type { PerceptionSnapshot } from '../perception/types.js'
import { CognitiveGate } from '../social/cognitiveGate.js'
import { buildVisibleAgentSocialContext } from '../social/context.js'
import type {
  ConversationCoordinator,
  ConversationParticipant,
  ConversationParticipantContext,
  ConversationTelemetryEvent,
  StartConversationResult
} from '../social/conversationCoordinator.js'
import type { SocialEvent } from '../social/events.js'
import type { SocialGenerationInput } from '../social/provider.js'
import type { RuntimeSocialResources } from './services.js'
import { say } from '../skills/social.js'
import { evaluateReflex } from '../survival/evaluateReflex.js'
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
  socialCoordinator?: ConversationCoordinator
  configuredAgents?: readonly AgentDefinition[]
}

export interface AgentRuntimeSnapshot {
  identity: RuntimeAgentIdentity
  phase: AgentRuntimePhase
  startedAt: number | null
  stoppedAt: number | null
  visibleExternalPlayers: string[]
  state: AgentState
  telemetry: AgentTelemetrySnapshot
}

export class AgentRuntime implements ConversationParticipant {
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
  private readonly socialCoordinator: ConversationCoordinator | null
  private readonly configuredAgents: readonly AgentDefinition[]
  private readonly cognitiveGate = new CognitiveGate()
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
  private socialResources: RuntimeSocialResources | null = null
  private brainLoop: RuntimeLoop | null = null
  private reflexLoop: RuntimeLoop | null = null
  private brainStartTimer: unknown = null
  private removeCommands: (() => void) | null = null
  private cancelSpawnWait: (() => void) | null = null
  private lastVisibleExternalPlayers: string[] = []
  private readonly removeRuntimeListeners: Array<() => void> = []
  private readonly recentSocialEvents: SocialEvent[] = []
  private socialRegistered = false

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
    this.socialCoordinator = options.socialCoordinator ?? null
    this.configuredAgents = (options.configuredAgents ?? [options.definition])
      .map(agent => ({ ...agent }))
    this.state = createAgentState(this.identity.username)
    this.telemetry = options.services.createTelemetry(this.identity)
    this.logger = prefixedLogger(options.services.logger, this.identity)
  }

  get agentId(): string {
    return this.identity.agentId
  }

  get username(): string {
    return this.identity.username
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
    if (this.bot && this.phase !== 'stopped') {
      this.lastVisibleExternalPlayers = [
        ...this.services.observeVisibleExternalPlayers(this.bot, this.state)
      ]
    }
    return {
      identity: { ...this.identity },
      phase: this.phase,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      visibleExternalPlayers: [...this.lastVisibleExternalPlayers],
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
      const socialEnabled = this.config.socialEnabled
      if ((autonomous || socialEnabled) && memoryEnabled) {
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
      if (socialEnabled) {
        if (!this.socialCoordinator || !this.services.createSocialResources) {
          throw new Error('Social runtime services are unavailable.')
        }
        this.socialResources = await this.services.createSocialResources({
          ...context,
          signal: this.providerAbort.signal,
          telemetry: this.telemetry,
          configuredAgentIds: this.configuredAgents.map(agent => agent.id)
        })
        this.ensureStillStarting()
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
      if (this.socialResources && this.socialCoordinator) {
        this.socialCoordinator.registerParticipant(this)
        this.socialRegistered = true
        this.attachSocialObservation(bot)
      }

      const loopContext = {
        ...context,
        bot,
        state: this.state,
        arbiter: this.arbiter,
        logger: this.logger,
        onReflexDecision: () => this.interruptCognition('reflex'),
        onManualActivity: () => this.interruptCognition('manual'),
        ...(this.socialCoordinator ? {
            startConversation: (targetAgentId: string) => this.startConversation(
              targetAgentId
            )
          } : {})
      }
      this.removeCommands = this.services.registerCommands(loopContext)
      this.reflexLoop = this.services.createReflexLoop(loopContext)
      if (this.provider) {
        this.brainLoop = this.services.createBrainLoop({
          ...loopContext,
          provider: this.provider,
          memory: this.memory,
          cognitiveGate: this.cognitiveGate,
          ...(this.socialResources ? {
              socialContext: (perception: PerceptionSnapshot) => (
                this.visibleSocialContext(perception)
              )
            } : {})
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

    captureSync(errors, () => this.removeCommands?.())
    this.removeCommands = null
    for (const remove of this.removeRuntimeListeners.splice(0)) {
      captureSync(errors, remove)
    }
    if (this.brainStartTimer !== null) {
      captureSync(errors, () => {
        this.services.scheduler.clearTimeout(this.brainStartTimer)
      })
      this.brainStartTimer = null
    }
    captureSync(errors, () => this.brainLoop?.stop())
    captureSync(errors, () => this.reflexLoop?.stop())
    this.cognitiveGate.stop()
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
    if (this.socialRegistered && this.socialCoordinator) {
      await captureAsync(errors, () => this.socialCoordinator!.unregisterParticipant(
        this.agentId
      ))
      this.socialRegistered = false
    }
    if (this.socialResources) {
      await captureAsync(errors, () => this.socialResources!.relationshipStore.flush())
    }
    if (this.memory) {
      captureSync(errors, () => this.telemetry.recordMemory(this.memory!.metrics()))
      await captureAsync(errors, () => this.memory!.flush())
    }
    await captureAsync(errors, () => this.telemetry.flush())
    if (this.bot) {
      captureSync(errors, () => this.bot!.quit('agent runtime stopped'))
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

  canSee(agentId: string): boolean {
    const target = this.configuredAgents.find(agent => agent.id === agentId)
    if (!target || !this.bot || target.id === this.agentId) return false
    const visible = this.services.observeVisibleExternalPlayers(this.bot, this.state)
    return visible.some(username => (
      username.toLowerCase() === target.username.toLowerCase()
    ))
  }

  isInDanger(): boolean {
    if (!this.bot || !this.services.observePerception) return false
    try {
      return evaluateReflex(this.services.observePerception(this.bot)) !== null
    } catch {
      return true
    }
  }

  beginSocialSession(conversationId: string): number {
    return this.cognitiveGate.beginSocialSession(conversationId)
  }

  async socialContext(targetAgentId: string): Promise<ConversationParticipantContext> {
    const resources = this.requireSocialResources()
    const [relationship] = await resources.relationships.summariesFor([
      targetAgentId
    ])
    if (!relationship) throw new Error('Social relationship context is unavailable.')
    const lastEvent = [...this.recentSocialEvents]
      .reverse()
      .find(event => event.verified && socialEventTarget(event) === targetAgentId)
    return {
      relationship: {
        familiarity: relationship.familiarity,
        trust: relationship.trust,
        affinity: relationship.affinity,
        reciprocity: relationship.reciprocity,
        interactionCount: relationship.interactionCount
      },
      lastVerifiedInteraction: lastEvent?.type ?? null,
      recentMemory: []
    }
  }

  async generateSocial(
    input: SocialGenerationInput,
    generation: number
  ): Promise<unknown> {
    const cognition = await this.cognitiveGate.runSocial(
      generation,
      signal => this.requireSocialResources().provider.generate(input, signal)
    )
    if (cognition.status !== 'completed') {
      throw new Error('Social generation became stale.')
    }
    return cognition.value
  }

  emitSocialMessage(message: string, generation: number): boolean {
    const conversationId = this.cognitiveGate.snapshot().socialSessionId
    if (
      !this.bot ||
      !conversationId ||
      !this.cognitiveGate.isCurrent(conversationId, generation)
    ) return false
    return say(this.bot, message).success
  }

  async recordSocialEvent(event: SocialEvent): Promise<void> {
    const resources = this.requireSocialResources()
    const relationship = await resources.relationships.record(event)
    let episodesCreated = 0
    if (this.memory) {
      const perception = this.currentPerception()
      const recorded = await this.memory.recordSocial({
        event,
        position: { ...perception.position },
        region: regionForPosition(perception.position)
      })
      episodesCreated = recorded.episodesCreated
      if (recorded.error) throw new Error('Social memory persistence failed.')
    }
    this.recentSocialEvents.push(event)
    this.recentSocialEvents.splice(0, Math.max(0, this.recentSocialEvents.length - 32))
    this.telemetry.recordSocialEvent(
      event.type,
      relationship.changed,
      episodesCreated
    )
  }

  recordConversationTelemetry(event: ConversationTelemetryEvent): void {
    this.telemetry.recordConversationTelemetry(event)
  }

  endSocialSession(conversationId: string): void {
    this.cognitiveGate.endSocialSession(conversationId)
  }

  private startConversation(targetAgentId: string): Promise<StartConversationResult> {
    if (!this.socialCoordinator) {
      return Promise.resolve({ accepted: false, reason: 'disabled' })
    }
    return this.socialCoordinator.startConversation(
      this.agentId,
      targetAgentId,
      'operator'
    ).then(result => {
      if (!result.accepted) this.telemetry.recordSocialLoopRejection()
      return result
    })
  }

  private interruptCognition(reason: 'manual' | 'reflex'): void {
    this.cognitiveGate.invalidate(reason)
    void this.socialCoordinator?.interruptAgent(this.agentId, reason).catch(() => {
      this.logger.error('Social interruption failed.')
    })
  }

  private attachSocialObservation(bot: Bot): void {
    let previouslyVisible = new Set<string>()
    const onPhysicsTick = () => {
      const visible = new Set(this.visibleConfiguredAgentIds())
      for (const targetAgentId of visible) {
        if (!previouslyVisible.has(targetAgentId)) {
          void this.socialCoordinator?.observeEncounter(
            this.agentId,
            targetAgentId
          ).catch(() => this.logger.error('Social encounter processing failed.'))
        }
      }
      previouslyVisible = visible
    }
    bot.on('physicsTick', onPhysicsTick)
    this.removeRuntimeListeners.push(() => bot.off('physicsTick', onPhysicsTick))
  }

  private visibleConfiguredAgentIds(): string[] {
    if (!this.bot) return []
    const visible = new Set(
      this.services.observeVisibleExternalPlayers(this.bot, this.state)
        .map(username => username.toLowerCase())
    )
    return this.configuredAgents
      .filter(agent => (
        agent.id !== this.agentId && visible.has(agent.username.toLowerCase())
      ))
      .map(agent => agent.id)
  }

  private async visibleSocialContext(
    perception: PerceptionSnapshot
  ) {
    const resources = this.requireSocialResources()
    const visibleAgentIds = this.visibleConfiguredAgentIds()
    const relationships = await resources.relationships.summariesFor(
      visibleAgentIds
    )
    const visibleUsernames = new Set(
      perception.nearbyEntities
        .filter(entity => entity.type === 'player')
        .map(entity => entity.name.toLowerCase())
    )
    return buildVisibleAgentSocialContext({
      observerAgentId: this.agentId,
      worldId: this.config.memoryWorldId,
      configuredAgents: this.configuredAgents.map(agent => ({
        agentId: agent.id,
        username: agent.username
      })),
      visibleUsernames: this.configuredAgents
        .filter(agent => visibleUsernames.has(agent.username.toLowerCase()))
        .map(agent => agent.username),
      relationships,
      recentEvents: this.recentSocialEvents
    })
  }

  private currentPerception(): PerceptionSnapshot {
    if (!this.bot || !this.services.observePerception) {
      throw new Error('Current social perception is unavailable.')
    }
    return this.services.observePerception(this.bot)
  }

  private requireSocialResources(): RuntimeSocialResources {
    if (!this.socialResources) throw new Error('Social runtime is unavailable.')
    return this.socialResources
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

function socialEventTarget(event: SocialEvent): string | undefined {
  return event.type === 'agent_seen' || event.type === 'agent_speech_observed'
    ? event.actorAgentId
    : event.targetAgentId
}

function safeReason(reason: unknown): string {
  return typeof reason === 'string' ? reason.slice(0, 200) : 'Unknown reason.'
}
