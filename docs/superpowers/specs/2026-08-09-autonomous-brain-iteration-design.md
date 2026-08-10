# Autonomous Brain Iteration Design

## Goal

Make Alice's existing controlled Brain faster, safer, more coherent, and easier to compare across providers without expanding the approved action vocabulary or entering survival, memory, or multi-agent milestones.

## Constraints

- Preserve the `LLMProvider -> unknown -> runtime validation -> exhaustive executor` boundary.
- Preserve the seven M1.1 actions: `idle`, `scan`, `follow_player`, `come_to_player`, `stop`, `collect_block`, and `say`.
- Never expose code execution, shell access, arbitrary Mineflayer calls, or reasoning traces.
- Keep automated tests deterministic and network-independent.
- Use built-in `fetch`; add no provider SDK or agent framework.
- Keep real provider benchmarks optional, low-volume, and clearly labeled as experimental.

## Considered Approaches

### Shared decision contract with thin adapters — selected

Move the concise system instruction, structured-output schema, and compact Brain input serialization into a provider-neutral module. Ollama and Groq remain small HTTP adapters. This avoids prompt/schema drift and keeps the loop unchanged.

### Duplicate the contract in each provider — rejected

This is initially smaller but makes later semantic and prompt improvements easy to apply inconsistently.

### Groq Responses API — rejected for this phase

The Responses API is currently beta. Chat Completions already supports strict JSON Schema, low reasoning effort, and suppression of returned reasoning for `openai/gpt-oss-20b`.

## Provider Design

`GroqProvider` implements the existing `LLMProvider` interface and returns parsed model JSON as `unknown`. It posts to `/chat/completions` with a bearer token that is never logged, strict JSON Schema output, `reasoning_effort: "low"`, `include_reasoning: false`, a low temperature, and a small completion budget. HTTP errors expose only status codes. Configuration adds `GROQ_API_KEY` and `GROQ_BASE_URL`; missing credentials fail only when Groq is selected for an active runtime or explicitly constructed.

## Benchmark Design

A small offline harness runs any `LLMProvider` against fixed `BrainInput` scenarios. Each result records provider/model labels, latency, validation outcome, action/reason, repetition, self/invalid targeting, and provider/schema errors. Unit tests use scripted providers and a fake clock. A CLI enables optional sequential real calls without Minecraft and prints machine-readable JSON for later reporting.

## Brain Semantics

Provider input will distinguish `self` from `externalVisiblePlayers`, categorize health and food on their known 0–20 scales, preserve useful raw values, and separate player entities from other nearby entities. Categorization is deterministic application logic, not prompt inference.

## Contextual Safety

Syntactic decision validation remains independent, with optional decision context for player-target actions. In the live loop, a player target must case-insensitively match a visible external player and must not match Alice. Movement skills retain a second defensive check so bypassing loop validation still cannot target self or a missing player.

## Repetition Control

The loop retains a bounded recent-decision window, not long-term memory. Exact repeated chat messages receive a short cooldown. Repeated `idle` is rejected only after consecutive idles against an unchanged semantic world fingerprint. Rejections are observable and never reach the skill executor. Recent decisions are included in the next Brain input so the model can select a different action.

## Prompt and Output Budget

The shared prompt describes Alice as an autonomous Minecraft survival inhabitant, not an assistant; states that observations are current; defines health/food scales; forbids fabricated targets/resources and unmotivated greetings; asks for one useful non-repetitive action and a very short reason. The prompt remains bounded and test-inspected. Reason length is reduced from 240 to 160 characters. Generation limits may be reduced only after local measurements show structured-output reliability is preserved.

## Verification and Checkpoints

Each milestone follows red-green-refactor, focused tests, full tests/typecheck/build/diff check, diff review, and a local checkpoint commit on `feature/autonomous-brain-iteration`. Local Ollama comparisons cover the three installed requested models. Groq live results remain explicitly unavailable unless an existing environment key appears.
