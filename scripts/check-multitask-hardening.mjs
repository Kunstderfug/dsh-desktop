#!/usr/bin/env node
// Real composed-application hardening matrix for [multitask] (issue #12).
//
// Composes the production path the desktop profile mounts: the permanent
// `dsh-multitask` host plugin, `dsh-multitask-client` task-card fold,
// command runtime, session persistence and log fold, claims, researcher and
// writer spawn, guardrails, round-driver, approval/sandbox inheritance, and
// the paired-phone/narrow text representation. Only model decisions, child
// settlement, kill, and restart/fold are scripted, matching the frozen
// `multitask_hardening_gate` seam. The script asserts full history — not a
// helper call, a keepInbox grep, or a final-state snapshot.
//
// Exit 0 only when every observation succeeded.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Commands from '@deepseek-ai/dsh-commands'
import { createUserMessage, LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as subagentSpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as toolSubagent from '@deepseek-ai/dsh-tool-subagent'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as multitask from '../packages/dsh-multitask/index.js'
import * as researcher from '../packages/dsh-multitask/researcher.js'

const DENIED_TOOLS = ['write', 'edit', 'str_replace_editor']
const RESEARCHER_LABEL = 'researcher'
const STRUCTURED_REPORT = [
  'Goal: harden the composed multitask matrix',
  'Affected paths: packages/dsh-multitask/index.js',
  'Implementation plan: retry once, release claims, keep inbox',
  'Risks: hidden failure and leaked dead-owner claims',
  'Recommended claim set: packages/dsh-multitask/index.js'
].join('\n')
const projectRoot = path.join(import.meta.dirname, '..')
const FORBIDDEN_PREFIXES = ['patches/']

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

function loadClient() {
  const source = readFileSync(path.join(projectRoot, 'packages/dsh-multitask-client/client.js'), 'utf8')
  let definition
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load: (value) => {
          definition = value
        }
      }
    }
  })
  return definition.factory((id) => {
    if (id === 'react') {
      return {
        createElement: () => ({}),
        useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
        useEffect: () => {},
        useMemo: (factory) => factory(),
        useState: (initial) => [initial, () => {}],
        memo: (component) => component
      }
    }
    throw new Error(`unexpected client require ${id}`)
  })
}

function foldCard(agent, taskId) {
  const plugin = loadClient()
  const folded = plugin.foldTasks(agent.session.snapshotEvents())
  const task = folded.find((row) => row.id === taskId)
  if (task === undefined) fail(`fold is missing task ${taskId}`)
  return { task, text: plugin.formatTaskCardText(task) }
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

function taskEvents(agent) {
  return agent.session.snapshotEvents()
    .filter((event) => event.type === 'multitask/task')
    .map((event) => event.data)
}

function phaseEvents(agent) {
  return agent.session.snapshotEvents()
    .filter((event) => event.type === 'multitask/phase')
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

function modeView(ctx, agent) {
  const snapshot = ctx.sessionProjections.snapshot(agent.session, ['multitask-mode'])
  const value = snapshot.values['multitask-mode']
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  if (typeof value.active !== 'boolean' || !Array.isArray(value.openTasks)) return undefined
  return {
    active: value.active,
    openTasks: value.openTasks.map((id) => String(id))
  }
}

function admittedHandoffs(agent) {
  return agent.session.deriveMessages().filter((message) => message.source.kind === 'multitask')
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

async function runTool(ctx, agent, name, args) {
  return ctx.tools.execute({
    callId: ToolCallId(`${name}-${Math.random().toString(16).slice(2)}`),
    name,
    arguments: args,
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

function registerMutationTools(ctx) {
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

async function compose(options = {}) {
  const home = options.home ?? await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-hardening-app-'))
  if (options.ownedHome !== true) await mkdir(path.join(home, 'src'), { recursive: true })
  const ctx = new Context()
  const cores = []
  const push = (name, dispose) => {
    let settled
    const once = async () => {
      settled ??= Promise.resolve().then(() => dispose())
      await settled
    }
    cores.push({ name, dispose: once })
  }

  const prompt = await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  push('prompt', () => prompt.dispose())
  const projections = await ctx.plugin(SessionProjectionRegistry)
  push('projections', () => projections.dispose())
  const sandbox = await ctx.plugin(SandboxPolicyService, {
    mode: options.sandboxMode ?? 'workspace-write',
    workspaceRoot: home
  })
  push('sandbox', () => sandbox.dispose())
  const approval = await ctx.plugin(ApprovalService)
  push('approval', () => approval.dispose())
  const sessions = await ctx.plugin(SessionStore)
  push('sessions', () => sessions.dispose())
  const tools = await ctx.plugin(ToolRuntime)
  push('tools', () => tools.dispose())
  const llm = await ctx.plugin(LlmRuntime)
  push('llm', () => llm.dispose())
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: home })
  push('persistence', () => persistence.dispose())
  const registry = await ctx.plugin(AgentRegistry)
  push('registry', () => registry.dispose())
  const commands = await ctx.plugin(Commands)
  push('commands', () => commands.dispose())
  registerMutationTools(ctx)

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
  push('adapter', () => adapter.dispose())
  const loop = await ctx.plugin(AgentLoop)
  push('loop', () => loop.dispose())
  const subagents = await ctx.plugin(SubagentRuntime)
  push('subagents', () => subagents.dispose())
  const spawn = await ctx.plugin(subagentSpawnInProcess)
  push('spawn', () => spawn.dispose())
  const query = await ctx.plugin(SessionQueryEngine)
  push('query', () => query.dispose())
  const mounted = await ctx.plugin(multitask, {
    enabled: true,
    maxWriters: options.maxWriters,
    maxConsecutiveWakes: options.maxConsecutiveWakes ?? 2
  })
  push('multitask', () => mounted.dispose())
  const writers = await ctx.plugin(toolSubagent, {
    provider: 'spawn',
    backgroundMode: 'continuable'
  })
  push('writers', () => writers.dispose())

  let agent
  if (options.resumeSessionId) {
    const handle = await ctx.agents.resume({
      resumeSessionId: SessionId(options.resumeSessionId),
      agentOptions: { provider: 'scripted', model: 'orchestrator' }
    })
    push('agent', () => handle.dispose())
    agent = handle.agent
  } else {
    const handle = await ctx.agents.create({
      sessionId: SessionId(options.sessionId ?? 'hardening-app'),
      meta: { cwd: home },
      agentOptions: { provider: 'scripted', model: 'orchestrator' }
    })
    push('agent', () => handle.dispose())
    agent = handle.agent
    setSandboxMode(agent.session, options.sandboxMode ?? 'workspace-write')
  }

  return {
    ctx,
    home,
    calls,
    agent,
    async dispose() {
      for (const core of [...cores].reverse()) await core.dispose()
      if (options.keepHome !== true) await rm(home, { recursive: true, force: true })
    },
    async disposeCoreSkipping(skip) {
      for (const core of [...cores].reverse()) {
        if (skip.includes(core.name)) continue
        await core.dispose()
      }
    }
  }
}

function assertForbiddenWork() {
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: projectRoot,
    encoding: 'utf8'
  })
  const forbidden = dirty
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter((file) => FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix)))
  if (forbidden.length > 0) fail(`forbidden patches/ work: ${forbidden.join('\n')}`)
  log('check-multitask-hardening: PASS forbidden-work observation (no patches/)')
}

async function assertResearcherRetryOnce() {
  if (researcher.RESEARCH_RETRY_LIMIT !== 1) fail(`RESEARCH_RETRY_LIMIT must be 1, got ${researcher.RESEARCH_RETRY_LIMIT}`)
  let researcherCalls = 0
  const app = await compose({
    respond: async (call) => {
      if (!isResearcherCall(call)) return 'parent ack'
      researcherCalls += 1
      throw new Error(`scripted researcher failure ${researcherCalls}`)
    }
  })
  try {
    await runCommand(app.ctx, app.agent, '/multitask retry the researcher once')
    await waitFor(() => researchEvents(app.agent).some((event) => event.phase === 'research-failed'), 'first researcher failure')
    if (!researcher.shouldRetryResearch(app.agent.session, 'MT-1')) fail('first failure must still be retryable')
    await waitFor(() => researchEvents(app.agent).filter((event) => event.phase === 'researching').length === 2, 'retry launch')
    await waitFor(() => researchEvents(app.agent).filter((event) => event.phase === 'research-failed').length === 2, 'retry exhausted')
    if (researcher.shouldRetryResearch(app.agent.session, 'MT-1')) fail('a second retry hid or reset the first failure')
    if (researcherCalls !== 2) fail(`expected exactly one retry, got ${researcherCalls} researcher calls`)
    if (!phaseEvents(app.agent).some((event) => event.id === 'MT-1' && event.phase === 'failed')) {
      fail('retry-exhausted researcher did not publish a failure phase')
    }
    const card = foldCard(app.agent, 'MT-1')
    if (card.task.failed !== true || card.task.phase !== 'failed') fail(`failure card missing: ${JSON.stringify(card.task)}`)
    if (!card.text.includes('MT-1') || !/fail/i.test(card.text) || !/retry/i.test(card.text)) {
      fail(`narrow/failure text is not actionable: ${card.text}`)
    }
    log('check-multitask-hardening: PASS researcher retry-once then visible failure')
  } finally {
    await app.dispose()
  }
}

async function assertWriterFailureCard() {
  const hold = gate()
  const app = await compose({
    respond: async (call) => {
      if (isWriterCall(call, 'writer will fail')) {
        await holdUntil(call.request.signal, hold.promise)
        throw new Error('scripted writer transport failure')
      }
      return isResearcherCall(call) ? STRUCTURED_REPORT : 'parent ack'
    }
  })
  try {
    await runCommand(app.ctx, app.agent, '/multitask writer failure card')
    await waitFor(() => researchEvents(app.agent).some((event) => event.phase === 'researched'), 'researcher settled')
    const started = await runSubagent(app.ctx, app.agent, 'writer-fail', 'writer will fail after claiming')
    if (started.isError) fail(`writer must start: ${started.error?.message}`)
    const writerId = childIdOf(started)
    await waitFor(() => app.ctx.agents.get(SessionId(writerId)) !== undefined, 'live writer')
    const writer = app.ctx.agents.get(SessionId(writerId))
    const claimed = await runTool(app.ctx, writer, 'claim_files', { paths: ['src/writer-fail.ts'], taskId: 'MT-1' })
    if (claimed.isError) fail(`writer claim failed: ${claimed.error?.message}`)
    hold.open()
    await waitFor(() => liveClaims(app.agent).every((claim) => claim.ownerSessionId !== writerId), 'writer claims released')
    await waitFor(() => phaseEvents(app.agent).some((event) => event.id === 'MT-1' && event.phase === 'failed'), 'writer failure phase')
    const card = foldCard(app.agent, 'MT-1')
    if (card.task.failed !== true) fail('writer failure card is not failed')
    if (!card.text.includes('MT-1') || !/fail/i.test(card.text)) fail(`writer failure card is not actionable: ${card.text}`)
    log('check-multitask-hardening: PASS writer failure releases claims and shows a card')
  } finally {
    hold.open()
    await app.dispose()
  }
}

async function assertKillAndRestart() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-hardening-restart-'))
  await mkdir(path.join(home, 'src'), { recursive: true })
  const hold = gate()
  const first = await compose({
    home,
    ownedHome: true,
    keepHome: true,
    sessionId: 'session-1',
    respond: async (call) => {
      if (isWriterCall(call, 'writer stays live across kill')) {
        await holdUntil(call.request.signal, hold.promise)
        return 'writer completed after restart'
      }
      return isResearcherCall(call) ? STRUCTURED_REPORT : 'parent ack'
    }
  })
  try {
    await runCommand(first.ctx, first.agent, '/multitask survive kill and restart')
    await waitFor(() => researchEvents(first.agent).some((event) => event.phase === 'researched'), 'researcher settled before kill')
    await waitFor(() => first.agent.session.snapshotEvents().some((event) =>
      event.type === 'multitask/mode' && event.data?.active === true
    ), 'orchestrator mode committed before kill')
    const started = await runSubagent(first.ctx, first.agent, 'writer-kill', 'writer stays live across kill')
    if (started.isError) fail(`writer must start: ${started.error?.message}`)
    const writerId = childIdOf(started)
    await waitFor(() => first.ctx.agents.get(SessionId(writerId)) !== undefined, 'live writer before kill')
    const writer = first.ctx.agents.get(SessionId(writerId))
    const claimed = await runTool(first.ctx, writer, 'claim_files', { paths: ['src/dead-owner.ts'], taskId: 'MT-1' })
    if (claimed.isError) fail(`writer claim failed: ${claimed.error?.message}`)
    if (taskEvents(first.agent).map((event) => event.id).join(',') !== 'MT-1') fail('pre-kill task identity drifted')
    await first.disposeCoreSkipping(['loop', 'registry', 'sessions', 'projections', 'prompt', 'tools', 'llm'])
  } finally {
    hold.open()
  }

  const resumed = await compose({
    home,
    ownedHome: true,
    resumeSessionId: 'session-1'
  })
  try {
    const parent = resumed.agent
    if (taskEvents(parent).map((event) => event.id).join(',') !== 'MT-1') {
      fail(`restart fold lost the open task: ${JSON.stringify(taskEvents(parent))}`)
    }
    await waitFor(() => liveClaims(parent).every((claim) => claim.path !== 'src/dead-owner.ts'), 'dead-owner claim expired')
    const view = modeView(resumed.ctx, parent)
    if (view?.active !== true || !view.openTasks?.includes('MT-1')) {
      fail(`mode did not restore from the log: ${JSON.stringify(view)}`)
    }
    const next = await runCommand(resumed.ctx, parent, '/multitask continue after restart')
    if (!String(next.result?.text ?? '').includes('MT-2')) fail('restart mint was not fold-derived')
    log('check-multitask-hardening: PASS kill/restart fold restores task, mode, and claims')
  } finally {
    await resumed.dispose()
  }
}

async function assertAbuseAndCancel() {
  const parentHold = gate()
  const holdA = gate()
  const holdB = gate()
  const app = await compose({
    maxWriters: 2,
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
      if (!isResearcherCall(call) && userText(call.request).includes('task A stays busy')) {
        await holdUntil(call.request.signal, parentHold.promise)
        return 'task A still running'
      }
      return isResearcherCall(call) ? STRUCTURED_REPORT : 'parent ack'
    }
  })
  try {
    app.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'task A stays busy' }],
      source: { kind: 'user' }
    }))
    await waitFor(() => app.calls.some((call) => userText(call.request).includes('task A stays busy')), 'held parent turn')
    await runCommand(app.ctx, app.agent, '/multitask rapid one')
    await runCommand(app.ctx, app.agent, '/multitask rapid two')
    await runCommand(app.ctx, app.agent, '/multitask rapid three')
    const ids = taskEvents(app.agent).map((event) => String(event.id))
    if (new Set(ids).size !== ids.length) fail(`rapid /multitask reused a task id: ${ids.join(',')}`)
    const inboxBefore = [...app.agent.inbox.nextTurn, ...app.agent.inbox.nextStep]
    if (!inboxBefore.some((message) => message.source?.kind === 'multitask')) fail('rapid submit dropped the inbox')
    app.agent.cancel({ kind: 'user' }, { keepInbox: true })
    await app.agent.whenIdle()
    const inboxAfter = [...app.agent.inbox.nextTurn, ...app.agent.inbox.nextStep]
    if (!inboxAfter.some((message) => message.source?.kind === 'multitask')) {
      fail('cancel-mid-task dropped the inbox; keepInbox is required')
    }
    parentHold.open()
    await app.agent.whenIdle()

    const writerA = await runSubagent(app.ctx, app.agent, 'writer-a', 'writer A stays live under cap')
    const writerB = await runSubagent(app.ctx, app.agent, 'writer-b', 'writer B stays live under cap')
    if (writerA.isError || writerB.isError) fail('first two writers must start')
    await waitFor(async () => (await liveWriterIds(app.ctx, app.agent)).length >= 2, 'two live writers')
    const refused = await runSubagent(app.ctx, app.agent, 'writer-c', 'writer C should hit the cap')
    if (!refused.isError) fail('cap conflict did not refuse the third writer')
    if (parseCapReason(refused).code !== 'WRITER_CAP') fail('cap refusal was not structured')
    log('check-multitask-hardening: PASS rapid submit, cancel-keepInbox, and cap conflict')
  } finally {
    parentHold.open()
    holdA.open()
    holdB.open()
    await app.dispose()
  }
}

async function assertInstantSettleBound() {
  const app = await compose({ maxConsecutiveWakes: 2 })
  try {
    await runCommand(app.ctx, app.agent, '/multitask bound instant settlers')
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
    if (admittedHandoffs(app.agent).length !== afterSettlements) fail('instant-settle children broke the shared wake bound')
    log('check-multitask-hardening: PASS instant-settle wake bound')
  } finally {
    await app.dispose()
  }
}

async function assertApprovalAndNarrow() {
  const hold = gate()
  const app = await compose({
    sandboxMode: 'workspace-write',
    respond: async (call) => {
      if (isWriterCall(call, 'writer reviews the diff')) {
        await holdUntil(call.request.signal, hold.promise)
        return 'writer diff handoff ready'
      }
      return isResearcherCall(call) ? STRUCTURED_REPORT : 'parent ack'
    }
  })
  try {
    await runCommand(app.ctx, app.agent, '/multitask pin writer approval')
    await waitFor(() => researchEvents(app.agent).some((event) => event.phase === 'researched'), 'researcher settled')
    const started = await runSubagent(app.ctx, app.agent, 'writer-approval', 'writer reviews the diff')
    if (started.isError) fail(`writer must start: ${started.error?.message}`)
    const writerId = childIdOf(started)
    await waitFor(() => app.ctx.agents.get(SessionId(writerId)) !== undefined, 'live writer for approval')
    const writer = app.ctx.agents.get(SessionId(writerId))
    const events = writer.session.snapshotEvents()
    if (!events.some((event) => event.type === 'approval/policy' && event.data?.policy === 'never' && event.data?.source === 'delegation')) {
      fail('writer spawn did not pin approval never')
    }
    if (!events.some((event) => event.type === 'sandbox/mode' && event.data?.mode === 'workspace-write' && event.data?.source === 'delegation')) {
      fail('writer spawn did not inherit the parent sandbox override')
    }
    if (events.some((event) => event.type === 'approval/asked')) fail('writer delegation created an unexpected approval prompt')
    hold.open()
    await waitFor(() => app.agent.session.deriveMessages().some((message) =>
      message.source.kind === 'subagent-settled'
      && message.content.some((block) => block.type === 'text' && String(block.text).includes('diff handoff'))
    ), 'orchestrator reviewed the writer diff handoff')
    app.agent.session.append('multitask/phase', {
      id: 'MT-1',
      objective: 'pin writer approval',
      phase: 'failed',
      createdAt: new Date().toISOString(),
      note: 'Writer failed. Claims were released. Review the diff handoff or retry the task.'
    })
    const card = foldCard(app.agent, 'MT-1')
    if (!card.text.includes('MT-1') || !/fail/i.test(card.text) || !card.text.includes('pin writer approval')) {
      fail(`paired-phone/narrow text is missing the task or failure: ${card.text}`)
    }
    if (/<[^>]+>/.test(card.text)) fail('narrow surface still depends on markup')
    log('check-multitask-hardening: PASS approval-never, sandbox inherit, and narrow failure text')
  } finally {
    hold.open()
    await app.dispose()
  }
}

try {
  assertForbiddenWork()
  await assertResearcherRetryOnce()
  await assertWriterFailureCard()
  await assertKillAndRestart()
  await assertAbuseAndCancel()
  await assertInstantSettleBound()
  await assertApprovalAndNarrow()
  log('check-multitask-hardening: PASS')
} catch (error) {
  if (error instanceof ScenarioFailure) {
    process.stderr.write(`check-multitask-hardening: FAIL\n${error.message}\n`)
  } else {
    process.stderr.write(`check-multitask-hardening: FAIL (unexpected error)\n${error?.stack ?? String(error)}\n`)
  }
  process.exit(1)
}
