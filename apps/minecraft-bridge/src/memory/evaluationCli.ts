import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runMemoryEvaluation } from './evaluation.js'

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'minecraft-memory-evaluation-'))
  try {
    const result = await runMemoryEvaluation({ directory })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (result.summary.failed > 0) process.exitCode = 1
  } finally {
    await rm(directory, { recursive: true })
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Memory evaluation failed.')
  process.exitCode = 1
})
