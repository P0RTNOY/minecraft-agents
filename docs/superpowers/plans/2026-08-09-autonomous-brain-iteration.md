# Autonomous Brain Iteration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Groq support, deterministic Brain benchmarks, semantic inputs, contextual target safety, bounded repetition control, and a concise Minecraft-specific prompt while preserving M1.1's controlled architecture.

**Architecture:** A shared decision-contract module owns provider payload semantics, schema, and prompt. Thin Ollama/Groq adapters implement the unchanged `LLMProvider`; the loop performs contextual validation and bounded decision-history policy before the unchanged exhaustive executor.

**Tech Stack:** Node.js 22 built-in `fetch`, TypeScript, Node test runner, Mineflayer, Ollama HTTP API, Groq OpenAI-compatible Chat Completions API.

## Global Constraints

- Preserve the seven existing `AgentDecision` actions exactly.
- Preserve `unknown -> validate -> execute`; no direct model-to-Mineflayer access.
- No new dependencies, secrets, real `.env`, arbitrary code execution, memory database, survival skills, or multi-agent features.
- Tests are deterministic and network-independent.
- Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` after every milestone.
- Commit only verified milestone files on `feature/autonomous-brain-iteration`; never push or merge.

---

### Task 1: Groq provider and shared decision contract

**Files:**
- Create: `apps/minecraft-bridge/src/brain/decisionContract.ts`
- Create: `apps/minecraft-bridge/src/brain/providers/groq.ts`
- Create: `apps/minecraft-bridge/src/brain/providers/groq.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/providers/ollama.ts`
- Modify: `apps/minecraft-bridge/src/brain/providers/index.ts`
- Modify: `apps/minecraft-bridge/src/brain/config.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `DECISION_JSON_SCHEMA`, `SYSTEM_INSTRUCTION`, `serializeBrainInput(input: BrainInput): unknown`.
- Produces: `GroqProvider implements LLMProvider` with `{ baseUrl, apiKey, model, fetchImpl?, requestTimeoutMs? }`.

- [ ] Write provider/config tests that require a strict schema request, low reasoning, hidden reasoning, bounded output, safe errors, and explicit provider selection.
- [ ] Run focused tests and observe failures caused by missing Groq support.
- [ ] Extract the shared contract without changing Ollama behavior; implement the minimal Groq adapter and configuration.
- [ ] Run focused and full verification, inspect the complete diff, then commit `feat: add Groq brain provider`.

Expected Groq request core:

```ts
{
  model,
  messages,
  stream: false,
  reasoning_effort: 'low',
  include_reasoning: false,
  temperature: 0.1,
  max_completion_tokens: 128,
  response_format: {
    type: 'json_schema',
    json_schema: { name: 'agent_decision', strict: true, schema }
  }
}
```

### Task 2: Offline benchmark harness

**Files:**
- Create: `apps/minecraft-bridge/src/brain/benchmark/scenarios.ts`
- Create: `apps/minecraft-bridge/src/brain/benchmark/run.ts`
- Create: `apps/minecraft-bridge/src/brain/benchmark/run.test.ts`
- Create: `apps/minecraft-bridge/src/brain/benchmark/cli.ts`
- Modify: `apps/minecraft-bridge/package.json`

**Interfaces:**
- Produces: `BrainBenchmarkScenario`, `BrainBenchmarkResult`, `runBrainBenchmark(options): Promise<BrainBenchmarkResult[]>`.
- Consumes: any `LLMProvider`, fixed `BrainInput` scenarios, injected clock for deterministic tests.

- [ ] Write failing tests for valid/invalid decisions, provider errors, latency, repetition, self-targeting, and hallucinated targets.
- [ ] Implement nine fixed scenarios and the smallest runner satisfying the tests.
- [ ] Add `npm run benchmark:brain` CLI selection through existing environment configuration; require no Minecraft server.
- [ ] Verify and commit `feat: add Brain benchmark harness`.

Result shape:

```ts
interface BrainBenchmarkResult {
  scenario: string
  provider: string
  model: string
  latencyMs: number
  valid: boolean
  action: AgentDecisionAction | null
  reason: string | null
  repeated: boolean
  unsafeTarget: boolean
  error: string | null
}
```

### Task 3: Semantic Brain input and contextual player validation

**Files:**
- Create: `apps/minecraft-bridge/src/brain/semantics.ts`
- Create: `apps/minecraft-bridge/src/brain/semantics.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/types.ts`
- Modify: `apps/minecraft-bridge/src/brain/decisionContract.ts`
- Modify: `apps/minecraft-bridge/src/brain/validateDecision.ts`
- Modify: `apps/minecraft-bridge/src/agent/loop.ts`
- Modify: `apps/minecraft-bridge/src/skills/movement.ts`

**Interfaces:**
- Produces: `buildBrainSemantics(input: BrainInput): BrainSemantics` and `buildDecisionContext(input: BrainInput): DecisionValidationContext`.
- Updates: `validateDecision(value, context?)` while retaining syntax-only validation when context is absent.

- [ ] Write failing tests for low/healthy status labels, self exclusion, visible external players, self-target rejection, hallucinated-player rejection, valid-player acceptance, and executor-level defense.
- [ ] Implement deterministic 0–20 status categorization and semantic serialization.
- [ ] Pass decision context from the loop and add defensive movement checks.
- [ ] Verify and commit `fix: enforce semantic player targets`.

Target semantic shape:

```ts
{
  self: { username: 'Alice' },
  health: { current: 7.95, max: 20, status: 'low' },
  food: { current: 15, max: 20, status: 'healthy' },
  externalVisiblePlayers: [{ username: 'Steve', distance: 4.2 }]
}
```

### Task 4: Bounded repetition policy, prompt, and output limits

**Files:**
- Create: `apps/minecraft-bridge/src/brain/repetition.ts`
- Create: `apps/minecraft-bridge/src/brain/repetition.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/types.ts`
- Modify: `apps/minecraft-bridge/src/agent/loop.ts`
- Modify: `apps/minecraft-bridge/src/brain/decisionContract.ts`
- Modify: `apps/minecraft-bridge/src/brain/validateDecision.ts`

**Interfaces:**
- Produces: `assessRepetition(decision, input): RepetitionAssessment` and a bounded `RecentDecision[]` input field.
- Changes: `MAX_REASON_LENGTH` from 240 to 160.

- [ ] Write failing tests for exact repeated chat cooldown, unchanged-world consecutive idle rejection, changed-world idle allowance, bounded history, and prompt constraints.
- [ ] Implement the policy before execution and expose recent bounded history to providers.
- [ ] Replace the prompt with the concise Minecraft-specific instruction and reduce the reason schema limit.
- [ ] Verify and commit `feat: reduce repetitive Brain decisions`.

### Task 5: Provider comparison and report

**Files:**
- Create: `docs/brain-benchmark.md`
- Modify only benchmark code if a measured defect is reproduced with a failing test.

- [ ] Run one warm-up and a small sequential scenario sample for `llama3.2:latest`, `qwen3:1.7b`, and `qwen3:4b`.
- [ ] Run Groq only if `GROQ_API_KEY` is already present; never print the key or response reasoning.
- [ ] Record exact commands, model/provider labels, approximate latency, validity, repetition, unsafe targets, and limitations.
- [ ] If experimentation reveals a bug, add a failing regression test before fixing it and rerun all verification.
- [ ] Commit the evidence as `docs: record Brain provider benchmark`.

### Task 6: Final branch review

- [ ] Review every commit and the full `main..HEAD` diff for scope, safety, provider coupling, manual override preservation, and accidental secrets.
- [ ] Run `git status`, `git log --oneline --decorate -10`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Leave the branch local and unmerged; report unverified Groq/live-Minecraft behavior and exact return commands.
