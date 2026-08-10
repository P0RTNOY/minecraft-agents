import { createProductionComposition } from './runtime/composition.js'

async function main(): Promise<void> {
  const { manager } = await createProductionComposition()
  let shutdownStarted = false
  const shutdown = (signal: NodeJS.Signals) => {
    if (shutdownStarted) return
    shutdownStarted = true
    console.log(`🛑 Received ${signal}; stopping Minecraft agents.`)
    void manager.stopAll().then(summary => {
      for (const failure of summary.failures) {
        console.error(
          `❌ [${failure.agentId}/${failure.username}] shutdown failed: ${failure.error}`
        )
      }
      if (summary.failures.length > 0) process.exitCode = 1
    }).catch(() => {
      console.error('❌ Unexpected multi-agent shutdown failure.')
      process.exitCode = 1
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  const startup = await manager.startAll()
  for (const agentId of startup.started) {
    const identity = manager.snapshots().find(
      snapshot => snapshot.identity.agentId === agentId
    )?.identity
    console.log(
      `✅ [${identity?.agentId ?? agentId}/${identity?.username ?? 'unknown'}] started`
    )
  }
  for (const failure of startup.failures) {
    console.error(
      `❌ [${failure.agentId}/${failure.username}] startup failed: ${failure.error}`
    )
  }
  if (startup.started.length === 0) {
    await manager.stopAll()
    process.exitCode = 1
  }
}

void main().catch(error => {
  const message = error instanceof Error
    ? error.message.slice(0, 300)
    : 'Unknown startup error.'
  console.error(`❌ Minecraft agent process failed: ${message}`)
  process.exitCode = 1
})
