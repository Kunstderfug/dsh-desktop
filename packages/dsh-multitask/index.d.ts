/**
 * Type face of the `dsh-multitask` host plugin.
 *
 * Declares the plugin's runtime exports for type-only consumers (the
 * implementation module `./index.js` is plain JavaScript) and augments the
 * session event vocabulary with the plugin-owned `multitask/task` event —
 * the same `declare module` pattern `@deepseek-ai/dsh-plan-mode` uses for
 * `plan/mode`.
 *
 * @module dsh-multitask
 */
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /**
         * One queued multitask task was minted host-side by the `/multitask`
         * command handler. Log-only, non-surface (visible through the session
         * log fold, never in derived model history). The task identity `MT-n`
         * is per session: the highest existing ordinal in the log plus one.
         * The data shape is frozen by the multitask epic: exactly
         * `{id, objective, phase, createdAt}` with `phase: 'queued'`.
         */
        'multitask/task': {
            /** Per-session task id, `MT-<n>` (fold-derived ordinal). */
            id: string
            /** The verbatim, trimmed objective text. */
            objective: string
            /** The lifecycle phase; this event is only ever appended `queued`. */
            phase: 'queued'
            /** ISO-8601 timestamp of the minting moment. */
            createdAt: string
        }
    }
}

/** Stable Cordis plugin name. */
export declare const name: 'dsh-multitask'

/** The command registry must exist before this plugin's apply() runs. */
export declare const inject: string[]

/**
 * Log the scaffold startup line and register the `/multitask` command.
 * @param ctx - Host context.
 */
export declare function apply(ctx: Context): void
