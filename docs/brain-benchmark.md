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
