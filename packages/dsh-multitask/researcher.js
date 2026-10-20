/**
 * Researcher briefing, continuable launch specification, and settlement
 * mapping for the [multitask] host plugin (issue #5).
 *
 * The Harness `SubagentRuntime` remains the child lifecycle and persistence
 * owner. This module only builds the system-owned brief, the child spawn
 * specification, the read-only registry the host guard enforces, and the
 * deterministic phase map.
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
 * Live researcher children the host guard keeps read-only.
 *
 * Harness 0.2.1 dropped the per-child `toolFilter` from the start request, so
 * the denial moved to the `tools/pre-execute` guard: the plugin registers each
 * spawned researcher id here and the guard refuses writer tools for it until
 * `subagent/end` releases the id.
 */
const researcherChildren = new Set()

/**
 * Register one researcher child for the read-only guard.
 *
 * @param childId - durable child session id.
 */
export function markResearcherChild(childId) {
  researcherChildren.add(String(childId))
}

/**
 * Release one finished researcher child.
 *
 * @param childId - durable child session id.
 */
export function releaseResearcherChild(childId) {
  researcherChildren.delete(String(childId))
}

/**
 * Whether one session is a live researcher child.
 *
 * @param sessionId - candidate session id.
 * @returns true while the child is registered from spawn to `subagent/end`.
 */
export function isResearcherChild(sessionId) {
  return sessionId !== undefined && researcherChildren.has(String(sessionId))
}

/**
 * The model-visible refusal for one denied researcher tool call.
 *
 * @param toolName - tool the child tried to run.
 * @returns the denial text naming the tool and the allowed alternative.
 */
export function formatResearcherRefusal(toolName) {
  return `The researcher is read-only: ${toolName} is unavailable in a researcher child. Return the structured report instead.`
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
 * Build the `startActivation` specification for one researcher child.
 *
 * 0.2.1 accepts no persona or toolFilter at start: the persona is folded into
 * the prompt and the read-only denial is enforced by the host guard.
 *
 * @param input
 * @param input.parent - receiving parent agent.
 * @param input.objective - trimmed task objective packed into the brief.
 * @param input.signal - caller cancellation until inbox acceptance.
 */
export function buildResearcherStartSpec({ parent, objective, signal }) {
  const workspace = parent.session.header.cwd ?? process.cwd()
  return {
    provider: 'spawn',
    label: RESEARCHER_LABEL,
    request: {
      prompt: [{
        type: 'text',
        text: `${RESEARCHER_PERSONA}\n\n${buildResearchBrief({ objective, workspace })}`
      }],
      parent
    },
    signal,
    delivery: 'parent'
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
