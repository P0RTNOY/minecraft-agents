# M4.1 Memory Reliability Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure whether bounded persistent memory improves, preserves, or regresses Alice's autonomous bootstrap reliability under controlled memory-off, isolated-memory, and accumulating-memory cohorts.

**Architecture:** Extend the existing bootstrap reliability harness with experiment-only memory lifecycle controls and privacy-safe retrieval-quality telemetry. Keep the Brain, prompt, decision vocabulary, memory ranking, and runtime behavior unchanged until baseline cohort evidence identifies a specific harmful mechanism. Compare saved cohort artifacts with pure deterministic aggregation and document the result.

**Tech Stack:** TypeScript, Node.js test runner, existing Mineflayer/Paper reliability harness, OpenAI `gpt-5-mini`, atomic JSON memory store.

## Global Constraints

- Remain on `feature/autonomous-brain-iteration`; do not merge or force-push.
- Do not begin M5 or add planners, routing, skills, memory types, embeddings, vector databases, or dependencies.
- Use the same provider, model, start state, goal, timeout, decision budget, Paper environment, crafting code, and action vocabulary across cohorts.
- Keep reflection disabled for the primary A/B comparison.
- Do not tune retrieval before collecting the first controlled baseline.
- Never persist or log prompts, provider responses, chain-of-thought, credentials, or free-form remembered player text.
- Automated tests must not require Minecraft, OpenAI, or network access.

---

### Task 1: Add explicit experiment memory modes

**Files:**
- Create: `apps/minecraft-bridge/src/brain/reliability/experiment.ts`
- Create: `apps/minecraft-bridge/src/brain/reliability/experiment.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/reliability/cli.ts`

**Interfaces:**
- Produce `BootstrapMemoryMode = 'isolated' | 'accumulating'`.
- Produce `readBootstrapMemoryMode(value)` with `isolated` as the default and fail-closed validation.
- Produce `memoryLayoutForRun(mode, runId)` returning a controlled file name and exact `MemoryIdentity`.
- Isolated mode returns unique per-run file/world identities; accumulating mode returns one shared cohort file/world identity.

- [ ] Write tests proving invalid modes fail, isolated layouts differ per run, accumulating layouts are shared, and controlled file names cannot escape the temporary root.
- [ ] Run the focused test and confirm it fails because the module does not exist.
- [ ] Implement the minimal pure helpers.
- [ ] Run the focused test and confirm it passes.
- [ ] Wire the CLI to `BOOTSTRAP_MEMORY_MODE` without changing memory-off behavior or deleting any path outside its `mkdtemp` root.
- [ ] Add a CLI-cohort metadata assertion to the focused tests where practical.

### Task 2: Add deterministic retrieval-quality telemetry

**Files:**
- Create: `apps/minecraft-bridge/src/brain/reliability/memoryQuality.ts`
- Create: `apps/minecraft-bridge/src/brain/reliability/memoryQuality.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/reliability/telemetry.ts`
- Modify: `apps/minecraft-bridge/src/brain/reliability/telemetry.test.ts`

**Interfaces:**
- Produce exclusive classifications: `directly_relevant`, `weakly_relevant`, `irrelevant`, `stale_or_contradicted`.
- Produce a controlled per-call trace containing only memory kind/type or relation, age/status, classification, and deterministic signals.
- Extend run and summary telemetry with classification counts plus mean/median provider latency.

- [ ] Write focused tests for observed-name overlap, current-region overlap, goal-category relevance, irrelevant history, and stale fact classification.
- [ ] Verify the tests fail for the missing classifier.
- [ ] Implement deterministic classification without an LLM judge.
- [ ] Verify classifier tests pass.
- [ ] Write telemetry tests proving all retrieved items are counted once, estimated memory tokens remain unchanged, controlled traces exclude summaries/provider content, and failed runs remain represented.
- [ ] Verify telemetry tests fail for the missing fields.
- [ ] Instrument provider input before each call and implement the minimal aggregation.
- [ ] Verify telemetry tests pass.

### Task 3: Add pure cohort comparison

**Files:**
- Modify: `apps/minecraft-bridge/src/brain/reliability/experiment.ts`
- Modify: `apps/minecraft-bridge/src/brain/reliability/experiment.test.ts`
- Create: `apps/minecraft-bridge/src/brain/reliability/compareCli.ts`
- Modify: `apps/minecraft-bridge/package.json`

**Interfaces:**
- Produce `compareBootstrapCohorts(memoryOff, memoryOn)` with memory-on-minus-memory-off deltas for completion, completion time, decision count, progress/no-progress, failures, latency, tokens, and memory metrics.
- Preserve `rawRuns`, `validRuns`, and `infrastructureInvalidRuns` for each cohort.
- Add `npm run benchmark:memory-ab -- <off.json> <isolated.json> <accumulating.json>` for deterministic artifact comparison.

- [ ] Write tests showing delta direction, zero-denominator handling, and that failed and infrastructure-invalid runs are not discarded from cohort accounting.
- [ ] Verify the tests fail for the missing comparison.
- [ ] Implement the pure comparison and dependency-free JSON CLI.
- [ ] Verify focused experiment tests pass.

### Task 4: Verify instrumentation before live measurement

**Files:**
- Review all files changed in Tasks 1–3.

- [ ] Run focused reliability tests.
- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `npm run benchmark:memory`.
- [ ] Run `git diff --check` and review the complete diff.
- [ ] Commit and push the experiment instrumentation only if all gates pass.

### Task 5: Run controlled primary cohorts

**Artifacts:**
- `/tmp/minecraft-agents-m41-off.json`
- `/tmp/minecraft-agents-m41-isolated.json`
- `/tmp/minecraft-agents-m41-accumulating.json`
- `/tmp/minecraft-agents-m41-comparison.json`

- [ ] Confirm `.env` is ignored and a usable OpenAI credential is available without printing it.
- [ ] Run 10 trials with `AGENT_MEMORY_ENABLED=false` and reflection off.
- [ ] Run 10 trials with memory enabled, reflection off, and `BOOTSTRAP_MEMORY_MODE=isolated`.
- [ ] Run 10 trials with memory enabled, reflection off, and `BOOTSTRAP_MEMORY_MODE=accumulating`.
- [ ] Preserve every raw run in its cohort artifact and report infrastructure-invalid trials separately.
- [ ] Generate the deterministic comparison artifact.
- [ ] Inspect failed memory-on traces for irrelevant, stale, or over-weighted memories before forming a causal hypothesis.
- [ ] Extend to 20+20 only if the first cohorts are stable, inexpensive, and materially inconclusive.

### Task 6: Apply only evidence-backed retrieval fixes

**Files:**
- Modify only the smallest relevant retrieval/telemetry file if baseline evidence demonstrates a specific causal regression.
- Add the matching focused regression test before production changes.

- [ ] If there is no trace-supported regression mechanism, make no Brain or retrieval change.
- [ ] If a mechanism is demonstrated, write and run a failing deterministic regression test.
- [ ] Implement the smallest generic fix without bootstrap-specific memories.
- [ ] Rerun the same affected cohort for a comparable before/after measurement.

### Task 7: Document, verify, review, and publish

**Files:**
- Create: `docs/memory-reliability.md`

- [ ] Document experiment design, raw/valid cohort sizes, all requested metric comparisons, deltas, statistical caveats, retrieval examples, token/latency/cost impact, and the beneficial/neutral/regressive classification.
- [ ] State explicitly whether reflection was run; keep it off unless primary memory is non-regressive and a small secondary experiment is justified.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run benchmark:memory`.
- [ ] Run `git diff --check` and `git diff --check main...HEAD`.
- [ ] Audit ignored runtime state, secret patterns, persisted fields, prompt/provider response leakage, and complete branch scope.
- [ ] Commit focused evidence or fixes and push to `origin/feature/autonomous-brain-iteration`.
- [ ] Confirm local/remote parity and stop after M4.1.

## Self-Review

- Spec coverage: all requested cohorts, metrics, isolation rules, evidence-gated tuning, documentation, security, validation, and Git requirements map to Tasks 1–7.
- Placeholder scan: no deferred implementation placeholders remain.
- Type consistency: experiment modes, retrieval classifications, summaries, and comparison inputs are defined once and consumed by the CLI/tests.
- Scope: instrumentation and evaluation only; no M5 or architecture expansion.
