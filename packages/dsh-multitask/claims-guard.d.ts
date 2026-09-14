/**
 * Public types for the host claim-enforcement guard.
 *
 * @module dsh-multitask/claims-guard
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { MultitaskClaimRecord } from './claims.js'

/** Session-log event for one boundary intervention. */
export declare const DENIAL_EVENT_TYPE: 'multitask/denial'

/** Ticket-named remedy appended to every denial reason. */
export declare const CLAIM_REMEDY: 'ask the orchestrator or claim a different path'

/** Model-facing mutating tools this tier claims against, and their path argument. */
export declare const GUARDED_PATH_ARGUMENTS: Readonly<{
  write: 'file_path'
  edit: 'file_path'
  str_replace_editor: 'path'
}>

/** Alias used by the host package export face. */
export declare const GUARDED_TOOL_PATH_ARGUMENTS: typeof GUARDED_PATH_ARGUMENTS

/** Visible task-card footnote: Bash stays outside tier 2. */
export declare const BASH_TIER2_SCOPE_NOTE: 'Native write/edit tools are guarded. Bash writes are not covered by tier 2.'

/** A live foreign holder blocking one write. */
export interface ForeignClaimHolder {
  session: Session
  path: string
  holder: MultitaskClaimRecord
}

/** Actionable denial text: path, holding task, and remedy. */
export declare function formatClaimDenialReason(path: string, holderTaskId: string): string

/** Alias used by the host package export face. */
export declare const formatClaimDenial: typeof formatClaimDenialReason

/** Resolve a live foreign holder for this write, or `undefined` to abstain. */
export declare function foreignHolderFor(
  ctx: Context,
  agent: Agent | undefined,
  rawPath: string | undefined
): Promise<ForeignClaimHolder | undefined>

/** Install the claims guard on both enforcement seams and the touched-path feed. */
export declare function registerClaimsGuard(ctx: Context): void
