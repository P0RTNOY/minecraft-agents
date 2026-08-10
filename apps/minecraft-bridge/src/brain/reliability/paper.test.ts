import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BoundedLineBuffer } from './paper.js'

describe('BoundedLineBuffer', () => {
  it('keeps a reader cursor valid when old lines are evicted', () => {
    const buffer = new BoundedLineBuffer(3)
    buffer.append('line-0')
    buffer.append('line-1')
    buffer.append('line-2')

    const firstScan = buffer.scan(buffer.oldestCursor, line => line === 'marker')
    assert.equal(firstScan.matched, false)

    buffer.append('line-3')
    buffer.append('line-4')
    buffer.append('marker')
    buffer.append('line-6')

    const secondScan = buffer.scan(firstScan.cursor, line => line === 'marker')
    assert.equal(secondScan.matched, true)
  })
})
