import type {
  AgentAction,
  AgentActionSource,
  AgentStatus
} from '../agent/state.js'
import type { PerceptionSnapshot } from '../perception/types.js'
import type { MemoryContext } from '../memory/types.js'
import type {
  AvailableCapabilities,
  GoalProgress,
  ShortTermGoal
} from './goals.js'

interface DecisionBase {
  reason: string
}

export type AgentDecision =
  | (DecisionBase & { action: 'idle' })
  | (DecisionBase & { action: 'scan' })
  | (DecisionBase & { action: 'explore' })
  | (DecisionBase & { action: 'follow_player'; username: string })
  | (DecisionBase & { action: 'come_to_player'; username: string })
  | (DecisionBase & { action: 'stop' })
  | (DecisionBase & { action: 'collect_block'; block: string })
  | (DecisionBase & { action: 'craft_item'; item: string; amount: number })
  | (DecisionBase & { action: 'place_block'; block: string })
  | (DecisionBase & { action: 'say'; message: string })

export type AgentDecisionAction = AgentDecision['action']

export interface BrainStateSnapshot {
  agentName: string
  status: AgentStatus
  currentAction: AgentAction | null
  currentGoal: string | null
  actionSource: AgentActionSource | null
  busy: boolean
}

export interface DecisionExecutionResult {
  success: boolean
  action: AgentDecisionAction
  status: 'completed' | 'started' | 'stopped' | 'cancelled' | 'failed'
  summary: string
  details?: Record<string, string | number | boolean>
}

export interface RecentDecision {
  decision: AgentDecision
  result: DecisionExecutionResult
  worldStateFingerprint: string
}

export interface BrainInput {
  perception: PerceptionSnapshot
  state: BrainStateSnapshot
  previousActionResult: DecisionExecutionResult | null
  recentDecisions: readonly RecentDecision[]
  shortTermGoal: ShortTermGoal | null
  goalProgress: GoalProgress | null
  availableCapabilities: AvailableCapabilities
  memory: MemoryContext
}
