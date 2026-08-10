import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export class PaperController {
  private process: ChildProcessWithoutNullStreams | null = null
  private readonly lines: string[] = []
  private watchdogEvents = 0

  constructor(private readonly serverDirectory: string) {}

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
    await this.waitFor(line => line.includes('Done ('), 60_000)
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
      this.lines.push(plain)
      if (this.lines.length > 500) this.lines.shift()
      if (plain.includes('has not responded for')) this.watchdogEvents += 1
      process.stderr.write(`${plain}\n`)
    })
  }

  private async waitFor(match: (line: string) => boolean, timeoutMs: number): Promise<void> {
    const startedAt = Date.now()
    let index = 0
    while (Date.now() - startedAt < timeoutMs) {
      while (index < this.lines.length) {
        if (match(this.lines[index] ?? '')) return
        index += 1
      }
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
