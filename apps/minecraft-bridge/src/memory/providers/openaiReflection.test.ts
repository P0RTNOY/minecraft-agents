import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { OpenAIReflectionProvider } from './openaiReflection.js'
import type { EpisodicMemory } from '../types.js'

describe('OpenAIReflectionProvider', () => {
  it('requests bounded stateless low-reasoning strict structured facts', async () => {
    let requestedUrl = ''
    let authorization = ''
    let body: Record<string, unknown> | null = null
    const provider = new OpenAIReflectionProvider({
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: 'test-key',
      model: 'gpt-5-mini',
      fetchImpl: async (input, init) => {
        requestedUrl = String(input)
        authorization = new Headers(init?.headers).get('authorization') ?? ''
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return response({
          status: 'completed',
          output: [{
            type: 'message',
            content: [{
              type: 'output_text',
              text: JSON.stringify({ candidates: [] })
            }]
          }],
          usage: { input_tokens: 111, output_tokens: 12 }
        })
      }
    })

    const result = await provider.reflect(Array.from(
      { length: 9 },
      (_, index) => episode(index)
    ))

    assert.equal(requestedUrl, 'https://api.openai.com/v1/responses')
    assert.equal(authorization, 'Bearer test-key')
    const requestedBody: Record<string, unknown> = body ?? {}
    assert.equal(requestedBody.model, 'gpt-5-mini')
    assert.equal(requestedBody.store, false)
    assert.equal(requestedBody.max_output_tokens, 256)
    assert.deepEqual(requestedBody.reasoning, { effort: 'low' })
    assert.equal('tools' in requestedBody, false)
    const input = JSON.parse(String(requestedBody.input)) as { episodes: unknown[] }
    assert.equal(input.episodes.length, 8)
    assert.equal('summary' in (input.episodes[0] as object), false)
    assert.deepEqual(result, {
      candidates: { candidates: [] },
      timing: { inputTokens: 111, outputTokens: 12 }
    })

    const text = requestedBody.text as {
      format: { strict: boolean; name: string; schema: Record<string, unknown> }
    }
    assert.equal(text.format.strict, true)
    assert.equal(text.format.name, 'memory_reflection')
    assert.deepEqual(text.format.schema.required, ['candidates'])
    assert.equal(text.format.schema.additionalProperties, false)
  })

  it('validates HTTPS, credentials, model, and timeout', () => {
    assert.throws(() => new OpenAIReflectionProvider({
      baseUrl: 'http://api.openai.test/v1', apiKey: 'key', model: 'gpt-5-mini'
    }), /HTTPS/)
    assert.throws(() => new OpenAIReflectionProvider({
      baseUrl: 'https://user:pass@api.openai.test/v1', apiKey: 'key', model: 'gpt-5-mini'
    }), /credentials/)
    assert.throws(() => new OpenAIReflectionProvider({
      baseUrl: 'https://api.openai.test/v1', apiKey: '', model: 'gpt-5-mini'
    }), /API key is required/)
    assert.throws(() => new OpenAIReflectionProvider({
      baseUrl: 'https://api.openai.test/v1', apiKey: 'key', model: ''
    }), /model is required/)
    assert.throws(() => new OpenAIReflectionProvider({
      baseUrl: 'https://api.openai.test/v1', apiKey: 'key', model: 'gpt-5-mini', requestTimeoutMs: 999
    }), /at least 1000 ms/)
  })

  it('fails safely for HTTP, refusal, incomplete, malformed, and oversized output', async () => {
    const secret = 'secret-memory-payload'
    const providers = [
      returning(new Response(secret, { status: 429 })),
      returning(response({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: secret }] }] })),
      returning(response({ status: 'incomplete', output: [] })),
      returning(new Response('{not-json')),
      returning(response({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{bad-json' }] }] })),
      returning(response({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'x'.repeat(20_001) }] }] }))
    ]

    for (const provider of providers) {
      await assert.rejects(provider.reflect([episode(0)]), error => {
        assert.doesNotMatch(String(error), new RegExp(secret))
        return true
      })
    }
  })

  it('ignores reasoning content and reports absent usage as null', async () => {
    const provider = returning(response({
      status: 'completed',
      output: [
        { type: 'reasoning', encrypted_content: 'private reasoning' },
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ candidates: [] }) }] }
      ]
    }))

    assert.deepEqual(await provider.reflect([episode(0)]), {
      candidates: { candidates: [] }, timing: null
    })
  })
})

function returning(result: Response): OpenAIReflectionProvider {
  return new OpenAIReflectionProvider({
    baseUrl: 'https://api.openai.test/v1',
    apiKey: 'test-key',
    model: 'gpt-5-mini',
    fetchImpl: async () => result
  })
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value))
}

function episode(index: number): EpisodicMemory {
  return {
    id: `episode-${index}`,
    agentId: 'Alice',
    worldId: 'local-paper',
    timestamp: 1_000 + index,
    type: 'resource_discovery',
    summary: 'Do not serialize arbitrary prose.',
    importance: 6,
    source: 'perception',
    context: { region: '0:0', resource: 'oak_log' }
  }
}
