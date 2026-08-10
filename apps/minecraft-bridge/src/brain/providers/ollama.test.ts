import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { BrainInput } from '../types.js'
import { OllamaProvider } from './ollama.js'

const brainInput: BrainInput = {
  perception: {
    agent: 'Alice',
    timestamp: 123,
    position: { x: 1, y: 64, z: 2 },
    health: 20,
    food: 18,
    nearbyBlocks: [
      { name: 'oak_log', distance: 2, position: { x: 2, y: 64, z: 2 } },
      { name: 'oak_log', distance: 4, position: { x: 4, y: 64, z: 2 } }
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
  recentDecisions: []
}

describe('OllamaProvider', () => {
  it('requests one non-streaming structured decision and returns unknown JSON', async () => {
    let requestedUrl = ''
    const requestedBodies: Array<Record<string, unknown>> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      requestedUrl = String(input)
      requestedBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>
      )

      return new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            action: 'idle',
            reason: 'Wait safely.'
          })
        }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434/',
      model: 'local-test-model',
      fetchImpl
    })

    const output = await provider.decide(brainInput)

    assert.deepEqual(output, { action: 'idle', reason: 'Wait safely.' })
    assert.equal(requestedUrl, 'http://127.0.0.1:11434/api/chat')
    const requestedBody = requestedBodies[0]
    assert.ok(requestedBody)
    assert.equal(requestedBody?.model, 'local-test-model')
    assert.equal(requestedBody?.stream, false)
    assert.equal(requestedBody?.think, false)
    assert.equal(requestedBody?.keep_alive, '10m')
    assert.equal(typeof requestedBody?.format, 'object')
    assert.deepEqual(requestedBody?.options, {
      temperature: 0.1,
      num_predict: 128,
      num_ctx: 4096
    })

    const messages = requestedBody?.messages as Array<{ content: string }>
    const compactInput = JSON.parse(messages[1].content) as {
      perception: { nearbyBlocks: unknown[] }
    }
    assert.equal(compactInput.perception.nearbyBlocks.length, 1)
  })

  it('logs concise timing metadata only when debug timing is enabled', async () => {
    const logs: string[] = []
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'local-test-model',
      debugTiming: true,
      logger: { log: message => logs.push(message) },
      fetchImpl: async () => new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            action: 'idle',
            reason: 'Wait safely.'
          }),
          thinking: 'private reasoning must never be logged'
        },
        total_duration: 1_840_000_000,
        load_duration: 12_000_000,
        prompt_eval_count: 420,
        prompt_eval_duration: 300_000_000,
        eval_count: 34,
        eval_duration: 1_214_285_714
      }))
    })

    await provider.decide(brainInput)

    assert.deepEqual(logs, [
      '🧠 LLM: 1840ms total | 12ms load | prompt 420 tok | output 34 tok | 28 tok/s'
    ])
    assert.doesNotMatch(logs.join('\n'), /private reasoning/)
  })

  it('does not log timings when debug timing is disabled', async () => {
    const logs: string[] = []
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'local-test-model',
      logger: { log: message => logs.push(message) },
      fetchImpl: async () => new Response(JSON.stringify({
        message: {
          content: JSON.stringify({ action: 'scan', reason: 'Look around.' })
        },
        total_duration: 1_000_000,
        load_duration: 0,
        prompt_eval_count: 10,
        prompt_eval_duration: 500_000,
        eval_count: 5,
        eval_duration: 500_000
      }))
    })

    await provider.decide(brainInput)

    assert.deepEqual(logs, [])
  })

  it('skips incomplete timing metadata without failing the decision', async () => {
    const logs: string[] = []
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'local-test-model',
      debugTiming: true,
      logger: { log: message => logs.push(message) },
      fetchImpl: async () => new Response(JSON.stringify({
        message: {
          content: JSON.stringify({ action: 'scan', reason: 'Look around.' })
        },
        total_duration: 1_000_000,
        load_duration: 0,
        prompt_eval_count: 10,
        eval_count: 5,
        eval_duration: 500_000
      }))
    })

    const output = await provider.decide(brainInput)

    assert.deepEqual(output, { action: 'scan', reason: 'Look around.' })
    assert.deepEqual(logs, [])
  })

  it('rejects HTTP failures without exposing a raw response body', async () => {
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'local-test-model',
      fetchImpl: async () => new Response('sensitive details', { status: 500 })
    })

    await assert.rejects(
      provider.decide(brainInput),
      /Ollama request failed with HTTP 500/
    )
  })

  it('rejects malformed response envelopes and invalid model JSON', async () => {
    const malformedEnvelope = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'local-test-model',
      fetchImpl: async () => new Response(JSON.stringify({ done: true }))
    })
    const invalidModelJson = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'local-test-model',
      fetchImpl: async () => new Response(JSON.stringify({
        message: { content: 'not JSON' }
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
