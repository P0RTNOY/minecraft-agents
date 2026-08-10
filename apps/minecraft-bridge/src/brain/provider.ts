import type { BrainInput } from './types.js'

export interface LLMRequestTiming {
  totalDurationMs?: number
  loadDurationMs?: number
  promptTokens?: number
  promptDurationMs?: number
  outputTokens?: number
  outputDurationMs?: number
  outputTokensPerSecond?: number
}

export interface LLMProvider {
  decide(input: BrainInput): Promise<unknown>
  getLastTiming?(): LLMRequestTiming | null
}
