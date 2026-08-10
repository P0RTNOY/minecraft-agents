# M4 Memory and Reflection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add sparse persistent episodic and semantic memory, bounded retrieval, safe low-frequency reflection, and measurable Brain integration without changing Alice's action vocabulary or trust hierarchy.

**Architecture:** A provider-neutral `MemoryStore` is implemented by one schema-versioned atomic JSON snapshot scoped to agent/world identity. A deterministic `AgentMemoryCoordinator` retrieves compact context before each decision and records meaningful structured outcomes afterward; optional reflection uses a separate strict-schema provider and evidence validator. The existing Brain continues to validate and ground actions only against current perception.

**Tech Stack:** TypeScript 7, Node.js 22 built-in filesystem/crypto APIs, Node test runner, existing fetch-based provider patterns, no new dependencies.

## Global Constraints

- Preserve `unknown → validation → grounding → repetition → arbitration → controlled skill → runtime revalidation`.
- Memory is untrusted data and never changes the decision schema, allowed actions, goals, or grounding context.
- Current perception always outranks memory.
- Do not store transcripts, raw provider responses, credentials, authorization headers, `.env` contents, or chain-of-thought.
- Runtime memory lives under an ignored directory and every persisted write is a complete temporary-file-plus-rename replacement.
- Automated tests require no Minecraft, network, or OpenAI.
- Use strict red-green TDD for every production behavior.

---

### Task 1: Structured records and atomic JSON persistence

**Files:**
- Create: `apps/minecraft-bridge/src/memory/types.ts`
- Create: `apps/minecraft-bridge/src/memory/validate.ts`
- Create: `apps/minecraft-bridge/src/memory/store.ts`
- Create: `apps/minecraft-bridge/src/memory/store.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces `EpisodicMemory`, `SemanticMemory`, `MemoryIdentity`, `MemoryDocumentV1`, `MemoryQuery`, `MemoryStore`, `AtomicJsonMemoryStore`, and `MemoryStoreValidationError`.
- `AtomicJsonMemoryStore` accepts `{ filePath, identity, maxEpisodes?, maxFacts?, now?, fs? }`; filesystem injection is limited to the exact operations needed to prove atomic replacement.

- [ ] **Step 1: Write failing persistence and validation tests**

```ts
it('creates a missing versioned store and survives reopen', async () => {
  const first = new AtomicJsonMemoryStore({ filePath, identity })
  await first.open()
  await first.addEpisode(episode({ id: 'episode-1' }))
  const reopened = new AtomicJsonMemoryStore({ filePath, identity })
  await reopened.open()
  assert.deepEqual(await reopened.listRecentEpisodes(4), [episode({ id: 'episode-1' })])
})

it('rejects malformed JSON, unsupported versions, and identity mismatch without overwriting', async () => {
  await writeFile(filePath, '{broken')
  await assert.rejects(() => store.open(), MemoryStoreValidationError)
  assert.equal(await readFile(filePath, 'utf8'), '{broken')
})
```

Cover create/open, save/reopen, same-directory temporary write followed by rename, failed rename preserving the prior document, unsupported schema version, invalid fields, agent/world isolation, serialized concurrent additions, and bounded eviction.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --import tsx --test src/memory/store.test.ts`

Expected: module-not-found failure for `src/memory/store.ts`.

- [ ] **Step 3: Implement bounded record types and skeptical decoder**

```ts
export const MEMORY_SCHEMA_VERSION = 1 as const
export interface MemoryIdentity { agentId: string; worldId: string }
export interface MemoryDocumentV1 {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION
  identity: MemoryIdentity
  updatedAt: number
  episodes: EpisodicMemory[]
  semanticFacts: SemanticMemory[]
  reflection: ReflectionCursor
}

export function decodeMemoryDocument(
  value: unknown,
  expectedIdentity: MemoryIdentity
): MemoryDocumentV1
```

Validate exact controlled types, finite coordinates/timestamps/confidence, integer importance/counts, safe bounded identifiers/summaries, evidence limits, collection limits, and identity equality. Reject unknown schema versions before inspecting records.

- [ ] **Step 4: Implement atomic store writes and retention**

```ts
private async persist(next: MemoryDocumentV1): Promise<void> {
  const encoded = JSON.stringify(next, null, 2) + '\n'
  const temporary = `${this.filePath}.${randomUUID()}.tmp`
  await this.fs.writeFile(temporary, encoded, { encoding: 'utf8', mode: 0o600 })
  await this.fs.rename(temporary, this.filePath)
}
```

Create the parent directory, serialize mutations through a promise queue, validate before every write, remove only the known temporary file after failure, and evict by importance/timestamp/ID while preserving high-importance records.

- [ ] **Step 5: Ignore only runtime memory state**

Add `apps/minecraft-bridge/data/memory/` to the root `.gitignore`; do not ignore source fixtures or all JSON files.

- [ ] **Step 6: Run focused tests until GREEN**

Run: `node --import tsx --test src/memory/store.test.ts`

Expected: all persistence tests pass with no warnings.

- [ ] **Step 7: Commit the persistence component**

```sh
git add .gitignore apps/minecraft-bridge/src/memory/types.ts apps/minecraft-bridge/src/memory/validate.ts apps/minecraft-bridge/src/memory/store.ts apps/minecraft-bridge/src/memory/store.test.ts
git commit -m "feat: add atomic episodic memory store"
```

### Task 2: Deterministic retrieval, conflict handling, and compact views

**Files:**
- Create: `apps/minecraft-bridge/src/memory/retrieval.ts`
- Create: `apps/minecraft-bridge/src/memory/retrieval.test.ts`
- Modify: `apps/minecraft-bridge/src/memory/store.ts`
- Modify: `apps/minecraft-bridge/src/memory/types.ts`

**Interfaces:**
- Produces `rankEpisodes`, `rankSemanticFacts`, `compactEpisode`, `compactFact`, `reconcileFactWithPerception`, and `EMPTY_MEMORY_CONTEXT`.
- Store `findRelevantEpisodes`/`findRelevantFacts` delegate to deterministic rankers and return cloned bounded results.

- [ ] **Step 1: Write failing ranking and conflict tests**

```ts
it('ranks bounded goal/category matches ahead of merely recent memories', () => {
  const ranked = rankEpisodes([recentIdleFailure, olderOakDiscovery], {
    ...query,
    goalType: 'explore_for_resources',
    observedNames: ['oak_log']
  }, 1)
  assert.equal(ranked[0]?.id, olderOakDiscovery.id)
})

it('marks an absent remembered landmark stale only after two covered contradictions', () => {
  const once = reconcileFactWithPerception(tableFact, contradiction)
  const twice = reconcileFactWithPerception(once, contradiction)
  assert.equal(twice.status, 'stale')
  assert.equal(twice.confidence, 0.6)
})
```

Cover importance, recency buckets, category/goal/region matches, stable ties, 1–6 limits, stale-fact penalty, current observation refresh, and cloned outputs.

- [ ] **Step 2: Run focused test and verify RED**

Run: `node --import tsx --test src/memory/retrieval.test.ts`

Expected: module-not-found failure for `src/memory/retrieval.ts`.

- [ ] **Step 3: Implement transparent scoring and compact presentation**

```ts
const score = episode.importance * 100
  + categoryScore(episode, query)
  + regionScore(episode, query)
  + recencyScore(episode.timestamp, query.now)
```

Use only explicit query fields and stable tie-breakers. Compact views include type/relation, deterministic summary or tuple, importance/confidence/status, age bucket, and optional historical region; they omit persistence metadata and reflection state.

- [ ] **Step 4: Implement contradiction updates**

Only landmark/resource facts whose remembered region is covered by the current bounded perception are eligible for contradiction. One contradiction lowers confidence; the second marks stale. Matching live evidence refreshes `lastObservedAt`, confidence, and status.

- [ ] **Step 5: Run Task 1–2 tests until GREEN**

Run: `node --import tsx --test src/memory/store.test.ts src/memory/retrieval.test.ts`

- [ ] **Step 6: Commit retrieval and conflict behavior**

```sh
git add apps/minecraft-bridge/src/memory/types.ts apps/minecraft-bridge/src/memory/store.ts apps/minecraft-bridge/src/memory/retrieval.ts apps/minecraft-bridge/src/memory/retrieval.test.ts
git commit -m "feat: retrieve relevant agent memories"
```

### Task 3: Sparse episode recording and deterministic semantic consolidation

**Files:**
- Create: `apps/minecraft-bridge/src/memory/recorder.ts`
- Create: `apps/minecraft-bridge/src/memory/recorder.test.ts`
- Create: `apps/minecraft-bridge/src/memory/coordinator.ts`
- Create: `apps/minecraft-bridge/src/memory/coordinator.test.ts`

**Interfaces:**
- `MemoryEventRecorder.observe(before, after, decision, result, goalTransition)` returns zero or more application-defined episodes.
- `AgentMemoryCoordinator.retrieve(inputWithoutMemory)` returns `MemoryContext` and metrics.
- `AgentMemoryCoordinator.record(event)` persists episodes, consolidates obvious world facts, and returns metrics.

- [ ] **Step 1: Write failing sparse-recording tests**

```ts
it('records the first useful resource in a region but not an unchanged scan', () => {
  assert.equal(recorder.observeDiscovery(perceptionWithOak).length, 1)
  assert.equal(recorder.observeDiscovery(perceptionWithOak).length, 0)
})

it('records a repeated material failure and ignores cancellation', () => {
  recorder.observeOutcome(input, collectStone, missingTool)
  const second = recorder.observeOutcome(input, collectStone, missingTool)
  assert.equal(second[0]?.type, 'action_failure')
  assert.deepEqual(recorder.observeOutcome(input, explore, cancelled), [])
})
```

Cover first useful resource/table/threat/player, first crafted tool, goal completion, new-region exploration with useful observations, repeated failure, idle, scan, unchanged perception, ordinary material craft, and priority/cancellation outcomes.

- [ ] **Step 2: Run recorder tests and verify RED**

Run: `node --import tsx --test src/memory/recorder.test.ts`

- [ ] **Step 3: Implement deterministic event construction**

Use 32-block region keys, controlled signatures, deterministic summaries, integer importance, sanitized registry/player names, and a monotonic ID factory injected for tests. Never accept provider-authored reason text as summary content.

- [ ] **Step 4: Write failing coordinator/consolidation tests**

Prove that resource/landmark/danger/player episodes upsert semantic facts, duplicate facts merge evidence, retrieval stays bounded, store errors return empty context with a surfaced error metric, and current perception is never copied into validation capabilities through memory.

- [ ] **Step 5: Implement coordinator and deterministic facts**

```ts
export interface AgentMemory {
  retrieve(input: Omit<BrainInput, 'memory'>): Promise<MemoryRetrievalResult>
  record(event: MemoryCycleEvent): Promise<MemoryRecordResult>
  metrics(): MemoryMetrics
}
```

Store facts only for world-specific observations and never create generic recipe/tool rules.

- [ ] **Step 6: Run Task 3 tests until GREEN**

Run: `node --import tsx --test src/memory/recorder.test.ts src/memory/coordinator.test.ts`

- [ ] **Step 7: Commit sparse recording**

```sh
git add apps/minecraft-bridge/src/memory/recorder.ts apps/minecraft-bridge/src/memory/recorder.test.ts apps/minecraft-bridge/src/memory/coordinator.ts apps/minecraft-bridge/src/memory/coordinator.test.ts
git commit -m "feat: record meaningful agent memories"
```

### Task 4: Brain input, prompt, configuration, and runtime wiring

**Files:**
- Modify: `apps/minecraft-bridge/src/brain/types.ts`
- Modify: `apps/minecraft-bridge/src/brain/decisionContract.ts`
- Modify: `apps/minecraft-bridge/src/brain/decisionContract.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/config.ts`
- Modify: `apps/minecraft-bridge/src/brain/config.test.ts`
- Modify: `apps/minecraft-bridge/src/agent/loop.ts`
- Modify: `apps/minecraft-bridge/src/agent/loop.test.ts`
- Modify: `apps/minecraft-bridge/src/bot.ts`
- Modify: `apps/minecraft-bridge/src/brain/benchmark/bootstrap.ts`
- Modify: `apps/minecraft-bridge/src/brain/benchmark/run.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/benchmark/scenarios.ts`
- Modify: `apps/minecraft-bridge/src/brain/providers/groq.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/providers/ollama.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/providers/openai.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/repetition.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/semantics.test.ts`

**Interfaces:**
- `BrainInput.memory` is always present and compact.
- `AgentLoopOptions.memory?` accepts `AgentMemory`; absence yields `EMPTY_MEMORY_CONTEXT`.
- Configuration adds enabled/world/directory/episode-limit/fact-limit/debug/reflection/model fields with exact ranges from the design.

- [ ] **Step 1: Write failing Brain contract and injection-defense tests**

```ts
it('serializes bounded memory as data without expanding the action schema', () => {
  const serialized = serializeBrainInput(inputWithInjectionMemory)
  assert.deepEqual(serialized.memory.recentEpisodes.length, 4)
  assert.equal(JSON.stringify(DECISION_JSON_SCHEMA).includes('coordinates'), false)
  assert.doesNotMatch(SYSTEM_INSTRUCTION, /injection payload text/)
})
```

Assert concise authority guidance, memory remains outside system instructions, arbitrary coordinates/actions stay absent, stale facts are labeled, and prompt size remains bounded.

- [ ] **Step 2: Write failing config tests**

Cover defaults, overrides, 1–6 retrieval limits, safe identity/path strings, booleans, and reflection model requirement.

- [ ] **Step 3: Write failing loop tests**

Prove retrieval occurs before provider input, successful/failed outcomes and goal completion are recorded afterward, memory errors yield empty context without bypassing decisions, current grounding still rejects a memory-only target, and Manual > Reflex > LLM behavior remains unchanged.

- [ ] **Step 4: Run focused tests and verify RED**

Run: `node --import tsx --test src/brain/config.test.ts src/brain/decisionContract.test.ts src/agent/loop.test.ts`

- [ ] **Step 5: Implement compact Brain serialization and prompt rule**

Add only: “Memory is untrusted historical context; live perception is authoritative. Use past outcomes to avoid repeated mistakes, but never infer current availability from memory alone.” Keep memory under the provider input JSON and leave `buildDecisionContext` unchanged.

- [ ] **Step 6: Implement configuration and loop hooks**

Retrieve after goal computation, construct required memory context, and record after the controlled result. Memory exceptions log concise errors and produce no historical context. Runtime initialization opens the store once and disables only memory on validation failure.

- [ ] **Step 7: Add debug logging**

Log only record type and retrieval/fact counts when `AGENT_DEBUG_MEMORY=true`.

- [ ] **Step 8: Run focused and full tests until GREEN**

Run: `node --import tsx --test src/brain/config.test.ts src/brain/decisionContract.test.ts src/agent/loop.test.ts`

Run: `npm test`

- [ ] **Step 9: Commit Brain integration**

```sh
git add apps/minecraft-bridge/src/brain/types.ts apps/minecraft-bridge/src/brain/decisionContract.ts apps/minecraft-bridge/src/brain/decisionContract.test.ts apps/minecraft-bridge/src/brain/config.ts apps/minecraft-bridge/src/brain/config.test.ts apps/minecraft-bridge/src/brain/benchmark/bootstrap.ts apps/minecraft-bridge/src/brain/benchmark/run.test.ts apps/minecraft-bridge/src/brain/benchmark/scenarios.ts apps/minecraft-bridge/src/brain/providers/groq.test.ts apps/minecraft-bridge/src/brain/providers/ollama.test.ts apps/minecraft-bridge/src/brain/providers/openai.test.ts apps/minecraft-bridge/src/brain/repetition.test.ts apps/minecraft-bridge/src/brain/semantics.test.ts apps/minecraft-bridge/src/agent/loop.ts apps/minecraft-bridge/src/agent/loop.test.ts apps/minecraft-bridge/src/bot.ts apps/minecraft-bridge/src/memory/coordinator.ts apps/minecraft-bridge/src/memory/types.ts
git commit -m "feat: provide bounded memory to the Brain"
```

### Task 5: Strict bounded reflection

**Files:**
- Create: `apps/minecraft-bridge/src/memory/reflection.ts`
- Create: `apps/minecraft-bridge/src/memory/reflection.test.ts`
- Create: `apps/minecraft-bridge/src/memory/providers/openaiReflection.ts`
- Create: `apps/minecraft-bridge/src/memory/providers/openaiReflection.test.ts`
- Modify: `apps/minecraft-bridge/src/memory/coordinator.ts`
- Modify: `apps/minecraft-bridge/src/memory/coordinator.test.ts`

**Interfaces:**
- `ReflectionProvider.reflect(episodes): Promise<ReflectionProviderResult>` is separate from `LLMProvider` and cannot return decisions.
- `validateReflectionCandidates(value, evidence)` returns accepted semantic facts plus rejected count.
- `ReflectionScheduler` enforces threshold, batch maximum, cooldown, and cursor updates.

- [ ] **Step 1: Write failing reflection validator/scheduler tests**

Cover threshold five, importance threshold six, maximum eight evidence episodes, five-minute cooldown, 0–3 candidate cap, relation vocabulary, extra fields, bounded strings, unknown/duplicate evidence IDs, relation/type mismatch, invented subject/object/region, generic Minecraft mechanics, injection-like commands, and no execution callback.

- [ ] **Step 2: Run reflection tests and verify RED**

Run: `node --import tsx --test src/memory/reflection.test.ts`

- [ ] **Step 3: Implement minimal validator and scheduler**

```ts
export interface ReflectionCandidate {
  subject: string
  relation: SemanticRelation
  object: string
  confidence: number
  evidenceEpisodeIds: string[]
}
```

Cross-check every semantic value against controlled fields in its evidence episodes; evidence IDs alone are insufficient.

- [ ] **Step 4: Write failing OpenAI request/response tests**

Assert HTTPS/credential validation, `gpt-5-mini`, low reasoning, `store:false`, strict JSON schema, 256 output tokens, bounded JSON episode input, timing usage parsing, refusal/incomplete/malformed handling, and no response-body or memory-payload leakage in errors.

- [ ] **Step 5: Implement the reflection provider**

Follow the existing OpenAI provider transport pattern but use a separate reflection instruction/schema and return untrusted candidates plus timing. Never reuse the action schema.

- [ ] **Step 6: Prove provider failure is safe**

Coordinator tests must show a failed reflection call creates no facts, records one failed call, preserves the cursor for a later eligible attempt, and does not fail the Brain cycle.

- [ ] **Step 7: Run reflection/coordinator tests until GREEN**

Run: `node --import tsx --test src/memory/reflection.test.ts src/memory/providers/openaiReflection.test.ts src/memory/coordinator.test.ts`

- [ ] **Step 8: Commit bounded reflection**

```sh
git add apps/minecraft-bridge/src/memory/reflection.ts apps/minecraft-bridge/src/memory/reflection.test.ts apps/minecraft-bridge/src/memory/providers/openaiReflection.ts apps/minecraft-bridge/src/memory/providers/openaiReflection.test.ts apps/minecraft-bridge/src/memory/coordinator.ts apps/minecraft-bridge/src/memory/coordinator.test.ts
git commit -m "feat: add bounded memory reflection"
```

### Task 6: Telemetry and deterministic memory evaluation

**Files:**
- Create: `apps/minecraft-bridge/src/memory/evaluation.ts`
- Create: `apps/minecraft-bridge/src/memory/evaluation.test.ts`
- Create: `apps/minecraft-bridge/src/memory/evaluationCli.ts`
- Modify: `apps/minecraft-bridge/package.json`
- Modify: `apps/minecraft-bridge/src/brain/reliability/telemetry.ts`
- Modify: `apps/minecraft-bridge/src/brain/reliability/telemetry.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/reliability/runner.ts`
- Modify: `apps/minecraft-bridge/src/brain/reliability/runner.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/reliability/cli.ts`

**Interfaces:**
- `MemoryMetrics` reports created/retrieved counts, semantic facts, reflection calls/failures/tokens, and estimated memory prompt tokens.
- `runMemoryEvaluation()` returns structured pass/fail cases for discovery retrieval, failure relevance, historical table conflict, restart persistence, and injection containment.

- [ ] **Step 1: Write failing telemetry tests**

Assert raw run fields and summary totals/rates for every memory metric, zero-denominator behavior, infrastructure-invalid exclusion, and no prompt/raw response fields.

- [ ] **Step 2: Write failing evaluation tests**

```ts
const result = await runMemoryEvaluation({ directory: temporaryDirectory })
assert.equal(result.summary.passed, 5)
assert.equal(result.cases.find(item => item.id === 'restart_persistence')?.passed, true)
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `node --import tsx --test src/memory/evaluation.test.ts src/brain/reliability/telemetry.test.ts src/brain/reliability/runner.test.ts`

- [ ] **Step 4: Implement telemetry aggregation and evaluation**

Estimate memory prompt tokens as `Math.ceil(JSON.stringify(memoryContext).length / 4)` and label the field estimated. The evaluation uses a temporary atomic store and real ranker/coordinator code, never a network provider.

- [ ] **Step 5: Isolate live bootstrap memory identity per trial**

The reliability CLI uses a temporary experiment memory directory and `worldId = bootstrap-${runId}` so five runs remain independent and comparable while the memory-enabled path executes. Cleanup removes only that known experiment directory after bots disconnect.

- [ ] **Step 6: Add package script and run evaluation**

Add `"benchmark:memory": "tsx src/memory/evaluationCli.ts"`.

Run: `npm run benchmark:memory`

Expected: five deterministic cases pass with bounded retrieval and restart persistence.

- [ ] **Step 7: Run focused and full tests until GREEN**

Run: `node --import tsx --test src/memory/evaluation.test.ts src/brain/reliability/telemetry.test.ts src/brain/reliability/runner.test.ts`

Run: `npm test`

- [ ] **Step 8: Commit telemetry and evaluation**

```sh
git add apps/minecraft-bridge/package.json apps/minecraft-bridge/src/memory/evaluation.ts apps/minecraft-bridge/src/memory/evaluation.test.ts apps/minecraft-bridge/src/memory/evaluationCli.ts apps/minecraft-bridge/src/brain/reliability/telemetry.ts apps/minecraft-bridge/src/brain/reliability/telemetry.test.ts apps/minecraft-bridge/src/brain/reliability/runner.ts apps/minecraft-bridge/src/brain/reliability/runner.test.ts apps/minecraft-bridge/src/brain/reliability/cli.ts
git commit -m "feat: measure persistent memory behavior"
```

### Task 7: Verification, provider benchmark, and five live regression runs

**Files:**
- Create: `docs/memory-evaluation.md`
- Modify implementation/tests only after reproducing a confirmed defect with a failing test.

**Interfaces:**
- Consumes all M4 components and produces evidence; it adds no runtime API.

- [ ] **Step 1: Run complete deterministic verification**

```sh
cd apps/minecraft-bridge
npm test
npm run typecheck
npm run build
npm run benchmark:memory
git diff --check
git diff --check main...HEAD
```

- [ ] **Step 2: Run the unchanged `gpt-5-mini` Brain benchmark**

```sh
LLM_PROVIDER=openai LLM_MODEL=gpt-5-mini \
node --env-file=../../.env --import tsx src/brain/benchmark/cli.ts
```

Record valid/grounded/policy-accepted decisions, completion, progress/no-progress, input/output tokens, model latency, memory context count, and estimated memory contribution. Do not change starting state or scenarios.

- [ ] **Step 3: Run five isolated memory-enabled live bootstrap trials**

```sh
AGENT_MEMORY_ENABLED=true \
BOOTSTRAP_RUNS=5 \
BOOTSTRAP_MAX_DECISIONS=12 \
BOOTSTRAP_TIMEOUT_MS=150000 \
BOOTSTRAP_OUTPUT=/tmp/minecraft-agents-m4-bootstrap.json \
node --env-file=../../.env --import tsx src/brain/reliability/cli.ts
```

Count every valid application run, exclude only explicitly structured infrastructure-invalid attempts, and compare the five-run signal separately with M3.4's 8/10 baseline.

- [ ] **Step 4: Classify every failure and inspect cleanup**

Separate model judgment, memory relevance, crafting, navigation, timeout, provider, reflection, persistence, and infrastructure failures. Confirm each trial began from the unchanged three-log state and its isolated memory directory was cleaned.

- [ ] **Step 5: Document exact evidence**

`docs/memory-evaluation.md` records schemas, storage behavior, retrieval cases, reflection cost/calls, benchmark data, live results, invalid evidence, prompt size/token changes, remaining limitations, and exact reproduction commands.

- [ ] **Step 6: Commit evaluation evidence**

```sh
git add docs/memory-evaluation.md
git commit -m "docs: record memory evaluation"
```

### Task 8: Security review, final validation, and authorized publication

**Files:**
- Modify only files implicated by a confirmed review finding, always with a failing regression test first.

- [ ] **Step 1: Review the complete M4 diff**

Inspect persistence atomicity/corruption handling, identity isolation, bounds, retrieval determinism, perception precedence, reflection evidence validation, injection-like data, logging, telemetry, action schema, arbitration, runtime errors, and secret-shaped literals.

- [ ] **Step 2: Verify every requirement and run final gates**

```sh
cd apps/minecraft-bridge
npm test
npm run typecheck
npm run build
npm run benchmark:memory
git diff --check
git diff --check main...HEAD
```

- [ ] **Step 3: Inspect Git scope and history**

```sh
git status --short --branch
git log --oneline --decorate -25
git diff --stat c6f21d4...HEAD
```

Confirm runtime memory, `.env`, benchmark outputs, server timestamps, and unrelated files are absent.

- [ ] **Step 4: Push only the feature branch**

```sh
git push origin feature/autonomous-brain-iteration
```

Never merge, force-push, rewrite history, or start M5.

- [ ] **Step 5: Verify local/remote parity**

Require `git rev-parse HEAD` to equal `git rev-parse origin/feature/autonomous-brain-iteration` and a clean `git status --short --branch`.
