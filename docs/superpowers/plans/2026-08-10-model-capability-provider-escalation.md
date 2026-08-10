# Model Capability Evaluation and Provider Escalation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task. This phase is deliberately single-agent and stops after M3.2.

**Goal:** Determine whether M3.1's bootstrap failure is primarily a local-model capability limitation or an architecture defect, and add one production-safe OpenAI Brain provider behind the existing controlled provider boundary.

**Architecture:** Keep the fixed eight-cycle bootstrap benchmark, decision vocabulary, contextual validation, repetition policy, arbitration, and executor unchanged. Evaluate two Minecraft-specialized local checkpoints with the same scenario, then add a thin OpenAI Responses API adapter that returns untrusted `unknown` output to the existing validation pipeline.

**Tech Stack:** Node.js 22 built-in `fetch`, TypeScript, Node test runner, Ollama HTTP API, OpenAI Responses API, no new dependencies.

## Global constraints

- Work only on `feature/autonomous-brain-iteration`; never merge or force-push.
- Preserve `Manual > Reflex > LLM` and `provider -> unknown -> validation -> repetition -> arbiter -> executor`.
- Preserve the existing `AgentDecision` schema and fixed bootstrap benchmark.
- Never request, parse, expose, or log chain-of-thought.
- Never print or commit credentials; reject credential-bearing provider URLs.
- Automated tests must be deterministic and network-independent.
- Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` before every implementation checkpoint.
- Stop after M3.2; do not add memory, planning, new actions, skills, fine-tuning, or multi-agent behavior.

---

### Task 1: Specialized local-model capability checkpoints

- [x] Verify clean local/remote branch parity and run the existing validation gate.
- [x] Inspect the fixed sequential benchmark and provider safety boundary before evaluation.
- [x] Run a direct sanity prompt and the unchanged eight-cycle benchmark with `sweaterdog/andy-4:micro-q8_0`.
- [x] Check machine memory pressure, select one practical larger Andy-4 checkpoint, and run the identical benchmark.
- [x] Record validity, grounding, progress, completion, latency, token, and failure-pattern evidence without exposing reasoning.

### Task 2: OpenAI provider contract, tests first

**Files:**

- Create: `apps/minecraft-bridge/src/brain/providers/openai.ts`
- Create: `apps/minecraft-bridge/src/brain/providers/openai.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/providers/index.ts`
- Modify: `apps/minecraft-bridge/src/brain/providers/index.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/config.ts`
- Modify: `apps/minecraft-bridge/src/brain/config.test.ts`
- Modify: `.env.example`

- [x] Consult current official OpenAI Responses API and model documentation.
- [x] Write failing tests for explicit provider selection, missing credentials, HTTPS-only credential transport, strict structured output, bounded generation, no tools, no reasoning summaries, safe HTTP errors, refusal/malformed responses, and usage parsing.
- [x] Run focused tests and confirm failures are caused by missing OpenAI support.
- [x] Implement the smallest `OpenAIProvider implements LLMProvider` using injected `fetch`, the shared system instruction, serialized `BrainInput`, and `DECISION_JSON_SCHEMA`.
- [x] Return only parsed output JSON as `unknown`; expose only non-sensitive usage timing metadata through `getLastTiming()`.
- [x] Run focused and full validation, inspect the complete diff, commit `feat: add OpenAI Brain provider`, and push normally.

### Task 3: Minimum remote comparison and architecture diagnosis

- [x] Check for `OPENAI_API_KEY` without printing its value.
- [x] Resolve remote execution through the specified stop condition: no key exists, so no live API request was made.
- [x] Stop remote execution after offline provider validation and record the explicit limitation.
- [x] Skip an isolated live Minecraft test because no newly tested model demonstrated benchmark progress.
- [x] Classify the evidence as model-capability, architecture, compatibility, or inconclusive; do not repair speculative defects.

### Task 4: Evidence, review, and completion

**Files:**

- Modify: `docs/brain-benchmark.md`

- [x] Add the exact M3.2 commands, checkpoint identities, metrics, observed failure patterns, compatibility notes, and OpenAI credential limitation.
- [x] Confirm benchmark source files and the decision vocabulary are unchanged.
- [x] Review provider-boundary safety, secret handling, structured-output strictness, validation/arbitration preservation, and scope.
- [x] Run the complete test/typecheck/build/whitespace gate plus a secret-pattern audit.
- [ ] Commit `docs: record M3.2 capability evaluation`, push normally, and verify local/remote branch equality.
- [ ] Stop after M3.2 and report changed files, commits, benchmark evidence, diagnosis, limitations, and whether the next milestone is justified.
