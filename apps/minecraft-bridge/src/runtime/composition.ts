import { isAbsolute, resolve } from 'node:path'
import mineflayer from 'mineflayer'
import { pathfinder } from 'mineflayer-pathfinder'

import { cancelAgentAction } from '../agent/cancelAction.js'
import { AutonomousAgentLoop } from '../agent/loop.js'
import { loadBrainConfig, type BrainConfig } from '../brain/config.js'
import { createLLMProvider } from '../brain/providers/index.js'
import { visibleExternalPlayers } from '../brain/semantics.js'
import {
  createOperatorAuthorizer,
  registerChatCommands
} from '../commands/chatCommands.js'
import { MemoryReflector } from '../memory/reflection.js'
import { OpenAIReflectionProvider } from '../memory/providers/openaiReflection.js'
import { createDefaultDecisionExecutor } from '../skills/execute.js'
import { perceive } from '../perception/perceive.js'
import { ConversationCoordinator } from '../social/conversationCoordinator.js'
import { OpenAISocialProvider } from '../social/providers/openai.js'
import {
  AtomicJsonRelationshipStore,
  relationshipFilePath
} from '../social/relationshipStore.js'
import { AgentRelationshipService } from '../social/relationships.js'
import { ReflexLoop } from '../survival/reflexLoop.js'
import { AgentManager } from './agentManager.js'
import { AgentRuntime } from './agentRuntime.js'
import {
  loadAgentConfiguration,
  type AgentConfiguration
} from './config.js'
import { createAgentMemory } from './memory.js'
import { ProviderConcurrencyLimiter } from './providerLimiter.js'
import type {
  AgentRuntimeServices,
  RuntimeScheduler
} from './services.js'
import {
  AgentRuntimeTelemetry,
  instrumentAgentProvider,
  instrumentSocialProvider
} from './telemetry.js'

type Environment = Readonly<Record<string, string | undefined>>

export interface ProductionComposition {
  manager: AgentManager
  agentConfiguration: AgentConfiguration
  brainConfig: BrainConfig
}

export async function createProductionComposition(
  environment: Environment = process.env
): Promise<ProductionComposition> {
  const brainConfig = loadBrainConfig(environment)
  const agentConfiguration = await loadAgentConfiguration(environment)
  const limiter = new ProviderConcurrencyLimiter(
    agentConfiguration.maxProviderConcurrency
  )
  const appDirectory = resolve(__dirname, '../..')
  const memoryDirectory = isAbsolute(brainConfig.memoryDirectory)
    ? brainConfig.memoryDirectory
    : resolve(appDirectory, brainConfig.memoryDirectory)
  const socialDirectory = isAbsolute(brainConfig.socialDirectory)
    ? brainConfig.socialDirectory
    : resolve(appDirectory, brainConfig.socialDirectory)
  const coordinator = brainConfig.socialEnabled
    ? new ConversationCoordinator({
        enabled: true,
        worldId: brainConfig.memoryWorldId,
        autoGreeting: brainConfig.socialAutoGreeting,
        maxTurns: brainConfig.socialMaxTurns,
        cooldownMs: brainConfig.socialCooldownMs,
        turnTimeoutMs: brainConfig.socialTurnTimeoutMs,
        maxMessageCharacters: brainConfig.socialMaxMessageChars,
        logger: console
      })
    : null
  const isAuthorizedOperator = createOperatorAuthorizer(
    agentConfiguration.operatorUsernames,
    agentConfiguration.configuredAgentUsernames
  )
  const services: AgentRuntimeServices = {
    createMemory: context => createAgentMemory({
      baseDirectory: memoryDirectory,
      identity: context.memoryIdentity,
      episodeLimit: context.config.memoryEpisodeLimit,
      factLimit: context.config.memoryFactLimit,
      debug: context.config.debugMemory,
      logger: context.logger,
      ...(context.config.memoryReflection
        ? {
            createReflector: store => new MemoryReflector({
              store,
              provider: new OpenAIReflectionProvider({
                baseUrl: context.config.openaiBaseUrl,
                apiKey: context.config.openaiApiKey,
                model: context.config.memoryReflectionModel
              })
            })
          }
        : {})
    }),
    createProvider: context => instrumentAgentProvider(
      createLLMProvider(context.config, { logger: context.logger }),
      limiter,
      context.telemetry,
      context.signal
    ),
    ...(coordinator ? {
        createSocialResources: async (context) => {
          const targets = context.configuredAgentIds.filter(
            agentId => agentId !== context.identity.agentId
          )
          const identity = {
            observerAgentId: context.identity.agentId,
            worldId: context.config.memoryWorldId
          }
          const relationshipStore = new AtomicJsonRelationshipStore({
            filePath: relationshipFilePath(socialDirectory, identity),
            identity,
            configuredTargetAgentIds: targets
          })
          await relationshipStore.open()
          return {
            relationshipStore,
            relationships: new AgentRelationshipService({
              identity,
              configuredTargetAgentIds: targets,
              store: relationshipStore,
              encounterCooldownMs: context.config.socialCooldownMs
            }),
            provider: instrumentSocialProvider(
              new OpenAISocialProvider({
                baseUrl: context.config.openaiBaseUrl,
                apiKey: context.config.openaiApiKey,
                model: context.config.socialModel,
                requestTimeoutMs: context.config.socialTurnTimeoutMs
              }),
              limiter,
              context.telemetry,
              context.signal
            )
          }
        }
      } : {}),
    createBot: connection => {
      const bot = mineflayer.createBot({
        ...connection,
        auth: 'offline'
      })
      bot.loadPlugin(pathfinder)
      return bot
    },
    createBrainLoop: context => new AutonomousAgentLoop({
      bot: context.bot,
      state: context.state,
      arbiter: context.arbiter,
      provider: context.provider,
      memory: context.memory ?? undefined,
      cognitiveGate: context.cognitiveGate,
      socialContext: context.socialContext,
      intervalMs: context.config.tickIntervalMs,
      execute: createDefaultDecisionExecutor({
        explorationRadius: context.config.explorationRadius
      }),
      logger: context.logger
    }),
    createReflexLoop: context => new ReflexLoop({
      bot: context.bot,
      state: context.state,
      arbiter: context.arbiter,
      intervalMs: context.config.reflexIntervalMs,
      onReflexDecision: context.onReflexDecision,
      logger: context.logger
    }),
    registerCommands: context => registerChatCommands(
      context.bot,
      context.state,
      {
        arbiter: context.arbiter,
        isAuthorizedOperator,
        startConversation: context.startConversation,
        onManualActivity: context.onManualActivity,
        logger: context.logger
      }
    ),
    observeVisibleExternalPlayers: (bot, state) => visibleExternalPlayers(
      perceive(bot),
      state.agentName
    ).map(player => player.username),
    observePerception: perceive,
    cancelAction: cancelAgentAction,
    createTelemetry: identity => new AgentRuntimeTelemetry(identity),
    scheduler: nodeScheduler,
    now: Date.now,
    logger: console
  }
  const manager = new AgentManager({
    definitions: agentConfiguration.agents,
    createRuntime: (definition, index) => new AgentRuntime({
      definition,
      brainConfig,
      minecraft: agentConfiguration.minecraft,
      brainStartDelayMs: index * agentConfiguration.brainStaggerMs,
      services,
      ...(coordinator ? {
          socialCoordinator: coordinator,
          configuredAgents: agentConfiguration.agents
        } : {})
    }),
    prepareSharedStop: () => coordinator?.prepareStop(),
    closeShared: async () => {
      try {
        await coordinator?.close()
      } finally {
        limiter.close()
      }
    }
  })
  return { manager, agentConfiguration, brainConfig }
}

const nodeScheduler: RuntimeScheduler = {
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    timer.unref()
    return timer
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout)
  }
}
