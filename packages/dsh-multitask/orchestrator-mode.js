/**
 * Logged per-agent orchestrator collaboration state.
 *
 * Mirrors `@deepseek-ai/dsh-plan-mode`: task lifecycle changes propose a
 * pending intent; the plugin appends `multitask/mode` only after an accepted
 * `agent/pre-step`. The `multitask-mode`
 * projection folds the log so resume and fork restore `{active, openTasks}`.
 * Entering or leaving the mode changes only the `multitask:orchestrator`
 * prompt section, never the request tool catalog.
 *
 * @module dsh-multitask/orchestrator-mode
 */

import { Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

/** Session-log event and projection key. */
export const MODE_EVENT_TYPE = 'multitask/mode'

/** Client-visible projection unit key. */
export const PROJECTION_KEY = 'multitask-mode'

/** System-prompt section name while orchestrator mode is active. */
export const ORCHESTRATOR_SECTION_NAME = 'multitask:orchestrator'

/** Guidance rendered only while at least one task is open. */
export const ORCHESTRATOR_GUIDANCE = [
  'You are the orchestrator.',
  'Consume the researcher report, merge the claim set, and dispatch a writer through the `subagent` tool.',
  'Verify the writer handoff, then release claims.',
  'Prefer yielding over blocking waits; do not implement the task yourself.'
].join(' ')

const EMPTY_TASKS = Object.freeze([])
const INACTIVE_VIEW = Object.freeze({
  active: false,
  openTasks: EMPTY_TASKS
})

const stateSchema = z.object({
  active: z.boolean(),
  openTasks: z.array(z.string()),
  activeAtLastHeader: z.boolean().nullable()
}).strict()

const viewSchema = z.object({
  active: z.boolean(),
  openTasks: z.array(z.string())
}).strict()

function sameTasks(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function sameIntent(left, right) {
  return left.active === right.active && sameTasks(left.openTasks, right.openTasks)
}

function activationNarration(taskId) {
  const text = `Multitask task ${taskId} handed off; you are the orchestrator.`
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-multitask',
      form: 'notice',
      summary: text
    }
  })
}

/**
 * Fold open-task ids from the session log.
 *
 * A committed `multitask/mode` replaces the set. Later `multitask/task`
 * events append newly minted ids so a pending-never-committed mint still
 * reconstructs after resume.
 *
 * @param session - session whose log is folded.
 * @returns detached open-task ids in mint order.
 */
export function foldOpenTasks(session) {
  const open = []
  for (const event of session.snapshotEvents()) {
    if (event.type === MODE_EVENT_TYPE && Array.isArray(event.data?.openTasks)) {
      open.length = 0
      for (const id of event.data.openTasks) {
        const taskId = String(id)
        if (taskId.length > 0 && !open.includes(taskId)) open.push(taskId)
      }
      continue
    }
    if (event.type !== 'multitask/task') continue
    const taskId = String(event.data?.id ?? '')
    if (taskId.length > 0 && !open.includes(taskId)) open.push(taskId)
  }
  return open
}

/**
 * Fold task ids whose host-published `multitask/phase` is terminal.
 *
 * `done` (writer handoff completed) and `failed` both close a task; a task
 * with any later non-terminal phase event after a terminal one stays closed —
 * the host never re-opens a published terminal phase.
 *
 * @param session - session whose log is folded.
 * @returns set of terminal task ids.
 */
export function foldTerminalTasks(session) {
  const terminal = new Set()
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'multitask/phase') continue
    const taskId = String(event.data?.id ?? '')
    if (taskId.length === 0) continue
    if (event.data?.phase === 'done' || event.data?.phase === 'failed') terminal.add(taskId)
  }
  return terminal
}

function viewOf(state) {
  if (!state.active && state.openTasks.length === 0) return INACTIVE_VIEW
  return {
    active: state.active,
    openTasks: state.openTasks
  }
}

/** Projection of committed orchestrator mode and cropped wire view. */
export const orchestratorModeProjectionDefinition = {
  key: PROJECTION_KEY,
  stateVersion: 1,
  stateSchema,
  init: () => ({
    active: false,
    openTasks: EMPTY_TASKS,
    activeAtLastHeader: null
  }),
  apply: (state, event) => {
    if (event.type === MODE_EVENT_TYPE) {
      const openTasks = Object.freeze(
        (Array.isArray(event.data?.openTasks) ? event.data.openTasks : []).map(id => String(id))
      )
      return {
        active: event.data?.active === true,
        openTasks,
        activeAtLastHeader: state.activeAtLastHeader
      }
    }
    if (event.type === 'request/header') {
      if (state.activeAtLastHeader === state.active) return state
      return {
        ...state,
        activeAtLastHeader: state.active
      }
    }
    return state
  },
  wire: {
    viewSchema,
    view: viewOf
  }
}

/**
 * `ctx.multitaskMode`: owns logged orchestrator state, applies and narrates
 * selected state at accepted pre-step boundaries, and the named prompt section.
 */
export class OrchestratorModeController extends Service {
  pendingIntents = new WeakMap()

  constructor(ctx) {
    super(ctx, 'multitaskMode')
    const projections = ctx.get('sessionProjections')
    const systemPrompt = ctx.get('systemPrompt')
    this.projections = projections
    projections.register(orchestratorModeProjectionDefinition)
    systemPrompt.section({
      name: ORCHESTRATOR_SECTION_NAME,
      order: systemPrompt.getSectionOrder('PLAN_POLICY'),
      text: (context) => {
        if (context.agent === undefined) return ''
        try {
          const pending = this.pendingIntents.get(context.agent.session)
          return (pending?.active ?? this.loggedActive(context.agent.session))
            ? ORCHESTRATOR_GUIDANCE
            : ''
        } catch {
          return ''
        }
      }
    })
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      const pending = this.pendingIntents.get(agent.session)
      if (decision.kind === 'reject' || signal.aborted || pending === undefined) return decision
      const narration = pending.narrate ? this.narration(pending) : undefined
      try {
        this.onBoundary(agent.session)
      } catch (error) {
        ctx.get?.('logger')?.warn?.(
          `dsh-multitask: failed to append selected orchestrator mode at step start: ${error}`
        )
        return decision
      }
      return narration === undefined
        ? decision
        : {
            ...decision,
            messages: [...decision.messages, narration]
          }
    })
    ctx.on?.('session/event', (session, event) => {
      if (event.type !== 'multitask/task') return
      const agent = ctx.get?.('agents')?.get?.(session.id)
      if (agent === undefined || agent.session !== session) return
      const taskId = String(event.data?.id ?? '')
      if (taskId.length === 0) return
      this.noteTaskOpened(agent, taskId)
    })
    ctx.on?.('agent/created', ({ agent }) => {
      this.syncFromLog(agent)
    })
  }

  loggedState(session) {
    const state = this.projections.stateOf(session, PROJECTION_KEY)
    if (state === undefined) throw new Error('orchestrator-mode requires the multitask-mode session projection')
    return state
  }

  loggedActive(session) {
    return this.loggedState(session).active
  }

  loggedOpenTasks(session) {
    return [...this.loggedState(session).openTasks]
  }

  loggedIntent(session) {
    const state = this.loggedState(session)
    return {
      active: state.active,
      openTasks: [...state.openTasks]
    }
  }

  currentIntent(session) {
    const pending = this.pendingIntents.get(session)
    return pending === undefined
      ? this.loggedIntent(session)
      : {
          active: pending.active,
          openTasks: [...pending.openTasks]
        }
  }

  narration(intent) {
    if (!intent.active) return undefined
    const taskId = intent.openTasks.at(-1)
    if (taskId === undefined) return undefined
    return activationNarration(taskId)
  }

  /**
   * Select the next committed `{active, openTasks}` snapshot.
   *
   * @param agent - receiving agent.
   * @param intent - whole-value mode snapshot to apply.
   * @returns plan-mode controller outcome.
   */
  set(agent, intent) {
    const session = agent.session
    const target = {
      active: intent.active === true && intent.openTasks.length > 0,
      openTasks: [...intent.openTasks]
    }
    if (target.active === false) target.openTasks = []
    if (sameIntent(target, this.currentIntent(session))) return 'noop'
    if (sameIntent(target, this.loggedIntent(session))) {
      this.pendingIntents.delete(session)
      return 'cancelled'
    }
    this.pendingIntents.set(session, {
      ...target,
      narrate: target.active && !this.loggedActive(session)
    })
    return 'queued'
  }

  /** Append one pending selection before the next request assembly. */
  onBoundary(session) {
    const pending = this.pendingIntents.get(session)
    if (pending === undefined) return
    const target = {
      active: pending.active,
      openTasks: [...pending.openTasks]
    }
    if (sameIntent(target, this.loggedIntent(session))) {
      this.pendingIntents.delete(session)
      return
    }
    session.append(MODE_EVENT_TYPE, {
      active: target.active,
      openTasks: target.openTasks
    })
    this.pendingIntents.delete(session)
  }

  /**
   * Propose activation (or a larger open-task set) from a minted task.
   *
   * @param agent - receiving agent.
   * @param taskId - `MT-n` identity.
   */
  noteTaskOpened(agent, taskId) {
    const id = String(taskId ?? '')
    if (id.length === 0) return 'noop'
    const current = this.currentIntent(agent.session)
    const openTasks = current.openTasks.includes(id) ? current.openTasks : [...current.openTasks, id]
    return this.set(agent, { active: true, openTasks })
  }

  /**
   * Propose deactivation (or a smaller open-task set) when a task closes.
   *
   * @param agent - receiving agent.
   * @param taskId - `MT-n` identity.
   */
  noteTaskClosed(agent, taskId) {
    const id = String(taskId ?? '')
    if (id.length === 0) return 'noop'
    const openTasks = this.currentIntent(agent.session).openTasks.filter(existing => existing !== id)
    return this.set(agent, { active: openTasks.length > 0, openTasks })
  }

  /**
   * Re-propose intents the log recorded as tasks but never committed, and
   * close tasks whose folded phase is terminal, so a resumed process neither
   * re-opens finished work nor keeps it active.
   */
  syncFromLog(agent) {
    const desired = foldOpenTasks(agent.session)
    const logged = this.loggedOpenTasks(agent.session)
    for (const id of desired) {
      if (!logged.includes(id)) this.noteTaskOpened(agent, id)
    }
    const terminal = foldTerminalTasks(agent.session)
    if (terminal.size === 0) return
    const open = new Set([...this.currentIntent(agent.session).openTasks, ...logged])
    for (const id of open) {
      if (terminal.has(id)) this.noteTaskClosed(agent, id)
    }
  }
}

/**
 * Register the projection, prompt section, and controller when the host has
 * the required services. No-ops for the scaffold `apply({})` smoke path.
 *
 * @param ctx - host plugin context.
 * @returns the controller, or `undefined` when services are absent.
 */
export function registerOrchestratorMode(ctx) {
  const projections = ctx.get?.('sessionProjections')
  const systemPrompt = ctx.get?.('systemPrompt')
  if (typeof projections?.register !== 'function' || typeof systemPrompt?.section !== 'function') {
    return undefined
  }
  KNOWN_SESSION_EVENT_TYPES.add(MODE_EVENT_TYPE)
  return new OrchestratorModeController(ctx)
}
