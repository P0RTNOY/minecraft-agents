import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AgentDefinition } from './config.js'
import {
  AgentManager,
  type ManagedAgentRuntime
} from './agentManager.js'
import { createEmptySocialTelemetry } from './telemetry.js'

describe('AgentManager', () => {
  it('continues Alice and Charlie when Bob startup fails', async () => {
    const stopOrder: string[] = []
    const manager = new AgentManager({
      definitions: definitions(),
      createRuntime: definition => runtimeDouble(definition, stopOrder, {
        startFailure: definition.id === 'bob'
          ? new Error('connect failed')
          : undefined
      })
    })

    assert.deepEqual(await manager.startAll(), {
      started: ['alice', 'charlie'],
      failures: [{
        agentId: 'bob',
        username: 'Bob',
        error: 'connect failed'
      }]
    })
    assert.deepEqual(manager.snapshots().map(item => item.identity.agentId), [
      'alice',
      'charlie'
    ])

    assert.deepEqual(await manager.stopAll(), {
      stopped: ['charlie', 'alice'],
      failures: []
    })
    assert.deepEqual(stopOrder, ['charlie', 'alice'])
  })

  it('stops every runtime and shared service once while reporting all failures', async () => {
    const stopOrder: string[] = []
    let sharedStops = 0
    const manager = new AgentManager({
      definitions: definitions().slice(0, 2),
      createRuntime: definition => runtimeDouble(definition, stopOrder, {
        stopFailure: new Error(`${definition.id} stop failed`)
      }),
      closeShared: async () => {
        sharedStops += 1
        throw new Error('limiter close failed')
      }
    })
    await manager.startAll()

    const [first, second] = await Promise.all([
      manager.stopAll(),
      manager.stopAll()
    ])

    assert.deepEqual(first, second)
    assert.deepEqual(first, {
      stopped: [],
      failures: [{
        agentId: 'bob',
        username: 'Bob',
        error: 'bob stop failed'
      }, {
        agentId: 'alice',
        username: 'Alice',
        error: 'alice stop failed'
      }, {
        agentId: 'shared',
        username: 'shared',
        error: 'limiter close failed'
      }]
    })
    assert.deepEqual(stopOrder, ['bob', 'alice'])
    assert.equal(sharedStops, 1)
  })

  it('prepares shared services once before any runtime begins stopping', async () => {
    const events: string[] = []
    const manager = new AgentManager({
      definitions: definitions().slice(0, 2),
      createRuntime: definition => runtimeDouble(definition, events),
      prepareSharedStop: () => { events.push('shared:prepare') },
      closeShared: () => { events.push('shared:close') }
    })
    await manager.startAll()

    await Promise.all([manager.stopAll(), manager.stopAll()])

    assert.deepEqual(events, [
      'shared:prepare',
      'bob',
      'alice',
      'shared:close'
    ])
  })

  it('reports prepare-stop failure while still draining runtimes and shared close', async () => {
    const events: string[] = []
    const manager = new AgentManager({
      definitions: definitions().slice(0, 1),
      createRuntime: definition => runtimeDouble(definition, events),
      prepareSharedStop: () => { throw new Error('prepare failed') },
      closeShared: () => { events.push('shared:close') }
    })
    await manager.startAll()

    const result = await manager.stopAll()

    assert.deepEqual(events, ['alice', 'shared:close'])
    assert.equal(result.failures[0]?.error, 'prepare failed')
  })

  it('rejects duplicate identities before constructing any runtime', () => {
    let constructions = 0

    assert.throws(() => new AgentManager({
      definitions: [
        { id: 'alice', username: 'Alice' },
        { id: 'alice', username: 'OtherAlice' }
      ],
      createRuntime: definition => {
        constructions += 1
        return runtimeDouble(definition, [])
      }
    }), /duplicate agent id/i)
    assert.equal(constructions, 0)
  })

  it('cancels the currently starting runtime before reverse shutdown', async () => {
    const events: string[] = []
    const bobStarted = deferred<void>()
    const manager = new AgentManager({
      definitions: definitions().slice(0, 2),
      createRuntime: definition => definition.id === 'alice'
        ? runtimeDouble(definition, events)
        : {
            ...runtimeDouble(definition, events),
            start: () => bobStarted.promise,
            async stop() {
              events.push('bob')
              bobStarted.reject(new Error('stopped during startup'))
            }
          }
    })
    const starting = manager.startAll()
    await Promise.resolve()

    const stopped = await manager.stopAll()

    assert.deepEqual((await starting).started, ['alice'])
    assert.deepEqual(stopped, { stopped: ['alice'], failures: [] })
    assert.deepEqual(events, ['bob', 'alice'])
  })
})

function definitions(): AgentDefinition[] {
  return [
    { id: 'alice', username: 'Alice' },
    { id: 'bob', username: 'Bob' },
    { id: 'charlie', username: 'Charlie' }
  ]
}

function runtimeDouble(
  definition: AgentDefinition,
  stopOrder: string[],
  options: { startFailure?: Error; stopFailure?: Error } = {}
): ManagedAgentRuntime {
  return {
    identity: { agentId: definition.id, username: definition.username },
    async start() {
      if (options.startFailure) throw options.startFailure
    },
    async stop() {
      stopOrder.push(definition.id)
      if (options.stopFailure) throw options.stopFailure
    },
    snapshot: () => ({
      identity: { agentId: definition.id, username: definition.username },
      phase: 'running',
      startedAt: 1,
      stoppedAt: null,
      visibleExternalPlayers: [],
      state: {
        agentName: definition.username,
        status: 'idle',
        currentAction: null,
        currentGoal: null,
        actionSource: null,
        busy: false,
        actionVersion: 0,
        manualOverrideVersion: 0
      },
      telemetry: {
        agentId: definition.id,
        username: definition.username,
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
        social: createEmptySocialTelemetry()
      }
    })
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (error: Error) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}
