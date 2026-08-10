# M3.3 bootstrap reliability

Date: 2026-08-10

This report measures the existing controlled Brain architecture. The harness does not prescribe a recipe sequence, inject action hints, retry failed runs, or exclude application failures. Every model proposal still passes through structural validation, contextual grounding, repetition policy, arbitration, the normal executor, and runtime skill revalidation.

## Environment and method

- Apple Silicon Mac, Node.js 22.23.2, npm 10.9.8
- Paper 1.21.11 (`1.21.11-132-ver/1.21.11@c5eb079`), offline local server
- OpenAI Responses API, `gpt-5-mini`, low reasoning effort, strict Structured Outputs, no tools, `store: false`
- Five-run pilot followed by five additional runs after the environment remained stable
- Per run: at most 12 decisions or 150 seconds; stop immediately when `establish_basic_resources` completes
- Initial state: health 20, food 20, exactly three oak logs, and no planks, sticks, crafting table, or tools
- Temporary test volume: `x=-16..16`, `y=199..202`, `z=-16..16`; stone floor at Y=199, barrier perimeter, Peaceful difficulty, and all nine intersecting chunks force-loaded
- Between runs: clear the interior and item entities, clear Alice's inventory/effects, teleport to `(0.5, 200, 0.5)`, restore health/food, and give exactly three logs
- Final cleanup: clear Alice, restore her pre-run position, remove the complete temporary volume, remove force-loaded chunks, restore Easy difficulty, disconnect, and stop Paper

`AGENT_AUTONOMOUS=false` remains the production default. Only the reliability harness enables autonomy and forces the measured provider/model.

## Crafting diagnosis and correctness audit

The wooden-pickaxe recipe itself is correct. Paper's live registry exposes wood-specific shaped recipes; the selected oak recipe consumes exactly three oak planks and two sticks and produces one wooden pickaxe. A healthy controlled sequence persisted the expected final inventory across reconnect: three planks, two sticks, and one wooden pickaxe.

The original implementation confirmed only that output count increased. That could accept a client-side output even when the ingredient delta was corrupt or had not reconciled with the server. Craft execution now snapshots immutable inventory counts and accepts success only when every selected recipe delta matches the requested number of applications. It distinguishes unknown item, unavailable recipe, insufficient ingredients, missing table, navigation/cancellation, `craft_failed`, `inventory_changed`, and `output_not_confirmed`. It also waits for up to ten Minecraft ticks for the authoritative delta to settle before rejecting the craft.

Focused automated coverage now exercises:

- inventory-only oak planks;
- sticks and crafting-table construction;
- exact table-required wooden-pickaxe and wooden-axe recipes;
- missing ingredients and missing/disappearing crafting tables;
- ingredients disappearing during table navigation;
- navigation replacement and action cancellation;
- delayed authoritative inventory reconciliation;
- missing output and corrupt ingredient deltas.

One live limitation remains. Table-required crafting can intermittently return without a confirmed output even though the table and ingredients are locally present. In the instrumented second batch, all three such events were `craft_item:output_not_confirmed`; the model later recovered after collecting and re-placing the table. Separate isolated diagnostics also reproduced Mineflayer's `windowOpen` timeout with an unchanged inventory. This is a Mineflayer/Paper table-interaction synchronization issue, not an item-specific recipe error. The application now fails closed and reports it accurately; it does not silently repeat a possibly ambiguous craft.

## Production-loop telemetry and harness

`BootstrapRunTelemetry` wraps the configured provider without changing its interface. It records actual Responses API input/output usage, wall-clock LLM latency, provider calls/errors, decisions, action counts, exact non-sensitive skill failure reason counts, validation/grounding/repetition rejections, progress/no-progress outcomes, reflexes, manual overrides, completion, duration, and final inventory. No prompt, raw response, authorization header, or secret is captured.

The runner owns Paper for the experiment, detects Paper watchdog messages, retains every attempt, marks setup/cleanup/watchdog-corrupted attempts as `infrastructure_invalid`, and excludes only those marked attempts from agent reliability denominators. Cleanup runs in `finally`, including after failed and timed-out trials. Automated runner tests use injected trials and require neither Minecraft nor network access.

## Post-fix live results

The table combines two consecutive five-run batches. Run identifiers 6–10 correspond to the second batch's local identifiers 1–5. Cost uses the [current listed standard `gpt-5-mini` rates](https://developers.openai.com/api/docs/models/gpt-5-mini) of $0.25 per million input tokens and $2.00 per million output tokens. It treats all input as uncached, so actual billed cost may be lower.

| Run | Success | Time | Decisions | Progress | Craft failures | Grounding rejects | Provider errors | Input tokens | Output tokens | Approx. cost | Failure reason |
| ---: | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | yes | 20.188 s | 5 | 5 | 0 | 0 | 0 | 6,480 | 936 | $0.003492 | — |
| 2 | no | 150.138 s | 6 | 4 | 0 | 0 | 0 | 6,938 | 1,093 | $0.003921 | timeout |
| 3 | yes | 16.558 s | 5 | 5 | 0 | 0 | 0 | 6,425 | 803 | $0.003212 | — |
| 4 | yes | 42.150 s | 10 | 7 | 2 | 0 | 0 | 14,893 | 1,905 | $0.007533 | — |
| 5 | yes | 23.198 s | 6 | 5 | 1 | 0 | 0 | 8,228 | 1,069 | $0.004195 | — |
| 6 | no | 150.468 s | 6 | 4 | 0 | 0 | 0 | 6,916 | 1,116 | $0.003961 | timeout |
| 7 | yes | 16.071 s | 5 | 5 | 0 | 0 | 0 | 6,424 | 735 | $0.003076 | — |
| 8 | yes | 36.900 s | 11 | 7 | 3 | 0 | 0 | 16,719 | 2,205 | $0.008590 | — |
| 9 | yes | 15.549 s | 5 | 5 | 0 | 0 | 0 | 6,446 | 747 | $0.003105 | — |
| 10 | no | 150.948 s | 6 | 4 | 0 | 0 | 0 | 6,929 | 1,117 | $0.003966 | timeout |

### Aggregate statistics

- Raw/valid/infrastructure-invalid: 10 / 10 / 0
- Goal completions and successes: 7/10 (70%)
- Successful-run completion time: 20.188 s median, 24.373 s mean
- Successful-run decisions: 5 median, 6.714 mean
- Progress-producing/no-progress action rates: 82.26% / 17.74%
- Craft failure rate: 6/43 craft actions (13.95%)
- Grounding, validation, and provider failure rates: 0%
- Reflex-trigger rate and manual overrides: 0%
- Most common failed-run reason: timeout (3)
- Actual provider calls/decisions: 65 / 65
- Actual input/output tokens: 86,398 / 11,726
- Average input/output tokens per run: 8,639.8 / 1,172.6
- LLM latency across calls: 2,658 ms median, 3,005 ms mean
- Approximate total/average cost: $0.045052 / $0.004505 per run

All three failed runs made four progress-producing actions, but chose to craft 16 sticks, consuming all remaining planks. They then attempted stone collection without a pickaxe and eventually exhausted the run timeout while exploring inside the bounded test environment. These are retained model-decision failures expressed as timeouts, not crafting or infrastructure failures.

The first five-run post-fix batch met the 80% pilot target (4/5). The full ten-run result is 70%, demonstrating why the additional sample was useful. It exposed both the overproduction failure mode and the intermittent table-interaction limitation without changing the architecture to optimize the benchmark.

## Pre-fix and invalid evidence

Pre-fix evidence is intentionally not hidden:

- A complete five-run batch before the bounded inventory-settlement fix produced 3/5 completions, two timeouts, and three craft failures across successful runs. Its actual usage was 40,095 input and 5,450 output tokens.
- The first setup attempt force-loaded coordinates as chunk coordinates instead of block coordinates. The positive boundary was not loaded, Alice fell, and the attempt was classified as infrastructure-invalid. The command builder now force-loads the complete inclusive block volume and is regression-tested.
- An earlier diagnostic coincided with a Paper watchdog stall and was excluded from agent reliability evidence.
- Aborted and deliberately isolated crafting diagnostics were used only for root-cause work and are not mixed into the ten-run reliability statistics.

No watchdog event occurred during the ten official post-fix trials. The second Paper startup spent about 16 seconds initializing data converters, but completed before run preparation and did not corrupt a trial. Every official run passed start-state verification and final cleanup completed.

## Reproduction

From `apps/minecraft-bridge`, with an ignored local `.env` containing `OPENAI_API_KEY`:

```sh
BOOTSTRAP_RUNS=5 \
BOOTSTRAP_MAX_DECISIONS=12 \
BOOTSTRAP_TIMEOUT_MS=150000 \
BOOTSTRAP_OUTPUT=/tmp/minecraft-agents-bootstrap.json \
node --env-file=../../.env --import tsx src/brain/reliability/cli.ts
```

If `OPENAI_API_KEY` is already exported, the package-script equivalent is:

```sh
BOOTSTRAP_RUNS=5 BOOTSTRAP_OUTPUT=/tmp/minecraft-agents-bootstrap.json \
npm run benchmark:bootstrap
```

Automated verification:

```sh
npm test
npm run typecheck
npm run build
git diff --check
git diff --check main...HEAD
```

## Conclusion

M3.3 establishes a repeatable and measurable bootstrap capability without a planner, memory, routing, or new actions. Crafting now validates the complete recipe delta and fails closed on stale or ambiguous inventory state. The live goal completes autonomously in 7/10 valid runs at roughly half a cent per run. The next work should remain a focused reliability milestone: address excessive grounded craft amounts and investigate Mineflayer table-window synchronization. It should not begin M4 architecture expansion until those measured failure modes are resolved.
