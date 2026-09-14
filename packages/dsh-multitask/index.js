/**
 * Host half of the [multitask] plugin (issues #3 scaffold + #4 command).
 *
 * This package is the permanent mount target of every later multitask
 * ticket. The composed desktop profile loads it through the
 * `build/dsh-desktop.patch.yml` insert row. Its surface today:
 *
 * - the scaffold startup line in the Harness log (`scripts/check-multitask-mount.mjs`
 *   greps for it), and
 * - the `/multitask <objective>` runtime command (issue #4): the handler runs
 *   host-side on `invocation.agent` — no model turn is opened, nothing is
 *   queued, steered, or aborted — validates the objective, mints the
 *   per-session task id `MT-n` by folding the receiving session's existing
 *   `multitask/task` events (never an in-memory or global counter), appends
 *   the log-only `multitask/task` event, and returns a `CommandResult` text
 *   card. Attachments are admitted by the `@deepseek-ai/dsh-commands` runtime
 *   because the definition declares `input.attachments`; this ticket's
 *   handler owns no further attachment grammar.
 *
 * The researcher spawn (issue #5), the orchestrator handoff followup
 * (issue #6), and the task-card chat node (issue #11) are later tickets'
 * seams and deliberately absent here.
 *
 * @module dsh-multitask
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

/** Stable Cordis plugin name. */
export const name = 'dsh-multitask'

/** The command registry must exist before this plugin's apply() runs. */
export const inject = ['commands']

/** Usage line shared by the menu description and the validation error. */
const USAGE = 'Usage: /multitask <objective>'

/** The one startup line the host plugin logs (grepped by the mount smoke script). */
const STARTUP_LINE = '[multitask] plugin active'

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
 * Execute one `/multitask` invocation host-side.
 *
 * Synchronous on purpose: no model round-trip, and no `followup`, `steer`,
 * or `abort` call — issuing the command while the agent is busy changes
 * nothing about the running turn. The `@deepseek-ai/dsh-commands` runtime
 * has already appended `command/run` when this runs and appends
 * `command/done` after this returns, so the session log records the full
 * lifecycle pair around at most one `multitask/task` event.
 *
 * @param invocation - the registry's invocation for the receiving agent.
 * @returns the settled CommandResult (text card, or validation error).
 */
function executeMultitaskCommand(invocation) {
  const objective = invocation.rawInput.trim()
  if (objective.length === 0) {
    // Validation failure: no `multitask/task` is appended; only the
    // runtime's own command/run + command/done(error) pair records the try.
    return {
      kind: 'error',
      text: `A multitask objective is required. ${USAGE}`
    }
  }

  const task = {
    id: nextTaskId(invocation.agent.session),
    objective,
    phase: 'queued',
    createdAt: new Date().toISOString()
  }
  invocation.agent.session.append('multitask/task', task)

  return {
    kind: 'success',
    text: [
      `Multitask task ${task.id} queued.`,
      `Objective: ${task.objective}`,
      `Phase: ${task.phase}`,
      '',
      `What happens next: research, then implementation. The orchestrator drives both phases for ${task.id} in later turns and reports back here.`
    ].join('\n')
  }
}

/**
 * Log the scaffold startup line, declare the multitask session-event
 * vocabulary, and register the `/multitask` command.
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
 */
export function apply(ctx) {
  console.log(STARTUP_LINE)
  KNOWN_SESSION_EVENT_TYPES.add('multitask/task')
  if (typeof ctx.commands?.register !== 'function') return
  ctx.commands.register({
    name: 'multitask',
    description: 'queue a multitask objective: research, then implementation',
    input: {
      hint: '<objective>',
      attachments: true
    },
    handler: (invocation) => executeMultitaskCommand(invocation)
  })
}
