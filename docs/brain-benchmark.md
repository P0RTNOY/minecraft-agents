# Brain provider benchmark

Date: 2026-08-09

This is a small engineering comparison for the controlled M1.1 decision loop. It is not a general model evaluation. The benchmark calls providers sequentially without a Minecraft server, validates every response, and records action repetition and unsafe player targeting.

## Environment

- Apple M1 MacBook Pro (`MacBookPro17,1`), 16 GB RAM
- Darwin 25.5.0 arm64
- Node.js 22.23.2, npm 10.9.8
- Ollama 0.32.0
- Request settings: `think: false`, `keep_alive: "10m"`, temperature `0.1`, `num_predict: 128`, `num_ctx: 4096`, JSON Schema output
- System instruction: 664 characters / 92 whitespace-delimited words
- One representative warm llama3.2 request: 290 prompt tokens, 19 output tokens, 1,613 ms total, 20 output tokens/s

The installed local models were warmed with the Ollama generate endpoint before the measured scenario pass. The measured pass used:

```sh
LLM_PROVIDER=ollama LLM_MODEL=llama3.2:latest npm run benchmark:brain
LLM_PROVIDER=ollama LLM_MODEL=qwen3:1.7b npm run benchmark:brain
LLM_PROVIDER=ollama LLM_MODEL=qwen3:4b npm run benchmark:brain
```

The warm-up request for each model was equivalent to:

```sh
curl --fail --silent --show-error http://127.0.0.1:11434/api/generate \
  -H 'content-type: application/json' \
  -d '{"model":"MODEL_NAME","keep_alive":"10m"}' >/dev/null
```

The qwen3:4b command was repeated after two terminal-output capture attempts; the table uses the final fully captured run. No Groq call was made because `GROQ_API_KEY` was not present in the environment.

## Results

Each model made 11 decisions across nine fixed scenarios; the repeated-idle scenario has three samples. Latencies include local HTTP, prompt evaluation, and generation. “Context-valid” means the response passed both the JSON decision contract and current-world player-target validation.

| Provider / model | Context-valid | Schema failures | Unsafe targets blocked | Repeated decisions | Mean latency | Median latency | Range |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ollama / llama3.2:latest | 9/11 | 0 | 2 | 0 | 2,174 ms | 2,057 ms | 1,410–3,147 ms |
| Ollama / qwen3:1.7b | 11/11 | 0 | 0 | 2 | 1,121 ms | 1,060 ms | 879–1,713 ms |
| Ollama / qwen3:4b | 11/11 | 0 | 0 | 2 | 3,866 ms | 3,645 ms | 2,110–5,303 ms |
| Groq / openai/gpt-oss-20b | Not run | Not run | Not run | Not run | Not run | Not run | Missing pre-existing key |

All 33 final responses were valid structured JSON. The two llama3.2 failures were well-formed player actions aimed at a player absent from `externalVisiblePlayers`; contextual validation rejected both before execution.

### Decision quality observations

- `qwen3:1.7b` was the fastest and produced no unsafe target. It remained conservative and scan-heavy, then emitted `idle` for all three unchanged repeated-idle samples.
- `qwen3:4b` selected `collect_block` when useful blocks were present and showed more task variety. It was roughly 3.4 times slower than qwen3:1.7b by median latency. It also chose `collect_block` in the cow-only/no-block scenario, indicating weaker observation grounding in that sample. The subsequent M1.1 grounding hardening rejects that decision before execution because the requested block is absent from current perception.
- `llama3.2:latest` was scan-heavy. On repeated samples it twice invented a player target despite the prompt instruction. The new contextual validator converted those outputs into safe failures.
- Both Qwen models repeated the same idle decision twice after their first idle. In the live loop, the first two idles can execute but the third unchanged-world idle is rejected by the deterministic repetition policy. The benchmark intentionally reports provider output repetition rather than simulating skill execution policy.
- None of the final `previous_say` decisions produced the earlier customer-support-style greeting. One small nondeterministic sample is not enough to claim that behavior is eliminated.

## Before/after evidence

An earlier llama3.2 run with the original raw input and prompt produced 10/11 schema-valid decisions, two unsafe/hallucinated player targets, and a customer-support-like `say` reason in the repeated-state scenario. A semantic-input-only intermediate run happened to produce 11/11 safe decisions, which demonstrates run-to-run variance at temperature 0.1. The final run produced no schema failures and safely rejected both hallucinated targets, but it did not make llama3.2 consistently more useful.

The meaningful improvements are therefore structural rather than a claim of model intelligence:

- health and food have explicit 0–20 semantics and status labels;
- self is separated from visible external players;
- fabricated/self player targets cannot reach execution;
- collection targets must exactly match a currently observed nearby block, with runtime revalidation if the world changes;
- recent decisions and outcomes are bounded to four entries;
- duplicate chat and a third unchanged-world idle are rejected deterministically;
- reasons are capped at 160 characters and the prompt explicitly frames Alice as a Minecraft inhabitant rather than a chatbot.

## Output-budget decision

The generation budget remains 128 tokens. The representative llama3.2 decision used only 19 output tokens, while all 33 final responses remained schema-valid. This shows the current limit is a ceiling rather than typical usage, but it does not establish that a smaller ceiling would preserve structured-output reliability across the supported local models and Groq. The reason limit was reduced from 240 to 160 characters; the token budget was left unchanged rather than trading reliability for an unmeasured latency gain.

## Recommendation

Use `qwen3:1.7b` as the current local default candidate when decision latency matters. Keep the application-side semantic, contextual-validation, and repetition controls regardless of provider: the benchmark shows that prompt instructions alone do not reliably prevent hallucinated targets or repetitive idle behavior.

Groq remains implemented but unverified against the live API in this environment. A later low-volume comparison should run the same command with a pre-existing key:

```sh
LLM_PROVIDER=groq LLM_MODEL=openai/gpt-oss-20b npm run benchmark:brain
```

No benchmark invoked Mineflayer skills, changed the Paper server, or modified the Minecraft world.

## Autonomous Bootstrap / Goal-directed capability selection

Date: 2026-08-10

These are local engineering measurements for M3.1, not universal model rankings. This pass evaluates whether a provider can use application-owned goal progress and exact grounded capabilities over an evolving sequence. It supersedes the earlier fixed-scenario recommendation only for autonomous bootstrap work.

### Sequential scenario and metric semantics

The eight-cycle scenario begins healthy and safe with three `oak_log` items, no crafting table, no tool, and `oak_planks` reported as craftable. After a decision passes structural validation, contextual grounding, and repetition policy, the harness simulates only the supported inventory effects for planks, sticks, a crafting table, table placement, and a wooden pickaxe. The real `ShortTermGoalManager` recomputes goal progress and capabilities after each accepted transition. It does not simulate Minecraft physics or invoke Mineflayer skills.

- Valid means the provider output matched the unchanged controlled decision schema.
- Grounded means the decision also passed the production contextual validator.
- Progress-producing means accepted simulated execution changed deterministic `goalProgress` facts.
- No-progress includes structurally valid proposals rejected by grounding as well as accepted decisions that left goal progress unchanged.
- Repeated no-progress compares exact structurally valid proposal signatures across consecutive cycles. Runtime repetition policy still decides whether a grounded proposal may execute.
- Goal completion is application-owned: the bootstrap goal completes only after crafting access and a basic tool are observed.

The final prompt is 995 characters / 139 whitespace-delimited words. It gives general progress and exact-capability grounding guidance, contains no recipe sequence, and retains the same ten decision actions.

### Provider results

Each Ollama model was explicitly warmed and then ran the same eight sequential decisions with `think: false`, `keep_alive: "10m"`, temperature `0.1`, `num_predict: 128`, and `num_ctx: 4096`.

| Provider / model | Valid | Grounded | Policy accepted | Progress | No progress | Idle rate | Repeated no progress | Goal completion | Mean / median latency | Prompt / output tokens | Mean load | Mean output rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ollama / llama3.2:latest | 8/8 | 7/8 | 2/8 | 0/8 | 8/8 | 0% | 6/8 | 0/1 | 1,493 / 1,214 ms | 5,005 / 145 | 272 ms | 22 tok/s |
| Ollama / qwen3:1.7b | 8/8 | 0/8 | 0/8 | 0/8 | 8/8 | 0% | 5/8 | 0/1 | 1,032 / 892 ms | 4,544 / 200 | 154 ms | 35.8 tok/s |
| Ollama / qwen3:4b | 8/8 | 0/8 | 0/8 | 0/8 | 8/8 | 0% | 7/8 | 0/1 | 2,622 / 2,262 ms | 4,496 / 280 | 185 ms | 17.5 tok/s |
| Groq / openai/gpt-oss-20b | Not run | Not run | Not run | Not run | Not run | Not run | Not run | Not run | Not run | Not run | Not available | Missing pre-existing key |

Notable failures:

- `llama3.2:latest` first proposed an unavailable collection target, then alternated into repeated `explore` decisions. Two explorations were admitted before deterministic stagnation policy rejected later repetitions. The goal made no progress.
- Both Qwen models repeatedly proposed `collect_block` for a block absent from observed nearby blocks. All proposals were schema-valid, but contextual validation rejected all eight before simulation or execution.
- No model selected the currently grounded `craft_item(oak_planks, amount)` capability, so action diversity did not translate into goal progress and no model completed the bootstrap goal.
- The Groq provider path and standard token-usage parsing are covered with deterministic mocks. No live Groq request was made because `GROQ_API_KEY` was absent; no secret was printed or stored.

### Controlled live result

The best-grounded local candidate, `llama3.2:latest`, ran for approximately two minutes against local Paper 1.21.11. Alice started with exactly three oak logs on a temporary 33×33 smooth-stone platform at Y=200, with barrier edges and an exploration radius of eight. Her pre-test position `(3.6986251284809826, 87, 5.3289531212420815)` and empty inventory were recorded first.

Across ten timed LLM decisions, the model produced four successful bounded explorations, five grounded attempts to collect `smooth_stone` that failed runtime harvest revalidation safely, and one stale collection decision skipped when the existing Creeper reflex took priority. It never crafted, inventory remained three oak logs, goal progress did not change, and the goal did not complete. Mean request time was 3,870 ms, median was 4,203 ms, prompt/output totals were 7,764/263 tokens, mean reported load time was 564 ms, and mean generation speed was 17.3 tok/s. The first request included a 3,606 ms model load; subsequent reported loads were 185–404 ms.

The Creeper reflex demonstrated the intended arbitration boundary: it preempted a stale autonomous action and reported a successful escape. The test then stopped. Alice was cleared back to her verified empty inventory, teleported to the exact recorded position, and the exact `x=-16..16`, `y=199..202`, `z=-16..16` test volume was filled with air. Final server checks confirmed the empty inventory and restored position. Paper was left running because it was running before the test.

### Recommendation

For this goal-directed bootstrap workload, use `llama3.2:latest` as the local development default because it had the highest grounding rate (7/8) and its bad semantic choices remained inside both contextual and runtime safety boundaries. `qwen3:1.7b` is the latency leader, but 0/8 grounded decisions makes it a poor autonomy default for this scenario. No tested local model is yet reliable enough to call bootstrap-capable, and no remote recommendation can be made without a measured Groq run.

Reproduce the automated comparison from `apps/minecraft-bridge` with:

```sh
LLM_PROVIDER=ollama LLM_MODEL=llama3.2:latest npm run benchmark:brain
LLM_PROVIDER=ollama LLM_MODEL=qwen3:1.7b npm run benchmark:brain
LLM_PROVIDER=ollama LLM_MODEL=qwen3:4b npm run benchmark:brain
```

## M3.2 model capability evaluation and provider escalation

Date: 2026-08-10

This pass asks a narrower engineering question than the earlier comparisons: does a Minecraft-specialized local model make the unchanged eight-cycle bootstrap benchmark progress, and, if not, can the same controlled boundary be evaluated through OpenAI? The benchmark scenario, transition simulation, prompt, decision vocabulary, structural/context validation, repetition policy, and executor were not changed for these measurements.

### Specialized local checkpoints

The machine-pressure check was performed before selecting the larger checkpoint. The host has 16 GB RAM, showed 24% system-wide free memory with no throttled pages, and was already running Paper. The 4.0 GB Q3 checkpoint was therefore selected instead of the 8.5 GB Q8 checkpoint.

| Provider / model | Checkpoint details | Valid | Grounded | Accepted | Progress | Goal completion | Mean / median latency | Prompt / output tokens | Mean load / output rate | Notable failure |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Ollama / `sweaterdog/andy-4:micro-q8_0` | ID `12ec425c590d`; Qwen2 1.8B; Q8_0; 1.9 GB | 8/8 | 0/8 | 0/8 | 0/8 | 0/1 | 5,203 / 5,289 ms | 4,480 / 391 | 306 ms / 12 tok/s | Repeatedly requested an unavailable `oak_log` collection target; one reason invented prior coordinates and another leaked an unsupported command fragment. Context validation rejected every proposal. |
| Ollama / `sweaterdog/andy-4:q3_k_m` | ID `ea89f867b0b6`; Llama 8.0B; Q3_K_M; 4.0 GB | 0/8 | 0/8 | 0/8 | 0/8 | 0/1 | 26,998 / 24,993 ms | 4,352 / 1,024 in Ollama debug envelopes | 2,262 ms / 6.6 tok/s in debug envelopes | Every request used all 128 evaluation tokens but returned no usable `message.content`; the provider failed closed with `Ollama response is missing message content.` |
| OpenAI / configurable | Responses API adapter implemented; no model hard-coded | Not run | Not run | Not run | Not run | Not run | Not run | Not run | Not run | `OPENAI_API_KEY` was absent, triggering the explicit M3.2 stop condition. |

The larger checkpoint's benchmark summary reports token/timing fields as `null` because each call throws after response metadata is captured but before the benchmark receives a decision. The separate enabled Ollama timing log supplied the totals shown above: eight requests at 544 prompt tokens and 128 evaluation tokens each. No reasoning content was read, parsed as a decision, or logged.

Before the micro benchmark, a direct grounded sanity prompt described three inventory logs and only two current capabilities: craft `oak_planks` or explore. The model said sticks were needed first and proposed an unsupported recipe command. The cold request took approximately 8.65 seconds (168 prompt tokens, 26 output tokens). This was useful negative evidence before the full run: the model recognized crafting as relevant but did not follow the exact grounded capability set.

Reproduce the measured local runs from `apps/minecraft-bridge`:

```sh
LLM_PROVIDER=ollama LLM_MODEL='sweaterdog/andy-4:micro-q8_0' LLM_DEBUG_TIMING=true npm run --silent benchmark:brain
LLM_PROVIDER=ollama LLM_MODEL='sweaterdog/andy-4:q3_k_m' LLM_DEBUG_TIMING=true npm run --silent benchmark:brain
```

Both use the same Ollama settings as M3.1: `think: false`, `keep_alive: "10m"`, temperature `0.1`, `num_predict: 128`, `num_ctx: 4096`, and JSON Schema output.

### OpenAI provider and model selection

The new provider uses the current Responses API with `store: false`, no tools, no remote conversation state, low reasoning effort, a 128-token output ceiling, and strict Structured Outputs. OpenAI requires a root JSON object for strict schemas, while the shared decision contract is intentionally a top-level `anyOf`. The provider therefore transports that exact union inside one required `decision` property and unwraps it before returning `unknown`; the existing validator remains authoritative.

The provider ignores non-message reasoning items, never requests a reasoning summary, redacts refusal details, reports only safe HTTP status codes, and parses standard `input_tokens` / `output_tokens` usage. HTTPS and credential-free base URLs are enforced. The implementation uses built-in `fetch` and adds no dependency.

Current official model information confirms that [`gpt-5-mini`](https://developers.openai.com/api/docs/models/gpt-5-mini) supports both the Responses API and Structured Outputs and is positioned for cost-sensitive, low-latency, high-volume work. Its listed standard text pricing is $0.25 per million input tokens and $2.00 per million output tokens. It remains the first practical live candidate for this tiny decision benchmark; model selection stays entirely in `LLM_MODEL`. No request was made, so measured token usage and benchmark cost are both zero. If that first candidate later fails, only one stronger current model should be compared, following the [current model catalog](https://developers.openai.com/api/docs/models).

The intended future command is:

```sh
LLM_PROVIDER=openai LLM_MODEL=gpt-5-mini npm run benchmark:brain
```

It intentionally fails closed without `OPENAI_API_KEY`. No key, credential file, or live response was created during M3.2.

### Architecture diagnosis and recommendation

No tested model completed bootstrap. The best general local candidate remains `llama3.2:latest` from M3.1 because it grounded 7/8 decisions, but it still produced zero progress. Among the Minecraft-specialized candidates, micro Q8 is the only one that returned schema-valid decisions; it is not usable for this goal because all eight were ungrounded. The larger Andy checkpoint exposed a model/provider-output compatibility failure rather than decision-quality evidence.

The combined local evidence does not justify a planner or another architecture layer. It shows that the existing safety architecture correctly contains hallucinated targets and empty provider responses, while the models tested so far do not choose the exact available crafting capability. It does **not** prove that the current architecture can complete bootstrap: the required strong remote comparison could not run. The correct classification is therefore **inconclusive because OpenAI credentials were unavailable**, with strong evidence of local model-capability and Andy compatibility limitations but no reproduced architecture defect.

No architecture fix was made. The only runtime addition is a provider-neutral OpenAI adapter behind the same `unknown -> structural validation -> contextual validation -> repetition -> arbitration -> executor` flow. A live Minecraft run was also skipped because no newly tested model produced deterministic benchmark progress.

Recommended next step: provide a usable `OPENAI_API_KEY` in a future M3.2 continuation and run only the fixed eight-request `gpt-5-mini` benchmark. If it makes clear progress, analyze that trace before any escalation; if it does not, compare one stronger suitable OpenAI model. Do not add planning, memory, new skills, or decision types without that evidence.
