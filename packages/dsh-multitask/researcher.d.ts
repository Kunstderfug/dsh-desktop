/**
 * Typed contract for the researcher briefing and launch module.
 *
 * @module dsh-multitask/researcher
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentActivationSpec, SubagentStopReason } from '@deepseek-ai/dsh-subagent'

/** Stable lineage label stored on every researcher child and task event. */
export declare const RESEARCHER_LABEL: 'researcher'

/** Child tools denied by `toolFilter`, not by prompt wording alone. */
export declare const RESEARCHER_DENIED_TOOLS: readonly ['write', 'edit', 'str_replace_editor']

/** Required structured-report headings the brief demands. */
export declare const RESEARCH_REPORT_HEADINGS: readonly [
  'Goal',
  'Affected paths',
  'Implementation plan',
  'Risks',
  'Recommended claim set'
]

/** Role persona installed on the child. */
export declare const RESEARCHER_PERSONA: string

/** Orchestrator retries a failed researcher this many times, then surfaces failure. */
export declare const RESEARCH_RETRY_LIMIT: 1

/** Count researcher launches recorded for one task. */
export declare function countResearchLaunches(session: Session, taskId: string): number

/** Count recorded researcher failures for one task. */
export declare function countResearchFailures(session: Session, taskId: string): number

/** Whether the first researcher failure still deserves exactly one retry. */
export declare function shouldRetryResearch(session: Session, taskId: string): boolean

/** Build the system-owned research brief. */
export declare function buildResearchBrief(input: {
  objective: string
  workspace: string
}): string

/** Register one spawned researcher child for the read-only guard. */
export declare function markResearcherChild(childId: string): void

/** Release one finished researcher child. */
export declare function releaseResearcherChild(childId: string): void

/** Whether one session is a live researcher child. */
export declare function isResearcherChild(sessionId: unknown): boolean

/** The model-visible refusal for one denied researcher tool call. */
export declare function formatResearcherRefusal(toolName: string): string

/** Map a continuable-child stop reason to the terminal research phase. */
export declare function mapResearchSettlement(
  stopReason: SubagentStopReason
): 'researched' | 'research-failed'

/** Build the `startActivation` specification for one researcher child. */
export declare function buildResearcherStartSpec(input: {
  parent: Agent
  objective: string
  signal: AbortSignal
}): SubagentActivationSpec

/** Pull the full structured report through `sendMessage`. */
export declare function retrieveResearcherReport(
  ctx: Context,
  parent: Agent,
  childId: SessionId,
  signal: AbortSignal
): Promise<MessageId>

export type { ContentBlock }
