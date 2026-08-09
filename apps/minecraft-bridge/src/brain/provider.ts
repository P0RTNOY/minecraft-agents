import type { BrainInput } from './types.js'

export interface LLMProvider {
  decide(input: BrainInput): Promise<unknown>
}
