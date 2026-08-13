import type { BrainInput } from './types.js'

export interface LLMRequestTiming {
  totalDurationMs?: number
  loadDurationMs?: number
  promptTokens?: number
  promptDurationMs?: number
  outputTokens?: number
  outputDurationMs?: number
  outputTokensPerSecond?: number
  queueWaitMs?: number
}

export interface LLMProvider {
  decide(input: BrainInput, signal?: AbortSignal): Promise<unknown>
  getLastTiming?(): LLMRequestTiming | null
}
