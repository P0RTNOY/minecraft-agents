import { resolve } from 'node:path'

import { createProductionComposition } from './composition.js'
import type { AgentRuntimeSnapshot } from './agentRuntime.js'
import {
  createMultiAgentValidationReport,
  readValidationSessionMs,
  resolveValidationOutputPath,
  type ValidationTermination,
  writeMultiAgentValidationReport
} from './validation.js'

async function main(): Promise<void> {
  const appDirectory = resolve(__dirname, '../..')
  const sessionMs = readValidationSessionMs(
    process.env.MULTI_AGENT_SESSION_MS
  )
  const outputPath = resolveValidationOutputPath(
    process.env.MULTI_AGENT_OUTPUT,
    process.cwd(),
    appDirectory
  )
  const composition = await createProductionComposition(process.env)
  requireValidationProfile(composition)
  const sessionStartedAt = Date.now()
  const startup = await composition.manager.startAll()
  let termination: ValidationTermination = 'duration'
  let liveSnapshots: AgentRuntimeSnapshot[] = []
  let shutdown
  try {
    if (startup.started.length > 0) {
      termination = await waitForTermination(sessionMs)
    }
    liveSnapshots = composition.manager.snapshots()
  } finally {
    shutdown = await composition.manager.stopAll()
  }

  const stoppedSnapshots = composition.manager.snapshots()
  const liveVisibility = new Map(
    liveSnapshots.map(snapshot => [
      snapshot.identity.agentId,
      snapshot.visibleExternalPlayers
    ])
  )
  const snapshots = stoppedSnapshots.map(snapshot => ({
    ...snapshot,
    visibleExternalPlayers: [
      ...(liveVisibility.get(snapshot.identity.agentId) ??
        snapshot.visibleExternalPlayers)
    ]
  }))
  const report = createMultiAgentValidationReport({
    sessionStartedAt,
    sessionEndedAt: Date.now(),
    termination,
    requestedAgents: composition.agentConfiguration.agents.map(agent => ({
      agentId: agent.id,
      username: agent.username
    })),
    startup,
    shutdown,
    snapshots
  })
  await writeMultiAgentValidationReport(outputPath, report)
  console.log(
    `Multi-agent validation complete: ${report.startup.startedAgentIds.length}` +
    `/${report.startup.requestedAgentIds.length} agents, ` +
    `${report.aggregate.providerCalls} provider calls, report ${outputPath}`
  )
  if (
    startup.failures.length > 0 ||
    shutdown.failures.length > 0 ||
    startup.started.length !== composition.agentConfiguration.agents.length
  ) process.exitCode = 1
}

function requireValidationProfile(
  composition: Awaited<ReturnType<typeof createProductionComposition>>
): void {
  const config = composition.brainConfig
  if (!config.autonomous) {
    throw new Error('Multi-agent validation requires AGENT_AUTONOMOUS=true.')
  }
  if (config.provider !== 'openai' || config.model !== 'gpt-5-mini') {
    throw new Error(
      'Multi-agent validation requires LLM_PROVIDER=openai and LLM_MODEL=gpt-5-mini.'
    )
  }
  if (!config.memoryEnabled || config.memoryReflection) {
    throw new Error(
      'Multi-agent validation requires memory enabled and reflection disabled.'
    )
  }
  const incompatible = composition.agentConfiguration.agents.find(agent => (
    agent.autonomous === false || agent.memoryEnabled === false
  ))
  if (incompatible) {
    throw new Error(
      `Agent ${incompatible.id} disables the required validation profile.`
    )
  }
}

function waitForTermination(
  durationMs: number
): Promise<ValidationTermination> {
  return new Promise(resolvePromise => {
    let settled = false
    const timer = setTimeout(() => finish('duration'), durationMs)
    const onSigint = () => finish('SIGINT')
    const onSigterm = () => finish('SIGTERM')
    const finish = (termination: ValidationTermination) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
      resolvePromise(termination)
    }
    process.once('SIGINT', onSigint)
    process.once('SIGTERM', onSigterm)
  })
}

void main().catch(error => {
  const message = error instanceof Error
    ? error.message.slice(0, 300)
    : 'Unknown validation error.'
  console.error(`Multi-agent validation failed: ${message}`)
  process.exitCode = 1
})
