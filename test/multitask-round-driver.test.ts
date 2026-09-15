/**
 * [multitask] issue #6 — same-session round driver (handoff + race fences).
 *
 * Real-harness composition at the frozen public seam: the permanent
 * `dsh-multitask` plugin, real `@deepseek-ai/dsh-commands` CommandRuntime,
 * real agent loop, real SubagentRuntime + in-process spawn, real JSONL
 * persistence, real session query. The ONLY stand-in is the scripted model
 * adapter registered through `ctx.llm.registerAdapter`.
 *
 * The retained regressions observe full command/inbox/pre-step/turn history
 * — not a queue helper, a counter unit, a final inbox snapshot, or direct
 * message injection that bypasses pre-step.
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
  type FinishReason,
  type GenerateOptions,
  LlmAdapter,
  LlmRuntime,
  type StreamChunk
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

const DENIED_TOOLS = ['write', 'edit', 'str_replace_editor'] as const

const RESEARCHER_LABEL = 'researcher'
const STRUCTURED_REPORT = [
  'Goal: implement the researcher brief for task B',
  'Affected paths: packages/dsh-multitask/round-driver.js',
  'Implementation plan: queue a race-fenced orchestrator handoff',
  'Risks: interrupting task A and unbounded settlement wakes',
  'Recommended claim set: packages/dsh-multitask/round-driver.js'
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
  maxConsecutiveWakes?: number
  enabled?: boolean
}

interface Fixture {
  ctx: Context
  home: string
  calls: ScriptedCall[]
  disposePlugin: () => Promise<void>
  agent(id: string): Promise<Agent>
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-round-driver-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
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

  const mounted = await ctx.plugin(
    multitask as unknown as Parameters<Context['plugin']>[0],
    {
      enabled: options.enabled ?? true,
      maxConsecutiveWakes: options.maxConsecutiveWakes ?? 3
    }
  )
  const disposePlugin = async () => {
    await (mounted as { dispose(): Promise<void> }).dispose()
  }
  pushCore(disposePlugin)

  async function agent(id: string): Promise<Agent> {
    const handle = await ctx.agents.create({
      sessionId: SessionId(id),
      meta: { cwd: home },
      agentOptions: { provider: 'scripted', model: 'orchestrator' }
    })
    pushCore(() => handle.dispose())
    return handle.agent
  }

  return { ctx, home, calls, disposePlugin, agent }
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

function admittedMessages(agent: Agent) {
  return agent.session.deriveMessages()
}

function admittedHandoffs(agent: Agent) {
  return admittedMessages(agent).filter(message => message.source.kind === 'multitask')
}

function queuedHandoffs(agent: Agent) {
  return agent.inbox.nextTurn.filter(message => message.source.kind === 'multitask')
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

function* textChunks(text: string, reason: FinishReason = { kind: 'stop' }): Generator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
  yield { type: 'finish', reason }
}

describe('multitask_round_driver_gate next-boundary handoff', () => {
  it('queues one source-tagged handoff during task A and admits it once at the next boundary', { timeout: 20_000 }, async () => {
    const parentHold = gate()
    const researcherHold = gate()
    const f = await fixture({
      respond: async (call) => {
        if (isResearcherCall(call)) {
          await holdUntil(call.request.signal, researcherHold.promise)
          return STRUCTURED_REPORT
        }
        await holdUntil(call.request.signal, parentHold.promise)
        return userText(call.request).includes('MT-1') ? 'orchestrator received MT-1' : 'task A still running'
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

    const execution = await runCommand(f, agent, '/multitask research and implement task B')
    expect(execution.result).toMatchObject({ kind: 'success' })

    expect(researchEvents(agent).some(event => event.phase === 'researching')).toBe(true)
    expect(agent.status).toBe('running')
    expect(turnCount(agent)).toBe(1)
    expect(userText(f.calls.find(call => !isResearcherCall(call))!.request)).toBe(taskAInput)
    expect(taskAInput).toContain('task A in progress')
    expect(taskAInput).not.toContain('/multitask')

    const queued = queuedHandoffs(agent)
    expect(queued, 'command must queue one orchestrator handoff while task A runs').toHaveLength(1)
    expect(queued[0]!.source).toMatchObject({ kind: 'multitask', taskId: 'MT-1' })
    expect(queued[0]!.content.some(block => block.type === 'text' && block.text.includes('MT-1'))).toBe(true)

    const launchEffects = parentControlEffects(agent, launchSeq)
    expect(launchEffects.filter(event => event.type === 'turn/start')).toHaveLength(0)
    expect(launchEffects.filter(event => /(steer|abort)/iu.test(event.type))).toHaveLength(0)
    expect(admittedHandoffs(agent), 'handoff must not enter history before the next boundary').toHaveLength(0)

    parentHold.open()
    await waitFor(() =>
      f.calls.some(call => !isResearcherCall(call) && userText(call.request).includes('MT-1')),
    'handoff admitted as the next parent turn')
    expect(turnCount(agent)).toBe(2)
    expect(admittedHandoffs(agent)).toHaveLength(1)
    expect(admittedHandoffs(agent)[0]!.source).toMatchObject({ kind: 'multitask', taskId: 'MT-1' })
    expect(f.calls.filter(call => !isResearcherCall(call) && userText(call.request).includes('MT-1'))).toHaveLength(1)

    researcherHold.open()
    await agent.whenIdle()
    expect(admittedHandoffs(agent).filter(message => {
      const source = message.source as { kind: string, taskId?: string }
      return source.kind === 'multitask' && source.taskId === 'MT-1'
        && message.id === queued[0]!.id
    })).toHaveLength(1)
  })
})

describe('multitask_round_driver_gate user-queue wins', () => {
  it('admits interleaved user input first and rejects the stale handoff without leaking it', { timeout: 20_000 }, async () => {
    const parentHold = gate()
    const researcherHold = gate()
    const f = await fixture({
      respond: async (call) => {
        if (isResearcherCall(call)) {
          await holdUntil(call.request.signal, researcherHold.promise)
          return STRUCTURED_REPORT
        }
        await holdUntil(call.request.signal, parentHold.promise)
        return `parent saw: ${userText(call.request)}`
      }
    })
    const agent = await f.agent('session-1')

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'task A in progress' }],
      source: { kind: 'user' }
    }))
    await waitFor(() => f.calls.some(call => !isResearcherCall(call)), 'held task A model call')

    await runCommand(f, agent, '/multitask research and implement task B')
    expect(queuedHandoffs(agent), 'command must queue the handoff before the interleaved user message').toHaveLength(1)
    const handoff = queuedHandoffs(agent)[0]!

    const user = createUserMessage({
      content: [{ type: 'text', text: 'user queued between handoff and boundary' }],
      source: { kind: 'user' }
    })
    agent.followup(user)
    expect(agent.inbox.nextTurn.some(message => message.id === user.id)).toBe(true)
    expect(agent.status).toBe('running')
    expect(turnCount(agent)).toBe(1)

    parentHold.open()
    await waitFor(() =>
      f.calls.some(call => !isResearcherCall(call) && userText(call.request).includes('user queued between handoff and boundary')),
    'interleaved user input admitted')

    const parentTexts = f.calls
      .filter(call => !isResearcherCall(call))
      .map(call => userText(call.request))
    expect(parentTexts.filter(text => text.includes('user queued between handoff and boundary'))).toHaveLength(1)
    expect(parentTexts.some(text => text.includes('task A in progress'))).toBe(true)

    const admittedUser = admittedMessages(agent).filter(message =>
      message.source.kind === 'user' && message.id === user.id)
    expect(admittedUser).toHaveLength(1)
    expect(admittedMessages(agent).filter(message => message.id === handoff.id)).toHaveLength(0)
    expect(admittedHandoffs(agent).some(message => message.id === handoff.id)).toBe(false)
    const surfaced = admittedMessages(agent)
      .map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
      .join('\n')
    expect(surfaced).toContain('user queued between handoff and boundary')
    expect(surfaced).not.toContain(handoff.content.map(block => block.type === 'text' ? block.text : '').join(''))

    researcherHold.open()
    await agent.whenIdle()
    expect(admittedMessages(agent).filter(message => message.id === user.id)).toHaveLength(1)
    expect(admittedMessages(agent).filter(message => message.id === handoff.id)).toHaveLength(0)
  })
})

describe('multitask_round_driver_gate settlement wake bound', () => {
  it('caps consecutive automatic rounds and resets the counter on user input', { timeout: 20_000 }, async () => {
    const f = await fixture({
      maxConsecutiveWakes: 2,
      respond: async (call) => {
        if (isResearcherCall(call)) return STRUCTURED_REPORT
        return `parent ack ${userText(call.request).slice(0, 80)}`
      }
    })
    const agent = await f.agent('session-1')

    await runCommand(f, agent, '/multitask research and implement task B')
    await waitFor(() => researchEvents(agent).some(event => event.phase === 'researched'), 'first researcher settled')
    await waitFor(() => admittedHandoffs(agent).length >= 1, 'command handoff admitted')
    await agent.whenIdle()

    const afterCommand = admittedHandoffs(agent).length
    expect(afterCommand).toBeGreaterThanOrEqual(1)

    for (const label of ['settle-2', 'settle-3']) {
      await f.ctx.subagents.startContinuable({
        provider: 'spawn',
        label,
        request: {
          prompt: [{ type: 'text', text: `do not modify files\nRecommended claim set\nstructured research report ${label}` }],
          parent: agent,
          persona: RESEARCHER_LABEL,
          toolFilter: { deny: ['write', 'edit', 'str_replace_editor'] }
        },
        signal: new AbortController().signal
      })
      await waitFor(() =>
        agent.session.deriveMessages().some(message =>
          message.source.kind === 'subagent-settled'
          && JSON.stringify(message.source).includes(label) === false
        ) || agent.status === 'idle' || agent.status === 'running',
      `${label} child launched`)
    }

    await waitFor(() => agent.status === 'idle' || admittedHandoffs(agent).length >= 2, 'bounded settlement wakes running')
    await agent.whenIdle()

    const automaticAfterSettlements = admittedHandoffs(agent).length
    expect(automaticAfterSettlements, 'instant settlements must not exceed maxConsecutiveWakes').toBeLessThanOrEqual(2)
    expect(automaticAfterSettlements).toBe(2)

    const extraBeforeReset = automaticAfterSettlements
    await f.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'settle-over-bound',
      request: {
        prompt: [{ type: 'text', text: 'do not modify files\nRecommended claim set\nstructured research report over bound' }],
        parent: agent,
        persona: RESEARCHER_LABEL,
        toolFilter: { deny: ['write', 'edit', 'str_replace_editor'] }
      },
      signal: new AbortController().signal
    })
    await agent.whenIdle()
    expect(admittedHandoffs(agent).length, 'a further settlement must not exceed the bound').toBe(extraBeforeReset)

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'user resets the consecutive wake counter' }],
      source: { kind: 'user' }
    }))
    await agent.whenIdle()

    await f.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'settle-after-reset',
      request: {
        prompt: [{ type: 'text', text: 'do not modify files\nRecommended claim set\nstructured research report after reset' }],
        parent: agent,
        persona: RESEARCHER_LABEL,
        toolFilter: { deny: ['write', 'edit', 'str_replace_editor'] }
      },
      signal: new AbortController().signal
    })
    await waitFor(() => admittedHandoffs(agent).length > extraBeforeReset, 'user input resets the wake counter')
    await agent.whenIdle()
    expect(admittedHandoffs(agent).length).toBe(extraBeforeReset + 1)
  })

  it('does not wake for a settlement once the task phase is terminal', { timeout: 20_000 }, async () => {
    const f = await fixture({
      maxConsecutiveWakes: 2,
      respond: async (call) => {
        if (isResearcherCall(call)) return STRUCTURED_REPORT
        return `parent ack ${userText(call.request).slice(0, 80)}`
      }
    })
    const agent = await f.agent('session-1')

    await runCommand(f, agent, '/multitask finish then stay finished')
    await waitFor(() => researchEvents(agent).some(event => event.phase === 'researched'), 'first researcher settled')
    await waitFor(() => admittedHandoffs(agent).length >= 1, 'command handoff admitted')
    await agent.whenIdle()

    agent.session.append('multitask/phase', {
      id: 'MT-1',
      objective: 'finish then stay finished',
      phase: 'done',
      createdAt: new Date().toISOString()
    })

    const beforeTerminal = admittedHandoffs(agent).length
    await f.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'settle-after-done',
      request: {
        prompt: [{ type: 'text', text: 'do not modify files\nRecommended claim set\nstructured research report after done' }],
        parent: agent,
        persona: RESEARCHER_LABEL,
        toolFilter: { deny: ['write', 'edit', 'str_replace_editor'] }
      },
      signal: new AbortController().signal
    })
    await agent.whenIdle()
    expect(admittedHandoffs(agent).length, 'a terminal task must not consume a wake').toBe(beforeTerminal)
    expect(queuedHandoffs(agent), 'a terminal task must not queue a handoff').toHaveLength(0)
  })

  it('disarms pending rounds on max-tokens, abort, and plugin teardown', { timeout: 20_000 }, async () => {
    const parentHold = gate()
    const f = await fixture({
      maxConsecutiveWakes: 3,
      respond: async (call) => {
        if (isResearcherCall(call)) return STRUCTURED_REPORT
        if (userText(call.request).includes('MT-1')) {
          await holdUntil(call.request.signal, parentHold.promise)
          return textChunks('partial orchestrator output', { kind: 'max-tokens' })
        }
        return 'unexpected extra automatic round'
      }
    })
    const agent = await f.agent('session-1')
    await runCommand(f, agent, '/multitask research and implement task B')
    await waitFor(() =>
      f.calls.some(call => !isResearcherCall(call) && userText(call.request).includes('MT-1')),
    'handoff turn opened')
    expect(agent.status).toBe('running')

    parentHold.open()
    await agent.whenIdle()
    const afterMaxTokens = admittedHandoffs(agent).length
    expect(afterMaxTokens).toBe(1)

    await f.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'after-max-tokens',
      request: {
        prompt: [{ type: 'text', text: 'do not modify files\nRecommended claim set\nstructured research report after max-tokens' }],
        parent: agent,
        persona: RESEARCHER_LABEL,
        toolFilter: { deny: ['write', 'edit', 'str_replace_editor'] }
      },
      signal: new AbortController().signal
    })
    await agent.whenIdle()
    expect(admittedHandoffs(agent).length, 'max-tokens must disarm later settlement wakes').toBe(afterMaxTokens)

    const abortHold = gate()
    const abortFixture = await fixture({
      respond: async (call) => {
        if (isResearcherCall(call)) return STRUCTURED_REPORT
        await holdUntil(call.request.signal, abortHold.promise)
        return 'aborted parent'
      }
    })
    const abortAgent = await abortFixture.agent('session-abort')
    abortAgent.followup(createUserMessage({
      content: [{ type: 'text', text: 'task A in progress' }],
      source: { kind: 'user' }
    }))
    await waitFor(() => abortFixture.calls.some(call => !isResearcherCall(call)), 'held abort parent')
    await runCommand(abortFixture, abortAgent, '/multitask abort pending handoff')
    expect(queuedHandoffs(abortAgent).length).toBeGreaterThanOrEqual(1)
    abortAgent.cancel({ kind: 'user' })
    abortHold.open()
    await abortAgent.whenIdle()
    await abortFixture.disposePlugin()
    await abortAgent.whenIdle()
    expect(abortAgent.status).toBe('idle')
    expect(queuedHandoffs(abortAgent)).toHaveLength(0)
    expect(abortAgent.inbox.nextTurn).toHaveLength(0)
  })
})
