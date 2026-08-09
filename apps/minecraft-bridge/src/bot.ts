import mineflayer from 'mineflayer'
import { goals, pathfinder, Movements } from 'mineflayer-pathfinder'

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'Alice',
  auth: 'offline'
})

bot.loadPlugin(pathfinder)

bot.once('spawn', async () => {
  console.log(`✅ ${bot.username} spawned in Minecraft`)
  console.log(`📍 Position: ${bot.entity.position}`)

  bot.chat('Hello! I am Alice.')

  setTimeout(() => {
    scanEnvironment()
  }, 2000)

  setTimeout(() => {
    followNearestPlayer()
  }, 4000)
})
function followNearestPlayer() {
  console.log('\n👤 Alice is looking for a nearby player...')

  const player = bot.nearestEntity(entity =>
    entity.type === 'player' &&
    entity.username !== bot.username
  )

  if (!player) {
    console.log('❌ No nearby player found')
    return
  }

  console.log(
    `👀 Found player: ${player.username} at ${player.position}`
  )

  const movements = new Movements(bot)

  bot.pathfinder.setMovements(movements)

  bot.chat(`Hi ${player.username}! I'm following you.`)

  bot.pathfinder.setGoal(
    new goals.GoalFollow(player, 2),
    true
  )

  console.log(`🚶 Alice is now following ${player.username}`)
}
bot.once('health', () => {
  console.log(`❤️ Health: ${bot.health}`)
  console.log(`🍗 Food: ${bot.food}`)
})

function scanEnvironment() {
  console.log('\n===== 👁️ ALICE PERCEPTION =====')

  console.log(`📍 Position: ${bot.entity.position}`)
  console.log(`❤️ Health: ${bot.health}`)
  console.log(`🍗 Food: ${bot.food}`)

  const nearbyBlocks = bot.findBlocks({
    matching: () => true,
    maxDistance: 8,
    count: 20
  })

  console.log('\n🧱 Nearby blocks:')

  for (const position of nearbyBlocks) {
    const block = bot.blockAt(position)

    if (!block || block.name === 'air') {
      continue
    }

    const distance = bot.entity.position.distanceTo(position)

    console.log(
      `- ${block.name} | distance: ${distance.toFixed(1)} | ${position}`
    )
  }

  console.log('\n🎒 Inventory:')
  printInventory()

  console.log('===============================\n')
}

function printInventory() {
  const items = bot.inventory.items()

  if (items.length === 0) {
    console.log('- Empty')
    return
  }

  for (const item of items) {
    console.log(`- ${item.name} x${item.count}`)
  }
}

async function collectBlock(blockName: string) {
  console.log(`\n⛏️ Alice wants to collect: ${blockName}`)

  const target = bot.findBlock({
    matching: block => block.name === blockName,
    maxDistance: 32
  })

  if (!target) {
    console.log(`❌ Could not find ${blockName}`)
    return
  }

  console.log(`🎯 Found ${blockName} at ${target.position}`)

  const movements = new Movements(bot)
  bot.pathfinder.setMovements(movements)

  try {
    await bot.pathfinder.goto(
      new goals.GoalNear(
        target.position.x,
        target.position.y,
        target.position.z,
        2
      )
    )

    console.log(`🚶 Reached ${blockName}`)

    const block = bot.blockAt(target.position)

    if (!block) {
      console.log('❌ Target block disappeared')
      return
    }

    if (!bot.canDigBlock(block)) {
      console.log(`❌ ${blockName} cannot be dug from here`)
      return
    }

    console.log(`⛏️ Digging ${blockName}...`)

    await bot.dig(block)

    console.log(`✅ Broke ${blockName}`)

    // Wait briefly for the dropped item entity to appear.
    await new Promise(resolve => setTimeout(resolve, 300))

    const droppedItem = bot.nearestEntity(entity => {
      return (
        entity.name === 'item' &&
        bot.entity.position.distanceTo(entity.position) <= 10
      )
    })

    if (!droppedItem) {
      console.log('⚠️ No dropped item found nearby')

      console.log('\n🎒 Inventory:')
      printInventory()

      return
    }

    console.log(
      `📦 Dropped item detected at ${droppedItem.position}`
    )

    console.log('🚶 Moving to collect dropped item...')

    await bot.pathfinder.goto(
      new goals.GoalFollow(droppedItem, 0)
    )

    // Give the server a moment to process the pickup.
    await new Promise(resolve => setTimeout(resolve, 500))

    console.log('✅ Pickup attempt complete')

    console.log('\n🎒 Inventory after collection:')
    printInventory()

  } catch (error) {
    console.error(`❌ Failed to collect ${blockName}:`, error)
  }
}

bot.on('playerCollect', (collector) => {
  if (collector.id === bot.entity.id) {
    console.log('📥 Alice picked up an item')
  }
})

bot.on('kicked', reason => {
  console.error('❌ Alice was kicked:', reason)
})

bot.on('error', error => {
  console.error('❌ Alice error:', error)
})

bot.on('chat', async (username, message) => {
  if (username === bot.username) {
    return
  }

  console.log(`💬 ${username}: ${message}`)

  const command = message.trim().toLowerCase()

  if (command === 'alice come') {
    const player = bot.players[username]?.entity

    if (!player) {
      bot.chat(`I can't see you, ${username}.`)
      return
    }

    const movements = new Movements(bot)
    bot.pathfinder.setMovements(movements)

    bot.chat(`Coming, ${username}!`)

    try {
      await bot.pathfinder.goto(
        new goals.GoalNear(
          player.position.x,
          player.position.y,
          player.position.z,
          2
        )
      )
    } catch (error) {
      console.error('❌ Failed to reach player:', error)
      bot.chat("I couldn't reach you.")
    }

    return
  }

  if (command === 'alice follow') {
    const player = bot.players[username]?.entity

    if (!player) {
      bot.chat(`I can't see you, ${username}.`)
      return
    }

    const movements = new Movements(bot)
    bot.pathfinder.setMovements(movements)

    bot.pathfinder.setGoal(
      new goals.GoalFollow(player, 2),
      true
    )

    bot.chat(`I'm following you, ${username}.`)
    return
  }

  if (command === 'alice stop') {
    bot.pathfinder.setGoal(null)

    bot.chat('Stopped.')
    return
  }

  if (command === 'alice scan') {
    scanEnvironment()

    bot.chat('I scanned the area.')
    return
  }

  if (command === 'alice inventory') {
    console.log('\n🎒 INVENTORY REQUEST')
    printInventory()

    bot.chat(`I have ${bot.inventory.items().length} item stack(s).`)
  }
})