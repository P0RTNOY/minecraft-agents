import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { BootstrapReliabilitySummary } from './telemetry.js'
import {
  compareBootstrapCohorts,
  type BootstrapCohortKind
} from './experiment.js'

interface CohortArtifact {
  cohort: { kind: BootstrapCohortKind }
  summary: BootstrapReliabilitySummary
}

async function main(): Promise<void> {
  const [memoryOffPath, isolatedPath, accumulatingPath] = process.argv.slice(2)
  if (!memoryOffPath || !isolatedPath || !accumulatingPath) {
    throw new Error(
      'Usage: compareCli <memory-off.json> <isolated-memory.json> <accumulating-memory.json>'
    )
  }

  const [memoryOff, isolated, accumulating] = await Promise.all([
    readArtifact(memoryOffPath, 'memory_off'),
    readArtifact(isolatedPath, 'isolated_memory'),
    readArtifact(accumulatingPath, 'accumulating_memory')
  ])

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    cohorts: {
      memoryOff: memoryOff.summary,
      isolatedMemory: isolated.summary,
      accumulatingMemory: accumulating.summary
    },
    comparisons: {
      isolatedMemoryMinusOff: compareBootstrapCohorts(
        memoryOff.summary,
        isolated.summary
      ),
      accumulatingMemoryMinusOff: compareBootstrapCohorts(
        memoryOff.summary,
        accumulating.summary
      )
    }
  }, null, 2)}\n`)
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Cohort comparison failed.')
  process.exitCode = 1
})

async function readArtifact(
  filePath: string,
  expectedKind: BootstrapCohortKind
): Promise<CohortArtifact> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(resolve(filePath), 'utf8'))
  } catch {
    throw new Error(`Could not read valid cohort JSON for ${expectedKind}.`)
  }
  if (!isRecord(parsed) || !isRecord(parsed.cohort)) {
    throw new Error(`Cohort artifact for ${expectedKind} is invalid.`)
  }
  if (parsed.cohort.kind !== expectedKind || !validSummary(parsed.summary)) {
    throw new Error(`Cohort artifact for ${expectedKind} has unexpected data.`)
  }
  return parsed as unknown as CohortArtifact
}

function validSummary(value: unknown): value is BootstrapReliabilitySummary {
  if (!isRecord(value)) return false
  const numericFields = [
    'rawRuns',
    'validRuns',
    'infrastructureInvalidRuns',
    'goalCompletionRate',
    'successRate',
    'progressActionRate',
    'noProgressRate',
    'craftFailureRate',
    'groundingRejectionRate',
    'validationRejectionRate',
    'providerFailureRate',
    'totalInputTokens',
    'totalOutputTokens',
    'averageInputTokens',
    'averageOutputTokens',
    'totalMemoryEpisodesCreated',
    'totalMemoryEpisodesRetrieved',
    'totalMemorySemanticFactsCreated',
    'totalMemorySemanticFactsRetrieved',
    'totalMemoryRetrievalFailures',
    'totalMemoryPersistenceFailures',
    'totalEstimatedMemoryPromptTokens',
    'totalProviderCalls',
    'averageMemoryPromptTokensPerProviderCall'
  ]
  return numericFields.every(field => (
    typeof value[field] === 'number' && Number.isFinite(value[field])
  )) &&
    nullableNumber(value.meanCompletionTimeMs) &&
    nullableNumber(value.medianCompletionTimeMs) &&
    nullableNumber(value.meanDecisions) &&
    nullableNumber(value.medianDecisions) &&
    nullableNumber(value.meanProviderLatencyMs) &&
    nullableNumber(value.medianProviderLatencyMs) &&
    isRecord(value.failureCounts) &&
    isRecord(value.memoryRetrievalQuality)
}

function nullableNumber(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
