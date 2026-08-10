import { join, resolve } from 'node:path'

import {
  AgentMemoryCoordinator,
  type AgentMemory,
  type MemoryCoordinatorLogger
} from '../memory/coordinator.js'
import { MemoryEventRecorder } from '../memory/recorder.js'
import type { MemoryReflector } from '../memory/reflection.js'
import { AtomicJsonMemoryStore } from '../memory/store.js'
import type { MemoryIdentity } from '../memory/types.js'

const AGENT_ID = /^[a-z][a-z0-9_-]{0,31}$/
const WORLD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface CreateAgentMemoryOptions {
  baseDirectory: string
  identity: MemoryIdentity
  episodeLimit: number
  factLimit: number
  debug: boolean
  logger?: MemoryCoordinatorLogger
  reflector?: Pick<MemoryReflector, 'consider'>
}

export function memoryFilePath(
  baseDirectory: string,
  identity: MemoryIdentity
): string {
  if (!AGENT_ID.test(identity.agentId)) {
    throw new Error('Invalid agent memory identity.')
  }
  if (!WORLD_ID.test(identity.worldId)) {
    throw new Error('Invalid world memory identity.')
  }
  return join(resolve(baseDirectory), identity.worldId, `${identity.agentId}.json`)
}

export async function createAgentMemory(
  options: CreateAgentMemoryOptions
): Promise<AgentMemory> {
  const identity = { ...options.identity }
  const store = new AtomicJsonMemoryStore({
    filePath: memoryFilePath(options.baseDirectory, identity),
    identity
  })
  await store.open()
  return new AgentMemoryCoordinator({
    store,
    recorder: new MemoryEventRecorder({ identity }),
    identity,
    episodeLimit: options.episodeLimit,
    factLimit: options.factLimit,
    debug: options.debug,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.reflector ? { reflector: options.reflector } : {})
  })
}
