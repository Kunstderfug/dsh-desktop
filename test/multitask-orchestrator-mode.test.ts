/**
 * [multitask] issue #7 — orchestrator mode projection, pending boundaries,
 * named prompt section, activation narration, resume/fork, and invariant
 * tool catalog.
 *
 * Real-harness composition at the frozen public seam: the permanent
 * `dsh-multitask` plugin, real CommandRuntime, session event log/projections,
 * agent pre-step, system-prompt assembly, stable tool registry,
 * SubagentRuntime, resume, and fork. The ONLY stand-ins are the scripted
 * model adapter and a writer-facing `subagent` adapter tool.
 *
 * The retained regressions observe full request-header / prompt / tool-call
 * history — not a source grep, an isolated fold helper, a private-controller
 * call, or a static prompt snapshot without a task transition.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
  type ToolSchema,
  ToolCallId
} from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as subagentSpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as multitask from '../packages/dsh-multitask/index.js'

const STRUCTURED_REPORT = [
  'Goal: implement the orchestrator-mode brief',
  'Affected paths: packages/dsh-multitask/orchestrator-mode.js',
  'Implementation plan: dispatch a writer through subagent',
  'Risks: parent self-implementation',
  'Recommended claim set: packages/dsh-multitask/orchestrator-mode.js'
].join('\n')

const ACTIVATION_NARRATION = /Multitask task MT-\d+ handed off; you are the orchestrator\./u
const ORCHESTRATOR_GUIDANCE = [
  'You are the orchestrator',
  'dispatch a writer through the `subagent` tool',
  'do not implement the task yourself',
  'Prefer yielding over blocking waits'
] as const

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

interface ModeController {
  noteTaskOpened(agent: Agent, taskId: string): 'committed' | 'queued' | 'cancelled' | 'noop'
  noteTaskClosed(agent: Agent, taskId: string): 'committed' | 'queued' | 'cancelled' | 'noop'
}

interface FixtureOptions {
  respond?: (call: ScriptedCall) => Promise<ScriptedResponse>
  home?: string
  detached?: boolean
}

interface Fixture {
  ctx: Context
  home: string
  writes: string[]
  subagentCalls: Array<{ description: string, prompt: string }>
  calls: ScriptedCall[]
  agent(id: string): Promise<Agent>
  disposeAll(): Promise<void>
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const home = options.home ?? await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-orchestrator-'))
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

  const writes: string[] = []
  const subagentCalls: Fixture['subagentCalls'] = []
  registerStableTools(ctx, writes, subagentCalls)

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
    subagentCalls,
    calls,
    agent,
    disposeAll: async () => {
      for (const dispose of [...disposers].reverse()) await dispose()
    }
  }
}

function registerStableTools(
  ctx: Context,
  writes: string[],
  subagentCalls: Fixture['subagentCalls']
): void {
  for (const name of ['write', 'edit', 'str_replace_editor'] as const) {
    ctx.tools.register(defineTool({
      name,
      description: name === 'write' ? 'self-implementation probe' : `${name} mutation probe`,
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
        writes.push(String(args.file_path))
        return { path: args.file_path }
      }
    }))
  }
  ctx.tools.register(defineTool({
    name: 'subagent',
    description: 'Writer-facing delegation tool',
    parameters: {
      description: { type: 'string', required: true, description: 'short task label' },
      prompt: { type: 'string', required: true, description: 'writer brief' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'continuable', required: true },
          subagentId: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }]
    },
    async execute(args) {
      subagentCalls.push({
        description: String(args.description),
        prompt: String(args.prompt)
      })
      return { kind: 'continuable' as const, subagentId: 'writer-1' }
    }
  }))
}

function defaultRespond(call: ScriptedCall): ScriptedResponse {
  if (isResearcherCall(call)) return STRUCTURED_REPORT
  if (inToolFollowup(call.request)) return `parent ack: ${call.model}`
  if (hasOrchestratorGuidance(call.request)) return subagentChunks()
  if (isParentCall(call) && implementYourself(call.request)) return writeChunks()
  return `parent ack: ${call.model}`
}

function inToolFollowup(request: GenerateOptions): boolean {
  const lastAssistant = [...request.messages].reverse().find(message => message.role === 'assistant')
  return lastAssistant?.content.some(block => block.type === 'tool-call') === true
}

function isResearcherCall(call: ScriptedCall): boolean {
  const text = userText(call.request)
  return text.includes('do not modify files')
    || text.includes('Recommended claim set')
    || text.includes('structured research report')
}

function isParentCall(call: ScriptedCall): boolean {
  return call.model === 'orchestrator' && !isResearcherCall(call)
}

function implementYourself(request: GenerateOptions): boolean {
  return /implement (the feature|this) yourself/iu.test(userText(request))
}

function hasOrchestratorGuidance(request: GenerateOptions): boolean {
  const text = systemText(request)
  return ORCHESTRATOR_GUIDANCE.every(phrase => text.includes(phrase))
}

function systemText(request: GenerateOptions): string {
  const messages = request.messages
    .filter(message => message.role === 'system')
    .map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
    .join('\n')
  return `${request.system ?? ''}\n${messages}`
}

function userText(request: GenerateOptions): string {
  return request.messages
    .filter(message => message.role === 'user')
    .map(message => message.content.map(block => block.type === 'text' ? block.text : `<${block.type}>`).join(''))
    .join('\n')
}

function* subagentChunks(): Generator<StreamChunk> {
  const id = ToolCallId('orchestrator-writer')
  const args = JSON.stringify({
    description: 'implement open task',
    prompt: 'Implement the researched task as the writer. Claim before edit; release when done.'
  })
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name: 'subagent', argumentsDelta: args }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'subagent', arguments: args } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function* writeChunks(): Generator<StreamChunk> {
  const id = ToolCallId('parent-self-write')
  const args = JSON.stringify({
    file_path: 'src/self-implemented.ts',
    content: 'parent implemented this itself'
  })
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name: 'write', argumentsDelta: args }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: args } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
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

function modeEvents(agent: Agent): Array<{ active: boolean, openTasks: string[] }> {
  return agent.session
    .snapshotEvents()
    .filter(event => event.type === 'multitask/mode')
    .map(event => event.data as { active: boolean, openTasks: string[] })
}

function modeView(ctx: Context, agent: Agent): { active: boolean, openTasks: string[] } | undefined {
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

function modeController(ctx: Context): ModeController {
  const mode = (ctx as Context & { multitaskMode?: ModeController }).multitaskMode
  if (mode === undefined) {
    throw new Error('orchestrator mode controller is not mounted on the composed plugin')
  }
  return mode
}

function catalogFingerprint(tools: readonly ToolSchema[] | undefined): string {
  return JSON.stringify((tools ?? []).map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  })).sort((left, right) => left.name.localeCompare(right.name)))
}

function headerCatalogs(agent: Agent): string[] {
  return agent.session
    .snapshotEvents()
    .filter(event => event.type === 'request/header')
    .map(event => catalogFingerprint((event.data as { header?: { tools?: ToolSchema[] } }).header?.tools))
}

function systemMessages(agent: Agent): string {
  return agent.session
    .snapshotEvents()
    .filter(event => event.type === 'system/message')
    .map(event => {
      const message = (event.data as { message?: { content?: Array<{ type?: string, text?: string }> } }).message
      return (message?.content ?? []).map(block => block.type === 'text' ? block.text ?? '' : '').join('')
    })
    .join('\n')
}

function toolCallNames(agent: Agent): string[] {
  return agent.session
    .snapshotEvents()
    .filter(event => event.type === 'tool/call')
    .map(event => String((event.data as { name?: string }).name ?? ''))
}

function parentCalls(f: Fixture): ScriptedCall[] {
  return f.calls.filter(isParentCall)
}

describe('multitask_orchestrator_mode_gate guidance and writer dispatch', () => {
  it('activates the named section after an accepted boundary and dispatches subagent instead of self-implementing', { timeout: 20_000 }, async () => {
    const held = gate()
    const f = await fixture({
      respond: async (call) => {
        if (isResearcherCall(call)) return STRUCTURED_REPORT
        if (
          isParentCall(call)
          && userText(call.request).includes('task A in progress')
          && !call.request.messages.some(message => message.role === 'assistant')
        ) {
          await holdUntil(call.request.signal, held.promise)
          return 'task A still running'
        }
        return defaultRespond(call)
      }
    })
    const agent = await f.agent('session-1')

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'task A in progress' }],
      source: { kind: 'user' }
    }))
    await waitFor(() => parentCalls(f).some(call => userText(call.request).includes('task A in progress')), 'held task A')
    expect(modeEvents(agent), 'mid-turn must not commit mode before /multitask').toHaveLength(0)
    expect(modeView(f.ctx, agent)?.active ?? false).toBe(false)

    await runCommand(f, agent, '/multitask research and implement task B')
    expect(modeEvents(agent), 'mid-turn task mint must stay pending until the next accepted step').toHaveLength(0)
    expect(systemText(parentCalls(f)[0]!.request)).not.toContain('do not implement the task yourself')

    held.open()
    await agent.whenIdle()

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue; implement this yourself if you are not the orchestrator' }],
      source: { kind: 'user' }
    }))
    await agent.whenIdle()

    const activeCall = parentCalls(f).find(call =>
      userText(call.request).includes('implement this yourself')
      || ACTIVATION_NARRATION.test(userText(call.request)))
    expect(activeCall, 'parent must assemble a post-boundary request').toBeDefined()
    const guidance = systemText(activeCall!.request)
    for (const phrase of ORCHESTRATOR_GUIDANCE) {
      expect(guidance, `missing orchestrator guidance: ${phrase}`).toContain(phrase)
    }
    expect(userText(activeCall!.request)).toMatch(ACTIVATION_NARRATION)
    expect(modeEvents(agent).at(-1)).toMatchObject({
      active: true,
      openTasks: ['MT-1']
    })
    expect(modeView(f.ctx, agent)).toEqual({
      active: true,
      openTasks: ['MT-1']
    })
    expect(
      activeCall!.request.tools?.map(tool => tool.name) ?? [],
      'writer-facing subagent must stay in the request catalog'
    ).toContain('subagent')
    expect(toolCallNames(agent)).toContain('subagent')
    expect(toolCallNames(agent)).not.toContain('write')
    expect(f.subagentCalls.length, 'scripted model must invoke writer-facing subagent').toBeGreaterThan(0)
    expect(f.writes, 'parent must not self-implement').toHaveLength(0)
  })

  it('omits the section when no tasks are open', { timeout: 20_000 }, async () => {
    const f = await fixture()
    const agent = await f.agent('session-1')
    expect(modeView(f.ctx, agent)).toEqual({ active: false, openTasks: [] })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'implement the feature yourself' }],
      source: { kind: 'user' }
    }))
    await agent.whenIdle()

    const idleCall = parentCalls(f)[0]
    expect(idleCall).toBeDefined()
    const guidance = systemText(idleCall!.request)
    expect(guidance, 'zero open tasks must omit the orchestrator section').not.toContain('do not implement the task yourself')
    expect(guidance).not.toContain('You are the orchestrator')
    expect(systemMessages(agent)).not.toContain('do not implement the task yourself')
    expect(modeEvents(agent)).toHaveLength(0)
  })
})

describe('multitask_orchestrator_mode_gate pending close, resume, and fork', () => {
  it('deactivates at the next accepted boundary and restores the folded view on resume and fork', { timeout: 20_000 }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-orchestrator-resume-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))

    const first = await fixture({ home, detached: true })
    const agent = await first.agent('session-1')
    await runCommand(first, agent, '/multitask restore this mode from the log')
    await agent.whenIdle()
    await waitFor(() => agent.session.snapshotEvents().some(event =>
      event.type === 'multitask/research'
      && ((event.data as { phase?: string }).phase === 'researched'
        || (event.data as { phase?: string }).phase === 'research-failed'
        || (event.data as { phase?: string }).phase === 'researching')),
    'researcher launched')

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'orchestrate the restored task' }],
      source: { kind: 'user' }
    }))
    await agent.whenIdle()
    expect(modeView(first.ctx, agent)).toEqual({ active: true, openTasks: ['MT-1'] })
    const activeCatalog = catalogFingerprint(parentCalls(first).at(-1)?.request.tools)
    const seed = agent.session.snapshotEvents()
    await first.disposeAll()

    const resumed = await fixture({ home })
    const handle = await resumed.ctx.agents.resume({
      resumeSessionId: SessionId('session-1'),
      agentOptions: { provider: 'scripted', model: 'orchestrator' }
    })
    cleanups.push(() => handle.dispose())
    expect(modeView(resumed.ctx, handle.agent)).toEqual({
      active: true,
      openTasks: ['MT-1']
    })

    const forkHandle = await resumed.ctx.agents.create({
      sessionId: SessionId('fork-1'),
      meta: {
        cwd: home,
        parentSession: SessionId('session-1'),
        isSeeded: true
      },
      inheritedEventCount: SessionLogOffset(seed.length),
      seed,
      agentOptions: { provider: 'scripted', model: 'orchestrator' }
    })
    cleanups.push(() => forkHandle.dispose())
    expect(modeView(resumed.ctx, forkHandle.agent)).toEqual({
      active: true,
      openTasks: ['MT-1']
    })

    modeController(resumed.ctx).noteTaskClosed(handle.agent, 'MT-1')
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'implement the feature yourself after close' }],
      source: { kind: 'user' }
    }))
    await handle.agent.whenIdle()
    expect(modeView(resumed.ctx, handle.agent)).toEqual({
      active: false,
      openTasks: []
    })
    expect(modeView(resumed.ctx, forkHandle.agent)).toEqual({
      active: true,
      openTasks: ['MT-1']
    })

    const closedCall = parentCalls(resumed).find(call =>
      userText(call.request).includes('after close'))
    expect(closedCall).toBeDefined()
    expect(systemText(closedCall!.request)).not.toContain('do not implement the task yourself')
    expect(catalogFingerprint(closedCall!.request.tools)).toBe(activeCatalog)
    const catalogs = headerCatalogs(handle.agent)
    expect(new Set(catalogs).size, 'request/header tool catalogs must stay identical').toBe(1)
  })
})

describe('multitask_orchestrator_mode_gate tool catalog invariance', () => {
  it('keeps request tool names and schemas identical across activation and deactivation', { timeout: 20_000 }, async () => {
    const f = await fixture()
    const agent = await f.agent('session-1')
    await runCommand(f, agent, '/multitask keep the catalog stable')
    await agent.whenIdle()
    await waitFor(() => agent.session.snapshotEvents().some(event =>
      event.type === 'multitask/research'
      && ((event.data as { phase?: string }).phase === 'researched'
        || (event.data as { phase?: string }).phase === 'research-failed'
        || (event.data as { phase?: string }).phase === 'researching')),
    'researcher launched')

    const pendingCatalog = catalogFingerprint(f.ctx.tools.schemas(agent))
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'orchestrate with an open task' }],
      source: { kind: 'user' }
    }))
    await agent.whenIdle()
    const activeCall = parentCalls(f).find(call => hasOrchestratorGuidance(call.request))
    expect(activeCall, 'active request must include the orchestrator section').toBeDefined()
    const activeCatalog = catalogFingerprint(activeCall!.request.tools)
    expect(activeCatalog).toBe(pendingCatalog)

    modeController(f.ctx).noteTaskClosed(agent, 'MT-1')
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'implement the feature yourself now that tasks are gone' }],
      source: { kind: 'user' }
    }))
    await agent.whenIdle()
    const inactiveCall = parentCalls(f).find(call =>
      userText(call.request).includes('tasks are gone'))
    expect(inactiveCall).toBeDefined()
    expect(hasOrchestratorGuidance(inactiveCall!.request)).toBe(false)
    expect(catalogFingerprint(inactiveCall!.request.tools)).toBe(activeCatalog)
    expect(catalogFingerprint(f.ctx.tools.schemas(agent))).toBe(activeCatalog)
    expect(new Set(headerCatalogs(agent)).size).toBe(1)
  })
})
