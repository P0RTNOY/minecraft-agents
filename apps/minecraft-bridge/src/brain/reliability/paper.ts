import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

interface BufferedLine {
  sequence: number
  value: string
}

export class BoundedLineBuffer {
  private readonly entries: BufferedLine[] = []
  private nextSequence = 0

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('Paper output buffer capacity must be a positive integer.')
    }
  }

  get oldestCursor(): number {
    return this.entries[0]?.sequence ?? this.nextSequence
  }

  append(value: string): void {
    this.entries.push({ sequence: this.nextSequence, value })
    this.nextSequence += 1
    if (this.entries.length > this.capacity) this.entries.shift()
  }

  scan(cursor: number, match: (line: string) => boolean): { matched: boolean; cursor: number } {
    let nextCursor = Math.max(cursor, this.oldestCursor)
    for (const entry of this.entries) {
      if (entry.sequence < nextCursor) continue
      nextCursor = entry.sequence + 1
      if (match(entry.value)) return { matched: true, cursor: nextCursor }
    }
    return { matched: false, cursor: nextCursor }
  }
}

export class PaperController {
  private process: ChildProcessWithoutNullStreams | null = null
  private readonly lines = new BoundedLineBuffer(500)
  private watchdogEvents = 0

  constructor(
    private readonly serverDirectory: string,
    private readonly startupTimeoutMs = 60_000
  ) {}

  get watchdogCount(): number {
    return this.watchdogEvents
  }

  async start(): Promise<void> {
    if (this.process) throw new Error('Paper is already managed by this runner.')
    const child = spawn('java', ['-Xms1G', '-Xmx2G', '-jar', 'paper.jar', '--nogui'], {
      cwd: this.serverDirectory,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.process = child
    this.capture(child.stdout)
    this.capture(child.stderr)
    await this.waitFor(line => line.includes('Done ('), this.startupTimeoutMs)
  }

  async runCommands(commands: readonly string[], marker: string): Promise<void> {
    const child = this.requireProcess()
    for (const command of commands) child.stdin.write(`${command}\n`)
    child.stdin.write(`say ${marker}\n`)
    await this.waitFor(line => line.includes(marker), 60_000)
  }

  send(command: string): void {
    this.requireProcess().stdin.write(`${command}\n`)
  }

  async stop(): Promise<void> {
    const child = this.process
    if (!child) return
    if (child.exitCode === null) {
      child.stdin.write('stop\n')
      await new Promise<void>(resolve => child.once('exit', () => resolve()))
    }
    this.process = null
  }

  private capture(stream: NodeJS.ReadableStream): void {
    createInterface({ input: stream }).on('line', line => {
      const plain = line.replaceAll(/\u001b\[[0-9;]*m/g, '')
      this.lines.append(plain)
      if (plain.includes('has not responded for')) this.watchdogEvents += 1
      process.stderr.write(`${plain}\n`)
    })
  }

  private async waitFor(match: (line: string) => boolean, timeoutMs: number): Promise<void> {
    const startedAt = Date.now()
    let cursor = this.lines.oldestCursor
    while (Date.now() - startedAt < timeoutMs) {
      const scan = this.lines.scan(cursor, match)
      if (scan.matched) return
      cursor = scan.cursor
      const child = this.requireProcess()
      if (child.exitCode !== null) throw new Error(`Paper exited with code ${child.exitCode}.`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Timed out waiting for Paper output.')
  }

  private requireProcess(): ChildProcessWithoutNullStreams {
    if (!this.process) throw new Error('Paper is not running.')
    return this.process
  }
}
