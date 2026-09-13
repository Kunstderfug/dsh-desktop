/**
 * t1c-runtime-spike — real-harness composition proof for Multitask/Orchestrator
 * mode (epic #1, spec
 * docs/superpowers/specs/2026-09-13-multitask-orchestrator-mode-research.md
 * §2.1, §2.2, §4.1, §4.2, §5.2).
 *
 * Everything here runs against the installed Harness services in
 * node_modules/@deepseek-ai/*@0.1.5-rc.2: real cordis Context, real agent loop
 * (ReactLoopAgent), real SubagentRuntime continuation manager, real JSONL
 * session persistence. The ONLY stand-in is the model: a scripted LlmAdapter
 * (registered through the real `ctx.llm` adapter registry) that replies with
 * deterministic text and can be gated mid-stream to hold a turn open. The
 * behaviors under test — inbox queueing/steering, continuable spawn,
 * settlement notices, restart durability — are the real runtime code paths.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { type GenerateOptions, LlmAdapter, LlmRuntime, type StreamChunk, type UserMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as subagentSpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Model-visible reply for one scripted model call. */
type Responder = (call: { model: string, request: GenerateOptions }) => string | Promise<string>

/** Text of every user-role message in an assembled request, in order. */
function userText(request: GenerateOptions): string {
  return request.messages
    .filter(message => message.role === 'user')
    .map(message => message.content.map(block => block.type === 'text' ? block.text : `<${block.type}>`).join(''))
    .join('\n')
}

/** Text of a standalone message (inbox rows, appended user messages). */
function messageText(message: { content: UserMessage['content'] }): string {
  return message.content.map(block => block.type === 'text' ? block.text : `<${block.type}>`).join('')
}

/** The runtime-owned settlement source shape (merge-extensible upstream). */
function settledSource(message: { source: { kind: string } }): { senderSessionId: string, summary: string } {
  return message.source as unknown as { senderSessionId: string, summary: string }
}

/** Typed view of one durable inbox splice event (loop-owned vocabulary). */
interface InboxSpliceEvent {
  data: {
    target: 'next-turn' | 'next-step'
    inserted: UserMessage[]
    removedCount?: number
    outcome?: 'canceled'
  }
}

/** The durable splice event that inserted one message into a parent's inbox. */
function spliceFor(parent: Agent, messageId: string): InboxSpliceEvent | undefined {
  return parent.session.snapshotEvents().find(event =>
    event.type === 'agent/inbox/spliced'
    && Array.isArray((event.data as InboxSpliceEvent['data']).inserted)
    && (event.data as InboxSpliceEvent['data']).inserted.some(message => message.id === messageId)) as InboxSpliceEvent | undefined
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

/**
 * Await a gate while honoring the request's abort signal, so a held model
 * stream settles when the turn is cancelled (real adapters honor it too).
 */
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
async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * Scripted MODEL adapter standing in for the provider wire. Registered on the
 * real LlmRuntime via the real `llm.registerAdapter` seam, so the agent loop's
 * `prepareCall`/`stream` path is the production one.
 */
class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly responder: Responder) {
    super()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = await this.responder({ model: options.model, request: options })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface FixtureOptions {
  /** Model script; defaults to a deterministic ack line. */
  respond?: Responder
  /** Existing persistence home to recompose over (restart durability). */
  home?: string
  /**
   * Skip global afterEach registration: the test owns every disposal via
   * `disposeAll`/`disposeCoreSkipping` (crash-style restart scenarios).
   */
  detached?: boolean
}

interface Fixture {
  ctx: Context
  home: string
  /** Scripted model calls in arrival order, tagged by route model id. */
  calls: Array<{ model: string, request: GenerateOptions }>
  /** Create a real loop-driven agent with the scripted model route. */
  agent(id: string, options?: { model?: string }): Promise<Agent>
  /** Early-dispose just the SubagentRuntime fiber (teardown-inject path). */
  disposeSubagents(): Promise<void>
  /** Dispose the whole composed stack now (agents first, then core plugins). */
  disposeAll(): Promise<void>
  /**
   * Dispose core plugin fibers (reverse order) while skipping the named ones
   * — the crash-style restart path skips `loop` so agent disposal (which
   * clears pending inbox durably) never runs.
   */
  disposeCoreSkipping(skip?: string[]): Promise<void>
}

/**
 * Compose the real harness stack in one cordis Context with no model/network:
 * system prompt, session projections + store, tool runtime, LLM runtime with
 * the scripted adapter, JSONL persistence under a tmp home, agent registry +
 * loop, subagent runtime + in-process spawn provider, session query.
 */
async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const home = options.home ?? await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-spike-'))
  if (options.home === undefined) cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()

  // Memoized disposers; named for the core plugins so a crash-style teardown
  // can skip the loop (whose graceful agent disposal clears pending inbox).
  const memo = (dispose: () => Promise<void> | void): (() => Promise<void>) => {
    let settled: Promise<void> | undefined
    return async () => {
      settled ??= (async () => {
        await dispose()
      })()
      await settled
    }
  }
  const core = new Map<string, () => Promise<void>>()
  const agentDisposers: Array<() => Promise<void>> = []
  const pushCore = (name: string, dispose: () => Promise<void> | void) => {
    const once = memo(dispose)
    core.set(name, once)
    if (options.detached !== true) cleanups.push(once)
    return once
  }
  const pushAgent = (dispose: () => Promise<void> | void) => {
    const once = memo(dispose)
    agentDisposers.push(once)
    if (options.detached !== true) cleanups.push(once)
    return once
  }

  const prompt = ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await prompt
  pushCore('prompt', () => prompt.dispose())
  const projections = ctx.plugin(SessionProjectionRegistry)
  await projections
  pushCore('projections', () => projections.dispose())
  const sessions = ctx.plugin(SessionStore)
  await sessions
  pushCore('sessions', () => sessions.dispose())
  const tools = ctx.plugin(ToolRuntime)
  await tools
  pushCore('tools', () => tools.dispose())
  const llm = ctx.plugin(LlmRuntime)
  await llm
  pushCore('llm', () => llm.dispose())
  const persistence = ctx.plugin(JsonlSessionPersistence, { root: home })
  await persistence
  pushCore('persistence', () => persistence.dispose())
  const registry = ctx.plugin(AgentRegistry)
  await registry
  pushCore('registry', () => registry.dispose())

  const calls: Fixture['calls'] = []
  // The scripted MODEL adapter is registered from a plugin with
  // inject: ['llm'] ordering — the llm service must exist before anything
  // effects it (the composition trap from the t1b brief).
  const adapter = ctx.plugin({
    inject: ['llm'],
    apply(pluginCtx: Context) {
      pluginCtx.llm.registerAdapter(['scripted'], new ScriptedAdapter(async (call) => {
        calls.push({ model: call.model, request: call.request })
        return options.respond?.(call) ?? `scripted ack: ${userText(call.request)}`
      }))
    }
  })
  await adapter
  pushCore('adapter', () => adapter.dispose())

  const loop = ctx.plugin(AgentLoop)
  await loop
  pushCore('loop', () => loop.dispose())
  const subagents = ctx.plugin(SubagentRuntime)
  await subagents
  const disposeSubagents = pushCore('subagents', async () => {
    await (subagents as { dispose(): Promise<void> }).dispose()
  })
  // The runtime module exports name/inject/apply but its .d.ts omits them, so
  // cast to the cordis plugin shape for installation.
  const spawn = ctx.plugin(subagentSpawnInProcess as unknown as Parameters<Context['plugin']>[0])
  await spawn
  pushCore('spawn', () => spawn.dispose())
  // Cast to a config-free constructor: the runtime defaults every config
  // field, but the cordis Plugin typing mis-infers the optional Config param.
  const query = ctx.plugin(SessionQueryEngine as unknown as new (ctx: Context) => SessionQueryEngine)
  await query
  pushCore('query', () => query.dispose())

  async function agent(id: string, agentOptions: { model?: string } = {}) {
    const handle = await ctx.agents.create({
      sessionId: SessionId(id),
      meta: { cwd: home },
      agentOptions: { provider: 'scripted', model: agentOptions.model ?? 'orchestrator' }
    })
    pushAgent(() => handle.dispose())
    return handle.agent
  }

  const disposeCoreSkipping = async (skip: string[] = []) => {
    for (const [name, dispose] of [...core].reverse()) {
      if (skip.includes(name)) continue
      await dispose()
    }
  }
  return {
    ctx,
    home,
    calls,
    agent,
    disposeSubagents,
    disposeAll: async () => {
      for (const dispose of [...agentDisposers].reverse()) await dispose()
      await disposeCoreSkipping()
    },
    disposeCoreSkipping
  }
}

/** Spawn one continuable researcher child off a parent through the real seam. */
function spawnResearcher(f: Fixture, parent: Agent, promptText: string) {
  return f.ctx.subagents.startContinuable({
    provider: 'spawn',
    label: 'spike researcher',
    request: {
      prompt: [{ type: 'text', text: promptText }],
      parent,
      agentOptions: { model: 'researcher' }
    },
    signal: new AbortController().signal
  })
}

describe('multitask runtime spike (real harness, scripted model)', () => {
  it('spawns a continuable child through the real runtime: durable child id and catalog listing', async () => {
    const f = await fixture()
    const parent = await f.agent('parent-1')
    expect(parent.status).toBe('idle')

    const start = await spawnResearcher(f, parent, 'research the multitask runtime spike')
    expect(typeof start.childId).toBe('string')
    expect(start.childId).not.toBe(parent.id)
    expect(typeof start.messageId).toBe('string')

    // The child ran its initial turn for real (scripted model call on the
    // researcher route), then settled: its activation ended and the durable
    // catalog lists it under the parent.
    await waitFor(() => f.ctx.agents.get(start.childId) === undefined, 'child activation to settle')
    const children = await f.ctx.subagents.listChildren(parent.id)
    expect(children).toHaveLength(1)
    const child = children[0]
    expect(child).toMatchObject({ kind: 'child', id: start.childId, mode: 'continuable', label: 'spike researcher' })
    expect(child).property('activity', 'inactive')
    expect(f.calls.some(call => call.model === 'researcher' && userText(call.request).includes('research the multitask runtime spike'))).toBe(true)
  })

  it('wakes an idle parent with the settlement notice and the parent consumes it as its own turn', async () => {
    const f = await fixture()
    const parent = await f.agent('parent-1')
    expect(turnCount(parent)).toBe(0)

    const start = await spawnResearcher(f, parent, 'research the multitask runtime spike')

    // The runtime delivered the settlement notice into the parent's session.
    await waitFor(() => parent.session.deriveMessages().some(message => message.source.kind === 'subagent-settled'), 'settlement notice in parent session')
    const notice = parent.session.deriveMessages().find(message => message.source.kind === 'subagent-settled')
    expect(notice).toBeDefined()
    expect(notice!.source).toMatchObject({ kind: 'subagent-settled', form: 'notice', senderSessionId: start.childId })
    expect(JSON.stringify(notice!.source)).toContain('finished and will do no further work')
    // The notice carries the child's closing message for the orchestrator.
    expect(messageText(notice!)).toContain('Its closing message:')

    // Idle parent ⇒ the notice was delivered as queue (next-turn splice).
    const splice = spliceFor(parent, notice!.id)
    expect(splice).toBeDefined()
    expect(splice!.data.target).toBe('next-turn')

    // And the wake is real: the parent started and finished a turn on it with
    // no test-driven kick.
    await waitFor(() => turnCount(parent) >= 1, 'parent wake turn')
    await parent.whenIdle()
    expect(parent.status).toBe('idle')
    expect(turnCount(parent)).toBe(1)
    const wakeCall = f.calls.find(call => call.model === 'orchestrator')
    expect(wakeCall).toBeDefined()
    expect(userText(wakeCall!.request)).toContain('finished and will do no further work')
  })

  it('leaves a running turn untouched by a queued followup and consumes it at the turn boundary', async () => {
    const step1 = gate()
    let orchestratorCalls = 0
    const f = await fixture({
      respond: async (call) => {
        if (call.model !== 'orchestrator') return 'researcher findings: ready'
        orchestratorCalls += 1
        if (orchestratorCalls === 1) await holdUntil(call.request.signal, step1.promise)
        return `parent ack ${orchestratorCalls}`
      }
    })
    const parent = await f.agent('parent-1')

    // Start task A: a plain user turn that the scripted model holds open.
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'task A in progress' }],
      source: { kind: 'user' }
    }))
    await waitFor(() => f.calls.some(call => call.model === 'orchestrator'), 'held turn 1 model call')
    expect(parent.status).toBe('running')
    expect(turnCount(parent)).toBe(1)

    // /multitask-style host dispatch: queue the handoff WITHOUT interrupting.
    const handoff = createUserMessage({
      content: [{ type: 'text', text: 'handoff MT-1: orchestrate task B' }],
      source: { kind: 'user' }
    })
    parent.followup(handoff)

    // Still inside turn 1: no new turn, and no model request has seen the
    // handoff; it is parked in the durable next-turn queue.
    expect(parent.status).toBe('running')
    expect(turnCount(parent)).toBe(1)
    expect(f.calls.every(call => !userText(call.request).includes('handoff MT-1'))).toBe(true)
    expect(parent.inbox.nextTurn.some(message => message.id === handoff.id)).toBe(true)
    const queuedSplice = spliceFor(parent, handoff.id)
    expect(queuedSplice).toBeDefined()
    expect(queuedSplice!.data.target).toBe('next-turn')

    // Release the held step: turn 1 finishes, then the loop consumes the
    // queued handoff as turn 2 on its own (followup → next-turn → kick loop).
    step1.open()
    await parent.whenIdle()
    expect(parent.status).toBe('idle')
    expect(turnCount(parent)).toBe(2)
    const handoffCall = f.calls.find(call => userText(call.request).includes('handoff MT-1'))
    expect(handoffCall).toBeDefined()
    // The handoff was admitted as its own turn's user input, not spliced into
    // the running turn's request.
    expect(handoffCall).not.toBe(f.calls[0])
    expect(parent.session.deriveMessages().some(message =>
      message.source.kind === 'user' && message.id === handoff.id)).toBe(true)
  })

  it('steers the settlement notice into a running turn at the next step boundary', async () => {
    const step1 = gate()
    let orchestratorCalls = 0
    const f = await fixture({
      respond: async (call) => {
        if (call.model !== 'orchestrator') return 'researcher findings: ready'
        orchestratorCalls += 1
        if (orchestratorCalls === 1) await holdUntil(call.request.signal, step1.promise)
        return `parent ack ${orchestratorCalls}`
      }
    })
    const parent = await f.agent('parent-1')
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'task A in progress' }],
      source: { kind: 'user' }
    }))
    await waitFor(() => f.calls.some(call => call.model === 'orchestrator'), 'held turn 1 model call')
    expect(parent.status).toBe('running')

    // The child settles WHILE the parent's turn is running.
    const start = await spawnResearcher(f, parent, 'research the multitask runtime spike')
    await waitFor(() => {
      return parent.session.snapshotEvents().some(event =>
        event.type === 'agent/inbox/spliced'
        && Array.isArray((event.data as InboxSpliceEvent['data']).inserted)
        && (event.data as InboxSpliceEvent['data']).inserted.some(message => message.source.kind === 'subagent-settled'))
    }, 'steered settlement splice while running')
    const steeredSplice = parent.session.snapshotEvents().map(event =>
      event.type === 'agent/inbox/spliced' ? event as InboxSpliceEvent : undefined)
      .find(splice => splice?.data.inserted.some(message => message.source.kind === 'subagent-settled'))
    expect(steeredSplice).toBeDefined()
    expect(steeredSplice!.data.target).toBe('next-step')
    const steeredNotice = steeredSplice!.data.inserted.find(message => message.source.kind === 'subagent-settled')
    expect(settledSource(steeredNotice!).senderSessionId).toBe(start.childId)

    // Release the held step: the SAME turn continues with a further step that
    // consumes the steered notice — no second turn, no idle gap.
    step1.open()
    await parent.whenIdle()
    expect(parent.status).toBe('idle')
    expect(turnCount(parent)).toBe(1)
    const parentCalls = f.calls.filter(call => call.model === 'orchestrator')
    expect(parentCalls).toHaveLength(2)
    expect(userText(parentCalls[1]!.request)).toContain('finished and will do no further work')
    expect(parent.session.deriveMessages().some(message =>
      message.source.kind === 'subagent-settled' && message.source.senderSessionId === start.childId)).toBe(true)
  })

  it('injects the settlement notice without waking a turn while the runtime tears down', async () => {
    const research = gate()
    const f = await fixture({
      respond: async (call) => {
        if (call.model === 'researcher') await holdUntil(call.request.signal, research.promise)
        return `ack for ${call.model}`
      }
    })
    const parent = await f.agent('parent-1')
    const start = await spawnResearcher(f, parent, 'research the multitask runtime spike')
    await waitFor(() => f.calls.some(call => call.model === 'researcher'), 'held child model call')
    expect(f.ctx.agents.get(start.childId)).toBeDefined()
    expect(turnCount(parent)).toBe(0)

    // Tear the subagent runtime down while the child's turn is in flight.
    await f.disposeSubagents()

    // The activation drained; the settlement notice was INJECTED into the
    // parent's next-step inbox — delivered, but never woken into a turn.
    await waitFor(() => parent.inbox.nextStep.some(message => message.source.kind === 'subagent-settled'), 'injected settlement notice')
    expect(parent.status).toBe('idle')
    expect(turnCount(parent)).toBe(0)
    expect(f.calls.filter(call => call.model === 'orchestrator')).toHaveLength(0)
    // Injection splices the inbox; nothing was appended to the parent's log.
    expect(parent.session.deriveMessages().some(message => message.source.kind === 'subagent-settled')).toBe(false)
    const injected = parent.inbox.nextStep.find(message => message.source.kind === 'subagent-settled')
    expect(settledSource(injected!).senderSessionId).toBe(start.childId)
    research.open()
  })

  it('restores parent, queued handoff, and continuable child from the persisted home after a crash-style restart', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-spike-restart-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const step1 = gate()
    let orchestratorCalls = 0
    let childId: SessionId | undefined
    const handoff = createUserMessage({
      content: [{ type: 'text', text: 'handoff MT-1: orchestrate task B' }],
      source: { kind: 'user' }
    })
    {
      // Session 1 (detached — the test owns disposal): run a held turn, queue
      // a handoff behind it, let a child settle while running (steered
      // notice), cancel keeping the inbox, then shut down WITHOUT the
      // graceful loop disposal (which would durably clear pending input).
      const f = await fixture({
        home,
        detached: true,
        respond: async (call) => {
          if (call.model !== 'orchestrator') return 'researcher findings: ready'
          orchestratorCalls += 1
          if (orchestratorCalls === 1) await holdUntil(call.request.signal, step1.promise)
          return `parent ack ${orchestratorCalls}`
        }
      })
      const parent = await f.agent('parent-1')
      parent.followup(createUserMessage({
        content: [{ type: 'text', text: 'task A in progress' }],
        source: { kind: 'user' }
      }))
      await waitFor(() => f.calls.some(call => call.model === 'orchestrator'), 'session-1 held turn')
      parent.followup(handoff)
      const start = await spawnResearcher(f, parent, 'research the multitask runtime spike')
      childId = start.childId
      await waitFor(() => {
        return parent.session.snapshotEvents().some(event =>
          event.type === 'agent/inbox/spliced'
          && Array.isArray(event.data.inserted)
          && event.data.inserted.some(message => message.source.kind === 'subagent-settled'))
      }, 'session-1 steered settlement splice')
      parent.cancel({ kind: 'user' }, { keepInbox: true })
      await parent.whenIdle()
      expect(parent.inbox.nextTurn.some(message => message.id === handoff.id)).toBe(true)
      expect(parent.inbox.nextStep.some(message => message.source.kind === 'subagent-settled')).toBe(true)
      // Crash-style shutdown: dispose only fibers the agent loop does not
      // depend on. Cordis tears down dependent fibers when a service they
      // inject disappears — disposing `registry`/`sessions`/`llm`/`tools`/
      // `prompt`/`projections` would cascade to the loop fiber, whose
      // graceful agent disposal clears pending inbox durably. The persistence
      // disposal drains every routed buffer to disk.
      await f.disposeCoreSkipping(['loop', 'registry', 'sessions', 'projections', 'prompt', 'tools', 'llm'])
    }
    expect(childId).toBeDefined()
    const settledChildId = childId!

    // Session 2: recompose over the same home and resume the parent.
    const f2 = await fixture({
      home,
      respond: async (call) => call.model === 'orchestrator' ? 'parent ack after restart' : 'researcher findings: round 2'
    })
    const handle = await f2.ctx.agents.resume({
      resumeSessionId: SessionId('parent-1'),
      agentOptions: { provider: 'scripted', model: 'orchestrator' }
    })
    const parent2 = handle.agent
    cleanups.push(() => handle.dispose())

    // The durable inbox fold restored BOTH pending inputs from the log.
    expect(parent2.inbox.nextTurn.some(message => message.id === handoff.id)).toBe(true)
    expect(parent2.inbox.nextStep.some(message => message.source.kind === 'subagent-settled' && settledSource(message).senderSessionId === childId)).toBe(true)

    // The child is durably discoverable without loading it.
    const children = await f2.ctx.subagents.listChildren(SessionId('parent-1'))
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ kind: 'child', id: childId, mode: 'continuable', label: 'spike researcher' })
    expect(children[0]).property('activity', 'inactive')

    // The next wake consumes the durable backlog first: notice + handoff.
    parent2.followup(createUserMessage({
      content: [{ type: 'text', text: 'resume after restart' }],
      source: { kind: 'user' }
    }))
    await parent2.whenIdle()
    expect(parent2.status).toBe('idle')
    const parent2Calls = f2.calls.filter(call => call.model === 'orchestrator')
    expect(parent2Calls.length).toBeGreaterThanOrEqual(1)
    expect(userText(parent2Calls[0]!.request)).toContain('finished and will do no further work')
    expect(userText(parent2Calls[0]!.request)).toContain('handoff MT-1: orchestrate task B')

    // The settled child cold-resumes from persistence when the parent
    // messages it through the real seam, runs the new prompt, and settles
    // again with a fresh notice.
    await f2.ctx.subagents.sendMessage(parent2, settledChildId, [{ type: 'text', text: 'follow-up question for the researcher' }], {
      signal: new AbortController().signal
    })
    await waitFor(() => f2.calls.some(call => call.model === 'researcher' && userText(call.request).includes('follow-up question for the researcher')), 'cold-resumed child model call')
    await waitFor(() => {
      return parent2.session.deriveMessages().filter(message =>
        message.source.kind === 'subagent-settled' && settledSource(message).senderSessionId === settledChildId).length >= 2
    }, 'second settlement notice after cold resume')
    await parent2.whenIdle()
  })

  it('documents the graceful-teardown nuance: a graceful agent disposal clears pending inbox durably', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-spike-graceful-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const step1 = gate()
    let orchestratorCalls = 0
    const handoff = createUserMessage({
      content: [{ type: 'text', text: 'handoff MT-2: queued when the app closed' }],
      source: { kind: 'user' }
    })
    {
      const f = await fixture({
        home,
        detached: true,
        respond: async (call) => {
          if (call.model !== 'orchestrator') return 'researcher findings: ready'
          orchestratorCalls += 1
          if (orchestratorCalls === 1) await holdUntil(call.request.signal, step1.promise)
          return `parent ack ${orchestratorCalls}`
        }
      })
      const parent = await f.agent('parent-1')
      parent.followup(createUserMessage({
        content: [{ type: 'text', text: 'task A in progress' }],
        source: { kind: 'user' }
      }))
      await waitFor(() => f.calls.some(call => call.model === 'orchestrator'), 'graceful-case held turn')
      parent.followup(handoff)
      expect(parent.inbox.nextTurn.some(message => message.id === handoff.id)).toBe(true)
      // Graceful full teardown (agent disposal included, exactly like the
      // afterEach path or an app quit): pending inbox is durably cleared.
      await f.disposeAll()
    }

    const f2 = await fixture({
      home,
      respond: async (call) => call.model === 'orchestrator' ? 'parent ack after graceful restart' : 'researcher ack'
    })
    const handle = await f2.ctx.agents.resume({
      resumeSessionId: SessionId('parent-1'),
      agentOptions: { provider: 'scripted', model: 'orchestrator' }
    })
    const parent2 = handle.agent
    cleanups.push(() => handle.dispose())
    // The queued handoff did NOT survive the graceful teardown: the clearing
    // splices are durable session events, and the fold honors them.
    expect(parent2.inbox.nextTurn.some(message => message.id === handoff.id)).toBe(false)
    expect(parent2.inbox.nextTurn).toHaveLength(0)
    expect(parent2.inbox.nextStep).toHaveLength(0)
    // And the clearing is observable in the durable log itself.
    const events = parent2.session.snapshotEvents()
    const clearing = events.filter(event =>
      event.type === 'agent/inbox/spliced'
      && event.data.removedCount !== undefined
      && event.data.outcome === 'canceled')
    expect(clearing.length).toBeGreaterThanOrEqual(1)
  })
})
