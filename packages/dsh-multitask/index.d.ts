/**
 * Type face of the `dsh-multitask` host plugin.
 *
 * Declares the plugin's runtime exports for type-only consumers (the
 * implementation module `./index.js` is plain JavaScript) and augments the
 * session event vocabulary with the plugin-owned `multitask/task` mint,
 * `multitask/research` researcher lifecycle, and `multitask/claims` registry
 * records — the same `declare module` pattern `@deepseek-ai/dsh-plan-mode`
 * uses for `plan/mode`.
 *
 * @module dsh-multitask
 */
import type { Context } from '@deepseek-ai/cordis'

/** Researcher lifecycle phases published on `multitask/research` events. */
export type MultitaskResearchPhase = 'researching' | 'researched' | 'research-failed'

/** Supported researcher settlement reasons (Harness stopReason vocabulary). */
export type MultitaskResearchStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /**
         * One queued multitask task was minted host-side by the `/multitask`
         * command handler. Log-only, non-surface (visible through the session
         * log fold, never in derived model history). The task identity `MT-n`
         * is per session: the highest existing ordinal in the log plus one.
         * The minting data shape remains `{id, objective, phase, createdAt}`
         * with `phase: 'queued'`.
         */
        'multitask/task': {
            /** Per-session task id, `MT-<n>` (fold-derived ordinal). */
            id: string
            /** The verbatim, trimmed objective text. */
            objective: string
            /** The lifecycle phase; the minting event is only ever appended `queued`. */
            phase: 'queued'
            /** ISO-8601 timestamp of the minting moment. */
            createdAt: string
        }
        /**
         * Researcher child lifecycle for one minted task. Launch success is
         * `researching` with `childId` and the stable `researcher` label;
         * settlement is `researched` or `research-failed` with `stopReason`.
         */
        'multitask/research': {
            /** The parent task id, `MT-<n>`. */
            id: string
            /** The verbatim, trimmed objective text. */
            objective: string
            /** Researcher phase recorded by this append. */
            phase: MultitaskResearchPhase
            /** ISO-8601 timestamp of this append. */
            createdAt: string
            /** Durable continuable researcher child id, once launched. */
            childId?: string
            /** Stable researcher lineage label. */
            label: string
            /** Settlement reason when the researcher reached a terminal phase. */
            stopReason?: MultitaskResearchStopReason
        }
        /**
         * One claim or release state change. Log-only, folded by the
         * `multitask/claims` projection unit. Identity is the workspace-relative
         * path plus task id and owner session id.
         */
        'multitask/claims': {
            /** Workspace-relative normalized path. */
            path: string
            /** The parent task id, `MT-<n>`. */
            taskId: string
            /** Session id of the owning agent (parent or child). */
            ownerSessionId: string
            /** Event state recorded by this append. */
            state: 'claimed' | 'released'
            /** ISO-8601 timestamp of this append. */
            since: string
        }
    }
}

/** Stable Cordis plugin name. */
export declare const name: 'dsh-multitask'

/** The command registry must exist before this plugin's apply() runs. */
export declare const inject: string[]

/**
 * Log the scaffold startup line, listen for researcher settlement, register
 * claims, and register the `/multitask` command.
 * @param ctx - Host context.
 */
export declare function apply(ctx: Context): void

export type {
  MultitaskClaimRecord,
  MultitaskClaimsProjectionState,
  MultitaskClaimsWireView
} from './claims.js'
export {
  CLAIM_CONFLICT_CODE,
  CLAIM_EVENT_TYPE,
  CLAIM_TOOL_NAMES,
  ClaimConflictError,
  MultitaskClaimsService,
  normalizeClaimPath,
  pathsOverlap,
  registerClaims
} from './claims.js'
