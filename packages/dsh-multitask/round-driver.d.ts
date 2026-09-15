/**
 * Typed contract for the same-session multitask round driver.
 *
 * @module dsh-multitask/round-driver
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { MultitaskClaimRecord } from './claims.js'

/** Jobs-plugin anti-self-excitation default. */
export declare const DEFAULT_MAX_CONSECUTIVE_WAKES: 3

/** Merge-extensible handoff source carried by every reserved followup. */
export interface MultitaskHandoffSource {
  kind: 'multitask'
  taskId: string
}

/** Driver enable flag and the one configured wake bound. */
export interface MultitaskRoundDriverConfig {
  /** When true, command submission queues a handoff and settlement can re-wake. */
  enabled?: boolean
  /** Consecutive automatic rounds before settlement wakes stop (default 3). */
  maxConsecutiveWakes?: number
}

/** Normalized driver config after defaults. */
export interface ResolvedRoundDriverConfig {
  enabled: boolean
  maxConsecutiveWakes: number
}

/** Minted task identity used to tag a handoff. */
export interface MultitaskDriverTask {
  id: string
  objective: string
}

/** Capacity/protected-path extras rendered into a handoff. */
export interface MultitaskHandoffExtras {
  capacity?: {
    active: number
    maxWriters: number
    available: number
    maxConsecutiveWakes: number
  }
  protectedPaths?: readonly string[]
}

/** Public driver seams used by the host plugin. */
export interface MultitaskRoundDriver {
  readonly config: ResolvedRoundDriverConfig
  queueHandoff(
    agent: Agent,
    task: MultitaskDriverTask,
    claims?: readonly Pick<MultitaskClaimRecord, 'path' | 'taskId' | 'ownerSessionId' | 'state'>[]
  ): void
  notifySettlement(agent: Agent, task?: MultitaskDriverTask): void
  refreshHandoffTable?(
    agent: Agent,
    claims?: readonly Pick<MultitaskClaimRecord, 'path' | 'taskId' | 'ownerSessionId' | 'state'>[]
  ): void
  queueLaterRound?(
    agent: Agent,
    task: MultitaskDriverTask
  ): { queued: boolean, unique?: boolean, reason?: string }
  snapshotBudget?(agent: Agent): {
    consecutiveWakes: number
    maxConsecutiveWakes: number
    config: ResolvedRoundDriverConfig
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    multitask: MultitaskHandoffSource
  }
}

/** Whether a source identifies a driver-owned orchestrator handoff. */
export declare function isMultitaskHandoffSource(
  source: { kind?: string, taskId?: string } | undefined
): source is MultitaskHandoffSource

/** Resolve the driver enable flag and the one wake bound. */
export declare function resolveRoundDriverConfig(
  config?: MultitaskRoundDriverConfig
): ResolvedRoundDriverConfig

/** Render the model-visible orchestrator handoff for one task. */
export declare function renderHandoffPrompt(
  task: MultitaskDriverTask,
  claims?: readonly Pick<MultitaskClaimRecord, 'path' | 'taskId' | 'ownerSessionId' | 'state'>[],
  extras?: MultitaskHandoffExtras
): ContentBlock[]

/** Latest fold-derived task on a session log, if any. */
export declare function latestTask(session: Session): MultitaskDriverTask | undefined

/** Whether a task's folded `multitask/phase` is terminal (`done` or `failed`). */
export declare function isTerminalTask(session: Session, taskId: string): boolean

/** Install automatic handoff reservations, settlement wakes, and race fences. */
export declare function registerRoundDriver(
  ctx: Context,
  config: Pick<ResolvedRoundDriverConfig, 'maxConsecutiveWakes'>
): MultitaskRoundDriver

export type { UserMessage }
