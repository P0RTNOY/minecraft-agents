import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import type { Bot } from 'mineflayer'

import type { BrainConfig } from '../brain/config.js'
import type { LLMProvider } from '../brain/provider.js'
import type { AgentMemory, MemoryMetrics } from '../memory/coordinator.js'
import type { AgentDefinition } from './config.js'
import { AgentRuntime } from './agentRuntime.js'
import type {
  AgentRuntimeServices,
  RuntimeLoop,
  RuntimeScheduler,
  RuntimeTelemetry
} from './services.js'

describe('AgentRuntime', () => {
  it('owns independent state and arbitration for every agent', () => {
    const alice = harness({ id: 'alice', username: 'Alice' }).runtime
    const bob = harness({ id: 'bob', username: 'Bob' }).runtime

    assert.notEqual(alice.state, bob.state)
    assert.notEqual(alice.arbiter, bob.arbiter)
    assert.equal(alice.state.agentName, 'Alice')
    assert.equal(bob.state.agentName, 'Bob')
  })

  it('isolates arbitration generations and active execution locks', async () => {
    const alice = harness({ id: 'alice', username: 'Alice' }).runtime
    const bob = harness({ id: 'bob', username: 'Bob' }).runtime
    const aliceAction = deferred<void>()
    const aliceRun = alice.arbiter.run({
      source: 'autonomous',
      cancel() {},
      execute: () => aliceAction.promise
    })

    alice.arbiter.interrupt('manual')
    assert.equal(bob.arbiter.captureGeneration(), 0)
    assert.deepEqual(await bob.arbiter.run({
      source: 'autonomous',
      cancel() {},
      execute: async () => 'bob-executed'
    }), { status: 'executed', value: 'bob-executed' })

    aliceAction.resolve()
    await aliceRun
  })

  it('starts in dependency order and staggers only the Brain loop', async () => {
    const setup = harness({ id: 'bob', username: 'Bob' }, 2_000)

    await setup.runtime.start()

    assert.deepEqual(setup.events, [
      'memory:create:bob',
      'provider:create:bob',
      'bot:create:Bob',
      'timer:set:30000',
      'timer:clear:1',
      'commands:register',
      'reflex:create',
      'brain:create',
      'reflex:start',
      'timer:set:2000'
    ])
    assert.equal(setup.runtime.snapshot().phase, 'running')
    assert.deepEqual(
      setup.runtime.snapshot().visibleExternalPlayers,
      ['ExternalPlayer']
    )
    assert.equal(setup.brain.starts, 0)

    setup.scheduler.fire(2)
    assert.equal(setup.brain.starts, 1)
  })

  it('stops timers, queued work, actions, loops, memory, telemetry, and bot once', async () => {
    const setup = harness({ id: 'alice', username: 'Alice' }, 1_000)
    await setup.runtime.start()
    setup.events.length = 0

    await Promise.all([setup.runtime.stop(), setup.runtime.stop()])

    assert.deepEqual(setup.events, [
      'commands:remove',
      'timer:clear:2',
      'brain:stop',
      'reflex:stop',
      'provider:abort',
      'action:cancel',
      'brain:idle',
      'reflex:idle',
      'telemetry:memory',
      'memory:flush',
      'telemetry:flush',
      'bot:quit:agent runtime stopped'
    ])
    assert.equal(setup.runtime.snapshot().phase, 'stopped')
  })

  it('removes command listeners before waiting for active loops to drain', async () => {
    const brainIdleGate = deferred<void>()
    const setup = harness(
      { id: 'alice', username: 'Alice' },
      0,
      {
        brainIdleGate: brainIdleGate.promise,
        commandProbe: true
      }
    )
    await setup.runtime.start()
    setup.events.length = 0

    const stopping = setup.runtime.stop()
    assert.equal(setup.runtime.snapshot().phase, 'stopping')
    assert.equal(setup.events.includes('brain:idle'), true)

    setup.bot.emit('test-command')
    assert.equal(setup.events.includes('command:executed'), false)

    brainIdleGate.resolve()
    await stopping
  })

  it('fails one agent before connection when its memory cannot open', async () => {
    const setup = harness(
      { id: 'charlie', username: 'Charlie' },
      0,
      { memoryFailure: new Error('Charlie memory is malformed.') }
    )

    await assert.rejects(
      setup.runtime.start(),
      /Charlie memory is malformed/
    )
    assert.equal(setup.events.includes('bot:create:Charlie'), false)
    assert.equal(setup.runtime.snapshot().phase, 'stopped')
  })

  it('bounds connection startup and cleans up a bot that never spawns', async () => {
    const setup = harness(
      { id: 'bob', username: 'Bob' },
      0,
      { autoSpawn: false }
    )

    const starting = setup.runtime.start()
    await Promise.resolve()
    setup.scheduler.fire(1)

    await assert.rejects(starting, /spawn timed out after 30000 ms/)
    assert.equal(
      setup.events.includes('bot:quit:agent runtime stopped'),
      true
    )
    assert.equal(setup.runtime.snapshot().phase, 'stopped')
  })

  it('waits for pending startup acquisition before completing shutdown', async () => {
    const memoryGate = deferred<void>()
    const setup = harness(
      { id: 'charlie', username: 'Charlie' },
      0,
      { memoryGate: memoryGate.promise }
    )

    const starting = setup.runtime.start()
    await Promise.resolve()
    const stopping = setup.runtime.stop()
    memoryGate.resolve()

    await assert.rejects(starting, /stopped during startup/)
    await stopping
    assert.equal(setup.events.includes('bot:create:Charlie'), false)
    assert.equal(setup.events.includes('memory:flush'), true)
    assert.equal(setup.runtime.snapshot().phase, 'stopped')
  })

  it('flushes agent-local resources after an unexpected disconnect', async () => {
    const setup = harness({ id: 'bob', username: 'Bob' }, 1_000)
    await setup.runtime.start()
    setup.events.length = 0

    setup.bot.emit('end')
    await setup.runtime.stop()

    assert.equal(setup.events[0], 'telemetry:disconnect')
    assert.equal(setup.events.includes('memory:flush'), true)
    assert.equal(setup.events.includes('telemetry:flush'), true)
    assert.equal(setup.runtime.snapshot().phase, 'stopped')
  })
})

function harness(
  definition: AgentDefinition,
  brainStartDelayMs = 0,
  options: {
    memoryFailure?: Error
    memoryGate?: Promise<void>
    autoSpawn?: boolean
    brainIdleGate?: Promise<void>
    commandProbe?: boolean
  } = {}
) {
  const events: string[] = []
  const scheduler = new ManualScheduler(events)
  const bot = createBot(events)
  const brain = new LoopDouble('brain', events, options.brainIdleGate)
  const reflex = new LoopDouble('reflex', events)
  const memory = memoryDouble(events)
  const telemetry = telemetryDouble(events, definition)
  const provider: LLMProvider = {
    decide: async () => ({ action: 'idle', reason: 'Wait.' })
  }
  const services: AgentRuntimeServices = {
    createMemory: async context => {
      events.push(`memory:create:${context.identity.agentId}`)
      if (options.memoryFailure) throw options.memoryFailure
      if (options.memoryGate) await options.memoryGate
      return memory
    },
    createProvider: context => {
      events.push(`provider:create:${context.identity.agentId}`)
      context.signal.addEventListener('abort', () => {
        events.push('provider:abort')
      }, { once: true })
      return provider
    },
    createBot: connection => {
      events.push(`bot:create:${connection.username}`)
      if (options.autoSpawn !== false) queueMicrotask(() => bot.emit('spawn'))
      return bot as Bot
    },
    createBrainLoop: context => {
      assert.equal(context.state.agentName, definition.username)
      events.push('brain:create')
      return brain
    },
    createReflexLoop: context => {
      assert.equal(context.state.agentName, definition.username)
      events.push('reflex:create')
      return reflex
    },
    registerCommands: () => {
      events.push('commands:register')
      const onTestCommand = () => events.push('command:executed')
      if (options.commandProbe) bot.on('test-command', onTestCommand)
      return () => {
        events.push('commands:remove')
        if (options.commandProbe) bot.off('test-command', onTestCommand)
      }
    },
    observeVisibleExternalPlayers: () => ['ExternalPlayer'],
    cancelAction: () => events.push('action:cancel'),
    createTelemetry: () => telemetry,
    scheduler,
    now: () => 1_000,
    logger: { log() {}, error() {} }
  }
  const runtime = new AgentRuntime({
    definition,
    brainConfig: brainConfig(),
    minecraft: {
      host: 'localhost',
      port: 25_565,
      spawnTimeoutMs: 30_000
    },
    brainStartDelayMs,
    services
  })
  return { runtime, events, scheduler, brain, reflex, bot }
}

class LoopDouble implements RuntimeLoop {
  starts = 0

  constructor(
    private readonly name: string,
    private readonly events: string[],
    private readonly idleGate?: Promise<void>
  ) {}

  start(): void {
    this.starts += 1
    this.events.push(`${this.name}:start`)
  }

  stop(): void {
    this.events.push(`${this.name}:stop`)
  }

  async waitForIdle(): Promise<void> {
    this.events.push(`${this.name}:idle`)
    await this.idleGate
  }
}

class ManualScheduler implements RuntimeScheduler {
  private sequence = 0
  private readonly callbacks = new Map<number, () => void>()

  constructor(private readonly events: string[]) {}

  setTimeout(callback: () => void, delayMs: number): number {
    const handle = ++this.sequence
    this.callbacks.set(handle, callback)
    this.events.push(`timer:set:${delayMs}`)
    return handle
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as number)
    this.events.push(`timer:clear:${String(handle)}`)
  }

  fire(handle: number): void {
    const callback = this.callbacks.get(handle)
    assert.ok(callback, `Missing timer ${handle}.`)
    this.callbacks.delete(handle)
    callback()
  }
}

function createBot(events: string[]): EventEmitter & Partial<Bot> {
  const bot = new EventEmitter() as EventEmitter & Partial<Bot>
  bot.username = 'pending'
  bot.quit = reason => events.push(`bot:quit:${reason ?? ''}`)
  return bot
}

function memoryDouble(events: string[]): AgentMemory {
  return {
    retrieve: async () => ({
      context: { recentEpisodes: [], relevantFacts: [] }
    }),
    record: async () => ({ episodesCreated: 0, semanticFactsCreated: 0 }),
    flush: async () => { events.push('memory:flush') },
    metrics: emptyMemoryMetrics
  }
}

function telemetryDouble(
  events: string[],
  definition: AgentDefinition
): RuntimeTelemetry {
  return {
    recordProviderCall() {},
    recordSpawn() {},
    recordDisconnect: () => { events.push('telemetry:disconnect') },
    recordError() {},
    recordKick() {},
    recordMemory: () => { events.push('telemetry:memory') },
    flush: async () => { events.push('telemetry:flush') },
    snapshot: () => ({
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
      memory: null
    })
  }
}

function emptyMemoryMetrics(): MemoryMetrics {
  return {
    episodesCreated: 0,
    episodesRetrieved: 0,
    semanticFactsCreated: 0,
    semanticFactsRetrieved: 0,
    retrievalFailures: 0,
    persistenceFailures: 0,
    reflectionCalls: 0,
    reflectionFailures: 0,
    reflectionInputTokens: 0,
    reflectionOutputTokens: 0,
    estimatedMemoryPromptTokens: 0
  }
}

function brainConfig(): BrainConfig {
  return {
    autonomous: true,
    tickIntervalMs: 5_000,
    reflexIntervalMs: 250,
    explorationRadius: 24,
    provider: 'openai',
    model: 'gpt-5-mini',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    groqBaseUrl: 'https://api.groq.com/openai/v1',
    groqApiKey: '',
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiApiKey: 'presence-only-test-value',
    debugTiming: false,
    memoryEnabled: true,
    memoryWorldId: 'local-paper',
    memoryDirectory: 'data/memory',
    memoryEpisodeLimit: 4,
    memoryFactLimit: 4,
    debugMemory: false,
    memoryReflection: false,
    memoryReflectionModel: 'gpt-5-mini'
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}
