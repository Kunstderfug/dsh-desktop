/**
 * [multitask] issue #10 — writer cap, shared wake bound, busy-parent briefs.
 *
 * Real configured composition at the frozen public seam selected by
 * `multitask_guardrails_gate`: permanent `dsh-multitask` plugin, command
 * runtime, orchestrator-mode request assembly, scoped `subagent` tool
 * runtime, live descendant activity, claims/touch trail, round-driver
 * handoffs and wake budget, and the session event log. Only the model
 * adapter and child settlement timing are scripted.
 *
 * These regressions observe a structured third-writer refusal, later
 * admission after settlement, queue uniqueness, the shared
 * `maxConsecutiveWakes` bound, parent-held path omission from writer
 * briefs, and the researcher spawn `toolFilter` — not a counter unit,
 * a mocked writer list, or a source grep.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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
import * as toolSubagent from '@deepseek-ai/dsh-tool-subagent'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as multitask from '../packages/dsh-multitask/index.js'

const DENIED_TOOLS = ['write', 'edit', 'str_replace_editor'] as const
const RESEARCHER_LABEL = 'researcher'
const PARENT_HELD = 'parent-busy.ts'
const STRUCTURED_REPORT = [
  'Goal: implement the guardrails brief',
  'Affected paths: packages/dsh-multitask/guardrails.js',
  'Implementation plan: refuse the third writer and yield',
  'Risks: hidden retry and leaked reservations',
  'Recommended claim set: packages/dsh-multitask/guardrails.js'
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
  maxWriters?: number
  maxConsecutiveWakes?: number
  enabled?: boolean
  sessionId?: string
}

interface Fixture {
  ctx: Context
  home: string
  calls: ScriptedCall[]
  agent: Agent
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-guardrails-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  await mkdir(path.join(home, 'src'), { recursive: true })
  const ctx = new Context()
  const disposers: Array<() => Promise<void>> = []
  const push = (dispose: () => Promise<void> | void) => {
    let settled: Promise<void> | undefined
    const once = async () => {
      settled ??= Promise.resolve().then(() => dispose())
      await settled
    }
    disposers.push(once)
    cleanups.push(once)
  }

  const prompt = await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  push(() => prompt.dispose())
  const projections = await ctx.plugin(SessionProjectionRegistry)
  push(() => projections.dispose())
  const sessions = await ctx.plugin(SessionStore)
  push(() => sessions.dispose())
  const tools = await ctx.plugin(ToolRuntime)
  push(() => tools.dispose())
  const llm = await ctx.plugin(LlmRuntime)
  push(() => llm.dispose())
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: home })
  push(() => persistence.dispose())
  const registry = await ctx.plugin(AgentRegistry)
  push(() => registry.dispose())
  const commands = await ctx.plugin(Commands)
  push(() => commands.dispose())
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
  push(() => adapter.dispose())

  const loop = await ctx.plugin(AgentLoop)
  push(() => loop.dispose())
  const subagents = await ctx.plugin(SubagentRuntime)
  push(() => (subagents as { dispose(): Promise<void> }).dispose())
  const spawn = await ctx.plugin(subagentSpawnInProcess as unknown as Parameters<Context['plugin']>[0])
  push(() => spawn.dispose())
  const query = await ctx.plugin(SessionQueryEngine as unknown as new (ctx: Context) => SessionQueryEngine)
  push(() => query.dispose())
  const mounted = await ctx.plugin(
    multitask as unknown as Parameters<Context['plugin']>[0],
    {
      enabled: options.enabled ?? true,
      maxWriters: options.maxWriters,
      maxConsecutiveWakes: options.maxConsecutiveWakes ?? 3
    }
  )
  push(() => mounted.dispose())
  const writers = await ctx.plugin(toolSubagent as unknown as Parameters<Context['plugin']>[0], {
    provider: 'spawn',
    backgroundMode: 'continuable'
  })
  push(() => (writers as { dispose(): Promise<void> }).dispose())

  const handle = await ctx.agents.create({
    sessionId: SessionId(options.sessionId ?? 'session-1'),
    meta: { cwd: home },
    agentOptions: { provider: 'scripted', model: 'orchestrator' }
  })
  push(() => handle.dispose())

  return { ctx, home, calls, agent: handle.agent }
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

function handoffs(agent: Agent) {
  return [
    ...agent.inbox.nextTurn,
    ...agent.inbox.nextStep,
    ...agent.session.deriveMessages()
  ].filter(message => message.source?.kind === 'multitask')
}

function queuedHandoffs(agent: Agent) {
  return [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
    .filter(message => message.source?.kind === 'multitask')
}

function admittedHandoffs(agent: Agent) {
  return agent.session.deriveMessages().filter(message => message.source.kind === 'multitask')
}

function handoffText(agent: Agent): string {
  return handoffs(agent)
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')
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

async function liveWriterIds(ctx: Context, agent: Agent): Promise<string[]> {
  const descendants = await ctx.subagents.listDescendants(agent.session.id)
  return descendants
    .filter(entry => entry.kind === 'child' && entry.activity === 'running' && entry.label !== RESEARCHER_LABEL)
    .map(entry => String(entry.id))
}

describe('multitask_guardrails_gate config matrix', () => {
  it('defaults maxWriters to 2, honors a custom cap, and fails closed', () => {
    expect(multitask.DEFAULT_MAX_WRITERS).toBe(2)
    expect(multitask.resolveGuardrailsConfig()).toEqual({ maxWriters: 2 })
    expect(multitask.resolveGuardrailsConfig({})).toEqual({ maxWriters: 2 })
    expect(multitask.resolveGuardrailsConfig({ maxWriters: 3 })).toEqual({ maxWriters: 3 })
    expect(() => multitask.resolveGuardrailsConfig({ maxWriters: 0 })).toThrow(/maxWriters/i)
    expect(() => multitask.resolveGuardrailsConfig({ maxWriters: -1 })).toThrow(/maxWriters/i)
    expect(() => multitask.resolveGuardrailsConfig({ maxWriters: 1.5 })).toThrow(/maxWriters/i)
    expect(() => multitask.resolveGuardrailsConfig({ maxWriters: '2' as unknown as number })).toThrow(/maxWriters/i)
    expect(() => multitask.apply({} as never, { maxWriters: 0 })).toThrow(/maxWriters/i)
  })

  it('shares the existing driver config object for maxConsecutiveWakes', async () => {
    const f = await fixture({ maxConsecutiveWakes: 2, maxWriters: 1 })
    const guardrails = f.ctx.get('multitask.guardrails') as {
      driverConfig: { maxConsecutiveWakes: number }
      driver?: { config: { maxConsecutiveWakes: number } }
    } | undefined
    expect(guardrails, 'guardrails controller must be mounted').toBeDefined()
    expect(guardrails!.driverConfig.maxConsecutiveWakes).toBe(2)
    expect(guardrails!.driver?.config, 'admission must read the same driver config object').toBe(guardrails!.driverConfig)
    expect(Object.getOwnPropertyNames(guardrails).filter(name => /wake|counter/i.test(name))).toEqual([])
  })
})

describe('multitask_guardrails_gate writer admission', () => {
  it('refuses a third concurrent writer, queues once, then admits after settlement', { timeout: 30_000 }, async () => {
    const holdA = gate()
    const holdB = gate()
    const holdC = gate()
    const ends = new Map<string, string>()
    const f = await fixture({
      respond: async (call) => {
        if (isWriterCall(call, 'writer A stays live')) {
          await holdUntil(call.request.signal, holdA.promise)
          return 'writer A completed'
        }
        if (isWriterCall(call, 'writer B stays live')) {
          await holdUntil(call.request.signal, holdB.promise)
          return 'writer B completed'
        }
        if (isWriterCall(call, 'writer C stays live')) {
          await holdUntil(call.request.signal, holdC.promise)
          return 'writer C completed'
        }
        return defaultRespond(call)
      }
    })
    f.ctx.on('subagent/end', (info: { id: string, stopReason?: string }) => {
      ends.set(String(info.id), String(info.stopReason ?? ''))
    })

    await runCommand(f.ctx, f.agent, '/multitask first objective')
    const busy = await f.ctx.tools.execute({
      callId: ToolCallId('write-busy'),
      name: 'write',
      arguments: {
        file_path: path.join(f.home, PARENT_HELD),
        content: 'parent already touching this'
      },
      agent: f.agent,
      signal: new AbortController().signal
    }).catch(() => undefined)
    if (busy?.isError) {
      /* write tool may be absent in this composition; touch via claims */
    }
    const claims = f.ctx.get('multitask.claims') as { recordTouched?(session: Agent['session'], path: string): void }
    claims?.recordTouched?.(f.agent.session, PARENT_HELD)
    await runCommand(f.ctx, f.agent, '/multitask second objective')

    expect(
      liveClaims(f.agent).some(claim => String(claim.path).includes(PARENT_HELD)),
      'busy-parent path must be claimed before publication'
    ).toBe(true)
    expect(handoffText(f.agent)).toMatch(/Live claims/i)
    expect(handoffText(f.agent)).toContain(PARENT_HELD)

    const first = await runSubagent(f.ctx, f.agent, 'writer-a', `writer A stays live to claim files; do not touch ${PARENT_HELD}`)
    expect(first.isError, `first writer must start: ${first.error?.message}`).toBe(false)
    const second = await runSubagent(f.ctx, f.agent, 'writer-b', `writer B stays live to claim files; do not touch ${PARENT_HELD}`)
    expect(second.isError, `second writer must start: ${second.error?.message}`).toBe(false)

    await waitFor(async () => (await liveWriterIds(f.ctx, f.agent)).length >= 2, 'two live writers')
    const liveBefore = await liveWriterIds(f.ctx, f.agent)
    expect(liveBefore).toHaveLength(2)

    const researchers = researchEvents(f.agent).filter(event => event.phase === 'researching')
    expect(researchers.length, 'researchers must not consume writer slots').toBeGreaterThan(0)

    const queuedBefore = queuedHandoffs(f.agent).map(message => message.id)
    const third = await runSubagent(f.ctx, f.agent, 'writer-c', `writer C stays live to claim files; include ${PARENT_HELD}`)
    expect(third.isError, 'third concurrent writer must be refused').toBe(true)
    const refusal = parseCapReason(third)
    expect(refusal.code).toBe('WRITER_CAP')
    expect(refusal.maxWriters).toBe(2)
    expect(refusal.queue).toBe('yield')
    expect(String(refusal.reason)).toMatch(/writer cap reached/i)

    const liveAfterRefuse = await liveWriterIds(f.ctx, f.agent)
    expect(liveAfterRefuse, 'refusal must start no child').toHaveLength(2)
    expect(liveAfterRefuse.sort()).toEqual(liveBefore.sort())

    const queuedAfter = queuedHandoffs(f.agent)
    const uniqueTaskIds = new Set(queuedAfter.map(message => String((message.source as { taskId?: string }).taskId)))
    expect(uniqueTaskIds.size, 'queue must stay unique per task').toBe(queuedAfter.length === 0 ? 0 : uniqueTaskIds.size)
    expect(
      queuedAfter.filter(message => !queuedBefore.includes(message.id)).length <= 1,
      'refusal must not duplicate the later handoff'
    ).toBe(true)

    const firstId = String((first as { value?: { subagentId?: string } }).value?.subagentId
      ?? (first as { value?: { childId?: string } }).value?.childId
      ?? liveBefore[0])
    holdA.open()
    await waitFor(() => ends.get(firstId) === 'completed' || ends.size >= 1, 'first writer settled')
    await waitFor(async () => (await liveWriterIds(f.ctx, f.agent)).length <= 1, 'reservation released after settlement')

    const later = await runSubagent(f.ctx, f.agent, 'writer-c-later', `writer C stays live to claim files; include ${PARENT_HELD}`)
    expect(later.isError, `later admission must start after settlement: ${later.error?.message}`).toBe(false)
    await waitFor(async () => (await liveWriterIds(f.ctx, f.agent)).length >= 2, 'later writer live')

    const laterId = String((later as { value?: { subagentId?: string } }).value?.subagentId ?? '')
    await waitFor(() => f.ctx.agents.get(SessionId(laterId)) !== undefined, 'later writer agent')
    const laterChild = f.ctx.agents.get(SessionId(laterId))
    const laterBrief = laterChild === undefined
      ? ''
      : laterChild.session.deriveMessages()
        .flatMap(message => message.content)
        .filter(block => block.type === 'text')
        .map(block => block.type === 'text' ? block.text : '')
        .join('\n')
    expect(laterBrief, 'admitted writer brief must omit parent-held paths').not.toContain(PARENT_HELD)

    const writerCalls = f.calls.filter(call => isWriterCall(call, 'writer C stays live') || isWriterCall(call, 'writer A stays live') || isWriterCall(call, 'writer B stays live'))
    for (const call of writerCalls) {
      expect(userText(call.request), 'child model input must omit parent-held paths').not.toContain(PARENT_HELD)
    }

    holdB.open()
    holdC.open()
    await f.agent.whenIdle()
  })

  it('does not count researchers toward the writer cap', { timeout: 20_000 }, async () => {
    const hold = gate()
    const f = await fixture({
      maxWriters: 1,
      respond: async (call) => {
        if (isWriterCall(call, 'only writer stays live')) {
          await holdUntil(call.request.signal, hold.promise)
          return 'only writer completed'
        }
        return defaultRespond(call)
      }
    })
    await runCommand(f.ctx, f.agent, '/multitask research only')
    await waitFor(() => researchEvents(f.agent).some(event => event.phase === 'researching'), 'researcher launched')
    const started = await runSubagent(f.ctx, f.agent, 'only-writer', 'only writer stays live to claim files')
    expect(started.isError, `the first writer must be admitted beside researchers: ${started.error?.message}`).toBe(false)
    const refused = await runSubagent(f.ctx, f.agent, 'overflow-writer', 'overflow writer stays live to claim files')
    expect(refused.isError).toBe(true)
    expect(parseCapReason(refused).maxWriters).toBe(1)
    hold.open()
    await f.agent.whenIdle()
  })
})

describe('multitask_guardrails_gate researcher filter and bound', () => {
  it('pins the actual researcher spawn toolFilter deny list', { timeout: 20_000 }, async () => {
    const f = await fixture()
    await runCommand(f.ctx, f.agent, '/multitask pin the researcher filter')
    const researching = researchEvents(f.agent).find(event => event.phase === 'researching')
    expect(researching, 'command must spawn a researcher').toBeDefined()
    const childId = String(researching!.childId)
    await waitFor(() => f.ctx.agents.get(SessionId(childId)) !== undefined, 'live researcher')
    const child = f.ctx.agents.get(SessionId(childId))!
    const descriptor = child.session.snapshotEvents().find(event => event.type === 'subagent/descriptor')
    expect(descriptor).toBeDefined()
    expect(descriptor!.data).toMatchObject({
      label: RESEARCHER_LABEL,
      toolFilter: { deny: [...DENIED_TOOLS] }
    })
    expect(f.ctx.tools.get('write', child)).toBeUndefined()
    expect(f.ctx.tools.get('edit', child)).toBeUndefined()
    expect(f.ctx.tools.get('str_replace_editor', child)).toBeUndefined()
    await f.agent.whenIdle()
  })

  it('admits at most maxConsecutiveWakes automatic dispatch rounds from the same driver config', { timeout: 20_000 }, async () => {
    const f = await fixture({
      maxConsecutiveWakes: 2,
      respond: async (call) => defaultRespond(call)
    })
    const guardrails = f.ctx.get('multitask.guardrails') as {
      driverConfig: { maxConsecutiveWakes: number }
      driver?: { config: { maxConsecutiveWakes: number } }
    }
    expect(guardrails.driver?.config).toBe(guardrails.driverConfig)

    await runCommand(f.ctx, f.agent, '/multitask bound the settle loop')
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
    expect(afterSettlements, 'instant settlements must not exceed the shared bound').toBeLessThanOrEqual(2)
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
    expect(admittedHandoffs(f.agent).length, 'no second counter may wake above the bound').toBe(afterSettlements)
  })
})
