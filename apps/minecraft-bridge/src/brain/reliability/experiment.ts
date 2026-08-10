import type { MemoryIdentity } from '../../memory/types.js'
import type {
  BootstrapFailureReason,
  BootstrapReliabilitySummary
} from './telemetry.js'

export type BootstrapMemoryMode = 'isolated' | 'accumulating'
export type BootstrapCohortKind =
  | 'memory_off'
  | 'isolated_memory'
  | 'accumulating_memory'

export interface BootstrapCohort {
  kind: BootstrapCohortKind
  memoryEnabled: boolean
  memoryMode: BootstrapMemoryMode
  reflectionEnabled: boolean
}

export interface BootstrapMemoryLayout {
  fileName: string
  identity: MemoryIdentity
}

export interface BootstrapCohortComparison {
  runAccounting: {
    memoryOff: CohortRunAccounting
    memoryOn: CohortRunAccounting
  }
  deltas: {
    validRuns: number
    infrastructureInvalidRuns: number
    goalCompletionRate: number
    successRate: number
    medianCompletionTimeMs: number | null
    meanCompletionTimeMs: number | null
    medianDecisions: number | null
    meanDecisions: number | null
    progressActionRate: number
    noProgressRate: number
    craftFailureRate: number
    groundingRejectionRate: number
    validationRejectionRate: number
    providerFailureRate: number
    totalProviderCalls: number
    meanProviderLatencyMs: number | null
    medianProviderLatencyMs: number | null
    totalInputTokens: number
    totalOutputTokens: number
    averageInputTokens: number
    averageOutputTokens: number
    totalMemoryEpisodesCreated: number
    totalMemoryEpisodesRetrieved: number
    totalMemorySemanticFactsCreated: number
    totalMemorySemanticFactsRetrieved: number
    totalMemoryRetrievalFailures: number
    totalMemoryPersistenceFailures: number
    totalEstimatedMemoryPromptTokens: number
    averageMemoryPromptTokensPerProviderCall: number
  }
  failureCountDeltas: Partial<Record<BootstrapFailureReason, number>>
  memoryRetrievalQuality: BootstrapReliabilitySummary['memoryRetrievalQuality']
}

interface CohortRunAccounting {
  raw: number
  valid: number
  infrastructureInvalid: number
}

const RUN_ID = /^run-[1-9][0-9]*$/

export function readBootstrapMemoryMode(
  value: string | undefined
): BootstrapMemoryMode {
  const normalized = value?.trim() || 'isolated'
  if (normalized !== 'isolated' && normalized !== 'accumulating') {
    throw new Error(
      'BOOTSTRAP_MEMORY_MODE must be isolated or accumulating.'
    )
  }
  return normalized
}

export function memoryLayoutForRun(
  mode: BootstrapMemoryMode,
  runId: string
): BootstrapMemoryLayout {
  if (!RUN_ID.test(runId)) {
    throw new Error('Bootstrap run id is invalid.')
  }
  if (mode === 'accumulating') {
    return {
      fileName: 'accumulating.json',
      identity: {
        agentId: 'Alice',
        worldId: 'bootstrap-accumulating'
      }
    }
  }
  return {
    fileName: `${runId}.json`,
    identity: {
      agentId: 'Alice',
      worldId: `bootstrap-${runId}`
    }
  }
}

export function bootstrapCohort(
  memoryEnabled: boolean,
  memoryMode: BootstrapMemoryMode,
  reflectionEnabled: boolean
): BootstrapCohort {
  return {
    kind: memoryEnabled
      ? memoryMode === 'isolated'
        ? 'isolated_memory'
        : 'accumulating_memory'
      : 'memory_off',
    memoryEnabled,
    memoryMode,
    reflectionEnabled
  }
}

export function compareBootstrapCohorts(
  memoryOff: BootstrapReliabilitySummary,
  memoryOn: BootstrapReliabilitySummary
): BootstrapCohortComparison {
  return {
    runAccounting: {
      memoryOff: runAccounting(memoryOff),
      memoryOn: runAccounting(memoryOn)
    },
    deltas: {
      validRuns: delta(memoryOff.validRuns, memoryOn.validRuns),
      infrastructureInvalidRuns: delta(
        memoryOff.infrastructureInvalidRuns,
        memoryOn.infrastructureInvalidRuns
      ),
      goalCompletionRate: delta(
        memoryOff.goalCompletionRate,
        memoryOn.goalCompletionRate
      ),
      successRate: delta(memoryOff.successRate, memoryOn.successRate),
      medianCompletionTimeMs: nullableDelta(
        memoryOff.medianCompletionTimeMs,
        memoryOn.medianCompletionTimeMs
      ),
      meanCompletionTimeMs: nullableDelta(
        memoryOff.meanCompletionTimeMs,
        memoryOn.meanCompletionTimeMs
      ),
      medianDecisions: nullableDelta(
        memoryOff.medianDecisions,
        memoryOn.medianDecisions
      ),
      meanDecisions: nullableDelta(
        memoryOff.meanDecisions,
        memoryOn.meanDecisions
      ),
      progressActionRate: delta(
        memoryOff.progressActionRate,
        memoryOn.progressActionRate
      ),
      noProgressRate: delta(memoryOff.noProgressRate, memoryOn.noProgressRate),
      craftFailureRate: delta(
        memoryOff.craftFailureRate,
        memoryOn.craftFailureRate
      ),
      groundingRejectionRate: delta(
        memoryOff.groundingRejectionRate,
        memoryOn.groundingRejectionRate
      ),
      validationRejectionRate: delta(
        memoryOff.validationRejectionRate,
        memoryOn.validationRejectionRate
      ),
      providerFailureRate: delta(
        memoryOff.providerFailureRate,
        memoryOn.providerFailureRate
      ),
      totalProviderCalls: delta(
        memoryOff.totalProviderCalls,
        memoryOn.totalProviderCalls
      ),
      meanProviderLatencyMs: nullableDelta(
        memoryOff.meanProviderLatencyMs,
        memoryOn.meanProviderLatencyMs
      ),
      medianProviderLatencyMs: nullableDelta(
        memoryOff.medianProviderLatencyMs,
        memoryOn.medianProviderLatencyMs
      ),
      totalInputTokens: delta(
        memoryOff.totalInputTokens,
        memoryOn.totalInputTokens
      ),
      totalOutputTokens: delta(
        memoryOff.totalOutputTokens,
        memoryOn.totalOutputTokens
      ),
      averageInputTokens: delta(
        memoryOff.averageInputTokens,
        memoryOn.averageInputTokens
      ),
      averageOutputTokens: delta(
        memoryOff.averageOutputTokens,
        memoryOn.averageOutputTokens
      ),
      totalMemoryEpisodesCreated: delta(
        memoryOff.totalMemoryEpisodesCreated,
        memoryOn.totalMemoryEpisodesCreated
      ),
      totalMemoryEpisodesRetrieved: delta(
        memoryOff.totalMemoryEpisodesRetrieved,
        memoryOn.totalMemoryEpisodesRetrieved
      ),
      totalMemorySemanticFactsCreated: delta(
        memoryOff.totalMemorySemanticFactsCreated,
        memoryOn.totalMemorySemanticFactsCreated
      ),
      totalMemorySemanticFactsRetrieved: delta(
        memoryOff.totalMemorySemanticFactsRetrieved,
        memoryOn.totalMemorySemanticFactsRetrieved
      ),
      totalMemoryRetrievalFailures: delta(
        memoryOff.totalMemoryRetrievalFailures,
        memoryOn.totalMemoryRetrievalFailures
      ),
      totalMemoryPersistenceFailures: delta(
        memoryOff.totalMemoryPersistenceFailures,
        memoryOn.totalMemoryPersistenceFailures
      ),
      totalEstimatedMemoryPromptTokens: delta(
        memoryOff.totalEstimatedMemoryPromptTokens,
        memoryOn.totalEstimatedMemoryPromptTokens
      ),
      averageMemoryPromptTokensPerProviderCall: delta(
        memoryOff.averageMemoryPromptTokensPerProviderCall,
        memoryOn.averageMemoryPromptTokensPerProviderCall
      )
    },
    failureCountDeltas: failureCountDeltas(memoryOff, memoryOn),
    memoryRetrievalQuality: { ...memoryOn.memoryRetrievalQuality }
  }
}

function runAccounting(
  summary: BootstrapReliabilitySummary
): CohortRunAccounting {
  return {
    raw: summary.rawRuns,
    valid: summary.validRuns,
    infrastructureInvalid: summary.infrastructureInvalidRuns
  }
}

function failureCountDeltas(
  memoryOff: BootstrapReliabilitySummary,
  memoryOn: BootstrapReliabilitySummary
): Partial<Record<BootstrapFailureReason, number>> {
  const reasons = new Set([
    ...Object.keys(memoryOff.failureCounts),
    ...Object.keys(memoryOn.failureCounts)
  ] as BootstrapFailureReason[])
  return Object.fromEntries(
    [...reasons].sort().map(reason => [
      reason,
      delta(
        memoryOff.failureCounts[reason] ?? 0,
        memoryOn.failureCounts[reason] ?? 0
      )
    ]).filter(([, difference]) => difference !== 0)
  )
}

function nullableDelta(
  memoryOff: number | null,
  memoryOn: number | null
): number | null {
  return memoryOff === null || memoryOn === null
    ? null
    : delta(memoryOff, memoryOn)
}

function delta(memoryOff: number, memoryOn: number): number {
  return Math.round((memoryOn - memoryOff) * 1_000_000) / 1_000_000
}
