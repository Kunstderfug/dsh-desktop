/**
 * [multitask] issue #5 — researcher subagent lifecycle.
 *
 * Real-harness composition at the frozen public seam: the permanent
 * `dsh-multitask` plugin, real `@deepseek-ai/dsh-commands` CommandRuntime,
 * real SubagentRuntime + in-process spawn, real JSONL persistence, real
 * session query, real agent loop. The ONLY stand-in is the scripted model
 * adapter registered through `ctx.llm.registerAdapter`.
 *
 * The retained regressions observe full command/child/parent-turn history
 * and the child `toolFilter` denial — not a brief-template unit, a mocked
 * runtime, or a final-phase-only assertion.
 */
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  type FinishReason,
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
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as subagentSpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as multitask from '../packages/dsh-multitask/index.js'

const RESEARCHER_LABEL = 'researcher'
const DENIED_TOOLS = ['write', 'edit', 'str_replace_editor'] as const
const REPORT_HEADINGS = [
  'Goal',
  'Affected paths',
  'Implementation plan',
  'Risks',
  'Recommended claim set'
] as const

const STRUCTURED_REPORT = [
  'Goal: implement the researcher brief for task B',
  'Affected paths: packages/dsh-multitask/index.js, packages/dsh-multitask/researcher.js',
  'Implementation plan: spawn a continuable researcher, then map settlement',
  'Risks: parent-turn interruption and write-tool leakage',
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
  rejectSubagentSteps?: boolean
}

interface Fixture {
  ctx: Context
  home: string
  probePath: string
  writes: Array<{ name: string, path: string }>
  calls: ScriptedCall[]
  agent(id: string): Promise<Agent>
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const home = options.home ?? await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-researcher-'))
  if (options.home === undefined) cleanups.push(() => rm(home, { recursive: true, force: true }))
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
    cleanups.push(once)
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
  const probePath = path.join(home, 'researcher-probe.txt')
  registerMutationTools(ctx, writes)

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

  if (options.rejectSubagentSteps === true) {
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent.session.header.origin === 'subagent') return { kind: 'reject' }
      return next()
    })
  }

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

  return { ctx, home, probePath, writes, calls, agent }
}

function registerMutationTools(ctx: Context, writes: Fixture['writes']): void {
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
        writes.push({ name, path: args.file_path })
        await writeFile(args.file_path, args.content)
        return { path: args.file_path }
      }
    }))
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

function userText(request: GenerateOptions): string {
  return request.messages
    .filter(message => message.role === 'user')
    .map(message => message.content.map(block => block.type === 'text' ? block.text : `<${block.type}>`).join(''))
    .join('\n')
}

function researchEvents(agent: Agent): Array<Record<string, unknown>> {
  return agent.session
    .snapshotEvents()
    .filter(event => event.type === 'multitask/research')
    .map(event => event.data as Record<string, unknown>)
}

function turnCount(agent: Agent): number {
  return agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length
}

function parentControlEffects(agent: Agent, afterSeq: number): SessionEvent[] {
  return agent.session.snapshotEvents().filter(event =>
    event.seq > afterSeq
    && (
      event.type === 'turn/start'
      || event.type === 'user/message'
      || event.type === 'agent/inbox/spliced'
      || /(followup|steer|abort)/iu.test(event.type)
    ))
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

function* writeMutationChunks(probePath: string): Generator<StreamChunk> {
  const id = ToolCallId('researcher-write-probe')
  const args = JSON.stringify({
    file_path: probePath,
    content: 'researcher must not be allowed to write this'
  })
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name: 'write', argumentsDelta: args }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: args } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function* textChunks(text: string, reason: FinishReason = { kind: 'stop' }): Generator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
  yield { type: 'finish', reason }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

describe('multitask_researcher_gate launch while task A runs', () => {
  it('starts one continuable researcher without touching the parent turn or input', { timeout: 20_000 }, async () => {
    const parentHold = gate()
    const researcherHold = gate()
    const f = await fixture({
      respond: async (call) => {
        if (isResearcherCall(call)) {
          await holdUntil(call.request.signal, researcherHold.promise)
          return STRUCTURED_REPORT
        }
        await holdUntil(call.request.signal, parentHold.promise)
        return 'task A still running'
      }
    })
    const agent = await f.agent('session-1')

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'task A in progress' }],
      source: { kind: 'user' }
    }))
    await waitFor(() => f.calls.some(call => !isResearcherCall(call)), 'held task A model call')
    const launchSeq = agent.session.snapshotEvents().at(-1)!.seq
    expect(agent.status).toBe('running')
    expect(turnCount(agent)).toBe(1)
    const taskAInput = userText(f.calls.find(call => !isResearcherCall(call))!.request)

    const started = Date.now()
    const execution = await runCommand(f, agent, '/multitask research and implement task B')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(execution.result).toMatchObject({ kind: 'success' })

    const launched = researchEvents(agent)
    expect(launched.some(event => event.phase === 'researching'), 'command must spawn a researcher and record researching').toBe(true)
    const researching = launched.find(event => event.phase === 'researching')!
    expect(researching.id).toBe('MT-1')
    expect(typeof researching.childId).toBe('string')
    expect(researching.label).toBe(RESEARCHER_LABEL)

    const children = await f.ctx.subagents.listChildren(agent.id)
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({
      kind: 'child',
      id: researching.childId,
      mode: 'continuable',
      label: RESEARCHER_LABEL
    })

    expect(agent.status).toBe('running')
    expect(turnCount(agent)).toBe(1)
    expect(userText(f.calls.find(call => !isResearcherCall(call))!.request)).toBe(taskAInput)
    expect(taskAInput).toContain('task A in progress')
    expect(taskAInput).not.toContain('/multitask')
    expect(taskAInput).not.toContain('research and implement task B')
    expect(agent.inbox.nextTurn).toHaveLength(0)
    const launchEffects = parentControlEffects(agent, launchSeq).filter(event =>
      event.type !== 'subagent/catalog' && event.type !== 'subagent/descriptor')
    expect(launchEffects.filter(event =>
      event.type === 'turn/start' || /(followup|steer|abort)/iu.test(event.type))).toHaveLength(0)

    researcherHold.open()
    parentHold.open()
    await waitFor(() => researchEvents(agent).some(event => event.phase === 'researched'), 'completed settlement')
    await agent.whenIdle()
  })
})

describe('multitask_researcher_gate child write denial', () => {
  it('denies write/edit/str_replace_editor by child toolFilter, not brief text alone', { timeout: 20_000 }, async () => {
    let writeCalls = 0
    const f = await fixture({
      respond: async (call) => {
        if (!isResearcherCall(call)) return 'parent idle ack'
        writeCalls += 1
        if (writeCalls === 1) return writeMutationChunks(f.probePath)
        return STRUCTURED_REPORT
      }
    })
    const parent = await f.agent('session-1')
    const parentWrite = f.ctx.tools.get('write', parent)
    expect(parentWrite).toBeDefined()

    await runCommand(f, parent, '/multitask research the mutation probe')
    const launched = researchEvents(parent)
    expect(launched.some(event => event.phase === 'researching'), 'command must spawn a researcher and record researching').toBe(true)
    const researching = launched.find(event => event.phase === 'researching')!
    const childId = String(researching.childId)

    await waitFor(() => f.ctx.agents.get(SessionId(childId)) !== undefined, 'live researcher agent')
    const child = f.ctx.agents.get(SessionId(childId))!
    expect(f.ctx.tools.get('write', child)).toBeUndefined()
    expect(f.ctx.tools.get('edit', child)).toBeUndefined()
    expect(f.ctx.tools.get('str_replace_editor', child)).toBeUndefined()

    const descriptor = child.session.snapshotEvents().find(event => event.type === 'subagent/descriptor')
    expect(descriptor).toBeDefined()
    expect(descriptor!.data).toMatchObject({
      mode: 'continuable',
      label: RESEARCHER_LABEL,
      toolFilter: { deny: [...DENIED_TOOLS] }
    })
    const persona = 'persona' in descriptor!.data ? String(descriptor!.data.persona ?? '') : ''
    expect(persona).toMatch(/researcher/i)

    await waitFor(() =>
      child.session.snapshotEvents().some(event => event.type === 'tool/result'),
    'denied mutation tool result')
    const toolResult = child.session.snapshotEvents().find(event => event.type === 'tool/result')!
    const denialText = JSON.stringify(toolResult.data)
    expect(denialText).toContain('UNKNOWN_TOOL')
    expect(denialText).toMatch(/unknown tool \\?"write\\?"/i)
    expect(denialText).toContain('"isError":true')
    expect(denialText).not.toContain('do not modify files')

    await waitFor(() => researchEvents(parent).some(event => event.phase === 'researched' || event.phase === 'research-failed'), 'researcher settled')
    expect(f.writes).toHaveLength(0)
    expect(await fileExists(f.probePath)).toBe(false)
  })
})

describe('multitask_researcher_gate report retrieval and settlement mapping', () => {
  it('retrieves the structured report through sendMessage and maps completed to researched', { timeout: 20_000 }, async () => {
    const f = await fixture()
    const parent = await f.agent('session-1')

    await runCommand(f, parent, '/multitask research the structured report')
    expect(
      researchEvents(parent).some(event => event.phase === 'researching'),
      'command must spawn a researcher and record researching'
    ).toBe(true)
    await waitFor(() => researchEvents(parent).some(event => event.phase === 'researched'), 'completed → researched')
    const researched = researchEvents(parent).find(event => event.phase === 'researched')!
    expect(researched.stopReason).toBe('completed')
    expect(researched.label).toBe(RESEARCHER_LABEL)
    expect(researchEvents(parent).some(event => event.phase === 'researching')).toBe(true)
    expect(researchEvents(parent).every(event => event.phase !== 'research-failed')).toBe(true)

    const childId = SessionId(String(researched.childId))
    await f.ctx.subagents.sendMessage(parent, childId, [{
      type: 'text',
      text: 'Return the complete structured research report covering Goal, Affected paths, Implementation plan, Risks, and Recommended claim set.'
    }], { signal: new AbortController().signal })

    await waitFor(() => f.calls.some(call =>
      isResearcherCall(call) && userText(call.request).includes('complete structured research report')),
    'parent retrieval sendMessage reached the child')
    await waitFor(() => parent.session.deriveMessages().filter(message =>
      message.source.kind === 'subagent-settled').length >= 2,
    'retrieval settlement notice')

    const retrieved = f.calls
      .filter(isResearcherCall)
      .flatMap(call => call.request.messages.filter(message => message.role === 'assistant'))
      .map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
      .join('\n')
    const noticeText = parent.session.deriveMessages()
      .filter(message => message.source.kind === 'subagent-settled')
      .map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
      .join('\n')
    const reportSurface = `${retrieved}\n${noticeText}\n${STRUCTURED_REPORT}`
    for (const heading of REPORT_HEADINGS) {
      expect(reportSurface).toContain(heading)
    }
  })

  it.each([
    {
      name: 'aborted',
      setup: 'interrupt' as const,
      expected: 'aborted'
    },
    {
      name: 'error',
      setup: 'throw' as const,
      expected: 'error'
    },
    {
      name: 'max-tokens',
      setup: 'max-tokens' as const,
      expected: 'max-tokens'
    },
    {
      name: 'refusal',
      setup: 'reject' as const,
      expected: 'refusal'
    }
  ])('maps $name settlement to research-failed', { timeout: 20_000 }, async ({ setup, expected }) => {
    const researcherHold = gate()
    const f = await fixture({
      rejectSubagentSteps: setup === 'reject',
      respond: async (call) => {
        if (!isResearcherCall(call)) return 'parent idle ack'
        if (setup === 'throw') throw new Error('scripted researcher transport failure')
        if (setup === 'max-tokens') return textChunks('partial report before the ceiling', { kind: 'max-tokens' })
        if (setup === 'interrupt') {
          await holdUntil(call.request.signal, researcherHold.promise)
          return STRUCTURED_REPORT
        }
        return STRUCTURED_REPORT
      }
    })
    const parent = await f.agent('session-1')
    await runCommand(f, parent, `/multitask observe ${expected} settlement`)
    expect(
      researchEvents(parent).some(event => event.phase === 'researching'),
      'command must spawn a researcher and record researching'
    ).toBe(true)
    const childId = String(researchEvents(parent).find(event => event.phase === 'researching')!.childId)

    if (setup === 'interrupt') {
      f.ctx.subagents.interrupt(SessionId(childId), { kind: 'ancestor', agent: parent })
      researcherHold.open()
    }

    await waitFor(() =>
      researchEvents(parent).some(event => event.phase === 'research-failed'),
    `${expected} → research-failed`)
    const failed = researchEvents(parent).find(event => event.phase === 'research-failed')!
    expect(failed.stopReason).toBe(expected)
    expect(failed.childId).toBe(childId)
    expect(researchEvents(parent).every(event => event.phase !== 'researched')).toBe(true)
    expect(researchEvents(parent).filter(event => event.phase === 'researching')).toHaveLength(1)
  })
})
