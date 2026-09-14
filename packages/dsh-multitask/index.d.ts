/**
 * Type face of the `dsh-multitask` host plugin.
 *
 * Declares the plugin's runtime exports for type-only consumers (the
 * implementation module `./index.js` is plain JavaScript) and augments the
 * session event vocabulary with the plugin-owned `multitask/task` mint,
 * `multitask/research` researcher lifecycle, `multitask/claims` registry
 * records, and `multitask/mode` orchestrator collaboration state — the same
 * `declare module` pattern `@deepseek-ai/dsh-plan-mode` uses for `plan/mode`.
 *
 * @module dsh-multitask
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MultitaskRoundDriverConfig } from './round-driver.js'
import type { MultitaskGuardrailsConfig } from './guardrails.js'

/** Plugin config: round-driver enable/bound plus the writer cap. */
export interface MultitaskPluginConfig extends MultitaskRoundDriverConfig, MultitaskGuardrailsConfig {}

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
            /** `1` when this launch is the orchestrator's one allowed retry. */
            retry?: number
        }
        /**
         * Terminal or intermediate task phase published by the host. Writer
         * failure and retry-exhausted researcher failure append `phase: 'failed'`
         * with an actionable note for the task card / paired-phone surface.
         */
        'multitask/phase': {
            /** The parent task id, `MT-<n>`. */
            id: string
            /** The verbatim, trimmed objective text. */
            objective: string
            /** Lifecycle phase recorded by this append. */
            phase: 'orchestrating' | 'writing' | 'verifying' | 'done' | 'failed'
            /** ISO-8601 timestamp of this append. */
            createdAt: string
            /** Durable child id when a writer or researcher produced this phase. */
            childId?: string
            /** Settlement reason when this phase is a failure. */
            stopReason?: MultitaskResearchStopReason
            /** Actionable user-visible failure note. */
            note?: string
            /** Failure owner: `researcher` or `writer`. */
            reason?: string
        }
        /**
         * One claim-enforcement denial. Log-only; folded into the task card as a
         * boundary-intervention note. Does not replace the claim registry.
         */
        'multitask/denial': {
            /** Task id that should surface the intervention note. */
            id: string
            /** Optional task id alias used by the card fold. */
            taskId?: string
            /** Normalized workspace-relative path that was denied. */
            path: string
            /** Live task that holds the path. */
            holderTaskId: string
            /** Actionable reason naming path, holder, and remedy. */
            reason: string
            /** Same reason, folded as a visible phase note. */
            note?: string
            /** Card fold marker; not a lifecycle chip. */
            phase?: string
            /** ISO-8601 timestamp of this append. */
            createdAt: string
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
        /**
         * Orchestrator collaboration state from this point on: log-only,
         * non-surface, whole-value replace. The last `multitask/mode` wins; a
         * log with none folds to inactive through the projection unit. The
         * cropped wire view is `{active, openTasks}`.
         */
        'multitask/mode': {
            /** Whether orchestrator mode is in force. */
            active: boolean
            /** Open task ids (`MT-n`) that keep the mode active. */
            openTasks: string[]
        }
    }
}

/** Stable Cordis plugin name. */
export declare const name: 'dsh-multitask'

/** The command registry must exist before this plugin's apply() runs. */
export declare const inject: string[]

/**
 * Log the scaffold startup line, listen for researcher settlement, register
 * claims, mount orchestrator mode, optionally install the round driver, and
 * register the `/multitask` command.
 * @param ctx - Host context.
 * @param config - optional driver enable flag, wake bound, and writer cap.
 */
export declare function apply(ctx: Context, config?: MultitaskPluginConfig): void

export type {
  MultitaskHandoffSource,
  MultitaskRoundDriver,
  MultitaskRoundDriverConfig,
  ResolvedRoundDriverConfig
} from './round-driver.js'
export {
  DEFAULT_MAX_CONSECUTIVE_WAKES,
  isMultitaskHandoffSource,
  latestTask,
  registerRoundDriver,
  renderHandoffPrompt,
  resolveRoundDriverConfig
} from './round-driver.js'
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
  effectiveClaims,
  normalizeClaimPath,
  pathsOverlap,
  registerClaims,
  resolveMultitaskSession
} from './claims.js'
export {
  BASH_TIER2_SCOPE_NOTE,
  CLAIM_REMEDY,
  DENIAL_EVENT_TYPE,
  GUARDED_TOOL_PATH_ARGUMENTS,
  formatClaimDenial,
  registerClaimsGuard
} from './claims-guard.js'
export type {
  OrchestratorModeIntent,
  OrchestratorModeOutcome,
  OrchestratorModeProjectionState,
  OrchestratorModeWireView
} from './orchestrator-mode.js'
export type {
  MultitaskGuardrailsConfig,
  ResolvedGuardrailsConfig,
  WriterCapacitySnapshot,
  WriterCapRefusal
} from './guardrails.js'
export {
  DEFAULT_MAX_WRITERS,
  WRITER_CAP_CODE,
  WRITER_TOOL_NAME,
  MultitaskGuardrails,
  formatWriterCapRefusal,
  registerGuardrails,
  resolveGuardrailsConfig
} from './guardrails.js'
export {
  MODE_EVENT_TYPE,
  ORCHESTRATOR_GUIDANCE,
  ORCHESTRATOR_SECTION_NAME,
  PROJECTION_KEY,
  OrchestratorModeController,
  foldOpenTasks,
  orchestratorModeProjectionDefinition,
  registerOrchestratorMode
} from './orchestrator-mode.js'
export {
  RESEARCHER_LABEL,
  RESEARCH_RETRY_LIMIT,
  RESEARCHER_DENIED_TOOLS,
  RESEARCH_REPORT_HEADINGS,
  countResearchFailures,
  countResearchLaunches,
  mapResearchSettlement,
  shouldRetryResearch
} from './researcher.js'
