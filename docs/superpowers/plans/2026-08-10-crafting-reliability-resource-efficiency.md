# M3.4 Crafting Reliability and Resource Efficiency Plan

> **Execution:** Follow this plan inline with `superpowers:executing-plans`; use test-driven development for every behavior change.

**Goal:** Improve autonomous bootstrap reliability by making craft quantities output-aware and by retrying one proven zero-mutation table synchronization failure without weakening the controlled action boundary.

**Architecture:** Keep the existing decision vocabulary and `unknown -> validation -> grounding -> repetition -> arbitration -> controlled skill -> runtime revalidation` flow. Extend the application-owned craftability snapshot with recipe output batch size, enforce desired-output-count semantics in contextual and runtime validation, and contain one table-only retry inside the crafting skill after complete inventory equality and fresh table reacquisition. Carry non-sensitive craft metrics through the existing execution result into reliability telemetry.

**Tech stack:** TypeScript, Node test runner, Mineflayer 4.37, Paper 1.21.11, existing provider adapters, no new dependencies.

## Evidence before implementation

- The official M3.3 post-fix sample contains 10 valid runs: 7 completed and runs 2, 6, and 10 timed out.
- Each failed run recorded three craft actions, one table placement, one failed collection, four progress actions, one no-progress action, no craft/grounding/validation/provider failure, and a final inventory of exactly 16 sticks. Given the fixed three-log start and Minecraft recipe deltas, this proves all 12 planks were ultimately allocated to one table and four stick recipe executions, leaving no planks for a basic tool.
- The M3.3 JSON does not retain ordered decision payloads or before/after inventory for every cycle. Therefore the intermediate sequence (12 planks, one table, 16 sticks) is a deterministic recipe-delta reconstruction; exact ordering and per-cycle snapshots are unavailable and must not be represented as directly recorded evidence.
- Six of 43 official craft actions failed. Exact structured reasons exist only for the second five-run batch: all three failures there were `craft_item:output_not_confirmed` in a run that later recovered. The first batch predates structured skill-reason capture, so its three failures cannot be assigned an exact reason from saved JSON.
- Mineflayer's table path calls `activateBlock`, waits for `windowOpen`, performs slot operations, and closes the window. An isolated live diagnostic reproduced its 20-second `windowOpen` timeout with a completely unchanged inventory. A resolved craft with no confirmed delta is likewise retryable only when a complete inventory snapshot remains identical.
- The pre-change system instruction is 995 characters / 139 whitespace-delimited words.

## Tasks

### 1. Lock the desired-output quantity contract with failing tests

**Files:**
- Modify `apps/minecraft-bridge/src/skills/crafting.test.ts`
- Modify `apps/minecraft-bridge/src/brain/validateDecision.test.ts`
- Modify `apps/minecraft-bridge/src/brain/decisionContract.test.ts`
- Modify relevant capability/benchmark fixtures

- [x] Require every craftable capability to expose `recipeOutput` from the selected grounded recipe.
- [x] Prove `craft_item(item, amount)` means desired output item count and maps an aligned amount to exact recipe executions.
- [x] Reject non-positive, non-integer, over-limit, capability-max-exceeding, and recipe-output-unaligned amounts without normalization.
- [x] Assert the prompt explains output batches and resource preservation generically without naming a bootstrap recipe sequence.
- [x] Run focused tests and confirm they fail for the missing semantics.

### 2. Lock bounded retry and idempotency with failing tests

**Files:**
- Modify `apps/minecraft-bridge/src/skills/crafting.test.ts`

- [x] Cover immediate success and delayed authoritative confirmation.
- [x] Cover one unchanged-inventory table retry succeeding and failing, with no second retry.
- [x] Cover a known `windowOpen` synchronization error as retryable only when unchanged.
- [x] Prove cancellation, partial ingredient mutation, partial output mutation, missing ingredients, and non-table failures never retry.
- [x] Prove retry reacquires a current table block rather than reusing the held reference.
- [x] Run the focused test and confirm failures reflect missing retry/idempotency behavior.

### 3. Implement the minimal quantity and table-sync behavior

**Files:**
- Modify `apps/minecraft-bridge/src/skills/crafting.ts`
- Modify `apps/minecraft-bridge/src/brain/validateDecision.ts`
- Modify `apps/minecraft-bridge/src/brain/decisionContract.ts`
- Modify `apps/minecraft-bridge/src/brain/repetition.ts`
- Modify `apps/minecraft-bridge/src/brain/benchmark/bootstrap.ts`
- Modify capability fixtures

- [x] Add `recipeOutput` to the grounded capability selected from registry recipes.
- [x] Validate alignment and use exact integer division for recipe executions; never silently round output requests.
- [x] Add concise resource-efficient prompt guidance and measure its final size.
- [x] Refactor one craft attempt into exact whole-inventory reconciliation.
- [x] Permit one table-only retry after zero mutation, current action revalidation, fresh table lookup/block revalidation, recipe/ingredient revalidation, and a known transient outcome.
- [x] Return structured metrics and fail closed on every ambiguous delta.
- [x] Re-run focused tests until green.

### 4. Add structured craft telemetry

**Files:**
- Modify `apps/minecraft-bridge/src/skills/execute.ts`
- Modify `apps/minecraft-bridge/src/skills/execute.test.ts`
- Modify `apps/minecraft-bridge/src/brain/reliability/telemetry.ts`
- Modify `apps/minecraft-bridge/src/brain/reliability/telemetry.test.ts`

- [x] Carry requested amount, recipe output batch size, recipe execution count, retry count, retry result, and preserved failure reason in execution details.
- [x] Record bounded per-craft telemetry without prompts, raw provider responses, or secrets.
- [x] Summarize retry rate and retry success rate.
- [x] Run focused and full deterministic tests.

### 5. Verify, benchmark, and measure live reliability

**Files:**
- Modify `docs/bootstrap-reliability.md`
- Modify implementation/tests only after reproducing a new defect with a failing test

- [x] Run `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`, and `git diff --check main...HEAD`.
- [x] Run the unchanged eight-cycle deterministic bootstrap benchmark with `gpt-5-mini`; compare requested quantities, progress, completion, and token usage against M3.3.
- [x] Run five identical live trials, inspect validity and cleanup, then extend to ten only if stable.
- [x] Classify every failed post-change run from structured evidence and keep M3.3/M3.4 denominators separate.
- [x] Document quantity behavior, retry behavior, rates, token/cost changes, and remaining limitations.

### 6. Review, commit, and push verified work

- [x] Perform crafting correctness, quantity contract, retry/idempotency, telemetry, arbitration, and secret-pattern reviews.
- [x] Inspect `git status` and the complete diff; do not stage unrelated files or `.env`.
- [x] Create focused conventional commits for confirmed improvements and evidence.
- [x] Push only to `origin/feature/autonomous-brain-iteration`, verify local/remote parity, and stop before M4.
