import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { runMemoryEvaluation } from './evaluation.js'

describe('runMemoryEvaluation', () => {
  it('passes deterministic retrieval, conflict, restart, and containment cases', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'memory-evaluation-test-'))
    try {
      const result = await runMemoryEvaluation({ directory })

      assert.deepEqual(result.summary, { passed: 5, failed: 0, total: 5 })
      assert.deepEqual(result.cases.map(item => item.id), [
        'discovery_retrieval',
        'failure_relevance',
        'historical_table_conflict',
        'restart_persistence',
        'injection_containment'
      ])
      assert.equal(
        result.cases.find(item => item.id === 'restart_persistence')?.passed,
        true
      )
      assert.equal(result.cases.every(item => item.details.length <= 160), true)
    } finally {
      await rm(directory, { recursive: true })
    }
  })
})
