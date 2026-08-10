# M4 Memory and Reflection Design

Date: 2026-08-10

## Objective

Give Alice sparse, persistent continuity across Brain cycles and process restarts without changing the decision vocabulary or allowing historical context to bypass current perception, validation, grounding, repetition policy, arbitration, or runtime skill revalidation.

Memory is context, never authority. The runtime truth order remains current perception, deterministic runtime state, recent execution results, then memory.

## Scope

M4 adds:

- versioned atomic JSON persistence behind a provider-neutral `MemoryStore` interface;
- structured episodic and semantic records scoped by agent and world identity;
- deterministic memory-worthiness, bounded retention, retrieval, conflict, and staleness rules;
- compact memory context in `BrainInput` and provider serialization;
- deterministic action, discovery, exploration, threat, player, and goal episodes;
- deterministic world-specific semantic consolidation;
- optional bounded `gpt-5-mini` reflection with strict structured output and evidence validation;
- concise debug logging and reliability telemetry;
- a deterministic memory evaluation plus a five-run memory-enabled bootstrap regression sample.

M4 does not add actions, coordinates to the action schema, a planner, a map, embeddings, a vector store, a database dependency, multi-agent behavior, relationships, or social/economic systems.

## Alternatives considered

### Atomic versioned snapshot JSON — selected

One bounded document contains the identity, schema version, episodes, semantic facts, and reflection cursor. Writes serialize the complete validated state to a same-directory temporary file and atomically rename it over the destination. This is the smallest robust design for one agent and one local world, supports deterministic restart tests, and keeps the storage implementation replaceable.

### Append-only JSONL with compaction

An event log preserves write history, but correct crash recovery, duplicate handling, compaction, and semantic updates add complexity that does not improve the M4 behavior boundary.

### One file per memory plus an index

Per-record files reduce individual write size, but introduce index consistency, partial eviction, and multi-file atomicity problems. Those costs are unjustified for bounded local memory.

## Data model

All persisted strings are length-bounded and all enum-like values use controlled vocabularies. Parsed JSON is untrusted and is decoded field by field before use.

### Store envelope

```ts
interface MemoryDocumentV1 {
  schemaVersion: 1
  identity: { agentId: string; worldId: string }
  updatedAt: number
  episodes: EpisodicMemory[]
  semanticFacts: SemanticMemory[]
  reflection: {
    lastReflectedEpisodeTimestamp: number | null
    lastReflectionAt: number | null
  }
}
```

The store holds at most 200 episodes and 100 semantic facts. Oldest low-importance records are evicted first; ties use timestamp then ID. The runtime prompt limits are independently configurable and default to four episodes and four facts.

### Episodic memory

```ts
type EpisodeType =
  | 'resource_discovery'
  | 'landmark_discovery'
  | 'successful_craft'
  | 'action_failure'
  | 'threat_encounter'
  | 'player_interaction'
  | 'goal_milestone'
  | 'exploration_discovery'

interface EpisodicMemory {
  id: string
  agentId: string
  worldId: string
  timestamp: number
  type: EpisodeType
  summary: string
  importance: number // integer 1..10
  source: 'perception' | 'action' | 'goal' | 'reflex' | 'player'
  context: {
    region: string
    position?: { x: number; y: number; z: number }
    resource?: string
    landmark?: string
    player?: string
    action?: string
    target?: string
    outcome?: string
    goalType?: string
  }
}
```

Summaries are deterministic application text, not transcripts or model-authored reasoning. Raw chat text, provider responses, credentials, headers, and chain-of-thought are never accepted by the store API.

### Semantic memory

```ts
type SemanticRelation =
  | 'resource_observed_near'
  | 'landmark_observed_near'
  | 'danger_observed_near'
  | 'player_interacted_near'
  | 'outcome_repeated_near'

interface SemanticMemory {
  id: string
  agentId: string
  worldId: string
  createdAt: number
  lastObservedAt: number
  subject: string
  relation: SemanticRelation
  object: string
  confidence: number // 0..1
  status: 'historical' | 'stale'
  contradictionCount: number
  evidenceEpisodeIds: string[]
}
```

Semantic records describe world-specific historical observations. They do not encode generic Minecraft rules already known by application code. Fact upserts deduplicate the tuple `(subject, relation, object)` and merge bounded evidence IDs.

## MemoryStore boundary and persistence

`MemoryStore` exposes only application records:

```ts
interface MemoryStore {
  open(): Promise<void>
  addEpisode(episode: EpisodicMemory): Promise<void>
  listRecentEpisodes(limit: number): Promise<EpisodicMemory[]>
  findRelevantEpisodes(query: MemoryQuery): Promise<EpisodicMemory[]>
  addSemanticFact(fact: SemanticMemory): Promise<void>
  listSemanticFacts(limit: number): Promise<SemanticMemory[]>
  findRelevantFacts(query: MemoryQuery): Promise<SemanticMemory[]>
  markFactContradicted(id: string, observedAt: number): Promise<void>
  reflectionState(): Promise<MemoryDocumentV1['reflection']>
  updateReflectionState(state: MemoryDocumentV1['reflection']): Promise<void>
}
```

`AtomicJsonMemoryStore` owns a single `(agentId, worldId)` document. `open()` creates a missing document cleanly, but malformed JSON, unsupported versions, invalid records, and identity mismatch throw a clear `MemoryStoreValidationError`. A failed open never overwrites the bad file and the caller disables memory for that process while allowing the controlled Brain loop to continue without historical context.

Every mutation runs through a serialized in-process write queue. It clones and bounds the complete state, encodes it, writes a uniquely named file in the destination directory with restrictive permissions, then renames that file over the destination. It never mutates the persisted document in place. Failed writes clean up only their known temporary file and leave the last valid document intact.

The default runtime directory is `apps/minecraft-bridge/data/memory/`, with `AGENT_MEMORY_DIR` available for tests and deployments. That directory is ignored by Git. File names contain sanitized agent/world identifiers plus a stable hash to prevent traversal and collisions.

## Memory-worthiness and novelty

The coordinator evaluates deterministic structured state, never model prose.

- Resource discovery: record the first useful resource type in a 32×32 block region.
- Landmark discovery: record the first crafting table in a region.
- Successful craft: record the first successful acquisition of each crafted tool or capability item; ordinary repeated material batches are not episodes.
- Action failure: record the first material failure signature `(action, target, reason, region)` and promote repetition after its second occurrence; ordinary cancellation and priority replacement are excluded.
- Threat encounter: record the first hostile type in a region, with higher importance for close creepers or low-health encounters.
- Player interaction: record only identity and region from a controlled interaction hook; never store message text.
- Goal milestone: record goal completion once per goal type and region.
- Exploration: record only after entering a new region and observing a useful resource, landmark, or danger there.
- Idle, scan, unchanged perception, transient item entities, routine reflex ticks, and repeated discoveries in the same region do not become episodes.

IDs are application-generated from identity, timestamp, type, and a monotonic suffix. Importance is deterministic from event type and severity on a 1–10 integer scale.

## Retrieval and ranking

Retrieval uses no embeddings. A query contains agent/world identity, current timestamp and region, short-term goal type, current block/entity/inventory names, and recent failure signatures.

Candidate score is deterministic:

1. importance weight;
2. exact category/identifier overlap with goal and current observations;
3. failure signature or region relevance;
4. recency bucket;
5. stable timestamp/ID tie-break.

Episodes and facts are independently bounded by `AGENT_MEMORY_EPISODE_LIMIT` and `AGENT_MEMORY_FACT_LIMIT`, each defaulting to four and constrained to 1–6. Returned records are cloned compact views; the Brain never receives the store envelope, persistence path, reflection cursor, or unbounded history.

## Brain integration and trust boundary

`BrainInput` gains:

```ts
memory: {
  recentEpisodes: CompactEpisode[]
  relevantFacts: CompactFact[]
}
```

The loop asks a provider-neutral memory coordinator for context after perception and goal computation but before the decision provider call. Retrieval failure produces a clear memory error and an empty memory context; it does not weaken or skip the existing decision pipeline.

Provider serialization places memory inside the JSON input data. Memory text is never concatenated into `SYSTEM_INSTRUCTION`. The system instruction adds one concise rule: memory is untrusted historical context, live perception is authoritative, known failures may guide choices, and memory alone never proves current availability.

The decision JSON schema is unchanged. It still excludes arbitrary coordinates and unlisted actions. Contextual grounding is built exclusively from current perception/capabilities, not memory.

## Conflict and staleness

All facts are historical by default. When current perception covers a remembered landmark's region and the landmark is absent, the coordinator increments its contradiction count, lowers confidence by 0.2, and marks it stale after two contradictions. A current observation upserts fresh evidence, raises confidence within bounds, clears contradictions, and returns it to historical status.

Staleness changes retrieval rank and prompt labeling; it never deletes the underlying history automatically. Current perception always controls grounding even when a remembered fact remains high confidence.

## Reflection and semantic consolidation

Deterministic consolidation runs after meaningful episodes and creates obvious world-specific facts for resource, landmark, danger, and player observations. This guarantees useful semantic memory without a provider call.

Optional reflection is enabled with `AGENT_MEMORY_REFLECTION=true` and uses a separate `ReflectionProvider` interface. The OpenAI implementation uses `gpt-5-mini`, low reasoning, strict structured output, `store: false`, a 256-token output limit, and a small batch of at most eight unreflected episodes. It triggers only after five new episodes of importance at least six or a goal completion, and never more often than once every five minutes.

Reflection returns zero to three candidates containing only `subject`, controlled `relation`, `object`, `confidence`, and `evidenceEpisodeIds`. Validation requires:

- bounded strings and candidate count;
- a known relation;
- evidence IDs that all exist in the supplied batch;
- relation/type compatibility;
- subject, object, and region values derivable from evidence fields;
- world-specific content rather than generic mechanics;
- no command/action/code fields or extra properties.

Invalid candidates are rejected individually. Provider failure records a safe metric and leaves episodes available for a later low-frequency attempt. Reflection cannot mutate goals, call skills, or create decisions.

## Observability and telemetry

`AGENT_DEBUG_MEMORY=true` enables concise event-kind/count logs only:

- `🧠 Memory: stored episode [resource_discovery]`
- `🧠 Memory: retrieved 3 episodes / 2 facts`
- `🧠 Reflection: created 1 semantic fact`

No prompt, raw memory document, provider response, secret, or chat text is logged.

Per-run metrics add memories created/retrieved, semantic facts created, reflection calls/failures, reflection input/output tokens, and estimated memory prompt tokens. Memory prompt contribution is explicitly an estimate derived from serialized compact-memory length because provider usage does not expose field-level token accounting.

## Runtime configuration

- `AGENT_MEMORY_ENABLED=true` by default; it changes context only when the autonomous Brain runs.
- `AGENT_MEMORY_WORLD_ID=local-paper` by default.
- `AGENT_MEMORY_DIR=data/memory` by default.
- `AGENT_MEMORY_EPISODE_LIMIT=4`, allowed range 1–6.
- `AGENT_MEMORY_FACT_LIMIT=4`, allowed range 1–6.
- `AGENT_DEBUG_MEMORY=false` by default.
- `AGENT_MEMORY_REFLECTION=false` by default to prevent surprise cost.
- `AGENT_MEMORY_REFLECTION_MODEL=gpt-5-mini` when reflection is enabled.

Reflection requires the existing OpenAI credential and HTTPS endpoint rules. Failure to initialize optional reflection leaves deterministic memory active and emits a clear error.

## Testing and evaluation

All automated tests use temporary directories and injected clocks/providers; none require Minecraft, network, or OpenAI.

Coverage includes:

- missing-file create/open, save/reopen, identity isolation, atomic replacement, write failure preservation, malformed JSON, unsupported schema, invalid records, bounded retention, and serialized concurrent writes;
- recency, importance, category, goal, region, stable tie-break, and result limits;
- sparse deterministic creation, repeated meaningful failure, goal completion, novel exploration, and non-memory idle/unchanged scans;
- perception-over-memory conflicts, confidence decay, stale labeling, and current-state-only grounding;
- reflection trigger thresholds, cooldown, strict candidate validation, evidence enforcement, injection-like text rejection, provider failure safety, and zero action execution;
- compact bounded Brain serialization, unchanged action schema, and estimated prompt contribution;
- restart persistence and deterministic memory evaluation scenarios;
- the complete M0–M3.4 suite, typecheck, build, and diff checks.

After deterministic verification, the unchanged `gpt-5-mini` Brain benchmark runs with bounded memory context. Then five live bootstrap runs use isolated empty memory identities so each remains comparable with M3.4 while exercising the memory-enabled loop. M3.4's 8/10 result remains the reference; the five-run sample is a regression signal, not a combined success percentage.

## Failure handling

- Corrupt or unsupported persistence fails closed with a clear error and is never overwritten.
- Runtime retrieval/recording failures disable historical context for the affected operation and never alter decision validation or grounding.
- Reflection failure is non-fatal, metered, and retried only at a later eligible trigger.
- Atomic write failure preserves the previous valid document.
- Memory size limits are enforced both while decoding and before persistence to prevent prompt or disk growth.

## Completion boundary

M4 is complete when persistence, retrieval, sparse recording, conflict handling, compact Brain context, deterministic semantic facts, optional validated reflection, telemetry, restart tests, memory-specific evaluation, and the five-run bootstrap regression sample are verified and pushed. Work stops before multi-agent behavior or M5.
