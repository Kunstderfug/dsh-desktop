/**
 * Claims service and model contract for the [multitask] host plugin.
 *
 * @module dsh-multitask/claims
 */
import type { Context, Service } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Agent-scoped claim tool names. Never registered on the global catalog. */
export declare const CLAIM_TOOL_NAMES: readonly [
  'claim_files',
  'release_files',
  'list_file_claims'
]

/** Structured conflict code materialized on a denied overlapping claim. */
export declare const CLAIM_CONFLICT_CODE: 'CLAIM_CONFLICT'

/** Session-log and projection key for claim state. */
export declare const CLAIM_EVENT_TYPE: 'multitask/claims'

/** One claim or release record stored in the session log. */
export interface MultitaskClaimRecord {
  path: string
  taskId: string
  ownerSessionId: string
  state: 'claimed' | 'released'
  since: string
}

/** Host fold state for the `multitask/claims` projection unit. */
export interface MultitaskClaimsProjectionState {
  records: MultitaskClaimRecord[]
}

/** Browser wire view of live claims. */
export interface MultitaskClaimsWireView {
  claims: MultitaskClaimRecord[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'multitask/claims': MultitaskClaimsProjectionState
  }
  interface SessionProjectionMap {
    'multitask/claims': MultitaskClaimsWireView
  }
}

/** Structured overlap denial listing the holding task. */
export declare class ClaimConflictError extends HarnessError {
  readonly path: string
  readonly holderTaskId: string
  constructor(path: string, holderTaskId: string)
}

/** Normalize one caller path to a workspace-relative identity. */
export declare function normalizeClaimPath(cwd: string | undefined, input: unknown): string

/** Segment-aware overlap: exact match, ancestor, or descendant. */
export declare function pathsOverlap(left: string, right: string): boolean

/** Log-backed claims service installed as `ctx['multitask.claims']`. */
export declare class MultitaskClaimsService extends Service {
  constructor(ctx: Context)
  reconcile(session: Session): Promise<void>
  claim(
    session: Session,
    ownerSessionId: string,
    taskId: string,
    paths: readonly string[]
  ): Promise<{ claimed: string[], idempotent: boolean }>
  release(
    session: Session,
    ownerSessionId: string,
    taskId: string,
    paths: readonly string[]
  ): Promise<{ released: string[] }>
  list(session: Session): Promise<MultitaskClaimsWireView>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'multitask.claims': MultitaskClaimsService
  }
}

/** Register the claims projection, service, and agent-scoped tools. */
export declare function registerClaims(ctx: Context): void
