import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { BrainInput } from '../types.js'
import { OpenAIProvider } from './openai.js'

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
    inventory: [],
    edibleItemCount: 0,
    craftableItems: [],
    nearbyCraftingTable: false,
    equippedItem: null,
    placeableBlocks: []
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
  recentDecisions: [],
  shortTermGoal: null,
  goalProgress: null,
  availableCapabilities: {
    observedCollectableBlocks: ['oak_log'],
    craftableItems: [],
    placeableBlocks: [],
    canExplore: true
  }
}

describe('OpenAIProvider', () => {
  it('requests one stateless low-reasoning strict structured decision', async () => {
    let requestedUrl = ''
    let requestedAuthorization = ''
    const requestedBodies: Array<Record<string, unknown>> = []
    const provider = new OpenAIProvider({
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: 'test-api-key',
      model: 'gpt-5-mini',
      fetchImpl: async (input, init) => {
        requestedUrl = String(input)
        requestedAuthorization = new Headers(init?.headers).get(
          'authorization'
        ) ?? ''
        requestedBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>
        )

        return new Response(JSON.stringify({
          status: 'completed',
          output: [{
            type: 'reasoning',
            encrypted_content: 'must not be consumed'
          }, {
            type: 'message',
            role: 'assistant',
            content: [{
              type: 'output_text',
              text: JSON.stringify({
                decision: {
                  action: 'collect_block',
                  block: 'oak_log',
                  reason: 'Gather useful resources.'
                }
              })
            }]
          }],
          usage: {
            input_tokens: 312,
            output_tokens: 27,
            total_tokens: 339
          }
        }))
      }
    })

    const output = await provider.decide(brainInput)

    assert.deepEqual(output, {
      action: 'collect_block',
      block: 'oak_log',
      reason: 'Gather useful resources.'
    })
    assert.equal(requestedUrl, 'https://api.openai.com/v1/responses')
    assert.equal(requestedAuthorization, 'Bearer test-api-key')

    const requestedBody = requestedBodies[0]
    assert.ok(requestedBody)
    assert.equal(requestedBody.model, 'gpt-5-mini')
    assert.equal(typeof requestedBody.instructions, 'string')
    assert.equal(typeof requestedBody.input, 'string')
    assert.equal(requestedBody.store, false)
    assert.equal(requestedBody.max_output_tokens, 128)
    assert.deepEqual(requestedBody.reasoning, { effort: 'low' })
    assert.equal('tools' in requestedBody, false)
    assert.equal('previous_response_id' in requestedBody, false)
    assert.equal('conversation' in requestedBody, false)

    const text = requestedBody.text as {
      format: {
        type: string
        name: string
        strict: boolean
        schema: {
          type: string
          properties: { decision: { anyOf: unknown[] } }
          required: string[]
          additionalProperties: boolean
        }
      }
    }
    assert.equal(text.format.type, 'json_schema')
    assert.equal(text.format.name, 'agent_decision')
    assert.equal(text.format.strict, true)
    assert.equal(text.format.schema.type, 'object')
    assert.deepEqual(text.format.schema.required, ['decision'])
    assert.equal(text.format.schema.additionalProperties, false)
    assert.equal(Array.isArray(
      text.format.schema.properties.decision.anyOf
    ), true)
    assert.deepEqual(provider.getLastTiming(), {
      promptTokens: 312,
      outputTokens: 27
    })
  })

  it('reports no timing when standard usage metadata is unavailable', async () => {
    const provider = providerReturning({
      status: 'completed',
      output: [messageOutput({ decision: { action: 'idle', reason: 'Wait.' } })]
    })

    await provider.decide(brainInput)

    assert.equal(provider.getLastTiming(), null)
  })

  it('rejects missing credentials, credential-bearing URLs, and non-HTTPS URLs', () => {
    assert.throws(
      () => new OpenAIProvider({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-5-mini'
      }),
      /OpenAI API key is required/
    )
    assert.throws(
      () => new OpenAIProvider({
        baseUrl: 'http://api.openai.test/v1',
        apiKey: 'test-api-key',
        model: 'gpt-5-mini'
      }),
      /HTTPS/
    )
    assert.throws(
      () => new OpenAIProvider({
        baseUrl: 'https://user:password@api.openai.test/v1',
        apiKey: 'test-api-key',
        model: 'gpt-5-mini'
      }),
      /must not contain credentials/
    )
  })

  it('reports HTTP failures without exposing response bodies or credentials', async () => {
    const provider = new OpenAIProvider({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-api-key',
      model: 'gpt-5-mini',
      fetchImpl: async () => new Response(
        'sensitive provider details test-api-key',
        { status: 429 }
      )
    })

    await assert.rejects(
      provider.decide(brainInput),
      error => {
        assert.match(String(error), /OpenAI request failed with HTTP 429/)
        assert.doesNotMatch(String(error), /sensitive|test-api-key/)
        return true
      }
    )
  })

  it('rejects refusals without exposing refusal or reasoning text', async () => {
    const provider = providerReturning({
      status: 'completed',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'refusal',
          refusal: 'sensitive refusal explanation'
        }]
      }]
    })

    await assert.rejects(
      provider.decide(brainInput),
      error => {
        assert.match(String(error), /refused to produce a decision/)
        assert.doesNotMatch(String(error), /sensitive refusal explanation/)
        return true
      }
    )
  })

  it('rejects incomplete, malformed, and invalid model responses', async () => {
    const incomplete = providerReturning({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: []
    })
    const malformedEnvelope = providerReturning({
      status: 'completed',
      output: []
    })
    const invalidModelJson = providerReturning({
      status: 'completed',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'not JSON' }]
      }]
    })
    const missingDecision = providerReturning({
      status: 'completed',
      output: [messageOutput({ action: 'idle', reason: 'Wait.' })]
    })

    await assert.rejects(incomplete.decide(brainInput), /incomplete response/)
    await assert.rejects(
      malformedEnvelope.decide(brainInput),
      /missing decision output/
    )
    await assert.rejects(
      invalidModelJson.decide(brainInput),
      /invalid JSON/
    )
    await assert.rejects(
      missingDecision.decide(brainInput),
      /missing the decision object/
    )
  })
})

function providerReturning(envelope: unknown): OpenAIProvider {
  return new OpenAIProvider({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'test-api-key',
    model: 'gpt-5-mini',
    fetchImpl: async () => new Response(JSON.stringify(envelope))
  })
}

function messageOutput(value: unknown): Record<string, unknown> {
  return {
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'output_text',
      text: JSON.stringify(value)
    }]
  }
}
