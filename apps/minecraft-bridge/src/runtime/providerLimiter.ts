interface QueuedProviderCall<T> {
  enqueuedAt: number
  signal?: AbortSignal
  onAbort?: () => void
  start(queueWaitMs: number): void
  reject(error: Error): void
}

export class ProviderConcurrencyLimiter {
  private readonly queue: Array<QueuedProviderCall<unknown>> = []
  private active = 0
  private closed = false

  constructor(
    private readonly maximum: number,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new Error('Provider concurrency limit must be a positive integer.')
    }
  }

  run<T>(
    task: (queueWaitMs: number) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.closed) return Promise.reject(closedError())
    if (signal?.aborted) return Promise.reject(abortedError())

    return new Promise<T>((resolve, reject) => {
      const queued: QueuedProviderCall<T> = {
        enqueuedAt: this.now(),
        ...(signal ? { signal } : {}),
        start: queueWaitMs => {
          this.removeAbortListener(queued)
          this.active += 1
          void task(queueWaitMs).then(resolve, reject).finally(() => {
            this.active -= 1
            this.drain()
          })
        },
        reject
      }
      if (signal) {
        queued.onAbort = () => {
          const index = this.queue.indexOf(queued as QueuedProviderCall<unknown>)
          if (index < 0) return
          this.queue.splice(index, 1)
          this.removeAbortListener(queued)
          reject(abortedError())
        }
        signal.addEventListener('abort', queued.onAbort, { once: true })
      }
      this.queue.push(queued as QueuedProviderCall<unknown>)
      this.drain()
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const queued of this.queue.splice(0)) {
      this.removeAbortListener(queued)
      queued.reject(closedError())
    }
  }

  private drain(): void {
    while (!this.closed && this.active < this.maximum) {
      const queued = this.queue.shift()
      if (!queued) return
      if (queued.signal?.aborted) {
        this.removeAbortListener(queued)
        queued.reject(abortedError())
        continue
      }
      queued.start(Math.max(0, this.now() - queued.enqueuedAt))
    }
  }

  private removeAbortListener(queued: QueuedProviderCall<unknown>): void {
    if (queued.signal && queued.onAbort) {
      queued.signal.removeEventListener('abort', queued.onAbort)
    }
  }
}

function abortedError(): Error {
  const error = new Error('Provider request queue was aborted.')
  error.name = 'AbortError'
  return error
}

function closedError(): Error {
  return new Error('Provider concurrency limiter is closed.')
}
