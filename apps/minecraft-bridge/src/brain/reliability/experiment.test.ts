import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AtomicJsonMemoryStore } from '../../memory/store.js'
import type { EpisodicMemory } from '../../memory/types.js'
import {
  bootstrapCohort,
  compareBootstrapCohorts,
  memoryLayoutForRun,
  readBootstrapMemoryMode,
  readPaperStartupTimeout
} from './experiment.js'
import type { BootstrapReliabilitySummary } from './telemetry.js'

describe('memory reliability experiment controls', () => {
  it('defaults to isolated memory and rejects unsupported modes', () => {
    assert.equal(readBootstrapMemoryMode(undefined), 'isolated')
    assert.equal(readBootstrapMemoryMode(' isolated '), 'isolated')
    assert.equal(readBootstrapMemoryMode('accumulating'), 'accumulating')
    assert.throws(
      () => readBootstrapMemoryMode('shared'),
      /BOOTSTRAP_MEMORY_MODE must be isolated or accumulating/
    )
  })

  it('allows one bounded Paper startup override for every cohort', () => {
    assert.equal(readPaperStartupTimeout(undefined), 60_000)
    assert.equal(readPaperStartupTimeout('120000'), 120_000)
    assert.throws(
      () => readPaperStartupTimeout('59999'),
      /BOOTSTRAP_PAPER_START_TIMEOUT_MS must be an integer from 60000 to 300000/
    )
    assert.throws(
      () => readPaperStartupTimeout('300001'),
      /BOOTSTRAP_PAPER_START_TIMEOUT_MS must be an integer from 60000 to 300000/
    )
  })

  it('uses distinct controlled files and world identities for isolated runs', () => {
    const first = memoryLayoutForRun('isolated', 'run-1')
    const second = memoryLayoutForRun('isolated', 'run-2')

    assert.deepEqual(first, {
      fileName: 'run-1.json',
      identity: { agentId: 'Alice', worldId: 'bootstrap-run-1' }
    })
    assert.notDeepEqual(first, second)
    assert.throws(
      () => memoryLayoutForRun('isolated', '../escape'),
      /run id is invalid/
    )
  })

  it('reopens one cohort-scoped file and identity for accumulating runs', () => {
    assert.deepEqual(
      memoryLayoutForRun('accumulating', 'run-1'),
      memoryLayoutForRun('accumulating', 'run-10')
    )
    assert.deepEqual(memoryLayoutForRun('accumulating', 'run-2'), {
      fileName: 'accumulating.json',
      identity: { agentId: 'Alice', worldId: 'bootstrap-accumulating' }
    })
  })

  it('isolates per-run state while accumulating mode reopens prior state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'memory-cohort-test-'))
    try {
      const isolatedFirst = memoryLayoutForRun('isolated', 'run-1')
      const isolatedStore = new AtomicJsonMemoryStore({
        filePath: join(directory, isolatedFirst.fileName),
        identity: isolatedFirst.identity
      })
      await isolatedStore.open()
      await isolatedStore.addEpisode(episode(isolatedFirst.identity.worldId))

      const isolatedSecond = memoryLayoutForRun('isolated', 'run-2')
      const freshStore = new AtomicJsonMemoryStore({
        filePath: join(directory, isolatedSecond.fileName),
        identity: isolatedSecond.identity
      })
      await freshStore.open()
      assert.deepEqual(await freshStore.listRecentEpisodes(4), [])

      const accumulatingFirst = memoryLayoutForRun('accumulating', 'run-1')
      const accumulatingStore = new AtomicJsonMemoryStore({
        filePath: join(directory, accumulatingFirst.fileName),
        identity: accumulatingFirst.identity
      })
      await accumulatingStore.open()
      await accumulatingStore.addEpisode(
        episode(accumulatingFirst.identity.worldId)
      )

      const accumulatingSecond = memoryLayoutForRun('accumulating', 'run-2')
      const reopenedStore = new AtomicJsonMemoryStore({
        filePath: join(directory, accumulatingSecond.fileName),
        identity: accumulatingSecond.identity
      })
      await reopenedStore.open()
      assert.equal((await reopenedStore.listRecentEpisodes(4)).length, 1)
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it('labels memory-off, isolated, and accumulating cohorts explicitly', () => {
    assert.equal(bootstrapCohort(false, 'isolated', false).kind, 'memory_off')
    assert.equal(bootstrapCohort(true, 'isolated', false).kind, 'isolated_memory')
    assert.equal(
      bootstrapCohort(true, 'accumulating', false).kind,
      'accumulating_memory'
    )
    assert.deepEqual(bootstrapCohort(true, 'isolated', false), {
      kind: 'isolated_memory',
      memoryEnabled: true,
      memoryMode: 'isolated',
      reflectionEnabled: false
    })
  })

  it('compares complete cohort accounting and reports memory-on deltas', () => {
    const memoryOff = summary({
      rawRuns: 10,
      validRuns: 9,
      infrastructureInvalidRuns: 1,
      goalCompletionRate: 0.8,
      meanCompletionTimeMs: 30_000,
      medianCompletionTimeMs: 28_000,
      meanDecisions: 8,
      medianDecisions: 8,
      progressActionRate: 0.95,
      noProgressRate: 0.05,
      craftFailureRate: 0.05,
      totalProviderCalls: 80,
      meanProviderLatencyMs: 2_500,
      medianProviderLatencyMs: 2_400,
      totalInputTokens: 10_000,
      totalOutputTokens: 1_000,
      failureCounts: { timeout: 1 }
    })
    const memoryOn = summary({
      rawRuns: 10,
      validRuns: 8,
      infrastructureInvalidRuns: 2,
      goalCompletionRate: 0.5,
      meanCompletionTimeMs: 40_000,
      medianCompletionTimeMs: 38_000,
      meanDecisions: 10,
      medianDecisions: 9,
      progressActionRate: 0.85,
      noProgressRate: 0.15,
      craftFailureRate: 0.1,
      totalProviderCalls: 90,
      meanProviderLatencyMs: 3_000,
      medianProviderLatencyMs: 2_900,
      totalInputTokens: 14_000,
      totalOutputTokens: 1_200,
      totalMemoryEpisodesCreated: 20,
      totalMemoryEpisodesRetrieved: 40,
      totalMemorySemanticFactsCreated: 10,
      totalMemorySemanticFactsRetrieved: 30,
      totalEstimatedMemoryPromptTokens: 1_200,
      averageMemoryPromptTokensPerProviderCall: 13.333333,
      memoryRetrievalQuality: {
        directlyRelevant: 20,
        weaklyRelevant: 15,
        irrelevant: 4,
        staleOrContradicted: 1,
        total: 40
      },
      failureCounts: { timeout: 3, provider_error: 1 }
    })

    const comparison = compareBootstrapCohorts(memoryOff, memoryOn)

    assert.deepEqual(comparison.runAccounting, {
      memoryOff: { raw: 10, valid: 9, infrastructureInvalid: 1 },
      memoryOn: { raw: 10, valid: 8, infrastructureInvalid: 2 }
    })
    assert.equal(comparison.deltas.goalCompletionRate, -0.3)
    assert.equal(comparison.deltas.validRuns, -1)
    assert.equal(comparison.deltas.infrastructureInvalidRuns, 1)
    assert.equal(comparison.deltas.meanCompletionTimeMs, 10_000)
    assert.equal(comparison.deltas.meanDecisions, 2)
    assert.equal(comparison.deltas.progressActionRate, -0.1)
    assert.equal(comparison.deltas.noProgressRate, 0.1)
    assert.equal(comparison.deltas.meanProviderLatencyMs, 500)
    assert.equal(comparison.deltas.totalInputTokens, 4_000)
    assert.equal(comparison.deltas.totalMemoryEpisodesRetrieved, 40)
    assert.deepEqual(comparison.failureCountDeltas, {
      provider_error: 1,
      timeout: 2
    })
    assert.deepEqual(comparison.memoryRetrievalQuality, memoryOn.memoryRetrievalQuality)
  })

  it('keeps unavailable timing deltas explicit instead of treating them as zero', () => {
    const comparison = compareBootstrapCohorts(
      summary({ meanCompletionTimeMs: null }),
      summary({ meanCompletionTimeMs: 40_000 })
    )

    assert.equal(comparison.deltas.meanCompletionTimeMs, null)
  })
})

function summary(
  overrides: Partial<BootstrapReliabilitySummary> = {}
): BootstrapReliabilitySummary {
  return {
    rawRuns: 0,
    validRuns: 0,
    infrastructureInvalidRuns: 0,
    successes: 0,
    goalCompletionRate: 0,
    successRate: 0,
    medianCompletionTimeMs: null,
    meanCompletionTimeMs: null,
    medianDecisions: null,
    meanDecisions: null,
    progressActionRate: 0,
    noProgressRate: 0,
    craftFailureRate: 0,
    craftRetryRate: 0,
    craftRetrySuccessRate: 0,
    groundingRejectionRate: 0,
    validationRejectionRate: 0,
    providerFailureRate: 0,
    reflexTriggerRate: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    averageInputTokens: 0,
    averageOutputTokens: 0,
    totalMemoryEpisodesCreated: 0,
    totalMemoryEpisodesRetrieved: 0,
    totalMemorySemanticFactsCreated: 0,
    totalMemorySemanticFactsRetrieved: 0,
    totalMemoryRetrievalFailures: 0,
    totalMemoryPersistenceFailures: 0,
    totalReflectionCalls: 0,
    totalReflectionFailures: 0,
    reflectionFailureRate: 0,
    totalReflectionInputTokens: 0,
    totalReflectionOutputTokens: 0,
    totalEstimatedMemoryPromptTokens: 0,
    totalProviderCalls: 0,
    meanProviderLatencyMs: null,
    medianProviderLatencyMs: null,
    averageMemoryPromptTokensPerProviderCall: 0,
    memoryRetrievalQuality: {
      directlyRelevant: 0,
      weaklyRelevant: 0,
      irrelevant: 0,
      staleOrContradicted: 0,
      total: 0
    },
    failureCounts: {},
    mostCommonFailureReason: null,
    ...overrides
  }
}

function episode(worldId: string): EpisodicMemory {
  return {
    id: `episode-${worldId}`,
    agentId: 'Alice',
    worldId,
    timestamp: 1,
    type: 'resource_discovery',
    summary: 'Discovered oak_log nearby.',
    importance: 7,
    source: 'perception',
    context: { region: '0:0', resource: 'oak_log' }
  }
}
