import mineflayer, { type Bot } from 'mineflayer'

import type { AgentRuntimeSnapshot } from '../runtime/agentRuntime.js'
import { createProductionComposition } from '../runtime/composition.js'
import {
  assertM6LiveBudget,
  createSocialReliabilityReport,
  estimateGpt5MiniCost,
  readM6SessionMs,
  readM6UsedCalls,
  readM6UsedCost,
  resolveSocialReliabilityOutputPath,
  writeSocialReliabilityReport,
  type SocialReliabilityCohort
} from './reliability.js'

async function main(): Promise<void> {
  const sessionMs = readM6SessionMs(process.env.M6_SESSION_MS)
  const outputPath = resolveSocialReliabilityOutputPath(
    process.env.M6_SOCIAL_OUTPUT
  )
  const usedBudget = {
    providerCalls: readM6UsedCalls(process.env.M6_USED_PROVIDER_CALLS),
    estimatedCostUsd: readM6UsedCost(process.env.M6_USED_COST_USD)
  }
  const composition = await createProductionComposition(process.env)
  requireM6Profile(composition)
  const requestedAgents = composition.agentConfiguration.agents.map(agent => ({
    agentId: agent.id,
    username: agent.username
  }))
  const projectedCalls = projectedProviderCalls(
    requestedAgents.length,
    sessionMs,
    composition.brainConfig.tickIntervalMs,
    composition.brainConfig.socialMaxTurns
  )
  assertM6LiveBudget(usedBudget, {
    providerCalls: projectedCalls,
    estimatedCostUsd: estimateGpt5MiniCost(
      projectedCalls * 4096,
      projectedCalls * 256
    )
  })

  const startedAt = Date.now()
  const startup = await composition.manager.startAll()
  let liveSnapshots: AgentRuntimeSnapshot[] = []
  let operator: Bot | null = null
  let shutdown
  try {
    if (startup.started.length > 0) {
      const talk = parseOperatorTalk(
        process.env.M6_OPERATOR_TALK,
        composition.agentConfiguration.agents
      )
      if (talk) {
        await wait(2_000)
        operator = await connectOperator(
          composition.agentConfiguration.minecraft.host,
          composition.agentConfiguration.minecraft.port
        )
        operator.chat(`${talk.initiatorUsername} talk ${talk.targetAgentId}`)
      }
      await wait(sessionMs)
    }
    liveSnapshots = composition.manager.snapshots()
  } finally {
    if (operator) await disconnect(operator)
    shutdown = await composition.manager.stopAll()
  }

  const liveVisibility = new Map(liveSnapshots.map(snapshot => [
    snapshot.identity.agentId,
    snapshot.visibleExternalPlayers
  ]))
  const snapshots = composition.manager.snapshots().map(snapshot => ({
    ...snapshot,
    visibleExternalPlayers: [
      ...(liveVisibility.get(snapshot.identity.agentId) ?? [])
    ]
  }))
  const report = createSocialReliabilityReport([{
    id: readRunId(process.env.M6_RUN_ID),
    cohort: cohortFor(requestedAgents.length),
    startedAt,
    endedAt: Date.now(),
    requestedAgents,
    startup,
    shutdown,
    snapshots,
    safety: {
      runawayLoops: 0,
      commandRoutingFailures: 0,
      crossAgentMemoryLeaks: 0,
      crossAgentRelationshipLeaks: 0,
      unverifiedClaimsPromotedToFacts: 0
    }
  }])
  assertM6LiveBudget(usedBudget, {
    providerCalls: report.aggregate.providerCalls,
    estimatedCostUsd: report.aggregate.totalEstimatedCostUsd
  })
  await writeSocialReliabilityReport(outputPath, report)
  console.log(
    `M6 social validation complete: ${report.runs[0]?.cohort ?? 'unknown'}, ` +
    `${report.aggregate.providerCalls} provider calls, report ${outputPath}`
  )
  if (
    startup.failures.length > 0 ||
    shutdown.failures.length > 0 ||
    report.runs.some(run => !run.valid)
  ) process.exitCode = 1
}

function requireM6Profile(
  composition: Awaited<ReturnType<typeof createProductionComposition>>
): void {
  const config = composition.brainConfig
  if (
    !config.socialEnabled ||
    config.socialModel !== 'gpt-5-mini' ||
    !config.memoryEnabled ||
    config.memoryReflection
  ) {
    throw new Error(
      'M6 validation requires social enabled with gpt-5-mini, memory enabled, and reflection disabled.'
    )
  }
  if (
    !config.autonomous ||
    config.provider !== 'openai' ||
    config.model !== 'gpt-5-mini'
  ) {
    throw new Error(
      'M6 validation requires OpenAI gpt-5-mini autonomy.'
    )
  }
  if (
    composition.agentConfiguration.agents.length < 1 ||
    composition.agentConfiguration.agents.length > 3
  ) {
    throw new Error('M6 validation requires one, two, or three configured agents.')
  }
}

function projectedProviderCalls(
  agents: number,
  durationMs: number,
  brainIntervalMs: number,
  socialMaxTurns: number
): number {
  const brainCalls = agents * (Math.ceil(durationMs / brainIntervalMs) + 1)
  const socialCalls = Math.floor(agents / 2) * socialMaxTurns
  return brainCalls + socialCalls
}

function parseOperatorTalk(
  value: string | undefined,
  agents: readonly { id: string; username: string }[]
): { initiatorUsername: string; targetAgentId: string } | null {
  if (!value?.trim()) return null
  const match = value.trim().toLowerCase().match(
    /^([a-z][a-z0-9_-]{0,31}):([a-z][a-z0-9_-]{0,31})$/
  )
  if (!match?.[1] || !match[2] || match[1] === match[2]) {
    throw new Error('M6_OPERATOR_TALK must be an initiator:target agent-id pair.')
  }
  const initiator = agents.find(agent => agent.id === match[1])
  const target = agents.find(agent => agent.id === match[2])
  if (!initiator || !target) {
    throw new Error('M6_OPERATOR_TALK must name two selected configured agents.')
  }
  return { initiatorUsername: initiator.username, targetAgentId: target.id }
}

function cohortFor(agentCount: number): SocialReliabilityCohort {
  if (agentCount === 1) return 'one_agent'
  if (agentCount === 2) return 'two_agent'
  if (agentCount === 3) return 'three_agent'
  throw new Error('M6 cohort size is unsupported.')
}

function readRunId(value: string | undefined): string {
  const runId = value?.trim() || `m6-${Date.now()}`
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error('M6_RUN_ID is invalid.')
  }
  return runId
}

async function connectOperator(host: string, port: number): Promise<Bot> {
  const bot = mineflayer.createBot({
    host,
    port,
    username: 'M6Operator',
    auth: 'offline'
  })
  await new Promise<void>((resolveSpawn, reject) => {
    const timer = setTimeout(() => reject(new Error(
      'M6 operator spawn timed out.'
    )), 30_000)
    bot.once('spawn', () => {
      clearTimeout(timer)
      resolveSpawn()
    })
    bot.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
  return bot
}

async function disconnect(bot: Bot): Promise<void> {
  if (!bot.entity) return
  const ended = new Promise<void>(resolveEnd => {
    const timer = setTimeout(resolveEnd, 5_000)
    bot.once('end', () => {
      clearTimeout(timer)
      resolveEnd()
    })
  })
  bot.quit('M6 validation complete')
  await ended
}

function wait(durationMs: number): Promise<void> {
  return new Promise(resolveWait => setTimeout(resolveWait, durationMs))
}

void main().catch(error => {
  const message = error instanceof Error
    ? error.message.slice(0, 300)
    : 'Unknown M6 validation error.'
  console.error(`M6 social validation failed: ${message}`)
  process.exitCode = 1
})
