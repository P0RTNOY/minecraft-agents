import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { BrainConfig } from '../config.js'
import { GroqProvider } from './groq.js'
import { createLLMProvider } from './index.js'
import { OllamaProvider } from './ollama.js'

const config: BrainConfig = {
  autonomous: true,
  tickIntervalMs: 5000,
  reflexIntervalMs: 250,
  explorationRadius: 24,
  provider: 'ollama',
  model: 'local-test-model',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  groqBaseUrl: 'https://api.groq.com/openai/v1',
  groqApiKey: 'test-api-key',
  debugTiming: false
}

describe('createLLMProvider', () => {
  it('creates the configured provider behind the neutral interface', () => {
    assert.equal(createLLMProvider(config) instanceof OllamaProvider, true)
    assert.equal(createLLMProvider({
      ...config,
      provider: 'groq',
      model: 'openai/gpt-oss-20b'
    }) instanceof GroqProvider, true)
  })

  it('rejects unsupported provider names explicitly', () => {
    assert.throws(
      () => createLLMProvider({ ...config, provider: 'unknown-provider' }),
      /Unsupported LLM_PROVIDER/
    )
  })
})
