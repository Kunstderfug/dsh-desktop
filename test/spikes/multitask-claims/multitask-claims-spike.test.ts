/**
 * Spike: claims enforcement seams (`tools/pre-execute` + fs intents) — [multitask] epic issue #2.
 * Frozen selector identity: `multitask_claims_spike`.
 *
 * Spec under test: docs/superpowers/specs/2026-09-13-multitask-orchestrator-mode-research.md (§4.4, §5.5 tier 2).
 *
 * This lane is THROWAWAY de-risking code and never ships as product code. It
 * composes the REAL installed harness packages from node_modules/@deepseek-ai/*
 * (real cordis kernel, real ToolRuntime execution pipeline, real fs backend and
 * policy waterfalls, real agents created through the real registry + agent-loop
 * factory) into a temp workspace and denies all writes to ONE hard-coded probe
 * path through a scratch guard, exactly as §5.5 tier 2 proposes. Nothing under
 * test is mocked: the assertions read the harness's own decision and result
 * surfaces (PreToolDecision, ToolExecutionResult, FsError).
 *
 * Behaviors exercised (ticket checklist):
 *  a. `tools/pre-execute` deny of write / edit / str_replace_editor, scoped per
 *     agent, exact denial reason reaching the model-facing tool result verbatim,
 *     non-target paths unaffected;
 *  b. same denial via `fs/write-intent` / `fs/edit-intent` (throw FsError):
 *     exact fs-only denial, non-fs tools unaffected, and with BOTH guards active
 *     exactly one denial (no double-deny interaction);
 *  c. waterfall listener ordering semantics with multiple listeners;
 *  d. whether run_code/PTC sub-dispatched tool calls pass through
 *     `tools/pre-execute` (the unresolved research question);
 *  e. built-in cross-session mitigation: stale second-session write gets
 *     `FS_STALE_VERSION` (per-target serialization);
 *  f. bash-command reachability at this tier (expected: heuristic at best).
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolExecutionResult, PreToolDecision } from '@deepseek-ai/dsh-tools'
import WorkerThreadCodeRuntime from '@deepseek-ai/dsh-code-runtime-worker-thread'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import BashLocal from '@deepseek-ai/dsh-bash-local'
import * as shellEnv from '@deepseek-ai/dsh-shell-env'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import * as strReplaceEditor from '@deepseek-ai/dsh-tool-str-replace-editor'
import * as toolBash from '@deepseek-ai/dsh-tool-bash'
import * as observationPolicy from '@deepseek-ai/dsh-fs-observation-policy'

/** The hard-coded probe path every guard denies (created inside the temp workspace). */
const PROBE_BASENAME = 'claims-probe.txt'
/** The actionable denial reason §5.5 tier 2 prescribes — must reach the model verbatim. */
const CLAIM_REASON = 'path held by task MT-2; ask the orchestrator or claim a different path'
/** The fs-intent denial reason (fs/write-intent + fs/edit-intent guard). */
const FS_CLAIM_REASON = 'fs/write-intent: path held by task MT-2; ask the orchestrator or claim a different path'
/** Task ids double as agent/session ids and guard ownership labels. */
const GUARDED_TASK = 'mt2-claims-spike-writer'
const UNGUARDED_TASK = 'mt3-claims-spike-writer'

/** Live observation counters the assertions read instead of the guard's internals. */
interface GuardCounters {
  /** Every `tools/pre-execute` dispatch the guard's listener received. */
  preExecuteSeen: Array<{ name: string; nested: boolean; arguedPath: string | undefined; command: string | undefined }>
  /** Number of `fs/write-intent` dispatches the guard's listener received. */
  writeIntentSeen: number
  /** Number of `fs/edit-intent` dispatches the guard's listener received. */
  editIntentSeen: number
}

function createCounters(): GuardCounters {
  return { preExecuteSeen: [], writeIntentSeen: 0, editIntentSeen: 0 }
}

/** Extract the model-supplied target path from a mutating tool's arguments (write/edit/str_replace_editor shapes). */
function arguedPath(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const candidate = (args as Record<string, unknown>)['file_path'] ?? (args as Record<string, unknown>)['path']
  return typeof candidate === 'string' ? candidate : undefined
}

/** Extract the bash command string, if the call is a shell call. */
function arguedCommand(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const candidate = (args as Record<string, unknown>)['command']
  return typeof candidate === 'string' ? candidate : undefined
}

function isProbePath(candidate: string | undefined, probePath: string): boolean {
  return candidate !== undefined && resolve(candidate) === probePath
}

/**
 * §5.5 tier 2 guard, pre-execute half: deny the probe path on one agent's
 * scoped world via the `tools/pre-execute` waterfall. Registered through
 * `agent.ctx` (inside the real agent-create setup window), so the harness's
 * scope-filtered dispatch routes it for this agent only.
 */
function guardAgentPreExecute(agentCtx: CordisContext, probePath: string, counters: GuardCounters): void {
  agentCtx.on('tools/pre-execute', async (exec, next) => {
    const path = arguedPath(exec.arguments)
    counters.preExecuteSeen.push({ name: exec.name, nested: exec.parent !== undefined, arguedPath: path, command: arguedCommand(exec.arguments) })
    if (isProbePath(path, probePath)) return { kind: 'deny', reason: CLAIM_REASON }
    return next()
  })
}

/**
 * §5.5 tier 2 guard, fs-intent half: throw `FsError` from the
 * `fs/write-intent` / `fs/edit-intent` waterfalls for the probe path. Loaded
 * BEFORE `@deepseek-ai/dsh-fs-observation-policy` so its listeners sit
 * outermost; non-target targets must be forwarded with `next()` so the
 * built-in observed-state policy still decides.
 */
function fsIntentGuardPlugin(probePath: string, counters: GuardCounters): { name: string, apply(ctx: CordisContext): void } {
  return {
    name: 'multitask-claims-fs-intent-guard',
    apply(ctx: CordisContext): void {
      ctx.on('fs/write-intent', async (target, _actor, next) => {
        counters.writeIntentSeen += 1
        if (resolve(target.displayPath) === probePath || String(target.targetKey) === probePath) {
          throw new FsError(FS_CLAIM_REASON, 'FS_PERMISSION_DENIED')
        }
        return next()
      })
      ctx.on('fs/edit-intent', async (target, _actor, next) => {
        counters.editIntentSeen += 1
        if (resolve(target.displayPath) === probePath || String(target.targetKey) === probePath) {
          throw new FsError(FS_CLAIM_REASON, 'FS_PERMISSION_DENIED')
        }
        return next()
      })
    }
  }
}

/** A never-called LLM adapter registration is unnecessary; the loop idles without one. */
interface CompositionOptions {
  /** Load the fs-intent guard plugin (outermost) before the observation policy. */
  fsIntentGuard: boolean
  /** Tools presentation mode: `both` exposes `run_code` alongside native tools. */
  toolsMode: 'native' | 'ptc' | 'both'
}

interface Composition {
  ctx: CordisContext
  workspaceRoot: string
  probePath: string
  counters: GuardCounters
  createAgent(taskId: string, guard: boolean): Promise<AgentHandle>
  execute(agent: Agent, name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
  dispose(): Promise<void>
}

/**
 * Compose the REAL harness stack in-process from installed packages:
 * cordis kernel + system-prompt + session store/projections + sandbox policy +
 * sandboxed local filesystem + agents + agent-loop factory + tool registry +
 * worker-thread code runtime + bash tooling + fs tool suite +
 * str_replace_editor + observation policy + (optional) spike guard.
 */
async function compose(options: CompositionOptions): Promise<Composition> {
  const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'multitask-claims-spike-')))
  const probePath = join(workspaceRoot, PROBE_BASENAME)
  const counters = createCounters()
  const ctx = new Context()

  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot })
  await ctx.plugin(SandboxedFileSystem, { cwd: workspaceRoot })
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ToolRuntime, { mode: options.toolsMode })
  await ctx.plugin(WorkerThreadCodeRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(BashLocal)
  await ctx.plugin(shellEnv)
  await ctx.plugin(toolFs)
  await ctx.plugin(strReplaceEditor)
  await ctx.plugin(toolBash)
  if (options.fsIntentGuard) await ctx.plugin(fsIntentGuardPlugin(probePath, counters))
  await ctx.plugin(observationPolicy)

  const created: AgentHandle[] = []
  return {
    ctx,
    workspaceRoot,
    probePath,
    counters,
    async createAgent(taskId: string, guard: boolean) {
      const handle = await ctx.agents.create({
        sessionId: taskId as unknown as SessionId,
        meta: { cwd: workspaceRoot }
      })
      if (guard) guardAgentPreExecute(handle.agent.ctx, probePath, counters)
      created.push(handle)
      return handle
    },
    async execute(agent: Agent, name: string, args: Record<string, unknown>) {
      return ctx.tools.execute({
        callId: `${name}-${Math.random().toString(36).slice(2)}` as never,
        name,
        arguments: args,
        agent,
        signal: new AbortController().signal
      })
    },
    async dispose() {
      for (const handle of created.splice(0).reverse()) await handle.dispose()
      await ctx.fiber.dispose()
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  }
}

/** The model-facing text of a failed call, exactly as the registry materializes it. */
function errorText(result: ToolExecutionResult): string {
  expect(result.isError).toBe(true)
  const [first] = result.content
  expect(first?.type).toBe('text')
  return first !== undefined && first.type === 'text' ? first.text : ''
}

const pending: Composition[] = []

async function fresh(options: CompositionOptions): Promise<Composition> {
  const composition = await compose(options)
  pending.push(composition)
  return composition
}

afterEach(async () => {
  for (const composition of pending.splice(0).reverse()) await composition.dispose()
})

describe('multitask_claims_spike', () => {
  it('a: pre-execute guard denies write, edit, and str_replace_editor with the reason verbatim; non-target paths unaffected', async () => {
    const spike = await fresh({ fsIntentGuard: false, toolsMode: 'native' })
    const agent = (await spike.createAgent(GUARDED_TASK, true)).agent
    const otherPath = join(spike.workspaceRoot, 'allowed.txt')

    // All three mutating tools hit the guard on the probe path…
    for (const [name, args] of [
      ['write', { file_path: spike.probePath, content: 'denied write\n' }],
      ['edit', { file_path: spike.probePath, old_string: 'x', new_string: 'y' }],
      ['str_replace_editor', { path: spike.probePath, command: 'str_replace', old_str: 'x', new_str: 'y' }]
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await spike.execute(agent, name, args)
      expect(result.isError, `${name} must be denied`).toBe(true)
      expect(result.error?.message, `${name} denial reason must be the guard's exact string`).toBe(CLAIM_REASON)
      // …and the model-facing result carries the reason verbatim (registry envelope: `Error: ` + reason).
      expect(errorText(result)).toBe(`Error: ${CLAIM_REASON}`)
    }
    expect(existsSync(spike.probePath)).toBe(false)

    // The guard is a claims guard, not a general write block: another path sails through.
    const allowed = await spike.execute(agent, 'write', { file_path: otherPath, content: 'allowed\n' })
    expect(allowed.isError).toBe(false)
    expect(readFileSync(otherPath, 'utf8')).toBe('allowed\n')
  })

  it('a: the guard is scoped per agent — an unguarded agent context writes the probe path', async () => {
    const spike = await fresh({ fsIntentGuard: false, toolsMode: 'native' })
    const guarded = (await spike.createAgent(GUARDED_TASK, true)).agent
    const unguarded = (await spike.createAgent(UNGUARDED_TASK, false)).agent // only MT-2 is guarded
    expect((await spike.execute(guarded, 'write', { file_path: spike.probePath, content: 'a\n' })).isError).toBe(true)

    const result = await spike.execute(unguarded, 'write', { file_path: spike.probePath, content: 'from mt3\n' })
    expect(result.isError, 'unguarded agent must be unaffected').toBe(false)
    expect(readFileSync(spike.probePath, 'utf8')).toBe('from mt3\n')
    expect(spike.counters.preExecuteSeen.filter((seen) => seen.name === 'write')).toHaveLength(1)
  })
  it('c: waterfall listener ordering — the OUTERMOST (first-registered) listener wins; it can veto peers by not calling next()', async () => {
    const spike = await fresh({ fsIntentGuard: false, toolsMode: 'native' })
    const agent = (await spike.createAgent(GUARDED_TASK, false)).agent
    const fixture = join(spike.workspaceRoot, 'ordering.txt')
    writeFileSync(fixture, 'ordering fixture\n')
    const calls: string[] = []
    /** Reject reads of non-test tools; record a marker; return `decision` unless asked to forward. */
    const listener = (marker: string, decision: () => PreToolDecision, forward = false) =>
      async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
        if (exec.name !== 'read') return next()
        calls.push(marker)
        if (forward) return next()
        return decision()
      }
    const outerDeny = spike.ctx.on('tools/pre-execute', listener('outer', () => ({ kind: 'deny', reason: 'outer listener denies' })))
    const innerDeny = spike.ctx.on('tools/pre-execute', listener('inner', () => ({ kind: 'deny', reason: 'inner listener denies' })))

    // Phase 1 — outer veto: the inner listener is NEVER consulted, even though both deny.
    const denied = await spike.execute(agent, 'read', { file_path: fixture })
    expect(denied.error?.message).toBe('outer listener denies')
    expect(calls).toEqual(['outer'])

    // Phase 2 — forwarding: an outer listener that returns next() hands the decision inward.
    // (Registered fresh, in order: forward-outer first, inner second.)
    calls.length = 0
    outerDeny()
    innerDeny()
    const outerForward = spike.ctx.on('tools/pre-execute', listener('outer', () => ({ kind: 'allow' as const }), true))
    const innerDeny2 = spike.ctx.on('tools/pre-execute', listener('inner', () => ({ kind: 'deny', reason: 'inner listener denies' })))
    const forwarded = await spike.execute(agent, 'read', { file_path: fixture })
    expect(forwarded.isError).toBe(true)
    expect(forwarded.error?.message).toBe('inner listener denies')
    expect(calls).toEqual(['outer', 'inner'])
    outerForward()
    innerDeny2()

    // Phase 3 — NO deny priority: an outer ALLOW that skips next() vetoes an inner DENY; the call proceeds.
    calls.length = 0
    const outerAllow = spike.ctx.on('tools/pre-execute', listener('outer-allow', () => ({ kind: 'allow' })))
    const innerDeny3 = spike.ctx.on('tools/pre-execute', listener('inner', () => ({ kind: 'deny', reason: 'inner listener denies' })))
    const proceeded = await spike.execute(agent, 'read', { file_path: fixture })
    expect(proceeded.isError, 'outer allow short-circuits the inner deny').toBe(false)
    expect(calls).toEqual(['outer-allow'])
    outerAllow()
    innerDeny3()
  })

  it('b: fs/write-intent + fs/edit-intent denial via FsError is fs-only; non-fs tools unaffected', async () => {
    const spike = await fresh({ fsIntentGuard: true, toolsMode: 'native' })
    writeFileSync(spike.probePath, 'v0\n')
    const agent = (await spike.createAgent(GUARDED_TASK, false)).agent // fs guard only; no pre-execute guard

    const write = await spike.execute(agent, 'write', { file_path: spike.probePath, content: 'denied\n' })
    expect(write.isError).toBe(true)
    expect(write.error?.message).toBe(FS_CLAIM_REASON)
    expect(write.error?.info).toEqual({ name: 'FsError', code: 'FS_PERMISSION_DENIED' })
    expect(errorText(write)).toBe(`Error: ${FS_CLAIM_REASON}`)

    const edit = await spike.execute(agent, 'edit', { file_path: spike.probePath, old_string: 'v0', new_string: 'v1' })
    expect(edit.isError).toBe(true)
    expect(edit.error?.message).toBe(FS_CLAIM_REASON)
    expect(spike.counters.editIntentSeen).toBe(1)

    // The denial is exact: the probe file is untouched.
    expect(readFileSync(spike.probePath, 'utf8')).toBe('v0\n')

    // Non-fs tool: bash dispatches NO fs intent waterfalls and is unaffected.
    const bash = await spike.execute(agent, 'bash', { command: 'echo bash-ran', description: 'non-fs probe' })
    expect(bash.isError).toBe(false)
    expect(spike.counters.writeIntentSeen).toBe(1)
    expect(spike.counters.editIntentSeen).toBe(1)

    // Non-target fs writes still work and reach the built-in observation policy (guard forwards with next()).
    const other = await spike.execute(agent, 'write', { file_path: join(spike.workspaceRoot, 'other.txt'), content: 'ok\n' })
    expect(other.isError).toBe(false)
    expect(spike.counters.writeIntentSeen).toBe(2)
  })

  it('b: with BOTH guards active there is exactly one denial — pre-execute fires first and the fs intent is never dispatched', async () => {
    const spike = await fresh({ fsIntentGuard: true, toolsMode: 'native' })
    writeFileSync(spike.probePath, 'v0\n')
    const agent = (await spike.createAgent(GUARDED_TASK, true)).agent // pre-execute guard AND fs-intent guard

    const result = await spike.execute(agent, 'write', { file_path: spike.probePath, content: 'denied\n' })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toBe(CLAIM_REASON) // the PRE-EXECUTE reason, not the fs one
    expect(errorText(result)).toBe(`Error: ${CLAIM_REASON}`)
    expect(readFileSync(spike.probePath, 'utf8')).toBe('v0\n')
    // The pipeline denied the call before the tool body ran, so the fs waterfall never dispatched.
    expect(spike.counters.writeIntentSeen).toBe(0)
    expect(spike.counters.preExecuteSeen).toEqual([
      { name: 'write', nested: false, arguedPath: spike.probePath, command: undefined }
    ])
  })

  it('d: run_code/PTC sub-dispatched tool calls DO pass through tools/pre-execute — the guard denies inside the program', async () => {
    const spike = await fresh({ fsIntentGuard: false, toolsMode: 'both' })
    const guarded = (await spike.createAgent(GUARDED_TASK, true)).agent
    const unguarded = (await spike.createAgent(UNGUARDED_TASK, false)).agent

    const program = [
      `const probe = ${JSON.stringify(spike.probePath)}`,
      "let outcome",
      "try {",
      "  await tools.write({ file_path: probe, content: 'from ptc\\n' })",
      "  outcome = { denied: false }",
      "} catch (error) {",
      "  outcome = { denied: true, message: error instanceof Error ? error.message : String(error) }",
      "}",
      "return outcome"
    ].join('\n')

    const guardedRun = await spike.execute(guarded, 'run_code', { code: program, description: 'PTC write probe' })
    expect(guardedRun.isError).toBe(false)
    const guardedValue = guardedRun.value as { logs: string[], result: { denied: boolean, message?: string } }
    expect(guardedValue.result.denied).toBe(true)
    expect(guardedValue.result.message).toBe(CLAIM_REASON)
    expect(existsSync(spike.probePath)).toBe(false)
    // Evidence the sub-dispatch crossed the seam: the guard saw the write WITH a parent transport token.
    const subDispatch = spike.counters.preExecuteSeen.find((seen) => seen.name === 'write')
    expect(subDispatch).toEqual({ name: 'write', nested: true, arguedPath: spike.probePath, command: undefined })

    // Scoping survives the transport: the unguarded agent's program write lands.
    const unguardedRun = await spike.execute(unguarded, 'run_code', { code: program, description: 'PTC write probe' })
    expect(unguardedRun.isError).toBe(false)
    const unguardedValue = unguardedRun.value as { logs: string[], result: { denied: boolean } }
    expect(unguardedValue.result.denied).toBe(false)
    expect(readFileSync(spike.probePath, 'utf8')).toBe('from ptc\n')
  })

  it('e: built-in cross-session mitigation — the stale second session gets FS_STALE_VERSION, and the first write survives', async () => {
    const spike = await fresh({ fsIntentGuard: false, toolsMode: 'native' })
    writeFileSync(spike.probePath, 'v0-content\n')
    const sessionA = (await spike.createAgent(`${GUARDED_TASK}-a`, false)).agent
    const sessionB = (await spike.createAgent(`${GUARDED_TASK}-b`, false)).agent

    // Both sessions observe the same baseline version through the real read tool.
    expect((await spike.execute(sessionA, 'read', { file_path: spike.probePath })).isError).toBe(false)
    expect((await spike.execute(sessionB, 'read', { file_path: spike.probePath })).isError).toBe(false)

    // Session A writes first and wins.
    const firstWrite = await spike.execute(sessionA, 'write', { file_path: spike.probePath, content: 'session A wrote this\n' })
    expect(firstWrite.isError).toBe(false)

    // Session B's write is based on the pre-A version: the built-in CAS rejects it.
    const staleWrite = await spike.execute(sessionB, 'write', { file_path: spike.probePath, content: 'session B stale write\n' })
    expect(staleWrite.isError).toBe(true)
    expect(staleWrite.error?.info?.code).toBe('FS_STALE_VERSION')
    expect(staleWrite.error?.message).toContain('file changed since it was read')
    expect(staleWrite.error?.message).toContain('re-read the file, then retry')

    // Per-target serialization: the loser never tore the winner's content.
    expect(readFileSync(spike.probePath, 'utf8')).toBe('session A wrote this\n')

    // After re-reading (fresh observation) session B can write — the CAS is a freshness gate, not a claim.
    expect((await spike.execute(sessionB, 'read', { file_path: spike.probePath })).isError).toBe(false)
    const retry = await spike.execute(sessionB, 'write', { file_path: spike.probePath, content: 'session B after re-read\n' })
    expect(retry.isError).toBe(false)
    expect(readFileSync(spike.probePath, 'utf8')).toBe('session B after re-read\n')
  })

  it('f: bash writing the claimed path is NOT catchable at this tier — both seams are blind; string sniffing is the only (evadable) heuristic', async () => {
    const spike = await fresh({ fsIntentGuard: true, toolsMode: 'native' })
    writeFileSync(spike.probePath, 'before-bash\n')
    const agent = (await spike.createAgent(GUARDED_TASK, true)).agent // strongest config: both guards

    // (1) Literal path: the command SUCCEEDS and the write lands — neither seam fires for the inner write.
    const literalCommand = `printf 'bash-literal-write\\n' > ${JSON.stringify(spike.probePath)}`
    const literal = await spike.execute(agent, 'bash', {
      command: literalCommand,
      description: 'bash literal write to claimed path'
    })
    expect(literal.isError, 'bash bypasses both seams at this tier').toBe(false)
    expect(readFileSync(spike.probePath, 'utf8')).toBe('bash-literal-write\n')
    const bashEntry = spike.counters.preExecuteSeen.find((seen) => seen.name === 'bash')
    expect(bashEntry, 'pre-execute DID see the bash tool call itself').toBeDefined()
    expect(bashEntry?.arguedPath, '…but the arguments expose no file_path/path to a structural guard').toBeUndefined()
    expect(bashEntry?.command).toBe(literalCommand)
    expect(spike.counters.writeIntentSeen, 'the fs-intent waterfall never dispatched for the shell write').toBe(0)

    // (2) The only visibility is heuristic string sniffing — and it is trivially evaded.
    writeFileSync(spike.probePath, 'before-obfuscated\n')
    const obfuscatedCommand = `cd ${JSON.stringify(spike.workspaceRoot)} && printf 'bash-obfuscated-write\\n' > "$(printf claims)-probe.txt"`
    const obfuscated = await spike.execute(agent, 'bash', {
      command: obfuscatedCommand,
      description: 'bash assembled write to claimed path'
    })
    expect(obfuscated.isError).toBe(false)
    const obfuscatedEntry = spike.counters.preExecuteSeen.find((seen) => seen.name === 'bash' && seen.command === obfuscatedCommand)
    expect(obfuscatedEntry).toBeDefined()
    // The assembled command never spells the probe path: the pieces are concatenated at runtime.
    expect(obfuscatedCommand).not.toContain(spike.probePath)
    expect(readFileSync(spike.probePath, 'utf8')).toBe('bash-obfuscated-write\n')
  })

  it('dev lane: the committed guard plugin module — the exact artifact the dev-app overlay mounts — denies a real write through the real pipeline', async () => {
    const spike = await fresh({ fsIntentGuard: false, toolsMode: 'native' })
    const logLines: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      logLines.push(parts.map(String).join(' '))
    })

    // Mount the plugin EXACTLY as the dev profile overlay row would: the loader
    // imports the module and calls apply(ctx, config) on the harness root.
    const guard = (await import(new URL('./multitask-claims-guard.mjs', import.meta.url).href)) as {
      name: string
      apply(ctx: CordisContext, config?: { probePath?: string }): void
    }
    expect(guard.name).toBe('multitask-claims-guard')
    guard.apply(spike.ctx, { probePath: spike.probePath })
    expect(logLines.some((line) => line.includes('[multitask-claims-guard] mounted')), 'plugin mounted into the real composition').toBe(true)

    const agent = (await spike.createAgent('dev-lane-agent', false)).agent // no in-test guard: the module IS the guard

    // The denial surfaces on BOTH model-visible channels: the structured error
    // and the tool-result content text the model loop feeds back verbatim.
    const denied = await spike.execute(agent, 'write', { file_path: spike.probePath, content: 'dev lane attempt\n' })
    expect(denied.isError).toBe(true)
    expect(denied.error?.message).toBe(CLAIM_REASON)
    expect(errorText(denied)).toBe(`Error: ${CLAIM_REASON}`)
    expect(existsSync(spike.probePath)).toBe(false)
    expect(logLines.some((line) => line.includes('[multitask-claims-guard] pre-execute deny #1 tool=write'))).toBe(true)

    // The same module also covers str_replace_editor and stays path-exact.
    const srDenied = await spike.execute(agent, 'str_replace_editor', { path: spike.probePath, command: 'view' })
    expect(srDenied.isError).toBe(true)
    expect(srDenied.error?.message).toBe(CLAIM_REASON)

    const allowedPath = join(spike.workspaceRoot, 'dev-lane-allowed.txt')
    const allowed = await spike.execute(agent, 'write', { file_path: allowedPath, content: 'fine\n' })
    expect(allowed.isError).toBe(false)
    expect(readFileSync(allowedPath, 'utf8')).toBe('fine\n')
    logSpy.mockRestore()
  })

  it('dev lane: the committed guard module’s fs-intent listeners throw the FsError identity (FS_PERMISSION_DENIED), not a plain Error', async () => {
    // The module's fs-intent half cannot fire inside a full composition that
    // also mounts its pre-execute half (the pre-execute deny short-circuits
    // before the fs waterfall dispatches — behavior b), so the identity is
    // asserted on the real cordis waterfall directly, with the exact
    // dispatch shape dsh-tool-fs uses (lib/index.js:650 write / :801 edit):
    // ctx.waterfall(event, target, actor, innerDefault).
    const probePath = '/tmp/multitask-claims-guard-fs-intent-probe.txt'
    const ctx = new Context()
    try {
      const guard = (await import(new URL('./multitask-claims-guard.mjs', import.meta.url).href)) as {
        name: string
        apply(ctx: CordisContext, config?: { probePath?: string }): void
      }
      guard.apply(ctx, { probePath })

      const writeTarget = { targetKey: FsTargetKey(probePath), displayPath: probePath }
      const writeRejection: unknown = await ctx
        .waterfall('fs/write-intent', writeTarget, undefined, () => undefined)
        .then(() => null, (error: unknown) => error)
      expect(writeRejection, 'fs/write-intent must reject').toBeInstanceOf(FsError)
      const writeError = writeRejection as FsError
      expect(writeError.name).toBe('FsError')
      expect(writeError.code).toBe('FS_PERMISSION_DENIED')
      expect(writeError.message).toBe(`fs/write-intent: ${CLAIM_REASON}`)

      const editTarget = { targetKey: FsTargetKey(probePath), displayPath: probePath }
      const editRejection: unknown = await ctx
        .waterfall('fs/edit-intent', editTarget, undefined, () => undefined)
        .then(() => null, (error: unknown) => error)
      expect(editRejection, 'fs/edit-intent must reject').toBeInstanceOf(FsError)
      expect((editRejection as FsError).code).toBe('FS_PERMISSION_DENIED')
      expect((editRejection as FsError).message).toBe(`fs/edit-intent: ${CLAIM_REASON}`)

      // A non-target path is forwarded with next(): the inner default decides
      // (the same `() => void 0` default dsh-tool-fs dispatches with), so the
      // abstention flows through as "no denial".
      const otherKey = FsTargetKey('/tmp/mt-claims-other.txt')
      const other = await ctx.waterfall(
        'fs/write-intent',
        { targetKey: otherKey, displayPath: '/tmp/mt-claims-other.txt' },
        undefined,
        () => undefined
      )
      expect(other).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
