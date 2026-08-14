import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { SocialEvent } from './events.js'
import { buildVisibleAgentSocialContext } from './context.js'
import { createEmptyRelationship, type RelationshipRecord } from './relationships.js'

describe('social context', () => {
  it('includes only currently visible configured external agents with compact categories', () => {
    const context = buildVisibleAgentSocialContext({
      observerAgentId: 'alice',
      worldId: 'test-world',
      configuredAgents: [
        { agentId: 'alice', username: 'Alice' },
        { agentId: 'bob', username: 'Bob' },
        { agentId: 'charlie', username: 'Charlie' }
      ],
      visibleUsernames: ['Bob', 'UnconfiguredPlayer'],
      relationships: [relationship('bob', {
        familiarity: 3,
        trust: -1,
        affinity: 0,
        reciprocity: 2,
        interactionCount: 4
      })],
      recentEvents: [
        speechEvent('bob', 'alice', 'Unverified claim.', 30),
        completedEvent('bob', 20),
        speechEvent('charlie', 'alice', 'Invisible claim.', 40)
      ]
    })

    assert.deepEqual(context, [{
      agentId: 'bob',
      username: 'Bob',
      relationship: {
        familiarity: 'familiar',
        trust: 'negative',
        affinity: 'neutral',
        reciprocity: 'positive',
        interactionCount: 4
      },
      lastVerifiedInteraction: 'conversation_completed',
      recentUnverifiedUtterance: 'Unverified claim.'
    }])
    assert.equal('familiarity' in (context[0] ?? {}), false)
    assert.equal('transcript' in (context[0] ?? {}), false)
  })

  it('uses neutral categories for missing records and never grounds an invisible remembered agent', () => {
    const context = buildVisibleAgentSocialContext({
      observerAgentId: 'alice',
      worldId: 'test-world',
      configuredAgents: [
        { agentId: 'alice', username: 'Alice' },
        { agentId: 'bob', username: 'Bob' }
      ],
      visibleUsernames: [],
      relationships: [relationship('bob', { familiarity: 99 })],
      recentEvents: [completedEvent('bob', 20)]
    })
    assert.deepEqual(context, [])

    const visible = buildVisibleAgentSocialContext({
      observerAgentId: 'alice',
      worldId: 'test-world',
      configuredAgents: [
        { agentId: 'alice', username: 'Alice' },
        { agentId: 'bob', username: 'Bob' }
      ],
      visibleUsernames: ['bob'],
      relationships: [],
      recentEvents: []
    })
    assert.equal(visible[0]?.relationship.familiarity, 'unknown')
    assert.equal(visible[0]?.lastVerifiedInteraction, null)
  })

  it('ignores relationship and event data from another world', () => {
    const otherWorldRelationship = relationship('bob', { familiarity: 99 })
    otherWorldRelationship.worldId = 'other-world'
    const otherWorldEvent = completedEvent('bob', 20)
    otherWorldEvent.worldId = 'other-world'

    const context = buildVisibleAgentSocialContext({
      observerAgentId: 'alice',
      worldId: 'test-world',
      configuredAgents: [
        { agentId: 'alice', username: 'Alice' },
        { agentId: 'bob', username: 'Bob' }
      ],
      visibleUsernames: ['Bob'],
      relationships: [otherWorldRelationship],
      recentEvents: [otherWorldEvent]
    })

    assert.equal(context[0]?.relationship.familiarity, 'unknown')
    assert.equal(context[0]?.lastVerifiedInteraction, null)
  })
})

function relationship(
  targetAgentId: string,
  overrides: Partial<RelationshipRecord> = {}
): RelationshipRecord {
  return {
    ...createEmptyRelationship({
      observerAgentId: 'alice',
      targetAgentId,
      worldId: 'test-world',
      timestamp: 1
    }),
    ...overrides
  }
}

function speechEvent(
  actorAgentId: string,
  observerAgentId: string,
  message: string,
  timestamp: number
): SocialEvent {
  return {
    id: `speech-${actorAgentId}-${timestamp}`,
    worldId: 'test-world',
    timestamp,
    type: 'agent_speech_observed',
    observerAgentId,
    actorAgentId,
    targetAgentId: observerAgentId,
    conversationId: 'conversation-1',
    verified: false,
    evidence: 'minecraft_chat',
    metadata: { message }
  }
}

function completedEvent(targetAgentId: string, timestamp: number): SocialEvent {
  return {
    id: `completed-${targetAgentId}-${timestamp}`,
    worldId: 'test-world',
    timestamp,
    type: 'conversation_completed',
    observerAgentId: 'alice',
    actorAgentId: 'alice',
    targetAgentId,
    conversationId: 'conversation-1',
    verified: true,
    evidence: 'coordinator',
    metadata: { outcome: 'completed', turns: 4 }
  }
}
