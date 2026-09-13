/**
 * t1 corrections — scratch debug-plugin spec (review round 1, P2 finding).
 *
 * The ticket's Tasks bullet 1 asks for a scratch cordis plugin that registers
 * a debug command whose handler (a) spawns a continuable child host-side via
 * `ctx.subagents.startContinuable` and (b) queues a followup on the parent via
 * `agent.followup`. That plugin now exists as `/tmp/mt-t1-debug-pkg`
 * (`mt-t1-debug`, installed into this worktree's node_modules with
 * `npm install --no-save --install-links`; never committed). This spec
 * composes the REAL harness in-process — real command registry
 * (`@deepseek-ai/dsh-commands`), real agent loop, real subagent runtime +
 * in-process spawn provider, real JSONL persistence — installs the scratch
 * plugin the way the loader would (name/inject/apply), and drives the
 * command through the registry's real dispatch path
 * (`ctx.commands.execute(agent, '/mt-t1-debug …', [], signal)`).
 *
 * The only stand-in is the model: a scripted `LlmAdapter` on the real
 * `llm.registerAdapter` seam (same approach as
 * `multitask-runtime-spike.test.ts`). Spawn, inbox queueing, command
 * lifecycle events, settlement, and wake are the production code paths.
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
import type { CommandExecution } from '@deepseek-ai/dsh-commands'
import { type GenerateOptions, createUserMessage, LlmAdapter, LlmRuntime, type StreamChunk } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as subagentSpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as scratchPlugin from 'mt-t1-debug'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Text of every user-role message in an assembled request, in order. */
function userText(request: GenerateOptions): string {
  return request.messages
    .filter(message => message.role === 'user')
    .map(message => message.content.map(block => block.type === 'text' ? block.text : `<${block.type}>`).join(''))
    .join('\n')
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

/** Count durable turn starts in a session log. */
function turnCount(agent: Agent): number {
  return agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length
}

/** The settlement message under observation, if delivered. */
function settlementNotices(agent: Agent) {
  return agent.session.deriveMessages().filter(message => message.source.kind === 'subagent-settled')
}

class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly record: (request: GenerateOptions) => void) {
    super()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.record(options)
    const text = `scripted ack: ${userText(options).slice(0, 120)}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Compose the real harness plus the commands registry and the scratch
 * plugin. Identical composition order to multitask-runtime-spike.test.ts,
 * with `CommandRuntime` installed before the scratch plugin's apply().
 */
async function fixture(): Promise<{ ctx: Context, home: string, calls: Array<{ model: string, request: GenerateOptions }>, agent: (id: string) => Promise<Agent> }> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-mt-t1-debug-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  const installs: Array<{ dispose: () => Promise<void> | void }> = []
  const track = <T extends { dispose(): Promise<void> | void }>(handle: T): T => {
    installs.push(handle)
    return handle
  }

  const prompt = track(ctx.plugin(SystemPrompt, { includeHarnessIdentity: false }))
  await prompt
  const projections = track(ctx.plugin(SessionProjectionRegistry))
  await projections
  const sessions = track(ctx.plugin(SessionStore))
  await sessions
  const tools = track(ctx.plugin(ToolRuntime))
  await tools
  const llm = track(ctx.plugin(LlmRuntime))
  await llm
  const persistence = track(ctx.plugin(JsonlSessionPersistence, { root: home }))
  await persistence
  const registry = track(ctx.plugin(AgentRegistry))
  await registry

  const calls: Array<{ model: string, request: GenerateOptions }> = []
  const adapter = track(ctx.plugin({
    inject: ['llm'],
    apply(pluginCtx: Context) {
      pluginCtx.llm.registerAdapter(['scripted'], new ScriptedAdapter(request => {
        calls.push({ model: request.model, request })
      }))
    }
  }))
  await adapter

  const loop = track(ctx.plugin(AgentLoop))
  await loop
  const subagents = track(ctx.plugin(SubagentRuntime))
  await subagents
  const spawn = track(ctx.plugin(subagentSpawnInProcess as unknown as Parameters<Context['plugin']>[0]))
  await spawn
  const query = track(ctx.plugin(SessionQueryEngine as unknown as new (ctx: Context) => SessionQueryEngine))
  await query
  // The real human-command registry, as the desktop bundle mounts it.
  const commands = track(ctx.plugin(Commands))
  await commands
  // The scratch plugin, installed exactly as the profile loader would:
  // name/inject/apply with `inject: ['commands', 'subagents']`.
  const plugin = track(ctx.plugin({
    inject: scratchPlugin.inject,
    apply(pluginCtx: Context) {
      scratchPlugin.apply(pluginCtx)
    }
  }))
  await plugin
  for (const handle of installs) cleanups.push(() => handle.dispose())

  async function agent(id: string): Promise<Agent> {
    const handle = await ctx.agents.create({
      sessionId: SessionId(id),
      meta: { cwd: home },
      agentOptions: { provider: 'scripted', model: 'orchestrator' }
    })
    cleanups.push(() => handle.dispose())
    return handle.agent
  }

  return { ctx, home, calls, agent }
}

describe('scratch debug plugin (real harness + real command registry, scripted model)', () => {
  it('registers /mt-t1-debug on the real registry and lists its descriptor', { timeout: 30_000 }, async () => {
    const f = await fixture()
    const parent = await f.agent('parent-1')
    const descriptors = f.ctx.commands.list(parent)
    const mine = descriptors.find(descriptor => descriptor.name === 'mt-t1-debug')
    expect(mine).toBeDefined()
    expect(mine).toMatchObject({ name: 'mt-t1-debug' })
    expect(mine?.description).toContain('continuable child')
  })

  it('executes /mt-t1-debug through the real dispatch: continuable child spawned, followup queued, both consumed', { timeout: 60_000 }, async () => {
    scratchPlugin.drainDebugLog()
    const f = await fixture()
    const parent = await f.agent('parent-1')
    expect(turnCount(parent)).toBe(0)

    // Real registry dispatch — what a UI slash-command submit reaches.
    const execution: CommandExecution | undefined = await f.ctx.commands.execute(
      parent,
      '/mt-t1-debug research the multitask runtime seam',
      [],
      new AbortController().signal
    )
    expect(execution).toBeDefined()
    expect(execution!.result.kind).toBe('success')
    expect(execution!.result.kind === 'success' && execution!.result.text).toContain('spawned continuable child')

    // (a) The handler really spawned a continuable child, durably listed.
    const recorded = scratchPlugin.drainDebugLog()
    expect(recorded).toHaveLength(1)
    const { childId, handoffText, promptText } = recorded[0]!
    expect(promptText).toBe('research the multitask runtime seam')
    const children = await f.ctx.subagents.listChildren(parent.id)
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ kind: 'child', id: childId, mode: 'continuable', label: scratchPlugin.CHILD_LABEL })

    // (b) The child ran its own initial turn on the handler's prompt.
    await waitFor(() => f.calls.some(call => call.model === 'orchestrator' && userText(call.request).includes(promptText)), 'child initial turn model call')

    // (c) The handler queued the followup; the parent was idle, so the loop
    // woke and consumed it as the parent's own turn (no test-driven kick).
    await waitFor(() => turnCount(parent) >= 1, 'parent wake turn on the queued handoff')
    await parent.whenIdle()
    const handoffCall = f.calls.find(call => userText(call.request).includes(handoffText))
    expect(handoffCall).toBeDefined()

    // (d) When the child settled, the settlement notice reached the parent.
    await waitFor(() => settlementNotices(parent).length >= 1, 'settlement notice to the parent')
    expect(settlementNotices(parent)[0]!.source).toMatchObject({ kind: 'subagent-settled', senderSessionId: childId })

    // (e) The command lifecycle was durably logged by the registry itself:
    // command/run before the handler, command/done after settlement.
    const events = parent.session.snapshotEvents()
    expect(events.some(event => event.type === 'command/run' && (event.data as { name: string }).name === 'mt-t1-debug')).toBe(true)
    expect(events.some(event => event.type === 'command/done' && (event.data as { kind: string }).kind === 'success')).toBe(true)
  })

  it('queues the followup behind an already-running turn without interrupting it', { timeout: 60_000 }, async () => {
    scratchPlugin.drainDebugLog()
    const f = await fixture()
    const parent = await f.agent('parent-1')
    // Give the parent a first task so the command fires mid-turn; the child
    // settles fast, so the assertion below only needs the ordering fact that
    // the command did not splice the running turn's request.
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'task A in progress' }],
      source: { kind: 'user' }
    }))
    await waitFor(() => turnCount(parent) >= 1, 'first parent turn')
    expect(parent.status).toBe('running')

    const execution = await f.ctx.commands.execute(
      parent,
      '/mt-t1-debug research while the parent works',
      [],
      new AbortController().signal
    )
    expect(execution!.result.kind).toBe('success')
    const { handoffText } = scratchPlugin.drainDebugLog()[0]!

    // The handoff is parked for the turn boundary, not spliced into the
    // running turn: no model request has seen it yet.
    expect(f.calls.every(call => !userText(call.request).includes(handoffText))).toBe(true)

    // The running turn finishes, then the boundary consumes the handoff.
    await parent.whenIdle()
    expect(parent.status).toBe('idle')
    await waitFor(() => f.calls.some(call => userText(call.request).includes(handoffText)), 'handoff consumed at the turn boundary')
  })
})
