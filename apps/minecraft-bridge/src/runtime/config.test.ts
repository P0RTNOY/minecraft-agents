import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  decodeAgentConfigDocument,
  loadAgentConfiguration
} from './config.js'

const document = JSON.stringify({
  schemaVersion: 1,
  agents: [
    { id: 'alice', username: 'Alice' },
    { id: 'bob', username: 'Bob', autonomous: false },
    { id: 'charlie', username: 'Charlie', memoryEnabled: false }
  ]
})

describe('decodeAgentConfigDocument', () => {
  it('decodes stable identities and optional per-agent overrides', () => {
    assert.deepEqual(decodeAgentConfigDocument(JSON.parse(document)), {
      schemaVersion: 1,
      agents: [
        { id: 'alice', username: 'Alice' },
        { id: 'bob', username: 'Bob', autonomous: false },
        { id: 'charlie', username: 'Charlie', memoryEnabled: false }
      ]
    })
  })

  it('rejects duplicate IDs and usernames case-insensitively', () => {
    assert.throws(() => decodeAgentConfigDocument({
      schemaVersion: 1,
      agents: [
        { id: 'alice', username: 'Alice' },
        { id: 'ALICE', username: 'Other' }
      ]
    }), /invalid agent id|duplicate agent id/i)
    assert.throws(() => decodeAgentConfigDocument({
      schemaVersion: 1,
      agents: [
        { id: 'alice', username: 'Alice' },
        { id: 'other', username: 'alice' }
      ]
    }), /duplicate agent username/i)
  })

  it('rejects traversal-shaped IDs, extra fields, and unsupported schemas', () => {
    assert.throws(() => decodeAgentConfigDocument({
      schemaVersion: 1,
      agents: [{ id: '../bob', username: 'Bob' }]
    }), /invalid agent id/i)
    assert.throws(() => decodeAgentConfigDocument({
      schemaVersion: 1,
      agents: [{ id: 'bob', username: 'Bob', secret: 'no' }]
    }), /unexpected field/i)
    assert.throws(() => decodeAgentConfigDocument({
      schemaVersion: 2,
      agents: []
    }), /unsupported agent configuration schema/i)
  })
})

describe('loadAgentConfiguration', () => {
  it('loads Alice by default and preserves explicit selection order', async () => {
    const defaults = await load({}, document)
    const selected = await load({ AGENTS: 'charlie,alice' }, document)

    assert.deepEqual(defaults.agents.map(agent => agent.id), ['alice'])
    assert.deepEqual(selected.agents.map(agent => agent.id), ['charlie', 'alice'])
  })

  it('loads all configured agents with the all selector', async () => {
    const result = await load({ AGENTS: 'all' }, document)
    assert.deepEqual(result.agents.map(agent => agent.id), [
      'alice',
      'bob',
      'charlie'
    ])
  })

  it('rejects unknown or repeated selections', async () => {
    await assert.rejects(load({ AGENTS: 'dave' }, document), /unknown agent id/i)
    await assert.rejects(
      load({ AGENTS: 'alice,Alice' }, document),
      /duplicate selected agent/i
    )
  })

  it('parses bounded concurrency, staggering, connection, and operators', async () => {
    const result = await load({
      AGENT_LLM_MAX_CONCURRENCY: '3',
      AGENT_BRAIN_STAGGER_MS: '750',
      AGENT_OPERATOR_USERNAMES: ' OPortnoy,Steve ',
      MINECRAFT_HOST: 'paper.local',
      MINECRAFT_PORT: '25570',
      AGENT_SPAWN_TIMEOUT_MS: '45000'
    }, document)

    assert.equal(result.maxProviderConcurrency, 3)
    assert.equal(result.brainStaggerMs, 750)
    assert.deepEqual(result.operatorUsernames, ['OPortnoy', 'Steve'])
    assert.deepEqual(result.minecraft, {
      host: 'paper.local',
      port: 25570,
      spawnTimeoutMs: 45000
    })
  })

  it('rejects unsafe paths and invalid bounded settings', async () => {
    await assert.rejects(
      load({ AGENT_CONFIG_PATH: '../agents.json' }, document),
      /agent config path/i
    )
    await assert.rejects(
      load({ AGENT_LLM_MAX_CONCURRENCY: '0' }, document),
      /AGENT_LLM_MAX_CONCURRENCY must be at least 1/i
    )
    await assert.rejects(
      load({ AGENT_BRAIN_STAGGER_MS: '60001' }, document),
      /AGENT_BRAIN_STAGGER_MS must be at most 60000/i
    )
  })
})

async function load(
  environment: Readonly<Record<string, string | undefined>>,
  encoded: string
) {
  return loadAgentConfiguration(environment, {
    appDirectory: '/workspace',
    readFile: async path => {
      assert.equal(path, '/workspace/configs/agents.json')
      return encoded
    }
  })
}
