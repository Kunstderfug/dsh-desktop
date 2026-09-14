/**
 * [multitask] issue #12 — hardening: resume/fork, failure, abuse, mobile.
 *
 * Configured composition at the frozen public seam selected by
 * `multitask_hardening_gate`: permanent host + client plugins, command
 * runtime, session persistence and log fold, claims, researcher and writer
 * spawn, guardrails, round-driver, task-card surfaces, and the
 * paired-phone/narrow text representation. Only model decisions, child
 * settlement, kill, and restart/fold are scripted.
 *
 * These regressions observe full history — writer-session kill plus mid-task
 * restart, researcher retry-once then a visible failure card, writer-failure
 * claim release, rapid `/multitask`, instant-settle, cap conflict,
 * cancel-`keepInbox`, approval `never`, and narrow failure text — not an
 * isolated fold helper or a final-state snapshot.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Commands from '@deepseek-ai/dsh-commands'
import {
  createUserMessage,
  type GenerateOptions,
  LlmAdapter,
  LlmRuntime,
  type StreamChunk,
  ToolCallId
} from '@deepseek-ai/dsh-llm'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as subagentSpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as toolSubagent from '@deepseek-ai/dsh-tool-subagent'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as multitask from '../packages/dsh-multitask/index.js'
import * as researcher from '../packages/dsh-multitask/researcher.js'

const DENIED_TOOLS = ['write', 'edit', 'str_replace_editor'] as const
const RESEARCHER_LABEL = 'researcher'
const STRUCTURED_REPORT = [
  'Goal: harden the composed multitask matrix',
  'Affected paths: packages/dsh-multitask/index.js',
  'Implementation plan: retry once, release claims, keep inbox',
  'Risks: hidden failure and leaked dead-owner claims',
  'Recommended claim set: packages/dsh-multitask/index.js'
].join('\n')

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type ScriptedCall = { model: string, request: GenerateOptions }
type ScriptedResponse = string | Iterable<StreamChunk> | AsyncIterable<StreamChunk>

class ScriptedAdapter extends LlmAdapter {
  constructor(
    private readonly respond: (call: ScriptedCall) => Promise<ScriptedResponse>
  ) {
    super()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const result = await this.respond({ model: options.model, request: options })
    if (typeof result !== 'string') {
      yield* result
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: result }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: result } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface FixtureOptions {
  respond?: (call: ScriptedCall) => Promise<ScriptedResponse>
  home?: string
  detached?: boolean
  maxWriters?: number
  maxConsecutiveWakes?: number
  enabled?: boolean
  sessionId?: string
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
}

interface CoreNamed {
  name: string
  dispose: () => Promise<void>
}

interface Fixture {
  ctx: Context
  home: string
  calls: ScriptedCall[]
  agent: Agent
  cores: CoreNamed[]
  disposeAll(): Promise<void>
  disposeCoreSkipping(skip: string[]): Promise<void>
}

function loadClient() {
  const source = readFileSync(path.join(process.cwd(), 'packages/dsh-multitask-client/client.js'), 'utf8')
  let definition: { factory: (require: (id: string) => unknown) => {
    foldTasks: (events: Array<Record<string, unknown>>) => Array<Record<string, unknown>>
    formatTaskCardText: (task: Record<string, unknown>) => string
  } } | undefined
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load: (value: typeof definition) => {
          definition = value
        }
      }
    }
  })
  return definition!.factory((id: string) => {
    if (id === 'react') {
      return {
        createElement: () => ({}),
        useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
        useEffect: () => {},
        useMemo: (factory: () => unknown) => factory(),
        useState: (initial: unknown) => [initial, () => {}],
        memo: (component: unknown) => component
      }
    }
    throw new Error(`unexpected client require ${id}`)
  })
}

function foldCard(agent: Agent, taskId: string) {
  const plugin = loadClient()
  const folded = plugin.foldTasks(agent.session.snapshotEvents() as unknown as Array<Record<string, unknown>>)
  const task = folded.find(row => row.id === taskId)
  if (task === undefined) throw new Error(`fold is missing task ${taskId}`)
  return { task, text: plugin.formatTaskCardText(task) }
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const home = options.home ?? await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-hardening-'))
  if (options.home === undefined && options.detached !== true) {
    cleanups.push(() => rm(home, { recursive: true, force: true }))
  }
  await mkdir(path.join(home, 'src'), { recursive: true })
  const ctx = new Context()
  const cores: CoreNamed[] = []
  const push = (name: string, dispose: () => Promise<void> | void) => {
    let settled: Promise<void> | undefined
    const once = async () => {
      settled ??= Promise.resolve().then(() => dispose())
      await settled
    }
    cores.push({ name, dispose: once })
    if (options.detached !== true) cleanups.push(once)
  }

  const prompt = await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  push('prompt', () => prompt.dispose())
  const projections = await ctx.plugin(SessionProjectionRegistry)
  push('projections', () => projections.dispose())
  const sandbox = await ctx.plugin(SandboxPolicyService, {
    mode: options.sandboxMode ?? 'workspace-write',
    workspaceRoot: home
  })
  push('sandbox', () => (sandbox as { dispose(): Promise<void> }).dispose())
  const approval = await ctx.plugin(ApprovalService)
  push('approval', () => (approval as { dispose(): Promise<void> }).dispose())
  const sessions = await ctx.plugin(SessionStore)
  push('sessions', () => sessions.dispose())
  const tools = await ctx.plugin(ToolRuntime)
  push('tools', () => tools.dispose())
  const llm = await ctx.plugin(LlmRuntime)
  push('llm', () => llm.dispose())
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: home })
  push('persistence', () => persistence.dispose())
  const registry = await ctx.plugin(AgentRegistry)
  push('registry', () => registry.dispose())
  const commands = await ctx.plugin(Commands)
  push('commands', () => commands.dispose())
  registerMutationTools(ctx)

  const calls: ScriptedCall[] = []
  const adapter = await ctx.plugin({
    inject: ['llm'],
    apply(pluginCtx: Context) {
      pluginCtx.llm.registerAdapter(['scripted'], new ScriptedAdapter(async (call) => {
        calls.push(call)
        return options.respond?.(call) ?? defaultRespond(call)
      }))
    }
  })
  push('adapter', () => adapter.dispose())
  const loop = await ctx.plugin(AgentLoop)
  push('loop', () => loop.dispose())
  const subagents = await ctx.plugin(SubagentRuntime)
  push('subagents', () => (subagents as { dispose(): Promise<void> }).dispose())
  const spawn = await ctx.plugin(subagentSpawnInProcess as unknown as Parameters<Context['plugin']>[0])
  push('spawn', () => spawn.dispose())
  const query = await ctx.plugin(SessionQueryEngine as unknown as new (ctx: Context) => SessionQueryEngine)
  push('query', () => query.dispose())
  const mounted = await ctx.plugin(
    multitask as unknown as Parameters<Context['plugin']>[0],
    {
      enabled: options.enabled ?? true,
      maxWriters: options.maxWriters,
      maxConsecutiveWakes: options.maxConsecutiveWakes ?? 2
    }
  )
  push('multitask', () => mounted.dispose())
  const writers = await ctx.plugin(toolSubagent as unknown as Parameters<Context['plugin']>[0], {
    provider: 'spawn',
    backgroundMode: 'continuable'
  })
  push('writers', () => (writers as { dispose(): Promise<void> }).dispose())

  const handle = await ctx.agents.create({
    sessionId: SessionId(options.sessionId ?? 'session-1'),
    meta: { cwd: home },
    agentOptions: { provider: 'scripted', model: 'orchestrator' }
  })
  push('agent', () => handle.dispose())
  setSandboxMode(handle.agent.session, options.sandboxMode ?? 'workspace-write')

  async function disposeAll() {
    for (const core of [...cores].reverse()) await core.dispose()
  }

  async function disposeCoreSkipping(skip: string[]) {
    for (const core of [...cores].reverse()) {
      if (skip.includes(core.name)) continue
      await core.dispose()
    }
  }

  return { ctx, home, calls, agent: handle.agent, cores, disposeAll, disposeCoreSkipping }
}

function registerMutationTools(ctx: Context): void {
  for (const name of DENIED_TOOLS) {
    ctx.tools.register(defineTool({
      name,
      description: `${name} mutation probe`,
      parameters: {
        file_path: { type: 'string', required: true, description: 'probe path' },
        content: { type: 'string', required: true, description: 'probe contents' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { path: { type: 'string', required: true } }
        },
        render: (_args, value) => [{ type: 'text', text: `wrote ${value.path}` }]
      },
      async execute(args) {
        return { path: args.file_path }
      }
    }))
  }
}

function defaultRespond(call: ScriptedCall): string {
  return isResearcherCall(call) ? STRUCTURED_REPORT : `parent ack: ${userText(call.request).slice(0, 80)}`
}

function isResearcherCall(call: ScriptedCall): boolean {
  const text = userText(call.request)
  return text.includes('do not modify files')
    || text.includes('Recommended claim set')
    || text.includes('structured research report')
}

function isWriterCall(call: ScriptedCall, token: string): boolean {
  return userText(call.request).includes(token)
}

function userText(request: GenerateOptions): string {
  return request.messages
    .filter(message => message.role === 'user')
    .map(message => message.content.map(block => block.type === 'text' ? block.text : `<${block.type}>`).join(''))
    .join('\n')
}

function researchEvents(agent: Agent): Array<Record<string, unknown>> {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'multitask/research')
    .map(event => event.data as Record<string, unknown>)
}

function taskEvents(agent: Agent): Array<Record<string, unknown>> {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'multitask/task')
    .map(event => event.data as Record<string, unknown>)
}

function phaseEvents(agent: Agent): Array<Record<string, unknown>> {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'multitask/phase')
    .map(event => event.data as Record<string, unknown>)
}

function claimEvents(agent: Agent): Array<Record<string, unknown>> {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'multitask/claims')
    .map(event => event.data as Record<string, unknown>)
}

function liveClaims(agent: Agent): Array<Record<string, unknown>> {
  const table = new Map<string, Record<string, unknown>>()
  for (const event of claimEvents(agent)) {
    const key = String(event.path)
    if (event.state === 'released') table.delete(key)
    else table.set(key, event)
  }
  return [...table.values()]
}

function modeView(ctx: Context, agent: Agent) {
  const snapshot = ctx.sessionProjections.snapshot(agent.session, ['multitask-mode'])
  const value = snapshot.values['multitask-mode']
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  const view = value as { active?: unknown, openTasks?: unknown }
  if (typeof view.active !== 'boolean' || !Array.isArray(view.openTasks)) return undefined
  return {
    active: view.active,
    openTasks: view.openTasks.map(id => String(id))
  }
}

function queuedHandoffs(agent: Agent) {
  return [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
    .filter(message => message.source?.kind === 'multitask')
}

function admittedHandoffs(agent: Agent) {
  return agent.session.deriveMessages().filter(message => message.source.kind === 'multitask')
}

function parseCapReason(result: { isError?: boolean, error?: { message?: string }, content?: Array<{ type: string, text?: string }> }): Record<string, unknown> {
  const text = [
    result.error?.message ?? '',
    ...(result.content ?? []).map(block => block.text ?? '')
  ].join('\n')
  const match = text.match(/\{[^{}]*"code"\s*:\s*"WRITER_CAP"[^{}]*\}/u)
  if (match === null) {
    throw new Error(`structured WRITER_CAP reason missing from ${JSON.stringify(text)}`)
  }
  return JSON.parse(match[0]) as Record<string, unknown>
}

function gate(): { promise: Promise<void>, open: () => void } {
  let open: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open: open! }
}

async function holdUntil(signal: AbortSignal | undefined, held: Promise<void>): Promise<void> {
  const reason = () => (signal?.reason instanceof Error ? signal.reason : new Error('scripted model call aborted'))
  if (signal?.aborted) throw reason()
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(reason())
    signal?.addEventListener('abort', onAbort, { once: true })
    held.then(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, reject)
  })
}

async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function runCommand(ctx: Context, agent: Agent, line: string) {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (execution === undefined) throw new Error(`command ${line} was not executed`)
  return execution
}

async function runSubagent(ctx: Context, agent: Agent, description: string, prompt: string) {
  return ctx.tools.execute({
    callId: ToolCallId(`subagent-${Math.random().toString(16).slice(2)}`),
    name: 'subagent',
    arguments: { description, prompt, run_in_background: true },
    agent,
    signal: new AbortController().signal
  })
}

async function runTool(ctx: Context, agent: Agent, name: string, args: Record<string, unknown>) {
  return ctx.tools.execute({
    callId: ToolCallId(`${name}-${Math.random().toString(16).slice(2)}`),
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal
  })
}

async function liveWriterIds(ctx: Context, agent: Agent): Promise<string[]> {
  const descendants = await ctx.subagents.listDescendants(agent.session.id)
  return descendants
    .filter(entry => entry.kind === 'child' && entry.activity === 'running' && entry.label !== RESEARCHER_LABEL)
    .map(entry => String(entry.id))
}

function childIdOf(result: { value?: unknown }) {
  const value = result.value as { subagentId?: string, childId?: string } | undefined
  return String(value?.subagentId ?? value?.childId ?? '')
}

describe('multitask_hardening_gate researcher retry-once', () => {
  it('retries a failed researcher once, keeps the first failure, then shows a failure card', { timeout: 30_000 }, async () => {
    expect(researcher.RESEARCH_RETRY_LIMIT).toBe(1)
    let researcherCalls = 0
    const f = await fixture({
      respond: async (call) => {
        if (!isResearcherCall(call)) return 'parent ack'
        researcherCalls += 1
        throw new Error(`scripted researcher failure ${researcherCalls}`)
      }
    })

    await runCommand(f.ctx, f.agent, '/multitask retry the researcher once')
    await waitFor(() => researchEvents(f.agent).some(event => event.phase === 'research-failed'), 'first researcher failure')
    expect(researcher.shouldRetryResearch(f.agent.session, 'MT-1')).toBe(true)

    await waitFor(() => researchEvents(f.agent).filter(event => event.phase === 'researching').length === 2, 'orchestrator retry launch')
    await waitFor(() => researchEvents(f.agent).filter(event => event.phase === 'research-failed').length === 2, 'retry exhausted')
    expect(researcher.shouldRetryResearch(f.agent.session, 'MT-1')).toBe(false)
    expect(researchEvents(f.agent).filter(event => event.phase === 'researching')).toHaveLength(2)
    expect(researcherCalls).toBe(2)

    const firstFailure = researchEvents(f.agent).find(event => event.phase === 'research-failed')
    expect(firstFailure?.stopReason).toBe('error')
    expect(phaseEvents(f.agent).some(event => event.id === 'MT-1' && event.phase === 'failed')).toBe(true)

    const card = foldCard(f.agent, 'MT-1')
    expect(card.task.failed).toBe(true)
    expect(card.task.phase).toBe('failed')
    expect(card.text).toContain('MT-1')
    expect(card.text).toMatch(/fail/i)
    expect(card.text).toMatch(/retry/i)
  })
})

describe('multitask_hardening_gate writer failure', () => {
  it('releases the dead writer claims and publishes a failure card', { timeout: 30_000 }, async () => {
    const hold = gate()
    const f = await fixture({
      respond: async (call) => {
        if (isWriterCall(call, 'writer will fail')) {
          await holdUntil(call.request.signal, hold.promise)
          throw new Error('scripted writer transport failure')
        }
        return defaultRespond(call)
      }
    })

    await runCommand(f.ctx, f.agent, '/multitask writer failure card')
    await waitFor(() => researchEvents(f.agent).some(event => event.phase === 'researched'), 'researcher settled')
    const started = await runSubagent(f.ctx, f.agent, 'writer-fail', 'writer will fail after claiming')
    expect(started.isError).toBe(false)
    const writerId = childIdOf(started)
    await waitFor(() => f.ctx.agents.get(SessionId(writerId)) !== undefined, 'live writer')
    const writer = f.ctx.agents.get(SessionId(writerId))!
    const claimed = await runTool(f.ctx, writer, 'claim_files', { paths: ['src/writer-fail.ts'], taskId: 'MT-1' })
    expect(claimed.isError).toBe(false)
    expect(liveClaims(f.agent).some(claim => claim.path === 'src/writer-fail.ts' && claim.ownerSessionId === writerId)).toBe(true)

    hold.open()
    await waitFor(() => liveClaims(f.agent).every(claim => claim.ownerSessionId !== writerId), 'writer claims released')
    await waitFor(() => phaseEvents(f.agent).some(event => event.id === 'MT-1' && event.phase === 'failed'), 'writer failure phase')

    const card = foldCard(f.agent, 'MT-1')
    expect(card.task.failed).toBe(true)
    expect(card.text).toContain('MT-1')
    expect(card.text).toMatch(/fail/i)
    expect(card.text).toMatch(/claim/i)
  })
})

describe('multitask_hardening_gate kill and restart fold', () => {
  it('restores one folded task/mode/claim view after writer kill and mid-task restart', { timeout: 30_000 }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-hardening-restart-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const hold = gate()
    {
      const f = await fixture({
        home,
        detached: true,
        sessionId: 'session-1',
        respond: async (call) => {
          if (isWriterCall(call, 'writer stays live across kill')) {
            await holdUntil(call.request.signal, hold.promise)
            return 'writer completed after restart'
          }
          return defaultRespond(call)
        }
      })
      await runCommand(f.ctx, f.agent, '/multitask survive kill and restart')
      await waitFor(() => researchEvents(f.agent).some(event => event.phase === 'researched'), 'researcher settled before kill')
      await waitFor(() => f.agent.session.snapshotEvents().some(event =>
        event.type === 'multitask/mode' && event.data?.active === true
      ), 'orchestrator mode committed before kill')
      const started = await runSubagent(f.ctx, f.agent, 'writer-kill', 'writer stays live across kill')
      expect(started.isError).toBe(false)
      const writerId = childIdOf(started)
      await waitFor(() => f.ctx.agents.get(SessionId(writerId)) !== undefined, 'live writer before kill')
      const writer = f.ctx.agents.get(SessionId(writerId))!
      const claimed = await runTool(f.ctx, writer, 'claim_files', { paths: ['src/dead-owner.ts'], taskId: 'MT-1' })
      expect(claimed.isError).toBe(false)
      expect(taskEvents(f.agent).map(event => event.id)).toEqual(['MT-1'])
      expect(modeView(f.ctx, f.agent)).toEqual(expect.objectContaining({
        active: true,
        openTasks: expect.arrayContaining(['MT-1'])
      }))
      await f.disposeCoreSkipping(['loop', 'registry', 'sessions', 'projections', 'prompt', 'tools', 'llm'])
    }

    const resumed = await fixture({ home, sessionId: 'session-resume-unused' })
    const handle = await resumed.ctx.agents.resume({
      resumeSessionId: SessionId('session-1'),
      agentOptions: { provider: 'scripted', model: 'orchestrator' }
    })
    cleanups.push(() => handle.dispose())
    const parent = handle.agent
    expect(taskEvents(parent).map(event => event.id)).toEqual(['MT-1'])
    expect(taskEvents(parent).filter(event => event.id === 'MT-1')).toHaveLength(1)
    await waitFor(() => liveClaims(parent).every(claim => claim.path !== 'src/dead-owner.ts'), 'dead-owner claim expired')
    expect(liveClaims(parent).some(claim => claim.ownerSessionId && String(claim.path).includes('dead-owner'))).toBe(false)
    const view = modeView(resumed.ctx, parent)
    expect(view).toEqual(expect.objectContaining({
      active: true,
      openTasks: ['MT-1']
    }))
    const next = await runCommand(resumed.ctx, parent, '/multitask continue after restart')
    expect(String(next.result?.text ?? '')).toContain('MT-2')
    expect(taskEvents(parent).map(event => event.id)).toEqual(['MT-1', 'MT-2'])
  })
})

describe('multitask_hardening_gate abuse and cancel', () => {
  it('keeps unique tasks, inbox, cap refusal, and the shared wake bound', { timeout: 30_000 }, async () => {
    const parentHold = gate()
    const holdA = gate()
    const holdB = gate()
    const f = await fixture({
      maxWriters: 2,
      maxConsecutiveWakes: 2,
      respond: async (call) => {
        if (isWriterCall(call, 'writer A stays live')) {
          await holdUntil(call.request.signal, holdA.promise)
          return 'writer A completed'
        }
        if (isWriterCall(call, 'writer B stays live')) {
          await holdUntil(call.request.signal, holdB.promise)
          return 'writer B completed'
        }
        if (!isResearcherCall(call) && userText(call.request).includes('task A stays busy')) {
          await holdUntil(call.request.signal, parentHold.promise)
          return 'task A still running'
        }
        return defaultRespond(call)
      }
    })

    f.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'task A stays busy' }],
      source: { kind: 'user' }
    }))
    await waitFor(() => f.calls.some(call => userText(call.request).includes('task A stays busy')), 'held parent turn')

    const first = await runCommand(f.ctx, f.agent, '/multitask rapid one')
    const second = await runCommand(f.ctx, f.agent, '/multitask rapid two')
    const third = await runCommand(f.ctx, f.agent, '/multitask rapid three')
    expect(String(first.result?.text ?? '')).toContain('MT-1')
    expect(String(second.result?.text ?? '')).toContain('MT-2')
    expect(String(third.result?.text ?? '')).toContain('MT-3')
    const ids = taskEvents(f.agent).map(event => String(event.id))
    expect(new Set(ids).size).toBe(ids.length)

    const inboxBeforeCancel = [...f.agent.inbox.nextTurn, ...f.agent.inbox.nextStep]
    expect(inboxBeforeCancel.some(message => message.source?.kind === 'multitask')).toBe(true)
    f.agent.cancel({ kind: 'user' }, { keepInbox: true })
    await f.agent.whenIdle()
    const inboxAfterCancel = [...f.agent.inbox.nextTurn, ...f.agent.inbox.nextStep]
    expect(inboxAfterCancel.some(message => message.source?.kind === 'multitask')).toBe(true)
    parentHold.open()
    await f.agent.whenIdle()

    const writerA = await runSubagent(f.ctx, f.agent, 'writer-a', 'writer A stays live under cap')
    const writerB = await runSubagent(f.ctx, f.agent, 'writer-b', 'writer B stays live under cap')
    expect(writerA.isError).toBe(false)
    expect(writerB.isError).toBe(false)
    await waitFor(async () => (await liveWriterIds(f.ctx, f.agent)).length >= 2, 'two live writers')
    const refused = await runSubagent(f.ctx, f.agent, 'writer-c', 'writer C should hit the cap')
    expect(refused.isError).toBe(true)
    const refusal = parseCapReason(refused)
    expect(refusal.code).toBe('WRITER_CAP')
    holdA.open()
    holdB.open()
    await f.agent.whenIdle()
  })

  it('does not let instant-settling children exceed the shared wake bound', { timeout: 30_000 }, async () => {
    const f = await fixture({ maxConsecutiveWakes: 2 })
    await runCommand(f.ctx, f.agent, '/multitask bound instant settlers')
    await waitFor(() => researchEvents(f.agent).some(event => event.phase === 'researched'), 'first researcher settled')
    await waitFor(() => admittedHandoffs(f.agent).length >= 1, 'command handoff admitted')
    await f.agent.whenIdle()
    for (const label of ['settle-2', 'settle-3']) {
      await f.ctx.subagents.startContinuable({
        provider: 'spawn',
        label,
        request: {
          prompt: [{ type: 'text', text: `do not modify files\nRecommended claim set\nstructured research report ${label}` }],
          parent: f.agent,
          persona: RESEARCHER_LABEL,
          toolFilter: { deny: [...DENIED_TOOLS] }
        },
        signal: new AbortController().signal
      })
    }
    await f.agent.whenIdle()
    const afterSettlements = admittedHandoffs(f.agent).length
    expect(afterSettlements).toBe(2)
    await f.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'settle-over-bound',
      request: {
        prompt: [{ type: 'text', text: 'do not modify files\nRecommended claim set\nstructured research report over bound' }],
        parent: f.agent,
        persona: RESEARCHER_LABEL,
        toolFilter: { deny: [...DENIED_TOOLS] }
      },
      signal: new AbortController().signal
    })
    await f.agent.whenIdle()
    expect(admittedHandoffs(f.agent).length).toBe(afterSettlements)
  })
})

describe('multitask_hardening_gate approval and narrow surface', () => {
  it('pins writer approval never, inherits sandbox, and names the failure on narrow text', { timeout: 30_000 }, async () => {
    const hold = gate()
    const f = await fixture({
      sandboxMode: 'workspace-write',
      respond: async (call) => {
        if (isWriterCall(call, 'writer reviews the diff')) {
          await holdUntil(call.request.signal, hold.promise)
          return 'writer diff handoff ready'
        }
        return defaultRespond(call)
      }
    })
    await runCommand(f.ctx, f.agent, '/multitask pin writer approval')
    await waitFor(() => researchEvents(f.agent).some(event => event.phase === 'researched'), 'researcher settled')
    const started = await runSubagent(f.ctx, f.agent, 'writer-approval', 'writer reviews the diff')
    expect(started.isError).toBe(false)
    const writerId = childIdOf(started)
    await waitFor(() => f.ctx.agents.get(SessionId(writerId)) !== undefined, 'live writer for approval')
    const writer = f.ctx.agents.get(SessionId(writerId))!
    const events = writer.session.snapshotEvents()
    expect(events.some(event => event.type === 'approval/policy' && event.data?.policy === 'never' && event.data?.source === 'delegation')).toBe(true)
    expect(events.some(event => event.type === 'sandbox/mode' && event.data?.mode === 'workspace-write' && event.data?.source === 'delegation')).toBe(true)
    expect(events.some(event => event.type === 'approval/asked')).toBe(false)

    const claimed = await runTool(f.ctx, writer, 'claim_files', { paths: ['src/handoff.ts'], taskId: 'MT-1' })
    expect(claimed.isError).toBe(false)
    hold.open()
    await waitFor(() => f.agent.session.deriveMessages().some(message =>
      message.source.kind === 'subagent-settled'
      && message.content.some(block => block.type === 'text' && block.text.includes('diff handoff'))
    ), 'orchestrator reviewed the writer diff handoff')

    f.agent.session.append('multitask/phase', {
      id: 'MT-1',
      objective: 'pin writer approval',
      phase: 'failed',
      createdAt: new Date().toISOString(),
      note: 'Writer failed. Claims were released. Review the diff handoff or retry the task.'
    })
    const card = foldCard(f.agent, 'MT-1')
    expect(card.text).toContain('MT-1')
    expect(card.text).toMatch(/fail/i)
    expect(card.text).toContain('pin writer approval')
    expect(card.text).not.toMatch(/<[^>]+>/)
  })
})
