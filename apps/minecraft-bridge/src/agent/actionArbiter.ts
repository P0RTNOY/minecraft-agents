import type { AgentActionSource } from './state.js'

export type ArbitrationRejectionReason =
  | 'priority_blocked'
  | 'stale'
  | 'superseded'

export type ArbitrationResult<T> =
  | { status: 'executed'; value: T }
  | { status: 'rejected'; reason: ArbitrationRejectionReason }

export interface ArbitrationRequest<T> {
  source: AgentActionSource
  expectedGeneration?: number
  execute(): Promise<T>
  cancel(): void
}

interface ActiveAction {
  source: AgentActionSource
  cancel(): void
  completion: Promise<void>
}

const ACTION_PRIORITY: Record<AgentActionSource, number> = {
  autonomous: 1,
  reflex: 2,
  manual: 3
}

export class ActionArbiter {
  private generation = 0
  private active: ActiveAction | null = null

  captureGeneration(): number {
    return this.generation
  }

  interrupt(source: Exclude<AgentActionSource, 'autonomous'>): number {
    this.generation += 1

    if (
      this.active &&
      ACTION_PRIORITY[source] > ACTION_PRIORITY[this.active.source]
    ) {
      this.active.cancel()
    }

    return this.generation
  }

  async run<T>(
    request: ArbitrationRequest<T>
  ): Promise<ArbitrationResult<T>> {
    if (
      request.expectedGeneration !== undefined &&
      request.expectedGeneration !== this.generation
    ) {
      return { status: 'rejected', reason: 'stale' }
    }

    const active = this.active
    if (
      active &&
      ACTION_PRIORITY[request.source] <= ACTION_PRIORITY[active.source]
    ) {
      return { status: 'rejected', reason: 'priority_blocked' }
    }

    const requestGeneration = request.source === 'autonomous'
      ? this.generation
      : ++this.generation

    if (active) {
      active.cancel()
      await active.completion

      if (requestGeneration !== this.generation) {
        return { status: 'rejected', reason: 'superseded' }
      }
    }

    if (
      request.expectedGeneration !== undefined &&
      request.expectedGeneration !== this.generation
    ) {
      return { status: 'rejected', reason: 'stale' }
    }

    if (this.active) {
      return { status: 'rejected', reason: 'priority_blocked' }
    }

    let complete!: () => void
    const completion = new Promise<void>(resolve => {
      complete = resolve
    })
    const current: ActiveAction = {
      source: request.source,
      cancel: request.cancel,
      completion
    }
    this.active = current

    try {
      return {
        status: 'executed',
        value: await request.execute()
      }
    } finally {
      if (this.active === current) {
        this.active = null
      }
      complete()
    }
  }
}
