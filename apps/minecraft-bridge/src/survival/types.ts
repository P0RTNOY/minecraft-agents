export interface FleeDecision {
  action: 'flee_from_entity'
  entityId: number
  entityName: string
  reason: string
}

export interface EatDecision {
  action: 'eat'
  reason: string
}

export type SurvivalDecision = FleeDecision | EatDecision
