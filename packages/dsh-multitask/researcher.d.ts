/**
 * Typed contract for the researcher briefing and launch module.
 *
 * @module dsh-multitask/researcher
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ContinuableStartSpec, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'

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

/** Build the system-owned research brief. */
export declare function buildResearchBrief(input: {
  objective: string
  workspace: string
}): string

/** The child `toolFilter` deny list for mutation tools. */
export declare function researcherToolFilter(): ToolRestriction

/** Map a continuable-child stop reason to the terminal research phase. */
export declare function mapResearchSettlement(
  stopReason: SubagentStopReason
): 'researched' | 'research-failed'

/** Build the `startContinuable` specification for one researcher child. */
export declare function buildResearcherStartSpec(input: {
  parent: Agent
  objective: string
  signal: AbortSignal
}): ContinuableStartSpec

/** Pull the full structured report through `sendMessage`. */
export declare function retrieveResearcherReport(
  ctx: Context,
  parent: Agent,
  childId: SessionId,
  signal: AbortSignal
): Promise<MessageId>

export type { ContentBlock }
