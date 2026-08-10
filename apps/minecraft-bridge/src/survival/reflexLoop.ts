import type { Bot } from 'mineflayer'

import type { ActionArbiter } from '../agent/actionArbiter.js'
import { cancelAgentAction } from '../agent/cancelAction.js'
import type { AgentState } from '../agent/state.js'
import { perceive } from '../perception/perceive.js'
import type { PerceptionSnapshot } from '../perception/types.js'
import { evaluateReflex } from './evaluateReflex.js'
import {
  executeSurvivalDecision,
  type SurvivalExecutionResult,
  type SurvivalExecutor
} from './execute.js'
import type { SurvivalDecision } from './types.js'

export interface ReflexLoopLogger {
  log(message: string): void
  error(message: string): void
}

export interface ReflexLoopOptions {
  bot: Bot
  state: AgentState
  arbiter: ActionArbiter
  intervalMs: number
  observe?: (bot: Bot) => PerceptionSnapshot
  evaluate?: (perception: PerceptionSnapshot) => SurvivalDecision | null
  execute?: SurvivalExecutor
  logger?: ReflexLoopLogger
}

export type ReflexCycleResult =
  | { status: 'no_action' }
  | {
      status: 'skipped'
      reason:
        | 'cycle_in_progress'
        | 'manual_action_active'
        | 'reflex_action_active'
        | 'priority_override'
    }
  | {
      status: 'executed'
      decision: SurvivalDecision
      result: SurvivalExecutionResult
    }
  | { status: 'observation_failed'; error: string }
  | { status: 'execution_failed'; error: string }

export class ReflexLoop {
  private readonly bot: Bot
  private readonly state: AgentState
  private readonly arbiter: ActionArbiter
  private readonly intervalMs: number
  private readonly observe: (bot: Bot) => PerceptionSnapshot
  private readonly evaluate: (
    perception: PerceptionSnapshot
  ) => SurvivalDecision | null
  private readonly execute: SurvivalExecutor
  private readonly logger: ReflexLoopLogger

  private running = false
  private cycleInProgress = false
  private timer: NodeJS.Timeout | null = null

  constructor(options: ReflexLoopOptions) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs < 100) {
      throw new Error('Reflex loop interval must be at least 100 ms.')
    }
    if (options.intervalMs > 500) {
      throw new Error('Reflex loop interval must be at most 500 ms.')
    }

    this.bot = options.bot
    this.state = options.state
    this.arbiter = options.arbiter
    this.intervalMs = options.intervalMs
    this.observe = options.observe ?? perceive
    this.evaluate = options.evaluate ?? evaluateReflex
    this.execute = options.execute ?? executeSurvivalDecision
    this.logger = options.logger ?? console
  }

  start(): void {
    if (this.running) return

    this.running = true
    void this.runAndSchedule()
  }

  stop(): void {
    this.running = false

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  async runCycle(): Promise<ReflexCycleResult> {
    if (this.cycleInProgress) {
      return { status: 'skipped', reason: 'cycle_in_progress' }
    }

    if (this.state.busy && this.state.actionSource === 'manual') {
      return { status: 'skipped', reason: 'manual_action_active' }
    }

    if (this.state.busy && this.state.actionSource === 'reflex') {
      return { status: 'skipped', reason: 'reflex_action_active' }
    }

    this.cycleInProgress = true

    try {
      let perception: PerceptionSnapshot
      try {
        perception = this.observe(this.bot)
      } catch (error) {
        const message = formatError(error)
        this.logger.error(`❌ Reflex observation failed: ${message}`)
        return { status: 'observation_failed', error: message }
      }

      const decision = this.evaluate(perception)
      if (!decision) {
        return { status: 'no_action' }
      }

      this.logger.log(`⚡ Reflex: ${decision.reason}`)
      this.logger.log(`⚙️ Executing reflex: ${decision.action}`)

      try {
        const arbitration = await this.arbiter.run({
          source: 'reflex',
          cancel: () => cancelAgentAction(this.bot, this.state),
          execute: () => {
            if (
              this.state.busy &&
              this.state.actionSource === 'autonomous'
            ) {
              cancelAgentAction(this.bot, this.state)
            }

            return this.execute(this.bot, this.state, decision)
          }
        })

        if (arbitration.status === 'rejected') {
          return { status: 'skipped', reason: 'priority_override' }
        }

        const result = arbitration.value
        this.logger[result.success ? 'log' : 'error'](
          `${result.success ? '✅' : '❌'} Reflex result: ${formatResult(result)}`
        )
        return { status: 'executed', decision, result }
      } catch (error) {
        const message = formatError(error)
        this.logger.error(`❌ Reflex execution failed: ${message}`)
        return { status: 'execution_failed', error: message }
      }
    } finally {
      this.cycleInProgress = false
    }
  }

  private async runAndSchedule(): Promise<void> {
    await this.runCycle()

    if (!this.running) return

    this.timer = setTimeout(() => {
      this.timer = null
      void this.runAndSchedule()
    }, this.intervalMs)
    this.timer.unref()
  }
}

function formatResult(result: SurvivalExecutionResult): string {
  if (result.success) {
    return result.action === 'eat'
      ? `ate ${result.item ?? 'food'}.`
      : `escaped ${result.targetName}.`
  }

  return result.reason
    ? `${result.action} failed (${result.reason}).`
    : `${result.action} failed.`
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
