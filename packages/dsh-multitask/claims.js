/**
 * Log-backed `multitask.claims` service, session-projection unit, and
 * agent-scoped claim tools for the [multitask] host plugin (issue #8).
 *
 * Persistence authority is the receiving session log. Effective claims are
 * the projection fold after dead-owner expiry consulted from real subagent
 * activity. Issue #9 adds live policy helpers (release-all, touched-path
 * pre-claim, holder lookup) used by the host claims guard.
 *
 * @module dsh-multitask/claims
 */

import { Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import {
  fileAddressFor,
  isAbsoluteWorkspacePath,
  parseFileAddress,
  relativizeToCwd,
  resolveWorkspacePath
} from '@deepseek-ai/dsh-util-workspace-path'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Agent-scoped claim tool names. Never registered on the global catalog. */
export const CLAIM_TOOL_NAMES = Object.freeze([
  'claim_files',
  'release_files',
  'list_file_claims'
])

/** Structured conflict code materialized on a denied overlapping claim. */
export const CLAIM_CONFLICT_CODE = 'CLAIM_CONFLICT'

/** Session-log and projection key for claim state. */
export const CLAIM_EVENT_TYPE = 'multitask/claims'

const EMPTY_STATE = Object.freeze({ records: Object.freeze([]) })
const EMPTY_VIEW = Object.freeze({ claims: Object.freeze([]) })
const touchedBySession = new WeakMap()

const claimRecordSchema = z.object({
  path: z.string(),
  taskId: z.string(),
  ownerSessionId: z.string(),
  state: z.enum(['claimed', 'released']),
  since: z.string()
})

const claimsStateSchema = z.object({
  records: z.array(claimRecordSchema)
})

const claimsWireSchema = z.object({
  claims: z.array(claimRecordSchema)
})

/**
 * Structured overlap denial. The tool runtime materializes `info: { name, code }`.
 */
export class ClaimConflictError extends HarnessError {
  /**
   * @param path - the normalized path the caller failed to acquire.
   * @param holderTaskId - the live task that already holds an overlapping path.
   */
  constructor(path, holderTaskId) {
    super(`path ${JSON.stringify(path)} held by task ${holderTaskId}`, CLAIM_CONFLICT_CODE)
    this.path = path
    this.holderTaskId = holderTaskId
  }
}

/**
 * Normalize one caller path to a workspace-relative identity.
 *
 * @param cwd - session workspace root.
 * @param input - absolute or workspace-relative path.
 * @returns posix workspace-relative path without a trailing slash.
 */
export function normalizeClaimPath(cwd, input) {
  const raw = String(input ?? '').trim()
  if (raw === '') throw new HarnessError('claim path must be non-empty', 'CLAIM_INVALID_PATH')
  const posix = raw.replace(/\\/g, '/')
  const resolved = resolveWorkspacePath(cwd, posix)
  let relative = relativizeToCwd(resolved, cwd).replace(/\\/g, '/')
  relative = relative.replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '')
  if (isAbsoluteWorkspacePath(relative) && cwd) {
    const parsed = parseFileAddress(fileAddressFor('claim', cwd, resolved))
    if (typeof parsed?.path === 'string') {
      relative = parsed.path.replace(/\\/g, '/').replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '')
    }
  }
  if (isAbsoluteWorkspacePath(relative)) {
    throw new HarnessError(`claim path must be workspace-relative: ${raw}`, 'CLAIM_INVALID_PATH')
  }
  return relative === '' ? '.' : relative
}

/**
 * Segment-aware overlap: exact match, ancestor, or descendant.
 *
 * @param left - normalized path.
 * @param right - normalized path.
 */
export function pathsOverlap(left, right) {
  if (left === right) return true
  if (left === '.' || right === '.') return true
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function uniquePaths(paths) {
  return [...new Set(paths)]
}

function hasOpenTasks(session) {
  return session.snapshotEvents().some(event => event.type === 'multitask/task')
}

function resolveClaimsSession(ctx, agent) {
  let current = agent.session
  const seen = new Set()
  for (;;) {
    const id = String(current.id)
    if (seen.has(id)) break
    seen.add(id)
    if (hasOpenTasks(current)) return current
    const parentId = current.header.parentSession
    if (parentId === undefined) break
    current = ctx.get?.('sessions')?.get(parentId) ?? ctx.get?.('agents')?.get(parentId)?.session
    if (current === undefined) break
  }
  throw new HarnessError('claim tools require an open multitask task', 'CLAIM_NO_TASK')
}

function foldedClaims(ctx, session) {
  const state = ctx.get?.('sessionProjections')?.stateOf(session, CLAIM_EVENT_TYPE)
  if (state === undefined) return effectiveClaims(session)
  return state.records.filter(record => record.state === 'claimed')
}

/**
 * Fold the session log into the live claim table without the projection unit.
 *
 * @param session - multitask-owning session log.
 */
export function effectiveClaims(session) {
  const table = new Map()
  for (const event of session.snapshotEvents()) {
    if (event.type !== CLAIM_EVENT_TYPE) continue
    const record = event.data
    if (record?.path == null) continue
    if (record.state === 'released') table.delete(record.path)
    else table.set(record.path, record)
  }
  return [...table.values()].sort((left, right) => String(left.path).localeCompare(String(right.path)))
}

function ownerIsLive(ctx, session, claim, activity) {
  if (String(claim.ownerSessionId) === String(session.id)) {
    return ctx.get?.('agents')?.get(session.id) !== undefined
  }
  return activity.get(String(claim.ownerSessionId)) === 'running'
}

function applyClaims(state, event) {
  if (event.type !== CLAIM_EVENT_TYPE) return state
  const record = event.data
  if (record.state === 'released') {
    const records = state.records.filter(existing =>
      !(existing.path === record.path
        && existing.taskId === record.taskId
        && existing.ownerSessionId === record.ownerSessionId))
    return records.length === state.records.length ? state : { records }
  }
  const records = state.records.filter(existing => existing.path !== record.path)
  records.push({
    path: record.path,
    taskId: record.taskId,
    ownerSessionId: record.ownerSessionId,
    state: 'claimed',
    since: record.since
  })
  return { records }
}

function viewClaims(state) {
  const claims = state.records
    .filter(record => record.state === 'claimed')
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path))
  return claims.length === 0 ? EMPTY_VIEW : { claims }
}

/**
 * Log-backed claims service installed as `ctx['multitask.claims']`.
 */
export class MultitaskClaimsService extends Service {
  /**
   * @param ctx - host context owning projections and optional subagents.
   */
  constructor(ctx) {
    super(ctx, 'multitask.claims')
  }

  /**
   * Expire claims whose owner child is not running before any decision.
   *
   * @param session - the multitask-owning session whose log is authoritative.
   */
  async reconcile(session) {
    const live = foldedClaims(this.ctx, session)
    if (live.length === 0) return
    const activity = new Map()
    const subagents = this.ctx.get?.('subagents')
    if (typeof subagents?.listDescendants === 'function') {
      const descendants = await subagents.listDescendants(session.id)
      for (const entry of descendants) {
        if (entry.kind === 'child') activity.set(String(entry.id), entry.activity)
      }
    }
    const since = new Date().toISOString()
    for (const claim of live) {
      if (ownerIsLive(this.ctx, session, claim, activity)) continue
      session.append(CLAIM_EVENT_TYPE, {
        path: claim.path,
        taskId: claim.taskId,
        ownerSessionId: claim.ownerSessionId,
        state: 'released',
        since
      })
    }
  }

  /**
   * Atomically claim normalized paths for one owner and task.
   *
   * @param session - multitask-owning session log.
   * @param ownerSessionId - calling agent session id.
   * @param taskId - open multitask task id.
   * @param paths - caller-supplied paths.
   */
  async claim(session, ownerSessionId, taskId, paths) {
    await this.reconcile(session)
    const normalized = uniquePaths(paths.map(path => normalizeClaimPath(session.header.cwd, path)))
    const live = foldedClaims(this.ctx, session)
    for (const path of normalized) {
      const holder = live.find(claim =>
        pathsOverlap(claim.path, path)
        && !(claim.taskId === taskId && claim.ownerSessionId === ownerSessionId))
      if (holder !== undefined) throw new ClaimConflictError(path, holder.taskId)
    }
    const already = new Set(
      live
        .filter(claim => claim.taskId === taskId && claim.ownerSessionId === ownerSessionId)
        .map(claim => claim.path)
    )
    const added = normalized.filter(path => !already.has(path))
    const since = new Date().toISOString()
    for (const path of added) {
      session.append(CLAIM_EVENT_TYPE, {
        path,
        taskId,
        ownerSessionId,
        state: 'claimed',
        since
      })
    }
    return { claimed: normalized, idempotent: added.length === 0 }
  }

  /**
   * Release paths this owner and task currently hold.
   *
   * @param session - multitask-owning session log.
   * @param ownerSessionId - calling agent session id.
   * @param taskId - open multitask task id.
   * @param paths - caller-supplied paths.
   */
  async release(session, ownerSessionId, taskId, paths) {
    await this.reconcile(session)
    const normalized = uniquePaths(paths.map(path => normalizeClaimPath(session.header.cwd, path)))
    const live = foldedClaims(this.ctx, session)
    const since = new Date().toISOString()
    const released = []
    for (const path of normalized) {
      const held = live.find(claim =>
        claim.path === path
        && claim.taskId === taskId
        && claim.ownerSessionId === ownerSessionId)
      if (held === undefined) continue
      session.append(CLAIM_EVENT_TYPE, {
        path,
        taskId,
        ownerSessionId,
        state: 'released',
        since
      })
      released.push(path)
    }
    return { released }
  }

  /**
   * Live effective claim table after expiry.
   *
   * @param session - multitask-owning session log.
   */
  async list(session) {
    await this.reconcile(session)
    return {
      claims: foldedClaims(this.ctx, session)
        .slice()
        .sort((left, right) => left.path.localeCompare(right.path))
    }
  }

  /**
   * Release every live claim held by one owner, optionally filtered by task.
   *
   * @param session - multitask-owning session log.
   * @param ownerSessionId - settling agent session id.
   * @param taskId - optional task id; omit to release every path this owner holds.
   */
  async releaseAll(session, ownerSessionId, taskId) {
    await this.reconcile(session)
    const live = foldedClaims(this.ctx, session)
    const owner = String(ownerSessionId)
    const mine = live.filter(claim =>
      claim.ownerSessionId === owner
      && (taskId == null || claim.taskId === taskId)
    )
    const since = new Date().toISOString()
    const released = []
    for (const claim of mine) {
      session.append(CLAIM_EVENT_TYPE, {
        path: claim.path,
        taskId: claim.taskId,
        ownerSessionId: claim.ownerSessionId,
        state: 'released',
        since
      })
      released.push(claim.path)
    }
    return { released }
  }

  /**
   * Record a workspace path the session just touched through a host tool/fs event.
   *
   * @param session - multitask-owning session.
   * @param rawPath - caller path from write/edit/intent.
   */
  recordTouched(session, rawPath) {
    if (session == null) return
    try {
      const normalized = normalizeClaimPath(session.header.cwd, rawPath)
      let set = touchedBySession.get(session)
      if (set === undefined) {
        set = new Set()
        touchedBySession.set(session, set)
      }
      set.add(normalized)
    } catch {
      /* invalid paths are not claim identities */
    }
  }

  /**
   * Touched workspace-relative paths accumulated for this session.
   *
   * @param session - multitask-owning session.
   */
  touchedOf(session) {
    return [...(touchedBySession.get(session) ?? [])]
  }

  /**
   * Claim every currently touched path for the busy main task.
   *
   * @param session - multitask-owning session log.
   * @param ownerSessionId - busy parent session id.
   * @param taskId - the live busy task (MT-n).
   */
  async preclaimTouched(session, ownerSessionId, taskId) {
    const paths = this.touchedOf(session)
    if (paths.length === 0 || taskId == null || String(taskId).length === 0) {
      return { claimed: [], idempotent: true }
    }
    return this.claim(session, ownerSessionId, taskId, paths)
  }

  /**
   * Live holder of a path after expiry, if any.
   *
   * @param session - multitask-owning session log.
   * @param rawPath - caller path.
   */
  async holderFor(session, rawPath) {
    await this.reconcile(session)
    const normalized = normalizeClaimPath(session.header.cwd, rawPath)
    return foldedClaims(this.ctx, session).find(claim => pathsOverlap(claim.path, normalized))
  }

}

function defineClaimFiles(ctx, service) {
  return defineTool({
    name: 'claim_files',
    description: 'Claim workspace-relative paths for one open multitask task',
    parameters: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Workspace paths to claim'
      },
      taskId: {
        type: 'string',
        required: true,
        description: 'Open multitask task id (MT-n)'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claimed: { type: 'array', items: { type: 'string' }, required: true },
          idempotent: { type: 'boolean', required: true }
        }
      },
      render(_args, value) {
        const label = value.idempotent ? 'Already claimed' : 'Claimed'
        return [{ type: 'text', text: `${label} ${value.claimed.join(', ')}` }]
      }
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new HarnessError('claim_files requires an agent', 'CLAIM_NO_AGENT')
      const session = resolveClaimsSession(ctx, exec.agent)
      return service.claim(session, String(exec.agent.session.id), String(args.taskId), args.paths)
    }
  })
}

function defineReleaseFiles(ctx, service) {
  return defineTool({
    name: 'release_files',
    description: 'Release workspace-relative paths held by one open multitask task',
    parameters: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Workspace paths to release'
      },
      taskId: {
        type: 'string',
        required: true,
        description: 'Open multitask task id (MT-n)'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          released: { type: 'array', items: { type: 'string' }, required: true }
        }
      },
      render(_args, value) {
        return [{ type: 'text', text: `Released ${value.released.join(', ')}` }]
      }
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new HarnessError('release_files requires an agent', 'CLAIM_NO_AGENT')
      const session = resolveClaimsSession(ctx, exec.agent)
      return service.release(session, String(exec.agent.session.id), String(args.taskId), args.paths)
    }
  })
}

function defineListFileClaims(ctx, service) {
  return defineTool({
    name: 'list_file_claims',
    description: 'List live file claims for the open multitask session',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claims: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                taskId: { type: 'string', required: true },
                ownerSessionId: { type: 'string', required: true },
                state: { type: 'string', required: true },
                since: { type: 'string', required: true }
              }
            },
            required: true
          }
        }
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value.claims) }]
      }
    },
    async execute(_args, exec) {
      if (exec.agent === undefined) throw new HarnessError('list_file_claims requires an agent', 'CLAIM_NO_AGENT')
      return service.list(resolveClaimsSession(ctx, exec.agent))
    }
  })
}

const attachedAgents = new WeakSet()

function claimsSessionOrNull(ctx, agent) {
  try {
    return resolveClaimsSession(ctx, agent)
  } catch {
    return undefined
  }
}

function attachClaimTools(ctx, service, agent) {
  if (attachedAgents.has(agent) || claimsSessionOrNull(ctx, agent) === undefined) return
  attachedAgents.add(agent)
  agent.ctx.tools.register(defineClaimFiles(ctx, service))
  agent.ctx.tools.register(defineReleaseFiles(ctx, service))
  agent.ctx.tools.register(defineListFileClaims(ctx, service))
}

/**
 * Resolve the multitask-owning session for an agent, or `undefined`.
 *
 * @param ctx - host context.
 * @param agent - invoking agent.
 */
export function resolveMultitaskSession(ctx, agent) {
  return claimsSessionOrNull(ctx, agent)
}

/**
 * Register the claims projection, service, and agent-scoped tools.
 *
 * No-ops when the composition has no projection registry or tool runtime, so
 * the scaffold `apply({})` smoke path stays intact.
 *
 * @param ctx - host plugin context.
 */
export function registerClaims(ctx) {
  KNOWN_SESSION_EVENT_TYPES.add(CLAIM_EVENT_TYPE)
  const projections = ctx.get?.('sessionProjections')
  const tools = ctx.get?.('tools')
  if (typeof projections?.register !== 'function' || typeof tools?.register !== 'function') {
    return
  }

  projections.register({
    key: CLAIM_EVENT_TYPE,
    stateVersion: 1,
    stateSchema: claimsStateSchema,
    init: () => EMPTY_STATE,
    apply: applyClaims,
    wire: {
      viewSchema: claimsWireSchema,
      view: viewClaims
    }
  })

  const service = new MultitaskClaimsService(ctx)
  ctx.on?.('session/event', (session, event) => {
    if (event.type !== 'multitask/task') return
    const agent = ctx.get?.('agents')?.get(session.id)
    if (agent !== undefined) attachClaimTools(ctx, service, agent)
  })
  ctx.on?.('agent/created', ({ agent }) => {
    attachClaimTools(ctx, service, agent)
    if (hasOpenTasks(agent.session) && agent.session.header.origin !== 'subagent') {
      void service.reconcile(agent.session)
    }
  })
}
