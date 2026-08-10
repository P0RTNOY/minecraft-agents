# Survival Reflex Layer Design

## Goal

Add a small deterministic survival layer that can flee immediate threats and eat real inventory food without waiting for an LLM, while preserving every M0/M1 safety boundary.

## Chosen architecture

Run a fast `ReflexLoop` separately from the slower `AutonomousAgentLoop`. Both submit controlled actions through one small `ActionArbiter`, which explicitly enforces:

`manual > reflex > llm`

The arbiter serializes skill execution, cancels lower-priority work through existing Mineflayer cancellation primitives, and advances a generation whenever manual or reflex work takes priority. A Brain cycle captures that generation before awaiting its provider; a changed generation makes the returned LLM decision stale and prevents execution.

This was selected over adding reflex checks to the Brain timer because survival checks need a different cadence, and over event-only reactions because Mineflayer entity/health events do not provide one deterministic, testable world snapshot boundary.

## Survival decisions

Initial M2 keeps survival decisions separate from `AgentDecision`:

- `flee_from_entity` carries an observed entity ID and canonical entity name.
- `eat` carries no model-selected item; the skill chooses from current inventory.

The seven-action LLM vocabulary and provider schema remain unchanged. This avoids granting the model entity IDs or inventory item selection while leaving room for a later, separately reviewed vocabulary expansion.

## Grounding and runtime safety

Perception records the Minecraft registry category for entities and a computed safe-edible inventory count. The reflex evaluator only treats observations categorized by Minecraft data as hostile. Creepers use a dedicated emergency distance; other hostiles require both close range and low health.

The flee skill revalidates the entity ID, canonical name, hostile registry category, and non-player/non-self status immediately before movement. It derives escape candidates away from the live entity, accepts only candidates with support and passable body space, uses Pathfinder, and returns safe structured failures for disappearance, unsafe destinations, cancellation, and routing failure.

The eat skill reads live inventory and `bot.registry.foodsByName`, excludes foods with known harmful or unpredictable effects, chooses deterministically, revalidates the stack before equipping, consumes through Mineflayer, and reports structured failure if the item disappears or consumption fails.

## Reflex policy

Named initial thresholds:

- Creeper emergency: at or within 4 blocks.
- Other hostile emergency: at or within 5 blocks while health is at or below 10/20.
- Critical food: at or below 6/20 with at least one safe edible item.
- Reflex interval: 250 ms by default, configurable with `AGENT_REFLEX_INTERVAL_MS` and bounded to avoid a busy loop.

Threat reflexes are evaluated before hunger, so Alice does not stop to eat under immediate pressure. No distant hostile triggers flee merely because it exists.

## Cancellation and priority

Manual commands advance the highest-priority generation. `alice stop` cancels Pathfinder movement, digging, and active item use. A reflex invalidates any pending Brain response, cancels an active lower-priority skill, waits for its controlled execution to settle, then starts. Lower-priority requests cannot displace higher-priority work, and only one controlled skill body runs at a time.

The existing action-version guard remains defense in depth so completion from a cancelled action cannot clear the replacement action.

## Observability

Only triggered reflexes log, using concise distinct messages such as:

```text
⚡ Reflex: creeper at 2.4m
⚙️ Executing reflex: flee_from_entity
✅ Reflex result: escaped threat
```

Empty ticks do not log. Brain logs retain the `🧠` prefix.

## Testing and rollout

Every checkpoint follows red-green-refactor, focused tests, the full test/typecheck/build/diff gate, diff review, a local conventional commit, and a non-force push to `origin/feature/autonomous-brain-iteration`.

Automated tests mock Mineflayer boundaries and require no server, model, provider key, or network. Live Minecraft checks run only if the local Paper server is already safely available; no hostile is spawned or structure placed for testing.
