import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadBrainConfig } from './config.js'

describe('loadBrainConfig', () => {
  it('keeps autonomy off by default with local Ollama defaults', () => {
    assert.deepEqual(loadBrainConfig({}), {
      autonomous: false,
      tickIntervalMs: 5000,
      reflexIntervalMs: 250,
      explorationRadius: 24,
      provider: 'ollama',
      model: '',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      groqBaseUrl: 'https://api.groq.com/openai/v1',
      groqApiKey: '',
      openaiBaseUrl: 'https://api.openai.com/v1',
      openaiApiKey: '',
      debugTiming: false,
      memoryEnabled: true,
      memoryWorldId: 'local-paper',
      memoryDirectory: 'data/memory',
      memoryEpisodeLimit: 4,
      memoryFactLimit: 4,
      debugMemory: false,
      memoryReflection: false,
      memoryReflectionModel: 'gpt-5-mini',
      socialEnabled: false,
      socialAutoGreeting: false,
      socialModel: 'gpt-5-mini',
      socialMaxTurns: 4,
      socialCooldownMs: 60_000,
      socialTurnTimeoutMs: 15_000,
      socialMaxMessageChars: 180,
      socialDirectory: 'data/social'
    })
  })

  it('uses environment overrides', () => {
    assert.deepEqual(loadBrainConfig({
      AGENT_AUTONOMOUS: 'true',
      AGENT_TICK_INTERVAL_MS: '8000',
      AGENT_REFLEX_INTERVAL_MS: '400',
      AGENT_EXPLORATION_RADIUS: '16',
      LLM_PROVIDER: 'ollama',
      LLM_MODEL: 'local-test-model',
      OLLAMA_BASE_URL: 'http://localhost:11434/',
      GROQ_BASE_URL: 'https://groq.example/v1/',
      GROQ_API_KEY: 'test-api-key',
      OPENAI_BASE_URL: 'https://openai.example/v1/',
      OPENAI_API_KEY: 'test-openai-key',
      LLM_DEBUG_TIMING: 'true',
      AGENT_MEMORY_ENABLED: 'false',
      AGENT_MEMORY_WORLD_ID: 'benchmark-world',
      AGENT_MEMORY_DIR: '/tmp/minecraft-agent-memory',
      AGENT_MEMORY_EPISODE_LIMIT: '6',
      AGENT_MEMORY_FACT_LIMIT: '1',
      AGENT_DEBUG_MEMORY: 'true',
      AGENT_MEMORY_REFLECTION: 'true',
      AGENT_MEMORY_REFLECTION_MODEL: 'gpt-5-mini-test',
      AGENT_SOCIAL_ENABLED: 'true',
      AGENT_SOCIAL_AUTO_GREETING: 'true',
      AGENT_SOCIAL_MODEL: 'gpt-5-mini-test',
      AGENT_SOCIAL_MAX_TURNS: '8',
      AGENT_SOCIAL_COOLDOWN_MS: '1000',
      AGENT_SOCIAL_TURN_TIMEOUT_MS: '60000',
      AGENT_SOCIAL_MAX_MESSAGE_CHARS: '256',
      AGENT_SOCIAL_DIR: '/tmp/minecraft-agent-social'
    }), {
      autonomous: true,
      tickIntervalMs: 8000,
      reflexIntervalMs: 400,
      explorationRadius: 16,
      provider: 'ollama',
      model: 'local-test-model',
      ollamaBaseUrl: 'http://localhost:11434/',
      groqBaseUrl: 'https://groq.example/v1/',
      groqApiKey: 'test-api-key',
      openaiBaseUrl: 'https://openai.example/v1/',
      openaiApiKey: 'test-openai-key',
      debugTiming: true,
      memoryEnabled: false,
      memoryWorldId: 'benchmark-world',
      memoryDirectory: '/tmp/minecraft-agent-memory',
      memoryEpisodeLimit: 6,
      memoryFactLimit: 1,
      debugMemory: true,
      memoryReflection: true,
      memoryReflectionModel: 'gpt-5-mini-test',
      socialEnabled: true,
      socialAutoGreeting: true,
      socialModel: 'gpt-5-mini-test',
      socialMaxTurns: 8,
      socialCooldownMs: 1000,
      socialTurnTimeoutMs: 60_000,
      socialMaxMessageChars: 256,
      socialDirectory: '/tmp/minecraft-agent-social'
    })
  })

  it('rejects unsafe intervals and enabled autonomy without a model', () => {
    assert.throws(
      () => loadBrainConfig({ AGENT_TICK_INTERVAL_MS: '10' }),
      /at least 1000/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_REFLEX_INTERVAL_MS: '99' }),
      /AGENT_REFLEX_INTERVAL_MS must be at least 100/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_REFLEX_INTERVAL_MS: '501' }),
      /AGENT_REFLEX_INTERVAL_MS must be at most 500/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_EXPLORATION_RADIUS: '7' }),
      /AGENT_EXPLORATION_RADIUS must be at least 8/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_EXPLORATION_RADIUS: '33' }),
      /AGENT_EXPLORATION_RADIUS must be at most 32/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_AUTONOMOUS: 'true' }),
      /LLM_MODEL is required/
    )
    assert.throws(
      () => loadBrainConfig({ LLM_DEBUG_TIMING: 'yes' }),
      /LLM_DEBUG_TIMING must be either true or false/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_MEMORY_EPISODE_LIMIT: '0' }),
      /AGENT_MEMORY_EPISODE_LIMIT must be at least 1/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_MEMORY_FACT_LIMIT: '7' }),
      /AGENT_MEMORY_FACT_LIMIT must be at most 6/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_MEMORY_WORLD_ID: '../other-world' }),
      /AGENT_MEMORY_WORLD_ID is invalid/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_MEMORY_DIR: 'bad\u0000path' }),
      /AGENT_MEMORY_DIR is invalid/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_DEBUG_MEMORY: 'yes' }),
      /AGENT_DEBUG_MEMORY must be either true or false/
    )
    assert.throws(
      () => loadBrainConfig({
        AGENT_AUTONOMOUS: 'true',
        LLM_PROVIDER: 'groq',
        LLM_MODEL: 'openai/gpt-oss-20b'
      }),
      /GROQ_API_KEY is required/
    )
    assert.throws(
      () => loadBrainConfig({
        AGENT_AUTONOMOUS: 'true',
        LLM_PROVIDER: 'openai',
        LLM_MODEL: 'gpt-5-mini'
      }),
      /OPENAI_API_KEY is required/
    )
    assert.throws(
      () => loadBrainConfig({
        AGENT_MEMORY_REFLECTION: 'true',
        AGENT_MEMORY_REFLECTION_MODEL: '   ',
        OPENAI_API_KEY: 'test-key'
      }),
      /AGENT_MEMORY_REFLECTION_MODEL is required/
    )
    assert.throws(
      () => loadBrainConfig({
        AGENT_MEMORY_REFLECTION: 'true',
        AGENT_MEMORY_REFLECTION_MODEL: '../unsafe-model',
        OPENAI_API_KEY: 'test-key'
      }),
      /AGENT_MEMORY_REFLECTION_MODEL is invalid/
    )
    assert.throws(
      () => loadBrainConfig({
        AGENT_MEMORY_REFLECTION: 'true'
      }),
      /OPENAI_API_KEY is required when memory reflection is enabled/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_SOCIAL_ENABLED: 'yes' }),
      /AGENT_SOCIAL_ENABLED must be either true or false/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_SOCIAL_AUTO_GREETING: 'yes' }),
      /AGENT_SOCIAL_AUTO_GREETING must be either true or false/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_SOCIAL_MAX_TURNS: '0' }),
      /AGENT_SOCIAL_MAX_TURNS must be at least 1/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_SOCIAL_MAX_TURNS: '9' }),
      /AGENT_SOCIAL_MAX_TURNS must be at most 8/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_SOCIAL_COOLDOWN_MS: '999' }),
      /AGENT_SOCIAL_COOLDOWN_MS must be at least 1000/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_SOCIAL_TURN_TIMEOUT_MS: '60001' }),
      /AGENT_SOCIAL_TURN_TIMEOUT_MS must be at most 60000/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_SOCIAL_MAX_MESSAGE_CHARS: '31' }),
      /AGENT_SOCIAL_MAX_MESSAGE_CHARS must be at least 32/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_SOCIAL_MODEL: '../unsafe-model' }),
      /AGENT_SOCIAL_MODEL is invalid/
    )
    assert.throws(
      () => loadBrainConfig({ AGENT_SOCIAL_DIR: 'bad\u0000path' }),
      /AGENT_SOCIAL_DIR is invalid/
    )
    assert.throws(
      () => loadBrainConfig({
        AGENT_SOCIAL_ENABLED: 'true'
      }),
      /OPENAI_API_KEY is required when social behavior is enabled/
    )
  })
})
