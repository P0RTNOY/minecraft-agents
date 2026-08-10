# Core Minecraft Capabilities Design

## Scope

M3 adds three deliberate Brain actions—`explore`, `craft_item`, and
`place_block`—plus application-owned harvesting tool selection. It preserves
the existing `Manual > Reflex > LLM` arbiter and the pipeline of schema
validation, contextual grounding, controlled execution, and live-world
revalidation. Survival actions remain reflex-only, and no memory, combat,
general building, or arbitrary-coordinate interface is introduced.

## Chosen approach

Use dedicated, typed skills and a compact capability snapshot derived from the
live Mineflayer registry, inventory, recipes, and nearby world. This follows
the current collection/eating/flee patterns and keeps each capability directly
testable.

Two alternatives were rejected:

- A generic capability/plugin framework would add abstraction before the
  action vocabulary is large enough to justify it.
- A scripted “build a crafting table” macro would hide the general sequence
  `collect_block -> craft_item -> place_block -> craft_item` that M3 is meant
  to enable.

## Decision and data contracts

The deliberate decision union gains:

```ts
{ action: 'explore'; reason: string }
{ action: 'craft_item'; item: string; amount: number; reason: string }
{ action: 'place_block'; block: string; reason: string }
```

`explore` never accepts coordinates. Craft amounts are positive integers no
larger than 64. Item and block names remain exact canonical snake_case names;
there is no fuzzy matching.

Perception adds compact deterministic capabilities:

```ts
interface CraftableItemSnapshot {
  item: string
  maxCraftable: number
  requiresTable: boolean
}

craftableItems: CraftableItemSnapshot[]
placeableBlocks: InventoryItemSnapshot[]
nearbyCraftingTable: boolean
equippedItem: string | null
```

The Brain sees these summaries rather than the full recipe registry.
Contextual validation accepts craft requests only within the reported maximum
and placement requests only for reported inventory-backed blocks.

## Bounded exploration

`AGENT_EXPLORATION_RADIUS` defaults to 24 and is constrained to 8–32 blocks.
The application searches deterministic directions and shorter fallbacks within
that radius. A candidate must have solid support, passable feet/head blocks,
and no water or lava. Pathfinder confirms actual reachability. The skill owns
the selected destination, reports only distance/progress to the Brain, and
maps goal replacement to cancellation.

## Crafting and crafting tables

Craftability is calculated with `bot.recipesFor` and the active Minecraft
registry. A nearby crafting table is located within the same conservative
local bound. Table recipes appear as craftable only when a real nearby table
exists and current ingredients can satisfy the recipe.

At runtime `craftItem` rechecks the registry item, recipe, ingredients, and
table. When required, it approaches the table through Pathfinder, revalidates
the table and recipe after movement, executes the correct number of recipe
applications, and confirms the requested inventory delta. It never grants
items or uses an LLM-maintained recipe list.

## Safe local placement

Placeable capabilities include inventory items whose same-name registry block
is a solid block. The placement skill considers only nearby application-owned
candidates. A candidate needs solid support, a replaceable non-fluid target,
and clearance from Alice and nearby entities. The skill rechecks inventory and
world state after equipping, places against the support block, waits for the
world update, and verifies the resulting block name.

This supports placing a crafted `crafting_table` without exposing coordinates
or a general building planner.

## Harvesting tools

Collection uses the target block’s `canHarvest`/`harvestTools` registry data.
Hand-harvestable blocks remain valid. Required tools are selected only from the
live inventory, choosing the valid tool with the shortest registry-derived dig
time. Missing tools return `missing_required_tool` plus a concise tool class
such as `pickaxe`. Tool availability is checked again after navigation before
digging.

## Arbitration and cancellation

All new actions run through the existing shared `ActionArbiter`. Manual and
reflex actions continue to invalidate pending Brain generations before a new
skill can start. `cancelAgentAction` stops Pathfinder for exploration,
craft-table approach, and collection; action-version checks prevent crafting
or placement from continuing after a cancellation boundary where the
underlying Minecraft operation can still be avoided.

## Repetition and results

Execution results include concise reasons and measurable progress such as
crafted count, placed block, or exploration distance. The bounded recent
history remains the only history. Repetition checks use current capability and
world fingerprints so repeated actions are rejected when they produce no
state change, while legitimate sequences remain possible.

## Verification

Tests use fake Mineflayer boundaries and the real application code without a
Minecraft server, provider, or network. They cover endpoint safety,
cancellation, recipe/table/inventory grounding, placement revalidation,
harvesting tools, executor wiring, stale arbitration, semantics, repetition,
and benchmark classification. Final validation runs the full package suite,
typecheck, build, both diff checks, security/grounding/arbitration reviews, and
a controlled Paper smoke test when the existing server is responsive and the
world can be used safely.
