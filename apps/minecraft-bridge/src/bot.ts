import mineflayer from 'mineflayer'
import { pathfinder } from 'mineflayer-pathfinder'

import { ActionArbiter } from './agent/actionArbiter.js'
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
import { ReflexLoop } from './survival/reflexLoop.js'

const agentName = 'Alice'
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
registerChatCommands(bot, state, arbiter)

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
    const { config, provider } = runtime
    setTimeout(() => {
      autonomousLoop = new AutonomousAgentLoop({
        bot,
        state,
        arbiter,
        provider,
        intervalMs: config.tickIntervalMs
      })
      console.log(
        `🧠 Autonomous mode enabled with ${config.provider}/${config.model}`
      )
      autonomousLoop.start()
    }, 4000)
  } else {
    setTimeout(() => {
      console.log(`\n👤 ${state.agentName} is looking for a nearby player...`)

      const result = followNearestPlayer(bot, state, 'autonomous')

      if (!result.success || !result.target) {
        console.log('❌ No nearby player found')
        return
      }

      console.log(`👀 Found player: ${result.target}`)
      bot.chat(`Hi ${result.target}! I'm following you.`)
      console.log(`🚶 ${state.agentName} is now following ${result.target}`)
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
} | null {
  try {
    const config = loadBrainConfig()

    return {
      config,
      provider: config.autonomous ? createLLMProvider(config) : null
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`❌ Agent runtime configuration disabled: ${message}`)
    return null
  }
}
