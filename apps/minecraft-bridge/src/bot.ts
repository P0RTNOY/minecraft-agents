import mineflayer from 'mineflayer'
import { pathfinder } from 'mineflayer-pathfinder'

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

const agentName = 'Alice'
const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: agentName,
  auth: 'offline'
})
const state = createAgentState(agentName)
const autonomousRuntime = configureAutonomousRuntime()
let autonomousLoop: AutonomousAgentLoop | null = null

bot.loadPlugin(pathfinder)
registerChatCommands(bot, state)

bot.once('spawn', () => {
  console.log(`✅ ${bot.username} spawned in Minecraft`)
  console.log(`📍 Position: ${bot.entity.position}`)
  bot.chat('Hello! I am Alice.')

  setTimeout(() => {
    console.log(formatPerception(perceive(bot)).join('\n'))
  }, 2000)

  if (autonomousRuntime) {
    setTimeout(() => {
      const { config, provider } = autonomousRuntime
      autonomousLoop = new AutonomousAgentLoop({
        bot,
        state,
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

      const result = followNearestPlayer(bot, state)

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
})

function configureAutonomousRuntime(): {
  config: BrainConfig
  provider: LLMProvider
} | null {
  try {
    const config = loadBrainConfig()
    if (!config.autonomous) return null

    return {
      config,
      provider: createLLMProvider(config)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`❌ Autonomous mode disabled: ${message}`)
    return null
  }
}
