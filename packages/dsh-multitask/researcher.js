/**
 * Researcher briefing, continuable launch specification, and settlement
 * mapping for the [multitask] host plugin (issue #5).
 *
 * The Harness `SubagentRuntime` remains the child lifecycle and persistence
 * owner. This module only builds the system-owned brief, the child spawn
 * specification (`toolFilter` + persona), and the deterministic phase map.
 *
 * @module dsh-multitask/researcher
 */

/** Stable lineage label stored on every researcher child and task event. */
export const RESEARCHER_LABEL = 'researcher'

/** Child tools denied by `toolFilter`, not by prompt wording alone. */
export const RESEARCHER_DENIED_TOOLS = Object.freeze(['write', 'edit', 'str_replace_editor'])

/** Required structured-report headings the brief demands. */
export const RESEARCH_REPORT_HEADINGS = Object.freeze([
  'Goal',
  'Affected paths',
  'Implementation plan',
  'Risks',
  'Recommended claim set'
])

/** Role persona installed on the child (shadowing the deployment persona). */
export const RESEARCHER_PERSONA = [
  'You are the multitask researcher.',
  'Investigate the objective in a clean context and return only a structured report.',
  'You must not modify workspace files.'
].join(' ')

/** Orchestrator retries a failed researcher this many times, then surfaces failure. */
export const RESEARCH_RETRY_LIMIT = 1

/**
 * Count researcher launches recorded for one task.
 *
 * @param session - parent session log.
 * @param taskId - `MT-n` identity.
 */
export function countResearchLaunches(session, taskId) {
  let count = 0
  const id = String(taskId)
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'multitask/research') continue
    if (String(event.data?.id ?? '') !== id) continue
    if (event.data?.phase === 'researching') count += 1
  }
  return count
}

/**
 * Count recorded researcher failures for one task.
 *
 * @param session - parent session log.
 * @param taskId - `MT-n` identity.
 */
export function countResearchFailures(session, taskId) {
  let count = 0
  const id = String(taskId)
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'multitask/research') continue
    if (String(event.data?.id ?? '') !== id) continue
    if (event.data?.phase === 'research-failed') count += 1
  }
  return count
}

/**
 * Whether the first researcher failure still deserves exactly one retry.
 *
 * @param session - parent session log.
 * @param taskId - `MT-n` identity.
 */
export function shouldRetryResearch(session, taskId) {
  return countResearchLaunches(session, taskId) === 1
    && countResearchFailures(session, taskId) >= 1
}

/**
 * Build the system-owned research brief.
 *
 * @param input
 * @param input.objective - trimmed task objective.
 * @param input.workspace - parent session cwd or process cwd.
 * @returns the child prompt text.
 */
export function buildResearchBrief({ objective, workspace }) {
  return [
    'Research brief',
    `Objective: ${objective}`,
    `Workspace: ${workspace}`,
    'You must not modify files. Do not call write, edit, or str_replace_editor.',
    'Return a structured report with exactly these headings:',
    ...RESEARCH_REPORT_HEADINGS.map(heading => `- ${heading}`)
  ].join('\n')
}

/**
 * The child `toolFilter` for one researcher child.
 *
 * Deny names are intersected with the tools the deployment actually knows:
 * `tools.restrict()` rejects unknown names loud, so a hard-coded alias such
 * as `str_replace_editor` (absent in deployments without the Anthropic-style
 * toolset) fails the whole child materialization. The brief's prompt-level
 * denial still covers any alias the filter had to drop.
 *
 * @param knownTools - optional set of tool names the deployment knows.
 * @returns the `toolFilter` deny list.
 */
export function researcherToolFilter(knownTools) {
  const deny = typeof knownTools?.has === 'function'
    ? RESEARCHER_DENIED_TOOLS.filter(name => knownTools.has(name))
    : [...RESEARCHER_DENIED_TOOLS]
  return { deny }
}

/**
 * Map a continuable-child stop reason to the terminal research phase.
 *
 * @param stopReason - `completed` | `aborted` | `error` | `max-tokens` | `refusal`
 * @returns `researched` only for a completed child; otherwise `research-failed`.
 */
export function mapResearchSettlement(stopReason) {
  return stopReason === 'completed' ? 'researched' : 'research-failed'
}

/**
 * Build the `startContinuable` specification for one researcher child.
 *
 * @param input
 * @param input.parent - receiving parent agent.
 * @param input.objective - trimmed task objective packed into the brief.
 * @param input.signal - caller cancellation until inbox acceptance.
 * @param input.knownTools - optional known tool names for the deny filter.
 */
export function buildResearcherStartSpec({ parent, objective, signal, knownTools }) {
  const workspace = parent.session.header.cwd ?? process.cwd()
  return {
    provider: 'spawn',
    label: RESEARCHER_LABEL,
    request: {
      prompt: [{ type: 'text', text: buildResearchBrief({ objective, workspace }) }],
      parent,
      persona: RESEARCHER_PERSONA,
      toolFilter: researcherToolFilter(knownTools)
    },
    signal
  }
}

/**
 * Pull the full structured report through the supported continuable-child
 * `sendMessage` path. The settlement notice is only a summary.
 *
 * @param ctx - host context providing `subagents`.
 * @param parent - exact live parent authorizing the retrieval.
 * @param childId - durable researcher child id.
 * @param signal - caller cancellation until inbox acceptance.
 * @returns the accepted message id.
 */
export function retrieveResearcherReport(ctx, parent, childId, signal) {
  return ctx.subagents.sendMessage(parent, childId, [{
    type: 'text',
    text: [
      'Return the complete structured research report covering',
      `${RESEARCH_REPORT_HEADINGS.join(', ')}.`
    ].join(' ')
  }], { signal })
}
