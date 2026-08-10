# M6 Social Interaction Foundation Design

Date: 2026-08-10

## Objective and boundary

M6 lets configured Minecraft agents recognize one another, conduct bounded
pairwise conversations, retain perspective-specific social memories, and build
minimal directed relationship state from verified application events. It is a
safe social substrate, not a society simulation. It adds no professions,
organizations, economy, shared goals, delegated work, group conversations,
social reflection, planning architecture, new Minecraft actions, or M7
behavior.

All M5 guarantees remain authoritative: each `AgentRuntime` owns its bot,
state, goals, arbiter, loops, memory, telemetry, and lifecycle; world actions
retain Manual > Reflex > LLM priority; current perception grounds targets; and
provider output remains untrusted data that cannot invoke tools or skills.

## Approaches considered

### Manager-owned coordinator with runtime-owned adapters — selected

A single `ConversationCoordinator` owns only the cross-runtime facts that must
be shared: active pair membership, deterministic turn ownership, cooldowns,
session budgets, timeouts, and lifecycle generations. Each runtime owns its
social provider, cognitive gate, relationship document, social-memory writer,
telemetry, perception callback, and chat sender. The coordinator sees these
through narrow participant adapters and never receives arbitrary Mineflayer or
skill access.

This preserves M5 isolation while giving a pairwise session one authoritative
owner. It also makes third-party rejection, one-session-per-agent enforcement,
shutdown invalidation, and loop prevention deterministic.

### Conversation logic inside each Brain loop

This would reuse scheduling code, but two independent loops could race over
turn ownership, duplicate sessions, or treat global Minecraft chat as a
control channel. It would also couple social output to `AgentDecision`, which
M6 explicitly forbids.

### Central multi-agent Brain

A central model could see every participant, but it would violate per-agent
memory and cognition ownership, enlarge the prompt trust boundary, and create
the shared planning architecture reserved for later milestones.

## Verified social events and unverified claims

`SocialEvent` is an immutable application record with a generated ID, world
ID, timestamp, type, observer, actor, optional target and conversation IDs,
verification flag, bounded evidence discriminator, and bounded metadata.
Decoding rejects extra fields, invalid identities, impossible self-targets,
invalid timestamps, and provenance/type mismatches.

M6 supports only events whose attribution is available now:

- `agent_seen` is verified from the observer's live Mineflayer perception of a
  configured external player;
- `conversation_started`, `conversation_completed`, and
  `conversation_interrupted` are verified from coordinator-owned lifecycle
  state;
- `agent_speech_observed` attributes bounded text to the Minecraft chat
  speaker but is always `verified: false`, because its semantic claims are not
  world facts.

M6 does not create verified help, harm, following, item-given, or item-received
events. Existing data cannot reliably prove intent or item attribution. Model
interpretation can never create or upgrade a verified event. Truth priority is
live perception, verified runtime event, deterministic state, historical
verified memory, then unverified utterance.

Repeated `agent_seen` events are keyed by world, observer, and actor and
suppressed for the configured social cooldown. Conversation lifecycle IDs make
start and terminal events idempotent.

## Directed relationships

Each observer owns an independent `RelationshipRecord` for each configured
external target in the same world:

```text
observerAgentId, targetAgentId, worldId,
familiarity: 0..100,
trust: -100..100,
affinity: -100..100,
reciprocity: -100..100,
interactionCount: non-negative integer,
lastInteractionAt, lastVerifiedEventAt, updatedAt
```

An LLM never writes these fields. Named deterministic deltas are:

- first verified `agent_seen` after cooldown: familiarity `+1`;
- verified normal `conversation_completed`: familiarity `+2` and
  interaction count `+1`.

All values are clamped. Unverified speech, provider failure, invalid output,
timeout, shutdown, manual interruption, and danger interruption cause no
numeric update. Trust, affinity, and reciprocity remain neutral in M6 because
reliable help/harm attribution is intentionally unsupported. Alice to Bob and
Bob to Alice are separate records and may diverge.

## Relationship persistence

`RelationshipStore` hides storage from runtimes and the Brain.
`AtomicJsonRelationshipStore` uses the established dependency-free pattern:
validate the complete document, write a mode-0600 same-directory temporary
file, then rename it over the destination. It never edits persisted JSON in
place.

The ignored layout is:

```text
data/social/<worldId>/<observerAgentId>.json
```

Documents include schema version 1, exact world and observer identity,
`updatedAt`, and at most 100 configured-target records. Restricted identity
alphabets and post-resolution containment checks prevent traversal. Missing
files are created. Malformed JSON, unsupported versions, identity mismatches,
invalid targets, and out-of-range fields fail closed without replacement.
Serialized mutation queues and `flush()` match the memory-store durability
boundary. A corrupt Bob document fails Bob's social startup without being read
or rewritten by Alice.

## Conversation coordinator and session lifecycle

`ConversationCoordinator` is created by production composition and registered
as a shared manager-level service. Runtime participants register only after
their bot, social resources, command listener, and reflex/Brain loops are
ready. A participant exposes identity, bounded current context, visibility and
danger checks, social generation, safe chat emission, event recording,
relationship updates, telemetry callbacks, and cancellation generation. It
does not expose a bot, arbiter, goal manager, memory store, or skill executor.

A session has exactly two distinct configured participants, a unique random
ID, initiator, current speaker and recipient, creation/deadline timestamps,
turn count, provider-call count, maximum turns, maximum calls, lifecycle
generation, and terminal reason. An agent can belong to at most one active
session. Pair keys suppress duplicate and cooldown-bypassing creation.

The coordinator alternates turns deterministically, starting with the
initiator. It validates visibility and safety before each request and again
before emitting chat. Each accepted response emits one bounded chat message,
records an unverified utterance for both perspectives, and either advances to
the other participant or closes. It closes on validated farewell/decline,
`continueConversation: false`, maximum turns, session-call budget, timeout,
participant disappearance, manual/reflex interruption, provider error,
invalid output, participant removal, or shutdown. Responses whose session
generation changed while awaiting the provider are discarded.

Only the coordinator advances a session. Global Minecraft chat never advances
turn ownership; it is merely untrusted observation. Own chat is ignored,
non-members cannot join, ordinary `say` never creates a session, and no agent
can participate in overlapping pairs.

## Triggers and operator command

Social behavior is disabled by default. With social enabled, supported starts
are:

- exact trusted-operator command `<speaker> talk <target>`;
- first meaningful verified encounter after the pair cooldown when automatic
  greeting is explicitly enabled.

Ambient or overheard chat never starts a session. The command parser adds only
the exact `talk` form. The addressed runtime must match the speaker exactly,
the target must be a different configured agent and currently visible, and
both must be idle for conversation. Configured-agent usernames remain excluded
from the operator authorizer, so agent speech, prompt-shaped text, invalid
targets, and busy targets cannot initiate. Starting a session changes no
relationship number by itself.

## Social response contract and provider

`SocialResponse` is separate from `AgentDecision`:

```json
{
  "message": "short in-world utterance",
  "intent": "greet|reply|acknowledge|thank|decline|farewell",
  "continueConversation": true
}
```

The validator accepts `unknown`, requires the exact three-field object,
enforces the configured character limit, rejects empty/control-character or
command-shaped text, URLs, coordinates, code fences, shell/code fragments,
function-call syntax, action/tool fields, and unsupported intents. It never
casts raw output. The final emission also passes the existing defensive `say`
boundary.

`SocialProvider` is provider-neutral. The OpenAI implementation uses the
Responses API with `gpt-5-mini`, `store: false`, low reasoning, strict JSON
schema, no tools, no web search, no code execution, a short output limit, a
bounded timeout, and an abort signal. It returns `unknown`; it exposes only
token timing metadata. Errors contain HTTP/status categories only, never
response bodies, refusal text, reasoning, headers, prompts, or credentials.

The system instruction defines one Minecraft inhabitant speaking to one
visible configured inhabitant. Current verified context is authoritative.
Prior utterances and memory are serialized inside a clearly named untrusted
JSON data object; they are never concatenated into instructions. The prompt
forbids fabricated verified events, user-assistant behavior, instructions,
actions, tools, code, and commands, and requests farewell when the session
should close.

## Cognitive scheduling and world-action priority

Each runtime owns one `CognitiveGate`. Ordinary Brain generation and social
generation acquire it exclusively. Entering a social session suppresses new
Brain cycles; an in-flight Brain provider result becomes stale before action
execution. Closing the session releases suppression, so the normal Brain
schedule resumes without permanent busy state. The shared FIFO provider
limiter continues to bound cohort-wide Brain and social calls.

The social gate does not enter `ActionArbiter` and gains no world-action
authority. Manual > Reflex > LLM remains unchanged. Manual activity and urgent
reflex decisions invalidate the runtime's social generation and close its
active session. Reflex evaluation stays immediate and never waits for the
cognitive gate. A delayed social response after manual override, reflex,
session closure, runtime stop, or manager shutdown is discarded before chat,
memory, or relationship effects.

## Social memory and Brain context

The existing per-agent memory coordinator gains a narrow `recordSocial`
operation. It stores bounded perspective-specific episodes for verified
encounters, conversation start/completion/interruption, and recent attributed
utterances. Utterance episodes retain speaker, recipient, conversation ID, a
bounded message, and `verified: false`; they never become semantic facts.
Conversation summaries contain counts and outcomes, not unlimited transcripts.
Reflection stays disabled for social material.

Before an ordinary Brain request, the runtime supplies compact owned social
context only for currently visible configured external agents. Numeric values
become small categorical labels (`unknown|familiar`,
`negative|neutral|positive`) plus interaction count, last verified interaction,
and at most one bounded recent unverified utterance. Raw documents and
transcripts are never included. Invisible agents are omitted and memory cannot
make them targetable. Existing player grounding and action vocabulary remain
unchanged.

## Configuration and telemetry

Strict configuration adds:

- `AGENT_SOCIAL_ENABLED=false`;
- `AGENT_SOCIAL_AUTO_GREETING=false`;
- `AGENT_SOCIAL_MODEL=gpt-5-mini`;
- `AGENT_SOCIAL_MAX_TURNS=4` with range `1..8`;
- `AGENT_SOCIAL_COOLDOWN_MS=60000` with range `1000..3600000`;
- `AGENT_SOCIAL_TURN_TIMEOUT_MS=15000` with range `1000..60000`;
- `AGENT_SOCIAL_MAX_MESSAGE_CHARS=180` with range `32..256`;
- `AGENT_SOCIAL_DIR=data/social`.

Enabling social mode requires the existing OpenAI key. It does not require
ordinary autonomy. Reflection remains independently disabled. The real `.env`
is never modified; `.env.example` documents only placeholders and safe
defaults.

Agent-scoped social telemetry counts starts, completions, timeouts,
interruptions, generated turns, invalid outputs, provider failures/calls,
tokens, latency, queue wait, budget exhaustion, loop-prevention rejections,
relationship updates by verified event category, episodes, and stale outputs.
It stores no prompts, responses, transcripts, reasoning, headers, or secrets.
The reliability report derives aggregate mean/median turns, failure rates, and
cost from immutable snapshots.

## Shutdown

`AgentManager.stopAll()` first invokes one idempotent shared prepare-stop hook.
The coordinator stops accepting sessions, invalidates every session, aborts
queued/in-flight social requests, and prevents further chat emission. Each
runtime then removes command/social listeners before any asynchronous drain,
stops loops, invalidates cognition, cancels its world action, waits for active
work, flushes relationship and memory mutations, flushes telemetry, quits the
bot, and removes connection listeners. The manager finally closes the
coordinator and provider limiter exactly once. Aggregate errors remain
identity-attributed and do not skip later cleanup.

## Testing and validation

All automated tests are deterministic, dependency-free, and offline. They
cover strict event provenance, unverified claims, deduplication, directed and
isolated persistence, atomic replacement, corruption/version/path failures,
deterministic clamped updates, social memory perspective, strict provider and
response contracts, injection containment, exact operator initiation,
pair/busy/cooldown/turn/timeout limits, third-party exclusion, runaway-loop
prevention, cognitive exclusion, stale-result rejection, reflex/manual/shutdown
races, telemetry privacy, and all M0-M5 regressions.

Live validation uses the existing Paper world and `gpt-5-mini`, with memory
reflection off. It records Paper's initial state, validates Alice alone, at
least five stable Alice/Bob sessions, and at least five stable three-agent
sessions. It proves pairwise membership, independent relationships and memory,
restart persistence, operator routing, injection containment, reflex
interruption, Brain resumption, and clean shutdown. All M6 live calls share a
hard counter capped at 300 and conservative estimated cost capped below $1.00.
Processes and temporary fixtures are cleaned up, and Paper is restored to its
initial state.

Final gates are the full test suite, typecheck, build, memory benchmark, both
diff checks, a diff-scoped security review, clean/ignored secret and runtime
data checks, pushed branch parity, and a draft-only PR. M6 stops before M7.
