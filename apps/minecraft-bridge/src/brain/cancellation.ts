export interface CancellationScope {
  signal: AbortSignal
  dispose(): void
}

export function composeCancellation(
  signals: readonly (AbortSignal | undefined)[],
  timeoutMs?: number
): CancellationScope {
  const controller = new AbortController()
  const abort = () => controller.abort()
  for (const signal of signals) {
    if (!signal) continue
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', abort, { once: true })
  }
  const timer = timeoutMs === undefined ? null : setTimeout(abort, timeoutMs)
  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer)
      for (const signal of signals) signal?.removeEventListener('abort', abort)
    }
  }
}

export function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  message = 'Provider request was aborted.'
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(message))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(abortError(message))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

export function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function releaseUnusedResponseBody(response: Response): void {
  const body = response.body
  if (!body || response.bodyUsed || body.locked) return
  try {
    void body.cancel().catch(() => {})
  } catch {
    // Releasing a transport resource must not replace the provider error.
  }
}
