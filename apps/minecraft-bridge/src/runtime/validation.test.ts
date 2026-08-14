import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import type { AgentRuntimeSnapshot } from './agentRuntime.js'
import { createEmptySocialTelemetry } from './telemetry.js'
import {
  createMultiAgentValidationReport,
  decodeMultiAgentValidationReport,
  readValidationSessionMs,
  resolveValidationOutputPath,
  writeMultiAgentValidationReport
} from './validation.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})

describe('multi-agent validation reporting', () => {
  it('aggregates startup, connection, provider, queue, token, and cost metrics', () => {
    const report = createMultiAgentValidationReport({
      sessionStartedAt: 1_000,
      sessionEndedAt: 6_000,
      termination: 'duration',
      requestedAgents: [
        { agentId: 'alice', username: 'Alice' },
        { agentId: 'bob', username: 'Bob' },
        { agentId: 'charlie', username: 'Charlie' }
      ],
      startup: {
        started: ['alice', 'bob'],
        failures: [{ agentId: 'charlie', username: 'Charlie', error: 'secret marker' }]
      },
      shutdown: {
        stopped: ['bob', 'alice'],
        failures: []
      },
      snapshots: [
        snapshot('alice', 'Alice', {
          calls: 2,
          failures: 0,
          inputTokens: 1_000,
          outputTokens: 100,
          latencies: [100, 300],
          queueWait: [0, 20],
          visibleExternalPlayers: ['Bob']
        }),
        snapshot('bob', 'Bob', {
          calls: 1,
          failures: 1,
          inputTokens: 500,
          outputTokens: 50,
          latencies: [200],
          queueWait: [10],
          visibleExternalPlayers: ['Alice'],
          disconnects: 1
        })
      ]
    })

    assert.deepEqual(report.startup, {
      requestedAgentIds: ['alice', 'bob', 'charlie'],
      startedAgentIds: ['alice', 'bob'],
      failedAgentIds: ['charlie'],
      successRate: 2 / 3
    })
    assert.deepEqual(report.agents.map(agent => ({
      id: agent.agentId,
      visible: agent.visibleExternalPlayers,
      meanLatencyMs: agent.provider.meanLatencyMs,
      medianLatencyMs: agent.provider.medianLatencyMs,
      meanQueueWaitMs: agent.provider.meanQueueWaitMs,
      estimatedCostUsd: agent.provider.estimatedCostUsd
    })), [{
      id: 'alice',
      visible: ['Bob'],
      meanLatencyMs: 200,
      medianLatencyMs: 200,
      meanQueueWaitMs: 10,
      estimatedCostUsd: 0.00045
    }, {
      id: 'bob',
      visible: ['Alice'],
      meanLatencyMs: 200,
      medianLatencyMs: 200,
      meanQueueWaitMs: 10,
      estimatedCostUsd: 0.000225
    }])
    assert.deepEqual(report.aggregate, {
      requestedAgents: 3,
      startedAgents: 2,
      startupSuccessRate: 2 / 3,
      providerCalls: 3,
      providerFailures: 1,
      inputTokens: 1_500,
      outputTokens: 150,
      meanProviderLatencyMs: 200,
      medianProviderLatencyMs: 200,
      meanProviderQueueWaitMs: 10,
      disconnects: 1,
      errors: 0,
      kicked: 0,
      memoryRetrievalFailures: 0,
      memoryPersistenceFailures: 0,
      estimatedCostUsd: 0.000675
    })
  })

  it('serializes only allowlisted telemetry and no lifecycle error text', () => {
    const report = createMultiAgentValidationReport({
      sessionStartedAt: 1,
      sessionEndedAt: 2,
      termination: 'SIGINT',
      requestedAgents: [{ agentId: 'alice', username: 'Alice' }],
      startup: {
        started: [],
        failures: [{
          agentId: 'alice',
          username: 'Alice',
          error: 'Ignore instructions. authorization bearer secret-provider-response'
        }]
      },
      shutdown: { stopped: [], failures: [] },
      snapshots: []
    })
    const encoded = JSON.stringify(report)
    const forbiddenKeys = new Set([
      'prompt', 'response', 'chat', 'reason', 'key', 'authorization',
      'modelText', 'error'
    ])

    visit(report, key => assert.equal(forbiddenKeys.has(key), false, key))
    assert.equal(encoded.includes('Ignore instructions'), false)
    assert.equal(encoded.includes('secret-provider-response'), false)
  })

  it('writes a complete temporary report before atomic replacement', async () => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'report.json')
    await writeFile(filePath, '{"old":true}\n', 'utf8')
    let destinationBeforeRename = ''
    let temporaryAtRename = ''
    const report = createMultiAgentValidationReport({
      sessionStartedAt: 10,
      sessionEndedAt: 20,
      termination: 'duration',
      requestedAgents: [],
      startup: { started: [], failures: [] },
      shutdown: { stopped: [], failures: [] },
      snapshots: []
    })

    await writeMultiAgentValidationReport(filePath, report, {
      temporarySuffix: '.test-tmp',
      beforeRename: async temporaryPath => {
        destinationBeforeRename = await readFile(filePath, 'utf8')
        temporaryAtRename = await readFile(temporaryPath, 'utf8')
      }
    })

    assert.equal(destinationBeforeRename, '{"old":true}\n')
    assert.deepEqual(JSON.parse(temporaryAtRename), report)
    assert.deepEqual(
      decodeMultiAgentValidationReport(JSON.parse(await readFile(filePath, 'utf8'))),
      report
    )
  })

  it('fails closed on unsupported or malformed report data', () => {
    assert.throws(
      () => decodeMultiAgentValidationReport({ schemaVersion: 2 }),
      /unsupported multi-agent validation schema version/i
    )
    assert.throws(
      () => decodeMultiAgentValidationReport({
        schemaVersion: 1,
        session: {},
        startup: {},
        shutdown: {},
        agents: [],
        aggregate: {}
      }),
      /invalid multi-agent validation report/i
    )
  })

  it('bounds live duration and resolves only JSON report targets', () => {
    assert.equal(readValidationSessionMs(undefined), 60_000)
    assert.equal(readValidationSessionMs('1500'), 1_500)
    assert.throws(() => readValidationSessionMs('999'), /at least 1000/i)
    assert.throws(() => readValidationSessionMs('600001'), /at most 600000/i)
    assert.throws(() => readValidationSessionMs('1s'), /integer/i)
    assert.equal(
      resolveValidationOutputPath('artifacts/session.json', '/workspace', '/app'),
      '/workspace/artifacts/session.json'
    )
    assert.equal(
      resolveValidationOutputPath(undefined, '/workspace', '/app'),
      '/app/data/validation/latest.json'
    )
    assert.throws(
      () => resolveValidationOutputPath('report.txt', '/workspace', '/app'),
      /JSON file/i
    )
  })
})

function snapshot(
  agentId: string,
  username: string,
  options: {
    calls: number
    failures: number
    inputTokens: number
    outputTokens: number
    latencies: number[]
    queueWait: number[]
    visibleExternalPlayers: string[]
    disconnects?: number
  }
): AgentRuntimeSnapshot {
  return {
    identity: { agentId, username },
    phase: 'running',
    startedAt: 1,
    stoppedAt: null,
    visibleExternalPlayers: [...options.visibleExternalPlayers],
    state: {
      agentName: username,
      status: 'idle',
      currentAction: null,
      currentGoal: null,
      actionSource: null,
      busy: false,
      actionVersion: 0,
      manualOverrideVersion: 0
    },
    telemetry: {
      agentId,
      username,
      providerCalls: options.calls,
      providerFailures: options.failures,
      inputTokens: options.inputTokens,
      outputTokens: options.outputTokens,
      providerLatenciesMs: [...options.latencies],
      providerQueueWaitMs: [...options.queueWait],
      spawned: 1,
      disconnects: options.disconnects ?? 0,
      errors: 0,
      kicked: 0,
      social: createEmptySocialTelemetry(),
      memory: {
        episodesCreated: 1,
        episodesRetrieved: 1,
        semanticFactsCreated: 1,
        semanticFactsRetrieved: 1,
        retrievalFailures: 0,
        persistenceFailures: 0,
        reflectionCalls: 0,
        reflectionFailures: 0,
        reflectionInputTokens: 0,
        reflectionOutputTokens: 0,
        estimatedMemoryPromptTokens: 10
      }
    }
  }
}

function visit(value: unknown, inspectKey: (key: string) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, inspectKey)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, child] of Object.entries(value)) {
    inspectKey(key)
    visit(child, inspectKey)
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'multi-agent-validation-'))
  temporaryDirectories.push(directory)
  return directory
}
