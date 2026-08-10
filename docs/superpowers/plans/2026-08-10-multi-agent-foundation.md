# M5 Multi-Agent Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Alice, Bob, and Charlie safely in one Paper world with isolated mutable runtime state, bounded shared provider concurrency, agent-specific commands and telemetry, and deterministic graceful shutdown.

**Architecture:** A small `AgentManager` owns independent `AgentRuntime` compositions. Each runtime owns its bot, state, arbiter, loops, memory identity, provider wrapper, and telemetry; immutable config and a FIFO provider limiter are shared. The current `bot.ts` becomes a composition root, and an offline-testable bounded validation CLI records live evidence.

**Tech Stack:** TypeScript 7, Node.js 22, Mineflayer, `node:test`, atomic JSON memory, OpenAI Responses API. No new dependencies.

## Global Constraints

- Continue on `feature/autonomous-brain-iteration`; never merge main, force-push, or rewrite history.
- Preserve the complete `AgentDecision` vocabulary and all current grounding/runtime revalidation.
- Use `gpt-5-mini`; do not add provider/model routing.
- Reflection remains disabled during M5 validation.
- One shared application API key; never persist prompts, responses, chat, reasoning, headers, or secrets.
- No relationships, roles, professions, shared goals, coordination, social memory, economy, planner, embeddings, vector database, new Minecraft skills, M6 behavior, or new production dependency.
- Every production behavior change follows red-green-refactor with offline deterministic tests.
- Each meaningful task ends with full tests, typecheck, build, diff review, a focused commit, and push.

---

### Task 1: Validated Multi-Agent Configuration

**Files:**
- Create: `apps/minecraft-bridge/src/runtime/config.ts`
- Create: `apps/minecraft-bridge/src/runtime/config.test.ts`
- Create: `configs/agents.json`
- Modify: `.env.example`

**Interfaces:**
- Produces `AgentDefinition`, `AgentRuntimeConfig`, `AgentConfiguration`,
  `decodeAgentConfigDocument(value)`, and
  `loadAgentConfiguration(environment, options)`.
- Agent IDs match `/^[a-z][a-z0-9_-]{0,31}$/`; usernames match Minecraft's
  `/^[A-Za-z0-9_]{1,16}$/`.
- Default selection is `alice`; `AGENTS=alice,bob,charlie` selects three.

- [ ] **Step 1: Write failing configuration tests**

```ts
it('loads Alice by default and preserves ordered explicit selection', async () => {
  assert.deepEqual((await load({})).agents.map(agent => agent.id), ['alice'])
  assert.deepEqual((await load({ AGENTS: 'charlie,alice' })).agents.map(agent => agent.id), ['charlie', 'alice'])
})

it('rejects duplicate identities and traversal-shaped ids', () => {
  assert.throws(() => decode({ schemaVersion: 1, agents: [alice, alice] }), /duplicate agent id/i)
  assert.throws(() => decode({ schemaVersion: 1, agents: [{ id: '../bob', username: 'Bob' }] }), /invalid agent id/i)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --import tsx --test src/runtime/config.test.ts`
Expected: failure because `runtime/config.ts` does not exist.

- [ ] **Step 3: Implement strict decoding and environment selection**

```ts
export interface AgentDefinition {
  id: string
  username: string
  autonomous?: boolean
  memoryEnabled?: boolean
}

export interface AgentConfiguration {
  agents: readonly AgentDefinition[]
  maxProviderConcurrency: number
  brainStaggerMs: number
  operatorUsernames: readonly string[]
  minecraft: { host: string; port: number; spawnTimeoutMs: number }
}
```

Use `readFile(..., 'utf8')`, parse unknown JSON, validate every field, compare
IDs/usernames case-insensitively for duplicates, reject unknown selected IDs,
and never include credentials in this model.

- [ ] **Step 4: Add the tracked identity file and safe environment examples**

`configs/agents.json` contains schema version 1 and Alice/Bob/Charlie identities
only. `.env.example` documents `AGENT_CONFIG_PATH`, `AGENTS`,
`AGENT_LLM_MAX_CONCURRENCY`, `AGENT_BRAIN_STAGGER_MS`, and optional operator
usernames without a secret value.

- [ ] **Step 5: Verify and checkpoint**

Run focused tests, `npm test`, `npm run typecheck`, `npm run build`, and
`git diff --check`; review, commit `feat: configure multiple Minecraft agents`,
and push.

---

### Task 2: Shared Provider Limiter and Agent-Scoped Telemetry

**Files:**
- Create: `apps/minecraft-bridge/src/runtime/providerLimiter.ts`
- Create: `apps/minecraft-bridge/src/runtime/providerLimiter.test.ts`
- Create: `apps/minecraft-bridge/src/runtime/telemetry.ts`
- Create: `apps/minecraft-bridge/src/runtime/telemetry.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/provider.ts`

**Interfaces:**
- Produces `ProviderConcurrencyLimiter.run(task, signal)`, `close()` and
  `ConcurrencyLimitedProvider`.
- Extends `LLMRequestTiming` with optional `queueWaitMs` without changing
  provider call sites.
- Produces immutable `AgentTelemetrySnapshot` with identity, calls, failures,
  tokens, latency, queue wait, connection counters, and memory metrics.

- [ ] **Step 1: Write failing FIFO/cap/abort/no-leak tests**

```ts
it('never exceeds the cap and starts queued calls FIFO', async () => {
  const limiter = new ProviderConcurrencyLimiter(2)
  // Hold two tasks, enqueue two more, release in order, and assert maxActive=2
  // plus start order [1, 2, 3, 4].
})

it('rejects an aborted queued call without invoking its task', async () => {
  // Fill the permit, enqueue with AbortController.signal, abort, and assert the
  // queued callback was never called.
})
```

- [ ] **Step 2: Run focused tests and verify RED**

Run both new test files; expected missing-module failures.

- [ ] **Step 3: Implement the minimal dependency-free semaphore**

Use a private FIFO queue of `{ resolve, reject, signal, onAbort }`. A permit is
released in `finally`; listener cleanup occurs on acquisition, abort, or close.
`close()` rejects queued work but does not corrupt already-active calls.

- [ ] **Step 4: Implement separate-provider wrapping and telemetry**

```ts
export function instrumentAgentProvider(
  identity: AgentIdentity,
  provider: LLMProvider,
  limiter: ProviderConcurrencyLimiter,
  telemetry: AgentRuntimeTelemetry,
  signal: AbortSignal
): LLMProvider
```

Measure queue wait and wall time, copy only timing numbers, preserve each base
provider's separate `getLastTiming()`, and never retain `BrainInput` or output.

- [ ] **Step 5: Verify and checkpoint**

Run focused/full gates, review privacy and queue cleanup, commit
`feat: limit and measure agent provider requests`, and push.

---

### Task 3: Identity-Scoped Memory and Flush Boundary

**Files:**
- Create: `apps/minecraft-bridge/src/runtime/memory.ts`
- Create: `apps/minecraft-bridge/src/runtime/memory.test.ts`
- Modify: `apps/minecraft-bridge/src/memory/types.ts`
- Modify: `apps/minecraft-bridge/src/memory/store.ts`
- Modify: `apps/minecraft-bridge/src/memory/coordinator.ts`
- Modify: related memory tests

**Interfaces:**
- Produces `memoryFilePath(baseDirectory, identity)` and
  `createAgentMemory(options)`.
- Adds awaited `flush(): Promise<void>` to `MemoryStore` and `AgentMemory`.
- Maps validated identity to `<base>/<worldId>/<agentId>.json`.

- [ ] **Step 1: Write failing same-world isolation and corruption tests**

```ts
it('does not retrieve Alice episodes or facts through Bob identity', async () => {
  // Open alice and bob stores in one temp root, write Alice records, query Bob,
  // and assert both result arrays are empty.
})

it('leaves Alice usable when Bob JSON is malformed', async () => {
  // Corrupt only bob.json, assert Bob open rejects and Alice still reopens.
})
```

- [ ] **Step 2: Run focused tests and verify RED**

Expected failure because runtime memory construction and flush are absent.

- [ ] **Step 3: Implement traversal-safe paths and flush**

`memoryFilePath` revalidates IDs even though configuration already decoded them.
`AtomicJsonMemoryStore.flush()` awaits its mutation queue and propagates the
original failure. Coordinator flush delegates to the store. Do not alter schema
version or atomic replacement.

- [ ] **Step 4: Verify and checkpoint**

Run focused/full gates and `npm run benchmark:memory`; review identity checks,
commit `feat: isolate agent memory by runtime identity`, and push.

---

### Task 4: Reusable AgentRuntime and Graceful Lifecycle

**Files:**
- Create: `apps/minecraft-bridge/src/runtime/agentRuntime.ts`
- Create: `apps/minecraft-bridge/src/runtime/agentRuntime.test.ts`
- Create: `apps/minecraft-bridge/src/runtime/services.ts`
- Modify: `apps/minecraft-bridge/src/agent/loop.ts`
- Modify: `apps/minecraft-bridge/src/agent/loop.test.ts`
- Modify: `apps/minecraft-bridge/src/survival/reflexLoop.ts`
- Modify: `apps/minecraft-bridge/src/survival/reflexLoop.test.ts`

**Interfaces:**
- Produces `AgentRuntime.start()`, `stop()`, `snapshot()`, and read-only
  identity/state/arbiter accessors needed by manager and validation.
- Loop classes expose `waitForIdle(): Promise<void>` while preserving existing
  `start()`, `stop()`, and `runCycle()` behavior.
- `AgentRuntimeServices` injects bot/provider/memory/loop factories, scheduler,
  commands, logger, and clock for offline lifecycle tests.

- [ ] **Step 1: Write failing loop-idle and runtime ownership tests**

```ts
it('owns independent state and arbiter for every runtime', () => {
  assert.notEqual(alice.state, bob.state)
  assert.notEqual(alice.arbiter, bob.arbiter)
})

it('stops timers, queued provider work, active action, memory, and bot once', async () => {
  await runtime.start()
  await Promise.all([runtime.stop(), runtime.stop()])
  assert.deepEqual(events, expectedOrderedShutdown)
})
```

- [ ] **Step 2: Verify RED**

Run runtime and loop focused tests; confirm failures identify missing lifecycle
APIs rather than fixture errors.

- [ ] **Step 3: Add loop idle completion without changing cycle semantics**

Track the current cycle promise, clear it in `finally`, and resolve idle waiters
only after the active cycle settles. `stop()` prevents future scheduling.

- [ ] **Step 4: Implement AgentRuntime composition**

Create memory/provider before connection, wait for `spawn` with timeout/error/end
listeners, register commands with the runtime's arbiter, create one reflex and
Brain loop, start reflex immediately, and schedule Brain at the supplied
deterministic delay. Prefix logger messages with `[agentId/username]`.

- [ ] **Step 5: Implement idempotent ordered stop**

Cancel the delayed Brain start, stop both loops, abort queued provider work,
cancel the controlled action, await both loops, flush memory and telemetry, quit
the bot, and remove runtime-owned listeners.

- [ ] **Step 6: Verify and checkpoint**

Run focused/full gates, inspect behavior preservation, commit
`refactor: extract reusable agent runtime`, and push.

---

### Task 5: Player Perception, Agent-Specific Prompt, and Command Routing

**Files:**
- Modify: `apps/minecraft-bridge/src/perception/perceive.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/decisionContract.ts`
- Modify: `apps/minecraft-bridge/src/brain/decisionContract.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/providers/openai.ts`
- Modify: provider tests as needed
- Modify: `apps/minecraft-bridge/src/commands/chatCommands.ts`
- Modify: `apps/minecraft-bridge/src/commands/chatCommands.test.ts`

**Interfaces:**
- Produces `systemInstructionFor(agentName)`; retains `SYSTEM_INSTRUCTION` as the
  Alice-compatible export if needed by existing tests/providers.
- Extends `registerChatCommands` options with `isAuthorizedOperator` and logger.

- [ ] **Step 1: Write failing tests**

```ts
it('shows Bob and Charlie to Alice while excluding Alice', () => {
  assert.deepEqual(perceive(bot).nearbyEntities.map(e => e.name), ['Bob', 'Charlie'])
})

it('routes alice stop only to Alice and rejects agent-authored commands', async () => {
  // Emit the same human command to Alice/Bob handlers, then emit command-shaped
  // text from Charlie and prompt-shaped speech; assert only Alice manual state changes.
})
```

- [ ] **Step 2: Verify RED**

The new routing/authorization and dynamic instruction assertions must fail.

- [ ] **Step 3: Implement dynamic identity and operator filtering**

Build the instruction from validated `BrainInput.state.agentName`; all world and
memory content remains serialized JSON data. Reject own chat and configured
agent usernames before parsing. Parse only the exact target runtime prefix.

- [ ] **Step 4: Re-run grounding regressions**

Run semantic, decision validation, loop, movement, perception, command, and
provider tests. Confirm visible Bob is allowed, invisible Bob/self/Dave rejected.

- [ ] **Step 5: Verify and checkpoint**

Run full gates, review prompt-injection containment, commit
`feat: route commands to grounded agent runtimes`, and push.

---

### Task 6: AgentManager and Thin Process Entrypoint

**Files:**
- Create: `apps/minecraft-bridge/src/runtime/agentManager.ts`
- Create: `apps/minecraft-bridge/src/runtime/agentManager.test.ts`
- Create: `apps/minecraft-bridge/src/runtime/composition.ts`
- Replace: `apps/minecraft-bridge/src/bot.ts`

**Interfaces:**
- Produces `AgentManager.startAll()`, `stopAll()`, `snapshots()`, and explicit
  startup result types.
- Production composition creates a separate provider for every runtime behind
  one shared limiter, one runtime per selected agent, and one signal handler.

- [ ] **Step 1: Write failing manager tests**

```ts
it('continues Alice and Charlie when Bob startup fails', async () => {
  assert.deepEqual(await manager.startAll(), {
    started: ['alice', 'charlie'], failures: [{ agentId: 'bob', error: 'connect failed' }]
  })
})

it('stops all started runtimes in reverse order after partial failure', async () => {
  await manager.stopAll()
  assert.deepEqual(stopOrder, ['charlie', 'alice'])
})
```

- [ ] **Step 2: Verify RED**

Expected missing manager/composition failures.

- [ ] **Step 3: Implement manager failure boundaries**

Validate definitions before constructing any runtime. Start in configured order,
retain successful runtimes, report agent-local failures, and make shutdown
idempotent with aggregate error reporting.

- [ ] **Step 4: Replace global `bot.ts` with composition**

Load Brain and agent config once, build shared services, start the manager, log
every startup result with identity, and install SIGINT/SIGTERM handlers that
stop once and set a failing exit code only when shutdown fails.

- [ ] **Step 5: Verify single-agent compatibility and checkpoint**

Offline tests must show default `AGENTS` creates Alice only. Run full gates,
review mutable ownership, commit `feat: manage multiple Minecraft agents`, push.

---

### Task 7: Multi-Agent Validation Reports

**Files:**
- Create: `apps/minecraft-bridge/src/runtime/validation.ts`
- Create: `apps/minecraft-bridge/src/runtime/validation.test.ts`
- Create: `apps/minecraft-bridge/src/runtime/validationCli.ts`
- Modify: `apps/minecraft-bridge/package.json`

**Interfaces:**
- Produces schema-versioned `MultiAgentValidationReport`, deterministic
  aggregation, conservative cost calculation, and atomic report writes.
- Adds `npm run validate:multi-agent`.

- [ ] **Step 1: Write failing aggregation and privacy tests**

Assert per-agent/aggregate calls, tokens, failures, queue wait, startup rate,
disconnect rate, visible players, and cost. Assert the encoded report contains
no prompt, response, chat, reason, key, authorization, or free-form model text.

- [ ] **Step 2: Verify RED and implement minimal reporting**

The CLI loads production composition, runs for bounded
`MULTI_AGENT_SESSION_MS`, snapshots current external players and telemetry,
stops in `finally`, and atomically replaces only `MULTI_AGENT_OUTPUT`.

- [ ] **Step 3: Verify and checkpoint**

Run focused/full gates, review output boundaries, commit
`feat: measure multi-agent runtime reliability`, and push.

---

### Task 8: Ordered Live Validation, Documentation, and Final Audit

**Files:**
- Create: `docs/multi-agent-foundation.md`
- Modify implementation/tests only for defects reproduced during live sessions.

**Interfaces:**
- Produces evidence for one-agent, two-agent, three-agent, and—only if stable—
  five bounded three-agent sessions.

- [ ] **Step 1: Run Alice alone**

Use memory on, reflection off, OpenAI/`gpt-5-mini`, a bounded session, and an
artifact outside the repository. Verify spawn, Brain/reflex logs, memory,
commands where practical, crafting, telemetry, and shutdown.

- [ ] **Step 2: Run Alice and Bob**

Verify both joins, mutual perception, separate Brain/reflex logs and memory,
targeted command handling, no feedback loop, limiter metrics, and clean stop.

- [ ] **Step 3: Run Alice, Bob, and Charlie**

Run 5–10 minutes maximum, healthy/safe, without professions or coordination.
Inspect startups, disconnects, resource contention, memory isolation, command
routing, queue wait, tokens, cost, crashes, and shutdown.

- [ ] **Step 4: Run five bounded sessions only if infrastructure remains stable**

Do not hide invalid sessions. Stop if Paper/OpenAI limits prevent trustworthy
validation; report the blocker rather than tuning behavior.

- [ ] **Step 5: Write the evidence document**

Document architecture, shared/isolated services, config, memory, commands,
provider concurrency, staggering, lifecycle, prompt trust, exact live results,
per-agent tokens/cost/latency, failures, limitations, and reproduction commands.

- [ ] **Step 6: Perform required reviews**

Review multi-agent/state/arbitration isolation, memory identity, routing,
concurrency, shutdown, prompt injection, secrets, and M0–M4 regressions. Add a
failing deterministic test before every defect fix.

- [ ] **Step 7: Run final gates**

```sh
git status
git log --oneline --decorate -25
cd apps/minecraft-bridge
npm test
npm run typecheck
npm run build
npm run benchmark:memory
git diff --check
git diff --check main...HEAD
```

- [ ] **Step 8: Final checkpoint and stop**

Commit `docs: record multi-agent validation`, push only
`feature/autonomous-brain-iteration`, confirm local/remote parity and clean
status, report all 34 requested results, and stop before M6.
