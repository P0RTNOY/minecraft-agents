export type AgentStatus =
  | 'idle'
  | 'moving'
  | 'following'
  | 'collecting'
  | 'fleeing'

export type AgentAction =
  | 'come_to_player'
  | 'follow_player'
  | 'follow_nearest_player'
  | 'collect_block'
  | 'flee_from_entity'

export type AgentActionSource = 'manual' | 'reflex' | 'autonomous'

export interface AgentState {
  agentName: string
  status: AgentStatus
  currentAction: AgentAction | null
  currentGoal: string | null
  actionSource: AgentActionSource | null
  busy: boolean
  actionVersion: number
  manualOverrideVersion: number
}

export function createAgentState(agentName: string): AgentState {
  if (!agentName?.trim()) {
    throw new Error('Agent name is required')
  }

  return {
    agentName: agentName.trim(),
    status: 'idle',
    currentAction: null,
    currentGoal: null,
    actionSource: null,
    busy: false,
    actionVersion: 0,
    manualOverrideVersion: 0
  }
}

export function beginAgentAction(
  state: AgentState,
  status: Exclude<AgentStatus, 'idle'>,
  action: AgentAction,
  goal: string,
  source: AgentActionSource = 'manual'
): number {
  state.actionVersion += 1
  state.status = status
  state.currentAction = action
  state.currentGoal = goal
  state.actionSource = source
  state.busy = true

  return state.actionVersion
}

export function markManualOverride(state: AgentState): number {
  state.manualOverrideVersion += 1
  return state.manualOverrideVersion
}

export function finishAgentAction(
  state: AgentState,
  actionVersion: number
): boolean {
  if (state.actionVersion !== actionVersion) {
    return false
  }

  resetAgentAction(state)
  return true
}

export function stopAgentAction(state: AgentState): void {
  state.actionVersion += 1
  resetAgentAction(state)
}

function resetAgentAction(state: AgentState): void {
  state.status = 'idle'
  state.currentAction = null
  state.currentGoal = null
  state.actionSource = null
  state.busy = false
}
