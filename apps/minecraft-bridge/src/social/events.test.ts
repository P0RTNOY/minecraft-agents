import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createSocialEvent,
  decodeSocialEvent
} from './events.js'

const configuredAgents = ['alice', 'bob', 'charlie'] as const

describe('social event provenance', () => {
  it('accepts a verified external-agent encounter backed by perception', () => {
    const event = decodeSocialEvent({
      id: 'social-1',
      worldId: 'local-paper',
      timestamp: 100,
      type: 'agent_seen',
      observerAgentId: 'alice',
      actorAgentId: 'bob',
      verified: true,
      evidence: 'perception',
      metadata: {}
    }, {
      worldId: 'local-paper',
      configuredAgentIds: configuredAgents
    })

    assert.equal(event.verified, true)
    assert.equal(event.actorAgentId, 'bob')
  })

  it('keeps attributed speech explicitly unverified and bounded', () => {
    const event = createSocialEvent({
      id: 'social-2',
      worldId: 'local-paper',
      timestamp: 101,
      type: 'agent_speech_observed',
      observerAgentId: 'alice',
      actorAgentId: 'bob',
      targetAgentId: 'alice',
      conversationId: 'conversation-1',
      verified: false,
      evidence: 'minecraft_chat',
      metadata: { message: 'Charlie says Bob stole Alice items.' }
    }, configuredAgents)

    assert.equal(event.verified, false)
    assert.equal(event.metadata.message, 'Charlie says Bob stole Alice items.')
  })

  it('rejects unsupported attribution and provenance combinations', () => {
    const base = {
      id: 'social-3',
      worldId: 'local-paper',
      timestamp: 102,
      observerAgentId: 'alice',
      actorAgentId: 'bob',
      metadata: {}
    }

    assert.throws(() => decodeSocialEvent({
      ...base,
      type: 'agent_helped',
      verified: true,
      evidence: 'coordinator'
    }, {
      worldId: 'local-paper',
      configuredAgentIds: configuredAgents
    }), /type is invalid/)

    assert.throws(() => decodeSocialEvent({
      ...base,
      type: 'agent_speech_observed',
      verified: true,
      evidence: 'minecraft_chat',
      metadata: { message: 'Trust me.' }
    }, {
      worldId: 'local-paper',
      configuredAgentIds: configuredAgents
    }), /speech must remain unverified/)

    assert.throws(() => decodeSocialEvent({
      ...base,
      type: 'agent_seen',
      verified: true,
      evidence: 'coordinator'
    }, {
      worldId: 'local-paper',
      configuredAgentIds: configuredAgents
    }), /agent_seen requires verified perception evidence/)
  })

  it('rejects self, unknown, mismatched-world, malformed, and extra-field events', () => {
    const valid = {
      id: 'social-4',
      worldId: 'local-paper',
      timestamp: 103,
      type: 'agent_seen',
      observerAgentId: 'alice',
      actorAgentId: 'bob',
      verified: true,
      evidence: 'perception',
      metadata: {}
    }
    const context = {
      worldId: 'local-paper',
      configuredAgentIds: configuredAgents
    }

    assert.throws(
      () => decodeSocialEvent({ ...valid, actorAgentId: 'alice' }, context),
      /external social target/
    )
    assert.throws(
      () => decodeSocialEvent({ ...valid, actorAgentId: 'dave' }, context),
      /configured agent/
    )
    assert.throws(
      () => decodeSocialEvent({ ...valid, worldId: 'other' }, context),
      /world identity/
    )
    assert.throws(
      () => decodeSocialEvent({ ...valid, timestamp: -1 }, context),
      /timestamp/
    )
    assert.throws(
      () => decodeSocialEvent({ ...valid, extra: true }, context),
      /extra is not allowed/
    )
  })

  it('requires exact coordinator provenance for conversation lifecycle events', () => {
    const event = decodeSocialEvent({
      id: 'social-5',
      worldId: 'local-paper',
      timestamp: 104,
      type: 'conversation_completed',
      observerAgentId: 'alice',
      actorAgentId: 'alice',
      targetAgentId: 'bob',
      conversationId: 'conversation-2',
      verified: true,
      evidence: 'coordinator',
      metadata: { outcome: 'completed', turns: 4 }
    }, {
      worldId: 'local-paper',
      configuredAgentIds: configuredAgents
    })

    assert.equal(event.targetAgentId, 'bob')
    assert.equal(event.conversationId, 'conversation-2')
  })
})
