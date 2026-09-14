#!/usr/bin/env node
// Real composed-application rapid-settle workflow for [multitask] guardrails
// (issue #10).
//
// Composes the production path the desktop profile mounts: the permanent
// `dsh-multitask` host plugin, command runtime, orchestrator-mode request
// assembly, scoped `subagent` tool runtime, live descendant activity,
// claims/touch trail, round-driver handoffs and wake budget, and the session
// event log. Only the model adapter and child settlement timing are
// scripted, matching the frozen `multitask_guardrails_gate` seam. The script
// asserts full history — structured third-writer refusal, later admission,
// queue uniqueness, the shared wake bound, parent-held path omission, and
// the actual researcher `toolFilter` — not a helper call or a final-state
// snapshot.
//
// Exit 0 only when every observation succeeded.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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
import * as toolSubagent from '@deepseek-ai/dsh-tool-subagent'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as multitask from '../packages/dsh-multitask/index.js'

const DENIED_TOOLS = ['write', 'edit', 'str_replace_editor']
const RESEARCHER_LABEL = 'researcher'
const PARENT_HELD = 'parent-busy.ts'
const STRUCTURED_REPORT = [
  'Goal: implement the composed guardrails scenario',
  'Affected paths: packages/dsh-multitask/guardrails.js',
  'Implementation plan: refuse the third writer, yield, then admit later',
  'Risks: hidden retry, duplicate queue, leaked reservation',
  'Recommended claim set: packages/dsh-multitask/guardrails.js'
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

function isWriterCall(call, token) {
  return userText(call.request).includes(token)
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

async function waitFor(condition, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return
    if (Date.now() > deadline) fail(`waitFor timed out: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function researchEvents(agent) {
  return agent.session.snapshotEvents()
    .filter((event) => event.type === 'multitask/research')
    .map((event) => event.data)
}

function claimEvents(agent) {
  return agent.session.snapshotEvents()
    .filter((event) => event.type === 'multitask/claims')
    .map((event) => event.data)
}

function liveClaims(agent) {
  const table = new Map()
  for (const event of claimEvents(agent)) {
    if (event.state === 'released') table.delete(event.path)
    else table.set(event.path, event)
  }
  return [...table.values()]
}

function queuedHandoffs(agent) {
  return [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
    .filter((message) => message.source?.kind === 'multitask')
}

function admittedHandoffs(agent) {
  return agent.session.deriveMessages().filter((message) => message.source.kind === 'multitask')
}

function handoffText(agent) {
  return [
    ...agent.inbox.nextTurn,
    ...agent.inbox.nextStep,
    ...agent.session.deriveMessages()
  ]
    .filter((message) => message.source?.kind === 'multitask')
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function parseCapReason(result) {
  const text = [
    result.error?.message ?? '',
    ...(result.content ?? []).map((block) => block.text ?? '')
  ].join('\n')
  const match = text.match(/\{[^{}]*"code"\s*:\s*"WRITER_CAP"[^{}]*\}/u)
  if (match === null) fail(`structured WRITER_CAP reason missing from ${JSON.stringify(text)}`)
  return JSON.parse(match[0])
}

async function runCommand(ctx, agent, line) {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (execution === undefined) fail(`command ${line} was not executed`)
  return execution
}

async function runSubagent(ctx, agent, description, prompt) {
  return ctx.tools.execute({
    callId: ToolCallId(`subagent-${Math.random().toString(16).slice(2)}`),
    name: 'subagent',
    arguments: { description, prompt, run_in_background: true },
    agent,
    signal: new AbortController().signal
  })
}

async function liveWriterIds(ctx, agent) {
  const descendants = await ctx.subagents.listDescendants(agent.session.id)
  return descendants
    .filter((entry) => entry.kind === 'child' && entry.activity === 'running' && entry.label !== RESEARCHER_LABEL)
    .map((entry) => String(entry.id))
}

function childIdOf(result) {
  return String(result.value?.subagentId ?? result.value?.childId ?? '')
}

function assertConfigMatrix() {
  if (multitask.DEFAULT_MAX_WRITERS !== 2) fail(`default maxWriters must be 2, got ${multitask.DEFAULT_MAX_WRITERS}`)
  if (JSON.stringify(multitask.resolveGuardrailsConfig()) !== JSON.stringify({ maxWriters: 2 })) {
    fail('resolveGuardrailsConfig() must default to { maxWriters: 2 }')
  }
  if (JSON.stringify(multitask.resolveGuardrailsConfig({ maxWriters: 3 })) !== JSON.stringify({ maxWriters: 3 })) {
    fail('resolveGuardrailsConfig must honor a custom cap')
  }
  for (const invalid of [0, -1, 1.5, '2']) {
    let threw = false
    try {
      multitask.resolveGuardrailsConfig({ maxWriters: invalid })
    } catch (error) {
      threw = /maxWriters/i.test(String(error?.message ?? error))
    }
    if (!threw) fail(`invalid maxWriters ${JSON.stringify(invalid)} must fail closed`)
  }
  log('check-multitask-guardrails: PASS config matrix (default 2, custom, fail-closed)')
}

async function compose(options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-guardrails-app-'))
  await mkdir(path.join(home, 'src'), { recursive: true })
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

  const calls = []
  const adapter = await ctx.plugin({
    inject: ['llm'],
    apply(pluginCtx) {
      pluginCtx.llm.registerAdapter(['scripted'], new ScriptedAdapter(async (call) => {
        calls.push(call)
        return options.respond?.(call) ?? (isResearcherCall(call) ? STRUCTURED_REPORT : `parent ack: ${userText(call.request).slice(0, 80)}`)
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
  const mounted = await ctx.plugin(multitask, {
    enabled: true,
    maxWriters: options.maxWriters,
    maxConsecutiveWakes: options.maxConsecutiveWakes ?? 2
  })
  push(() => mounted.dispose())
  const writers = await ctx.plugin(toolSubagent, {
    provider: 'spawn',
    backgroundMode: 'continuable'
  })
  push(() => writers.dispose())

  const handle = await ctx.agents.create({
    sessionId: SessionId(options.sessionId ?? 'guardrails-app'),
    meta: { cwd: home },
    agentOptions: { provider: 'scripted', model: 'orchestrator' }
  })
  push(() => handle.dispose())

  return {
    ctx,
    home,
    calls,
    agent: handle.agent,
    async dispose() {
      for (const dispose of [...disposers].reverse()) await dispose()
      await rm(home, { recursive: true, force: true })
    }
  }
}

async function assertRapidSettleCap() {
  const holdA = gate()
  const holdB = gate()
  const holdC = gate()
  const ends = new Map()
  const app = await compose({
    maxConsecutiveWakes: 2,
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
      return isResearcherCall(call) ? STRUCTURED_REPORT : `parent ack: ${userText(call.request).slice(0, 80)}`
    }
  })
  app.ctx.on('subagent/end', (info) => {
    ends.set(String(info.id), String(info.stopReason ?? ''))
  })
  try {
    if (app.ctx.tools.get('subagent', app.agent) === undefined) {
      fail('composed flow never reached the scoped subagent tool')
    }
    const guardrails = app.ctx.get('multitask.guardrails')
    if (guardrails?.driver?.config !== guardrails?.driverConfig) {
      fail('admission must consume the same round-driver config object')
    }
    if (guardrails?.driverConfig?.maxConsecutiveWakes !== 2) {
      fail('shared wake bound must stay on the driver config object')
    }

    await runCommand(app.ctx, app.agent, '/multitask first objective')
    const researching = researchEvents(app.agent).find((event) => event.phase === 'researching')
    if (researching?.childId == null) fail('command must spawn a researcher')
    await waitFor(() => app.ctx.agents.get(SessionId(String(researching.childId))) !== undefined, 'live researcher')
    const researcher = app.ctx.agents.get(SessionId(String(researching.childId)))
    const descriptor = researcher.session.snapshotEvents().find((event) => event.type === 'subagent/descriptor')
    if (descriptor?.data?.toolFilter?.deny == null) fail('researcher spawn did not record toolFilter')
    const deny = descriptor.data.toolFilter.deny
    for (const name of DENIED_TOOLS) {
      if (!deny.includes(name)) fail(`researcher toolFilter is missing ${name}: ${JSON.stringify(deny)}`)
    }
    if (app.ctx.tools.get('write', researcher) !== undefined) fail('researcher write tool leaked')

    app.ctx.get('multitask.claims')?.recordTouched?.(app.agent.session, PARENT_HELD)
    await runCommand(app.ctx, app.agent, '/multitask second objective')
    if (!liveClaims(app.agent).some((claim) => String(claim.path).includes(PARENT_HELD))) {
      fail('busy-parent touched path was not claimed before publication')
    }
    const published = handoffText(app.agent)
    if (!/Live claims/i.test(published) || !published.includes(PARENT_HELD)) {
      fail('handoff published before the busy-parent claim table was visible')
    }

    const first = await runSubagent(app.ctx, app.agent, 'writer-a', `writer A stays live to claim files; do not touch ${PARENT_HELD}`)
    if (first.isError) fail(`first writer must start: ${first.error?.message}`)
    const second = await runSubagent(app.ctx, app.agent, 'writer-b', `writer B stays live to claim files; do not touch ${PARENT_HELD}`)
    if (second.isError) fail(`second writer must start: ${second.error?.message}`)
    await waitFor(async () => (await liveWriterIds(app.ctx, app.agent)).length >= 2, 'two live writers')
    const liveBefore = await liveWriterIds(app.ctx, app.agent)
    if (liveBefore.length !== 2) fail(`expected two live writers, got ${liveBefore.length}`)

    const queuedBefore = queuedHandoffs(app.agent).map((message) => message.id)
    const third = await runSubagent(app.ctx, app.agent, 'writer-c', `writer C stays live to claim files; include ${PARENT_HELD}`)
    if (!third.isError) fail('third concurrent writer was not refused')
    const refusal = parseCapReason(third)
    if (refusal.code !== 'WRITER_CAP' || refusal.maxWriters !== 2 || refusal.queue !== 'yield') {
      fail(`structured refusal was incomplete: ${JSON.stringify(refusal)}`)
    }
    const liveAfter = await liveWriterIds(app.ctx, app.agent)
    if (liveAfter.length !== 2) fail('third writer started a child at cap')
    const queuedAfter = queuedHandoffs(app.agent)
    const newQueued = queuedAfter.filter((message) => !queuedBefore.includes(message.id))
    const uniqueTasks = new Set(queuedAfter.map((message) => String(message.source.taskId)))
    if (uniqueTasks.size !== queuedAfter.length && queuedAfter.length > 0) {
      fail('later handoff queue was not unique per task')
    }
    if (newQueued.length > 1) fail(`refusal duplicated the later handoff (${newQueued.length})`)

    const firstId = childIdOf(first) || liveBefore[0]
    holdA.open()
    await waitFor(() => ends.get(firstId) === 'completed' || ends.size >= 1, 'first writer settled')
    await waitFor(async () => (await liveWriterIds(app.ctx, app.agent)).length <= 1, 'reservation released after settlement')

    const later = await runSubagent(app.ctx, app.agent, 'writer-c-later', `writer C stays live to claim files; include ${PARENT_HELD}`)
    if (later.isError) fail(`later admission must start after settlement: ${later.error?.message}`)
    const laterId = childIdOf(later)
    await waitFor(() => app.ctx.agents.get(SessionId(laterId)) !== undefined, 'later writer agent')
    const laterChild = app.ctx.agents.get(SessionId(laterId))
    const laterBrief = laterChild.session.deriveMessages()
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (laterBrief.includes(PARENT_HELD)) fail('admitted writer brief included a parent-held path')
    for (const call of app.calls.filter((call) => isWriterCall(call, 'stays live'))) {
      if (userText(call.request).includes(PARENT_HELD)) {
        fail('writer child model input included a parent-held path')
      }
    }

    holdB.open()
    holdC.open()
    await app.agent.whenIdle()
    log('check-multitask-guardrails: PASS cap, later admission, queue uniqueness, brief exclusion, researcher filter')
  } finally {
    holdA.open()
    holdB.open()
    holdC.open()
    await app.dispose().catch(() => {})
  }
}

async function assertSharedBound() {
  const app = await compose({ maxConsecutiveWakes: 2 })
  try {
    const guardrails = app.ctx.get('multitask.guardrails')
    if (guardrails?.driver?.config !== guardrails?.driverConfig) {
      fail('bound narration must use the same driver config object')
    }
    await runCommand(app.ctx, app.agent, '/multitask bound the settle loop')
    await waitFor(() => researchEvents(app.agent).some((event) => event.phase === 'researched'), 'first researcher settled')
    await waitFor(() => admittedHandoffs(app.agent).length >= 1, 'command handoff admitted')
    await app.agent.whenIdle()
    for (const label of ['settle-2', 'settle-3']) {
      await app.ctx.subagents.startContinuable({
        provider: 'spawn',
        label,
        request: {
          prompt: [{ type: 'text', text: `do not modify files\nRecommended claim set\nstructured research report ${label}` }],
          parent: app.agent,
          persona: RESEARCHER_LABEL,
          toolFilter: { deny: [...DENIED_TOOLS] }
        },
        signal: new AbortController().signal
      })
    }
    await app.agent.whenIdle()
    const afterSettlements = admittedHandoffs(app.agent).length
    if (afterSettlements > 2) fail(`settlement wakes exceeded the shared bound: ${afterSettlements}`)
    if (afterSettlements !== 2) fail(`expected 2 automatic rounds, got ${afterSettlements}`)
    await app.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'settle-over-bound',
      request: {
        prompt: [{ type: 'text', text: 'do not modify files\nRecommended claim set\nstructured research report over bound' }],
        parent: app.agent,
        persona: RESEARCHER_LABEL,
        toolFilter: { deny: [...DENIED_TOOLS] }
      },
      signal: new AbortController().signal
    })
    await app.agent.whenIdle()
    if (admittedHandoffs(app.agent).length !== afterSettlements) {
      fail('a second counter woke above the shared bound')
    }
    log('check-multitask-guardrails: PASS shared maxConsecutiveWakes bound')
  } finally {
    await app.dispose()
  }
}

try {
  assertConfigMatrix()
  await assertRapidSettleCap()
  await assertSharedBound()
  log('check-multitask-guardrails: PASS')
} catch (error) {
  if (error instanceof ScenarioFailure) {
    process.stderr.write(`check-multitask-guardrails: FAIL\n${error.message}\n`)
  } else {
    process.stderr.write(`check-multitask-guardrails: FAIL (unexpected error)\n${error?.stack ?? String(error)}\n`)
  }
  process.exit(1)
}
