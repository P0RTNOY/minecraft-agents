import type { BrainConfig } from '../config.js'
import type { LLMProvider } from '../provider.js'
import { OllamaProvider } from './ollama.js'

export function createLLMProvider(config: BrainConfig): LLMProvider {
  switch (config.provider) {
    case 'ollama':
      return new OllamaProvider({
        baseUrl: config.ollamaBaseUrl,
        model: config.model,
        debugTiming: config.debugTiming
      })
    default:
      throw new Error(`Unsupported LLM_PROVIDER: ${config.provider}`)
  }
}
