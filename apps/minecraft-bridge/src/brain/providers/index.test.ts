import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { BrainConfig } from '../config.js'
import { createLLMProvider } from './index.js'
import { OllamaProvider } from './ollama.js'

const config: BrainConfig = {
  autonomous: true,
  tickIntervalMs: 5000,
  provider: 'ollama',
  model: 'local-test-model',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  debugTiming: false
}

describe('createLLMProvider', () => {
  it('creates the configured provider behind the neutral interface', () => {
    assert.equal(createLLMProvider(config) instanceof OllamaProvider, true)
  })

  it('rejects unsupported provider names explicitly', () => {
    assert.throws(
      () => createLLMProvider({ ...config, provider: 'unknown-provider' }),
      /Unsupported LLM_PROVIDER/
    )
  })
})
