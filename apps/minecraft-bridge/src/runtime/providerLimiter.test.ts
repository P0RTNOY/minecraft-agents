import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ProviderConcurrencyLimiter } from './providerLimiter.js'

describe('ProviderConcurrencyLimiter', () => {
  it('never exceeds the cap and starts queued calls in FIFO order', async () => {
    const limiter = new ProviderConcurrencyLimiter(2)
    const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()]
    const starts: number[] = []
    let active = 0
    let maximumActive = 0
    const calls = gates.map((gate, index) => limiter.run(async () => {
      starts.push(index + 1)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await gate.promise
      active -= 1
      return index + 1
    }))

    await turn()
    assert.deepEqual(starts, [1, 2])
    gates[0]?.resolve()
    await turn()
    assert.deepEqual(starts, [1, 2, 3])
    gates[1]?.resolve()
    await turn()
    assert.deepEqual(starts, [1, 2, 3, 4])
    gates[2]?.resolve()
    gates[3]?.resolve()

    assert.deepEqual(await Promise.all(calls), [1, 2, 3, 4])
    assert.equal(maximumActive, 2)
  })

  it('rejects an aborted queued call without invoking its task', async () => {
    const limiter = new ProviderConcurrencyLimiter(1)
    const active = deferred<void>()
    const first = limiter.run(() => active.promise)
    const controller = new AbortController()
    let invoked = false
    const queued = limiter.run(async () => {
      invoked = true
    }, controller.signal)

    controller.abort()
    await assert.rejects(queued, /aborted/i)
    assert.equal(invoked, false)
    active.resolve()
    await first
  })

  it('closes queued work while allowing active work to settle', async () => {
    const limiter = new ProviderConcurrencyLimiter(1)
    const active = deferred<string>()
    const first = limiter.run(() => active.promise)
    const queued = limiter.run(async () => 'queued')

    limiter.close()
    await assert.rejects(queued, /closed/i)
    active.resolve('active')
    assert.equal(await first, 'active')
    await assert.rejects(limiter.run(async () => 'late'), /closed/i)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function turn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}
