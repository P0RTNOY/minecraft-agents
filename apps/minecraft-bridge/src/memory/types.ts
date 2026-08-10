export const MEMORY_SCHEMA_VERSION = 1 as const
export const DEFAULT_MAX_EPISODES = 200
export const DEFAULT_MAX_SEMANTIC_FACTS = 100

export type EpisodeType =
  | 'resource_discovery'
  | 'landmark_discovery'
  | 'successful_craft'
  | 'action_failure'
  | 'threat_encounter'
  | 'player_interaction'
  | 'goal_milestone'
  | 'exploration_discovery'

export type EpisodeSource =
  | 'perception'
  | 'action'
  | 'goal'
  | 'reflex'
  | 'player'

export type SemanticRelation =
  | 'resource_observed_near'
  | 'landmark_observed_near'
  | 'danger_observed_near'
  | 'player_interacted_near'
  | 'outcome_repeated_near'

export interface MemoryIdentity {
  agentId: string
  worldId: string
}

export interface MemoryPosition {
  x: number
  y: number
  z: number
}

export interface EpisodeContext {
  region: string
  position?: MemoryPosition
  resource?: string
  landmark?: string
  player?: string
  action?: string
  target?: string
  outcome?: string
  goalType?: string
}

export interface EpisodicMemory extends MemoryIdentity {
  id: string
  timestamp: number
  type: EpisodeType
  summary: string
  importance: number
  source: EpisodeSource
  context: EpisodeContext
}

export interface SemanticMemory extends MemoryIdentity {
  id: string
  createdAt: number
  lastObservedAt: number
  subject: string
  relation: SemanticRelation
  object: string
  confidence: number
  status: 'historical' | 'stale'
  contradictionCount: number
  evidenceEpisodeIds: string[]
}

export interface ReflectionCursor {
  lastReflectedEpisodeTimestamp: number | null
  lastReflectionAt: number | null
}

export interface MemoryDocumentV1 {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION
  identity: MemoryIdentity
  updatedAt: number
  episodes: EpisodicMemory[]
  semanticFacts: SemanticMemory[]
  reflection: ReflectionCursor
}

export interface MemoryStore {
  open(): Promise<void>
  addEpisode(episode: EpisodicMemory): Promise<void>
  listRecentEpisodes(limit: number): Promise<EpisodicMemory[]>
  addSemanticFact(fact: SemanticMemory): Promise<void>
  listSemanticFacts(limit: number): Promise<SemanticMemory[]>
  reflectionState(): Promise<ReflectionCursor>
  updateReflectionState(state: ReflectionCursor): Promise<void>
}
