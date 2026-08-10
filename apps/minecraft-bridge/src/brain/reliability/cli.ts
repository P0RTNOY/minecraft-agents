import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import mineflayer, { type Bot } from 'mineflayer'
import { pathfinder } from 'mineflayer-pathfinder'

import { ActionArbiter } from '../../agent/actionArbiter.js'
import { cancelAgentAction } from '../../agent/cancelAction.js'
import { AutonomousAgentLoop } from '../../agent/loop.js'
import { createAgentState, type AgentState } from '../../agent/state.js'
import { loadBrainConfig } from '../config.js'
import { createLLMProvider } from '../providers/index.js'
import { perceive } from '../../perception/perceive.js'
import { createDefaultDecisionExecutor } from '../../skills/execute.js'
import { ReflexLoop } from '../../survival/reflexLoop.js'
import {
  AgentMemoryCoordinator,
  type AgentMemory
} from '../../memory/coordinator.js'
import { MemoryEventRecorder } from '../../memory/recorder.js'
import { MemoryReflector } from '../../memory/reflection.js'
import { OpenAIReflectionProvider } from '../../memory/providers/openaiReflection.js'
import { AtomicJsonMemoryStore } from '../../memory/store.js'
import type { MemoryIdentity } from '../../memory/types.js'
import {
  BOOTSTRAP_TEST_AREA,
  bootstrapPlatformCommands,
  bootstrapRunResetCommands,
  bootstrapWorldCleanupCommands,
  waitForBootstrapStartState
} from './environment.js'
import { PaperController } from './paper.js'
import { runBootstrapTrials } from './runner.js'
import { instrumentProvider } from './telemetry.js'

interface LiveContext {
  bot: Bot
  state: AgentState
  watchdogStart: number
  memory: AgentMemory | null
}

const runs = readPositiveInteger(process.env.BOOTSTRAP_RUNS, 5, 'BOOTSTRAP_RUNS')
const maxDecisions = readPositiveInteger(process.env.BOOTSTRAP_MAX_DECISIONS, 12, 'BOOTSTRAP_MAX_DECISIONS')
const timeoutMs = readPositiveInteger(process.env.BOOTSTRAP_TIMEOUT_MS, 150_000, 'BOOTSTRAP_TIMEOUT_MS')
const outputPath = process.env.BOOTSTRAP_OUTPUT?.trim()
const serverDirectory = resolve(process.env.MINECRAFT_SERVER_DIR?.trim() || '../../minecraft/server')
const config = loadBrainConfig({
  ...process.env,
  AGENT_AUTONOMOUS: 'true',
  LLM_PROVIDER: 'openai',
  LLM_MODEL: 'gpt-5-mini'
})
const paper = new PaperController(serverDirectory)
const contexts = new Map<string, LiveContext>()
let originalPosition: { x: number, y: number, z: number } | null = null

async function main(): Promise<void> {
  const experimentMemoryDirectory = await mkdtemp(
    join(tmpdir(), 'minecraft-agents-bootstrap-memory-')
  )
  try {
    await paper.start()
    await paper.runCommands(
      bootstrapPlatformCommands(),
      'bootstrap_platform_ready'
    )

    const result = await runBootstrapTrials({
    runs,
    provider: config.provider,
    model: config.model,
    maxDecisions,
    timeoutMs,
    prepare: async runId => {
      const bot = await connectAlice()
      const state = createAgentState('Alice')
      const context: LiveContext = {
        bot,
        state,
        watchdogStart: paper.watchdogCount,
        memory: null
      }
      contexts.set(runId, context)
      context.memory = config.memoryEnabled
        ? await createTrialMemory(runId, experimentMemoryDirectory)
        : null
      originalPosition ??= {
        x: bot.entity.position.x,
        y: bot.entity.position.y,
        z: bot.entity.position.z
      }
      const marker = `${runId}_prepared`
      const ready = waitForMessage(bot, marker)
      for (const command of bootstrapRunResetCommands()) paper.send(command)
      paper.send('clear Alice')
      paper.send('effect clear Alice')
      paper.send(`tp Alice 0.5 ${BOOTSTRAP_TEST_AREA.playerY} 0.5`)
      paper.send('give Alice oak_log 3')
      paper.send('effect give Alice instant_health 1 10 true')
      paper.send('effect give Alice saturation 1 10 true')
      paper.send(`tellraw Alice {"text":"${marker}"}`)
      await ready
      const startStateReady = await waitForBootstrapStartState(
        () => ({
          snapshot: perceive(bot),
          supportBlock: bot.blockAt(
            bot.entity.position.offset(0, -1, 0).floored()
          )?.name ?? null
        }),
        () => bot.waitForTicks(1)
      )
      if (!startStateReady) {
        throw new Error('Bootstrap start state verification failed.')
      }
    },
    createTrial: (runId, telemetry) => {
      const context = requireContext(runId)
      const memory = context.memory
      const provider = instrumentProvider(createLLMProvider(config), telemetry)
      const arbiter = new ActionArbiter()
      const loop = new AutonomousAgentLoop({
        bot: context.bot,
        state: context.state,
        arbiter,
        provider,
        intervalMs: config.tickIntervalMs,
        execute: createDefaultDecisionExecutor({ explorationRadius: config.explorationRadius }),
        ...(memory ? { memory } : {})
      })
      const reflexLoop = new ReflexLoop({
        bot: context.bot,
        state: context.state,
        arbiter,
        intervalMs: config.reflexIntervalMs
      })
      return {
        runCycle: async () => {
          const reflex = await reflexLoop.runCycle()
          if (reflex.status === 'executed') telemetry.recordReflex()
          return loop.runCycle()
        },
        observe: () => perceive(context.bot),
        infrastructureInvalid: () => paper.watchdogCount > context.watchdogStart,
        ...(memory
          ? { memoryMetrics: () => memory.metrics() }
          : {})
      }
    },
    cleanup: async runId => {
      const context = contexts.get(runId)
      if (!context) return
      cancelAgentAction(context.bot, context.state)
      const marker = `${runId}_cleaned`
      const cleaned = waitForMessage(context.bot, marker)
      paper.send('clear Alice')
      paper.send('effect clear Alice')
      if (originalPosition) {
        paper.send(`tp Alice ${originalPosition.x} ${originalPosition.y} ${originalPosition.z}`)
      }
      paper.send(`tellraw Alice {"text":"${marker}"}`)
      await cleaned
      await disconnect(context.bot)
      contexts.delete(runId)
    }
  })

    const serialized = `${JSON.stringify(result, null, 2)}\n`
    process.stdout.write(serialized)
    if (outputPath) await writeFile(resolve(outputPath), serialized, { mode: 0o600 })
  } finally {
    for (const context of contexts.values()) {
      await disconnect(context.bot)
    }
    contexts.clear()
    try {
      try {
        await paper.runCommands(
          bootstrapWorldCleanupCommands(),
          'bootstrap_cleanup_complete'
        )
      } finally {
        await paper.stop()
      }
    } finally {
      await rm(experimentMemoryDirectory, { recursive: true })
    }
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

async function connectAlice(): Promise<Bot> {
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'Alice', auth: 'offline' })
  bot.loadPlugin(pathfinder)
  await new Promise<void>((resolveSpawn, reject) => {
    bot.once('spawn', () => resolveSpawn())
    bot.once('error', reject)
  })
  return bot
}

function waitForMessage(bot: Bot, marker: string): Promise<void> {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${marker}.`)), 30_000)
    const listener = (message: string) => {
      if (!message.includes(marker)) return
      clearTimeout(timer)
      bot.off('messagestr', listener)
      resolveMessage()
    }
    bot.on('messagestr', listener)
  })
}

async function disconnect(bot: Bot): Promise<void> {
  const ended = new Promise<void>(resolveEnd => bot.once('end', () => resolveEnd()))
  bot.quit('bootstrap run complete')
  await ended
}

function requireContext(runId: string): LiveContext {
  const context = contexts.get(runId)
  if (!context) throw new Error(`Missing live context for ${runId}.`)
  return context
}

async function createTrialMemory(
  runId: string,
  directory: string
): Promise<AgentMemory> {
  const identity: MemoryIdentity = {
    agentId: 'Alice',
    worldId: `bootstrap-${runId}`
  }
  const store = new AtomicJsonMemoryStore({
    filePath: join(directory, `${runId}.json`),
    identity
  })
  await store.open()
  const reflector = config.memoryReflection
    ? new MemoryReflector({
        store,
        provider: new OpenAIReflectionProvider({
          baseUrl: config.openaiBaseUrl,
          apiKey: config.openaiApiKey,
          model: config.memoryReflectionModel
        })
      })
    : null
  return new AgentMemoryCoordinator({
    store,
    recorder: new MemoryEventRecorder({ identity }),
    identity,
    episodeLimit: config.memoryEpisodeLimit,
    factLimit: config.memoryFactLimit,
    debug: config.debugMemory,
    ...(reflector ? { reflector } : {})
  })
}

function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value?.trim() ? Number(value) : fallback
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`)
  return parsed
}
