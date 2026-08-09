import type { BrainConfig } from '../config.js'
import type { LLMProvider } from '../provider.js'
import { GroqProvider } from './groq.js'
import { OllamaProvider } from './ollama.js'

export function createLLMProvider(config: BrainConfig): LLMProvider {
  switch (config.provider) {
    case 'ollama':
      return new OllamaProvider({
        baseUrl: config.ollamaBaseUrl,
        model: config.model,
        debugTiming: config.debugTiming
      })
    case 'groq':
      return new GroqProvider({
        baseUrl: config.groqBaseUrl,
        apiKey: config.groqApiKey,
        model: config.model
      })
    default:
      throw new Error(`Unsupported LLM_PROVIDER: ${config.provider}`)
  }
}
