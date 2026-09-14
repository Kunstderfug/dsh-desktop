/**
 * [multitask] issue #4 — the `/multitask` command handler + `multitask/task`
 * session events.
 *
 * Real-harness composition, following the multitask-runtime spike precedent
 * (test/spikes/multitask-runtime/): real cordis Context, real
 * `@deepseek-ai/dsh-commands` CommandRuntime, real agent registry + loop, and
 * real JSONL session persistence. The ONLY stand-ins are (a) the scripted
 * model adapter on the real `ctx.llm` registry seam — the provider wire — and
 * (b) a minimal in-memory AttachmentStore backend for the attachment-admission
 * test; the command registry, the lifecycle logging, the session log fold,
 * and the plugin under test are all the production code paths.
 *
 * The behaviors under test are the issue's acceptance clauses: registration
 * for the composer menu, per-session MT-n identity minted by folding the
 * session log, the frozen `multitask/task` event shape, empty-objective
 * validation, attachment admission, busy-turn non-interruption, and the
 * `command/run` → `multitask/task` → `command/done` lifecycle pairing.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AttachmentStore, { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment
} from '@deepseek-ai/dsh-attachment'
import Commands from '@deepseek-ai/dsh-commands'
import type { CommandSubmitAttachment } from '@deepseek-ai/dsh-commands'
import {
  createUserMessage,
  type GenerateOptions,
  LlmAdapter,
  LlmRuntime,
  type StreamChunk
} from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as multitask from '../packages/dsh-multitask/index.js'

/** The exact definition the plugin registers (issue input grammar). */
const MULTITASK_DESCRIPTOR = {
  name: 'multitask',
  input: { hint: '<objective>', attachments: true }
}

/** One 1×1 canonical-base64 PNG used as an admitted attachment payload. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Scripted MODEL adapter standing in for the provider wire (spike precedent). */
class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly respond: (call: { request: GenerateOptions }) => Promise<string>) {
    super()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = await this.respond({ request: options })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface FixtureOptions {
  /** Model reply for one scripted orchestrator call. */
  respond?: (call: { request: GenerateOptions }) => Promise<string>
  /** Existing persistence home to recompose over (restart fold). */
  home?: string
  /** Compose the in-memory attachment store (admission test). */
  attachments?: boolean
  /** Skip global afterEach registration (restart fold owns disposal). */
  detached?: boolean
}

interface Fixture {
  ctx: Context
  home: string
  /** Scripted model calls in arrival order. */
  calls: Array<{ request: GenerateOptions }>
  /** Create a real loop-driven agent on the scripted model route. */
  agent(id: string): Promise<Agent>
  /** Graceful full teardown: agents first, then core plugins. */
  disposeAll(): Promise<void>
}

/**
 * Compose the real harness stack in one cordis Context with no network: the
 * spike's mounting order, plus the real `commands` runtime and the
 * `dsh-multitask` plugin mounted exactly as the desktop loader would (module
 * namespace with name/inject/apply).
 */
async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const home = options.home ?? (await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-command-')))
  if (options.home === undefined && !options.detached) {
    cleanups.push(() => rm(home, { recursive: true, force: true }))
  }
  const ctx = new Context()

  // Memoized disposers, disposed in reverse installation order (agents are
  // installed last, so they unwind first — the spike's teardown order).
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
    if (!options.detached) cleanups.push(once)
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

  const calls: Fixture['calls'] = []
  if (options.attachments === true) {
    const store = await ctx.plugin(MemoryAttachmentStore)
    pushCore(() => store.dispose())
  }
  // The scripted MODEL adapter registers through the real `llm.registerAdapter`
  // seam from an llm-injected plugin — the composition trap from the spike.
  const adapter = await ctx.plugin({
    inject: ['llm'],
    apply(pluginCtx: Context) {
      pluginCtx.llm.registerAdapter(['scripted'], new ScriptedAdapter(async (call) => {
        calls.push({ request: call.request })
        return options.respond?.(call) ?? `scripted ack: ${call.request.model}`
      }))
    }
  })
  pushCore(() => adapter.dispose())

  const loop = await ctx.plugin(AgentLoop)
  pushCore(() => loop.dispose())

  // The owner plugin, mounted through its real module namespace.
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
    calls,
    agent,
    disposeAll: async () => {
      for (const dispose of [...disposers].reverse()) await dispose()
    }
  }
}

/**
 * Minimal in-memory attachment backend. Storage edge stand-in only: the
 * admission path under test (`CommandRuntime.execute` → `admitEncodedImages`)
 * is the real upstream code.
 */
class MemoryAttachmentStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 1_000_000,
    maxImagesPerMessage: 4,
    maxMessageImageBytes: 1_000_000,
    maxImagePixels: 1_000_000,
    maxImageDimension: 4_096,
    mediaTypes: ['image/png']
  }

  override async validateImage(): Promise<void> {}

  override async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return {
      attachmentId: AttachmentId('mem-1'),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...(input.name === undefined ? {} : { name: input.name })
    }
  }

  override async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    return { ref, data: new Uint8Array([0x89, 0x50]) }
  }
}

/** Text of every user-role message in an assembled request, in order. */
function userText(request: GenerateOptions): string {
  return request.messages
    .filter(message => message.role === 'user')
    .map(message => message.content.map(block => block.type === 'text' ? block.text : `<${block.type}>`).join(''))
    .join('\n')
}

/** The multitask/task events of a session log, in order. */
function multitaskTaskEvents(agent: Agent): Array<{ id: string, objective: string, phase: 'queued', createdAt: string }> {
  return agent.session
    .snapshotEvents()
    .filter(event => event.type === 'multitask/task')
    .map(event => event.data)
}

/** The command/run events of a session log for one command name, in order. */
function commandRunEvents(agent: Agent, name: string): Array<{ commandId: string, name: string, args?: string }> {
  return agent.session
    .snapshotEvents()
    .filter((event): event is Extract<SessionEvent, { type: 'command/run' }> =>
      event.type === 'command/run' && event.data.name === name)
    .map(event => event.data)
}

/** The command/done events of a session log, in order. */
function commandDoneEvents(agent: Agent): Array<{ commandId: string, kind: 'success' | 'error', text?: string }> {
  return agent.session
    .snapshotEvents()
    .filter(event => event.type === 'command/done')
    .map(event => event.data)
}

/** Count durable turn starts in a session log. */
function turnCount(agent: Agent): number {
  return agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length
}

/** Create a manually released gate. */
function gate(): { promise: Promise<void>, open: () => void } {
  let release!: () => void
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, open: release }
}

/** Await a gate while honoring the request's abort signal (spike precedent). */
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

/** Await a condition with a deadline; the loop drivers are asynchronous. */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Run one slash line through the real runtime against the agent. */
async function runCommand(f: Fixture, agent: Agent, line: string, attachments: readonly CommandSubmitAttachment[] = []) {
  const execution = await f.ctx.commands.execute(agent, line, attachments, new AbortController().signal)
  expect(execution).toBeDefined()
  return execution!
}

describe('multitask command registration', () => {
  it('registers /multitask with the issue input grammar for the composer menu', async () => {
    const f = await fixture()
    const agent = await f.agent('session-1')

    const descriptor = f.ctx.commands.list(agent).find(command => command.name === 'multitask')
    expect(descriptor).toBeDefined()
    expect(descriptor!.description).toContain('multitask')
    expect(descriptor!.input).toMatchObject(MULTITASK_DESCRIPTOR.input)
    expect(descriptor!.input!.hint).toBe('<objective>')
    expect(descriptor!.input!.attachments).toBe(true)

    const definition = f.ctx.commands.find(agent, 'multitask')
    expect(definition).toBeDefined()
    expect(typeof definition!.handler).toBe('function')
  })
})

describe('multitask task identity and event shape', () => {
  it('mints MT-1 then MT-2 in one session by folding the session log', async () => {
    const f = await fixture()
    const agent = await f.agent('session-1')

    const first = await runCommand(f, agent, '/multitask research the fold minting')
    expect(first.result).toMatchObject({ kind: 'success' })
    const second = await runCommand(f, agent, '/multitask implement the fold minting')
    expect(second.result).toMatchObject({ kind: 'success' })

    const tasks = multitaskTaskEvents(agent)
    expect(tasks).toHaveLength(2)
    expect(tasks[0]!.id).toBe('MT-1')
    expect(tasks[1]!.id).toBe('MT-2')
  })

  it('appends exactly the frozen event shape with an ISO createdAt', async () => {
    const f = await fixture()
    const agent = await f.agent('session-1')
    const objective = 'research the frozen event shape'

    await runCommand(f, agent, `/multitask ${objective}`)

    const tasks = multitaskTaskEvents(agent)
    expect(tasks).toHaveLength(1)
    const task = tasks[0]!
    expect(Object.keys(task).sort()).toEqual(['createdAt', 'id', 'objective', 'phase'])
    expect(task.id).toBe('MT-1')
    expect(task.objective).toBe(objective)
    expect(task.phase).toBe('queued')
    expect(() => new Date(task.createdAt).toISOString()).not.toThrow()
    expect(new Date(task.createdAt).getTime()).not.toBeNaN()
  })

  it('continues the ordinal from the persisted log, not process memory', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-command-restart-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    {
      const f = await fixture({ home, detached: true })
      const agent = await f.agent('session-1')
      await runCommand(f, agent, '/multitask first task before restart')
      await runCommand(f, agent, '/multitask second task before restart')
      const before = multitaskTaskEvents(agent)
      expect(before.map(task => task.id)).toEqual(['MT-1', 'MT-2'])
      // Graceful full teardown drains every persistence buffer to disk.
      await f.disposeAll()
    }

    const f2 = await fixture({ home })
    const handle = await f2.ctx.agents.resume({
      resumeSessionId: SessionId('session-1'),
      agentOptions: { provider: 'scripted', model: 'orchestrator' }
    })
    cleanups.push(() => handle.dispose())

    const execution = await runCommand(f2, handle.agent, '/multitask first task after restart')
    expect(execution.result).toMatchObject({ kind: 'success' })
    expect(multitaskTaskEvents(handle.agent).map(task => task.id)).toEqual(['MT-1', 'MT-2', 'MT-3'])
  })
})

describe('multitask command validation', () => {
  it('rejects an empty objective with usage guidance and no multitask/task event', async () => {
    const f = await fixture()
    const agent = await f.agent('session-1')

    for (const line of ['/multitask', '/multitask   ']) {
      const execution = await runCommand(f, agent, line)
      expect(execution.result.kind).toBe('error')
      expect(execution.result.kind === 'error' && execution.result.text).toContain('Usage:')
    }

    expect(multitaskTaskEvents(agent)).toHaveLength(0)
    // The runtime still recorded each attempt's lifecycle pair.
    expect(commandRunEvents(agent, 'multitask')).toHaveLength(2)
    expect(commandDoneEvents(agent).map(done => done.kind)).toEqual(['error', 'error'])
  })
})

describe('multitask attachment admission', () => {
  it('admits an image attachment for a declaring invocation and settles the objective', async () => {
    const f = await fixture({ attachments: true })
    const agent = await f.agent('session-1')

    const execution = await runCommand(f, agent, '/multitask research the attached picture', [
      { type: 'image', mediaType: 'image/png', data: PNG_1X1 }
    ])
    expect(execution.result).toMatchObject({ kind: 'success' })

    const tasks = multitaskTaskEvents(agent)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.objective).toBe('research the attached picture')
    // The handler owns no further attachment grammar in this ticket: nothing
    // attachment-derived reaches the log beyond the queued task event.
    const logged = JSON.stringify(agent.session.snapshotEvents().map(event => event.type))
    expect(logged).not.toContain('user/message')
  })
})

describe('multitask busy-turn non-interruption', () => {
  it('executes host-side while a turn runs and changes nothing about that turn', async () => {
    const step1 = gate()
    let orchestratorCalls = 0
    const f = await fixture({
      respond: async (call) => {
        orchestratorCalls += 1
        if (orchestratorCalls === 1) await holdUntil(call.request.signal, step1.promise)
        return `parent ack ${orchestratorCalls}`
      }
    })
    const agent = await f.agent('session-1')

    // Start task A: a plain user turn the scripted model holds open.
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'task A in progress' }],
      source: { kind: 'user' }
    }))
    await waitFor(() => f.calls.length === 1, 'held turn 1 model call')
    expect(agent.status).toBe('running')
    expect(turnCount(agent)).toBe(1)

    // Issue the command while the agent is busy.
    const execution = await runCommand(f, agent, '/multitask research task B objective')
    expect(execution.result).toMatchObject({ kind: 'success' })

    // The running turn is untouched: no new turn, no interrupt, and the
    // command is nowhere in the model's input or the durable inbox.
    expect(agent.status).toBe('running')
    expect(turnCount(agent)).toBe(1)
    expect(f.calls).toHaveLength(1)
    expect(userText(f.calls[0]!.request)).not.toContain('/multitask')
    expect(userText(f.calls[0]!.request)).not.toContain('research task B objective')
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(agent.inbox.nextStep).toHaveLength(0)
    expect(multitaskTaskEvents(agent).map(task => task.id)).toEqual(['MT-1'])

    // Release the held step: turn 1 finishes on its original input; the
    // command started no follow-up turn.
    step1.open()
    await agent.whenIdle()
    expect(agent.status).toBe('idle')
    expect(turnCount(agent)).toBe(1)
    expect(f.calls).toHaveLength(1)
    // The command line never became model-visible history.
    const surfaced = agent.session.deriveMessages()
      .map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
      .join('\n')
    expect(surfaced).not.toContain('/multitask')
    expect(surfaced).not.toContain('research task B objective')
  })
})

describe('multitask command lifecycle pairing', () => {
  it('logs command/run, multitask/task, command/done in order under one pairing id', async () => {
    const f = await fixture()
    const agent = await f.agent('session-1')

    const execution = await runCommand(f, agent, '/multitask research the lifecycle pairing')
    expect(execution.result).toMatchObject({ kind: 'success' })

    const events = agent.session.snapshotEvents()
    const runIndex = events.findIndex(event => event.type === 'command/run' && event.data.name === 'multitask')
    const taskIndex = events.findIndex(event => event.type === 'multitask/task')
    const doneIndex = events.findIndex(event => event.type === 'command/done' && event.data.commandId === execution.commandId)
    expect(runIndex).toBeGreaterThanOrEqual(0)
    expect(taskIndex).toBeGreaterThan(runIndex)
    expect(doneIndex).toBeGreaterThan(taskIndex)

    const run = events[runIndex]!
    expect(run.type === 'command/run' && run.data.args).toBe(' research the lifecycle pairing')
    expect(run.type === 'command/run' && run.data.commandId).toBe(execution.commandId)

    const done = events[doneIndex]!
    expect(done.type === 'command/done' && done.data.kind).toBe('success')

    // The success text card names the id, the phase, and what happens next.
    const text = execution.result.kind === 'success' ? execution.result.text : undefined
    expect(text).toContain('MT-1')
    expect(text).toContain('queued')
    expect(text).toContain('research')
    expect(text).toContain('implementation')
    expect(text).toContain('orchestrator')
  })
})
