#!/usr/bin/env node
// Real composed-application scenario for the [multitask] claims registry (issue #8).
//
// Composes the production claims path the desktop profile mounts: the
// permanent `dsh-multitask` plugin, real tool runtime, session projection
// registry, session persistence, session query, subagent lineage, and
// browser publication. Only the model adapter is scripted, matching the
// frozen `multitask_claims_registry_gate` seam. The script asserts full
// history — two-task conflict, release/reclaim, scoped tools, and restart
// expiry from real subagent activity — not a final-state-only snapshot.
//
// Exit 0 only when every observation succeeded.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Commands from '@deepseek-ai/dsh-commands'
import { LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as subagentSpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as multitask from '../packages/dsh-multitask/index.js'

const CLAIM_TOOLS = ['claim_files', 'release_files', 'list_file_claims']
const STRUCTURED_REPORT = [
  'Goal: claims registry composed scenario',
  'Affected paths: src/shared.ts',
  'Implementation plan: contend, release, restart',
  'Risks: ghost claims',
  'Recommended claim set: src/shared.ts'
].join('\n')

class ScenarioFailure extends Error {}

function fail(message) {
  throw new ScenarioFailure(message)
}

function log(message) {
  process.stdout.write(`${message}\n`)
}

class ScriptedAdapter extends LlmAdapter {
  constructor(respond) {
    super()
    this.respond = respond
  }

  async *stream(options) {
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

function userText(request) {
  return request.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content.map((block) => (block.type === 'text' ? block.text : `<${block.type}>`)).join(''))
    .join('\n')
}

function isResearcherCall(call) {
  const text = userText(call.request)
  return text.includes('do not modify files')
    || text.includes('Recommended claim set')
    || text.includes('structured research report')
}

function isWriterCall(call) {
  return userText(call.request).includes('stays live to claim files')
}

function gate() {
  let open
  const promise = new Promise((resolve) => {
    open = resolve
  })
  return { promise, open }
}

async function holdUntil(signal, held) {
  const reason = () => (signal?.reason instanceof Error ? signal.reason : new Error('scripted model call aborted'))
  if (signal?.aborted) throw reason()
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(reason())
    signal?.addEventListener('abort', onAbort, { once: true })
    held.then(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, reject)
  })
}

async function waitFor(condition, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return
    if (Date.now() > deadline) fail(`waitFor timed out: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function claimEvents(agent) {
  return agent.session.snapshotEvents()
    .filter((event) => event.type === 'multitask/claims')
    .map((event) => event.data)
}

function toolNames(ctx, agent) {
  return ctx.tools.schemas(agent).map((schema) => schema.name)
}

function liveClaims(value) {
  return Array.isArray(value?.claims) ? value.claims : []
}

async function runCommand(ctx, agent, line) {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (execution === undefined) fail(`command ${line} was not executed`)
  return execution
}

async function runTool(ctx, agent, name, args) {
  return ctx.tools.execute({
    callId: ToolCallId(`${name}-${Math.random().toString(16).slice(2)}`),
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal
  })
}

async function compose(options = {}) {
  const home = options.home ?? await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-claims-app-'))
  const ctx = new Context()
  const disposers = []
  const push = (dispose) => {
    let settled
    const once = async () => {
      settled ??= Promise.resolve().then(() => dispose())
      await settled
    }
    disposers.push(once)
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

  const writes = []
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

  const adapter = await ctx.plugin({
    inject: ['llm'],
    apply(pluginCtx) {
      pluginCtx.llm.registerAdapter(['scripted'], new ScriptedAdapter(async (call) => {
        return options.respond?.(call) ?? (isResearcherCall(call) ? STRUCTURED_REPORT : 'parent ack')
      }))
    }
  })
  push(() => adapter.dispose())
  const loop = await ctx.plugin(AgentLoop)
  push(() => loop.dispose())
  const subagents = await ctx.plugin(SubagentRuntime)
  push(() => subagents.dispose())
  const spawn = await ctx.plugin(subagentSpawnInProcess)
  push(() => spawn.dispose())
  const query = await ctx.plugin(SessionQueryEngine)
  push(() => query.dispose())
  const mounted = await ctx.plugin(multitask)
  push(() => mounted.dispose())

  const projectionChanges = []
  ctx.sessionProjections.onChanged((session, key, value) => {
    projectionChanges.push({ sessionId: String(session.id), key, value })
  })

  const handle = await ctx.agents.create({
    sessionId: SessionId(options.sessionId ?? 'session-1'),
    meta: { cwd: home },
    agentOptions: { provider: 'scripted', model: 'orchestrator' }
  })
  push(() => handle.dispose())

  return {
    ctx,
    home,
    writes,
    projectionChanges,
    agent: handle.agent,
    dispose: async () => {
      for (const dispose of [...disposers].reverse()) await dispose()
      if (options.keepHome !== true) await rm(home, { recursive: true, force: true })
    }
  }
}

async function launchTwoHeldChildren(app) {
  await runCommand(app.ctx, app.agent, '/multitask implement shared file A')
  await runCommand(app.ctx, app.agent, '/multitask implement shared file B')
  const startA = await app.ctx.subagents.startContinuable({
    provider: 'spawn',
    label: 'writer-a',
    request: {
      prompt: [{ type: 'text', text: 'writer A stays live to claim files' }],
      parent: app.agent
    },
    signal: new AbortController().signal
  })
  const startB = await app.ctx.subagents.startContinuable({
    provider: 'spawn',
    label: 'writer-b',
    request: {
      prompt: [{ type: 'text', text: 'writer B stays live to claim files' }],
      parent: app.agent
    },
    signal: new AbortController().signal
  })
  const childIds = [String(startA.childId), String(startB.childId)]
  await waitFor(() => childIds.every((id) => app.ctx.agents.get(SessionId(id)) !== undefined), 'live writer agents')
  return {
    childA: app.ctx.agents.get(SessionId(childIds[0])),
    childB: app.ctx.agents.get(SessionId(childIds[1])),
    childIds
  }
}

async function runScenario() {
  const ordinary = await compose({ sessionId: 'ordinary' })
  try {
    if (CLAIM_TOOLS.some((name) => toolNames(ordinary.ctx).includes(name))) {
      fail('global tool catalog listed claim tools')
    }
    if (CLAIM_TOOLS.some((name) => toolNames(ordinary.ctx, ordinary.agent).includes(name))) {
      fail('ordinary session listed claim tools')
    }
  } finally {
    await ordinary.dispose()
  }

  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-claims-scenario-'))
  const hold = gate()
  const app = await compose({
    home,
    keepHome: true,
    respond: async (call) => {
      if (isWriterCall(call)) {
        await holdUntil(call.request.signal, hold.promise)
        return 'writer held'
      }
      if (isResearcherCall(call)) return STRUCTURED_REPORT
      return 'parent ack'
    }
  })
  try {
    if (CLAIM_TOOLS.some((name) => toolNames(app.ctx).includes(name))) {
      fail('global tool catalog listed claim tools before tasks opened')
    }
    const { childA, childB } = await launchTwoHeldChildren(app)
    if (!CLAIM_TOOLS.every((name) => toolNames(app.ctx, app.agent).includes(name))) {
      fail('parent with open multitask tasks is missing claim tools')
    }
    if (!CLAIM_TOOLS.every((name) => toolNames(app.ctx, childA).includes(name))) {
      fail('child A is missing inherited claim tools')
    }
    if (!CLAIM_TOOLS.every((name) => toolNames(app.ctx, childB).includes(name))) {
      fail('child B is missing inherited claim tools')
    }

    const first = await runTool(app.ctx, childA, 'claim_files', {
      paths: [path.join(app.home, 'src/shared.ts'), 'src/'],
      taskId: 'MT-1'
    })
    if (first.isError) fail(`first claim failed: ${first.error?.message}`)
    if (claimEvents(app.agent).some((event) => String(event.path).startsWith('/') || /^[A-Za-z]:[\\/]/.test(String(event.path)))) {
      fail('claim records used absolute-path identity')
    }

    const conflict = await runTool(app.ctx, childB, 'claim_files', {
      paths: ['src/nested/file.ts', 'other.ts'],
      taskId: 'MT-2'
    })
    if (!conflict.isError || conflict.error?.info?.code !== 'CLAIM_CONFLICT') {
      fail('overlapping claim did not return a structured CLAIM_CONFLICT')
    }
    if (!String(conflict.error?.message).includes('MT-1')) {
      fail('structured conflict did not name the holding task')
    }
    if (claimEvents(app.agent).some((event) => event.taskId === 'MT-2' && event.state === 'claimed')) {
      fail('conflicting claim partially acquired paths')
    }

    const listed = await runTool(app.ctx, app.agent, 'list_file_claims', {})
    if (listed.isError) fail(`list_file_claims failed: ${listed.error?.message}`)
    if (!liveClaims(listed.value).some((claim) => claim.taskId === 'MT-1')) {
      fail('live table lost the first claim')
    }

    const probe = path.join(app.home, 'claimed-write.txt')
    const write = await runTool(app.ctx, app.agent, 'write', {
      file_path: probe,
      content: 'claims must not deny writes'
    })
    if (write.isError) fail('write on a claimed path was denied — enforcement belongs to issue #9')
    if (app.writes.length !== 1) fail('write probe did not land')

    const released = await runTool(app.ctx, childA, 'release_files', { paths: ['src/shared.ts', 'src'], taskId: 'MT-1' })
    if (released.isError) fail(`release failed: ${released.error?.message}`)
    const reclaimed = await runTool(app.ctx, childB, 'claim_files', { paths: ['src/shared.ts'], taskId: 'MT-2' })
    if (reclaimed.isError) fail(`re-claim after release failed: ${reclaimed.error?.message}`)

    const again = await runTool(app.ctx, childB, 'claim_files', { paths: ['src/shared.ts'], taskId: 'MT-2' })
    if (again.isError) fail(`idempotent re-claim failed: ${again.error?.message}`)
    if (claimEvents(app.agent).filter((event) => event.path === 'src/shared.ts' && event.state === 'claimed' && event.taskId === 'MT-2').length !== 1) {
      fail('idempotent re-claim appended a duplicate event')
    }

    await runTool(app.ctx, app.agent, 'claim_files', { paths: ['src/parent.ts'], taskId: 'MT-1' })
    if (!app.projectionChanges.some((change) => change.key === 'multitask/claims')) {
      fail('claim/release did not publish multitask/claims change events')
    }

    hold.open()
    await app.agent.whenIdle()
    await app.dispose()

    const restarted = await compose({
      home,
      keepHome: true,
      sessionId: 'session-1-unused',
      respond: async () => 'parent ack after restart'
    })
    try {
      const handle = await restarted.ctx.agents.resume({
        resumeSessionId: SessionId('session-1'),
        agentOptions: { provider: 'scripted', model: 'orchestrator' }
      })
      const children = await restarted.ctx.subagents.listChildren(SessionId('session-1'))
      if (!children.some((entry) => entry.kind === 'child' && entry.activity === 'inactive')) {
        fail('restart did not consult real inactive subagent activity')
      }
      const after = await runTool(restarted.ctx, handle.agent, 'list_file_claims', {})
      const table = liveClaims(after.value)
      if (table.some((claim) => claim.path === 'src/shared.ts' && claim.taskId === 'MT-2')) {
        fail('restart left a ghost claim from a dead subagent')
      }
      if (!table.some((claim) => claim.path === 'src/parent.ts' && claim.taskId === 'MT-1')) {
        fail('restart expired a live parent-owned claim')
      }
      const snapshot = restarted.ctx.sessionProjections.snapshot(handle.agent.session, ['multitask/claims'])
      if (!liveClaims(snapshot.values['multitask/claims']).some((claim) => claim.path === 'src/parent.ts')) {
        fail('restart projection did not publish the surviving claim')
      }
      if (!restarted.projectionChanges.some((change) => change.key === 'multitask/claims')) {
        fail('restart did not emit multitask/claims change events')
      }
      log('check-multitask-claims: PASS conflict, lifecycle, scoping, and restart expiry')
    } finally {
      await restarted.dispose()
      await rm(home, { recursive: true, force: true })
    }
  } catch (error) {
    hold.open()
    await app.dispose().catch(() => {})
    await rm(home, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

try {
  await runScenario()
  log('check-multitask-claims: PASS')
} catch (error) {
  if (error instanceof ScenarioFailure) {
    process.stderr.write(`check-multitask-claims: FAIL\n${error.message}\n`)
  } else {
    process.stderr.write(`check-multitask-claims: FAIL (unexpected error)\n${error?.stack ?? String(error)}\n`)
  }
  process.exit(1)
}
