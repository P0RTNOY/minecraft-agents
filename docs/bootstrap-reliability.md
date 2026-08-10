# Bootstrap reliability (M3.3–M3.4)

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
BOOTSTRAP_RUNS=10 \
BOOTSTRAP_MAX_DECISIONS=12 \
BOOTSTRAP_TIMEOUT_MS=150000 \
BOOTSTRAP_OUTPUT=/tmp/minecraft-agents-bootstrap.json \
node --env-file=../../.env --import tsx src/brain/reliability/cli.ts
```

If `OPENAI_API_KEY` is already exported, the package-script equivalent is:

```sh
BOOTSTRAP_RUNS=10 BOOTSTRAP_OUTPUT=/tmp/minecraft-agents-bootstrap.json \
npm run benchmark:bootstrap
```

Deterministic provider benchmark, using its unchanged scenario set:

```sh
LLM_PROVIDER=openai LLM_MODEL=gpt-5-mini \
node --env-file=../../.env --import tsx src/brain/benchmark/cli.ts
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

## M3.4 resource efficiency and bounded table retry

M3.4 keeps the M3.3 architecture and action vocabulary. It changes `craft_item.amount` from recipe applications to the desired output-item count, exposes the selected recipe's `recipeOutput` in the grounded capability, and accepts only positive integer amounts that are exact output-batch multiples and no greater than `maxCraftable`. The prompt now says to craft only useful quantities and preserve ingredients for other grounded capabilities; it does not prescribe a bootstrap sequence. The system instruction grew from 995 characters / 139 words to 1,156 characters / 161 words.

The crafting skill still reconciles the complete inventory delta. For a table-required craft only, it may retry once when the first attempt has a known transient outcome (`windowOpen` or resolved-without-output) and the complete inventory is provably unchanged. Before retrying it reacquires the current table block, reselects the recipe, rechecks ingredients and amount alignment, and verifies that the inventory still equals the original snapshot. Cancellation, arbitrary errors, partial ingredient/output mutation, and all ambiguous deltas fail closed without a retry. Per-craft telemetry records requested output, recipe batch size, execution count, retry count/result, and failure reason without retaining prompts or raw provider responses.

The reliability setup also waits for the authoritative Mineflayer snapshot to reflect the exact prepared inventory and supported state after the command marker. This closes a measured command-marker/client-state race without weakening the start-state invariant.

### Deterministic benchmark

The unchanged eight-cycle `gpt-5-mini` benchmark produced 8/8 structurally valid decisions, 7/8 grounded and accepted decisions, seven progress cycles, one rejected non-aligned plank amount, and one completed bootstrap state. The accepted craft quantities were four planks, one table, four planks, four sticks, four planks, and one pickaxe. The rejected request was one plank against a recipe output batch of four; it was not normalized or executed.

Compared with the M3.3 benchmark, input/output usage increased from 8,545/1,043 to 9,044/1,949 tokens, and mean/median model latency increased from 1,960/1,956 ms to 4,597/4,441 ms. The expanded schema and instruction improved quantity behavior but increased model reasoning/output cost; live goal reliability remains the deciding measurement.

### Live results

The following table combines two consecutive five-run batches. Cost uses the same M3.3 rate assumptions so the samples remain directly comparable.

| Run | Success | Time | Decisions | Progress | Craft failures | Retries | Validation rejects | Input tokens | Output tokens | Approx. cost | Failure reason |
| ---: | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | yes | 41.583 s | 8 | 8 | 1 | 0 | 0 | 10,974 | 1,646 | $0.006036 | — |
| 2 | yes | 44.364 s | 10 | 10 | 0 | 0 | 0 | 14,048 | 1,864 | $0.007240 | — |
| 3 | yes | 37.340 s | 8 | 8 | 0 | 1 | 0 | 10,820 | 1,502 | $0.005709 | — |
| 4 | yes | 24.704 s | 6 | 6 | 0 | 0 | 0 | 7,759 | 1,351 | $0.004642 | — |
| 5 | no | 150.141 s | 8 | 6 | 0 | 0 | 0 | 10,617 | 2,025 | $0.006704 | timeout |
| 6 | yes | 28.316 s | 8 | 8 | 1 | 0 | 0 | 10,978 | 1,431 | $0.005607 | — |
| 7 | no | 150.066 s | 10 | 8 | 0 | 0 | 0 | 13,241 | 1,916 | $0.007142 | timeout |
| 8 | yes | 52.755 s | 11 | 10 | 1 | 0 | 1 | 15,042 | 2,324 | $0.008409 | — |
| 9 | yes | 21.541 s | 5 | 5 | 0 | 1 | 0 | 6,712 | 1,018 | $0.003714 | — |
| 10 | yes | 34.150 s | 8 | 8 | 0 | 0 | 0 | 11,023 | 1,676 | $0.006108 | — |

M3.4 aggregate statistics:

- Raw/valid/infrastructure-invalid official runs: 10 / 10 / 0
- Goal completions and successes: 8/10 (80%), up from M3.3's 7/10
- Successful-run completion time: 35.745 s median, 35.594 s mean
- Successful-run decisions: 8 median, 8 mean
- Progress-producing/no-progress executed-action rates: 77/79 (97.47%) / 2/79 (2.53%)
- Craft failure rate: 3/63 (4.76%), down from M3.3's 6/43 (13.95%)
- Retry rate: 2/63 crafts (3.17%); retry success rate: 2/2 (100%)
- Requested craft amounts: 1 × 28, 4 × 33, 8 × 1, and 12 × 1
- Grounding/provider failure rates: 0%; contextual validation rejected 1/82 provider decisions (1.22%)
- Actual provider calls: 82; input/output tokens: 111,214 / 16,753
- LLM latency across calls: 3,532 ms median, 3,950 ms mean
- Approximate total/average cost: $0.061310 / $0.006131 per run

All three craft failures were `inventory_changed`, so they were treated as ambiguous and were not retried. The model recovered and completed the goal in each affected run. Both eligible unchanged-inventory table synchronization failures retried once and succeeded.

The two failed runs are retained model-policy failures. Each successfully crafted a sword, consumed or stranded the remaining useful materials through an extra table or maximum-plank choice, attempted stone collection without the required pickaxe, and timed out with one table, one sword, and three sticks. Neither had a crafting failure, grounding rejection, provider error, or invalid start state. M3.4 eliminated the M3.3 pattern of producing 16 sticks in all failed runs, but generic resource guidance cannot guarantee optimal planning.

Before the official sample, five attempts were marked infrastructure-invalid because Paper acknowledged the setup marker before Alice's Mineflayer inventory snapshot had caught up; they made zero provider calls and are excluded from agent denominators. The authoritative-state wait was added and regression-tested before rerunning. A separate first cold Paper startup exceeded the controller's 60-second readiness deadline while initializing data converters, so no trial began. All ten official runs subsequently passed exact start-state verification and cleanup.

### M3.4 conclusion

The measured stop condition was met after ten trustworthy post-change runs: success reached 80%, resource-exhaustion timeouts fell from 3/10 to 2/10, and craft failures fell by roughly two thirds. The bounded retry recovered both proven zero-mutation table failures without retrying any ambiguous mutation. M3.4 is sufficient to close the focused crafting hardening milestone and begin M4 planning, while preserving two explicit limitations: model-level resource detours remain possible, and a one-time cold Paper data-converter startup can exceed the harness's readiness deadline before any trial starts.
