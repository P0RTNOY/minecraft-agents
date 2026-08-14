# Social Interaction Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add attributable, isolated, bounded pairwise social interaction and directed relationship state for configured Minecraft agents without expanding world-action authority.

**Architecture:** Production composition owns one `ConversationCoordinator` and the existing FIFO provider limiter. Every `AgentRuntime` owns a cognitive gate, social provider adapter, relationship store/service, social-memory integration, and telemetry; the coordinator accesses them only through narrow participant interfaces and owns pairwise session state. Verified perception/coordinator events drive deterministic relationship updates, while speech remains attributed unverified data.

**Tech Stack:** TypeScript 7, Node.js 22 built-in test runner, Mineflayer, dependency-free atomic JSON, OpenAI Responses API over built-in `fetch`.

## Global Constraints

- Preserve the existing `AgentDecision` vocabulary and Manual > Reflex > LLM world-action priority.
- Social behavior is disabled by default and uses `gpt-5-mini` for bounded live evaluation.
- Add no production dependency, database, agent framework, arbitrary tool, dynamic invocation, shell, eval, generated JavaScript, embeddings, or vector store.
- Treat provider output, Minecraft chat, memory, and prior utterances as untrusted data.
- Never log or persist prompts, raw provider responses, reasoning, credentials, authorization headers, or unlimited transcripts.
- Maximum combined live M6 usage is 300 social/provider calls and $1.00 estimated OpenAI cost.
- Keep `.env` ignored/untracked and use only presence checks for `OPENAI_API_KEY`.
- Do not implement M7 scope: professions, organizations, economy, governance, shared goals/plans, group conversations, or new Minecraft skills.
- Every automated test remains offline and requires neither Minecraft, Paper, OpenAI, nor network.

---

### Task 1: Strict social configuration and event provenance

**Files:**
- Create: `apps/minecraft-bridge/src/social/events.ts`
- Create: `apps/minecraft-bridge/src/social/events.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/config.ts`
- Modify: `apps/minecraft-bridge/src/brain/config.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: validated configured agent IDs/usernames and the existing `BrainConfig` environment loader.
- Produces: `SocialConfig`, `SocialEvent`, `decodeSocialEvent(value, expectedWorldId, configuredAgentIds)`, and `createSocialEvent(input)`.

- [ ] **Step 1: Write failing configuration and event tests**

```ts
assert.deepEqual(loadBrainConfig({}), {
  ...existingDefaults,
  socialEnabled: false,
  socialAutoGreeting: false,
  socialModel: 'gpt-5-mini',
  socialMaxTurns: 4,
  socialCooldownMs: 60_000,
  socialTurnTimeoutMs: 15_000,
  socialMaxMessageChars: 180,
  socialDirectory: 'data/social'
})

assert.equal(decodeSocialEvent({
  id: 'social-1', worldId: 'world', timestamp: 10,
  type: 'agent_speech_observed', observerAgentId: 'alice',
  actorAgentId: 'bob', targetAgentId: 'alice', conversationId: 'c-1',
  verified: false, evidence: 'minecraft_chat',
  metadata: { message: 'Hello.' }
}, 'world', ['alice', 'bob']).verified, false)
```

- [ ] **Step 2: Run focused tests and confirm failures identify missing social contracts**

Run: `npm test -- --test-name-pattern='loadBrainConfig|social event'`

- [ ] **Step 3: Implement strict parsing and exact provenance rules**

```ts
export type SocialEventType =
  | 'agent_seen'
  | 'agent_speech_observed'
  | 'conversation_started'
  | 'conversation_completed'
  | 'conversation_interrupted'

export interface SocialEvent {
  id: string
  worldId: string
  timestamp: number
  type: SocialEventType
  observerAgentId: string
  actorAgentId: string
  targetAgentId?: string
  conversationId?: string
  verified: boolean
  evidence: 'perception' | 'minecraft_chat' | 'coordinator'
  metadata: Readonly<Record<string, string | number | boolean>>
}
```

Enforce exact keys, bounded identifiers and message text, configured external targets, `agent_seen` + `perception` + verified, lifecycle events + `coordinator` + verified, and speech + `minecraft_chat` + unverified. Reject self-targets and unsupported attribution.

- [ ] **Step 4: Run focused tests, full suite, typecheck, build, and diff check**

Run: `npm test && npm run typecheck && npm run build && git diff --check`

- [ ] **Step 5: Commit and push the verified checkpoint**

```bash
git add .env.example apps/minecraft-bridge/src/brain/config.ts apps/minecraft-bridge/src/brain/config.test.ts apps/minecraft-bridge/src/social/events.ts apps/minecraft-bridge/src/social/events.test.ts
git commit -m "feat: add verified social event model"
git push -u origin feature/social-foundation
```

### Task 2: Directed relationship policy and atomic persistence

**Files:**
- Create: `apps/minecraft-bridge/src/social/relationships.ts`
- Create: `apps/minecraft-bridge/src/social/relationships.test.ts`
- Create: `apps/minecraft-bridge/src/social/relationshipStore.ts`
- Create: `apps/minecraft-bridge/src/social/relationshipStore.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: validated `SocialEvent` records from Task 1.
- Produces: `RelationshipRecord`, `RelationshipStore`, `AtomicJsonRelationshipStore`, `AgentRelationshipService.record(event)`, `summariesFor(targetIds)`, and `relationshipFilePath(base, identity)`.

- [ ] **Step 1: Write failing deterministic-policy tests**

```ts
const seen = applyRelationshipEvent(emptyRelationship('alice', 'bob', 'w', 1), agentSeen)
assert.equal(seen.record.familiarity, 1)
assert.equal(seen.record.trust, 0)
const spoken = applyRelationshipEvent(seen.record, unverifiedSpeech)
assert.deepEqual(spoken, { record: seen.record, changed: false, category: null })
```

Cover directed Alice→Bob/Bob→Alice state, clamping, encounter cooldown, completion increments, interruption/provider errors producing no delta, and self/unknown target rejection.

- [ ] **Step 2: Run focused policy tests and confirm red state**

Run: `npm test -- --test-name-pattern='relationship policy'`

- [ ] **Step 3: Implement named constants and deterministic service behavior**

```ts
export const RELATIONSHIP_BOUNDS = {
  familiarity: { min: 0, max: 100 },
  trust: { min: -100, max: 100 },
  affinity: { min: -100, max: 100 },
  reciprocity: { min: -100, max: 100 }
} as const
export const AGENT_SEEN_FAMILIARITY_DELTA = 1
export const CONVERSATION_FAMILIARITY_DELTA = 2
```

- [ ] **Step 4: Write failing storage tests**

Cover create/open, save/reopen, same-directory temporary write then rename, failed rename preserving the prior file, malformed JSON, unsupported schema, identity mismatch, bounded records, safe path derivation, world isolation, observer isolation, and one corrupt observer not affecting another.

- [ ] **Step 5: Implement the schema-versioned atomic JSON store**

```ts
export interface RelationshipStore {
  open(): Promise<void>
  get(targetAgentId: string): Promise<RelationshipRecord | null>
  list(): Promise<RelationshipRecord[]>
  put(record: RelationshipRecord): Promise<void>
  flush(): Promise<void>
}
```

Use mode `0700` directories, mode `0600` temporary files, full-document validation before trust/write, serialized mutations, and atomic rename. Add `apps/minecraft-bridge/data/social/` to `.gitignore`.

- [ ] **Step 6: Run focused and full validation**

Run: `npm test -- --test-name-pattern='relationship' && npm test && npm run typecheck && npm run build && git diff --check`

- [ ] **Step 7: Commit and push**

```bash
git add .gitignore apps/minecraft-bridge/src/social/relationships.ts apps/minecraft-bridge/src/social/relationships.test.ts apps/minecraft-bridge/src/social/relationshipStore.ts apps/minecraft-bridge/src/social/relationshipStore.test.ts
git commit -m "feat: persist directed agent relationships"
git push
```

### Task 3: Closed social response contract, OpenAI provider, and cognitive gate

**Files:**
- Create: `apps/minecraft-bridge/src/social/response.ts`
- Create: `apps/minecraft-bridge/src/social/response.test.ts`
- Create: `apps/minecraft-bridge/src/social/provider.ts`
- Create: `apps/minecraft-bridge/src/social/providers/openai.ts`
- Create: `apps/minecraft-bridge/src/social/providers/openai.test.ts`
- Create: `apps/minecraft-bridge/src/social/cognitiveGate.ts`
- Create: `apps/minecraft-bridge/src/social/cognitiveGate.test.ts`

**Interfaces:**
- Consumes: agent identity, visible recipient, compact verified relationship context, bounded untrusted utterances, existing `ProviderConcurrencyLimiter`, and `AbortSignal`.
- Produces: `SocialResponse`, `validateSocialResponse`, `SocialProvider.generate(input)`, `OpenAISocialProvider`, and `CognitiveGate`.

- [ ] **Step 1: Write failing response-validation and injection tests**

```ts
assert.equal(validateSocialResponse({
  message: 'Hello, Bob.', intent: 'greet', continueConversation: true
}, 180).success, true)
assert.equal(validateSocialResponse({
  message: 'alice stop', intent: 'reply', continueConversation: true
}, 180).success, false)
```

Reject extra/action/tool fields, unsupported intent, empty/control/oversized text, slash or `<agent> <command>` payloads, coordinates, URLs, code fences, shell/code/function syntax, and remembered injection attempts.

- [ ] **Step 2: Implement the validator, strict JSON schema, and prompt serialization**

Keep verified context and an `untrustedData` object separate in serialized input; no prior text is placed in the system instruction.

- [ ] **Step 3: Write failing provider request/response tests**

Assert `store: false`, strict schema, no `tools`, low reasoning, `max_output_tokens <= 256`, bounded timeout, usage parsing, abort propagation, refusal/incomplete/malformed/non-2xx safety, and absence of key/raw response/reasoning in errors or logs.

- [ ] **Step 4: Implement `OpenAISocialProvider`**

```ts
export interface SocialProvider {
  generate(input: SocialGenerationInput, signal?: AbortSignal): Promise<unknown>
  getLastTiming?(): LLMRequestTiming | null
}
```

Compose caller and timeout cancellation without exposing response bodies. Return parsed `unknown`, not a cast `SocialResponse`.

- [ ] **Step 5: Write and implement cognitive-gate tests**

Prove one deliberate call per agent, social suppression of new Brain calls, generation invalidation across manual/reflex/stop, no permanent busy state after failure, and independent gates for Alice/Bob.

- [ ] **Step 6: Validate, commit, and push**

Run: `npm test -- --test-name-pattern='social response|OpenAISocialProvider|CognitiveGate' && npm test && npm run typecheck && npm run build && git diff --check`

```bash
git add apps/minecraft-bridge/src/social
git commit -m "feat: add bounded social generation contract"
git push
```

### Task 4: Pairwise conversation coordinator and loop prevention

**Files:**
- Create: `apps/minecraft-bridge/src/social/conversationCoordinator.ts`
- Create: `apps/minecraft-bridge/src/social/conversationCoordinator.test.ts`

**Interfaces:**
- Consumes: `ConversationParticipant` adapters, `SocialProvider`, validator, relationship service, event/memory recorder callbacks, clock/scheduler, and social policy.
- Produces: `registerParticipant`, `startConversation`, `interruptAgent`, `observeEncounter`, `prepareStop`, `close`, `snapshot`, and exact terminal outcomes.

- [ ] **Step 1: Write failing session-state tests**

```ts
assert.deepEqual(await coordinator.startConversation('alice', 'bob', 'operator'), {
  accepted: true,
  conversationId: 'conversation-1'
})
assert.equal(coordinator.snapshot().sessions[0]?.currentSpeakerAgentId, 'alice')
```

Cover exact pair membership, duplicate/busy/cooldown rejection, deterministic alternating turns, max turns/calls, early farewell, timeout, participant disappearance, third-party overhearing, own chat, ordinary `say`, and non-member reply attempts.

- [ ] **Step 2: Run focused tests and confirm red state**

Run: `npm test -- --test-name-pattern='ConversationCoordinator'`

- [ ] **Step 3: Implement lifecycle generations and deterministic turn flow**

```ts
export interface ConversationParticipant {
  readonly agentId: string
  readonly username: string
  canSee(agentId: string): boolean
  isInDanger(): boolean
  beginSocialSession(conversationId: string): number
  generateSocial(input: SocialGenerationInput, generation: number): Promise<unknown>
  emitSocialMessage(message: string, generation: number): boolean
  recordSocialEvent(event: SocialEvent): Promise<void>
  endSocialSession(conversationId: string): void
}
```

Revalidate active session, generation, turn owner, visibility, danger, budget, and deadline after every await and before chat or persistence.

- [ ] **Step 4: Add runaway, stale-response, reflex/manual, shutdown, and cancellation races**

Hold provider promises open while closing/interruption/shutdown occurs; assert zero late chat, memory, relationship, or next-turn effects and exact stale telemetry.

- [ ] **Step 5: Validate, commit, and push**

Run: `npm test -- --test-name-pattern='ConversationCoordinator' && npm test && npm run typecheck && npm run build && git diff --check`

```bash
git add apps/minecraft-bridge/src/social/conversationCoordinator.ts apps/minecraft-bridge/src/social/conversationCoordinator.test.ts
git commit -m "feat: add bounded pairwise conversations"
git push
```

### Task 5: Perspective-specific social memory and compact Brain context

**Files:**
- Modify: `apps/minecraft-bridge/src/memory/types.ts`
- Modify: `apps/minecraft-bridge/src/memory/validate.ts`
- Modify: `apps/minecraft-bridge/src/memory/coordinator.ts`
- Modify: `apps/minecraft-bridge/src/memory/coordinator.test.ts`
- Modify: `apps/minecraft-bridge/src/memory/reflection.ts`
- Modify: `apps/minecraft-bridge/src/memory/reflection.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/types.ts`
- Modify: `apps/minecraft-bridge/src/brain/decisionContract.ts`
- Modify: `apps/minecraft-bridge/src/brain/decisionContract.test.ts`
- Create: `apps/minecraft-bridge/src/social/context.ts`
- Create: `apps/minecraft-bridge/src/social/context.test.ts`

**Interfaces:**
- Consumes: validated social events and owned directed relationship summaries.
- Produces: `AgentMemory.recordSocial(event)`, bounded social episode types, `VisibleAgentSocialContext[]`, and optional `BrainInput.socialContext`.

- [ ] **Step 1: Write failing social-memory tests**

Assert Alice/Bob perspective-specific episodes, bounded utterance message/identity/conversation metadata, no semantic fact creation, no reflection inclusion, deduplication by event ID, and safe persistence failure accounting.

- [ ] **Step 2: Implement social episode encoding and `recordSocial`**

```ts
export interface SocialMemoryEvent {
  event: SocialEvent
  position: MemoryPosition
  region: string
}
```

Store start/completion/interruption summaries and bounded recent utterances; do not call reflection from `recordSocial`, and filter social episode types from ordinary reflection batches.

- [ ] **Step 3: Write failing compact-context tests**

Assert only currently visible configured external agents appear, raw records/transcripts are absent, categories are deterministic, one recent unverified utterance remains labeled, and invisible memory cannot ground a target.

- [ ] **Step 4: Implement context mapping and Brain serialization**

```ts
export interface VisibleAgentSocialContext {
  agentId: string
  username: string
  relationship: {
    familiarity: 'unknown' | 'familiar'
    trust: 'negative' | 'neutral' | 'positive'
    affinity: 'negative' | 'neutral' | 'positive'
    reciprocity: 'negative' | 'neutral' | 'positive'
    interactionCount: number
  }
  lastVerifiedInteraction: string | null
  recentUnverifiedUtterance: string | null
}
```

- [ ] **Step 5: Validate, commit, and push**

Run: `npm test -- --test-name-pattern='social memory|social context|Brain decision contract|MemoryReflector' && npm test && npm run typecheck && npm run build && npm run benchmark:memory && git diff --check`

```bash
git add apps/minecraft-bridge/src/memory apps/minecraft-bridge/src/brain apps/minecraft-bridge/src/social/context.ts apps/minecraft-bridge/src/social/context.test.ts
git commit -m "feat: provide owned social memory and context"
git push
```

### Task 6: Runtime, command, telemetry, and shutdown integration

**Files:**
- Modify: `apps/minecraft-bridge/src/runtime/services.ts`
- Modify: `apps/minecraft-bridge/src/runtime/agentRuntime.ts`
- Modify: `apps/minecraft-bridge/src/runtime/agentRuntime.test.ts`
- Modify: `apps/minecraft-bridge/src/runtime/agentManager.ts`
- Modify: `apps/minecraft-bridge/src/runtime/agentManager.test.ts`
- Modify: `apps/minecraft-bridge/src/runtime/composition.ts`
- Modify: `apps/minecraft-bridge/src/runtime/telemetry.ts`
- Modify: `apps/minecraft-bridge/src/runtime/telemetry.test.ts`
- Modify: `apps/minecraft-bridge/src/agent/loop.ts`
- Modify: `apps/minecraft-bridge/src/agent/loop.test.ts`
- Modify: `apps/minecraft-bridge/src/survival/reflexLoop.ts`
- Modify: `apps/minecraft-bridge/src/survival/reflexLoop.test.ts`
- Modify: `apps/minecraft-bridge/src/commands/chatCommands.ts`
- Modify: `apps/minecraft-bridge/src/commands/chatCommands.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5 and existing runtime factories, limiter, state, arbiter, commands, loops, memory, and telemetry.
- Produces: production social participants, exact operator talk routing, cognitive exclusion, reflex/manual interruption, and ordered shared shutdown.

- [ ] **Step 1: Add failing exact command-routing tests**

Cover `alice talk bob`, visible configured target acceptance, unknown/self/invisible/busy rejection, configured-agent and non-operator rejection, prompt-shaped speech inertness, and no relationship delta on start alone.

- [ ] **Step 2: Add failing loop/cognitive tests**

Hold a Brain provider call while social starts and a social call while reflex/manual fires. Assert at most one deliberate provider call per runtime, ordinary Brain suppression during session, immediate reflex execution, and discarded stale outputs.

- [ ] **Step 3: Add failing runtime/manager shutdown tests**

Assert social/chat listeners are removed before drains, prepare-stop precedes runtime stop, active sessions close once, queued social calls abort, relationship/social-memory flush precedes bot quit, and coordinator/limiter close exactly once despite repeated shutdown.

- [ ] **Step 4: Integrate production composition conservatively**

Create the coordinator and participant resources only when social mode is enabled. Add a manager `prepareSharedStop` hook, preserve agent-local startup failure isolation, and leave one-agent/social-off construction behavior unchanged.

- [ ] **Step 5: Extend privacy-safe telemetry**

Record the specified social counters, numeric timings/tokens, categorical relationship-update counts, and stale/budget/loop rejections without messages, prompts, responses, or identities beyond existing agent identity.

- [ ] **Step 6: Validate, commit, and push**

Run: `npm test && npm run typecheck && npm run build && npm run benchmark:memory && git diff --check && git diff --check main...HEAD`

```bash
git add apps/minecraft-bridge/src/runtime apps/minecraft-bridge/src/agent apps/minecraft-bridge/src/survival apps/minecraft-bridge/src/commands
git commit -m "feat: integrate safe social runtime scheduling"
git push
```

### Task 7: Reliability harness, live validation, security review, and evidence

**Files:**
- Create: `apps/minecraft-bridge/src/social/reliability.ts`
- Create: `apps/minecraft-bridge/src/social/reliability.test.ts`
- Create: `apps/minecraft-bridge/src/social/validationCli.ts`
- Modify: `apps/minecraft-bridge/package.json`
- Create: `docs/social-foundation.md`

**Interfaces:**
- Consumes: production composition snapshots, social/relationship/memory telemetry, Paper process helper conventions, and the hard live call/cost budgets.
- Produces: versioned atomic privacy-safe M6 reports and reproduction commands.

- [ ] **Step 1: Write failing report/accounting tests**

Cover one/two/three-agent validity, startup/shutdown rates, completion rate, mean/median turns, timeout/interruption, runaway/routing/leak counters, provider failures/latency/queue wait/tokens/calls/cost, relationship updates, zero promoted claims, hard budget refusal, atomic report replacement, and transcript/secret absence.

- [ ] **Step 2: Implement the bounded validation runner and CLI**

Use explicit `M6_*` controls, a versioned schema, conservative `gpt-5-mini` rates, `calls <= 300`, `estimatedCostUsd < 1`, and `/tmp` output by default. Never emit provider or transcript bodies.

- [ ] **Step 3: Run the complete automated gates**

Run: `npm test && npm run typecheck && npm run build && npm run benchmark:memory && git diff --check && git diff --check main...HEAD`

- [ ] **Step 4: Run one final diff-scoped security review**

Preflight a compatible Python interpreter, then inspect event truth boundaries, prompt injection, feedback loops, command escalation, relationship path/identity isolation, provider secret handling, stale-response races, shutdown ordering, and memory poisoning. Reproduce and fix only confirmed findings test-first.

- [ ] **Step 5: Run bounded live validation in order**

Record Paper's initial running state. Run Alice alone, five stable Alice/Bob sessions, and five stable Alice/Bob/Charlie sessions with social enabled, auto greeting controlled, memory reflection false, model `gpt-5-mini`, and shared limiter 2. Exercise exact operator start, restart persistence, third-party exclusion, prompt-shaped speech, reflex interruption, and Brain resumption. Stop all agents and restore Paper's prior state.

- [ ] **Step 6: Write the evidence report and final checkpoint**

Document architecture, verified/unverified rules, relationship policy/isolation, session bounds, prompt defenses, scheduling, memory/context, commands, all requested metrics, bugs/fixes, tests, security results, cost, limitations, and exact reproduction commands.

- [ ] **Step 7: Validate, commit, and push the evidence**

Run: `npm test && npm run typecheck && npm run build && npm run benchmark:memory && git diff --check && git diff --check main...HEAD`

```bash
git add apps/minecraft-bridge/package.json apps/minecraft-bridge/src/social/reliability.ts apps/minecraft-bridge/src/social/reliability.test.ts apps/minecraft-bridge/src/social/validationCli.ts docs/social-foundation.md
git commit -m "docs: record social foundation validation"
git push
```

- [ ] **Step 8: Verify repository closure and create a draft PR**

Run the requested final status/log/gates, confirm `.env`, memory/social data ignores, no agent process, no active session or queued provider request, restored Paper state, clean tree, and local/remote branch parity. Create or update one draft PR titled `feat: add bounded multi-agent social foundation`; do not mark ready and do not merge.
