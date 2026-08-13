import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import type { AgentRuntimeSnapshot } from '../runtime/agentRuntime.js'
import { createEmptySocialTelemetry } from '../runtime/telemetry.js'
import {
  assertM6LiveBudget,
  createSocialReliabilityReport,
  decodeSocialReliabilityReport,
  readM6SessionMs,
  readM6UsedCalls,
  readM6UsedCost,
  resolveSocialReliabilityOutputPath,
  writeSocialReliabilityReport,
  type SocialReliabilityRunEvidence
} from './reliability.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})

describe('M6 social reliability reporting', () => {
  it('calculates one/two/three-agent validity and requested aggregate metrics', () => {
    const report = createSocialReliabilityReport([
      evidence('one-1', 'one_agent', [snapshot('alice', 'Alice')]),
      evidence('two-1', 'two_agent', [
        snapshot('alice', 'Alice', social({
          providerCalls: 1,
          inputTokens: 40,
          outputTokens: 8,
          providerLatenciesMs: [20],
          providerQueueWaitMs: [2],
          conversationsStarted: 1,
          conversationsCompleted: 1,
          turnsCompleted: 1,
          terminalConversationTurns: [2],
          relationshipUpdates: { agentSeen: 1, conversationCompleted: 1 },
          episodesCreated: 4
        })),
        snapshot('bob', 'Bob', social({
          providerCalls: 1,
          inputTokens: 30,
          outputTokens: 6,
          providerLatenciesMs: [30],
          providerQueueWaitMs: [4],
          conversationsStarted: 1,
          conversationsCompleted: 1,
          turnsCompleted: 1,
          terminalConversationTurns: [2],
          relationshipUpdates: { agentSeen: 1, conversationCompleted: 1 },
          episodesCreated: 4
        }))
      ]),
      evidence('three-1', 'three_agent', [
        snapshot('alice', 'Alice'),
        snapshot('bob', 'Bob'),
        snapshot('charlie', 'Charlie')
      ])
    ])

    assert.deepEqual(report.aggregate.validSessions, {
      oneAgent: 1,
      twoAgent: 1,
      threeAgent: 0
    })
    assert.equal(report.aggregate.startupSuccessRate, 1)
    assert.equal(report.aggregate.cleanShutdownRate, 1)
    assert.equal(report.aggregate.conversationCompletionRate, 1)
    assert.equal(report.aggregate.meanTurns, 2)
    assert.equal(report.aggregate.medianTurns, 2)
    assert.equal(report.aggregate.providerCalls, 2)
    assert.equal(report.aggregate.providerFailureRate, 0)
    assert.equal(report.aggregate.meanProviderLatencyMs, 25)
    assert.equal(report.aggregate.meanProviderQueueWaitMs, 3)
    assert.equal(report.aggregate.relationshipUpdates.agentSeen, 2)
    assert.equal(report.aggregate.relationshipUpdates.conversationCompleted, 2)
    assert.equal(report.aggregate.unverifiedClaimsPromotedToFacts, 0)
    assert.equal(report.aggregate.totalEstimatedCostUsd, 0.0000455)
  })

  it('fails closed for malformed reports and unsupported versions', () => {
    assert.throws(
      () => decodeSocialReliabilityReport({ schemaVersion: 2 }),
      /unsupported M6 social reliability schema version/i
    )
    assert.throws(
      () => decodeSocialReliabilityReport({ schemaVersion: 1 }),
      /invalid M6 social reliability report/i
    )
  })

  it('marks unmeasured safety checks explicitly and fails the run closed', () => {
    const unmeasured = evidence('one-unmeasured', 'one_agent', [
      snapshot('alice', 'Alice')
    ])
    unmeasured.safety = {
      runawayLoops: null,
      commandRoutingFailures: null,
      crossAgentMemoryLeaks: null,
      crossAgentRelationshipLeaks: null,
      unverifiedClaimsPromotedToFacts: null
    }

    const report = createSocialReliabilityReport([unmeasured])

    assert.equal(report.runs[0]?.valid, false)
    assert.deepEqual(report.runs[0]?.safety, unmeasured.safety)
    assert.equal(report.aggregate.runawayLoopCount, null)
    assert.equal(report.aggregate.unverifiedClaimsPromotedToFacts, null)
  })

  it('refuses projected live use at the hard call or cost budget', () => {
    assert.doesNotThrow(() => assertM6LiveBudget({
      providerCalls: 299,
      estimatedCostUsd: 0.99
    }, { providerCalls: 1, estimatedCostUsd: 0.009 }))
    assert.throws(() => assertM6LiveBudget({
      providerCalls: 300,
      estimatedCostUsd: 0.5
    }, { providerCalls: 1, estimatedCostUsd: 0 }), /call budget/i)
    assert.throws(() => assertM6LiveBudget({
      providerCalls: 1,
      estimatedCostUsd: 0.99
    }, { providerCalls: 1, estimatedCostUsd: 0.01 }), /cost budget/i)
  })

  it('atomically replaces a privacy-safe report without transcript fields', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'report.json')
    await writeFile(path, '{"old":true}\n', 'utf8')
    const report = createSocialReliabilityReport([
      evidence('one-1', 'one_agent', [snapshot('alice', 'Alice')])
    ])
    let observedOldFile = false

    await writeSocialReliabilityReport(path, report, {
      temporarySuffix: '.replacement.tmp',
      beforeRename: async temporaryPath => {
        observedOldFile = (await readFile(path, 'utf8')).includes('old')
        assert.equal(
          decodeSocialReliabilityReport(JSON.parse(
            await readFile(temporaryPath, 'utf8')
          )).schemaVersion,
          1
        )
      }
    })

    const encoded = await readFile(path, 'utf8')
    assert.equal(observedOldFile, true)
    for (const forbidden of [
      'message', 'prompt', 'response', 'authorization', 'reasoning', 'transcript'
    ]) {
      assert.equal(encoded.toLowerCase().includes(forbidden), false)
    }
  })

  it('uses a contained temporary default output path', () => {
    assert.equal(
      resolveSocialReliabilityOutputPath(undefined),
      '/tmp/minecraft-agents-m6-social-validation.json'
    )
    assert.throws(
      () => resolveSocialReliabilityOutputPath('../report.txt'),
      /JSON file/i
    )
  })

  it('strictly bounds unattended live controls', () => {
    assert.equal(readM6SessionMs(undefined), 30_000)
    assert.equal(readM6SessionMs('5000'), 5_000)
    assert.equal(readM6UsedCalls('299'), 299)
    assert.equal(readM6UsedCost('0.25'), 0.25)
    assert.throws(() => readM6SessionMs('4999'), /5000/)
    assert.throws(() => readM6UsedCalls('301'), /300/)
    assert.throws(() => readM6UsedCost('1'), /not including 1/)
  })
})

function evidence(
  id: string,
  cohort: SocialReliabilityRunEvidence['cohort'],
  snapshots: AgentRuntimeSnapshot[]
): SocialReliabilityRunEvidence {
  return {
    id,
    cohort,
    startedAt: 1,
    endedAt: 101,
    requestedAgents: snapshots.map(item => item.identity),
    startup: { started: snapshots.map(item => item.identity.agentId), failures: [] },
    shutdown: { stopped: [...snapshots].reverse().map(item => item.identity.agentId), failures: [] },
    snapshots,
    safety: {
      runawayLoops: 0,
      commandRoutingFailures: 0,
      crossAgentMemoryLeaks: 0,
      crossAgentRelationshipLeaks: 0,
      unverifiedClaimsPromotedToFacts: 0
    }
  }
}

function snapshot(
  agentId: string,
  username: string,
  socialMetrics = createEmptySocialTelemetry()
): AgentRuntimeSnapshot {
  return {
    identity: { agentId, username },
    phase: 'stopped',
    startedAt: 1,
    stoppedAt: 100,
    visibleExternalPlayers: [],
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
      providerCalls: 0,
      providerFailures: 0,
      inputTokens: 0,
      outputTokens: 0,
      providerLatenciesMs: [],
      providerQueueWaitMs: [],
      spawned: 1,
      disconnects: 0,
      errors: 0,
      kicked: 0,
      memory: null,
      social: socialMetrics
    }
  }
}

function social(
  overrides: Partial<ReturnType<typeof createEmptySocialTelemetry>>
) {
  return {
    ...createEmptySocialTelemetry(),
    ...overrides
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'm6-social-reliability-'))
  temporaryDirectories.push(directory)
  return directory
}
