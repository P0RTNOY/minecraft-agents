import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ActionArbiter } from './actionArbiter.js'

describe('ActionArbiter', () => {
  it('lets a reflex cancel and replace an active autonomous action serially', async () => {
    const arbiter = new ActionArbiter()
    const autonomousDone = deferred<void>()
    let activeExecutions = 0
    let maximumExecutions = 0
    let cancellations = 0

    const autonomous = arbiter.run({
      source: 'autonomous',
      execute: async () => {
        activeExecutions += 1
        maximumExecutions = Math.max(maximumExecutions, activeExecutions)
        await autonomousDone.promise
        activeExecutions -= 1
        return 'brain'
      },
      cancel: () => {
        cancellations += 1
        autonomousDone.resolve()
      }
    })
    const reflex = arbiter.run({
      source: 'reflex',
      execute: async () => {
        activeExecutions += 1
        maximumExecutions = Math.max(maximumExecutions, activeExecutions)
        activeExecutions -= 1
        return 'flee'
      },
      cancel: () => {}
    })

    assert.deepEqual(await autonomous, {
      status: 'executed',
      value: 'brain'
    })
    assert.deepEqual(await reflex, {
      status: 'executed',
      value: 'flee'
    })
    assert.equal(cancellations, 1)
    assert.equal(maximumExecutions, 1)
  })

  it('does not let lower or equal priority replace an active action', async () => {
    const arbiter = new ActionArbiter()
    const manualDone = deferred<void>()
    const manual = arbiter.run({
      source: 'manual',
      execute: async () => {
        await manualDone.promise
        return 'manual'
      },
      cancel: () => assert.fail('manual action must not be cancelled')
    })
    let executions = 0

    const reflex = await arbiter.run({
      source: 'reflex',
      execute: async () => {
        executions += 1
      },
      cancel: () => {}
    })
    const secondManual = await arbiter.run({
      source: 'manual',
      execute: async () => {
        executions += 1
      },
      cancel: () => {}
    })

    assert.deepEqual(reflex, {
      status: 'rejected',
      reason: 'priority_blocked'
    })
    assert.deepEqual(secondManual, {
      status: 'rejected',
      reason: 'priority_blocked'
    })
    assert.equal(executions, 0)
    manualDone.resolve()
    await manual
  })

  it('lets a manual request supersede a reflex waiting on cancellation', async () => {
    const arbiter = new ActionArbiter()
    const autonomousDone = deferred<void>()
    let reflexExecuted = false
    let manualExecuted = false
    const autonomous = arbiter.run({
      source: 'autonomous',
      execute: async () => {
        await autonomousDone.promise
      },
      cancel: () => {}
    })
    const reflex = arbiter.run({
      source: 'reflex',
      execute: async () => {
        reflexExecuted = true
      },
      cancel: () => {}
    })
    const manual = arbiter.run({
      source: 'manual',
      execute: async () => {
        manualExecuted = true
      },
      cancel: () => {}
    })

    autonomousDone.resolve()

    assert.deepEqual(await reflex, {
      status: 'rejected',
      reason: 'superseded'
    })
    assert.deepEqual(await manual, {
      status: 'executed',
      value: undefined
    })
    assert.equal(reflexExecuted, false)
    assert.equal(manualExecuted, true)
    await autonomous
  })

  it('rejects a stale autonomous generation after a reflex interrupt', async () => {
    const arbiter = new ActionArbiter()
    const generation = arbiter.captureGeneration()
    let executed = false

    arbiter.interrupt('reflex')
    const result = await arbiter.run({
      source: 'autonomous',
      expectedGeneration: generation,
      execute: async () => {
        executed = true
      },
      cancel: () => {}
    })

    assert.deepEqual(result, {
      status: 'rejected',
      reason: 'stale'
    })
    assert.equal(executed, false)
  })
})

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve
  })

  return { promise, resolve: resolvePromise }
}
