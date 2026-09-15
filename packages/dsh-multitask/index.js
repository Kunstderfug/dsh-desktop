/**
 * Host half of the [multitask] plugin (issues #3 scaffold + #4 command +
 * #5 researcher + #8 claims registry + #9 claim enforcement + #6 round
 * driver + #7 orchestrator mode + #12 hardening).
 *
 * This package is the permanent mount target of every later multitask
 * ticket. The composed desktop profile loads it through the
 * `build/dsh-desktop.patch.yml` insert row. Its surface today:
 *
 * - the scaffold startup line in the Harness log (`scripts/check-multitask-mount.mjs`
 *   greps for it),
 * - the `/multitask <objective>` runtime command (issue #4): the handler runs
 *   host-side on `invocation.agent` — no model turn is opened, nothing is
 *   queued, steered, or aborted — validates the objective, mints the
 *   per-session task id `MT-n` by folding the receiving session's existing
 *   `multitask/task` events (never an in-memory or global counter), appends
 *   the log-only `multitask/task` event, and returns a `CommandResult` text
 *   card. Attachments are admitted by the `@deepseek-ai/dsh-commands` runtime
 *   because the definition declares `input.attachments`; this ticket's
 *   handler owns no further attachment grammar, and
 * - the researcher spawn (issue #5): when `ctx.subagents` is mounted, the
 *   same handler immediately starts one continuable child via
 *   `startContinuable` (persona + `toolFilter` deny for write/edit/
 *   `str_replace_editor`), appends `researching` with the child id and
 *   label, and maps every supported settlement `stopReason` to
 *   `researched` / `research-failed`. The Harness SubagentRuntime remains
 *   the child lifecycle and persistence owner. The parent retrieves the
 *   full structured report through `sendMessage`, and
 * - the file-claim registry (issue #8) plus claim enforcement (issue #9):
 *   a log-backed `multitask.claims` service, agent-scoped claim tools, a
 *   host claims guard on `tools/pre-execute` and fs write/edit intents,
 *   busy-parent pre-claim at `/multitask`, live claim table in handoffs,
 *   and host-side release-on-settle, and
 * - the round driver (issue #6): when `enabled: true`, `/multitask` queues
 *   one `{kind:'multitask', taskId}` followup, `agent/pre-step` validates or
 *   rejects that reservation, settlement while idle requests a bounded next
 *   round, and teardown cancels owned attempts. Off by default so #4/#5/#8
 *   keep their no-handoff mount, and
 * - orchestrator mode (issue #7): per-agent logged `multitask/mode` events
 *   folded by the `multitask-mode` projection into `{active, openTasks}`.
 *   Task lifecycle proposes mode intent; the controller commits only after
 *   an accepted `agent/pre-step`. While active, the named
 *   `multitask:orchestrator` section is included and activation adds the
 *   ticket-named narration to that accepted step. The tool catalog is
 *   unchanged, and
 * - writer guardrails (issue #10): `maxWriters` (default 2) is enforced at
 *   the writer-facing `subagent` tool. A structured cap refusal queues or
 *   yields through the existing round-driver wake budget. Busy-parent
 *   touched paths are claimed before publication and omitted from admitted
 *   writer briefs. Researcher identities never consume a writer slot.
 *
 * The task-card chat node (issue #11) is a later ticket's seam.
 *
 * @module dsh-multitask
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { effectiveClaims, registerClaims } from './claims.js'
import { registerClaimsGuard } from './claims-guard.js'
import {
  registerGuardrails,
  resolveGuardrailsConfig
} from './guardrails.js'
import { registerOrchestratorMode } from './orchestrator-mode.js'
import {
  RESEARCHER_LABEL,
  buildResearcherStartSpec,
  mapResearchSettlement,
  shouldRetryResearch
} from './researcher.js'
import {
  latestTask,
  registerRoundDriver,
  resolveRoundDriverConfig
} from './round-driver.js'

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
  foldTerminalTasks,
  orchestratorModeProjectionDefinition,
  registerOrchestratorMode
} from './orchestrator-mode.js'
export {
  DEFAULT_MAX_CONSECUTIVE_WAKES,
  isMultitaskHandoffSource,
  isTerminalTask,
  latestTask,
  registerRoundDriver,
  renderHandoffPrompt,
  resolveRoundDriverConfig
} from './round-driver.js'
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

/** Stable Cordis plugin name. */
export const name = 'dsh-multitask'

/** Commands register the slash handler; agents own followup, pre-step, and teardown. */
export const inject = ['commands', 'agents']

/** Usage line shared by the menu description and the validation error. */
const USAGE = 'Usage: /multitask <objective>'

/** The one startup line the host plugin logs (grepped by the mount smoke script). */
const STARTUP_LINE = '[multitask] plugin active'

/** Live child id → the parent session and minted task awaiting settlement. */
const pendingResearchers = new Map()

/**
 * Dispatched writer child id → `{ session, parentId, taskId }`.
 * Populated through the guardrails writer-acquire hook so writer success and
 * failure attribution never depends on `latestTask` when several writers run
 * concurrently for different tasks.
 */
const writerTasks = new Map()

/** Child session id → parent session id for host-side release-on-settle. */
const childParents = new Map()

/**
 * Remember the parent session that owns a child, for settle-time release.
 *
 * @param childId - durable child session id.
 * @param parentId - parent session id.
 */
function rememberChildParent(childId, parentId) {
  if (childId == null || parentId == null) return
  childParents.set(String(childId), String(parentId))
}

/**
 * Parent session whose log holds claims for a settled child.
 *
 * @param ctx - host context.
 * @param childId - durable child session id.
 */
function sessionForSettledChild(ctx, childId) {
  const pending = pendingResearchers.get(String(childId))
  if (pending !== undefined) return pending.session
  const child = ctx.get?.('agents')?.get(childId)
  const parentId = child?.session.header.parentSession ?? childParents.get(String(childId))
  if (parentId === undefined) return undefined
  return ctx.get?.('sessions')?.get(parentId) ?? ctx.get?.('agents')?.get(parentId)?.session
}

/**
 * Host-side release of every claim the settled child still holds.
 * Every supported child-activation stop reason is a settlement boundary,
 * including ordinary continuable completion. Skip only composition teardown
 * (parent agent already gone) so resume can still expire dead owners through
 * the existing fold.
 *
 * @param ctx - host context.
 * @param info - `subagent/end` payload.
 */
function releaseSettledOwnerClaims(ctx, info) {
  const service = ctx.get?.('multitask.claims') ?? ctx['multitask.claims']
  const session = sessionForSettledChild(ctx, info.id)
  if (service == null || session == null) return
  if (ctx.get?.('agents')?.get(session.id) === undefined) return
  return service.releaseAll(session, String(info.id))
}

/**
 * Fold the session log into the next per-session task ordinal.
 *
 * The receiving session's append-only log is the only durable state: the
 * highest existing `MT-<n>` ordinal plus one, or `MT-1` for a log with no
 * multitask tasks. Resume- and fork-safe by construction — a fresh process
 * over the same session log continues at the next ordinal because the fold,
 * not any memory, decides.
 *
 * @param session - the receiving agent's live session.
 * @returns the next task id, `MT-n`.
 */
function nextTaskId(session) {
  let highest = 0
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'multitask/task') continue
    const match = /^MT-([1-9][0-9]*)$/u.exec(String(event.data?.id ?? ''))
    if (match !== null) highest = Math.max(highest, Number(match[1]))
  }
  return `MT-${highest + 1}`
}

/**
 * Objective text for one minted task, folded from the session log.
 *
 * @param session - parent session log.
 * @param taskId - `MT-n` identity.
 */
function taskObjective(session, taskId) {
  let objective = ''
  for (const event of session.snapshotEvents()) {
    if (event.type === 'multitask/task' && String(event.data?.id ?? '') === String(taskId)) {
      objective = String(event.data?.objective ?? '')
    }
  }
  return objective
}

/**
 * Publish one user-visible task-phase event. The first researcher failure
 * stays on the log; failure and done cards are the terminal outcomes.
 * Every phase event carries the task id so the client fold always lands it
 * on the right card (the fold skips events without an id).
 *
 * @param session - parent session log.
 * @param task - `{ id, objective }`.
 * @param phase - lifecycle phase (`orchestrating`, `writing`, `verifying`, `done`, `failed`).
 * @param extras - stop reason, note, and optional child id.
 */
function publishTaskPhase(session, task, phase, extras = {}) {
  if (task?.id == null) return
  session.append('multitask/phase', {
    id: task.id,
    objective: task.objective,
    phase,
    createdAt: new Date().toISOString(),
    ...extras
  })
}

/**
 * Publish one user-visible task failure (delegates to `publishTaskPhase`).
 *
 * @param session - parent session log.
 * @param task - `{ id, objective }`.
 * @param extras - stop reason, note, and optional child id.
 */
function publishTaskFailure(session, task, extras = {}) {
  publishTaskPhase(session, task, 'failed', extras)
}

/**
 * Whether the log already holds a terminal (`done` / `failed`) phase event
 * for one task. Guards duplicate terminal publications across the fold.
 *
 * @param session - parent session log.
 * @param taskId - `MT-n` identity.
 */
function hasTerminalPhase(session, taskId) {
  const id = String(taskId)
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'multitask/phase') continue
    if (String(event.data?.id ?? '') !== id) continue
    if (event.data?.phase === 'done' || event.data?.phase === 'failed') return true
  }
  return false
}

/**
 * Resolve the live parent agent for one session, for mode-close proposals.
 *
 * @param ctx - host context.
 * @param session - parent session.
 */
function agentForSession(ctx, session) {
  if (session == null) return undefined
  return ctx.get?.('agents')?.get(String(session.id))
}

/**
 * Propose closing one terminal task in orchestrator mode. The controller
 * commits at the next accepted `agent/pre-step` — an idle parent keeps the
 * deactivation pending, exactly like activation today.
 *
 * @param ctx - host context.
 * @param mode - optional orchestrator-mode controller.
 * @param session - parent session.
 * @param taskId - `MT-n` identity.
 */
function closeTaskMode(ctx, mode, session, taskId) {
  if (mode == null || taskId == null) return
  const agent = agentForSession(ctx, session)
  if (agent === undefined) return
  try {
    mode.noteTaskClosed(agent, taskId)
  } catch (error) {
    console.error('[multitask] task-close proposal failed:', error && error.stack ? error.stack : error)
  }
}

/**
 * Record a writer dispatch on the parent log (`phase: 'writing'`) and
 * remember the attribution for settle time. Called through the guardrails
 * writer-acquire seam, so researchers never land here.
 *
 * @param ctx - host context.
 * @param childId - durable writer child id.
 * @param parentId - parent session id.
 * @param taskId - `MT-n` identity from the dispatch reservation, when known.
 */
function noteWriterDispatch(ctx, childId, parentId, taskId) {
  const id = String(parentId ?? '')
  if (childId == null || id.length === 0) return
  const session = ctx.get?.('sessions')?.get(id) ?? ctx.get?.('agents')?.get(id)?.session
  if (session == null) return
  const resolvedTaskId = taskId ?? latestTask(session)?.id
  if (resolvedTaskId == null) return
  const task = { id: resolvedTaskId, objective: taskObjective(session, resolvedTaskId) }
  writerTasks.set(String(childId), { session, parentId: id, taskId: resolvedTaskId })
  try {
    publishTaskPhase(session, task, 'writing', { childId: String(childId) })
  } catch (error) {
    console.error('[multitask] writing-phase publication failed:', error && error.stack ? error.stack : error)
  }
}

/**
 * Launch exactly one researcher retry for a recorded first failure.
 *
 * @param ctx - host context.
 * @param pending - original researcher pending record.
 */
/**
 * Enumerate the tool names the deployment knows, for deny-filter filtering.
 *
 * `tools.restrict()` rejects unknown names, so the researcher deny list must
 * never carry an alias this composition lacks. Any failure to enumerate keeps
 * the historical full list (fail loud as before, not silently unguarded).
 *
 * @param ctx - host context exposing `tools`.
 * @param agent - the parent agent whose view anchors the enumeration.
 * @returns known restrictable tool names, or undefined when unresolvable.
 */
function knownToolNames(ctx, agent) {
  const tools = ctx.get?.('tools')
  if (typeof tools?.view !== 'function') return undefined
  try {
    return tools.view(agent).restrictableNames
  } catch {
    return undefined
  }
}

async function launchResearcherRetry(ctx, pending, mode) {
  const subagents = ctx.get?.('subagents')
  if (typeof subagents?.startContinuable !== 'function') {
    publishTaskFailure(pending.session, pending.task, {
      reason: 'researcher',
      stopReason: 'error',
      note: 'Researcher failed after one retry. Review the stop reason and retry the task.'
    })
    closeTaskMode(ctx, mode, pending.session, pending.task.id)
    return
  }
  try {
    const start = await subagents.startContinuable(buildResearcherStartSpec({
      parent: pending.agent,
      objective: pending.task.objective,
      knownTools: knownToolNames(ctx, pending.agent),
      signal: new AbortController().signal
    }))
    const childId = String(start.childId)
    pending.session.append('multitask/research', {
      id: pending.task.id,
      objective: pending.task.objective,
      phase: 'researching',
      createdAt: new Date().toISOString(),
      childId,
      label: RESEARCHER_LABEL,
      retry: 1
    })
    pendingResearchers.set(childId, pending)
  } catch (error) {
    console.error('[multitask] researcher retry launch failed:', error && error.stack ? error.stack : error)
    pending.session.append('multitask/research', {
      id: pending.task.id,
      objective: pending.task.objective,
      phase: 'research-failed',
      createdAt: new Date().toISOString(),
      label: RESEARCHER_LABEL,
      stopReason: 'error',
      retry: 1
    })
    publishTaskFailure(pending.session, pending.task, {
      reason: 'researcher',
      stopReason: 'error',
      note: 'Researcher failed after one retry. Review the stop reason and retry the task.'
    })
    closeTaskMode(ctx, mode, pending.session, pending.task.id)
  }
}

/**
 * Record a researcher settlement on the parent session that owns the child.
 *
 * When the round driver is mounted, the first failure retries once. The first
 * `research-failed` row stays in the log so a retry cannot hide it. A
 * successful research settlement publishes a durable `orchestrating` phase
 * event (the client fold maps `researched` → `orchestrating`), and a terminal
 * failure closes the task in orchestrator mode.
 *
 * @param ctx - host context.
 * @param info - `subagent/end` payload from SubagentRuntime.
 * @param driver - optional enabled round driver.
 * @param mode - optional orchestrator-mode controller.
 */
async function recordResearchSettlement(ctx, info, driver, mode) {
  const childId = String(info.id)
  const pending = pendingResearchers.get(childId)
  if (pending === undefined) return false
  pendingResearchers.delete(childId)
  const phase = mapResearchSettlement(info.stopReason)
  pending.session.append('multitask/research', {
    id: pending.task.id,
    objective: pending.task.objective,
    phase,
    createdAt: new Date().toISOString(),
    childId,
    label: RESEARCHER_LABEL,
    stopReason: info.stopReason
  })
  if (phase === 'research-failed' && driver != null && shouldRetryResearch(pending.session, pending.task.id)) {
    await launchResearcherRetry(ctx, pending, mode)
    return true
  }
  if (phase === 'research-failed') {
    publishTaskFailure(pending.session, pending.task, {
      reason: 'researcher',
      stopReason: info.stopReason,
      note: 'Researcher failed after one retry. Review the stop reason and retry the task.'
    })
    closeTaskMode(ctx, mode, pending.session, pending.task.id)
  } else {
    publishTaskPhase(pending.session, pending.task, 'orchestrating', {
      childId,
      label: RESEARCHER_LABEL
    })
  }
  driver?.notifySettlement(pending.agent, pending.task)
  return true
}

/**
 * Surface a writer settlement failure as a failure card. Host release of that
 * owner's claims happens in the settle `finally`. Attribution prefers the
 * dispatch-time writer record so concurrent writers on different tasks never
 * cross-attribute through `latestTask`.
 *
 * @param ctx - host context.
 * @param info - `subagent/end` payload.
 * @param entry - optional dispatch-time attribution record.
 * @returns `{ session, taskId }` when a failure was published, else `undefined`.
 */
function publishWriterFailure(ctx, info, entry) {
  if (mapResearchSettlement(info.stopReason) === 'researched') return undefined
  const session = entry?.session ?? sessionForSettledChild(ctx, info.id)
  if (session == null) {
    console.error(`[multitask] writer child ${String(info.id)} settled unsuccessfully but its parent session could not be resolved; no failure card was published`)
    return undefined
  }
  const owner = String(info.id)
  const owned = effectiveClaims(session).filter(claim => String(claim.ownerSessionId) === owner)
  const taskId = entry?.taskId ?? owned[0]?.taskId ?? latestTask(session)?.id
  if (taskId == null) return undefined
  publishTaskFailure(session, { id: taskId, objective: taskObjective(session, taskId) }, {
    reason: 'writer',
    stopReason: info.stopReason,
    childId: owner,
    note: 'Writer failed. Claims were released. Review the diff handoff or retry the task.'
  })
  return { session, taskId }
}

/**
 * Settle one non-researcher child.
 *
 * A successful writer publishes `verifying` while another live writer for the
 * same task remains, and otherwise publishes `done` exactly once and closes
 * the task in orchestrator mode. `done` means the writer handoff completed —
 * it does not claim human review. Programmatic writer starts that never went
 * through the guardrails dispatch seam keep the historical silent behavior.
 *
 * @param ctx - host context.
 * @param info - `subagent/end` payload.
 * @param guardrails - optional guardrails controller.
 * @param mode - optional orchestrator-mode controller.
 */
function settleWriterChild(ctx, info, guardrails, mode) {
  const childId = String(info.id)
  const succeeded = mapResearchSettlement(info.stopReason) === 'researched'
  const entry = writerTasks.get(childId)
  writerTasks.delete(childId)
  if (succeeded && entry != null) {
    const task = { id: entry.taskId, objective: taskObjective(entry.session, entry.taskId) }
    if (task.id == null || hasTerminalPhase(entry.session, task.id)) return
    const liveOthers = (guardrails?.liveWriterIds?.(entry.parentId) ?? [])
      .filter(id => id !== childId && writerTasks.get(id)?.taskId === task.id)
    if (liveOthers.length > 0) {
      publishTaskPhase(entry.session, task, 'verifying', { childId })
      return
    }
    publishTaskPhase(entry.session, task, 'done', { childId })
    closeTaskMode(ctx, mode, entry.session, task.id)
    return
  }
  const attributed = publishWriterFailure(ctx, info, entry)
  if (attributed !== undefined) closeTaskMode(ctx, mode, attributed.session, attributed.taskId)
}

async function settleChild(ctx, info, driver, guardrails, mode) {
  const wasResearcher = pendingResearchers.has(String(info.id))
  try {
    if (wasResearcher) await recordResearchSettlement(ctx, info, driver, mode)
    else settleWriterChild(ctx, info, guardrails, mode)
  } finally {
    guardrails?.releaseChild?.(String(info.id))
    await releaseSettledOwnerClaims(ctx, info)
    childParents.delete(String(info.id))
  }
}

/**
 * Execute one `/multitask` invocation host-side.
 *
 * The mint itself is synchronous: no model round-trip, and no `followup`,
 * `steer`, or `abort` call. When SubagentRuntime is mounted, the handler
 * then awaits only inbox acceptance of the researcher child — the child's
 * turn is its own and does not replace the parent turn.
 *
 * @param ctx - host context that may expose `subagents`.
 * @param invocation - the registry's invocation for the receiving agent.
 * @param driver - optional enabled round driver.
 * @param mode - optional orchestrator-mode controller.
 * @returns the settled CommandResult (text card, or validation error).
 */
async function executeMultitaskCommand(ctx, invocation, driver, mode) {
  const objective = invocation.rawInput.trim()
  if (objective.length === 0) {
    // Validation failure: no `multitask/task` is appended; only the
    // runtime's own command/run + command/done(error) pair records the try.
    return {
      kind: 'error',
      text: `A multitask objective is required. ${USAGE}`
    }
  }

  const session = invocation.agent.session
  const busy = latestTask(session)
  const task = {
    id: nextTaskId(session),
    objective,
    phase: 'queued',
    createdAt: new Date().toISOString()
  }
  session.append('multitask/task', task)
  mode?.noteTaskOpened(invocation.agent, task.id)
  const claims = ctx.get?.('multitask.claims')
  if (busy !== undefined && typeof claims?.preclaimTouched === 'function') {
    try {
      await claims.preclaimTouched(session, String(session.id), busy.id)
    } catch {
      /* a conflicting live claim still protects the busy-parent path */
    }
  }
  let liveClaims = effectiveClaims(session)
  if (typeof claims?.list === 'function') {
    try {
      liveClaims = (await claims.list(session)).claims
    } catch {
      liveClaims = effectiveClaims(session)
    }
  }
  driver?.refreshHandoffTable?.(invocation.agent, liveClaims)
  driver?.queueHandoff(invocation.agent, task, liveClaims)

  let researcherLine = ''
  const subagents = ctx.get?.('subagents')
  if (typeof subagents?.startContinuable === 'function') {
    try {
      const start = await subagents.startContinuable(buildResearcherStartSpec({
        parent: invocation.agent,
        objective,
        knownTools: knownToolNames(ctx, invocation.agent),
        signal: invocation.signal
      }))
      const childId = String(start.childId)
      invocation.agent.session.append('multitask/research', {
        id: task.id,
        objective,
        phase: 'researching',
        createdAt: new Date().toISOString(),
        childId,
        label: RESEARCHER_LABEL
      })
      pendingResearchers.set(childId, {
        session: invocation.agent.session,
        agent: invocation.agent,
        task
      })
      researcherLine = `Researcher ${childId} (${RESEARCHER_LABEL}) launched; research phase: researching.`
    } catch (error) {
      console.error('[multitask] researcher launch failed:', error && error.stack ? error.stack : error)
      invocation.agent.session.append('multitask/research', {
        id: task.id,
        objective,
        phase: 'research-failed',
        createdAt: new Date().toISOString(),
        label: RESEARCHER_LABEL,
        stopReason: 'error'
      })
      researcherLine = `Researcher launch failed; research phase: research-failed.`
    }
  }

  return {
    kind: 'success',
    text: [
      `Multitask task ${task.id} queued.`,
      `Objective: ${task.objective}`,
      `Phase: ${task.phase}`,
      ...(researcherLine === '' ? [] : [researcherLine]),
      '',
      `What happens next: research, then implementation. The orchestrator drives both phases for ${task.id} in later turns and reports back here.`
    ].join('\n')
  }
}

/**
 * Log the scaffold startup line, declare the multitask session-event
 * vocabulary, listen for researcher settlement, register claims, mount
 * orchestrator mode, and register `/multitask`.
 *
 * The startup line goes straight to the Harness process stdout so it lands
 * in the desktop's `harness.log`. The event-vocabulary registration exists
 * because the persistence layer's load path refuses any stored event type it
 * does not know unless the record was written `ignorable: true`
 * (`@deepseek-ai/dsh-session-persistence` `validateStoredEvents`), and
 * `Session.append` offers no way to write that marker. Since this plugin is
 * the permanent owner of the `multitask/task` vocabulary and is mounted by
 * the composed desktop profile, declaring the type known to this build here
 * is what makes a session that ran `/multitask` resumable — the property the
 * fold-derived task identity depends on. The compile-time face of the same
 * declaration is the `SessionEventMap` augmentation in `index.d.ts`.
 *
 * The command registration is skipped only when apply() runs without a
 * composed host context (the scaffold smoke test calls `apply({})`
 * directly) — real composition declares `inject: ['commands']`, so the
 * registry is always present there.
 *
 * @param ctx - Host context.
 * @param config - optional driver enable flag, wake bound, and writer cap.
 */
export function apply(ctx, config) {
  console.log(STARTUP_LINE)
  KNOWN_SESSION_EVENT_TYPES.add('multitask/task')
  KNOWN_SESSION_EVENT_TYPES.add('multitask/research')
  KNOWN_SESSION_EVENT_TYPES.add('multitask/phase')
  KNOWN_SESSION_EVENT_TYPES.add('multitask/claims')
  KNOWN_SESSION_EVENT_TYPES.add('multitask/denial')
  KNOWN_SESSION_EVENT_TYPES.add('multitask/mode')
  registerClaimsGuard(ctx)
  const driverConfig = resolveRoundDriverConfig(config)
  const guardrailsConfig = resolveGuardrailsConfig(config)
  const guardrails = registerGuardrails(ctx, {
    maxWriters: guardrailsConfig.maxWriters,
    driverConfig,
    onWriterStart: (childId, parentId, taskId) => noteWriterDispatch(ctx, childId, parentId, taskId)
  })
  const driver = driverConfig.enabled ? registerRoundDriver(ctx, driverConfig) : undefined
  guardrails?.bindDriver(driver)
  const mode = registerOrchestratorMode(ctx)
  ctx.on?.('agent/created', ({ agent }) => {
    rememberChildParent(agent.session.id, agent.session.header.parentSession)
  })
  ctx.on?.('subagent/end', (info) => settleChild(ctx, info, driver, guardrails, mode))
  registerClaims(ctx)
  if (typeof ctx.commands?.register !== 'function') return
  ctx.commands.register({
    name: 'multitask',
    description: 'queue a multitask objective: research, then implementation',
    input: {
      hint: '<objective>',
      attachments: true
    },
    handler: (invocation) => executeMultitaskCommand(ctx, invocation, driver, mode)
  })
}
