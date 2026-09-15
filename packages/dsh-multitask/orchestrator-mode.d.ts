/**
 * Typed contract for logged orchestrator collaboration state.
 *
 * @module dsh-multitask/orchestrator-mode
 */
import type { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { z as zod } from 'zod'

/** Session-log event type for committed orchestrator mode. */
export declare const MODE_EVENT_TYPE: 'multitask/mode'

/** Client-visible projection unit key. */
export declare const PROJECTION_KEY: 'multitask-mode'

/** System-prompt section name while orchestrator mode is active. */
export declare const ORCHESTRATOR_SECTION_NAME: 'multitask:orchestrator'

/** Guidance rendered only while at least one task is open. */
export declare const ORCHESTRATOR_GUIDANCE: string

/** Whole-value committed / proposed mode snapshot. */
export interface OrchestratorModeIntent {
  active: boolean
  openTasks: string[]
}

/** Host fold state for the `multitask-mode` projection unit. */
export interface OrchestratorModeProjectionState {
  active: boolean
  openTasks: string[]
  activeAtLastHeader: boolean | null
}

/** Browser / host wire view of orchestrator mode. */
export interface OrchestratorModeWireView {
  active: boolean
  openTasks: string[]
}

/** Plan-mode controller outcome for one proposed mode change. */
export type OrchestratorModeOutcome = 'committed' | 'queued' | 'cancelled' | 'noop'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whether orchestrator mode is in force from this point on: log-only,
     * non-surface, whole-value replace. Carries the complete post-change
     * `{active, openTasks}` snapshot.
     */
    'multitask/mode': OrchestratorModeIntent
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'multitask-mode': OrchestratorModeProjectionState
  }
  interface SessionProjectionMap {
    'multitask-mode': OrchestratorModeWireView
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    multitaskMode: OrchestratorModeController
  }
}

/** Fold open-task ids from the session log. */
export declare function foldOpenTasks(session: Session): string[]

/** Fold task ids whose host-published `multitask/phase` is terminal. */
export declare function foldTerminalTasks(session: Session): Set<string>

/** Projection of committed orchestrator mode and cropped wire view. */
export declare const orchestratorModeProjectionDefinition: {
  key: 'multitask-mode'
  stateVersion: number
  stateSchema: zod.ZodType<OrchestratorModeProjectionState>
  init: () => OrchestratorModeProjectionState
  apply: (
    state: OrchestratorModeProjectionState,
    event: import('@deepseek-ai/dsh-session').SessionEvent
  ) => OrchestratorModeProjectionState
  wire: {
    viewSchema: zod.ZodType<OrchestratorModeWireView>
    view: (state: OrchestratorModeProjectionState) => OrchestratorModeWireView
  }
}

/**
 * `ctx.multitaskMode`: owns logged orchestrator state, applies and narrates
 * selected state at accepted pre-step boundaries, and the named prompt section.
 */
export declare class OrchestratorModeController extends Service {
  constructor(ctx: Context)
  noteTaskOpened(agent: Agent, taskId: string): OrchestratorModeOutcome
  noteTaskClosed(agent: Agent, taskId: string): OrchestratorModeOutcome
  set(agent: Agent, intent: OrchestratorModeIntent): OrchestratorModeOutcome
}

/** Register the projection, prompt section, and controller when services exist. */
export declare function registerOrchestratorMode(ctx: Context): OrchestratorModeController | undefined
