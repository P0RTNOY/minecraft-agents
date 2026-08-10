# M5 Multi-Agent Foundation Design

Date: 2026-08-10

## Objective

Generalize the local Mineflayer bridge from one process-global Alice runtime to
multiple independently owned agent runtimes. Alice, Bob, and Charlie share one
Paper world and one application-level OpenAI project credential, while state,
goals, arbitration, perception, memory, commands, and telemetry remain isolated
per agent.

M5 is coexistence infrastructure. It does not add relationships, roles,
professions, coordination, shared goals, social reasoning, new Minecraft
actions, planning, routing, embeddings, reflection, or M6 behavior.

## Selected architecture

`AgentManager` owns a validated ordered set of `AgentRuntime` instances. Each
runtime creates and owns exactly one Mineflayer bot, `AgentState`,
`ActionArbiter`, `ShortTermGoalManager` through its Brain loop, reflex loop,
memory coordinator/store identity, command handler, and telemetry recorder.
Runtime construction uses small injected factories so lifecycle and isolation
are deterministic without Minecraft, OpenAI, or network access in tests.

The process shares only immutable global Brain/provider configuration, the
provider-concurrency limiter, static Minecraft helpers, logger infrastructure,
and the configured set of agent/operator identities. Each runtime receives a
separate provider instance behind the shared limiter so provider timing state
cannot leak across agents.

The existing `bot.ts` becomes a thin composition root: load configuration,
create shared services and the manager, start all selected agents, install one
idempotent SIGINT/SIGTERM shutdown path, and report agent-local startup errors.

## Alternatives considered

### Runtime instances in one process — selected

One process keeps the current architecture and static registry sharing while
making mutable ownership explicit. It supports a small dependency-free
semaphore, deterministic staggering, targeted commands, unified shutdown, and
per-agent telemetry without duplicating code.

### One Node process per agent

Process isolation is strong, but configuration, provider concurrency, lifecycle,
telemetry aggregation, and live validation would need inter-process
coordination. That is unnecessary infrastructure for three local agents.

### One centralized multi-agent loop

A central scheduler could own all state, but it would weaken the already-proven
per-agent single-flight, goal, reflex, and arbitration boundaries. It also makes
one agent's failure more likely to affect all agents.

## Configuration

`configs/agents.json` is a tracked, secret-free schema-versioned identity list:

```json
{
  "schemaVersion": 1,
  "agents": [
    { "id": "alice", "username": "Alice" },
    { "id": "bob", "username": "Bob" },
    { "id": "charlie", "username": "Charlie" }
  ]
}
```

`AGENT_CONFIG_PATH` selects the file. `AGENTS` selects exact IDs and defaults to
`alice`, preserving convenient single-agent development. Per-agent optional
`autonomous` and `memoryEnabled` booleans override the corresponding global
Brain defaults; provider credentials and model settings stay global.

The loader rejects malformed JSON, unsupported schema versions, invalid IDs or
Minecraft usernames, unknown selections, control characters, duplicate IDs,
and duplicate usernames case-insensitively before any connection starts.
Validated IDs use a traversal-safe restricted alphabet.

Additional dependency-free settings are:

- `AGENT_LLM_MAX_CONCURRENCY`, default `2`, range `1..8`;
- `AGENT_BRAIN_STAGGER_MS`, default `1000`, range `0..60000`;
- `AGENT_OPERATOR_USERNAMES`, optional comma-separated Minecraft usernames;
- `MINECRAFT_HOST`, default `localhost`;
- `MINECRAFT_PORT`, default `25565`;
- `AGENT_SPAWN_TIMEOUT_MS`, default `30000`.

The ignored root `.env` remains the only credential location. All three agents
use the same `OPENAI_API_KEY`; application telemetry attributes usage by agent.

## Runtime ownership and lifecycle

`AgentRuntime.start()` opens its identity-scoped memory first, creates its own
provider and bot, waits for a bounded spawn event, registers commands, creates
its loops, starts the reflex loop, and schedules the Brain loop at
`agentIndex * AGENT_BRAIN_STAGGER_MS`. A memory-open or bot-start failure is
agent-local and is returned by the manager without preventing later agents from
starting. Invalid shared configuration and duplicate identities are
manager-fatal because safe construction cannot begin.

`AgentRuntime.stop()` is idempotent. It stops future Brain/reflex work, cancels a
queued provider request through an agent-local abort signal, cancels the current
controlled action, waits for loop work already in flight, flushes memory and
telemetry, disconnects the bot, and clears timers/listeners. Active remote calls
are allowed to complete within the provider's existing bounded timeout; queued
calls fail immediately on abort.

`AgentManager.stopAll()` stops runtimes in reverse order and reports all errors
without abandoning later cleanup. The process signal handler accepts only one
shutdown attempt.

## Provider concurrency and staggering

A small FIFO `ProviderConcurrencyLimiter` owns at most
`AGENT_LLM_MAX_CONCURRENCY` permits. Each runtime wraps its separate provider in
the shared limiter and supplies its shutdown signal. Per-agent Brain single-
flight remains unchanged; the limiter only bounds cross-agent remote calls.
Queued work preserves order, never shares input, and is rejected cleanly if its
agent stops or the manager closes the limiter.

Queue wait, wall-clock provider latency, input/output tokens, failures, and
request counts are recorded by the runtime's agent-scoped telemetry. Aggregate
telemetry is derived from immutable per-agent snapshots rather than shared
mutable counters.

## Memory isolation

Every runtime uses the common `worldId` and its stable lowercase `agentId`.
Each validated identity maps to one file under:

```text
data/memory/<worldId>/<agentId>.json
```

The existing `AtomicJsonMemoryStore` still validates document identity and each
query/record identity. The runtime path is derived only from validated IDs, and
the entire directory remains ignored. Alice and Bob can occupy the same world
without sharing episodes or semantic facts. A corrupted Bob document fails
Bob's startup only and is never replaced or read by Alice.

The memory store gains only an awaited `flush()` boundary over its existing
serialized mutation queue. Persistence schema/version validation and atomic
replacement behavior remain unchanged.

## Perception, grounding, and prompt trust

Mineflayer already exposes other bots as player entities. Perception continues
to remove only the runtime's exact self entity, so Alice can observe Bob,
Charlie, and human players in range. Brain semantics and contextual validation
continue excluding the current runtime username and grounding
`follow_player`/`come_to_player` only to currently visible external players.
There is no AI-versus-human special case.

The deliberate system instruction becomes agent-specific from the structured
`BrainInput.state.agentName`; the action schema stays unchanged. Player names,
memory, and all world observations remain JSON data. Chat text is not inserted
into system instructions or Brain input, so an agent saying "Ignore your system
instructions" cannot change another agent's schema or validation path.

## Manual commands and chat-loop prevention

Every bot registers a handler using its own username prefix. A message such as
`alice stop` parses only in Alice's runtime; Bob and Charlie ignore it. Commands
still execute through the target runtime's arbiter, preserving
manual > reflex > LLM without touching another runtime's generation or lock.

Configured agent usernames are never authorized operators. When
`AGENT_OPERATOR_USERNAMES` is non-empty, only that allowlist may issue commands;
otherwise any non-agent external player may use the recognized whitelist for
backward compatibility. Own chat and arbitrary speech are ignored. This blocks
agent-command feedback loops without hard-coding one human identity.

## Telemetry and live validation

`AgentRuntimeTelemetry` snapshots include `agentId`, `username`, provider calls
and failures, input/output tokens, provider latency, queue wait, memory metrics,
connection/end/error counters, and lifecycle timestamps. They never store
prompts, provider responses, chat text, reasoning, authorization headers, or
credentials.

A bounded validation CLI uses the production manager and writes a versioned
JSON report atomically after one-, two-, or three-agent sessions. It records
startup outcomes, shutdown outcomes, each runtime's visible external players,
per-agent telemetry, aggregate totals, and estimated standard `gpt-5-mini` cost.
It does not prescribe goals or infer social quality.

Live validation proceeds in order: Alice alone, Alice and Bob, then all three.
Only after the three-agent session is stable may five bounded three-agent
sessions be run. Resource contention and runtime revalidation failures are
normal world outcomes unless they reveal isolation or lifecycle defects.

## Test strategy

All automated tests remain offline and dependency-free. They cover:

- configuration validation, selection, duplicates, and single-agent default;
- runtime ownership, staggered starts, partial startup failure, and idempotent
  graceful shutdown;
- independent state, goals, arbiters, histories, locks, and timers;
- same-world cross-agent episode/fact isolation and corrupt-file containment;
- self exclusion, external AI-player perception, and unchanged grounding;
- exact command routing, operator authorization, own-chat rejection, and
  prompt-like agent speech containment;
- FIFO provider concurrency, cap, abort, queue wait, provider failure isolation,
  and input-object separation;
- per-agent telemetry identity and aggregation;
- single-agent compatibility and all existing M0–M4.1 regressions.

## Completion boundary

M5 completes only after deterministic tests and bounded live one-, two-, and
three-agent sessions demonstrate safe coexistence, the small reliability cohort
is attempted when infrastructure is stable, final documentation records the
evidence, all repository gates pass, and the feature branch is clean and pushed.
Work stops before M6 or social systems.
