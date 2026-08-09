import mineflayer from 'mineflayer'
import { pathfinder } from 'mineflayer-pathfinder'

import { createAgentState } from './agent/state.js'
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

bot.loadPlugin(pathfinder)
registerChatCommands(bot, state)

bot.once('spawn', () => {
  console.log(`✅ ${bot.username} spawned in Minecraft`)
  console.log(`📍 Position: ${bot.entity.position}`)
  bot.chat('Hello! I am Alice.')

  setTimeout(() => {
    console.log(formatPerception(perceive(bot)).join('\n'))
  }, 2000)

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
