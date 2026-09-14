/**
 * [multitask] issue #9 — claim enforcement guards and release-on-settle.
 *
 * Real configured composition at the frozen public seam selected by
 * `multitask_claim_enforcement_gate`: permanent `dsh-multitask` host/client
 * surfaces, command runtime, agents/subagents, tool pre-execute waterfall,
 * native fs write/edit intents and observation policy, session event
 * log/projections, round-driver handoff, and task-card text. Only the model
 * adapter is scripted.
 *
 * These regressions observe a native denied write, one denial, recovery, an
 * accurate live claim table, host release before retry across every supported
 * settlement variant, researcher lifecycle after `subagent/end`, and the Bash
 * tier-2 footnote — not a guard helper, a hard-coded probe, or a final-state
 * snapshot.
 */
import { readFileSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Commands from '@deepseek-ai/dsh-commands'
import { FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import * as observationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import {
  type FinishReason,
  type GenerateOptions,
  LlmAdapter,
  LlmRuntime,
  type StreamChunk,
  ToolCallId
} from '@deepseek-ai/dsh-llm'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as subagentSpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import * as strReplaceEditor from '@deepseek-ai/dsh-tool-str-replace-editor'
import * as toolBash from '@deepseek-ai/dsh-tool-bash'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import BashLocal from '@deepseek-ai/dsh-bash-local'
import * as shellEnv from '@deepseek-ai/dsh-shell-env'
import * as multitask from '../packages/dsh-multitask/index.js'

const REMEDY = 'ask the orchestrator or claim a different path'
const STRUCTURED_REPORT = [
  'Goal: claim enforcement coverage',
  'Affected paths: src/held.ts',
  'Implementation plan: claim, collide, recover, abort',
  'Risks: double-deny and leaked claims',
  'Recommended claim set: src/held.ts'
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

interface Fixture {
  ctx: Context
  home: string
  writeIntents: number
  editIntents: number
  agent: Agent
  disposeAll(): Promise<void>
}

function loadMultitaskClient(): {
  foldTasks: (events: Array<Record<string, unknown>>) => Array<Record<string, unknown>>
  formatTaskCardText: (task: Record<string, unknown>) => string
} {
  const source = readFileSync(path.join(process.cwd(), 'packages/dsh-multitask-client/client.js'), 'utf8')
  let definition: { factory: (require: (id: string) => unknown) => {
    foldTasks: (events: Array<Record<string, unknown>>) => Array<Record<string, unknown>>
    formatTaskCardText: (value: Record<string, unknown>) => string
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
        useEffect: () => {}
      }
    }
    throw new Error(`unexpected client require ${id}`)
  })
}

function foldTaskCardFromLiveSession(agent: Agent, taskId: string): string {
  const plugin = loadMultitaskClient()
  const folded = plugin.foldTasks(agent.session.snapshotEvents() as unknown as Array<Record<string, unknown>>)
  const task = folded.find(row => row.id === taskId)
  if (task === undefined) throw new Error(`live session fold is missing task ${taskId}`)
  return plugin.formatTaskCardText(task)
}

function userText(request: GenerateOptions): string {
  return request.messages
    .filter(message => message.role === 'user')
    .map(message => message.content.map(block => block.type === 'text' ? block.text : `<${block.type}>`).join(''))
    .join('\n')
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

function isWriterACall(call: ScriptedCall): boolean {
  return userText(call.request).includes('writer A stays live to claim files')
}

function isWriterBCall(call: ScriptedCall): boolean {
  return userText(call.request).includes('writer B stays live to claim files')
}

function* textChunks(text: string, reason: FinishReason = { kind: 'stop' }): Generator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
  yield { type: 'finish', reason }
}

function researchEvents(agent: Agent) {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'multitask/research')
    .map(event => event.data as Record<string, unknown>)
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

async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function runCommand(ctx: Context, agent: Agent, line: string) {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
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

function claimEvents(agent: Agent) {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'multitask/claims')
    .map(event => event.data as Record<string, unknown>)
}

function denialEvents(agent: Agent) {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'multitask/denial')
    .map(event => event.data as Record<string, unknown>)
    .filter(data => String(data.note ?? data.reason ?? '').includes(REMEDY) || String(data.phase ?? '').includes('intervention'))
}

function liveClaims(agent: Agent) {
  return claimEvents(agent)
    .reduce((table, event) => {
      const pathKey = String(event.path)
      if (event.state === 'released') table.delete(pathKey)
      else table.set(pathKey, event)
      return table
    }, new Map<string, Record<string, unknown>>())
}

function handoffText(agent: Agent): string {
  return [
    ...agent.inbox.nextTurn,
    ...agent.inbox.nextStep,
    ...agent.session.deriveMessages()
  ]
    .filter(message => message.source?.kind === 'multitask')
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')
}

async function fixture(options: {
  respond?: (call: ScriptedCall) => Promise<ScriptedResponse>
  enabled?: boolean
} = {}): Promise<Fixture> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-claim-enforcement-'))
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
  const sandbox = await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: home })
  push(() => (sandbox as { dispose(): Promise<void> }).dispose())
  const fs = await ctx.plugin(SandboxedFileSystem, { cwd: home })
  push(() => (fs as { dispose(): Promise<void> }).dispose())
  const sessions = await ctx.plugin(SessionStore)
  push(() => sessions.dispose())
  const tools = await ctx.plugin(ToolRuntime, { mode: 'native' })
  push(() => tools.dispose())
  const llm = await ctx.plugin(LlmRuntime)
  push(() => llm.dispose())
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: home })
  push(() => persistence.dispose())
  const registry = await ctx.plugin(AgentRegistry)
  push(() => registry.dispose())
  const commands = await ctx.plugin(Commands)
  push(() => commands.dispose())
  const adapter = await ctx.plugin({
    inject: ['llm'],
    apply(pluginCtx: Context) {
      pluginCtx.llm.registerAdapter(['scripted'], new ScriptedAdapter(async (call) => {
        return options.respond?.(call) ?? (isResearcherCall(call) ? STRUCTURED_REPORT : 'parent ack')
      }))
    }
  })
  push(() => adapter.dispose())
  const loop = await ctx.plugin(AgentLoop)
  push(() => loop.dispose())
  const subprocess = await ctx.plugin(LocalSubprocessRuntime)
  push(() => (subprocess as { dispose(): Promise<void> }).dispose())
  const bash = await ctx.plugin(BashLocal)
  push(() => (bash as { dispose(): Promise<void> }).dispose())
  const env = await ctx.plugin(shellEnv as unknown as Parameters<Context['plugin']>[0])
  push(() => env.dispose())
  const nativeFs = await ctx.plugin(toolFs as unknown as Parameters<Context['plugin']>[0])
  push(() => nativeFs.dispose())
  const editor = await ctx.plugin(strReplaceEditor as unknown as Parameters<Context['plugin']>[0])
  push(() => editor.dispose())
  const bashTool = await ctx.plugin(toolBash as unknown as Parameters<Context['plugin']>[0])
  push(() => bashTool.dispose())
  const mounted = await ctx.plugin(multitask as unknown as Parameters<Context['plugin']>[0], { enabled: options.enabled === true })
  push(() => mounted.dispose())
  const observed = await ctx.plugin(observationPolicy as unknown as Parameters<Context['plugin']>[0])
  push(() => observed.dispose())
  const subagents = await ctx.plugin(SubagentRuntime)
  push(() => (subagents as { dispose(): Promise<void> }).dispose())
  const spawn = await ctx.plugin(subagentSpawnInProcess as unknown as Parameters<Context['plugin']>[0])
  push(() => spawn.dispose())
  const query = await ctx.plugin(SessionQueryEngine as unknown as new (ctx: Context) => SessionQueryEngine)
  push(() => query.dispose())

  const counters = { writeIntents: 0, editIntents: 0 }
  ctx.on('fs/write-intent', async (_target, _actor, next) => {
    counters.writeIntents += 1
    return next()
  })
  ctx.on('fs/edit-intent', async (_target, _actor, next) => {
    counters.editIntents += 1
    return next()
  })

  const handle = await ctx.agents.create({
    sessionId: SessionId('session-1'),
    meta: { cwd: home },
    agentOptions: { provider: 'scripted', model: 'orchestrator' }
  })
  push(() => handle.dispose())

  return {
    ctx,
    home,
    get writeIntents() { return counters.writeIntents },
    get editIntents() { return counters.editIntents },
    agent: handle.agent,
    disposeAll: async () => {
      for (const dispose of [...disposers].reverse()) await dispose()
    }
  }
}

async function launchTwoHeldChildren(f: Fixture, hold: { promise: Promise<void> }) {
  await runCommand(f.ctx, f.agent, '/multitask implement shared file A')
  await runCommand(f.ctx, f.agent, '/multitask implement shared file B')
  const startA = await f.ctx.subagents.startContinuable({
    provider: 'spawn',
    label: 'writer-a',
    request: {
      prompt: [{ type: 'text', text: 'writer A stays live to claim files' }],
      parent: f.agent
    },
    signal: new AbortController().signal
  })
  const startB = await f.ctx.subagents.startContinuable({
    provider: 'spawn',
    label: 'writer-b',
    request: {
      prompt: [{ type: 'text', text: 'writer B stays live to claim files' }],
      parent: f.agent
    },
    signal: new AbortController().signal
  })
  const childIds = [String(startA.childId), String(startB.childId)]
  await waitFor(() => childIds.every(id => f.ctx.agents.get(SessionId(id)) !== undefined), 'live writer agents')
  return {
    childA: f.ctx.agents.get(SessionId(childIds[0]!))!,
    childB: f.ctx.agents.get(SessionId(childIds[1]!))!,
    childIds,
    hold
  }
}

describe('multitask_claim_enforcement_gate native collision', () => {
  it('denies a foreign native write once with path, holder, and remedy, then recovers', { timeout: 30_000 }, async () => {
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
    const { childA, childB } = await launchTwoHeldChildren(f, hold)
    const claimed = await runTool(f.ctx, childA, 'claim_files', { paths: ['src/held.ts'], taskId: 'MT-1' })
    expect(claimed.isError).toBe(false)

    const ownerWrite = await runTool(f.ctx, childA, 'write', {
      file_path: path.join(f.home, 'src/held.ts'),
      content: 'owned by MT-1'
    })
    expect(ownerWrite.isError).toBe(false)
    expect(await fileExists(path.join(f.home, 'src/held.ts'))).toBe(true)

    const intentsBefore = f.writeIntents
    const foreign = await runTool(f.ctx, childB, 'write', {
      file_path: path.join(f.home, 'src/held.ts'),
      content: 'writer B collision'
    })
    expect(foreign.isError).toBe(true)
    const reason = String(foreign.error?.message ?? '')
    expect(reason).toContain('src/held.ts')
    expect(reason).toContain('MT-1')
    expect(reason).toContain(REMEDY)
    expect(await readFile(path.join(f.home, 'src/held.ts'), 'utf8')).toBe('owned by MT-1')
    expect(denialEvents(f.agent)).toHaveLength(1)
    expect(f.writeIntents - intentsBefore).toBe(0)

    const recovered = await runTool(f.ctx, childB, 'write', {
      file_path: path.join(f.home, 'src/recovered.ts'),
      content: 'writer B recovered'
    })
    expect(recovered.isError).toBe(false)
    expect(await fileExists(path.join(f.home, 'src/recovered.ts'))).toBe(true)
    expect(denialEvents(f.agent)).toHaveLength(1)

    const card = foldTaskCardFromLiveSession(f.agent, 'MT-2')
    expect(card).toContain('Boundary intervention')
    expect(card).toContain('MT-1')
    expect(card).toContain('src/held.ts')
    expect(card).toMatch(/Bash writes are not covered by tier 2/i)
    expect(card).not.toMatch(/Bash writes are (guarded|enforced)/i)

    hold.open()
    await f.agent.whenIdle()
  })
})

describe('multitask_claim_enforcement_gate handoff table and pre-claim', () => {
  it('pre-claims busy-parent touched paths and prints the live table on the next handoff', { timeout: 30_000 }, async () => {
    const hold = gate()
    const f = await fixture({
      enabled: true,
      respond: async (call) => {
        if (isWriterCall(call)) {
          await holdUntil(call.request.signal, hold.promise)
          return 'writer held'
        }
        if (isResearcherCall(call)) return STRUCTURED_REPORT
        return 'parent ack'
      }
    })
    await runCommand(f.ctx, f.agent, '/multitask implement shared file A')
    const busy = await runTool(f.ctx, f.agent, 'write', {
      file_path: path.join(f.home, 'parent-busy.ts'),
      content: 'parent already touching this'
    })
    expect(busy.isError).toBe(false)
    await runCommand(f.ctx, f.agent, '/multitask implement shared file B')
    const table = [...liveClaims(f.agent).values()]
    expect(table.some(claim => String(claim.path).includes('parent-busy.ts') && claim.taskId === 'MT-1')).toBe(true)
    expect(table.every(claim => claim.state !== 'released')).toBe(true)

    const text = handoffText(f.agent)
    expect(text).toMatch(/Live claims/i)
    expect(text).toContain('parent-busy.ts')
    expect(text).toContain('MT-1')
    expect(text).not.toMatch(/released/i)

    hold.open()
    await f.agent.whenIdle()
  })
})

describe('multitask_claim_enforcement_gate release-on-settle', () => {
  it.each([
    { name: 'completed', settle: 'completed' as const, stopReason: 'completed' },
    { name: 'max-tokens', settle: 'max-tokens' as const, stopReason: 'max-tokens' },
    { name: 'refusal', settle: 'refusal' as const, stopReason: 'refusal' },
    { name: 'error', settle: 'error' as const, stopReason: 'error' },
    { name: 'aborted', settle: 'aborted' as const, stopReason: 'aborted' },
    { name: 'killed/cancelled', settle: 'cancelled' as const, stopReason: 'aborted' }
  ])('releases only the settled owner on $name and preserves unrelated claims', { timeout: 30_000 }, async ({ name, settle, stopReason }) => {
    const holdA = gate()
    const holdB = gate()
    const admitWriters = gate()
    let holdNewWriters = false
    const rejectIds = new Set<string>()
    const ends = new Map<string, string>()
    const f = await fixture({
      respond: async (call) => {
        if (isWriterACall(call)) {
          await holdUntil(call.request.signal, holdA.promise)
          if (settle === 'error') throw new Error('scripted writer transport failure')
          if (settle === 'max-tokens') return textChunks('partial writer A before the ceiling', { kind: 'max-tokens' })
          return 'writer A completed'
        }
        if (isWriterBCall(call)) {
          await holdUntil(call.request.signal, holdB.promise)
          return 'writer B held'
        }
        if (isResearcherCall(call)) return STRUCTURED_REPORT
        return 'parent ack'
      }
    })
    f.ctx.on('subagent/end', (info: { id: string, stopReason?: string }) => {
      ends.set(String(info.id), String(info.stopReason ?? ''))
    })
    f.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (!holdNewWriters || agent.session.header.origin !== 'subagent') return next()
      await admitWriters.promise
      if (rejectIds.has(String(agent.session.id))) return { kind: 'reject' }
      return next()
    })

    await runCommand(f.ctx, f.agent, '/multitask implement shared file A')
    await runCommand(f.ctx, f.agent, '/multitask implement shared file B')
    holdNewWriters = true
    const startA = await f.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'writer-a',
      request: {
        prompt: [{ type: 'text', text: 'writer A stays live to claim files' }],
        parent: f.agent
      },
      signal: new AbortController().signal
    })
    const startB = await f.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'writer-b',
      request: {
        prompt: [{ type: 'text', text: 'writer B stays live to claim files' }],
        parent: f.agent
      },
      signal: new AbortController().signal
    })
    const childIds = [String(startA.childId), String(startB.childId)]
    await waitFor(() => childIds.every(id => f.ctx.agents.get(SessionId(id)) !== undefined), 'live writer agents')
    const childA = f.ctx.agents.get(SessionId(childIds[0]!))!
    const childB = f.ctx.agents.get(SessionId(childIds[1]!))!

    await runTool(f.ctx, childA, 'claim_files', { paths: ['src/held.ts'], taskId: 'MT-1' })
    await runTool(f.ctx, childB, 'claim_files', { paths: ['src/other.ts'], taskId: 'MT-2' })
    const blocked = await runTool(f.ctx, childB, 'write', {
      file_path: path.join(f.home, 'src/held.ts'),
      content: 'still blocked'
    })
    expect(blocked.isError).toBe(true)
    expect(liveClaims(f.agent).get('src/held.ts')?.taskId).toBe('MT-1')
    expect(liveClaims(f.agent).get('src/other.ts')?.taskId).toBe('MT-2')

    if (settle === 'refusal') rejectIds.add(childIds[0]!)
    admitWriters.open()

    if (settle !== 'refusal') {
      await waitFor(() => ends.has(childIds[0]!) === false && childA.status !== undefined, 'writer A admitted')
      if (settle === 'aborted') {
        await f.ctx.subagents.drainContinuableChildren(f.agent, [SessionId(childIds[0]!)])
      } else if (settle === 'cancelled') {
        childA.cancel({ kind: 'user' })
      }
      holdA.open()
    }

    await waitFor(() => ends.get(childIds[0]!) === stopReason, `${name} settled as ${stopReason}`)
    await waitFor(() => !liveClaims(f.agent).has('src/held.ts'), `holder claims released after ${name}`)
    expect(claimEvents(f.agent).filter(event => event.path === 'src/held.ts' && event.state === 'released').length).toBeGreaterThan(0)
    expect(liveClaims(f.agent).has('src/held.ts')).toBe(false)
    expect(liveClaims(f.agent).get('src/other.ts')?.taskId).toBe('MT-2')
    expect(String(liveClaims(f.agent).get('src/other.ts')?.ownerSessionId)).toBe(String(childB.session.id))

    const retry = await runTool(f.ctx, childB, 'write', {
      file_path: path.join(f.home, 'src/held.ts'),
      content: `retry after ${name}`
    })
    expect(retry.isError, `retry after ${name} must succeed without a model release`).toBe(false)
    expect(await readFile(path.join(f.home, 'src/held.ts'), 'utf8')).toBe(`retry after ${name}`)
    expect(liveClaims(f.agent).get('src/other.ts')?.taskId).toBe('MT-2')

    holdB.open()
    await f.agent.whenIdle()
  })

  it('keeps researcher completed and error mapping while an unrelated writer claim stays live', { timeout: 30_000 }, async () => {
    const hold = gate()
    let researcherCalls = 0
    const f = await fixture({
      respond: async (call) => {
        if (isWriterCall(call)) {
          await holdUntil(call.request.signal, hold.promise)
          return 'writer held'
        }
        if (isResearcherCall(call)) {
          researcherCalls += 1
          if (researcherCalls >= 2) throw new Error('scripted researcher transport failure')
          return STRUCTURED_REPORT
        }
        return 'parent ack'
      }
    })
    await runCommand(f.ctx, f.agent, '/multitask research the structured report')
    await waitFor(() => researchEvents(f.agent).some(event => event.phase === 'researched'), 'completed → researched')
    const researched = researchEvents(f.agent).find(event => event.phase === 'researched')!
    expect(researched.stopReason).toBe('completed')
    expect(researchEvents(f.agent).every(event => event.phase !== 'research-failed')).toBe(true)

    const startB = await f.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'writer-b',
      request: {
        prompt: [{ type: 'text', text: 'writer B stays live to claim files' }],
        parent: f.agent
      },
      signal: new AbortController().signal
    })
    await waitFor(() => f.ctx.agents.get(startB.childId) !== undefined, 'live unrelated writer')
    const childB = f.ctx.agents.get(startB.childId)!
    await runTool(f.ctx, childB, 'claim_files', { paths: ['src/other.ts'], taskId: 'MT-1' })
    expect(liveClaims(f.agent).get('src/other.ts')?.taskId).toBe('MT-1')

    await runCommand(f.ctx, f.agent, '/multitask observe error settlement')
    await waitFor(() => researchEvents(f.agent).some(event => event.phase === 'research-failed'), 'error → research-failed')
    const failed = researchEvents(f.agent).find(event => event.phase === 'research-failed')!
    expect(failed.stopReason).toBe('error')
    expect(liveClaims(f.agent).get('src/other.ts')?.taskId).toBe('MT-1')
    expect(String(liveClaims(f.agent).get('src/other.ts')?.ownerSessionId)).toBe(String(childB.session.id))

    hold.open()
    await f.agent.whenIdle()
  })
})

describe('multitask_claim_enforcement_gate bash scope', () => {
  it('leaves bash writes outside tier 2 and documents that on the task card', { timeout: 30_000 }, async () => {
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
    const { childA } = await launchTwoHeldChildren(f, hold)
    await runTool(f.ctx, childA, 'claim_files', { paths: ['held.txt'], taskId: 'MT-1' })
    const shell = await runTool(f.ctx, f.agent, 'bash', {
      command: `printf 'bash bypass\\n' > "${path.join(f.home, 'held.txt')}"`,
      description: 'Write held path through bash'
    })
    expect(shell.isError).toBe(false)
    expect(await fileExists(path.join(f.home, 'held.txt'))).toBe(true)
    const card = foldTaskCardFromLiveSession(f.agent, 'MT-1')
    expect(card).toMatch(/Bash writes are not covered by tier 2/i)
    expect(card).toMatch(/native write\/edit/i)
    expect(card).not.toMatch(/heuristic/i)

    hold.open()
    await f.agent.whenIdle()
  })
})

describe('multitask_claim_enforcement_gate fs fallback', () => {
  it('throws a typed FsError from fs intents and never a plain Error', { timeout: 20_000 }, async () => {
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
    const { childA, childB } = await launchTwoHeldChildren(f, hold)
    await runTool(f.ctx, childA, 'claim_files', { paths: ['src/held.ts'], taskId: 'MT-1' })
    const target = {
      displayPath: path.join(f.home, 'src/held.ts'),
      targetKey: FsTargetKey(path.join(f.home, 'src/held.ts'))
    }
    await expect(f.ctx.waterfall(
      'fs/write-intent',
      target,
      { agent: childB },
      () => undefined
    )).rejects.toBeInstanceOf(FsError)

    hold.open()
    await f.agent.whenIdle()
  })
})
