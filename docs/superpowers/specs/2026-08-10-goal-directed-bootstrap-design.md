# Goal-Directed Bootstrap Design

## Scope

M3.1 evaluates whether Alice can make autonomous bootstrap progress with the
existing controlled action vocabulary. It adds process-local short-term goals,
deterministic progress facts, goal-aware repetition, a sequential benchmark,
provider timing evidence, and one bounded live evaluation. It does not add a
planner, durable memory, generated actions, or new Minecraft skills.

## Considered approaches

1. **Loop-owned goal manager (selected).** A small runtime object owns the
   current `ShortTermGoal` and derives progress from each fresh perception.
   This keeps goal state process-local and separate from
   `AgentState.currentGoal`, which describes the skill currently executing.
2. **Store the short-term goal in `AgentState`.** This would make the state
   visible everywhere, but it would conflate an advisory Brain objective with
   action lifecycle state and expand the manual/reflex surface unnecessarily.
3. **Ask the LLM to generate or plan goals.** This adds a second untrusted model
   output and conflicts with the controlled, deterministic design constraints.

## Goal model and lifecycle

The controlled goal types are:

- `establish_basic_resources`: obtain usable crafting access and a basic tool;
- `improve_tooling`: obtain a tool above the basic wooden tier;
- `improve_safety`: restore non-urgent health/food readiness when grounded
  capabilities can help;
- `explore_for_resources`: discover resources that unlock another useful goal.

Each goal has an application-generated id, type, fixed description, and
`active`, `completed`, or `abandoned` status. The manager keeps only the active
goal plus a bounded record of the most recent transition. Goal ids use a
process-local counter and reset on restart.

On each Brain cycle the manager computes progress first. It completes the
active goal only from world/inventory facts, then selects the next appropriate
goal deterministically. If the survival evaluator detects an immediate
emergency, no advisory goal is exposed for that cycle and the higher-priority
reflex layer remains responsible for action.

## Progress and capabilities

Progress is a compact fixed structure derived from current perception:

- wood, planks, crafting-table item, nearby crafting table;
- wooden/basic tool and improved tool;
- safe food availability and healthy survival state;
- useful resource observations;
- a deterministic completion boolean for the active goal.

Tool and resource categories use exact canonical Minecraft registry names and
small application-owned sets. They do not fuzzy-match model text. Available
capabilities expose only exact observed collectable block names, exact current
craftable item records, exact placeable inventory block names, and the existing
boolean ability to request bounded exploration.

The goal describes desired state, never a next action. The prompt tells the
model to choose one grounded action that changes goal progress, but contains no
wood-to-planks-to-table-to-tool walkthrough.

## Runtime data flow

`AutonomousAgentLoop` observes the world, asks the goal manager for the current
goal/progress snapshot, and constructs `BrainInput` with:

- `shortTermGoal`;
- `goalProgress`;
- `availableCapabilities`;
- existing perception, action state, previous result, and bounded history.

The provider still returns `unknown`. Existing schema validation, contextual
grounding, repetition policy, arbitration, executor dispatch, and skill-level
world revalidation remain in that order. Repetition fingerprints include goal
type and progress facts so a repeated action becomes permissible after
meaningful goal progress, while repeated no-progress idle/actions are rejected.

## Sequential benchmark

The bootstrap benchmark starts healthy and safe with one log, no table, and no
tool. It runs multiple decisions against evolving state. Only accepted,
context-grounded actions reach the simulator. The simulator models the narrow
inventory/capability effects needed for bootstrap evaluation; it does not
model navigation or Minecraft physics.

The report records schema validity, contextual grounding, policy acceptance,
action diversity, progress-producing/no-progress actions, idle rate, repeated
no-progress decisions, goal completion, wall latency, and provider token/load
timing when the provider exposes it. Provider/network failure is a recorded
sample outcome and does not abort later scenarios.

## Provider timing

The neutral provider interface gains an optional read-only last-request timing
snapshot. Ollama maps its existing nanosecond timing metadata; Groq maps only
standard usage counts that are present. The benchmark always records measured
wall latency and never records model reasoning, response headers, credentials,
or authorization values.

## Verification and live evaluation

Automated tests cover goal selection/completion/transitions, deterministic
progress, emergency behavior, Brain serialization and prompt constraints,
goal-aware repetition, sequential transitions and metrics, provider failures,
and all existing safety regressions. Tests require no Minecraft server or
network.

After all gates pass, a live run may use a temporary isolated platform and a
minimal starting inventory. Every Paper command is recorded, the run is
bounded, and temporary blocks/items are removed. If the server, models, or a
safe reversible setup are unavailable, the limitation is reported rather than
weakening safety.
