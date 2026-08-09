import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { BrainInput } from '../types.js'
import { GroqProvider } from './groq.js'

const brainInput: BrainInput = {
  perception: {
    agent: 'Alice',
    timestamp: 123,
    position: { x: 1, y: 64, z: 2 },
    health: 20,
    food: 18,
    nearbyBlocks: [
      { name: 'oak_log', distance: 2, position: { x: 2, y: 64, z: 2 } }
    ],
    nearbyEntities: [],
    inventory: []
  },
  state: {
    agentName: 'Alice',
    status: 'idle',
    currentAction: null,
    currentGoal: null,
    actionSource: null,
    busy: false
  },
  previousActionResult: null,
  recentDecisions: []
}

describe('GroqProvider', () => {
  it('requests one low-reasoning strict structured decision', async () => {
    let requestedUrl = ''
    let requestedAuthorization = ''
    const requestedBodies: Array<Record<string, unknown>> = []
    const provider = new GroqProvider({
      baseUrl: 'https://api.groq.com/openai/v1/',
      apiKey: 'test-api-key',
      model: 'openai/gpt-oss-20b',
      fetchImpl: async (input, init) => {
        requestedUrl = String(input)
        requestedAuthorization = new Headers(init?.headers).get(
          'authorization'
        ) ?? ''
        requestedBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>
        )

        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                action: 'collect_block',
                block: 'oak_log',
                reason: 'Gather useful resources.'
              }),
              reasoning: 'private reasoning must not be consumed'
            }
          }]
        }))
      }
    })

    const output = await provider.decide(brainInput)

    assert.deepEqual(output, {
      action: 'collect_block',
      block: 'oak_log',
      reason: 'Gather useful resources.'
    })
    assert.equal(
      requestedUrl,
      'https://api.groq.com/openai/v1/chat/completions'
    )
    assert.equal(requestedAuthorization, 'Bearer test-api-key')
    const requestedBody = requestedBodies[0]
    assert.ok(requestedBody)
    assert.equal(requestedBody.model, 'openai/gpt-oss-20b')
    assert.equal(requestedBody.stream, false)
    assert.equal(requestedBody.reasoning_effort, 'low')
    assert.equal(requestedBody.include_reasoning, false)
    assert.equal(requestedBody.temperature, 0.1)
    assert.equal(requestedBody.max_completion_tokens, 128)

    const responseFormat = requestedBody.response_format as {
      type: string
      json_schema: {
        name: string
        strict: boolean
        schema: Record<string, unknown>
      }
    }
    assert.equal(responseFormat.type, 'json_schema')
    assert.equal(responseFormat.json_schema.name, 'agent_decision')
    assert.equal(responseFormat.json_schema.strict, true)
    assert.equal(Array.isArray(responseFormat.json_schema.schema.anyOf), true)
  })

  it('rejects missing credentials and unsafe base URLs', () => {
    assert.throws(
      () => new GroqProvider({
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: '',
        model: 'openai/gpt-oss-20b'
      }),
      /Groq API key is required/
    )
    assert.throws(
      () => new GroqProvider({
        baseUrl: 'file:///tmp/groq',
        apiKey: 'test-api-key',
        model: 'openai/gpt-oss-20b'
      }),
      /HTTP or HTTPS/
    )
  })

  it('reports HTTP failures without exposing response bodies or credentials', async () => {
    const provider = new GroqProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'test-api-key',
      model: 'openai/gpt-oss-20b',
      fetchImpl: async () => new Response(
        'sensitive provider details test-api-key',
        { status: 429 }
      )
    })

    await assert.rejects(
      provider.decide(brainInput),
      error => {
        assert.match(String(error), /Groq request failed with HTTP 429/)
        assert.doesNotMatch(String(error), /sensitive|test-api-key/)
        return true
      }
    )
  })

  it('rejects malformed envelopes and invalid model JSON', async () => {
    const malformedEnvelope = new GroqProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'test-api-key',
      model: 'openai/gpt-oss-20b',
      fetchImpl: async () => new Response(JSON.stringify({ choices: [] }))
    })
    const invalidModelJson = new GroqProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'test-api-key',
      model: 'openai/gpt-oss-20b',
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'not JSON' } }]
      }))
    })

    await assert.rejects(
      malformedEnvelope.decide(brainInput),
      /missing message content/
    )
    await assert.rejects(
      invalidModelJson.decide(brainInput),
      /invalid JSON/
    )
  })
})
