import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createBootstrapBrainInput } from '../benchmark/bootstrap.js'
import type { LLMProvider } from '../provider.js'
import { GroqProvider } from './groq.js'
import { OllamaProvider } from './ollama.js'
import { OpenAIProvider } from './openai.js'

describe('Brain provider cancellation', () => {
  const cases: Array<[string, (fetchImpl: typeof fetch) => LLMProvider]> = [
    ['OpenAI', fetchImpl => new OpenAIProvider({
      baseUrl: 'https://api.openai.com/v1', apiKey: 'test-key',
      model: 'gpt-5-mini', fetchImpl
    })],
    ['Groq', fetchImpl => new GroqProvider({
      baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'test-key',
      model: 'openai/gpt-oss-20b', fetchImpl
    })],
    ['Ollama', fetchImpl => new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434', model: 'test-model', fetchImpl
    })]
  ]

  for (const [name, createProvider] of cases) {
    it(`propagates caller cancellation through ${name}`, async () => {
      const started = deferred<AbortSignal>()
      const provider = createProvider(async (_input, init) => {
        const signal = init?.signal as AbortSignal
        started.resolve(signal)
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('transport detail')), {
            once: true
          })
        })
      })
      const controller = new AbortController()
      const pending = provider.decide(createBootstrapBrainInput(), controller.signal)
      const requestSignal = await started.promise

      controller.abort()

      await assert.rejects(pending, error => {
        assert.equal((error as Error).name, 'AbortError')
        assert.doesNotMatch(String(error), /transport detail/)
        return true
      })
      assert.equal(requestSignal.aborted, true)
    })

    it(`releases an unread HTTP failure body from ${name}`, async () => {
      let cancelCalls = 0
      const response = new Response(new ReadableStream<Uint8Array>({
        cancel() { cancelCalls += 1 }
      }), { status: 503 })
      const provider = createProvider(async () => response)

      await assert.rejects(provider.decide(createBootstrapBrainInput()), /HTTP 503/)
      assert.equal(cancelCalls, 1)
    })
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}
