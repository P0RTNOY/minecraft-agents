import type { Bot } from 'mineflayer'

import type { ActionArbiter } from '../agent/actionArbiter.js'
import type { AgentState } from '../agent/state.js'
import type { BrainConfig } from '../brain/config.js'
import type { LLMProvider } from '../brain/provider.js'
import type { AgentMemory } from '../memory/coordinator.js'
import type { MemoryIdentity } from '../memory/types.js'
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
  | 'flush'
> {
  snapshot(): AgentTelemetrySnapshot
}

export interface AgentResourceContext {
  identity: RuntimeAgentIdentity
  definition: AgentDefinition
  config: BrainConfig
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
  logger: RuntimeLogger
}

export interface BrainLoopContext extends RuntimeLoopContext {
  provider: LLMProvider
  memory: AgentMemory | null
}

export interface RuntimeCommandContext extends RuntimeLoopContext {}

export interface AgentRuntimeServices {
  createMemory(context: MemoryResourceContext): Promise<AgentMemory | null>
  createProvider(context: ProviderResourceContext): LLMProvider
  createBot(connection: {
    host: string
    port: number
    username: string
  }): Bot
  createBrainLoop(context: BrainLoopContext): RuntimeLoop
  createReflexLoop(context: RuntimeLoopContext): RuntimeLoop
  registerCommands(context: RuntimeCommandContext): () => void
  cancelAction(bot: Bot, state: AgentState): void
  createTelemetry(identity: RuntimeAgentIdentity): RuntimeTelemetry
  scheduler: RuntimeScheduler
  now(): number
  logger: RuntimeLogger
}
