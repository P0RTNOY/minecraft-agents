import { loadBrainConfig } from '../config.js'
import { createLLMProvider } from '../providers/index.js'
import { runBrainBenchmark } from './run.js'
import { BRAIN_BENCHMARK_SCENARIOS } from './scenarios.js'

async function main(): Promise<void> {
  const config = loadBrainConfig()
  if (!config.model) {
    throw new Error('LLM_MODEL is required to run the Brain benchmark.')
  }

  const results = await runBrainBenchmark({
    provider: createLLMProvider(config),
    providerName: config.provider,
    model: config.model,
    scenarios: BRAIN_BENCHMARK_SCENARIOS
  })

  console.log(JSON.stringify({
    provider: config.provider,
    model: config.model,
    results
  }, null, 2))
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
