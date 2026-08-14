import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CognitiveGate } from './cognitiveGate.js'

describe('CognitiveGate', () => {
  it('allows at most one deliberate provider call per agent', async () => {
    const gate = new CognitiveGate()
    const held = deferred<string>()
    const first = gate.runBrain(async () => held.promise)
    await turn()

    assert.deepEqual(await gate.runBrain(async () => 'second'), {
      status: 'suppressed',
      reason: 'busy'
    })
    held.resolve('first')
    assert.deepEqual(await first, { status: 'completed', value: 'first' })
  })

  it('suppresses Brain calls during a social session and invalidates an in-flight Brain', async () => {
    const gate = new CognitiveGate()
    const held = deferred<string>()
    const signals: AbortSignal[] = []
    const brain = gate.runBrain(async currentSignal => {
      signals.push(currentSignal)
      return held.promise
    })
    await turn()

    const generation = gate.beginSocialSession('conversation-1')
    assert.equal(signals[0]?.aborted, true)
    assert.deepEqual(await gate.runBrain(async () => 'late'), {
      status: 'suppressed',
      reason: 'social_session'
    })
    held.resolve('stale')
    assert.deepEqual(await brain, { status: 'stale' })

    assert.deepEqual(
      await gate.runSocial(generation, async () => 'hello'),
      { status: 'completed', value: 'hello' }
    )
    gate.endSocialSession('conversation-1')
    assert.deepEqual(await gate.runBrain(async () => 'resumed'), {
      status: 'completed', value: 'resumed'
    })
  })

  it('invalidates social work across manual/reflex changes and stop', async () => {
    for (const invalidate of ['manual', 'reflex'] as const) {
      const gate = new CognitiveGate()
      const generation = gate.beginSocialSession('conversation-1')
      const held = deferred<string>()
      const signals: AbortSignal[] = []
      const social = gate.runSocial(generation, async currentSignal => {
        signals.push(currentSignal)
        return held.promise
      })
      await turn()

      gate.invalidate(invalidate)
      assert.equal(signals[0]?.aborted, true)
      held.resolve('late')
      assert.deepEqual(await social, { status: 'stale' })
      assert.equal(gate.isCurrent('conversation-1', generation), false)
    }

    const stopped = new CognitiveGate()
    const generation = stopped.beginSocialSession('conversation-2')
    stopped.stop()
    assert.deepEqual(await stopped.runSocial(generation, async () => 'late'), {
      status: 'stale'
    })
    assert.deepEqual(await stopped.runBrain(async () => 'late'), {
      status: 'suppressed', reason: 'stopped'
    })
  })

  it('classifies an abort rejection after invalidation as stale', async () => {
    const gate = new CognitiveGate()
    const generation = gate.beginSocialSession('conversation-1')
    const social = gate.runSocial(generation, async signal => (
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true
        })
      })
    ))
    await turn()

    gate.invalidate('reflex')

    assert.deepEqual(await social, { status: 'stale' })
  })

  it('releases the gate promptly when invalidated work ignores abort', async () => {
    const gate = new CognitiveGate()
    const generation = gate.beginSocialSession('conversation-1')
    const never = new Promise<string>(() => {})
    const social = gate.runSocial(generation, async () => never)
    await turn()

    gate.invalidate('manual')

    assert.deepEqual(await Promise.race([
      social,
      new Promise(resolve => setTimeout(() => resolve('still-pending'), 20))
    ]), { status: 'stale' })
    assert.equal(gate.snapshot().busy, false)
  })

  it('releases the gate after provider failure without permanent busy state', async () => {
    const gate = new CognitiveGate()
    await assert.rejects(
      gate.runBrain(async () => { throw new Error('provider failed') }),
      /provider failed/
    )
    assert.deepEqual(await gate.runBrain(async () => 'recovered'), {
      status: 'completed', value: 'recovered'
    })
  })

  it('keeps gates independent for Alice and Bob', async () => {
    const alice = new CognitiveGate()
    const bob = new CognitiveGate()
    alice.beginSocialSession('conversation-1')

    assert.deepEqual(await alice.runBrain(async () => 'alice'), {
      status: 'suppressed', reason: 'social_session'
    })
    assert.deepEqual(await bob.runBrain(async () => 'bob'), {
      status: 'completed', value: 'bob'
    })
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

function turn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}
