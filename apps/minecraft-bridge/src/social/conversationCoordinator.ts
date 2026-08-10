import { createSocialEvent, type SocialEvent } from './events.js'
import type {
  SocialGenerationInput,
  SocialRelationshipContext,
  SocialTrigger
} from './provider.js'
import { validateSocialResponse } from './response.js'

export interface ConversationParticipantContext {
  relationship: SocialRelationshipContext
  lastVerifiedInteraction: string | null
  recentMemory: readonly string[]
}

export interface ConversationParticipant {
  readonly agentId: string
  readonly username: string
  canSee(agentId: string): boolean
  isInDanger(): boolean
  beginSocialSession(conversationId: string): number
  socialContext(targetAgentId: string): Promise<ConversationParticipantContext>
  generateSocial(
    input: SocialGenerationInput,
    generation: number
  ): Promise<unknown>
  emitSocialMessage(message: string, generation: number): boolean
  recordSocialEvent(event: SocialEvent): Promise<void>
  endSocialSession(conversationId: string): void
}

export type ConversationTerminalOutcome =
  | 'completed'
  | 'timeout'
  | 'danger'
  | 'participant_unavailable'
  | 'invalid_response'
  | 'provider_failed'
  | 'emission_rejected'
  | 'recording_failed'
  | 'manual'
  | 'reflex'
  | 'shutdown'

export type ConversationTelemetryEvent =
  | {
      type: 'started'
      conversationId: string
      initiatorAgentId: string
      targetAgentId: string
      trigger: ConversationStartTrigger
    }
  | {
      type: 'turn_completed'
      conversationId: string
      speakerAgentId: string
      turn: number
      providerCalls: number
    }
  | {
      type: 'stale_response'
      conversationId: string
      speakerAgentId: string
    }
  | {
      type: 'terminal'
      conversationId: string
      outcome: ConversationTerminalOutcome
      turns: number
      providerCalls: number
    }

export type ConversationStartTrigger = Exclude<SocialTrigger, 'reply'>

export type StartConversationResult =
  | { accepted: true; conversationId: string }
  | {
      accepted: false
      reason:
        | 'disabled'
        | 'stopping'
        | 'unknown_agent'
        | 'self_target'
        | 'not_visible'
        | 'danger'
        | 'busy'
        | 'cooldown'
        | 'invalid_trigger'
    }

export interface EncounterObservationResult {
  recorded: boolean
  conversation: StartConversationResult | null
}

export interface ConversationCoordinatorOptions {
  enabled: boolean
  worldId: string
  autoGreeting: boolean
  maxTurns: number
  cooldownMs: number
  turnTimeoutMs: number
  maxMessageCharacters: number
  now?: () => number
  onTelemetry?: (event: ConversationTelemetryEvent) => void
  logger?: { error(message: string): void }
}

export interface ConversationSessionSnapshot {
  conversationId: string
  participantAgentIds: readonly [string, string]
  currentSpeakerAgentId: string
  turns: number
  providerCalls: number
  maxTurns: number
  maxProviderCalls: number
  startedAt: number
}

export interface ConversationCoordinatorSnapshot {
  accepting: boolean
  sessions: ConversationSessionSnapshot[]
}

interface ConversationSession {
  conversationId: string
  participants: readonly [ConversationParticipant, ConversationParticipant]
  generations: ReadonlyMap<string, number>
  trigger: ConversationStartTrigger
  currentSpeakerAgentId: string
  turns: number
  providerCalls: number
  startedAt: number
  transcript: Array<{
    speakerAgentId: string
    recipientAgentId: string
    message: string
  }>
}

export class ConversationCoordinator {
  private readonly enabled: boolean
  private readonly worldId: string
  private readonly autoGreeting: boolean
  private readonly maxTurns: number
  private readonly cooldownMs: number
  private readonly turnTimeoutMs: number
  private readonly maxMessageCharacters: number
  private readonly now: () => number
  private readonly onTelemetry: ((event: ConversationTelemetryEvent) => void) | null
  private readonly logger: { error(message: string): void }
  private readonly participants = new Map<string, ConversationParticipant>()
  private readonly sessions = new Map<string, ConversationSession>()
  private readonly sessionByAgent = new Map<string, string>()
  private readonly pairCooldowns = new Map<string, number>()
  private readonly encounterCooldowns = new Map<string, number>()
  private readonly workers = new Set<Promise<void>>()
  private accepting = true
  private conversationSequence = 0
  private eventSequence = 0

  constructor(options: ConversationCoordinatorOptions) {
    this.enabled = options.enabled
    this.worldId = validateWorldId(options.worldId)
    this.autoGreeting = options.autoGreeting
    this.maxTurns = boundedInteger(options.maxTurns, 'maxTurns', 1, 8)
    this.cooldownMs = boundedInteger(
      options.cooldownMs,
      'cooldownMs',
      0,
      3_600_000
    )
    this.turnTimeoutMs = boundedInteger(
      options.turnTimeoutMs,
      'turnTimeoutMs',
      1,
      60_000
    )
    this.maxMessageCharacters = boundedInteger(
      options.maxMessageCharacters,
      'maxMessageCharacters',
      1,
      256
    )
    this.now = options.now ?? Date.now
    this.onTelemetry = options.onTelemetry ?? null
    this.logger = options.logger ?? console
  }

  registerParticipant(participant: ConversationParticipant): void {
    validateAgentId(participant.agentId)
    validateUsername(participant.username)
    if (!this.accepting) {
      throw new Error('Conversation coordinator is stopping.')
    }
    if (this.participants.has(participant.agentId)) {
      throw new Error('Conversation participant is already registered.')
    }
    this.participants.set(participant.agentId, participant)
  }

  async startConversation(
    initiatorAgentId: string,
    targetAgentId: string,
    trigger: SocialTrigger
  ): Promise<StartConversationResult> {
    if (!this.enabled) return rejected('disabled')
    if (!this.accepting) return rejected('stopping')
    const initiator = this.participants.get(initiatorAgentId)
    const target = this.participants.get(targetAgentId)
    if (!initiator || !target) return rejected('unknown_agent')
    if (initiatorAgentId === targetAgentId) return rejected('self_target')
    if (
      this.sessionByAgent.has(initiatorAgentId) ||
      this.sessionByAgent.has(targetAgentId)
    ) {
      return rejected('busy')
    }
    if (trigger === 'reply') return rejected('invalid_trigger')
    if (!initiator.canSee(targetAgentId) || !target.canSee(initiatorAgentId)) {
      return rejected('not_visible')
    }
    if (initiator.isInDanger() || target.isInDanger()) {
      return rejected('danger')
    }
    const pair = pairKey(initiatorAgentId, targetAgentId)
    const lastTerminalAt = this.pairCooldowns.get(pair)
    const now = this.currentTimestamp()
    if (
      lastTerminalAt !== undefined &&
      now - lastTerminalAt < this.cooldownMs
    ) {
      return rejected('cooldown')
    }

    const conversationId = `conversation-${++this.conversationSequence}`
    let initiatorGeneration: number
    try {
      initiatorGeneration = initiator.beginSocialSession(conversationId)
    } catch {
      return rejected('busy')
    }
    let targetGeneration: number
    try {
      targetGeneration = target.beginSocialSession(conversationId)
    } catch {
      initiator.endSocialSession(conversationId)
      return rejected('busy')
    }
    const session: ConversationSession = {
      conversationId,
      participants: [initiator, target],
      generations: new Map([
        [initiatorAgentId, initiatorGeneration],
        [targetAgentId, targetGeneration]
      ]),
      trigger,
      currentSpeakerAgentId: initiatorAgentId,
      turns: 0,
      providerCalls: 0,
      startedAt: now,
      transcript: []
    }
    this.sessions.set(conversationId, session)
    this.sessionByAgent.set(initiatorAgentId, conversationId)
    this.sessionByAgent.set(targetAgentId, conversationId)
    this.telemetry({
      type: 'started',
      conversationId,
      initiatorAgentId,
      targetAgentId,
      trigger
    })
    const worker = this.runSession(session)
      .catch(async () => {
        this.logger.error('Conversation coordinator worker failed.')
        if (this.isActive(session)) await this.finish(session, 'provider_failed')
      })
      .finally(() => {
        this.workers.delete(worker)
      })
    this.workers.add(worker)
    return { accepted: true, conversationId }
  }

  async observeEncounter(
    observerAgentId: string,
    targetAgentId: string
  ): Promise<EncounterObservationResult> {
    const observer = this.participants.get(observerAgentId)
    const target = this.participants.get(targetAgentId)
    if (!observer || !target || observerAgentId === targetAgentId) {
      return { recorded: false, conversation: null }
    }
    if (!observer.canSee(targetAgentId)) {
      return { recorded: false, conversation: null }
    }
    const key = `${observerAgentId}:${targetAgentId}`
    const now = this.currentTimestamp()
    const previous = this.encounterCooldowns.get(key)
    if (previous !== undefined && now - previous < this.cooldownMs) {
      return { recorded: false, conversation: null }
    }
    const event = this.event({
      worldId: this.worldId,
      timestamp: now,
      type: 'agent_seen',
      observerAgentId,
      actorAgentId: targetAgentId,
      verified: true,
      evidence: 'perception',
      metadata: {}
    })
    await observer.recordSocialEvent(event)
    this.encounterCooldowns.set(key, now)
    const conversation = this.autoGreeting
      ? await this.startConversation(observerAgentId, targetAgentId, 'encounter')
      : null
    return { recorded: true, conversation }
  }

  async interruptAgent(
    agentId: string,
    reason: 'manual' | 'reflex' | 'danger'
  ): Promise<boolean> {
    const conversationId = this.sessionByAgent.get(agentId)
    if (!conversationId) return false
    const session = this.sessions.get(conversationId)
    if (!session) return false
    await this.finish(session, reason)
    return true
  }

  prepareStop(): void {
    this.accepting = false
  }

  async close(): Promise<void> {
    this.prepareStop()
    await Promise.all(
      [...this.sessions.values()].map(session => this.finish(session, 'shutdown'))
    )
  }

  async waitForIdle(): Promise<void> {
    while (this.workers.size > 0) {
      await Promise.allSettled([...this.workers])
    }
  }

  snapshot(): ConversationCoordinatorSnapshot {
    return {
      accepting: this.accepting,
      sessions: [...this.sessions.values()]
        .sort((left, right) => left.conversationId.localeCompare(right.conversationId))
        .map(session => ({
          conversationId: session.conversationId,
          participantAgentIds: [
            session.participants[0].agentId,
            session.participants[1].agentId
          ],
          currentSpeakerAgentId: session.currentSpeakerAgentId,
          turns: session.turns,
          providerCalls: session.providerCalls,
          maxTurns: this.maxTurns,
          maxProviderCalls: this.maxTurns,
          startedAt: session.startedAt
        }))
    }
  }

  private async runSession(session: ConversationSession): Promise<void> {
    const started = await this.recordLifecycle(session, 'conversation_started')
    if (!this.isActive(session)) return
    if (!started) {
      await this.finish(session, 'recording_failed')
      return
    }

    while (this.isActive(session)) {
      if (session.turns >= this.maxTurns || session.providerCalls >= this.maxTurns) {
        await this.finish(session, 'completed')
        return
      }
      const speaker = this.participant(session, session.currentSpeakerAgentId)
      const recipient = this.otherParticipant(session, speaker.agentId)
      if (!this.pairAvailable(speaker, recipient)) {
        await this.finish(
          session,
          speaker.isInDanger() || recipient.isInDanger()
            ? 'danger'
            : 'participant_unavailable'
        )
        return
      }
      const generation = session.generations.get(speaker.agentId)
      if (generation === undefined) {
        await this.finish(session, 'provider_failed')
        return
      }

      let output: unknown
      try {
        output = await withTimeout(
          this.generateTurn(session, speaker, recipient, generation),
          this.turnTimeoutMs
        )
      } catch (error) {
        if (!this.isActive(session)) {
          this.stale(session, speaker.agentId)
          return
        }
        await this.finish(
          session,
          error instanceof TurnTimeoutError ? 'timeout' : 'provider_failed'
        )
        return
      }

      if (!this.isActive(session)) {
        this.stale(session, speaker.agentId)
        return
      }
      if (!this.pairAvailable(speaker, recipient)) {
        this.stale(session, speaker.agentId)
        await this.finish(
          session,
          speaker.isInDanger() || recipient.isInDanger()
            ? 'danger'
            : 'participant_unavailable'
        )
        return
      }
      const validation = validateSocialResponse(
        output,
        this.maxMessageCharacters
      )
      if (!validation.success) {
        await this.finish(session, 'invalid_response')
        return
      }
      if (!speaker.emitSocialMessage(validation.response.message, generation)) {
        this.stale(session, speaker.agentId)
        await this.finish(session, 'emission_rejected')
        return
      }

      session.turns += 1
      session.transcript.push({
        speakerAgentId: speaker.agentId,
        recipientAgentId: recipient.agentId,
        message: validation.response.message
      })
      session.transcript = session.transcript.slice(-this.maxTurns)
      this.telemetry({
        type: 'turn_completed',
        conversationId: session.conversationId,
        speakerAgentId: speaker.agentId,
        turn: session.turns,
        providerCalls: session.providerCalls
      })

      const recorded = await this.recordSpeech(
        session,
        speaker,
        recipient,
        validation.response.message
      )
      if (!this.isActive(session)) return
      if (!recorded) {
        await this.finish(session, 'recording_failed')
        return
      }
      if (
        validation.response.intent === 'farewell' ||
        !validation.response.continueConversation ||
        session.turns >= this.maxTurns ||
        session.providerCalls >= this.maxTurns
      ) {
        await this.finish(session, 'completed')
        return
      }
      session.currentSpeakerAgentId = recipient.agentId
    }
  }

  private async generateTurn(
    session: ConversationSession,
    speaker: ConversationParticipant,
    recipient: ConversationParticipant,
    generation: number
  ): Promise<unknown> {
    const context = await speaker.socialContext(recipient.agentId)
    if (!this.isActive(session)) throw new Error('stale session')
    const input: SocialGenerationInput = {
      speaker: { agentId: speaker.agentId, username: speaker.username },
      recipient: { agentId: recipient.agentId, username: recipient.username },
      trigger: session.turns === 0 ? session.trigger : 'reply',
      turn: session.turns + 1,
      maxTurns: this.maxTurns,
      verifiedContext: {
        recipientVisible: speaker.canSee(recipient.agentId),
        relationship: { ...context.relationship },
        lastVerifiedInteraction: context.lastVerifiedInteraction
      },
      untrustedData: {
        previousUtterances: session.transcript.slice(-4).map(item => ({
          ...item
        })),
        recentMemory: [...context.recentMemory].slice(0, 4)
      }
    }
    session.providerCalls += 1
    return speaker.generateSocial(input, generation)
  }

  private async finish(
    session: ConversationSession,
    outcome: ConversationTerminalOutcome
  ): Promise<void> {
    if (!this.isActive(session)) return
    this.sessions.delete(session.conversationId)
    for (const participant of session.participants) {
      this.sessionByAgent.delete(participant.agentId)
    }
    this.pairCooldowns.set(
      pairKey(session.participants[0].agentId, session.participants[1].agentId),
      this.currentTimestamp()
    )
    for (const participant of session.participants) {
      try {
        participant.endSocialSession(session.conversationId)
      } catch {
        this.logger.error('Conversation participant session cleanup failed.')
      }
    }
    this.telemetry({
      type: 'terminal',
      conversationId: session.conversationId,
      outcome,
      turns: session.turns,
      providerCalls: session.providerCalls
    })
    await this.recordLifecycle(
      session,
      outcome === 'completed'
        ? 'conversation_completed'
        : 'conversation_interrupted',
      outcome
    )
  }

  private async recordLifecycle(
    session: ConversationSession,
    type: 'conversation_started' | 'conversation_completed' | 'conversation_interrupted',
    outcome?: ConversationTerminalOutcome
  ): Promise<boolean> {
    const configured = [...this.participants.keys()]
    const results = await Promise.allSettled(session.participants.map(observer => {
      const target = this.otherParticipant(session, observer.agentId)
      const event = this.event({
        worldId: this.worldId,
        timestamp: this.currentTimestamp(),
        type,
        observerAgentId: observer.agentId,
        actorAgentId: observer.agentId,
        targetAgentId: target.agentId,
        conversationId: session.conversationId,
        verified: true,
        evidence: 'coordinator',
        metadata: type === 'conversation_started'
          ? { trigger: session.trigger }
          : { outcome: outcome ?? 'completed', turns: session.turns }
      }, configured)
      return observer.recordSocialEvent(event)
    }))
    return results.every(result => result.status === 'fulfilled')
  }

  private async recordSpeech(
    session: ConversationSession,
    speaker: ConversationParticipant,
    recipient: ConversationParticipant,
    message: string
  ): Promise<boolean> {
    const event = this.event({
      worldId: this.worldId,
      timestamp: this.currentTimestamp(),
      type: 'agent_speech_observed',
      observerAgentId: recipient.agentId,
      actorAgentId: speaker.agentId,
      targetAgentId: recipient.agentId,
      conversationId: session.conversationId,
      verified: false,
      evidence: 'minecraft_chat',
      metadata: { message }
    })
    try {
      await recipient.recordSocialEvent(event)
      return true
    } catch {
      return false
    }
  }

  private event(
    value: Omit<SocialEvent, 'id'>,
    configuredAgentIds = [...this.participants.keys()]
  ): SocialEvent {
    return createSocialEvent({
      id: `social-event-${++this.eventSequence}`,
      ...value
    }, configuredAgentIds)
  }

  private participant(
    session: ConversationSession,
    agentId: string
  ): ConversationParticipant {
    const participant = session.participants.find(item => item.agentId === agentId)
    if (!participant) throw new Error('Conversation speaker is not a session member.')
    return participant
  }

  private otherParticipant(
    session: ConversationSession,
    agentId: string
  ): ConversationParticipant {
    const participant = session.participants.find(item => item.agentId !== agentId)
    if (!participant) throw new Error('Conversation recipient is not a session member.')
    return participant
  }

  private pairAvailable(
    first: ConversationParticipant,
    second: ConversationParticipant
  ): boolean {
    return !first.isInDanger() &&
      !second.isInDanger() &&
      first.canSee(second.agentId) &&
      second.canSee(first.agentId)
  }

  private isActive(session: ConversationSession): boolean {
    return this.sessions.get(session.conversationId) === session
  }

  private stale(session: ConversationSession, speakerAgentId: string): void {
    this.telemetry({
      type: 'stale_response',
      conversationId: session.conversationId,
      speakerAgentId
    })
  }

  private telemetry(event: ConversationTelemetryEvent): void {
    try {
      this.onTelemetry?.(event)
    } catch {
      this.logger.error('Conversation telemetry callback failed.')
    }
  }

  private currentTimestamp(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Conversation coordinator clock is invalid.')
    }
    return value
  }
}

class TurnTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TurnTimeoutError()), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function rejected(reason: Exclude<StartConversationResult, { accepted: true }>['reason']): StartConversationResult {
  return { accepted: false, reason }
}

function pairKey(first: string, second: string): string {
  return [first, second].sort().join(':')
}

function validateAgentId(value: string): void {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(value)) {
    throw new Error('Conversation participant agent identity is invalid.')
  }
}

function validateUsername(value: string): void {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(value)) {
    throw new Error('Conversation participant username is invalid.')
  }
}

function validateWorldId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error('Conversation world identity is invalid.')
  }
  return value
}

function boundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Conversation ${label} is invalid.`)
  }
  return value
}
