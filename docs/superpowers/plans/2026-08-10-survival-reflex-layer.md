# Survival Reflex Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic, grounded fleeing and eating at reflex cadence with explicit Manual > Reflex > LLM arbitration.

**Architecture:** A separate reflex loop evaluates current structured perception every 250 ms and submits internal survival decisions through a shared single-flight arbiter. Survival skills revalidate the live Minecraft world; the existing LLM decision contract remains unchanged.

**Tech Stack:** TypeScript, Node test runner, Mineflayer, mineflayer-pathfinder, Minecraft registry data already exposed by Mineflayer.

## Global Constraints

- Work only on `feature/autonomous-brain-iteration`; never merge, force-push, or rewrite published history.
- Preserve all M0/M1 validation, grounding, repetition, manual override, and controlled-executor guarantees.
- Keep `AgentDecision` and provider schemas at the existing seven actions during initial M2.
- Add no dependency and require no Minecraft server, Ollama, Groq, or network for automated tests.
- No combat, crafting, exploration, memory, personalities, or unrelated navigation.

---

### Task 1: Grounded flee skill

**Files:**
- Create: `apps/minecraft-bridge/src/survival/types.ts`
- Create: `apps/minecraft-bridge/src/survival/hostility.ts`
- Create: `apps/minecraft-bridge/src/skills/flee.ts`
- Test: `apps/minecraft-bridge/src/skills/flee.test.ts`
- Modify: `apps/minecraft-bridge/src/agent/state.ts`
- Test: `apps/minecraft-bridge/src/agent/state.test.ts`

**Interfaces:**
- Produces: `FleeDecision { action: 'flee_from_entity'; entityId: number; entityName: string; reason: string }`.
- Produces: `isObservedHostile(entity)` and `fleeFromEntity(bot, state, decision, source)`.
- Uses entity IDs only after exact perception grounding and live registry revalidation.

- [ ] Write failing tests for close-target execution, hallucinated/player/self targets, disappeared entities, safe destination selection, no safe destination, routing failure, and goal-replacement cancellation.
- [ ] Run the focused flee/state tests and confirm failures are caused by missing M2 behavior.
- [ ] Implement the minimal registry-grounded flee decision, destination checks, Pathfinder movement, structured result, and state extensions.
- [ ] Re-run focused tests, then `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Review the complete diff, commit `feat: add grounded survival flee skill`, and push the feature branch without force.

### Task 2: Grounded eat skill

**Files:**
- Create: `apps/minecraft-bridge/src/skills/eat.ts`
- Test: `apps/minecraft-bridge/src/skills/eat.test.ts`
- Modify: `apps/minecraft-bridge/src/survival/types.ts`
- Modify: `apps/minecraft-bridge/src/agent/state.ts`
- Modify: `apps/minecraft-bridge/src/skills/index.ts`

**Interfaces:**
- Produces: `EatDecision { action: 'eat'; reason: string }` with no item supplied by an LLM or caller.
- Produces: `findSafeFood(bot)` using current inventory and `bot.registry.foodsByName`.
- Produces: `eatFood(bot, state, source)` with live stack revalidation and structured results.

- [ ] Write failing tests for deterministic safe-food choice, no food, harmful/non-food exclusion, disappearing inventory, consumption success/failure, and cancellation.
- [ ] Run the focused eat tests and confirm the expected RED state.
- [ ] Implement registry-backed selection, exclusions, equip/consume/revalidation, and state-safe cleanup.
- [ ] Re-run focused and full verification gates.
- [ ] Review, commit `feat: add grounded survival eating skill`, and push without force.

### Task 3: Deterministic reflex semantics and policy

**Files:**
- Modify: `apps/minecraft-bridge/src/perception/types.ts`
- Modify: `apps/minecraft-bridge/src/perception/perceive.ts`
- Modify: `apps/minecraft-bridge/src/brain/semantics.ts`
- Modify: `apps/minecraft-bridge/src/brain/decisionContract.ts`
- Create: `apps/minecraft-bridge/src/survival/evaluateReflex.ts`
- Test: `apps/minecraft-bridge/src/survival/evaluateReflex.test.ts`
- Modify/Test: relevant perception and semantics tests.

**Interfaces:**
- Produces: registry category on entity observations and safe-edible inventory facts.
- Produces: `evaluateReflex(perception): SurvivalDecision | null`.
- Exports named constants for creeper distance 4, hostile distance 5, low health 10, and critical food 6.

- [ ] Write failing policy tests covering near/distant creepers, low-health close/safe hostiles, healthy agents, self/player exclusions, hunger with/without food, and threat-before-food ordering.
- [ ] Verify RED, implement only deterministic threshold evaluation, then verify GREEN.
- [ ] Update semantic serialization tests without adding survival actions to provider schemas.
- [ ] Run full verification, review, commit `feat: add deterministic survival reflex policy`, and push without force.

### Task 4: Priority arbiter and stale-decision invalidation

**Files:**
- Create: `apps/minecraft-bridge/src/agent/actionArbiter.ts`
- Test: `apps/minecraft-bridge/src/agent/actionArbiter.test.ts`
- Modify: `apps/minecraft-bridge/src/agent/loop.ts`
- Modify/Test: `apps/minecraft-bridge/src/agent/loop.test.ts`
- Modify: `apps/minecraft-bridge/src/commands/chatCommands.ts`
- Modify/Test: `apps/minecraft-bridge/src/commands/chatCommands.test.ts`
- Modify: survival skills only where cancellation integration requires it.

**Interfaces:**
- Produces: one shared arbiter with priority `manual > reflex > llm`, a monotonic generation, and one active controlled execution.
- Brain captures an arbiter generation before provider await and rejects the response when it changes.
- Manual stop cancels movement, digging, and item use through the shared controlled cancellation boundary.

- [ ] Write failing arbiter/loop tests for all priority pairs, single-flight execution, stale LLM after reflex, manual stop during reflex, and autonomy-off behavior.
- [ ] Verify RED, implement minimal arbitration and integration, then verify focused GREEN.
- [ ] Run all M0/M1 regressions and the complete verification gate.
- [ ] Review, commit `feat: enforce survival action priority`, and push without force.

### Task 5: Fast reflex loop and runtime integration

**Files:**
- Create: `apps/minecraft-bridge/src/survival/loop.ts`
- Test: `apps/minecraft-bridge/src/survival/loop.test.ts`
- Modify/Test: `apps/minecraft-bridge/src/brain/config.ts` and `config.test.ts`
- Modify: `apps/minecraft-bridge/src/bot.ts`
- Modify: `apps/minecraft-bridge/src/skills/execute.ts` only if a shared survival execution adapter is needed.

**Interfaces:**
- Produces: `ReflexLoop` with non-overlapping 250 ms recursive scheduling and no LLM calls.
- Produces: bounded `AGENT_REFLEX_INTERVAL_MS` configuration.
- Logs only triggered/refused/completed reflex actions with `⚡`/`⚙️`/`✅` or `❌` prefixes.

- [ ] Write failing tests for interval bounds, no-trigger silence, trigger logging, non-overlapping ticks, grounded execution, and safe observation/execution failures.
- [ ] Verify RED, implement the loop and runtime wiring, then verify focused GREEN.
- [ ] Run the full gate and confirm LLM provider call counts do not increase with reflex ticks.
- [ ] Review, commit `feat: run survival reflexes independently`, and push without force.

### Task 6: Documentation, live smoke check, and final security review

**Files:**
- Modify: repository architecture documentation selected from existing docs after inspection.
- Modify: `.env.example` only if it exists and already documents agent intervals.

- [ ] Document Perception → Reflex/Brain → Arbiter → Skills and `Manual > Reflex > LLM` exactly as implemented.
- [ ] Run `git status`, `git log --oneline --decorate -15`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Inspect `git diff main...HEAD` for grounding bypasses, stale responses, priority inversion, concurrency, disappearing targets/items, unsafe flee candidates, scope drift, and accidental secret exposure.
- [ ] If a local Paper server is already safely available, run bounded non-destructive smoke checks; otherwise record that live testing was skipped.
- [ ] Commit `docs: describe survival reflex architecture`, push without force, and confirm local/remote branch equality.
- [ ] Stop after M2 and provide the requested comprehensive report and reproduction commands.
