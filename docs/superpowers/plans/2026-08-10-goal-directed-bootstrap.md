# Goal-Directed Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight process-local short-term goal/progress layer and evaluate autonomous bootstrap quality across providers without changing the controlled action vocabulary.

**Architecture:** A loop-owned `ShortTermGoalManager` deterministically derives goal state and progress from each perception snapshot. `BrainInput`, prompting, repetition, and a sequential benchmark consume those facts while existing validation, arbitration, executor, and runtime skill revalidation boundaries remain unchanged.

**Tech Stack:** TypeScript, Node test runner, Mineflayer 4.37, existing Ollama/Groq HTTP providers, no new dependencies.

## Global Constraints

- Do not add a full planner, durable memory, reflection, generated skills, or new decision/action types.
- Keep survival reflexes above advisory goal selection.
- Keep all model output untrusted and all existing grounding/execution boundaries intact.
- Automated tests must require no Minecraft server, provider, key, or network.
- Run `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`, and `git diff --check main...HEAD` before completion.
- Push only verified focused commits to `origin/feature/autonomous-brain-iteration`; do not merge or force-push.

---

### Task 1: Deterministic short-term goals and progress

**Files:**
- Create: `apps/minecraft-bridge/src/brain/goals.ts`
- Create: `apps/minecraft-bridge/src/brain/goals.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/types.ts`

**Interfaces:**
- Produce `ShortTermGoal`, `ShortTermGoalType`, `GoalProgress`, and `AvailableCapabilities` controlled structures.
- Produce `computeGoalProgress(perception, goalType)`, `buildAvailableCapabilities(perception)`, and process-local `ShortTermGoalManager.update(perception)`.

- [ ] Write failing tests for empty inventory selection, observed-resource selection, completion, transition, emergency suppression, deterministic progress changes, and process-local id behavior.
- [ ] Run `node --import tsx --test src/brain/goals.test.ts` and confirm failures are caused by the missing goal API.
- [ ] Implement the smallest controlled goal model, exact registry-name categories, progress computation, and runtime manager needed by the tests.
- [ ] Re-run the focused test and the full package suite.
- [ ] Review the diff, run `git diff --check`, commit as `feat: add short-term runtime goals`, and push after verifying remote parity.

### Task 2: Brain input, prompt, loop, and progress-aware repetition

**Files:**
- Modify: `apps/minecraft-bridge/src/agent/loop.ts`
- Modify: `apps/minecraft-bridge/src/agent/loop.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/decisionContract.ts`
- Modify: `apps/minecraft-bridge/src/brain/decisionContract.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/repetition.ts`
- Modify: `apps/minecraft-bridge/src/brain/repetition.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/semantics.test.ts`
- Modify provider/benchmark fixtures that construct `BrainInput`.

**Interfaces:**
- Consume `ShortTermGoalManager.update(perception)` once per autonomous cycle.
- Extend serialized `BrainInput` with `shortTermGoal`, `goalProgress`, and `availableCapabilities`.
- Preserve `LLMProvider -> unknown -> schema validation -> contextual validation -> repetition -> arbitration -> executor`.

- [ ] Write failing tests proving the goal/progress/capability snapshot reaches the provider, emergency input has no active goal, and contextual rejection still prevents execution.
- [ ] Write failing prompt tests for goal progress guidance, grounded choice, no-progress avoidance, concision, and absence of an encoded bootstrap sequence.
- [ ] Write failing repetition tests for goal-progress-sensitive idle/action rejection and permission after meaningful progress.
- [ ] Run the focused tests and confirm the expected failures.
- [ ] Wire the manager into the loop, serialize compact goal data, tune the shared prompt, and fingerprint goal progress without changing the JSON decision schema.
- [ ] Re-run focused tests and all package gates.
- [ ] Review the diff, commit as `feat: expose goal progress to Brain`, and push after remote parity verification.

### Task 3: Sequential bootstrap benchmark and provider timing

**Files:**
- Modify: `apps/minecraft-bridge/src/brain/provider.ts`
- Modify: `apps/minecraft-bridge/src/brain/providers/ollama.ts`
- Modify: `apps/minecraft-bridge/src/brain/providers/ollama.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/providers/groq.ts`
- Modify: `apps/minecraft-bridge/src/brain/providers/groq.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/benchmark/run.ts`
- Modify: `apps/minecraft-bridge/src/brain/benchmark/run.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/benchmark/scenarios.ts`
- Modify: `apps/minecraft-bridge/src/brain/benchmark/cli.ts`

**Interfaces:**
- Add optional `LLMProvider.getLastTiming(): LLMRequestTiming | null` with millisecond durations and token counts.
- Add a sequential bootstrap scenario transition that returns the next `BrainInput` and whether deterministic goal progress changed.
- Add benchmark summary metrics for grounding, diversity, progress/no-progress, idle, repeated no-progress, completion, latency, and provider timing.

- [ ] Write failing provider tests for normalized Ollama timing, Groq usage parsing, and missing timing metadata.
- [ ] Write failing benchmark tests for the accepted bootstrap transition sequence, non-grounded decisions, no-progress/repetition accounting, goal completion, summary metrics, and provider failure recovery.
- [ ] Run focused tests and confirm the expected failures.
- [ ] Implement optional timing snapshots and the bounded sequential simulator/summary while preserving existing static scenarios.
- [ ] Re-run focused tests and all package gates.
- [ ] Review the diff, commit as `feat: add sequential bootstrap benchmark`, and push after remote parity verification.

### Task 4: Provider comparison, controlled live run, and evidence

**Files:**
- Modify: `docs/brain-benchmark.md`
- Modify implementation/tests only if measurement exposes a reproducible defect, beginning with a failing test.

- [ ] Check installed Ollama models and whether `GROQ_API_KEY` exists without printing its value.
- [ ] Warm and run a modest identical bootstrap sample for `llama3.2:latest`, `qwen3:1.7b`, and `qwen3:4b`; run Groq only when the existing key is available.
- [ ] Record exact commands, metrics, failures, and local-engineering disclaimer in `docs/brain-benchmark.md`.
- [ ] With all automated gates green, check the Paper server and run a 2–5 minute isolated reversible bootstrap test only if safe; record setup, decisions/results, progress, final state, latency, and cleanup.
- [ ] Run final tests, typecheck, build, whitespace checks, architecture/grounding/arbitration/prompt review, and a secret-pattern audit.
- [ ] Inspect status and the complete branch diff, commit as `docs: record autonomous bootstrap evaluation`, fetch/verify remote parity, and push.
- [ ] Confirm local and remote feature-branch HEAD match and stop after M3.1.
