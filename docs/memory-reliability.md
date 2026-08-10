# Memory reliability validation (M4.1)

Date: 2026-08-10

## Decision

M4 memory is **NEUTRAL** on the available evidence. Persistent memory did not
produce a statistically distinguishable reliability change in this 10-run-per-
cohort experiment. Isolated memory completed 8/10 runs versus 9/10 with memory
off; accumulating memory completed 10/10. Both pairwise two-sided Fisher exact
tests have `p = 1.0`, and the 95% Wilson intervals overlap widely.

The overhead is small: 137 estimated memory-context tokens per provider call in
the isolated cohort and 198 in the accumulating cohort. There is no trace-backed
case for changing retrieval. M4 can close with memory enabled as an optional,
bounded subsystem. This result is not proof that memory improves bootstrap
reliability; a larger, independently repeated experiment would be needed for
that claim.

## Experiment design

The three cohorts used the same controlled bootstrap harness and differed only
in memory state:

- **Memory off:** `AGENT_MEMORY_ENABLED=false`.
- **Isolated memory:** memory enabled, reflection disabled, and an exact unique
  agent/world identity plus a separate temporary store for every run.
- **Accumulating memory:** memory enabled, reflection disabled, with all ten
  runs reopening one temporary store under one exact agent/world identity.

Every invocation created a fresh temporary memory root. The harness removed only
that exact root in final cleanup, so no user or production memory was touched.
Automated integration coverage verifies that run 2 sees no run-1 episode in
isolated mode and does reopen it in accumulating mode.

Common controls:

- OpenAI Responses API with `gpt-5-mini`, strict structured output, and the
  existing Brain prompt and action vocabulary.
- Paper 1.21.11 and the same bounded platform/start-state reset used by the
  bootstrap reliability harness.
- Goal: `establish_basic_resources` from exactly three oak logs, full health and
  food, and no other bootstrap resources.
- Maximum 12 decisions and 150 seconds per run.
- Reflection off.
- Ten raw runs per cohort. Infrastructure-invalid attempts remain visible and
  are excluded only from agent-reliability denominators.

The host was unusually loaded before the official cohorts. One Paper startup
stalled and one completed 250 ms beyond the old fixed 60-second startup limit;
neither reached a trial and neither is counted as a run. The harness received a
bounded, experiment-only 120-second startup override, used identically by all
three official cohorts. All 30 official runs passed start-state verification.

## Results

| Metric | Memory off | Isolated memory | Accumulating memory |
| --- | ---: | ---: | ---: |
| Raw / valid / infrastructure-invalid | 10 / 10 / 0 | 10 / 10 / 0 | 10 / 10 / 0 |
| Goal completion | 9/10 (90%) | 8/10 (80%) | 10/10 (100%) |
| 95% Wilson interval | 59.6%–98.2% | 49.0%–94.3% | 72.2%–100% |
| Successful-run time, median | 44.869 s | 37.603 s | 31.629 s |
| Successful-run time, mean | 42.513 s | 35.966 s | 34.915 s |
| Successful-run decisions, median | 8 | 8 | 8 |
| Successful-run decisions, mean | 8.444 | 8.250 | 8.700 |
| Progress-producing action rate | 98.82% | 96.47% | 98.85% |
| No-progress action rate | 1.18% | 3.53% | 1.15% |
| Craft failures / attempts | 3 / 66 | 5 / 66 | 8 / 71 |
| Resource-detour timeouts | 1 | 2 | 0 |
| Grounding / validation rejections | 0 / 0 | 0 / 0 | 0 / 0 |
| Provider failures / calls | 1 / 87 | 0 / 87 | 0 / 87 |

Memory-on minus memory-off deltas:

| Metric | Isolated minus off | Accumulating minus off |
| --- | ---: | ---: |
| Goal completion | -10 percentage points | +10 percentage points |
| Median successful completion time | -7.267 s (-16.2%) | -13.241 s (-29.5%) |
| Mean successful decisions | -0.194 | +0.256 |
| Progress action rate | -2.35 percentage points | +0.03 percentage points |
| No-progress action rate | +2.35 percentage points | -0.03 percentage points |
| Timeouts | +1 | -1 |
| Provider failures | -1 | -1 |

The sample is too small to separate memory effects from model/run variance.
In particular, the same late resource detour appeared in the memory-off failure
and one isolated-memory failure: after substantial valid crafting progress, the
agent attempted to collect stone without completing the required tool path. The
second isolated failure followed a closely related table/resource path. All
retrieved items in both failed isolated runs were classified directly relevant;
there was no irrelevant or stale item to identify as a causal retrieval defect.

## Memory volume and retrieval usefulness

| Metric | Isolated memory | Accumulating memory |
| --- | ---: | ---: |
| Episodes created / retrieved | 41 / 209 | 6 / 334 |
| Semantic facts created / retrieved | 20 / 131 | 2 / 170 |
| Retrieval failures | 0 | 0 |
| Persistence failures | 0 | 0 |
| Directly relevant | 340 | 485 |
| Weakly relevant | 0 | 0 |
| Irrelevant | 0 | 0 |
| Stale or contradicted | 0 | 19 |
| Total classified items | 340 | 504 |

Useful examples are recorded only as privacy-safe type/relation labels. The
directly relevant accumulating set consisted of successful-craft episodes (255),
resource-discovery episodes (19), landmark-discovery episodes (60), current
resource-near facts (86), and current landmark-near facts (65). These categories
match the active bootstrap goal and current observed region.

The only adverse signal was 19 stale `landmark_observed_near` fact retrievals in
the accumulating cohort. They began after run 1 and were spread across runs
2–10. Every accumulating run still completed, with no increase in no-progress
rate relative to memory-off. The trace therefore identifies a condition worth
monitoring, not evidence that the stale facts harmed decisions. No prompt,
provider response, chain-of-thought, or free-form memory text was captured for
this analysis.

## Token, latency, and cost impact

| Metric | Memory off | Isolated memory | Accumulating memory |
| --- | ---: | ---: | ---: |
| Input tokens | 122,931 | 134,066 | 139,887 |
| Output tokens | 17,031 | 16,507 | 16,707 |
| Estimated memory-context tokens | 0 | 11,932 | 17,246 |
| Memory-context tokens/provider call | 0 | 137.15 | 198.23 |
| Provider latency, median | 3,789 ms | 3,250 ms | 3,093 ms |
| Provider latency, mean | 4,085 ms | 3,770 ms | 3,360 ms |
| Conservative cohort cost | $0.064795 | $0.066530 | $0.068386 |
| Cost delta versus off | — | +$0.001736 (+2.68%) | +$0.003591 (+5.54%) |

Input tokens increased 9.06% in isolated mode and 13.79% in accumulating mode;
output tokens fell 3.08% and 1.90%, respectively. Observed provider latency did
not regress: mean latency was 7.72% lower for isolated memory and 17.76% lower
for accumulating memory. These are uncontrolled wall-clock observations on a
loaded host, so they show the absence of an observed latency penalty, not a
causal speedup from memory.

Cost uses the listed standard `gpt-5-mini` rates of $0.25 per million input
tokens and $2.00 per million output tokens from the
[OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-5-mini).
The estimate treats all input as uncached, so billed cost can be lower.

## Reflection decision

No reflection cohort was run. Reflection was optional and permitted only after
retrieval was shown not to regress reliability. The primary evidence is neutral,
not a sufficiently powered non-regression result, and reflection would add a
second variable plus token cost. Reflection remains off by default and was not
needed to answer the M4.1 primary question.

## Harness changes and reproducibility

M4.1 added deterministic, dependency-free experiment support for isolated and
accumulating memory layouts, A/B aggregation, failure retention, memory-token
accounting, privacy-safe retrieval classification, and concise decision traces.
It did not change retrieval ranking, prompts, Brain behavior, action vocabulary,
or memory architecture.

After all official artifacts were written, final Paper shutdown exposed a
harness-only log-buffer defect: array indices stopped tracking output after the
500-line rolling buffer evicted old entries. World cleanup had completed, but
the runner waited another 60 seconds and exited nonzero. The buffer now uses
monotonic sequence cursors, with a deterministic rollover regression test. This
post-artifact fix does not alter any reported trial result.

From `apps/minecraft-bridge`, with an ignored `.env` containing
`OPENAI_API_KEY`, reproduce each cohort with:

```sh
AGENT_MEMORY_ENABLED=false AGENT_MEMORY_REFLECTION=false \
BOOTSTRAP_MEMORY_MODE=isolated BOOTSTRAP_PAPER_START_TIMEOUT_MS=120000 \
BOOTSTRAP_RUNS=10 BOOTSTRAP_MAX_DECISIONS=12 BOOTSTRAP_TIMEOUT_MS=150000 \
BOOTSTRAP_OUTPUT=/tmp/memory-off.json \
node --env-file=../../.env --import tsx src/brain/reliability/cli.ts

AGENT_MEMORY_ENABLED=true AGENT_MEMORY_REFLECTION=false \
BOOTSTRAP_MEMORY_MODE=isolated BOOTSTRAP_PAPER_START_TIMEOUT_MS=120000 \
BOOTSTRAP_RUNS=10 BOOTSTRAP_MAX_DECISIONS=12 BOOTSTRAP_TIMEOUT_MS=150000 \
BOOTSTRAP_OUTPUT=/tmp/memory-isolated.json \
node --env-file=../../.env --import tsx src/brain/reliability/cli.ts

AGENT_MEMORY_ENABLED=true AGENT_MEMORY_REFLECTION=false \
BOOTSTRAP_MEMORY_MODE=accumulating BOOTSTRAP_PAPER_START_TIMEOUT_MS=120000 \
BOOTSTRAP_RUNS=10 BOOTSTRAP_MAX_DECISIONS=12 BOOTSTRAP_TIMEOUT_MS=150000 \
BOOTSTRAP_OUTPUT=/tmp/memory-accumulating.json \
node --env-file=../../.env --import tsx src/brain/reliability/cli.ts
```

Compare artifacts without network or Minecraft:

```sh
npm run benchmark:memory-ab -- \
  /tmp/memory-off.json \
  /tmp/memory-isolated.json \
  /tmp/memory-accumulating.json
```

Recommendation: close M4, preserve the current bounded deterministic retrieval
and telemetry, and carry the stale-landmark count as a monitoring signal. Do not
tune retrieval or enable reflection by default from this sample. The next
milestone may be planned only as a separately authorized task; M4.1 adds no M5
behavior.
