# M4 Memory and Reflection Evaluation

Date: 2026-08-10

M4 adds bounded, persistent historical context without changing the Brain's action vocabulary, contextual validation, arbitration, or skill execution. Memory is advisory data only. Current perception and application-owned capabilities remain authoritative for every targeted action.

## Storage and identity

The runtime uses a dependency-free atomic JSON store behind `MemoryStore`. Schema version 1 contains one exact `agentId`/`worldId` identity, bounded episodic memories, bounded semantic facts, and a reflection cursor. A mutation validates a cloned complete document, writes it to a mode-0600 temporary file in the destination directory, and renames that file over the prior snapshot. The persisted file is never partially updated in place.

Missing files are created cleanly. Malformed JSON, unsupported schema versions, invalid records, and identity mismatches fail closed with explicit validation errors and do not replace the prior file. Episodes and facts are retained at 200 and 100 records by default; Brain retrieval is independently limited to 1–6 episodes and 1–6 facts. Runtime files under `apps/minecraft-bridge/data/memory/` are ignored by Git.

Automated storage coverage includes create/open, save/reopen, atomic replacement, write-failure preservation, malformed JSON, unsupported schema, invalid records, serialized concurrent writes, bounded retention, and agent/world isolation.

No API keys, provider responses, authorization headers, prompts, chain-of-thought, or raw model reasoning are persisted. Episode summaries are assembled from controlled application fields rather than provider-authored decision reasons.

## Retrieval and consolidation

Retrieval ranks same-identity records deterministically by importance, goal/category relevance, exact observed names, region, controlled failure signature, recency, and stable tie-breaks. Returned context is a compact clone with age buckets; store paths, record IDs, evidence IDs, identity envelopes, and reflection cursors are withheld from the Brain.

Sparse recording covers useful resource, landmark, threat, and player observations; first useful-region exploration; first confirmed capability craft; repeated controlled failures; and goal completion. Idle, scan, unchanged perception, ordinary material crafts, cancellations, and priority outcomes do not create memory.

Deterministic resource, landmark, danger, and player facts are consolidated after episode persistence. Current perception reconciles resource and landmark facts before retrieval: exact re-observation refreshes confidence, while two observations that cover the remembered region without the subject mark the fact stale. Historical memory never populates current validation capabilities.

## Optional reflection boundary

Reflection is disabled by default. When explicitly enabled, a separate `ReflectionProvider` sends at most eight controlled episode records to `gpt-5-mini` with low reasoning, `store: false`, strict JSON Schema, no tools, and a 256-output-token ceiling. Arbitrary summaries are not sent.

The scheduler requires either five new episodes of importance at least six or a goal completion, with a five-minute cooldown. It accepts at most three candidates. Every candidate must have exact keys, a controlled relation, bounded values, unique known evidence IDs, a relation-compatible episode type, and subject/object/region values exactly derivable from every cited episode. Repeated-outcome facts require at least two matching failure episodes. Extra command/action/code fields, generic mechanics, invented values, duplicate or unknown evidence, and injection-like text are rejected individually.

Provider refusal, incomplete output, malformed output, HTTP failure, and persistence failure are non-fatal to the Brain cycle. A failed attempt advances only the attempt time for rate limiting; it does not advance the reflected-episode timestamp, so pending evidence remains eligible. Reasoning content and raw response bodies are ignored and never logged.

The live sample kept reflection at its safe default: 0 calls, 0 failures, 0 reflection input/output tokens, and therefore zero reflection cost. The transport, scheduling, evidence validation, cooldown, and failure behavior are covered with injected providers and require no network in automated tests.

## Deterministic memory evaluation

`npm run benchmark:memory` runs the real atomic store, ranker, coordinator, conflict reconciliation, restart path, and Brain serializer in a temporary directory. All five cases passed:

| Case | Result | Evidence |
| --- | :---: | --- |
| Discovery retrieval | pass | The exact observed resource was the sole/top bounded result. |
| Failure relevance | pass | The controlled matching failure signature outranked a newer unrelated failure. |
| Historical table conflict | pass | Two covered-region contradictions changed the table fact to `stale`. |
| Restart persistence | pass | A newly opened store recovered the persisted episode. |
| Injection containment | pass | Injection-like memory remained serialized data; capabilities and the action schema were unchanged. |

The benchmark creates no durable runtime memory and makes no provider request.

## Unchanged Brain benchmark

The existing eight-cycle OpenAI/`gpt-5-mini` benchmark was rerun without changing its scenario or transitions. Its memory context contained zero episodes and zero facts, contributing an estimated 11 serialized tokens per cycle (88 total) before tokenizer-specific encoding.

| Valid | Grounded | Policy accepted | Progress | No progress | Goal completion | Mean / median latency | Input / output tokens |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 8/8 | 8/8 | 8/8 | 6/8 | 2/8 | 1/1 | 4,298 / 3,743 ms | 9,314 / 1,496 |

The goal completed in cycle 6 through grounded craft/place decisions. Cycles 7–8 explored after the benchmark transitioned beyond the completed bootstrap state; the second exploration was a repeated no-progress decision but remained policy-accepted because it did not reach the existing rejection threshold.

## Five isolated live bootstrap trials

Each run started from the unchanged verified three-oak-log state. The harness created a temporary experiment directory, used `worldId=bootstrap-run-N`, opened one fresh store per trial, and passed the real memory coordinator through the production loop. Alice disconnected after every run. After all bots disconnected, the harness removed only that known temporary directory, restored the bounded world fixture, unforced its chunks, restored difficulty, and stopped Paper. No run was excluded.

| Run | Success | Time | Decisions | Progress / no progress | Skill failures | Input / output tokens | Episodes created / retrieved | Facts created / retrieved | Est. memory prompt tokens | Failure |
| ---: | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | yes | 39.537 s | 8 | 8 / 0 | 0 | 12,155 / 1,716 | 5 / 20 | 2 / 12 | 1,120 | — |
| 2 | yes | 36.691 s | 8 | 8 / 0 | 0 | 12,272 / 1,455 | 5 / 19 | 2 / 11 | 1,051 | — |
| 3 | yes | 32.152 s | 8 | 8 / 0 | 1 craft | 12,187 / 1,497 | 4 / 18 | 2 / 12 | 1,058 | — |
| 4 | yes | 50.965 s | 10 | 10 / 0 | 1 craft | 15,578 / 1,855 | 4 / 24 | 2 / 16 | 1,406 | — |
| 5 | no | 150.174 s | 10 | 8 / 1 | 1 collect | 15,026 / 2,048 | 4 / 28 | 2 / 16 | 1,530 | timeout |

Aggregate evidence:

- Raw / valid / infrastructure-invalid runs: 5 / 5 / 0.
- Goal completions: 4/5 (80%). This is a separate M4 regression signal and matches, but is not combined with, M3.4's 8/10 (80%) reference.
- Successful-run completion time: 38.114 s median, 39.836 s mean.
- Successful-run decisions: 8 median, 8.5 mean.
- Progress/no-progress executed-action rates: 42/43 (97.67%) / 1/43 (2.33%).
- Provider calls: 44; input/output tokens: 67,218 / 8,571.
- Memory episodes created/retrieved: 22 / 109; semantic facts created/retrieved: 10 / 67.
- Estimated memory prompt contribution: 6,165 tokens total, about 140 per provider call. This is the documented `ceil(JSON.stringify(context).length / 4)` estimate, not provider tokenizer usage.
- Memory retrieval failures, persistence failures, reflection calls/failures, validation rejections, grounding rejections, provider errors, reflexes, and manual overrides: all zero.
- Craft failures: 2/35 (5.71%), both controlled `inventory_changed`; two separate eligible retries occurred and both succeeded.

Runs 3 and 4 recovered from an ambiguous `wooden_sword` inventory-change failure and completed with a wooden pickaxe. Run 5 is a model/resource-allocation timeout, not a memory, provider, grounding, persistence, or infrastructure failure. It crafted a second table, attempted grounded stone collection without the required tool, then failed to find a safe exploration route before the trial deadline. Runtime collection revalidation returned `missing_required_tool` safely.

## Reproduction

From `apps/minecraft-bridge`:

```sh
npm test
npm run typecheck
npm run build
npm run benchmark:memory

LLM_PROVIDER=openai LLM_MODEL=gpt-5-mini \
node --env-file=../../.env --import tsx src/brain/benchmark/cli.ts

AGENT_MEMORY_ENABLED=true \
BOOTSTRAP_RUNS=5 \
BOOTSTRAP_MAX_DECISIONS=12 \
BOOTSTRAP_TIMEOUT_MS=150000 \
BOOTSTRAP_OUTPUT=/tmp/minecraft-agents-m4-bootstrap.json \
node --env-file=../../.env --import tsx src/brain/reliability/cli.ts
```

Credentials are loaded only from the ignored local `.env`. The live structured result remains at `/tmp/minecraft-agents-m4-bootstrap.json` and is not part of Git.

## Remaining limitations

- The JSON implementation is designed for one process per agent/world file. It has a serialized in-process mutation queue but no cross-process file locking.
- Reflection is opt-in and fully bounded, but this M4 evidence does not include a paid live reflection call; reflection quality and real token cost remain unmeasured.
- Semantic memory records world-specific history, not generic recipes, planning state, or current capability. It cannot prevent every model-level resource detour, as run 5 demonstrates.
- Perception conflict decay currently applies to resource and landmark facts only, where absence in a covered region is meaningful.
- A timestamp cursor is sufficient for the bounded recorder batches used here; a future store migration would be needed before supporting concurrent writers that can create more than eight same-timestamp reflection candidates.

M4's completion boundary is met: persistent bounded memory, deterministic retrieval/consolidation, current-state precedence, optional validated reflection, telemetry, restart evidence, deterministic evaluation, and an isolated five-run live regression sample are implemented and measured. No M5 behavior is included.
