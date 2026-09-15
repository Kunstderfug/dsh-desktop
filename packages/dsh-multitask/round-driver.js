/**
 * Same-session multitask round driver: orchestrator handoff reservations,
 * next-boundary admission, settlement re-wakes, and one configured wake
 * counter. Cloned structurally from `dsh-goal-round-driver` (race fences,
 * `validReservation` / `reject` / `restoreOtherClaimed`, teardown).
 *
 * @module dsh-multitask/round-driver
 */

import { isDeepStrictEqual } from 'node:util'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { effectiveClaims } from './claims.js'

/** Jobs-plugin anti-self-excitation default. */
export const DEFAULT_MAX_CONSECUTIVE_WAKES = 3

/** Whether a source identifies a driver-owned orchestrator handoff. */
export function isMultitaskHandoffSource(source) {
  return source?.kind === 'multitask' && typeof source.taskId === 'string' && source.taskId.length > 0
}

/**
 * Resolve the driver enable flag and the one wake bound.
 *
 * @param config - raw plugin config; omitted or `{ enabled: false }` keeps #4/#5/#8 behavior.
 * @returns normalized `{ enabled, maxConsecutiveWakes }`.
 */
export function resolveRoundDriverConfig(config = {}) {
  const max = config.maxConsecutiveWakes
  return {
    enabled: config.enabled === true,
    maxConsecutiveWakes: Number.isSafeInteger(max) && max >= 1 ? max : DEFAULT_MAX_CONSECUTIVE_WAKES
  }
}

/**
 * Render the model-visible orchestrator handoff for one task.
 *
 * @param task - minted `{ id, objective }`.
 * @param claims - live effective claim rows, already reconciled.
 * @param extras - optional capacity snapshot and protected parent paths.
 * @returns one text block for `createUserMessage`.
 */
export function renderHandoffPrompt(task, claims = [], extras = {}) {
  const live = (claims ?? []).filter(claim => claim.state !== 'released')
  const table = live.length === 0
    ? 'Live claims: (none)'
    : `Live claims:\n${live.map(claim => `- ${claim.path} held by ${claim.taskId} (owner ${claim.ownerSessionId})`).join('\n')}`
  const capacity = extras.capacity
  const capacityBlock = capacity == null
    ? ''
    : `\n\nWriter capacity: ${capacity.active}/${capacity.maxWriters} active (maxWriters=${capacity.maxWriters}, maxConsecutiveWakes=${capacity.maxConsecutiveWakes}).`
      + (capacity.available > 0
        ? ` ${capacity.available} slot(s) available.`
        : ' At cap; yield and queue for a later round.')
  const protectedPaths = extras.protectedPaths ?? []
  const protectedBlock = protectedPaths.length === 0
    ? ''
    : `\nProtected parent paths:\n${protectedPaths.map(path => `- ${path}`).join('\n')}`
  return [{
    type: 'text',
    text: `<multitask_round>
Task: ${task.id}
Objective: ${JSON.stringify(task.objective)}

${table}${capacityBlock}${protectedBlock}

Continue the multitask workflow for this task in this same session. Inspect researcher progress and durable session state, then orchestrate the next research or implementation step.
</multitask_round>`
  }]
}

/** Latest fold-derived task on a session log, if any. */
export function latestTask(session) {
  let task
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'multitask/task') continue
    const id = String(event.data?.id ?? '')
    if (id.length === 0) continue
    task = {
      id,
      objective: String(event.data?.objective ?? '')
    }
  }
  return task
}

/**
 * Whether a task's host-published `multitask/phase` is terminal (`done` or
 * `failed`). Terminal tasks are never wake-eligible, so a finished card
 * neither resurrects a closed task nor consumes the shared wake budget.
 *
 * @param session - parent session log.
 * @param taskId - `MT-n` identity.
 */
export function isTerminalTask(session, taskId) {
  const id = String(taskId)
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'multitask/phase') continue
    if (String(event.data?.id ?? '') !== id) continue
    if (event.data?.phase === 'done' || event.data?.phase === 'failed') return true
  }
  return false
}

/** Latest task that has not reached a terminal phase, if any. */
function latestOpenTask(session) {
  let task
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'multitask/task') continue
    const id = String(event.data?.id ?? '')
    if (id.length === 0 || isTerminalTask(session, id)) continue
    task = {
      id,
      objective: String(event.data?.objective ?? '')
    }
  }
  return task
}

function sameQueued(content, source, attempt) {
  return isMultitaskHandoffSource(source)
    && source.taskId === attempt.taskId
    && isDeepStrictEqual(content, attempt.content)
}

function renderThrown(value) {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Preserve claimed step context when this driver drops only its own handoff.
 *
 * @param agent - receiving agent.
 * @param messages - the pre-step batch.
 * @param messageId - the rejected handoff identity.
 */
function restoreOtherClaimed(agent, messages, messageId) {
  const retained = messages.filter(message => message.id !== messageId)
  for (const message of retained.toReversed()) {
    if (
      agent.inbox.nextStep.some(candidate => candidate.id === message.id)
      || agent.inbox.nextTurn.some(candidate => candidate.id === message.id)
    ) continue
    agent.inbox.prepend('next-step', message)
  }
}

/**
 * Install automatic handoff reservations, settlement wakes, and race fences.
 *
 * @param ctx - composed host context (agents, sessions, events).
 * @param config - already-resolved `{ maxConsecutiveWakes }`.
 * @returns `{ queueHandoff, notifySettlement, refreshHandoffTable, queueLaterRound, snapshotBudget, config }`.
 */
export function registerRoundDriver(ctx, config) {
  const maxConsecutiveWakes = config.maxConsecutiveWakes
  const states = new Map()

  function admissionExtras(agent) {
    const guardrails = ctx.get?.('multitask.guardrails')
    if (guardrails == null) return {}
    return {
      capacity: guardrails.capacitySnapshot(agent),
      protectedPaths: guardrails.protectedPaths(agent)
    }
  }

  function stateFor(agent) {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const state = {
      agent,
      attempt: undefined,
      competingQueued: false,
      consecutiveWakes: 0,
      disarmed: false,
      needsWake: false,
      wakeTask: undefined,
      requested: false,
      run: undefined,
      stopping: false
    }
    states.set(agent, state)
    return state
  }

  function agents() {
    return ctx.agents ?? ctx.get?.('agents')
  }

  function isLive(state) {
    const registry = agents()
    if (typeof registry?.get !== 'function') return true
    return registry.get(state.agent.id) === state.agent
  }

  function readyToDrive(state) {
    return (ctx.fiber?.state === undefined || ctx.fiber.state === 2)
      && !state.stopping
      && !state.disarmed
      && isLive(state)
      && state.agent.status === 'idle'
      && !state.competingQueued
  }

  /** Re-publish leftover ordinary input so a rejected handoff cannot park it. */
  function kickPendingOrdinary(state) {
    const { agent } = state
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
      .find(message => message.source?.kind === 'user')
    if (pending === undefined) return false
    if (!agent.inbox.remove(pending.id)) return false
    try {
      agent.followup(pending)
      return true
    } catch (error) {
      ctx.logger?.warn?.(`multitask-round-driver: could not wake pending input for agent "${agent.id}": ${renderThrown(error)}`)
      try {
        agent.inbox.prepend('next-turn', pending)
      } catch {
        /* the original message is already out of the inbox */
      }
      return false
    }
  }

  function disarm(state) {
    state.disarmed = true
    state.needsWake = false
    if (state.attempt !== undefined) state.attempt.stale = true
  }

  function snapshotClaims(agent) {
    const state = ctx.get?.('sessionProjections')?.stateOf?.(agent.session, 'multitask/claims')
    const records = (state?.records ?? []).filter(record => record.state === 'claimed')
    return records.length > 0 ? records : effectiveClaims(agent.session)
  }

  async function liveClaims(agent) {
    const service = ctx.get?.('multitask.claims')
    if (typeof service?.list === 'function') {
      try {
        return (await service.list(agent.session)).claims
      } catch {
        return snapshotClaims(agent)
      }
    }
    return snapshotClaims(agent)
  }

  function queueMessage(state, task, claims = []) {
    const content = renderHandoffPrompt(task, claims, admissionExtras(state.agent))
    const message = createUserMessage({
      content,
      source: {
        kind: 'multitask',
        taskId: task.id
      }
    })
    state.attempt = {
      taskId: task.id,
      messageId: message.id,
      content,
      phase: 'queued',
      cancelled: false,
      stale: false
    }
    try {
      state.agent.followup(message)
    } catch (error) {
      try {
        state.agent.inbox.prepend('next-turn', message)
      } catch {
        state.attempt = undefined
        ctx.logger?.warn?.(`multitask-round-driver: could not queue handoff for ${task.id}: ${renderThrown(error)}`)
      }
    }
    return message
  }

  function taskObjective(session, taskId) {
    let objective = ''
    for (const event of session.snapshotEvents()) {
      if (event.type === 'multitask/task' && String(event.data?.id ?? '') === String(taskId)) {
        objective = String(event.data?.objective ?? '')
      }
    }
    return objective
  }

  function queueHandoff(agent, task, claims) {
    if (task?.id == null) return
    const state = stateFor(agent)
    if (state.stopping) return
    queueMessage(state, task, claims ?? snapshotClaims(agent))
  }

  function refreshHandoffTable(agent, claims) {
    const state = stateFor(agent)
    if (state.stopping) return
    const table = claims ?? snapshotClaims(agent)
    const queued = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
      .filter(message => isMultitaskHandoffSource(message.source))
    for (const message of queued) {
      if (!agent.inbox.remove(message.id)) continue
      const task = {
        id: message.source.taskId,
        objective: taskObjective(agent.session, message.source.taskId)
      }
      const content = renderHandoffPrompt(task, table, admissionExtras(agent))
      const next = createUserMessage({
        content,
        source: { kind: 'multitask', taskId: task.id }
      })
      try {
        agent.followup(next)
      } catch {
        try {
          agent.inbox.prepend('next-turn', next)
        } catch {
          /* the original message is already out of the inbox */
        }
      }
      if (state.attempt !== undefined && state.attempt.taskId === task.id) {
        state.attempt.messageId = next.id
        state.attempt.content = content
        state.attempt.stale = false
        state.attempt.cancelled = false
      }
    }
  }

  function notifySettlement(agent, task) {
    const state = stateFor(agent)
    if (state.stopping || state.disarmed) return
    const requested = task?.id != null
      ? task
      : latestTask(agent.session) ?? state.wakeTask
    const openTask = requested != null && !isTerminalTask(agent.session, requested.id)
      ? requested
      : latestOpenTask(agent.session)
    if (openTask == null) return
    state.wakeTask = { id: openTask.id, objective: String(openTask.objective ?? '') }
    state.needsWake = true
    if (agent.status === 'idle') requestDrive(state)
  }

  async function drive(state) {
    if (!readyToDrive(state)) return
    if (state.attempt !== undefined) {
      if (state.attempt.stale || state.attempt.cancelled || state.attempt.phase === 'admitted') {
        state.attempt = undefined
      } else {
        return
      }
    }
    if (kickPendingOrdinary(state)) return
    if (!state.needsWake || state.disarmed) return
    if (state.consecutiveWakes >= maxConsecutiveWakes) {
      state.needsWake = false
      return
    }
    const task = state.wakeTask ?? latestTask(state.agent.session)
    if (task === undefined) {
      state.needsWake = false
      return
    }
    state.needsWake = false
    queueMessage(state, task, await liveClaims(state.agent))
  }

  function startDetached(operation) {
    const registry = agents()
    if (typeof registry?.withoutInitiator === 'function') {
      try {
        return registry.withoutInitiator(operation)
      } catch {
        /* test compositions may lack an initiator scope */
      }
    }
    return operation()
  }

  function requestDrive(state) {
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined) return
    let run
    try {
      run = startDetached(async () => {
        while (state.requested && !state.stopping) {
          state.requested = false
          try {
            await drive(state)
          } catch (error) {
            ctx.logger?.warn?.(`multitask-round-driver: driver failed for agent "${state.agent.id}": ${renderThrown(error)}`)
            disarm(state)
          }
        }
      })
    } catch (error) {
      ctx.logger?.warn?.(`multitask-round-driver: could not start driver for agent "${state.agent.id}": ${renderThrown(error)}`)
      return
    }
    state.run = run
    const retire = () => {
      state.run = undefined
      if (state.requested && !state.stopping) requestDrive(state)
    }
    Promise.resolve(run).then(retire, error => {
      ctx.logger?.warn?.(`multitask-round-driver: driver task rejected for agent "${state.agent.id}": ${renderThrown(error)}`)
      disarm(state)
      retire()
    })
  }

  function validReservation(state, content, source) {
    const attempt = state.attempt
    return ctx.fiber?.state === 2
      && !state.stopping
      && attempt !== undefined
      && attempt.phase === 'claimed'
      && !attempt.stale
      && !attempt.cancelled
      && sameQueued(content, source, attempt)
  }

  ctx.effect(function* () {
    ctx.on('agent/created', ({ agent }) => {
      stateFor(agent)
    })
    ctx.on('agent/disposed', ({ agent }) => {
      states.delete(agent)
    })
    ctx.on('agent/session-start', ({ agent }) => {
      const state = stateFor(agent)
      state.attempt = undefined
      state.competingQueued = false
    })
    ctx.on('agent/status', ({ agent, status }) => {
      const state = stateFor(agent)
      if (status !== 'idle') return
      state.competingQueued = false
      requestDrive(state)
    })
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      const state = stateFor(agent)
      if (message.source?.kind === 'subagent-settled') {
        notifySettlement(agent, latestTask(agent.session) ?? state.wakeTask)
      }
      if (!agent.inbox.nextTurn.some(candidate => candidate.id === message.id)) return
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) return
      if (isMultitaskHandoffSource(message.source)) return
      state.competingQueued = true
      if (attempt?.phase === 'queued') attempt.stale = true
    })
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const state = stateFor(agent)
      if (message.source?.kind === 'user') {
        state.consecutiveWakes = 0
        state.disarmed = false
      }
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) {
        attempt.phase = 'claimed'
      }
    })
    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      const attempt = stateFor(agent).attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) {
        attempt.cancelled = true
      }
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents?.get?.(session.id)
      if (agent === undefined || agent.session !== session) return
      const state = stateFor(agent)
      switch (event.type) {
        case 'user/message':
          if (state.attempt !== undefined && event.data.id === state.attempt.messageId) {
            state.attempt.phase = 'admitted'
          }
          return
        case 'turn/end':
          if (event.data.reason?.kind === 'max-tokens') {
            disarm(state)
            return
          }
          if (event.data.reason?.kind !== 'aborted') return
          if (state.attempt?.phase === 'claimed' || state.attempt?.phase === 'admitted') {
            state.attempt.cancelled = true
          } else {
            disarm(state)
          }
          return
        default:
      }
    })
    ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      const submitted = messages.find(message => isMultitaskHandoffSource(message.source))
      if (submitted === undefined) return next()
      const { content, source } = submitted
      const state = stateFor(agent)
      let valid = false
      try {
        valid = validReservation(state, content, source)
      } catch (error) {
        ctx.logger?.warn?.(`multitask-round-driver: pre-step check failed for agent "${agent.id}": ${renderThrown(error)}`)
        disarm(state)
      }
      if (!valid) {
        const attempt = state.attempt
        if (attempt !== undefined && attempt.taskId === source.taskId) {
          attempt.stale = true
          state.attempt = undefined
        }
        restoreOtherClaimed(agent, messages, submitted.id)
        requestDrive(state)
        return { kind: 'reject' }
      }
      let decision
      try {
        decision = await next()
      } catch (error) {
        if (signal.aborted) throw error
        state.attempt = undefined
        requestDrive(state)
        throw error
      }
      if (signal.aborted) {
        if (decision.kind === 'enter') restoreOtherClaimed(agent, decision.messages, submitted.id)
        return decision
      }
      if (decision.kind === 'reject') {
        state.attempt = undefined
        return decision
      }
      try {
        valid = validReservation(state, content, source)
      } catch (error) {
        ctx.logger?.warn?.(`multitask-round-driver: post-decision check failed for agent "${agent.id}": ${renderThrown(error)}`)
        disarm(state)
        valid = false
      }
      if (!valid) {
        state.attempt = undefined
        restoreOtherClaimed(agent, decision.messages, submitted.id)
        requestDrive(state)
        return { kind: 'reject' }
      }
      if (state.attempt !== undefined) state.attempt.phase = 'admitted'
      state.consecutiveWakes += 1
      return {
        ...decision,
        startsRequestSeries: true
      }
    })

    yield async () => {
      const waits = []
      for (const state of states.values()) {
        state.stopping = true
        const attempt = state.attempt
        if (attempt !== undefined) {
          attempt.stale = true
          if (state.agent.status === 'running') {
            state.agent.cancel({ kind: 'parent' })
            waits.push(state.agent.whenIdle())
          }
        }
        if (state.run !== undefined) waits.push(state.run)
      }
      await Promise.allSettled(waits)
      states.clear()
    }
  }, 'multitask-round-driver lifecycle')

  function snapshotBudget(agent) {
    const state = stateFor(agent)
    return {
      consecutiveWakes: state.consecutiveWakes,
      maxConsecutiveWakes,
      config
    }
  }

  function queueLaterRound(agent, task) {
    if (task?.id == null) return { queued: false }
    const state = stateFor(agent)
    if (state.stopping || state.disarmed) return { queued: false, reason: 'stopped' }
    const already = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
      .some(message => isMultitaskHandoffSource(message.source) && message.source.taskId === task.id)
    if (already) return { queued: true, unique: true, reason: 'already-queued' }
    if (state.consecutiveWakes >= maxConsecutiveWakes) {
      state.needsWake = false
      return { queued: false, reason: 'wake-bound' }
    }
    state.wakeTask = { id: task.id, objective: String(task.objective ?? '') }
    state.needsWake = true
    if (agent.status === 'idle') requestDrive(state)
    return { queued: true, unique: true, reason: 'yield' }
  }

  return { queueHandoff, notifySettlement, refreshHandoffTable, queueLaterRound, snapshotBudget, config }
}
