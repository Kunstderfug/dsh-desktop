/**
 * Typed contract for writer-admission guardrails.
 *
 * @module dsh-multitask/guardrails
 */
import type { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ResolvedRoundDriverConfig, MultitaskRoundDriver } from './round-driver.js'

/** Plugin config default for `multitask.maxWriters`. */
export declare const DEFAULT_MAX_WRITERS: 2

/** Structured refusal code materialized in the tool denial reason. */
export declare const WRITER_CAP_CODE: 'WRITER_CAP'

/** Writer-facing delegation tool checked at `tools/pre-execute`. */
export declare const WRITER_TOOL_NAME: 'subagent'

/** Raw plugin fields consumed by guardrails. */
export interface MultitaskGuardrailsConfig {
  maxWriters?: number
}

/** Normalized writer-cap config after defaults. */
export interface ResolvedGuardrailsConfig {
  maxWriters: number
}

/** Snapshot published into orchestrator handoffs. */
export interface WriterCapacitySnapshot {
  active: number
  maxWriters: number
  available: number
  maxConsecutiveWakes: number
}

/** Structured capacity refusal fields encoded in the tool denial reason. */
export interface WriterCapRefusal {
  code: typeof WRITER_CAP_CODE
  maxWriters: number
  activeWriters: number
  maxConsecutiveWakes: number
  queue: 'yield'
  reason: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'multitask.guardrails': MultitaskGuardrails
  }
}

/** Resolve `maxWriters`. Invalid limits fail closed. */
export declare function resolveGuardrailsConfig(
  config?: MultitaskGuardrailsConfig
): ResolvedGuardrailsConfig

/** One structured, model-visible capacity refusal. */
export declare function formatWriterCapRefusal(input: {
  maxWriters: number
  activeWriters: number
  maxConsecutiveWakes: number
}): string

/**
 * `ctx['multitask.guardrails']`: writer admission, reservations, and shared budget.
 */
export declare class MultitaskGuardrails extends Service {
  readonly maxWriters: number
  readonly driverConfig: ResolvedRoundDriverConfig
  driver?: MultitaskRoundDriver
  constructor(ctx: Context, options: {
    maxWriters: number
    driverConfig: ResolvedRoundDriverConfig
    driver?: MultitaskRoundDriver
  })
  bindDriver(driver?: MultitaskRoundDriver): void
  snapshotBudget(agent: Agent): {
    consecutiveWakes: number
    maxConsecutiveWakes: number
    config: ResolvedRoundDriverConfig
  }
  protectedPaths(agent: Agent): string[]
  capacitySnapshot(agent: Agent): WriterCapacitySnapshot
  releaseChild(childId: string): void
}

/** Install the guardrails controller when the host has event hooks. */
export declare function registerGuardrails(
  ctx: Context,
  options: {
    maxWriters: number
    driverConfig: ResolvedRoundDriverConfig
    driver?: MultitaskRoundDriver
  }
): MultitaskGuardrails | undefined
