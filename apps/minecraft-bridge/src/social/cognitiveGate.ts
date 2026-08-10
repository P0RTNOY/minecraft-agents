export type CognitiveSuppressionReason = 'busy' | 'social_session' | 'stopped'

export type CognitiveRunResult<T> =
  | { status: 'completed'; value: T }
  | { status: 'suppressed'; reason: CognitiveSuppressionReason }
  | { status: 'stale' }

interface ActiveCall {
  generation: number
  controller: AbortController
}

export interface CognitiveGateSnapshot {
  generation: number
  socialSessionId: string | null
  busy: boolean
  stopped: boolean
}

export class CognitiveGate {
  private generation = 0
  private socialSessionId: string | null = null
  private active: ActiveCall | null = null
  private stopped = false
  private readonly idleWaiters = new Set<() => void>()

  async runBrain<T>(
    task: (signal: AbortSignal) => Promise<T>
  ): Promise<CognitiveRunResult<T>> {
    if (this.stopped) return suppressed('stopped')
    if (this.socialSessionId) return suppressed('social_session')
    if (this.active) return suppressed('busy')
    return this.execute(this.generation, task)
  }

  beginSocialSession(conversationId: string): number {
    validateConversationId(conversationId)
    if (this.stopped) throw new Error('Cognitive gate is stopped.')
    if (this.socialSessionId) {
      throw new Error('Cognitive gate already has an active social session.')
    }
    this.socialSessionId = conversationId
    this.generation += 1
    this.active?.controller.abort()
    return this.generation
  }

  async runSocial<T>(
    expectedGeneration: number,
    task: (signal: AbortSignal) => Promise<T>
  ): Promise<CognitiveRunResult<T>> {
    if (!this.socialSessionId || !this.matches(expectedGeneration)) {
      return { status: 'stale' }
    }
    await this.waitUntilIdle()
    if (!this.socialSessionId || !this.matches(expectedGeneration)) {
      return { status: 'stale' }
    }
    return this.execute(expectedGeneration, task)
  }

  invalidate(_source: 'manual' | 'reflex' | 'session' | 'shutdown'): number {
    this.generation += 1
    this.active?.controller.abort()
    return this.generation
  }

  endSocialSession(conversationId: string): void {
    if (this.socialSessionId !== conversationId) return
    this.socialSessionId = null
    this.invalidate('session')
  }

  isCurrent(conversationId: string, expectedGeneration: number): boolean {
    return !this.stopped &&
      this.socialSessionId === conversationId &&
      this.matches(expectedGeneration)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.socialSessionId = null
    this.invalidate('shutdown')
  }

  snapshot(): CognitiveGateSnapshot {
    return {
      generation: this.generation,
      socialSessionId: this.socialSessionId,
      busy: this.active !== null,
      stopped: this.stopped
    }
  }

  private async execute<T>(
    generation: number,
    task: (signal: AbortSignal) => Promise<T>
  ): Promise<CognitiveRunResult<T>> {
    const call: ActiveCall = {
      generation,
      controller: new AbortController()
    }
    this.active = call
    try {
      const value = await task(call.controller.signal)
      return this.active === call && this.matches(generation)
        ? { status: 'completed', value }
        : { status: 'stale' }
    } catch (error) {
      if (this.active !== call || !this.matches(generation)) {
        return { status: 'stale' }
      }
      throw error
    } finally {
      if (this.active === call) {
        this.active = null
        this.resolveIdleWaiters()
      }
    }
  }

  private matches(expectedGeneration: number): boolean {
    return !this.stopped && this.generation === expectedGeneration
  }

  private async waitUntilIdle(): Promise<void> {
    while (this.active) {
      await new Promise<void>(resolve => this.idleWaiters.add(resolve))
    }
  }

  private resolveIdleWaiters(): void {
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }
}

function suppressed(reason: CognitiveSuppressionReason): CognitiveRunResult<never> {
  return { status: 'suppressed', reason }
}

function validateConversationId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('Conversation identity is invalid.')
  }
}
