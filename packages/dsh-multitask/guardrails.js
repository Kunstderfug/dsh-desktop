/**
 * Writer-admission guardrails for the [multitask] host plugin (issue #10).
 *
 * One controller owns capacity: live descendant writers plus parent-keyed
 * dispatch reservations. Researchers never consume a slot. The writer-facing
 * `subagent` tool is refused with a structured, orchestrator-visible reason
 * at cap; the existing round-driver config is the only wake bound.
 *
 * @module dsh-multitask/guardrails
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { Service } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { effectiveClaims } from './claims.js'
import { RESEARCHER_LABEL } from './researcher.js'
import { latestTask, renderHandoffPrompt } from './round-driver.js'

/** Plugin config default for `multitask.maxWriters`. */
export const DEFAULT_MAX_WRITERS = 2

/** Structured refusal code materialized in the tool denial reason. */
export const WRITER_CAP_CODE = 'WRITER_CAP'

/** Writer-facing delegation tool checked at `tools/pre-execute`. */
export const WRITER_TOOL_NAME = 'subagent'

const admission = new AsyncLocalStorage()
const wrappedRuntimes = new WeakSet()
const wrappedToolRuntimes = new WeakSet()

/**
 * Resolve `maxWriters`. Omitted values default to 2; invalid limits fail closed.
 *
 * @param config - raw plugin config.
 * @returns `{ maxWriters }`.
 */
export function resolveGuardrailsConfig(config = {}) {
  if (config.maxWriters === undefined) return { maxWriters: DEFAULT_MAX_WRITERS }
  const max = config.maxWriters
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new Error(`multitask.maxWriters must be a positive safe integer, got ${JSON.stringify(max)}`)
  }
  return { maxWriters: max }
}

/**
 * One structured, model-visible capacity refusal.
 *
 * @param input
 * @param input.maxWriters - configured cap.
 * @param input.activeWriters - counted writers + reservations.
 * @param input.maxConsecutiveWakes - shared driver bound (narration only).
 */
export function formatWriterCapRefusal({ maxWriters, activeWriters, maxConsecutiveWakes }) {
  return JSON.stringify({
    code: WRITER_CAP_CODE,
    maxWriters,
    activeWriters,
    maxConsecutiveWakes,
    queue: 'yield',
    reason: `writer cap reached (maxWriters=${maxWriters}); yield and queue for a later round`
  })
}

function renderCallbackError(error) {
  return error instanceof Error ? error.message : String(error)
}

function isResearcherSpec(spec) {
  const label = spec?.label ?? spec?.request?.label
  if (label === RESEARCHER_LABEL) return true
  const persona = spec?.request?.persona ?? spec?.persona
  if (typeof persona === 'string' && /multitask researcher/i.test(persona)) return true
  const deny = spec?.request?.toolFilter?.deny ?? spec?.toolFilter?.deny
  return Array.isArray(deny)
    && deny.includes('write')
    && deny.includes('edit')
    && deny.includes('str_replace_editor')
}

function omitProtectedPaths(text, paths) {
  let next = String(text ?? '')
  for (const raw of paths) {
    const value = String(raw ?? '')
    if (value.length === 0) continue
    next = next.split(value).join('')
  }
  return next
}

function sanitizeToolArguments(args, paths) {
  if (paths.length === 0 || args == null || typeof args !== 'object') return args
  const value = args
  if (isResearcherSpec({ label: value.description, prompt: value.prompt })) return args
  return { ...value, prompt: omitProtectedPaths(value.prompt, paths) }
}

function protectedPathsOf(session) {
  return effectiveClaims(session)
    .filter((claim) => claim.state !== 'released' && String(claim.ownerSessionId) === String(session.id))
    .map((claim) => String(claim.path))
}

function researcherChildIds(session) {
  const ids = new Set()
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'multitask/research') continue
    const childId = event.data?.childId
    if (childId != null) ids.add(String(childId))
  }
  return ids
}

function isResearcherIdentity(entry, researcherIds) {
  const id = String(entry?.id ?? '')
  if (id.length > 0 && researcherIds.has(id)) return true
  return entry?.label === RESEARCHER_LABEL
}

/**
 * `ctx['multitask.guardrails']`: writer admission, reservations, and shared budget.
 */
export class MultitaskGuardrails extends Service {
  constructor(ctx, options) {
    super(ctx, 'multitask.guardrails')
    this.maxWriters = options.maxWriters
    this.driverConfig = options.driverConfig
    this.driver = options.driver
    /** Optional host callback `(childId, parentId, taskId)` at writer admission. */
    this.onWriterStart = options.onWriterStart
    this.reservations = new Map()
    this.pendingByExec = new WeakMap()
    this.inflightByParent = new Map()
    this.install(ctx)
  }

  /** Attach the live driver after both controllers are constructed. */
  bindDriver(driver) {
    this.driver = driver
  }

  snapshotBudget(agent) {
    return this.driver?.snapshotBudget?.(agent) ?? {
      consecutiveWakes: 0,
      maxConsecutiveWakes: this.driverConfig.maxConsecutiveWakes,
      config: this.driverConfig
    }
  }

  protectedPaths(agent) {
    return protectedPathsOf(agent.session)
  }

  capacitySnapshot(agent) {
    const parentId = String(agent.session.id)
    const liveIds = new Set(this.liveWriterIds(parentId))
    let pending = 0
    for (const reservation of this.reservations.values()) {
      if (reservation.parentId !== parentId) continue
      if (reservation.childId != null && liveIds.has(reservation.childId)) continue
      pending += 1
    }
    const active = liveIds.size + pending
    return {
      active,
      maxWriters: this.maxWriters,
      available: Math.max(0, this.maxWriters - active),
      maxConsecutiveWakes: this.driverConfig.maxConsecutiveWakes
    }
  }

  liveWriterIds(parentId) {
    const agents = this.ctx.get?.('agents')
    const parent = agents?.get?.(parentId)?.session
    const researcherIds = parent == null ? new Set() : researcherChildIds(parent)
    const ids = []
    if (typeof agents?.list !== 'function') return ids
    for (const agent of agents.list()) {
      const header = agent.session?.header
      if (header?.origin !== 'subagent') continue
      if (String(header.parentSession ?? '') !== parentId) continue
      const id = String(agent.session.id)
      if (researcherIds.has(id) || this.childLabel(agent) === RESEARCHER_LABEL) continue
      ids.push(id)
    }
    return ids
  }

  childLabel(agent) {
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === 'subagent/descriptor' && event.data?.label != null) {
        return String(event.data.label)
      }
    }
    return ''
  }

  async activeWriterCount(agent) {
    const parentId = String(agent.session.id)
    const researcherIds = researcherChildIds(agent.session)
    const liveIds = new Set()
    const subagents = this.ctx.get?.('subagents')
    if (typeof subagents?.listDescendants === 'function') {
      try {
        const descendants = await subagents.listDescendants(agent.session.id)
        for (const event of descendants) {
          if (event.kind !== 'child' || event.activity !== 'running') continue
          if (isResearcherIdentity(event, researcherIds)) continue
          liveIds.add(String(event.id))
        }
      } catch {
        for (const id of this.liveWriterIds(parentId)) liveIds.add(id)
      }
    } else {
      for (const id of this.liveWriterIds(parentId)) liveIds.add(id)
    }
    let pending = 0
    for (const reservation of this.reservations.values()) {
      if (reservation.parentId !== parentId) continue
      if (reservation.childId != null && liveIds.has(reservation.childId)) continue
      pending += 1
    }
    return liveIds.size + pending
  }

  reserve(agent) {
    const id = `res-${Math.random().toString(16).slice(2)}`
    const task = latestTask(agent.session)
    this.reservations.set(id, {
      parentId: String(agent.session.id),
      taskId: task?.id,
      childId: undefined
    })
    return id
  }

  bindChild(reservationId, childId) {
    const reservation = this.reservations.get(reservationId)
    if (reservation == null || childId == null) return
    reservation.childId = String(childId)
  }

  releaseReservation(reservationId) {
    if (reservationId != null) this.reservations.delete(reservationId)
  }

  releaseChild(childId) {
    const id = String(childId)
    for (const [key, reservation] of this.reservations) {
      if (reservation.childId === id) this.reservations.delete(key)
    }
  }

  queueLaterHandoff(agent, task) {
    const alreadyQueued = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
      .some(message => message.source?.kind === 'multitask' && message.source.taskId === task.id)
    if (alreadyQueued) return
    const message = createUserMessage({
      content: renderHandoffPrompt(task, effectiveClaims(agent.session), {
        capacity: this.capacitySnapshot(agent),
        protectedPaths: this.protectedPaths(agent)
      }),
      source: { kind: 'multitask', taskId: task.id }
    })
    agent.inbox.prepend('next-turn', message)
  }

  async onPreExecute(exec, next) {
    this.ensureWrapped()
    if (exec?.name !== WRITER_TOOL_NAME) return next()
    if (this.pendingByExec.has(exec)) return next()
    const agent = exec.agent
    if (agent == null) return next()
    const active = await this.activeWriterCount(agent)
    if (active >= this.maxWriters) {
      const task = latestTask(agent.session)
      if (task != null) {
        const queued = this.driver?.queueLaterRound?.(agent, task)
        if (queued?.reason === 'yield' || queued?.reason === 'wake-bound') {
          if (agent.status === 'idle') this.queueLaterHandoff(agent, task)
          else this.driver?.queueHandoff?.(agent, task)
        }
      }
      return {
        kind: 'deny',
        reason: formatWriterCapRefusal({
          maxWriters: this.maxWriters,
          activeWriters: active,
          maxConsecutiveWakes: this.driverConfig.maxConsecutiveWakes
        })
      }
    }
    const reservationId = this.reserve(agent)
    const store = {
      reservationId,
      parentId: String(agent.session.id),
      protectedPaths: this.protectedPaths(agent)
    }
    this.pendingByExec.set(exec, store)
    this.inflightByParent.set(store.parentId, store)
    admission.enterWith(store)
    return next()
  }

  ensureWrapped() {
    const tools = this.ctx.get?.('tools')
    if (tools != null && !wrappedToolRuntimes.has(tools)) {
      wrappedToolRuntimes.add(tools)
      const originalExecute = tools.execute.bind(tools)
      const self = this
      tools.execute = async (input) => {
        if (input?.name !== WRITER_TOOL_NAME || input.agent == null) return originalExecute(input)
        const paths = self.protectedPaths(input.agent)
        return originalExecute({
          ...input,
          arguments: sanitizeToolArguments(input.arguments, paths)
        })
      }
    }
    const subagents = this.ctx.get?.('subagents')
    if (subagents == null || wrappedRuntimes.has(subagents)) return
    wrappedRuntimes.add(subagents)
    const originalContinuable = subagents.startContinuable.bind(subagents)
    const originalStart = subagents.start.bind(subagents)
    const self = this
    subagents.startContinuable = async (spec) => {
      const parentId = String(spec?.request?.parent?.session?.id ?? spec?.parent?.session?.id ?? '')
      const store = admission.getStore() ?? (parentId.length > 0 ? self.inflightByParent.get(parentId) : undefined)
      try {
        const result = await originalContinuable(spec)
        if (store != null && !isResearcherSpec(spec)) {
          self.bindChild(store.reservationId, result?.childId)
          if (store.parentId != null) self.inflightByParent.delete(store.parentId)
          if (result?.childId != null) {
            try {
              self.onWriterStart?.(String(result.childId), store.parentId, self.reservations.get(store.reservationId)?.taskId)
            } catch (error) {
              self.ctx.logger?.warn?.(`multitask-guardrails: writer-start callback failed: ${renderCallbackError(error)}`)
            }
          }
        }
        return result
      } catch (error) {
        if (store != null && !isResearcherSpec(spec)) {
          self.releaseReservation(store.reservationId)
          if (store.parentId != null) self.inflightByParent.delete(store.parentId)
        }
        throw error
      }
    }
    subagents.start = async (provider, request) => {
      const store = admission.getStore()
      try {
        return await originalStart(provider, request)
      } catch (error) {
        if (store != null) self.releaseReservation(store.reservationId)
        throw error
      }
    }
  }

  install(ctx) {
    this.ensureWrapped()
    ctx.on('tools/pre-execute', (exec, next) => this.onPreExecute(exec, next))
    ctx.on('agent/created', ({ agent }) => {
      this.ensureWrapped()
      if (typeof agent?.ctx?.on !== 'function') return
      agent.ctx.on('tools/pre-execute', (exec, next) => this.onPreExecute(exec, next))
    })
    ctx.on('tools/result', (exec, result) => {
      if (exec?.name !== WRITER_TOOL_NAME) return
      const store = this.pendingByExec.get(exec)
      if (store == null) return
      this.pendingByExec.delete(exec)
      if (result?.isError) this.releaseReservation(store.reservationId)
    })
    ctx.on('subagent/end', (info) => this.releaseChild(info.id))
  }
}

/**
 * Install the guardrails controller when the host has event hooks.
 * No-ops for the scaffold `apply({})` smoke path.
 *
 * @param ctx - host plugin context.
 * @param options - `{ maxWriters, driverConfig, driver? }`.
 */
export function registerGuardrails(ctx, options) {
  if (typeof ctx.on !== 'function') return undefined
  return new MultitaskGuardrails(ctx, options)
}
