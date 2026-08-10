import type { SocialEvent } from './events.js'
import type { RelationshipRecord } from './relationships.js'

export interface ConfiguredSocialAgent {
  agentId: string
  username: string
}

export interface VisibleAgentSocialContext {
  agentId: string
  username: string
  relationship: {
    familiarity: 'unknown' | 'familiar'
    trust: 'negative' | 'neutral' | 'positive'
    affinity: 'negative' | 'neutral' | 'positive'
    reciprocity: 'negative' | 'neutral' | 'positive'
    interactionCount: number
  }
  lastVerifiedInteraction: string | null
  recentUnverifiedUtterance: string | null
}

export interface BuildVisibleAgentSocialContextOptions {
  observerAgentId: string
  worldId: string
  configuredAgents: readonly ConfiguredSocialAgent[]
  visibleUsernames: readonly string[]
  relationships: readonly RelationshipRecord[]
  recentEvents: readonly SocialEvent[]
}

export function buildVisibleAgentSocialContext(
  options: BuildVisibleAgentSocialContextOptions
): VisibleAgentSocialContext[] {
  const visible = new Set(options.visibleUsernames.map(value => value.toLowerCase()))
  return options.configuredAgents
    .filter(agent => (
      agent.agentId !== options.observerAgentId &&
      visible.has(agent.username.toLowerCase())
    ))
    .map(agent => {
      const relationship = options.relationships.find(record => (
        record.observerAgentId === options.observerAgentId &&
        record.worldId === options.worldId &&
        record.targetAgentId === agent.agentId
      ))
      const verified = [...options.recentEvents]
        .filter(event => (
          event.observerAgentId === options.observerAgentId &&
          event.worldId === options.worldId &&
          event.verified &&
          socialTarget(event) === agent.agentId
        ))
        .sort(eventOrder)[0]
      const utterance = [...options.recentEvents]
        .filter(event => (
          event.type === 'agent_speech_observed' &&
          event.observerAgentId === options.observerAgentId &&
          event.worldId === options.worldId &&
          event.actorAgentId === agent.agentId &&
          !event.verified
        ))
        .sort(eventOrder)[0]
      return {
        agentId: agent.agentId,
        username: agent.username,
        relationship: {
          familiarity: relationship && relationship.familiarity > 0
            ? 'familiar'
            : 'unknown',
          trust: signCategory(relationship?.trust ?? 0),
          affinity: signCategory(relationship?.affinity ?? 0),
          reciprocity: signCategory(relationship?.reciprocity ?? 0),
          interactionCount: relationship?.interactionCount ?? 0
        },
        lastVerifiedInteraction: verified?.type ?? null,
        recentUnverifiedUtterance: utterance && typeof utterance.metadata.message === 'string'
          ? utterance.metadata.message
          : null
      }
    })
}

function socialTarget(event: SocialEvent): string | undefined {
  return event.type === 'agent_seen' ? event.actorAgentId : event.targetAgentId
}

function eventOrder(left: SocialEvent, right: SocialEvent): number {
  return right.timestamp - left.timestamp || left.id.localeCompare(right.id)
}

function signCategory(value: number): 'negative' | 'neutral' | 'positive' {
  if (value < 0) return 'negative'
  if (value > 0) return 'positive'
  return 'neutral'
}
