/**
 * [multitask] issue #8 — claims registry, projection, and scoped tools.
 *
 * Real-harness composition at the frozen public seam: the permanent
 * `dsh-multitask` plugin, real tool runtime, session projection registry,
 * session persistence, session query, subagent lineage, and browser
 * publication. The ONLY stand-in is the scripted model adapter registered
 * through `ctx.llm.registerAdapter`.
 *
 * The retained regressions observe full claim/release/conflict/expiry history
 * and forbidden work — not a pure overlap helper, an in-memory registry, an
 * unpersisted service call, a global tool catalog, or a restart that skips
 * real subagent activity.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Commands from '@deepseek-ai/dsh-commands'
import {
  type GenerateOptions,
  LlmAdapter,
  LlmRuntime,
  type StreamChunk,
  ToolCallId
} from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as subagentSpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as multitask from '../packages/dsh-multitask/index.js'

const CLAIM_TOOLS = ['claim_files', 'release_files', 'list_file_claims'] as const
const STRUCTURED_REPORT = [
  'Goal: claims registry coverage',
  'Affected paths: src/shared.ts',
  'Implementation plan: claim, then release',
  'Risks: overlapping writers',
  'Recommended claim set: src/shared.ts'
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
}

interface Fixture {
  ctx: Context
  home: string
  writes: Array<{ name: string, path: string }>
  calls: ScriptedCall[]
  projectionChanges: Array<{ sessionId: string, key: string, value: unknown }>
  agent(id: string): Promise<Agent>
  disposeAll(): Promise<void>
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const home = options.home ?? await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-claims-'))
  if (options.home === undefined && options.detached !== true) {
    cleanups.push(() => rm(home, { recursive: true, force: true }))
  }
  const ctx = new Context()
  const disposers: Array<() => Promise<void>> = []
  const pushCore = (dispose: () => Promise<void> | void) => {
    let settled: Promise<void> | undefined
    const once = async () => {
      settled ??= (async () => {
        await dispose()
      })()
      await settled
    }
    disposers.push(once)
    if (options.detached !== true) cleanups.push(once)
  }

  const prompt = await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  pushCore(() => prompt.dispose())
  const projections = await ctx.plugin(SessionProjectionRegistry)
  pushCore(() => projections.dispose())
  const sessions = await ctx.plugin(SessionStore)
  pushCore(() => sessions.dispose())
  const tools = await ctx.plugin(ToolRuntime)
  pushCore(() => tools.dispose())
  const llm = await ctx.plugin(LlmRuntime)
  pushCore(() => llm.dispose())
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: home })
  pushCore(() => persistence.dispose())
  const registry = await ctx.plugin(AgentRegistry)
  pushCore(() => registry.dispose())
  const commands = await ctx.plugin(Commands)
  pushCore(() => commands.dispose())

  const writes: Fixture['writes'] = []
  ctx.tools.register(defineTool({
    name: 'write',
    description: 'mutation probe used to prove claims do not enforce writes',
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
      writes.push({ name: 'write', path: args.file_path })
      await writeFile(args.file_path, args.content)
      return { path: args.file_path }
    }
  }))

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
  pushCore(() => adapter.dispose())

  const loop = await ctx.plugin(AgentLoop)
  pushCore(() => loop.dispose())
  const subagents = await ctx.plugin(SubagentRuntime)
  pushCore(() => (subagents as { dispose(): Promise<void> }).dispose())
  const spawn = await ctx.plugin(subagentSpawnInProcess as unknown as Parameters<Context['plugin']>[0])
  pushCore(() => spawn.dispose())
  const query = await ctx.plugin(SessionQueryEngine as unknown as new (ctx: Context) => SessionQueryEngine)
  pushCore(() => query.dispose())

  const mounted = await ctx.plugin(multitask as unknown as Parameters<Context['plugin']>[0])
  pushCore(() => mounted.dispose())

  const projectionChanges: Fixture['projectionChanges'] = []
  ctx.sessionProjections.onChanged((session, key, value) => {
    projectionChanges.push({ sessionId: String(session.id), key, value })
  })

  async function agent(id: string): Promise<Agent> {
    const handle = await ctx.agents.create({
      sessionId: SessionId(id),
      meta: { cwd: home },
      agentOptions: { provider: 'scripted', model: 'orchestrator' }
    })
    pushCore(() => handle.dispose())
    return handle.agent
  }

  return {
    ctx,
    home,
    writes,
    calls,
    projectionChanges,
    agent,
    disposeAll: async () => {
      for (const dispose of [...disposers].reverse()) await dispose()
    }
  }
}

function defaultRespond(call: ScriptedCall): string {
  return isResearcherCall(call) ? STRUCTURED_REPORT : `parent ack: ${call.model}`
}

function isResearcherCall(call: ScriptedCall): boolean {
  const text = userText(call.request)
  return text.includes('do not modify files')
    || text.includes('Recommended claim set')
    || text.includes('structured research report')
}

function isWriterCall(call: ScriptedCall): boolean {
  return userText(call.request).includes('stays live to claim files')
}

function userText(request: GenerateOptions): string {
  return request.messages
    .filter(message => message.role === 'user')
    .map(message => message.content.map(block => block.type === 'text' ? block.text : `<${block.type}>`).join(''))
    .join('\n')
}

function gate(): { promise: Promise<void>, open: () => void } {
  let release!: () => void
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, open: release }
}

async function holdUntil(signal: AbortSignal | undefined, held: Promise<void>): Promise<void> {
  const reason = () => signal?.reason instanceof Error ? signal.reason : new Error('scripted model call aborted')
  if (signal?.aborted) throw reason()
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(reason())
    signal?.addEventListener('abort', onAbort, { once: true })
    held.then(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, reject)
  })
}

async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function runCommand(f: Fixture, agent: Agent, line: string) {
  const execution = await f.ctx.commands.execute(agent, line, [], new AbortController().signal)
  expect(execution).toBeDefined()
  return execution!
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

function claimEvents(agent: Agent): Array<Record<string, unknown>> {
  return agent.session
    .snapshotEvents()
    .filter(event => event.type === 'multitask/claims')
    .map(event => event.data as Record<string, unknown>)
}

function toolNames(ctx: Context, agent?: Agent): string[] {
  return ctx.tools.schemas(agent).map(schema => schema.name).sort()
}

function liveClaims(value: unknown): Array<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || !('claims' in value)) return []
  const claims = (value as { claims?: unknown }).claims
  return Array.isArray(claims) ? claims as Array<Record<string, unknown>> : []
}

function projectionClaims(ctx: Context, agent: Agent): Array<Record<string, unknown>> {
  const snapshot = ctx.sessionProjections.snapshot(agent.session, ['multitask/claims'])
  return liveClaims(snapshot.values['multitask/claims'])
}

async function launchTwoHeldChildren(f: Fixture, parent: Agent) {
  await runCommand(f, parent, '/multitask implement shared file A')
  await runCommand(f, parent, '/multitask implement shared file B')
  const startA = await f.ctx.subagents.startContinuable({
    provider: 'spawn',
    label: 'writer-a',
    request: {
      prompt: [{ type: 'text', text: 'writer A stays live to claim files' }],
      parent
    },
    signal: new AbortController().signal
  })
  const startB = await f.ctx.subagents.startContinuable({
    provider: 'spawn',
    label: 'writer-b',
    request: {
      prompt: [{ type: 'text', text: 'writer B stays live to claim files' }],
      parent
    },
    signal: new AbortController().signal
  })
  const childIds = [String(startA.childId), String(startB.childId)]
  await waitFor(() => childIds.every(id => f.ctx.agents.get(SessionId(id)) !== undefined), 'live writer agents')
  return {
    childA: f.ctx.agents.get(SessionId(childIds[0]!))!,
    childB: f.ctx.agents.get(SessionId(childIds[1]!))!,
    childIds
  }
}

describe('multitask_claims_registry_gate conflict and scoping', () => {
  it('conflicts on overlapping live claims, scopes tools, and does not enforce writes', { timeout: 20_000 }, async () => {
    const hold = gate()
    const ordinary = await fixture()
    const ordinaryAgent = await ordinary.agent('ordinary')
    expect(toolNames(ordinary.ctx)).not.toEqual(expect.arrayContaining([...CLAIM_TOOLS]))
    expect(toolNames(ordinary.ctx, ordinaryAgent)).not.toEqual(expect.arrayContaining([...CLAIM_TOOLS]))

    const f = await fixture({
      respond: async (call) => {
        if (isWriterCall(call)) {
          await holdUntil(call.request.signal, hold.promise)
          return 'writer held'
        }
        if (isResearcherCall(call)) return STRUCTURED_REPORT
        return 'parent ack'
      }
    })
    const parent = await f.agent('session-1')
    expect(toolNames(f.ctx, parent)).not.toEqual(expect.arrayContaining([...CLAIM_TOOLS]))

    const { childA, childB } = await launchTwoHeldChildren(f, parent)
    expect(toolNames(f.ctx)).not.toEqual(expect.arrayContaining([...CLAIM_TOOLS]))
    expect(CLAIM_TOOLS.every(name => toolNames(f.ctx, parent).includes(name))).toBe(true)
    expect(CLAIM_TOOLS.every(name => toolNames(f.ctx, childA).includes(name))).toBe(true)
    expect(CLAIM_TOOLS.every(name => toolNames(f.ctx, childB).includes(name))).toBe(true)
    expect(toolNames(ordinary.ctx, ordinaryAgent)).not.toEqual(expect.arrayContaining([...CLAIM_TOOLS]))

    const first = await runTool(f.ctx, childA, 'claim_files', {
      paths: [path.join(f.home, 'src/shared.ts'), 'src/'],
      taskId: 'MT-1'
    })
    expect(first.isError).toBe(false)
    expect(first.value).toMatchObject({ claimed: expect.arrayContaining(['src/shared.ts', 'src']) })
    expect(claimEvents(parent).every(event => !isAbsoluteWorkspaceRecord(event.path))).toBe(true)

    const exact = await runTool(f.ctx, childB, 'claim_files', {
      paths: ['src/shared.ts'],
      taskId: 'MT-2'
    })
    expect(exact.isError).toBe(true)
    expect(exact.error?.info?.code).toBe('CLAIM_CONFLICT')
    expect(exact.error?.message).toContain('MT-1')
    expect(exact.error?.message).toContain('src/shared.ts')

    const descendant = await runTool(f.ctx, childB, 'claim_files', {
      paths: ['src/nested/file.ts', 'other.ts'],
      taskId: 'MT-2'
    })
    expect(descendant.isError).toBe(true)
    expect(descendant.error?.info?.code).toBe('CLAIM_CONFLICT')
    expect(descendant.error?.message).toContain('MT-1')
    expect(claimEvents(parent).filter(event => event.state === 'claimed' && event.taskId === 'MT-2')).toHaveLength(0)
    expect(projectionClaims(f.ctx, parent).every(claim => claim.taskId === 'MT-1')).toBe(true)

    const listed = await runTool(f.ctx, parent, 'list_file_claims', {})
    expect(listed.isError).toBe(false)
    expect(liveClaims(listed.value).some(claim => claim.path === 'src' && claim.taskId === 'MT-1')).toBe(true)

    const probe = path.join(f.home, 'claimed-write.txt')
    const write = await runTool(f.ctx, parent, 'write', {
      file_path: probe,
      content: 'claims must not deny writes'
    })
    expect(write.isError).toBe(false)
    expect(f.writes).toEqual([{ name: 'write', path: probe }])

    hold.open()
    await parent.whenIdle()
  })
})

describe('multitask_claims_registry_gate lifecycle and expiry', () => {
  it('releases, reclaims, stays idempotent, and expires only dead subagent owners', { timeout: 20_000 }, async () => {
    const hold = gate()
    const f = await fixture({
      respond: async (call) => {
        if (isWriterCall(call)) {
          await holdUntil(call.request.signal, hold.promise)
          return 'writer held'
        }
        if (isResearcherCall(call)) return STRUCTURED_REPORT
        return 'parent ack'
      }
    })
    const parent = await f.agent('session-1')
    const { childA, childB, childIds } = await launchTwoHeldChildren(f, parent)

    const first = await runTool(f.ctx, childA, 'claim_files', { paths: ['src/a.ts'], taskId: 'MT-1' })
    expect(first.isError).toBe(false)
    const again = await runTool(f.ctx, childA, 'claim_files', { paths: ['src/a.ts'], taskId: 'MT-1' })
    expect(again.isError).toBe(false)
    expect(claimEvents(parent).filter(event => event.path === 'src/a.ts' && event.state === 'claimed')).toHaveLength(1)

    const released = await runTool(f.ctx, childA, 'release_files', { paths: ['src/a.ts'], taskId: 'MT-1' })
    expect(released.isError).toBe(false)
    expect(projectionClaims(f.ctx, parent).some(claim => claim.path === 'src/a.ts')).toBe(false)

    const reclaimed = await runTool(f.ctx, childB, 'claim_files', { paths: ['src/a.ts'], taskId: 'MT-2' })
    expect(reclaimed.isError).toBe(false)
    expect(projectionClaims(f.ctx, parent).some(claim => claim.path === 'src/a.ts' && claim.taskId === 'MT-2')).toBe(true)

    await runTool(f.ctx, childA, 'claim_files', { paths: ['src/live.ts'], taskId: 'MT-1' })
    await f.ctx.subagents.drainContinuableChildren(parent, [SessionId(childIds[1]!)])
    await waitFor(async () => {
      const children = await f.ctx.subagents.listChildren(parent.id)
      const dead = children.find(entry => entry.kind === 'child' && entry.id === childIds[1])
      return dead?.kind === 'child' && dead.activity !== 'running'
    }, 'drained child is not running')

    const afterExpiry = await runTool(f.ctx, parent, 'list_file_claims', {})
    const table = liveClaims(afterExpiry.value)
    expect(table.some(claim => claim.path === 'src/a.ts' && claim.taskId === 'MT-2')).toBe(false)
    expect(table.some(claim => claim.path === 'src/live.ts' && claim.taskId === 'MT-1')).toBe(true)

    const liveChildren = await f.ctx.subagents.listChildren(parent.id)
    const live = liveChildren.find(entry => entry.kind === 'child' && entry.id === childIds[0])
    expect(live?.kind === 'child' && live.activity === 'running').toBe(true)

    hold.open()
    await parent.whenIdle()
  })
})

describe('multitask_claims_registry_gate restart publication', () => {
  it('folds the log, expires inactive owners, and publishes claims changes', { timeout: 20_000 }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-claims-restart-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const hold = gate()
    {
      const f = await fixture({
        home,
        detached: true,
        respond: async (call) => {
          if (isWriterCall(call)) {
            await holdUntil(call.request.signal, hold.promise)
            return 'writer held'
          }
          if (isResearcherCall(call)) return STRUCTURED_REPORT
          return 'parent ack'
        }
      })
      const parent = await f.agent('session-1')
      const { childA } = await launchTwoHeldChildren(f, parent)
      const parentClaim = await runTool(f.ctx, parent, 'claim_files', { paths: ['src/parent.ts'], taskId: 'MT-1' })
      expect(parentClaim.isError).toBe(false)
      const childClaim = await runTool(f.ctx, childA, 'claim_files', { paths: ['src/child.ts'], taskId: 'MT-1' })
      expect(childClaim.isError).toBe(false)
      expect(f.projectionChanges.some(change => change.key === 'multitask/claims')).toBe(true)
      expect(claimEvents(parent).some(event => event.path === 'src/parent.ts' && event.state === 'claimed')).toBe(true)
      hold.open()
      await parent.whenIdle()
      await f.disposeAll()
    }

    const f2 = await fixture({ home })
    const handle = await f2.ctx.agents.resume({
      resumeSessionId: SessionId('session-1'),
      agentOptions: { provider: 'scripted', model: 'orchestrator' }
    })
    cleanups.push(() => handle.dispose())
    const parent2 = handle.agent

    const children = await f2.ctx.subagents.listChildren(SessionId('session-1'))
    expect(children.some(entry => entry.kind === 'child' && entry.activity === 'inactive')).toBe(true)
    expect(f2.ctx.agents.get(SessionId('session-1'))).toBeDefined()

    const listed = await runTool(f2.ctx, parent2, 'list_file_claims', {})
    const table = liveClaims(listed.value)
    expect(table.some(claim => claim.path === 'src/child.ts')).toBe(false)
    expect(table.some(claim => claim.path === 'src/parent.ts' && claim.taskId === 'MT-1')).toBe(true)
    expect(table.every(claim => !isAbsoluteWorkspaceRecord(claim.path))).toBe(true)
    expect(projectionClaims(f2.ctx, parent2).some(claim => claim.path === 'src/parent.ts')).toBe(true)
    expect(f2.projectionChanges.some(change => change.key === 'multitask/claims')).toBe(true)

    const reclaim = await runTool(f2.ctx, parent2, 'claim_files', { paths: ['src/child.ts'], taskId: 'MT-2' })
    expect(reclaim.isError).toBe(false)
  })
})

function isAbsoluteWorkspaceRecord(value: unknown): boolean {
  return typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))
}
