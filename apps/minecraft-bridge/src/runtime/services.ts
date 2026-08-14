import type { Bot } from 'mineflayer'

import type { ActionArbiter } from '../agent/actionArbiter.js'
import type { AgentState } from '../agent/state.js'
import type { BrainConfig } from '../brain/config.js'
import type { LLMProvider } from '../brain/provider.js'
import type { AgentMemory } from '../memory/coordinator.js'
import type { MemoryIdentity } from '../memory/types.js'
import type { PerceptionSnapshot } from '../perception/types.js'
import type { CognitiveGate } from '../social/cognitiveGate.js'
import type { StartConversationResult } from '../social/conversationCoordinator.js'
import type { SocialProvider } from '../social/provider.js'
import type {
  AgentRelationshipService,
  RelationshipStore
} from '../social/relationships.js'
import type { AgentDefinition } from './config.js'
import type {
  AgentRuntimeTelemetry,
  AgentTelemetrySnapshot,
  RuntimeAgentIdentity
} from './telemetry.js'

export interface RuntimeLoop {
  start(): void
  stop(): void
  waitForIdle(): Promise<void>
}

export interface RuntimeScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface RuntimeLogger {
  log(message: string): void
  error(message: string): void
}

export interface RuntimeTelemetry extends Pick<
  AgentRuntimeTelemetry,
  | 'recordProviderCall'
  | 'recordSpawn'
  | 'recordDisconnect'
  | 'recordError'
  | 'recordKick'
  | 'recordMemory'
  | 'recordSocialProviderCall'
  | 'recordConversationTelemetry'
  | 'recordSocialEvent'
  | 'recordSocialLoopRejection'
  | 'recordSocialBudgetExhaustion'
  | 'flush'
> {
  snapshot(): AgentTelemetrySnapshot
}

export interface AgentResourceContext {
  identity: RuntimeAgentIdentity
  definition: AgentDefinition
  config: BrainConfig
  logger: RuntimeLogger
}

export interface ProviderResourceContext extends AgentResourceContext {
  signal: AbortSignal
  telemetry: RuntimeTelemetry
}

export interface MemoryResourceContext extends AgentResourceContext {
  memoryIdentity: MemoryIdentity
}

export interface RuntimeLoopContext extends AgentResourceContext {
  bot: Bot
  state: AgentState
  arbiter: ActionArbiter
}

export interface BrainLoopContext extends RuntimeLoopContext {
  provider: LLMProvider
  memory: AgentMemory | null
  cognitiveGate: CognitiveGate
  socialContext?: (
    perception: PerceptionSnapshot
  ) => Promise<readonly import('../social/context.js').VisibleAgentSocialContext[]>
}

export interface RuntimeCommandContext extends RuntimeLoopContext {
  startConversation?: (targetAgentId: string) => Promise<StartConversationResult>
  onManualActivity(): void
}

export interface ReflexLoopContext extends RuntimeLoopContext {
  onReflexDecision(): void
}

export interface RuntimeSocialResources {
  provider: SocialProvider
  relationshipStore: RelationshipStore
  relationships: AgentRelationshipService
}

export interface SocialResourceContext extends ProviderResourceContext {
  configuredAgentIds: readonly string[]
}

export interface AgentRuntimeServices {
  createMemory(context: MemoryResourceContext): Promise<AgentMemory | null>
  createProvider(context: ProviderResourceContext): LLMProvider
  createSocialResources?(
    context: SocialResourceContext
  ): Promise<RuntimeSocialResources>
  createBot(connection: {
    host: string
    port: number
    username: string
  }): Bot
  createBrainLoop(context: BrainLoopContext): RuntimeLoop
  createReflexLoop(context: ReflexLoopContext): RuntimeLoop
  registerCommands(context: RuntimeCommandContext): () => void
  observeVisibleExternalPlayers(bot: Bot, state: AgentState): string[]
  observePerception?(bot: Bot): PerceptionSnapshot
  cancelAction(bot: Bot, state: AgentState): void
  createTelemetry(identity: RuntimeAgentIdentity): RuntimeTelemetry
  scheduler: RuntimeScheduler
  now(): number
  logger: RuntimeLogger
}
