import type { Bot } from 'mineflayer'

import { ActionArbiter } from './actionArbiter.js'
import { cancelAgentAction } from './cancelAction.js'
import type { AgentState } from './state.js'
import type { LLMProvider } from '../brain/provider.js'
import { ShortTermGoalManager } from '../brain/goals.js'
import {
  appendRecentDecision,
  assessRepetition,
  createRecentDecision
} from '../brain/repetition.js'
import { buildDecisionContext } from '../brain/semantics.js'
import type {
  AgentDecision,
  BrainInput,
  DecisionExecutionResult,
  RecentDecision
} from '../brain/types.js'
import {
  validateDecision,
  type DecisionValidationContext,
  type DecisionValidationResult
} from '../brain/validateDecision.js'
import { perceive } from '../perception/perceive.js'
import type { PerceptionSnapshot } from '../perception/types.js'
import type {
  AgentMemory,
  MemoryCycleEvent
} from '../memory/coordinator.js'
import { EMPTY_MEMORY_CONTEXT } from '../memory/retrieval.js'
import {
  executeDecision,
  type DecisionExecutor
} from '../skills/execute.js'

export interface AgentLoopLogger {
  log(message: string): void
  error(message: string): void
}

export interface AgentLoopOptions {
  bot: Bot
  state: AgentState
  provider: LLMProvider
  intervalMs: number
  arbiter?: ActionArbiter
  observe?: (bot: Bot) => PerceptionSnapshot
  execute?: DecisionExecutor
  validate?: (
    input: unknown,
    context?: DecisionValidationContext
  ) => DecisionValidationResult
  logger?: AgentLoopLogger
  goalManager?: Pick<ShortTermGoalManager, 'update'>
  memory?: AgentMemory
}

export type BrainCycleResult =
  | {
      status: 'executed'
      decision: AgentDecision
      result: DecisionExecutionResult
    }
  | {
      status: 'skipped'
      reason:
        | 'cycle_in_progress'
        | 'manual_override'
        | 'manual_action_active'
        | 'action_in_progress'
        | 'priority_override'
    }
  | { status: 'validation_failed'; issues: string[] }
  | {
      status: 'policy_rejected'
      reason: 'duplicate_say' | 'stagnant_idle' | 'stagnant_action'
      decision: AgentDecision
    }
  | { status: 'provider_failed'; error: string }
  | { status: 'observation_failed'; error: string }
  | { status: 'execution_failed'; result: DecisionExecutionResult }

export class AutonomousAgentLoop {
  private readonly bot: Bot
  private readonly state: AgentState
  private readonly provider: LLMProvider
  private readonly intervalMs: number
  private readonly arbiter: ActionArbiter
  private readonly observe: (bot: Bot) => PerceptionSnapshot
  private readonly execute: DecisionExecutor
  private readonly validate: (
    input: unknown,
    context?: DecisionValidationContext
  ) => DecisionValidationResult
  private readonly logger: AgentLoopLogger
  private readonly goalManager: Pick<ShortTermGoalManager, 'update'>
  private readonly memory: AgentMemory | null

  private running = false
  private cycleInProgress = false
  private timer: NodeJS.Timeout | null = null
  private readonly idleWaiters = new Set<() => void>()
  private previousActionResult: DecisionExecutionResult | null = null
  private recentDecisions: readonly RecentDecision[] = []

  constructor(options: AgentLoopOptions) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1000) {
      throw new Error('Agent loop interval must be at least 1000 ms.')
    }

    this.bot = options.bot
    this.state = options.state
    this.provider = options.provider
    this.intervalMs = options.intervalMs
    this.arbiter = options.arbiter ?? new ActionArbiter()
    this.observe = options.observe ?? perceive
    this.execute = options.execute ?? executeDecision
    this.validate = options.validate ?? validateDecision
    this.logger = options.logger ?? console
    this.goalManager = options.goalManager ?? new ShortTermGoalManager()
    this.memory = options.memory ?? null
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

  waitForIdle(): Promise<void> {
    if (!this.cycleInProgress) return Promise.resolve()
    return new Promise(resolve => {
      this.idleWaiters.add(resolve)
    })
  }

  async runCycle(): Promise<BrainCycleResult> {
    if (this.cycleInProgress) {
      return { status: 'skipped', reason: 'cycle_in_progress' }
    }

    if (this.state.busy && this.state.actionSource === 'manual') {
      return { status: 'skipped', reason: 'manual_action_active' }
    }

    if (this.state.busy) {
      return { status: 'skipped', reason: 'action_in_progress' }
    }

    this.cycleInProgress = true
    const manualOverrideVersion = this.state.manualOverrideVersion
    const actionGeneration = this.arbiter.captureGeneration()
    this.logger.log('🧠 Brain cycle')

    try {
      let perception: PerceptionSnapshot
      try {
        perception = this.observe(this.bot)
      } catch (error) {
        const message = formatError(error)
        this.logger.error(`❌ Observation failed: ${message}`)
        return { status: 'observation_failed', error: message }
      }

      const goalSnapshot = this.goalManager.update(perception)
      const inputWithoutMemory: Omit<BrainInput, 'memory'> = {
        perception,
        state: {
          agentName: this.state.agentName,
          status: this.state.status,
          currentAction: this.state.currentAction,
          currentGoal: this.state.currentGoal,
          actionSource: this.state.actionSource,
          busy: this.state.busy
        },
        previousActionResult: this.previousActionResult,
        recentDecisions: this.recentDecisions,
        shortTermGoal: goalSnapshot.shortTermGoal,
        goalProgress: goalSnapshot.goalProgress,
        availableCapabilities: goalSnapshot.availableCapabilities
      }
      const memory = await this.retrieveMemory(inputWithoutMemory)
      const input: BrainInput = { ...inputWithoutMemory, memory }

      if (goalSnapshot.transition?.completedGoal) {
        this.logger.log(
          `🎯 Goal completed: ${goalSnapshot.transition.completedGoal.type}`
        )
      }
      if (goalSnapshot.transition?.abandonedGoal) {
        this.logger.log(
          `🎯 Goal abandoned: ${goalSnapshot.transition.abandonedGoal.type}`
        )
      }
      if (goalSnapshot.shortTermGoal && goalSnapshot.goalProgress) {
        this.logger.log(
          `🎯 Goal: ${goalSnapshot.shortTermGoal.type} | progress ${formatGoalProgress(goalSnapshot.goalProgress)}`
        )
      }

      let providerOutput: unknown
      try {
        providerOutput = await this.provider.decide(input)
      } catch (error) {
        const message = formatError(error)
        this.logger.error(`❌ Provider failure: ${message}`)
        return { status: 'provider_failed', error: message }
      }

      const validation = this.validate(
        providerOutput,
        buildDecisionContext(input)
      )
      if (!validation.success) {
        const issues = validation.issues.map(issue => (
          `${issue.path || 'decision'}: ${issue.message}`
        ))
        this.logger.error(`❌ Validation failure: ${issues.join('; ')}`)
        return { status: 'validation_failed', issues }
      }

      if (this.state.manualOverrideVersion !== manualOverrideVersion) {
        this.logger.log('ℹ️ Decision skipped because a manual command took priority')
        return { status: 'skipped', reason: 'manual_override' }
      }

      const decision = validation.decision
      const repetition = assessRepetition(decision, input)
      if (!repetition.allowed) {
        this.logger.log(`ℹ️ Decision rejected by repetition policy: ${repetition.reason}`)
        return {
          status: 'policy_rejected',
          reason: repetition.reason,
          decision
        }
      }

      this.logger.log(`Goal/Reason: ${decision.reason}`)
      this.logger.log(`Decision: ${formatDecision(decision)}`)
      this.logger.log(`⚙️ Executing: ${decision.action}`)

      let result: DecisionExecutionResult
      try {
        const arbitration = await this.arbiter.run({
          source: 'autonomous',
          expectedGeneration: actionGeneration,
          cancel: () => cancelAgentAction(this.bot, this.state),
          execute: () => this.execute(this.bot, decision, this.state)
        })

        if (arbitration.status === 'rejected') {
          this.logger.log(
            `ℹ️ Decision skipped because a ${arbitration.reason} action took priority`
          )
          return { status: 'skipped', reason: 'priority_override' }
        }

        result = arbitration.value
      } catch (error) {
        result = {
          success: false,
          action: decision.action,
          status: 'failed',
          summary: formatError(error)
        }
        this.previousActionResult = result
        this.logger.error(`❌ Result: ${result.summary}`)
        await this.recordMemory({
          before: perception,
          after: this.observeAfterExecution(perception),
          decision,
          result,
          goalTransition: goalSnapshot.transition
        })
        return { status: 'execution_failed', result }
      }

      this.previousActionResult = result
      this.recentDecisions = appendRecentDecision(
        this.recentDecisions,
        createRecentDecision(input, decision, result)
      )
      this.logger[result.success ? 'log' : 'error'](
        `${result.success ? '✅' : '❌'} Result: ${result.summary}`
      )
      await this.recordMemory({
        before: perception,
        after: this.observeAfterExecution(perception),
        decision,
        result,
        goalTransition: goalSnapshot.transition
      })

      return { status: 'executed', decision, result }
    } finally {
      this.cycleInProgress = false
      this.resolveIdleWaiters()
    }
  }

  private async retrieveMemory(
    input: Omit<BrainInput, 'memory'>
  ): Promise<BrainInput['memory']> {
    if (!this.memory) return EMPTY_MEMORY_CONTEXT
    try {
      const retrieved = await this.memory.retrieve(input)
      if (retrieved.error) {
        this.logger.error(`❌ Memory retrieval failed: ${retrieved.error}`)
      }
      return retrieved.context
    } catch {
      this.logger.error('❌ Memory retrieval failed.')
      return EMPTY_MEMORY_CONTEXT
    }
  }

  private async recordMemory(event: MemoryCycleEvent): Promise<void> {
    if (!this.memory) return
    try {
      const recorded = await this.memory.record(event)
      if (recorded.error) {
        this.logger.error(`❌ Memory persistence failed: ${recorded.error}`)
      }
    } catch {
      this.logger.error('❌ Memory persistence failed.')
    }
  }

  private observeAfterExecution(fallback: PerceptionSnapshot): PerceptionSnapshot {
    if (!this.memory) return fallback
    try {
      return this.observe(this.bot)
    } catch {
      this.logger.error('❌ Post-action memory observation failed.')
      return fallback
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

  private resolveIdleWaiters(): void {
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }
}

function formatDecision(decision: AgentDecision): string {
  switch (decision.action) {
    case 'follow_player':
    case 'come_to_player':
      return `${decision.action}(${decision.username})`
    case 'collect_block':
    case 'place_block':
      return `${decision.action}(${decision.block})`
    case 'craft_item':
      return `${decision.action}(${decision.item}, ${decision.amount})`
    case 'say':
      return `${decision.action}(${JSON.stringify(decision.message)})`
    default:
      return decision.action
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatGoalProgress(
  progress: NonNullable<BrainInput['goalProgress']>
): string {
  return [
    `wood=${progress.hasWood}`,
    `planks=${progress.hasPlanks}`,
    `sticks=${progress.hasSticks}`,
    `table_item=${progress.hasCraftingTableItem}`,
    `crafting_access=${progress.hasCraftingAccess}`,
    `basic_tool=${progress.hasBasicTool}`,
    `complete=${progress.completed}`
  ].join(',')
}
