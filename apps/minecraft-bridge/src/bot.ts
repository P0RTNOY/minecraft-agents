import mineflayer from 'mineflayer'
import { pathfinder } from 'mineflayer-pathfinder'
import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'

import { ActionArbiter } from './agent/actionArbiter.js'
import { cancelAgentAction } from './agent/cancelAction.js'
import { AutonomousAgentLoop } from './agent/loop.js'
import { createAgentState } from './agent/state.js'
import {
  loadBrainConfig,
  type BrainConfig
} from './brain/config.js'
import type { LLMProvider } from './brain/provider.js'
import { createLLMProvider } from './brain/providers/index.js'
import { registerChatCommands } from './commands/chatCommands.js'
import { formatPerception } from './perception/format.js'
import { perceive } from './perception/perceive.js'
import { followNearestPlayer } from './skills/index.js'
import { createDefaultDecisionExecutor } from './skills/execute.js'
import { ReflexLoop } from './survival/reflexLoop.js'
import {
  AgentMemoryCoordinator,
  type AgentMemory
} from './memory/coordinator.js'
import { MemoryEventRecorder } from './memory/recorder.js'
import { MemoryReflector } from './memory/reflection.js'
import { OpenAIReflectionProvider } from './memory/providers/openaiReflection.js'
import { AtomicJsonMemoryStore } from './memory/store.js'
import type { MemoryIdentity } from './memory/types.js'

const agentName = 'Alice'
const appDirectory = resolve(__dirname, '..')
const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: agentName,
  auth: 'offline'
})
const state = createAgentState(agentName)
const arbiter = new ActionArbiter()
const runtime = configureRuntime()
let autonomousLoop: AutonomousAgentLoop | null = null
let reflexLoop: ReflexLoop | null = null

bot.loadPlugin(pathfinder)
registerChatCommands(bot, state, { arbiter })

bot.once('spawn', () => {
  console.log(`✅ ${bot.username} spawned in Minecraft`)
  console.log(`📍 Position: ${bot.entity.position}`)
  bot.chat('Hello! I am Alice.')

  setTimeout(() => {
    console.log(formatPerception(perceive(bot)).join('\n'))
  }, 2000)

  if (runtime) {
    reflexLoop = new ReflexLoop({
      bot,
      state,
      arbiter,
      intervalMs: runtime.config.reflexIntervalMs
    })
    console.log(
      `⚡ Survival reflexes enabled (${runtime.config.reflexIntervalMs}ms)`
    )
    reflexLoop.start()
  }

  if (runtime?.provider) {
    const { config, provider, memory } = runtime
    setTimeout(() => {
      void memory.then(agentMemory => {
        autonomousLoop = new AutonomousAgentLoop({
          bot,
          state,
          arbiter,
          provider,
          intervalMs: config.tickIntervalMs,
          execute: createDefaultDecisionExecutor({
            explorationRadius: config.explorationRadius
          }),
          ...(agentMemory ? { memory: agentMemory } : {})
        })
        console.log(
          `🧠 Autonomous mode enabled with ${config.provider}/${config.model}`
        )
        autonomousLoop.start()
      })
    }, 4000)
  } else {
    setTimeout(() => {
      console.log(`\n👤 ${state.agentName} is looking for a nearby player...`)

      void arbiter.run({
        source: 'autonomous',
        cancel: () => cancelAgentAction(bot, state),
        execute: async () => followNearestPlayer(
          bot,
          state,
          'autonomous'
        )
      }).then(arbitration => {
        if (arbitration.status === 'rejected') {
          console.log('ℹ️ Nearby-player follow skipped for a priority action')
          return
        }

        const result = arbitration.value

        if (!result.success || !result.target) {
          console.log('❌ No nearby player found')
          return
        }

        console.log(`👀 Found player: ${result.target}`)
        bot.chat(`Hi ${result.target}! I'm following you.`)
        console.log(`🚶 ${state.agentName} is now following ${result.target}`)
      }).catch(error => {
        console.error('❌ Nearby-player follow failed:', error)
      })
    }, 4000)
  }
})

bot.once('health', () => {
  console.log(`❤️ Health: ${bot.health}`)
  console.log(`🍗 Food: ${bot.food}`)
})

bot.on('playerCollect', collector => {
  if (collector.id === bot.entity.id) {
    console.log(`📥 ${state.agentName} picked up an item`)
  }
})

bot.on('kicked', reason => {
  console.error(`❌ ${state.agentName} was kicked:`, reason)
})

bot.on('error', error => {
  console.error(`❌ ${state.agentName} error:`, error)
})

bot.on('end', () => {
  autonomousLoop?.stop()
  reflexLoop?.stop()
})

function configureRuntime(): {
  config: BrainConfig
  provider: LLMProvider | null
  memory: Promise<AgentMemory | null>
} | null {
  try {
    const config = loadBrainConfig()

    return {
      config,
      provider: config.autonomous ? createLLMProvider(config) : null,
      memory: config.autonomous && config.memoryEnabled
        ? initializeMemory(config)
        : Promise.resolve(null)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`❌ Agent runtime configuration disabled: ${message}`)
    return null
  }
}

async function initializeMemory(config: BrainConfig): Promise<AgentMemory | null> {
  const identity: MemoryIdentity = {
    agentId: agentName,
    worldId: config.memoryWorldId
  }
  const directory = isAbsolute(config.memoryDirectory)
    ? config.memoryDirectory
    : resolve(appDirectory, config.memoryDirectory)
  const store = new AtomicJsonMemoryStore({
    filePath: join(directory, memoryFileName(identity)),
    identity
  })
  try {
    await store.open()
    console.log(
      `🧠 Persistent memory enabled for ${identity.agentId}/${identity.worldId}`
    )
    let reflector: MemoryReflector | undefined
    if (config.memoryReflection) {
      try {
        reflector = new MemoryReflector({
          store,
          provider: new OpenAIReflectionProvider({
            baseUrl: config.openaiBaseUrl,
            apiKey: config.openaiApiKey,
            model: config.memoryReflectionModel
          })
        })
        console.log(
          `🧠 Optional memory reflection enabled with ${config.memoryReflectionModel}`
        )
      } catch {
        console.error(
          '❌ Optional memory reflection disabled: invalid provider configuration.'
        )
      }
    }
    return new AgentMemoryCoordinator({
      store,
      recorder: new MemoryEventRecorder({ identity }),
      identity,
      episodeLimit: config.memoryEpisodeLimit,
      factLimit: config.memoryFactLimit,
      debug: config.debugMemory,
      ...(reflector ? { reflector } : {})
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error.'
    console.error(`❌ Persistent memory disabled: ${message}`)
    return null
  }
}

function memoryFileName(identity: MemoryIdentity): string {
  const label = `${identity.agentId}-${identity.worldId}`
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 96)
  const digest = createHash('sha256')
    .update(`${identity.agentId}\0${identity.worldId}`)
    .digest('hex')
    .slice(0, 16)
  return `${label}-${digest}.json`
}
