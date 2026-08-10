export type SocialEventType =
  | 'agent_seen'
  | 'agent_speech_observed'
  | 'conversation_started'
  | 'conversation_completed'
  | 'conversation_interrupted'

export type SocialEventEvidence =
  | 'perception'
  | 'minecraft_chat'
  | 'coordinator'

export type SocialEventMetadata = Readonly<Record<
  string,
  string | number | boolean
>>

export interface SocialEvent {
  id: string
  worldId: string
  timestamp: number
  type: SocialEventType
  observerAgentId: string
  actorAgentId: string
  targetAgentId?: string
  conversationId?: string
  verified: boolean
  evidence: SocialEventEvidence
  metadata: SocialEventMetadata
}

export interface SocialEventValidationContext {
  worldId: string
  configuredAgentIds: readonly string[]
}

const EVENT_TYPES = new Set<SocialEventType>([
  'agent_seen',
  'agent_speech_observed',
  'conversation_started',
  'conversation_completed',
  'conversation_interrupted'
])
const EVIDENCE = new Set<SocialEventEvidence>([
  'perception',
  'minecraft_chat',
  'coordinator'
])
const ROOT_KEYS = [
  'id',
  'worldId',
  'timestamp',
  'type',
  'observerAgentId',
  'actorAgentId',
  'targetAgentId',
  'conversationId',
  'verified',
  'evidence',
  'metadata'
] as const
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const AGENT_ID = /^[a-z][a-z0-9_-]{0,31}$/
const WORLD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export function createSocialEvent(
  input: unknown,
  configuredAgentIds: readonly string[]
): SocialEvent {
  const record = requireRecord(input, 'Social event')
  const worldId = requireWorldId(record.worldId, 'Social event worldId')
  return decodeSocialEvent(record, { worldId, configuredAgentIds })
}

export function decodeSocialEvent(
  value: unknown,
  context: SocialEventValidationContext
): SocialEvent {
  const record = requireRecord(value, 'Social event')
  rejectExtraFields(record, ROOT_KEYS, 'Social event')
  const worldId = requireWorldId(record.worldId, 'Social event worldId')
  if (worldId !== context.worldId) {
    throw new Error('Social event world identity does not match its context.')
  }
  const configured = validateConfiguredAgents(context.configuredAgentIds)
  const observerAgentId = requireConfiguredAgent(
    record.observerAgentId,
    configured,
    'observerAgentId'
  )
  const actorAgentId = requireConfiguredAgent(
    record.actorAgentId,
    configured,
    'actorAgentId'
  )
  const type = requireEventType(record.type)
  const evidence = requireEvidence(record.evidence)
  const targetAgentId = record.targetAgentId === undefined
    ? undefined
    : requireConfiguredAgent(record.targetAgentId, configured, 'targetAgentId')
  const conversationId = record.conversationId === undefined
    ? undefined
    : requireIdentifier(record.conversationId, 'conversationId')
  if (typeof record.verified !== 'boolean') {
    throw new Error('Social event verified must be boolean.')
  }
  const metadata = decodeMetadata(type, record.metadata)

  validateProvenance({
    type,
    observerAgentId,
    actorAgentId,
    targetAgentId,
    conversationId,
    verified: record.verified,
    evidence
  })

  return {
    id: requireIdentifier(record.id, 'id'),
    worldId,
    timestamp: requireTimestamp(record.timestamp),
    type,
    observerAgentId,
    actorAgentId,
    ...(targetAgentId ? { targetAgentId } : {}),
    ...(conversationId ? { conversationId } : {}),
    verified: record.verified,
    evidence,
    metadata
  }
}

function validateProvenance(event: Omit<SocialEvent, 'id' | 'worldId' | 'timestamp' | 'metadata'>): void {
  if (event.type === 'agent_seen') {
    if (
      !event.verified ||
      event.evidence !== 'perception' ||
      event.targetAgentId !== undefined ||
      event.conversationId !== undefined
    ) {
      throw new Error('agent_seen requires verified perception evidence.')
    }
    if (event.actorAgentId === event.observerAgentId) {
      throw new Error('An agent cannot become its own external social target.')
    }
    return
  }

  if (event.type === 'agent_speech_observed') {
    if (event.verified) {
      throw new Error('Observed agent speech must remain unverified.')
    }
    if (
      event.evidence !== 'minecraft_chat' ||
      !event.targetAgentId ||
      !event.conversationId ||
      event.targetAgentId === event.actorAgentId
    ) {
      throw new Error('Observed agent speech requires an attributed pair and conversation.')
    }
    return
  }

  if (
    !event.verified ||
    event.evidence !== 'coordinator' ||
    !event.targetAgentId ||
    !event.conversationId ||
    event.targetAgentId === event.observerAgentId
  ) {
    throw new Error('Conversation lifecycle events require verified coordinator provenance.')
  }
}

function decodeMetadata(
  type: SocialEventType,
  value: unknown
): SocialEventMetadata {
  const record = requireRecord(value, 'Social event metadata')
  switch (type) {
    case 'agent_seen':
      rejectExtraFields(record, [], 'Social event metadata')
      return {}
    case 'agent_speech_observed':
      requireExactFields(record, ['message'], 'Social event metadata')
      return { message: requireText(record.message, 'message', 256) }
    case 'conversation_started':
      requireExactFields(record, ['trigger'], 'Social event metadata')
      return { trigger: requireIdentifier(record.trigger, 'trigger') }
    case 'conversation_completed':
    case 'conversation_interrupted':
      requireExactFields(record, ['outcome', 'turns'], 'Social event metadata')
      return {
        outcome: requireIdentifier(record.outcome, 'outcome'),
        turns: requireInteger(record.turns, 'turns', 0, 8)
      }
  }
}

function validateConfiguredAgents(values: readonly string[]): Set<string> {
  if (values.length < 1) throw new Error('Configured social agents are required.')
  const configured = new Set<string>()
  for (const value of values) {
    if (!AGENT_ID.test(value)) throw new Error('Configured social agent id is invalid.')
    if (configured.has(value)) throw new Error('Configured social agent ids must be unique.')
    configured.add(value)
  }
  return configured
}

function requireConfiguredAgent(
  value: unknown,
  configured: ReadonlySet<string>,
  path: string
): string {
  if (typeof value !== 'string' || !AGENT_ID.test(value)) {
    throw new Error(`Social event ${path} is invalid.`)
  }
  if (!configured.has(value)) {
    throw new Error(`Social event ${path} must name a configured agent.`)
  }
  return value
}

function requireEventType(value: unknown): SocialEventType {
  if (typeof value !== 'string' || !EVENT_TYPES.has(value as SocialEventType)) {
    throw new Error('Social event type is invalid.')
  }
  return value as SocialEventType
}

function requireEvidence(value: unknown): SocialEventEvidence {
  if (typeof value !== 'string' || !EVIDENCE.has(value as SocialEventEvidence)) {
    throw new Error('Social event evidence is invalid.')
  }
  return value as SocialEventEvidence
}

function requireWorldId(value: unknown, path: string): string {
  if (typeof value !== 'string' || !WORLD_ID.test(value)) {
    throw new Error(`${path} is invalid.`)
  }
  return value
}

function requireIdentifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new Error(`Social event ${path} is invalid.`)
  }
  return value
}

function requireTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Social event timestamp is invalid.')
  }
  return value as number
}

function requireInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(`Social event metadata ${path} is invalid.`)
  }
  return value as number
}

function requireText(
  value: unknown,
  path: string,
  maximum: number
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new Error(`Social event metadata ${path} is invalid.`)
  }
  return value
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`)
  }
  return value as Record<string, unknown>
}

function requireExactFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string
): void {
  rejectExtraFields(record, allowed, path)
  const missing = allowed.find(key => !(key in record))
  if (missing) throw new Error(`${path} ${missing} is required.`)
}

function rejectExtraFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string
): void {
  const allowedSet = new Set<string>(allowed)
  const extra = Object.keys(record).find(key => !allowedSet.has(key))
  if (extra) throw new Error(`${path} ${extra} is not allowed.`)
}
