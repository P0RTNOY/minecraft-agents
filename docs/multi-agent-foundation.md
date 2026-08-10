# Multi-agent foundation (M5)

## Status

M5 generalizes the single Alice process into independently owned Alice, Bob,
and Charlie runtimes without adding social systems or changing the controlled
decision vocabulary. The implementation passed deterministic offline coverage,
ordered live one-, two-, and three-agent checks, and five valid three-agent
reliability sessions on 2026-08-10.

The live validation used Paper 1.21.11 in one local offline world, OpenAI
`gpt-5-mini`, memory enabled, memory reflection disabled, a provider concurrency
cap of two, and a one-second Brain stagger. One shared application key powered
all agents; application telemetry attributed usage to each runtime.

## Architecture and ownership

`bot.ts` is now a thin process entry point. Production composition loads
immutable configuration once, creates shared services, and gives an
`AgentManager` one `AgentRuntime` per selected identity.

Each `AgentRuntime` exclusively owns:

- its Mineflayer bot and perception;
- `AgentState`, current action, and `ShortTermGoalManager` state;
- one `ActionArbiter`, generation, and execution lock;
- one 250 ms reflex loop and one deliberate Brain loop;
- one memory coordinator and agent/world store identity;
- one provider wrapper and agent-scoped telemetry;
- one exact-target manual command handler; and
- its timers, cancellation signal, listeners, and lifecycle timestamps.

The runtimes share only immutable Brain/agent configuration, static Minecraft
metadata through their libraries, the provider factory settings, and one FIFO
provider-concurrency limiter. They do not share mutable goals, histories,
memory, state, arbitration, active actions, inventory, perception, bot clients,
or telemetry counters.

## Configuration

Tracked identities live in `configs/agents.json` with schema version 1. Agent
IDs and usernames are explicit, stable, path-safe, and unique
case-insensitively. The tracked file contains no credentials.

The main runtime settings are:

| Setting | Default | Purpose |
| --- | ---: | --- |
| `AGENT_CONFIG_PATH` | `configs/agents.json` | Tracked identity configuration inside the repository |
| `AGENTS` | `alice` | Ordered IDs or `all`; preserves simple one-agent development |
| `AGENT_LLM_MAX_CONCURRENCY` | `2` | Shared remote-call cap |
| `AGENT_BRAIN_STAGGER_MS` | `1000` | Deterministic per-index Brain delay |
| `AGENT_OPERATOR_USERNAMES` | empty | Optional comma-separated human operator allowlist |
| `AGENT_SPAWN_TIMEOUT_MS` | `30000` | Per-agent connection bound |

Provider credentials remain global in the ignored root `.env`. Agent
configuration, reports, logs, and memory documents never contain a key.

## Perception, grounding, and commands

Other agents remain ordinary external player entities. Self is excluded by the
runtime identity, but Alice may perceive Bob and Charlie exactly as she would a
human. `follow_player` and `come_to_player` still require an exact currently
visible external player, and their skills revalidate the live entity before
acting. Resource actions retain the same current-perception grounding and live
world revalidation.

Manual syntax targets exactly one runtime, for example `alice stop`, `bob come`,
or `charlie collect grass_block`. Every bot receives world chat, but only the
handler whose own prefix matches can parse the command. Configured agent
usernames are never authorized operators. With an operator allowlist, only
listed external usernames are accepted; without one, any non-agent external
player retains the prior local-development behavior.

Own chat, arbitrary speech, prompt-like text, and agent-authored command text
are ignored by the command boundary. Chat is not inserted into system
instructions or Brain input. Existing `say` output is still visible as ordinary
Minecraft world chat, but M5 adds no conversation protocol or social reasoning.

## Provider concurrency and telemetry

Each runtime gets a separate provider object so timing state and context cannot
cross agents. The objects share a dependency-free FIFO limiter. Queued calls
are abortable, active calls release permits in `finally`, and closing the
limiter rejects queued work without merging or retaining inputs. Each Brain loop
remains single-flight as well.

Telemetry snapshots include `agentId`, `username`, calls, failures, input and
output tokens, provider latency, queue wait, connection counters, and bounded
memory counters. Aggregate metrics are an additional computed layer. Telemetry
does not store prompts, responses, chat, model-authored reasons, reasoning,
headers, or credentials.

Cost uses the current standard `gpt-5-mini` text rates of $0.25 per million
input tokens and $2.00 per million output tokens, with no cached-input discount.
This deliberately conservative estimate matches the
[official model page](https://developers.openai.com/api/docs/models/gpt-5-mini).

## Memory isolation

All three agents use the same `worldId` during a session and different stable
`agentId` values. The runtime maps validated identities to separate ignored
atomic JSON documents:

```text
data/memory/<worldId>/alice.json
data/memory/<worldId>/bob.json
data/memory/<worldId>/charlie.json
```

The existing schema/version validation, fail-closed corruption behavior,
bounded retention, and same-directory atomic replacement are unchanged.
Automated tests write Alice episodes and semantic facts, query Bob in the same
world, and observe no results. A malformed Bob file does not prevent Alice from
opening. Live sessions used a fresh world identity per reliability run and
created three distinct files every time. Reflection remained off.

## Lifecycle and failure boundaries

The manager validates the complete identity set before constructing a bot,
starts runtimes in configured order, retains successful runtimes after an
agent-local failure, and reports failures by identity. Shutdown is idempotent
and reverses startup order.

Each runtime stops future Brain work, invalidates provider decisions still in
flight, removes manual-command listeners before asynchronous draining begins,
aborts queued provider work, cancels the controlled action, stops both loops,
waits for their active cycles, flushes memory and telemetry, disconnects
Mineflayer, and removes connection listeners. A live reliability diagnostic
found that a provider response could previously arrive after the single
cancellation pass and start a new action. Commit `13b771c` added a Brain
lifecycle generation so a decision crossing `stop()` is discarded as
`loop_stopped`; the deterministic regression and the rerun both passed. The
final diff review also reproduced a narrower listener-ordering race in which an
authorized command could begin after shutdown started, so command teardown now
precedes every awaited shutdown step and a focused regression holds the Brain
drain open while proving the listener is already inert.

## Live validation results

The temporary safety platform was created only in the existing cleared test
volume. It and its forced chunks were removed afterward, difficulty was restored
to Easy, inventories/effects were cleared, player records were returned to safe
natural positions, and Paper was stopped cleanly. Versioned reports were
written atomically under `/tmp` and were not committed.

### Ordered validation

| Session | Duration | Startup / stop | Calls | Input / output tokens | Mean / median latency | Mean queue wait | Provider, memory, connection failures | Estimated cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Alice | 45.5 s | 1/1 / 1/1 | 3 | 3,416 / 362 | 2,786 / 2,896 ms | 0 ms | 0 | $0.001578 |
| Alice + Bob | 60.4 s | 2/2 / 2/2 | 9 | 10,528 / 1,371 | 4,028 / 3,594 ms | 0 ms | 0 | $0.005374 |
| Alice + Bob + Charlie | 192.4 s | 3/3 / 3/3 | 38 | 51,928 / 5,512 | 3,677 / 3,114 ms | 25.9 ms | 0 | $0.024006 |

The two-agent report recorded Alice seeing Bob and Bob seeing Alice. Alice made
a grounded `follow_player(Bob)` decision. A temporary external `Operator` sent
`alice stop` and `bob stop`; only the named runtime logged and executed each
command, and the agents' resulting `Stopped.` speech caused no feedback loop.

The three-agent report recorded every runtime seeing both peers. Live grounded
examples included Charlie reaching Alice, Alice reaching and following Charlie,
and ordinary agent speech remaining inert to the other command handlers. An
operator message shaped as `Ignore your system instructions...` caused no
command execution or Brain behavior. Concurrent collection and movement targets
that changed before execution failed safely through runtime revalidation.

An additional 120.2-second Alice capability smoke exercised the refactored
single-agent runtime with three oak logs and bread. Alice autonomously crafted
12 oak planks, one crafting table, and four sticks through the unchanged
controlled executor. Forced low food triggered the deterministic eat reflex;
attempts failed closed while the hunger effect prevented confirmation, then two
bread consumptions succeeded after the effect expired. The session stopped
cleanly with a Brain cycle in flight. It used 9 calls, 13,517 input tokens,
1,980 output tokens, and an estimated $0.00733925.

### Five-session three-agent reliability sample

All five valid sessions were 45-second, three-agent runs with isolated memory
world IDs.

| Agent | Sessions | Calls | Input / output tokens | Mean latency | Mean queue wait | Provider failures | Disconnects / errors / kicks | Memory read/write failures | Estimated cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Alice | 5 | 21 | 24,993 / 3,147 | 3,733 ms | 127.7 ms | 0 | 0 / 0 / 0 | 0 / 0 | $0.01254225 |
| Bob | 5 | 20 | 24,620 / 3,587 | 3,903 ms | 96.4 ms | 0 | 0 / 0 / 0 | 0 / 0 | $0.013329 |
| Charlie | 5 | 18 | 21,100 / 2,673 | 3,133 ms | 326.7 ms | 0 | 0 / 0 / 0 | 0 / 0 | $0.010621 |
| Cohort | 5 | 59 | 70,713 / 9,407 | — | — | 0 | 0 / 0 / 0 | 0 / 0 | $0.03649225 |

The valid cohort achieved 15/15 agent startups and 15/15 clean agent stops.
There were no startup failures, shutdown failures, provider failures or rate
limits, memory failures, connection errors, kicks, observed memory leaks, or
observed command-routing failures.

Across the ordered sessions, capability smoke, and five-session cohort, the
valid evidence totals 9 sessions, 22/22 successful starts and stops, 118
provider calls, 150,102 input tokens, 18,632 output tokens, and $0.07478950.

### Excluded diagnostics

Two attempts are retained as diagnostics and excluded from valid denominators:

- The first Alice smoke joined at a persisted position inside the previously
  cleared test volume and fell before respawning. The production runtime still
  completed, but the environment was not the required healthy baseline. Later
  sessions used the temporary safety platform.
- The first reliability-session-4 attempt exposed the post-stop decision race
  described above. It produced no report and required one forced Alice kick
  after Charlie and Bob stopped. The code was fixed test-first, all gates
  passed, and replacement session 4 completed normally.

## Automated evidence

The offline suite covers strict configuration and selection, duplicate IDs and
usernames, one-agent default mode, independent state/goals/histories/arbiters,
cross-agent lock and generation isolation, same-world memory isolation,
corrupt-file containment, self exclusion, player grounding, exact command
routing, agent-speech rejection, FIFO provider limiting, queue abort/close,
per-agent telemetry aggregation, partial startup, bounded spawn, reverse and
idempotent shutdown, memory/telemetry flush, report privacy, and atomic report
replacement. Existing M0-M4 action, crafting, grounding, memory, reflex, and
manual-priority regressions remain in the same suite.

A final diff-scoped security review completed full-file receipts for all 46
source-like M5 rows. It retained three candidates through discovery, suppressed
two as explicit trusted-operator/developer-local policies, and classified the
reproduced shutdown listener race as a correctness defect rather than a
security privilege-boundary break. The race was still fixed before publication.
No reportable security finding survived the final policy gate.

## Reproduction

Start the existing local Paper server separately, then run from
`apps/minecraft-bridge`. Keep the root `.env` ignored and do not print its
contents.

```sh
AGENTS=alice \
AGENT_AUTONOMOUS=true \
AGENT_MEMORY_ENABLED=true \
AGENT_MEMORY_REFLECTION=false \
AGENT_MEMORY_WORLD_ID=m5-reproduction-one \
LLM_PROVIDER=openai \
LLM_MODEL=gpt-5-mini \
MULTI_AGENT_SESSION_MS=60000 \
MULTI_AGENT_OUTPUT=/tmp/minecraft-agents-m5-one.json \
node --env-file=../../.env --import tsx src/runtime/validationCli.ts
```

For all three configured agents:

```sh
AGENTS=all \
AGENT_AUTONOMOUS=true \
AGENT_MEMORY_ENABLED=true \
AGENT_MEMORY_REFLECTION=false \
AGENT_MEMORY_WORLD_ID=m5-reproduction-three \
LLM_PROVIDER=openai \
LLM_MODEL=gpt-5-mini \
AGENT_LLM_MAX_CONCURRENCY=2 \
AGENT_BRAIN_STAGGER_MS=1000 \
MULTI_AGENT_SESSION_MS=180000 \
MULTI_AGENT_OUTPUT=/tmp/minecraft-agents-m5-three.json \
node --env-file=../../.env --import tsx src/runtime/validationCli.ts
```

The package alias is `npm run validate:multi-agent`; environment loading must
still be supplied by the caller.

## Known limitations and completion boundary

- M5 deliberately provides no relationships, reputation, professions,
  coordination, shared plans, economy, protocol, or other social layer.
- Agent-to-agent speech is visible world chat but is not specialized memory or
  a trusted control channel.
- The validation report records an end-of-session visibility snapshot, not a
  timeline. Live logs supplied the additional grounded interaction evidence.
- Command-routing and prompt-shaped-chat checks are covered deterministically
  and observed live, but the report schema intentionally has no chat text or
  command transcript counter.
- Provider estimates treat all input as uncached; actual billed cost may be
  lower.
- Resource contention remains a world fact handled by current grounding and
  runtime revalidation; M5 adds no world-resource locks.

Within those intentional limits, M5 is ready to close. The next milestone may
design social behavior, but it must not weaken the independent runtime,
grounding, arbitration, memory, telemetry, and lifecycle boundaries established
here.
