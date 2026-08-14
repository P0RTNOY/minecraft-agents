import type { SocialEvent, SocialEventType } from './events.js'

export const AGENT_SEEN_FAMILIARITY_DELTA = 1
export const CONVERSATION_FAMILIARITY_DELTA = 2

export interface RelationshipIdentity {
  observerAgentId: string
  worldId: string
}

export interface RelationshipRecord extends RelationshipIdentity {
  targetAgentId: string
  familiarity: number
  trust: number
  affinity: number
  reciprocity: number
  interactionCount: number
  lastInteractionAt: number | null
  lastVerifiedEventAt: number | null
  updatedAt: number
}

export interface RelationshipStore {
  open(): Promise<void>
  flush(): Promise<void>
  get(targetAgentId: string): Promise<RelationshipRecord | null>
  list(): Promise<RelationshipRecord[]>
  put(record: RelationshipRecord): Promise<void>
}

export interface RelationshipUpdate {
  record: RelationshipRecord
  changed: boolean
  category: SocialEventType | null
}

export interface AgentRelationshipServiceOptions {
  identity: RelationshipIdentity
  configuredTargetAgentIds: readonly string[]
  store: RelationshipStore
  encounterCooldownMs: number
}

export function createEmptyRelationship(input: RelationshipIdentity & {
  targetAgentId: string
  timestamp: number
}): RelationshipRecord {
  validateIdentityPart(input.observerAgentId, 'observer identity')
  validateIdentityPart(input.targetAgentId, 'target identity')
  validateWorldId(input.worldId)
  validateTimestamp(input.timestamp, 'relationship timestamp')
  if (input.observerAgentId === input.targetAgentId) {
    throw new Error('Relationship target must be external to its observer.')
  }
  return {
    observerAgentId: input.observerAgentId,
    targetAgentId: input.targetAgentId,
    worldId: input.worldId,
    familiarity: 0,
    trust: 0,
    affinity: 0,
    reciprocity: 0,
    interactionCount: 0,
    lastInteractionAt: null,
    lastVerifiedEventAt: null,
    updatedAt: input.timestamp
  }
}

export function applyRelationshipEvent(
  relationship: RelationshipRecord,
  event: SocialEvent,
  encounterCooldownMs: number
): RelationshipUpdate {
  validateRelationshipRecord(relationship)
  if (!Number.isSafeInteger(encounterCooldownMs) || encounterCooldownMs < 0) {
    throw new Error('Relationship encounter cooldown is invalid.')
  }
  if (
    event.type !== 'agent_seen' &&
    event.type !== 'conversation_completed'
  ) {
    return unchanged(relationship)
  }
  if (
    !event.verified ||
    (event.type === 'agent_seen' && event.evidence !== 'perception') ||
    (event.type === 'conversation_completed' && event.evidence !== 'coordinator')
  ) {
    return unchanged(relationship)
  }
  const targetAgentId = relationshipTarget(event)
  if (
    relationship.observerAgentId !== event.observerAgentId ||
    relationship.worldId !== event.worldId ||
    relationship.targetAgentId !== targetAgentId
  ) {
    throw new Error('Relationship identity does not match the social event.')
  }

  if (event.type === 'agent_seen') {
    const previous = relationship.lastVerifiedEventAt
    if (previous !== null && event.timestamp - previous < encounterCooldownMs) {
      return unchanged(relationship)
    }
    return {
      record: {
        ...relationship,
        familiarity: boundedScore(
          relationship.familiarity + AGENT_SEEN_FAMILIARITY_DELTA
        ),
        lastVerifiedEventAt: event.timestamp,
        updatedAt: event.timestamp
      },
      changed: true,
      category: event.type
    }
  }

  if (event.type === 'conversation_completed') {
    if (
      relationship.lastInteractionAt !== null &&
      event.timestamp <= relationship.lastInteractionAt
    ) {
      return unchanged(relationship)
    }
    return {
      record: {
        ...relationship,
        familiarity: boundedScore(
          relationship.familiarity + CONVERSATION_FAMILIARITY_DELTA
        ),
        interactionCount: Math.min(
          Number.MAX_SAFE_INTEGER,
          relationship.interactionCount + 1
        ),
        lastInteractionAt: event.timestamp,
        lastVerifiedEventAt: event.timestamp,
        updatedAt: event.timestamp
      },
      changed: true,
      category: event.type
    }
  }

  return unchanged(relationship)
}

export class AgentRelationshipService {
  private readonly identity: RelationshipIdentity
  private readonly configuredTargetAgentIds: ReadonlySet<string>
  private readonly store: RelationshipStore
  private readonly encounterCooldownMs: number
  private readonly mutationTails = new Map<string, Promise<void>>()

  constructor(options: AgentRelationshipServiceOptions) {
    this.identity = { ...options.identity }
    validateIdentityPart(this.identity.observerAgentId, 'observer identity')
    validateWorldId(this.identity.worldId)
    this.configuredTargetAgentIds = configuredTargets(
      options.configuredTargetAgentIds,
      this.identity.observerAgentId
    )
    this.store = options.store
    if (
      !Number.isSafeInteger(options.encounterCooldownMs) ||
      options.encounterCooldownMs < 0
    ) {
      throw new Error('Relationship encounter cooldown is invalid.')
    }
    this.encounterCooldownMs = options.encounterCooldownMs
  }

  async record(event: SocialEvent): Promise<RelationshipUpdate> {
    if (
      event.observerAgentId !== this.identity.observerAgentId ||
      event.worldId !== this.identity.worldId
    ) {
      throw new Error('Social event does not belong to the owning observer and world.')
    }
    const targetAgentId = relationshipTarget(event)
    if (!targetAgentId || !this.configuredTargetAgentIds.has(targetAgentId)) {
      throw new Error('Social event target must name a configured target agent.')
    }
    return this.serializeMutation(targetAgentId, async () => {
      const existing = await this.store.get(targetAgentId)
      const relationship = existing ?? createEmptyRelationship({
        ...this.identity,
        targetAgentId,
        timestamp: event.timestamp
      })
      const update = applyRelationshipEvent(
        relationship,
        event,
        this.encounterCooldownMs
      )
      if (update.changed) await this.store.put(update.record)
      return update
    })
  }

  async summariesFor(targetAgentIds: readonly string[]): Promise<RelationshipRecord[]> {
    const summaries: RelationshipRecord[] = []
    for (const targetAgentId of targetAgentIds) {
      if (!this.configuredTargetAgentIds.has(targetAgentId)) {
        throw new Error('Relationship summary target must be a configured target agent.')
      }
      await this.mutationTails.get(targetAgentId)
      summaries.push((await this.store.get(targetAgentId)) ?? createEmptyRelationship({
        ...this.identity,
        targetAgentId,
        timestamp: 0
      }))
    }
    return summaries.map(record => ({ ...record }))
  }

  private serializeMutation<T>(
    targetAgentId: string,
    task: () => Promise<T>
  ): Promise<T> {
    const previous = this.mutationTails.get(targetAgentId) ?? Promise.resolve()
    const operation = previous.then(task)
    const tail = operation.then(() => {}, () => {})
    this.mutationTails.set(targetAgentId, tail)
    void tail.then(() => {
      if (this.mutationTails.get(targetAgentId) === tail) {
        this.mutationTails.delete(targetAgentId)
      }
    })
    return operation
  }
}

export function validateRelationshipRecord(record: RelationshipRecord): void {
  validateIdentityPart(record.observerAgentId, 'observer identity')
  validateIdentityPart(record.targetAgentId, 'target identity')
  validateWorldId(record.worldId)
  if (record.observerAgentId === record.targetAgentId) {
    throw new Error('Relationship target must be external to its observer.')
  }
  for (const [label, value] of [
    ['familiarity', record.familiarity],
    ['trust', record.trust],
    ['affinity', record.affinity],
    ['reciprocity', record.reciprocity]
  ] as const) {
    if (!Number.isInteger(value) || value < -100 || value > 100) {
      throw new Error(`Relationship ${label} must be an integer from -100 to 100.`)
    }
  }
  if (
    !Number.isSafeInteger(record.interactionCount) ||
    record.interactionCount < 0
  ) {
    throw new Error('Relationship interactionCount is invalid.')
  }
  validateNullableTimestamp(record.lastInteractionAt, 'lastInteractionAt')
  validateNullableTimestamp(record.lastVerifiedEventAt, 'lastVerifiedEventAt')
  validateTimestamp(record.updatedAt, 'updatedAt')
}

function configuredTargets(values: readonly string[], observerAgentId: string): ReadonlySet<string> {
  const targets = new Set<string>()
  for (const value of values) {
    validateIdentityPart(value, 'configured target')
    if (value === observerAgentId) {
      throw new Error('Configured relationship target must be external to its observer.')
    }
    if (targets.has(value)) {
      throw new Error('Configured relationship targets must be unique.')
    }
    targets.add(value)
  }
  return targets
}

function unchanged(record: RelationshipRecord): RelationshipUpdate {
  return { record: { ...record }, changed: false, category: null }
}

function relationshipTarget(event: SocialEvent): string | undefined {
  if (
    event.type === 'agent_seen' ||
    event.type === 'agent_speech_observed'
  ) {
    return event.actorAgentId
  }
  return event.targetAgentId
}

function boundedScore(value: number): number {
  return Math.max(-100, Math.min(100, value))
}

function validateNullableTimestamp(value: number | null, label: string): void {
  if (value !== null) validateTimestamp(value, label)
}

function validateTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Relationship ${label} is invalid.`)
  }
}

function validateIdentityPart(value: string, label: string): void {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(value)) {
    throw new Error(`Relationship ${label} is invalid.`)
  }
}

function validateWorldId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error('Relationship world identity is invalid.')
  }
}
