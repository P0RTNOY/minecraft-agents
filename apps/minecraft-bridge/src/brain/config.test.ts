import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadBrainConfig } from './config.js'

describe('loadBrainConfig', () => {
  it('keeps autonomy off by default with local Ollama defaults', () => {
    assert.deepEqual(loadBrainConfig({}), {
      autonomous: false,
      tickIntervalMs: 5000,
      provider: 'ollama',
      model: '',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      debugTiming: false
    })
  })

  it('uses environment overrides', () => {
    assert.deepEqual(loadBrainConfig({
      AGENT_AUTONOMOUS: 'true',
      AGENT_TICK_INTERVAL_MS: '8000',
      LLM_PROVIDER: 'ollama',
      LLM_MODEL: 'local-test-model',
      OLLAMA_BASE_URL: 'http://localhost:11434/',
      LLM_DEBUG_TIMING: 'true'
    }), {
      autonomous: true,
      tickIntervalMs: 8000,
      provider: 'ollama',
      model: 'local-test-model',
      ollamaBaseUrl: 'http://localhost:11434/',
      debugTiming: true
    })
  })

  it('rejects unsafe intervals and enabled autonomy without a model', () => {
    assert.throws(
      () => loadBrainConfig({ AGENT_TICK_INTERVAL_MS: '10' }),
      /at least 1000/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_AUTONOMOUS: 'true' }),
      /LLM_MODEL is required/
    )
    assert.throws(
      () => loadBrainConfig({ LLM_DEBUG_TIMING: 'yes' }),
      /LLM_DEBUG_TIMING must be either true or false/
    )
  })
})
