/**
 * Host claim-enforcement guard for the [multitask] plugin (issue #9).
 *
 * Registers outermost on `tools/pre-execute` and the fs write/edit intents.
 * Abstains via `next()`. One attempted mutation reports one denial. Bash is
 * intentionally not inspected.
 *
 * @module dsh-multitask/claims-guard
 */

import { FsError } from '@deepseek-ai/dsh-fs'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import {
  CLAIM_EVENT_TYPE,
  normalizeClaimPath,
  pathsOverlap,
  resolveMultitaskSession
} from './claims.js'

/** Session-log event for one boundary intervention. */
export const DENIAL_EVENT_TYPE = 'multitask/denial'

/** Ticket-named remedy appended to every denial reason. */
export const CLAIM_REMEDY = 'ask the orchestrator or claim a different path'

/** Model-facing mutating tools this tier claims against, and their path argument. */
export const GUARDED_PATH_ARGUMENTS = Object.freeze({
  write: 'file_path',
  edit: 'file_path',
  str_replace_editor: 'path'
})

/** Alias used by the host package export face. */
export const GUARDED_TOOL_PATH_ARGUMENTS = GUARDED_PATH_ARGUMENTS

/** Visible task-card footnote: Bash stays outside tier 2. */
export const BASH_TIER2_SCOPE_NOTE = 'Native write/edit tools are guarded. Bash writes are not covered by tier 2.'

/**
 * Actionable denial text: path, holding task, and remedy.
 *
 * @param path - normalized workspace-relative path.
 * @param holderTaskId - live task that holds the path.
 */
export function formatClaimDenialReason(path, holderTaskId) {
  return `path ${JSON.stringify(path)} held by task ${holderTaskId}; ${CLAIM_REMEDY}`
}

/** Alias used by the host package export face. */
export const formatClaimDenial = formatClaimDenialReason

function arguedPath(input) {
  if (input == null) return undefined
  if (typeof input === 'string') return input
  if (typeof input !== 'object') return undefined
  const args = input.arguments ?? input
  const name = input.name
  const key = name != null ? GUARDED_PATH_ARGUMENTS[name] : undefined
  const raw = key != null
    ? args?.[key]
    : args?.file_path ?? args?.path ?? input.displayPath ?? input.targetKey
  return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined
}

function claimsService(ctx) {
  return ctx.get?.('multitask.claims') ?? ctx['multitask.claims']
}

function ownsHolder(agent, session, holder) {
  const ownerId = String(agent.session.id)
  if (holder.ownerSessionId === ownerId) return true
  return ownerId === String(session.id) && holder.ownerSessionId === String(session.id)
}

function latestTaskId(session) {
  let id
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'multitask/task') continue
    const next = String(event.data?.id ?? '')
    if (next.length > 0) id = next
  }
  return id
}

function deniedTaskId(session, agent, holderTaskId) {
  const ownerId = String(agent.session.id)
  for (const event of session.snapshotEvents()) {
    if (event.type === 'multitask/research' && String(event.data?.childId ?? '') === ownerId) {
      const id = String(event.data?.id ?? '')
      if (id.length > 0) return id
    }
  }
  const latest = latestTaskId(session)
  if (latest != null && latest !== holderTaskId) return latest
  return latest ?? holderTaskId
}

const notedExecs = new WeakSet()

function recordDenial(session, agent, path, holderTaskId, reason, exec) {
  if (exec != null && notedExecs.has(exec)) return
  if (exec != null) notedExecs.add(exec)
  const taskId = deniedTaskId(session, agent, holderTaskId)
  session.append(DENIAL_EVENT_TYPE, {
    id: taskId,
    taskId,
    path,
    holderTaskId,
    reason,
    note: reason,
    phase: 'intervention',
    createdAt: new Date().toISOString()
  })
}

function recordTouch(ctx, agent, rawPath) {
  const service = claimsService(ctx)
  if (service == null || rawPath == null || agent == null) return
  const session = resolveMultitaskSession(ctx, agent) ?? agent.session
  service.recordTouched(session, rawPath)
}

/**
 * Resolve a live foreign holder for this write, or `undefined` to abstain.
 *
 * @param ctx - host context.
 * @param agent - invoking agent.
 * @param rawPath - tool or fs path.
 */
function foldedHolder(ctx, session, rawPath) {
  const normalized = normalizeClaimPath(session.header.cwd, rawPath)
  const state = ctx.get?.('sessionProjections')?.stateOf(session, CLAIM_EVENT_TYPE)
  const records = Array.isArray(state?.records) ? state.records : []
  const holder = records
    .filter(record => record.state === 'claimed')
    .find(claim => pathsOverlap(claim.path, normalized))
  return holder === undefined ? undefined : { holder, path: holder.path }
}

export async function foreignHolderFor(ctx, agent, rawPath) {
  if (agent == null || rawPath == null) return undefined
  const session = resolveMultitaskSession(ctx, agent)
  if (session === undefined) return undefined
  const service = claimsService(ctx)
  if (typeof service?.reconcile === 'function') {
    try {
      await service.reconcile(session)
    } catch {
      /* projection fold remains authoritative if proxy reconcile fails */
    }
  }
  let found
  try {
    found = foldedHolder(ctx, session, rawPath)
  } catch {
    return undefined
  }
  if (found === undefined || ownsHolder(agent, session, found.holder)) return undefined
  return { session, path: found.path, holder: found.holder }
}

/**
 * Install the claims guard on both enforcement seams and the touched-path feed.
 *
 * @param ctx - host plugin context.
 */
export function registerClaimsGuard(ctx) {
  KNOWN_SESSION_EVENT_TYPES.add(DENIAL_EVENT_TYPE)
  if (typeof ctx.on !== 'function') return

  ctx.on('tools/pre-execute', async (exec, next) => {
    const argument = GUARDED_PATH_ARGUMENTS[exec.name]
    if (argument === undefined) return next()
    const rawPath = arguedPath(exec)
    if (rawPath === undefined) return next()
    const foreign = await foreignHolderFor(ctx, exec.agent, rawPath)
    if (foreign === undefined) return next()
    const reason = formatClaimDenialReason(foreign.path, foreign.holder.taskId)
    recordDenial(foreign.session, exec.agent, foreign.path, foreign.holder.taskId, reason, exec)
    return { kind: 'deny', reason }
  })

  ctx.on('fs/write-intent', async (target, actor, next) => {
    const agent = actor?.agent
    const rawPath = arguedPath(target)
    const foreign = await foreignHolderFor(ctx, agent, rawPath)
    if (foreign !== undefined && agent != null) {
      const reason = formatClaimDenialReason(foreign.path, foreign.holder.taskId)
      recordDenial(foreign.session, agent, foreign.path, foreign.holder.taskId, reason, actor)
      throw new FsError(reason, 'FS_PERMISSION_DENIED')
    }
    if (rawPath !== undefined) recordTouch(ctx, agent, rawPath)
    return next()
  })

  ctx.on('fs/edit-intent', async (target, actor, next) => {
    const agent = actor?.agent
    const rawPath = arguedPath(target)
    const foreign = await foreignHolderFor(ctx, agent, rawPath)
    if (foreign !== undefined && agent != null) {
      const reason = formatClaimDenialReason(foreign.path, foreign.holder.taskId)
      recordDenial(foreign.session, agent, foreign.path, foreign.holder.taskId, reason, actor)
      throw new FsError(reason, 'FS_PERMISSION_DENIED')
    }
    if (rawPath !== undefined) recordTouch(ctx, agent, rawPath)
    return next()
  })

  ctx.on('tools/result', (exec, result) => {
    if (result?.isError) return
    const rawPath = arguedPath(exec)
    if (rawPath === undefined) return
    recordTouch(ctx, exec.agent, rawPath)
  })

  ctx.on('agent/created', ({ agent }) => {
    if (typeof agent?.ctx?.on !== 'function') return
    agent.ctx.on('tools/pre-execute', async (exec, next) => {
      const argument = GUARDED_PATH_ARGUMENTS[exec.name]
      if (argument === undefined) return next()
      const rawPath = arguedPath(exec)
      if (rawPath === undefined) return next()
      const foreign = await foreignHolderFor(ctx, exec.agent ?? agent, rawPath)
      if (foreign === undefined) return next()
      const reason = formatClaimDenialReason(foreign.path, foreign.holder.taskId)
      recordDenial(foreign.session, exec.agent ?? agent, foreign.path, foreign.holder.taskId, reason, exec)
      return { kind: 'deny', reason }
    })
  })
}
