export interface ValidationOperatorBot {
  once(event: 'spawn', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  off(event: 'spawn', listener: () => void): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
  quit(reason: string): void
}

export interface ConnectValidationOperatorOptions<T extends ValidationOperatorBot> {
  host: string
  port: number
  timeoutMs?: number
  createBot(options: {
    host: string
    port: number
    username: 'M6Operator'
    auth: 'offline'
  }): T
}

export async function connectValidationOperator<T extends ValidationOperatorBot>(
  options: ConnectValidationOperatorOptions<T>
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('M6 operator spawn timeout is invalid.')
  }
  const bot = options.createBot({
    host: options.host,
    port: options.port,
    username: 'M6Operator',
    auth: 'offline'
  })
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout
    const cleanupListeners = () => {
      clearTimeout(timer)
      bot.off('spawn', onSpawn)
      bot.off('error', onError)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanupListeners()
      try {
        bot.quit('M6 validation operator connection failed')
      } catch {
        reject(new Error('M6 validation operator cleanup failed.'))
        return
      }
      reject(error)
    }
    const onSpawn = () => {
      if (settled) return
      settled = true
      cleanupListeners()
      resolve()
    }
    const onError = (error: Error) => fail(error)
    timer = setTimeout(
      () => fail(new Error('M6 operator spawn timed out.')),
      timeoutMs
    )
    bot.once('spawn', onSpawn)
    bot.once('error', onError)
  })
  return bot
}
