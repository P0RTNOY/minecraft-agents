# Core Minecraft Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded exploration, registry-grounded crafting, safe local block placement, and deterministic harvesting tools without weakening the existing M0–M2 safety pipeline.

**Architecture:** Extend the current typed decision contract with three dedicated actions and derive compact capabilities from Mineflayer-owned registry, recipe, inventory, and world state. Context validation grounds model proposals, each skill revalidates live state, and the existing shared arbiter remains the only execution boundary.

**Tech Stack:** TypeScript, Node test runner, Mineflayer 4.37, mineflayer-pathfinder 2.4, Minecraft registry/recipe data already bundled by Mineflayer.

## Global Constraints

- Preserve `Manual > Reflex > LLM` and all M0/M1/M2 behavior.
- Add only `explore`, `craft_item`, and `place_block` to the deliberate vocabulary.
- Never accept model-supplied coordinates, entity IDs, inventory slots, code, shell input, or dynamic function names.
- Use exact canonical registry names with no fuzzy matching.
- Add no dependencies and require no Minecraft, Ollama, Groq, or network access in automated tests.
- Do not add memory, combat, general building, multi-agent behavior, or long-term planning.

---

### Task 1: Bounded exploration

**Files:**
- Modify: `.env.example`
- Modify: `apps/minecraft-bridge/src/brain/config.ts`
- Modify: `apps/minecraft-bridge/src/brain/config.test.ts`
- Modify: `apps/minecraft-bridge/src/agent/state.ts`
- Create: `apps/minecraft-bridge/src/skills/explore.ts`
- Create: `apps/minecraft-bridge/src/skills/explore.test.ts`
- Modify: `apps/minecraft-bridge/src/skills/index.ts`
- Modify: `apps/minecraft-bridge/src/skills/execute.ts`
- Modify: `apps/minecraft-bridge/src/skills/execute.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/types.ts`
- Modify: `apps/minecraft-bridge/src/brain/decisionContract.ts`
- Modify: `apps/minecraft-bridge/src/brain/decisionContract.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/validateDecision.ts`
- Modify: `apps/minecraft-bridge/src/brain/validateDecision.test.ts`
- Modify: `apps/minecraft-bridge/src/bot.ts`

**Interfaces:**
- Produces: `exploreArea(bot, state, radius, source?) -> Promise<ExploreResult>`
- Produces: `findExplorationDestination(bot, radius) -> Vec3 | null`
- Extends: `BrainConfig.explorationRadius: number`
- Extends: `AgentDecision` with `{ action: 'explore'; reason: string }`

- [ ] **Step 1: Write failing configuration and destination tests**

```ts
assert.equal(loadBrainConfig({}).explorationRadius, 24)
assert.throws(
  () => loadBrainConfig({ AGENT_EXPLORATION_RADIUS: '33' }),
  /at most 32/
)

const destination = findExplorationDestination(bot, 24)
assert.ok(destination)
assert.ok(horizontalDistance(bot.entity.position, destination) <= 24)
```

- [ ] **Step 2: Write failing execution tests**

```ts
const result = await createExploreSkill(navigator)(bot, state, 24)
assert.equal(result.success, true)
assert.equal(result.action, 'explore')
assert.equal(state.busy, false)
```

Cover invalid support/fluid endpoints, `GoalChanged` cancellation, and ordinary
navigation failure. Assert the JSON schema for `explore` rejects coordinate
fields.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
cd apps/minecraft-bridge
node --import tsx --test src/brain/config.test.ts src/skills/explore.test.ts src/brain/validateDecision.test.ts
```

Expected: failures because exploration config, types, schema, and skill do not
exist.

- [ ] **Step 4: Implement the minimal bounded skill and wiring**

Use deterministic angle/distance candidates, require solid support plus empty
non-fluid feet/head blocks, and navigate with `GoalNear`. Start/finish an
`exploring` action version and translate goal replacement to `cancelled`.
Pass the validated configured radius from `bot.ts` into the decision executor;
do not add a decision field for it.

- [ ] **Step 5: Run focused and full tests**

```bash
npm test -- --test-name-pattern='explore|loadBrainConfig|decision executor|validateDecision'
npm test
npm run typecheck
```

Expected: all tests pass and the existing 118 tests remain green.

- [ ] **Step 6: Review and commit**

```bash
git diff --check
git add .env.example apps/minecraft-bridge/src
git commit -m "feat: add bounded exploration skill"
```

---

### Task 2: Registry-grounded crafting and capability perception

**Files:**
- Create: `apps/minecraft-bridge/src/skills/crafting.ts`
- Create: `apps/minecraft-bridge/src/skills/crafting.test.ts`
- Modify: `apps/minecraft-bridge/src/perception/types.ts`
- Modify: `apps/minecraft-bridge/src/perception/perceive.ts`
- Modify: `apps/minecraft-bridge/src/perception/perceive.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/types.ts`
- Modify: `apps/minecraft-bridge/src/brain/decisionContract.ts`
- Modify: `apps/minecraft-bridge/src/brain/decisionContract.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/validateDecision.ts`
- Modify: `apps/minecraft-bridge/src/brain/validateDecision.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/semantics.ts`
- Modify: `apps/minecraft-bridge/src/brain/semantics.test.ts`
- Modify: `apps/minecraft-bridge/src/skills/execute.ts`
- Modify: `apps/minecraft-bridge/src/skills/execute.test.ts`
- Modify: `apps/minecraft-bridge/src/agent/state.ts`
- Modify: `apps/minecraft-bridge/src/agent/cancelAction.test.ts`

**Interfaces:**
- Produces: `inspectCraftingCapabilities(bot, radius) -> CraftingCapabilities`
- Produces: `craftItem(bot, state, itemName, amount, source?) -> Promise<CraftResult>`
- Extends: `PerceptionSnapshot.craftableItems`, `nearbyCraftingTable`, and `equippedItem`
- Extends: `AgentDecision` with `{ action: 'craft_item'; item: string; amount: number; reason: string }`
- Extends: `DecisionValidationContext.craftableItems`

- [ ] **Step 1: Write failing capability and craft tests**

```ts
assert.deepEqual(inspectCraftingCapabilities(bot, 16).craftableItems, [
  { item: 'oak_planks', maxCraftable: 8, requiresTable: false }
])

const result = await craftItem(bot, state, 'oak_planks', 4)
assert.equal(result.success, true)
assert.equal(result.crafted, 4)
```

Add deterministic cases for unknown registry items, no recipe, insufficient
ingredients, missing crafting table, table disappearing after navigation,
ingredients disappearing before craft, craft failure, and unconfirmed output
delta.

- [ ] **Step 2: Write failing validation/semantic tests**

```ts
assert.equal(validateDecision({
  action: 'craft_item', item: 'oak_planks', amount: 4, reason: 'Need planks.'
}, context).success, true)

assert.equal(validateDecision({
  action: 'craft_item', item: 'diamond_pickaxe', amount: 1, reason: 'Upgrade.'
}, context).success, false)
```

Assert amount is an integer in `1..64` and does not exceed the capability’s
`maxCraftable` value.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
node --import tsx --test src/skills/crafting.test.ts src/perception/perceive.test.ts src/brain/semantics.test.ts src/brain/validateDecision.test.ts
```

Expected: failures for missing crafting interfaces and context fields.

- [ ] **Step 4: Implement registry-derived capability calculation**

Iterate registry items, call `bot.recipesFor(item.id, null, 1,
craftingTableOrFalse)`, and compute maximum output from each recipe’s negative
inventory deltas and result count. Sort by item name and emit only entries with
positive output. Find a real crafting table with `bot.findBlock` inside the
local radius.

- [ ] **Step 5: Implement live crafting revalidation**

Resolve the registry item and all recipes. Distinguish `unknown_item`,
`recipe_unavailable`, `insufficient_ingredients`, and
`crafting_table_unavailable`. If a table recipe is selected, navigate to the
table, recheck the block and recipe, calculate recipe applications as
`Math.ceil(amount / recipe.result.count)`, invoke `bot.craft`, and confirm the
inventory-name delta is at least the requested amount.

- [ ] **Step 6: Wire schema, semantics, context, executor, and cancellation**

Serialize only `{ item, maxCraftable, requiresTable }`, the nearby-table flag,
and equipped item. Add action/state variants and structured execution details;
reuse the shared arbiter and Pathfinder cancellation.

- [ ] **Step 7: Run focused/full verification and commit**

```bash
npm test -- --test-name-pattern='craft|perceive|semantics|validateDecision|decision executor'
npm test
npm run typecheck
npm run build
git diff --check
git add apps/minecraft-bridge/src
git commit -m "feat: add grounded crafting skill"
```

---

### Task 3: Safe local block placement

**Files:**
- Create: `apps/minecraft-bridge/src/skills/placement.ts`
- Create: `apps/minecraft-bridge/src/skills/placement.test.ts`
- Modify: `apps/minecraft-bridge/src/perception/types.ts`
- Modify: `apps/minecraft-bridge/src/perception/perceive.ts`
- Modify: `apps/minecraft-bridge/src/perception/perceive.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/types.ts`
- Modify: `apps/minecraft-bridge/src/brain/decisionContract.ts`
- Modify: `apps/minecraft-bridge/src/brain/decisionContract.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/validateDecision.ts`
- Modify: `apps/minecraft-bridge/src/brain/validateDecision.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/semantics.ts`
- Modify: `apps/minecraft-bridge/src/brain/semantics.test.ts`
- Modify: `apps/minecraft-bridge/src/skills/execute.ts`
- Modify: `apps/minecraft-bridge/src/skills/execute.test.ts`
- Modify: `apps/minecraft-bridge/src/agent/state.ts`

**Interfaces:**
- Produces: `inspectPlaceableBlocks(bot) -> InventoryItemSnapshot[]`
- Produces: `findPlacementTarget(bot) -> PlacementTarget | null`
- Produces: `placeInventoryBlock(bot, state, blockName, source?) -> Promise<PlacementResult>`
- Extends: `AgentDecision` with `{ action: 'place_block'; block: string; reason: string }`
- Extends: `DecisionValidationContext.placeableBlocks`

- [ ] **Step 1: Write failing placement tests**

```ts
assert.deepEqual(inspectPlaceableBlocks(bot), [
  { name: 'crafting_table', count: 1 }
])

const result = await placeInventoryBlock(bot, state, 'crafting_table')
assert.equal(result.success, true)
assert.equal(result.placed, true)
```

Cover unknown/non-placeable inventory items, occupied target, missing support,
fluid targets, entity/Alice collision, item disappearing after target
selection, failed equip, failed placement, cancellation before placement, and
world-block verification failure.

- [ ] **Step 2: Write failing grounding tests**

```ts
assert.equal(validateDecision({
  action: 'place_block', block: 'crafting_table', reason: 'Need a table.'
}, context).success, true)

assert.equal(validateDecision({
  action: 'place_block', block: 'tnt', reason: 'Place it.'
}, context).success, false)
```

- [ ] **Step 3: Run focused tests and verify RED**

```bash
node --import tsx --test src/skills/placement.test.ts src/perception/perceive.test.ts src/brain/validateDecision.test.ts
```

Expected: failures for missing placement skill and capability context.

- [ ] **Step 4: Implement local candidate derivation and placement**

Allow only inventory names with same-name solid registry blocks. Examine a
fixed adjacent-offset list; require a solid support block, an empty non-fluid
target, and entity clearance. Equip the exact live inventory item, recheck
action version/item/target/support, call `placeBlock(support, up)`, wait for the
world update, and verify the placed block name.

- [ ] **Step 5: Wire context, schema, semantics, and executor**

Expose compact placeable counts, reject any absent exact name, and report
structured reasons including `block_unavailable`, `no_safe_position`,
`target_changed`, `equip_failed`, `place_failed`, `placement_not_confirmed`,
and `action_cancelled`.

- [ ] **Step 6: Run focused/full verification and commit**

```bash
npm test -- --test-name-pattern='place|perceive|semantics|validateDecision|decision executor'
npm test
npm run typecheck
npm run build
git diff --check
git add apps/minecraft-bridge/src
git commit -m "feat: add safe block placement skill"
```

---

### Task 4: Deterministic harvesting tools

**Files:**
- Create: `apps/minecraft-bridge/src/skills/tools.ts`
- Create: `apps/minecraft-bridge/src/skills/tools.test.ts`
- Modify: `apps/minecraft-bridge/src/skills/collection.ts`
- Modify: `apps/minecraft-bridge/src/skills/collection.test.ts`
- Modify: `apps/minecraft-bridge/src/skills/execute.ts`
- Modify: `apps/minecraft-bridge/src/skills/execute.test.ts`

**Interfaces:**
- Produces: `selectHarvestTool(bot, block) -> HarvestToolSelection`
- Extends: `CollectionFailureReason` with `missing_required_tool` and `tool_unavailable`
- Extends: `CollectionResult.requiredTool?: string` and `tool?: string`

- [ ] **Step 1: Write failing tool-selection tests**

```ts
assert.deepEqual(selectHarvestTool(bot, oakLog), {
  required: false,
  item: null,
  requiredTool: null
})

assert.equal(selectHarvestTool(botWithPickaxes, stone).item?.name, 'iron_pickaxe')
assert.equal(selectHarvestTool(emptyBot, stone).requiredTool, 'pickaxe')
```

Use registry-backed block fakes to cover hand harvesting, valid tool choice,
tier restrictions, and missing tools.

- [ ] **Step 2: Write failing collection revalidation tests**

Assert collection returns `missing_required_tool` before navigation when no
valid tool exists, equips the chosen exact stack before digging, and returns
`tool_unavailable` if that stack disappears after navigation.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
node --import tsx --test src/skills/tools.test.ts src/skills/collection.test.ts
```

Expected: failures because collection currently ignores harvest tools.

- [ ] **Step 4: Implement tool selection and collection integration**

Treat `block.canHarvest(null)` as hand-harvestable. Otherwise filter live
inventory through `block.canHarvest(item.type)`, rank valid tools by the
block’s registry-derived dig time, and equip the best live stack. Recheck the
target and tool after movement before digging; never grant or synthesize a
tool.

- [ ] **Step 5: Run focused/full verification and commit**

```bash
npm test -- --test-name-pattern='tool|collection|decision executor'
npm test
npm run typecheck
npm run build
git diff --check
git add apps/minecraft-bridge/src/skills
git commit -m "fix: enforce Minecraft harvesting tools"
```

---

### Task 5: Progress policy and Brain benchmark

**Files:**
- Modify: `apps/minecraft-bridge/src/brain/repetition.ts`
- Modify: `apps/minecraft-bridge/src/brain/repetition.test.ts`
- Modify: `apps/minecraft-bridge/src/agent/loop.ts`
- Modify: `apps/minecraft-bridge/src/agent/loop.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/benchmark/scenarios.ts`
- Modify: `apps/minecraft-bridge/src/brain/benchmark/run.ts`
- Modify: `apps/minecraft-bridge/src/brain/benchmark/run.test.ts`
- Modify: `apps/minecraft-bridge/src/brain/benchmark/scenarios.test.ts`
- Modify: `docs/brain-benchmark.md`

**Interfaces:**
- Extends: repetition rejection reason with `stagnant_action`
- Extends: benchmark decision signatures for `craft_item` and `place_block`

- [ ] **Step 1: Write failing no-progress repetition tests**

```ts
assert.deepEqual(assessRepetition(exploreDecision, unchangedInput), {
  allowed: false,
  reason: 'stagnant_action'
})
```

Construct two successful recent identical decisions with unchanged capability
fingerprints. Also assert inventory/craftability or nearby-world changes allow
the next action.

- [ ] **Step 2: Write failing benchmark scenario tests**

Add scenarios for log-to-planks, planks-to-table, nearby-table recipes, safe
exploration, and an uncraftable hallucinated item. Assert coverage and result
classification, not an exact model choice.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
node --import tsx --test src/brain/repetition.test.ts src/brain/benchmark/run.test.ts src/brain/benchmark/scenarios.test.ts
```

- [ ] **Step 4: Implement generic progress fingerprinting and benchmark support**

Use exact decision signatures plus a capability/world fingerprint that omits
irrelevant timestamps. Reject a third identical successful action only when
the fingerprint has not changed. Add signature handling for craft item+amount
and placed block; retain schema/context/latency reporting.

- [ ] **Step 5: Run benchmark unit tests and full gates**

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

- [ ] **Step 6: Review and commit**

```bash
git add apps/minecraft-bridge/src/brain apps/minecraft-bridge/src/agent/loop.ts apps/minecraft-bridge/src/agent/loop.test.ts docs/brain-benchmark.md
git commit -m "test: validate autonomous capability progress"
```

---

### Task 6: Final review, live validation, and publication

**Files:**
- Modify only files required by confirmed review or live-test defects.

**Interfaces:**
- Consumes all M3 actions through the existing `AutonomousAgentLoop` and shared `ActionArbiter`.
- Produces a verified remote feature branch with no uncommitted state.

- [ ] **Step 1: Run the complete automated gate**

```bash
cd apps/minecraft-bridge
npm test
npm run typecheck
npm run build
git diff --check
git diff --check main...HEAD
```

- [ ] **Step 2: Perform focused read-only reviews**

Inspect the M3 diff for arbitrary input paths, ungrounded names, stale-decision
execution, cancellation races, unsafe placement endpoints, incorrect recipe or
tool assumptions, secrets, and regressions to reflex/autonomy-off behavior.
Use `rg` to audit secret patterns without printing secret values.

- [ ] **Step 3: Run a controlled Paper smoke test if responsive and safe**

Validate log collection, planks, crafting table craft/place, one table recipe,
bounded exploration, manual stop, and reflex preemption. Use tagged temporary
entities only, avoid structures, record exact commands, and restore health,
food, effects, inventory, and test entities.

- [ ] **Step 4: Fix only reproduced defects with RED/GREEN tests**

For each confirmed issue, add the smallest regression test, verify it fails,
apply one focused fix, rerun the focused live scenario, and create a focused
commit.

- [ ] **Step 5: Re-run final gates and inspect Git state**

```bash
git status
git log --oneline --decorate -20
cd apps/minecraft-bridge
npm test
npm run typecheck
npm run build
git diff --check
git diff --check main...HEAD
```

- [ ] **Step 6: Push without rewriting history**

```bash
git push origin feature/autonomous-brain-iteration
```

Expected: local and remote HEAD match, all checks pass, and the worktree is
clean.
