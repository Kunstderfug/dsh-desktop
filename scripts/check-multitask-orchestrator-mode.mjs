#!/usr/bin/env node
// Real composed-application scenario for [multitask] orchestrator mode (issue #7).
//
// Composes the production scheduling path the desktop profile mounts: the
// permanent `dsh-multitask` plugin, real CommandRuntime, session event
// log/projections, agent pre-step, system-prompt assembly, stable tool
// registry, SubagentRuntime, resume, and fork. Only the model adapter and
// the writer-facing `subagent` adapter are scripted, matching the frozen
// `multitask_orchestrator_mode_gate` seam. The script asserts full history —
// pending mid-turn mint, accepted-boundary narration + section, writer
// dispatch rather than self-implementation, zero-task section removal,
// resume/fork fold, and byte-identical tool catalogs — not a fold helper or
// a static prompt snapshot.
//
// Exit 0 only when every observation succeeded.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Commands from '@deepseek-ai/dsh-commands'
import { createUserMessage, LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
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
  'Goal: implement the orchestrator-mode composed scenario',
  'Affected paths: packages/dsh-multitask/orchestrator-mode.js',
  'Implementation plan: dispatch a writer through subagent',
  'Risks: parent self-implementation',
  'Recommended claim set: packages/dsh-multitask/orchestrator-mode.js'
].join('\n')

const ORCHESTRATOR_GUIDANCE = [
  'You are the orchestrator',
  'dispatch a writer through the `subagent` tool',
  'do not implement the task yourself',
  'Prefer yielding over blocking waits'
]
const ACTIVATION_NARRATION = /Multitask task MT-\d+ handed off; you are the orchestrator\./u

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

function systemText(request) {
  const messages = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''))
    .join('\n')
  return `${request.system ?? ''}\n${messages}`
}

function hasOrchestratorGuidance(request) {
  const text = systemText(request)
  return ORCHESTRATOR_GUIDANCE.every((phrase) => text.includes(phrase))
}

function isResearcherCall(call) {
  const text = userText(call.request)
  return text.includes('do not modify files')
    || text.includes('Recommended claim set')
    || text.includes('structured research report')
}

function isParentCall(call) {
  return call.model === 'orchestrator' && !isResearcherCall(call)
}

function* subagentChunks() {
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

function* writeChunks() {
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

function defaultRespond(call) {
  if (isResearcherCall(call)) return STRUCTURED_REPORT
  if (inToolFollowup(call.request)) return `parent ack: ${call.model}`
  if (hasOrchestratorGuidance(call.request)) return subagentChunks()
  if (isParentCall(call) && /implement (the feature|this) yourself/iu.test(userText(call.request))) {
    return writeChunks()
  }
  return `parent ack: ${call.model}`
}

function inToolFollowup(request) {
  const lastAssistant = [...request.messages].toReversed().find((message) => message.role === 'assistant')
  return lastAssistant?.content.some((block) => block.type === 'tool-call') === true
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

function catalogFingerprint(tools) {
  return JSON.stringify((tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  })).toSorted((left, right) => left.name.localeCompare(right.name)))
}

function modeEvents(agent) {
  return agent.session.snapshotEvents()
    .filter((event) => event.type === 'multitask/mode')
    .map((event) => event.data)
}

function modeView(ctx, agent) {
  const snapshot = ctx.sessionProjections.snapshot(agent.session, ['multitask-mode'])
  return snapshot.values['multitask-mode']
}

function toolCallNames(agent) {
  return agent.session.snapshotEvents()
    .filter((event) => event.type === 'tool/call')
    .map((event) => String(event.data.name ?? ''))
}

function headerCatalogs(agent) {
  return agent.session.snapshotEvents()
    .filter((event) => event.type === 'request/header')
    .map((event) => catalogFingerprint(event.data.header?.tools))
}

async function compose(options = {}) {
  const home = options.home ?? await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-orchestrator-app-'))
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
  const subagentCalls = []
  for (const name of ['write', 'edit', 'str_replace_editor']) {
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
      return { kind: 'continuable', subagentId: 'writer-1' }
    }
  }))

  const calls = []
  const adapter = await ctx.plugin({
    inject: ['llm'],
    apply(pluginCtx) {
      pluginCtx.llm.registerAdapter(['scripted'], new ScriptedAdapter(async (call) => {
        calls.push(call)
        return options.respond?.(call) ?? defaultRespond(call)
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

  return {
    ctx,
    home,
    writes,
    subagentCalls,
    calls,
    ownedHome: options.home === undefined,
    async agent(id) {
      const handle = await ctx.agents.create({
        sessionId: SessionId(id),
        meta: { cwd: home },
        agentOptions: { provider: 'scripted', model: 'orchestrator' }
      })
      push(() => handle.dispose())
      return handle.agent
    },
    async dispose() {
      for (const dispose of [...disposers].reverse()) await dispose()
      if (options.home === undefined) await rm(home, { recursive: true, force: true })
    }
  }
}

async function runCommand(app, agent, line) {
  const execution = await app.ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (execution === undefined) fail(`command ${line} was not executed`)
  return execution
}

function requireMode(ctx) {
  if (ctx.multitaskMode === undefined) {
    fail('orchestrator mode controller is not mounted on the composed plugin')
  }
  return ctx.multitaskMode
}

async function assertGuidanceAndDispatch() {
  const held = gate()
  const app = await compose({
    respond: async (call) => {
      if (isResearcherCall(call)) return STRUCTURED_REPORT
      if (
        isParentCall(call)
        && userText(call.request).includes('task A in progress')
        && !call.request.messages.some((message) => message.role === 'assistant')
      ) {
        await holdUntil(call.request.signal, held.promise)
        return 'task A still running'
      }
      return defaultRespond(call)
    }
  })
  try {
    const agent = await app.agent('compose-1')
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'task A in progress' }],
      source: { kind: 'user' }
    }))
    await waitFor(() => app.calls.some((call) => isParentCall(call) && userText(call.request).includes('task A in progress')), 'held task A')
    if (modeEvents(agent).length !== 0) fail('mode committed before /multitask')

    await runCommand(app, agent, '/multitask research and implement task B')
    if (modeEvents(agent).length !== 0) {
      fail('mid-turn task mint committed orchestrator mode before the accepted pre-step')
    }

    held.open()
    await agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue; implement this yourself if you are not the orchestrator' }],
      source: { kind: 'user' }
    }))
    await agent.whenIdle()

    const active = app.calls.find((call) =>
      isParentCall(call)
      && (hasOrchestratorGuidance(call.request) || ACTIVATION_NARRATION.test(userText(call.request))))
    if (active === undefined) fail('no post-boundary parent request was assembled')
    if (!hasOrchestratorGuidance(active.request)) {
      fail('open task did not publish the named multitask:orchestrator section; scripted model had no orchestrator guidance')
    }
    if (!ACTIVATION_NARRATION.test(userText(active.request))) {
      fail('activation omitted the ticket-named orchestrator narration')
    }
    const view = modeView(app.ctx, agent)
    if (view?.active !== true || JSON.stringify(view.openTasks) !== JSON.stringify(['MT-1'])) {
      fail(`folded mode view was ${JSON.stringify(view)} after an open task`)
    }
    if (!toolCallNames(agent).includes('subagent')) {
      fail('scripted model did not invoke the writer-facing subagent tool')
    }
    if (toolCallNames(agent).includes('write') || app.writes.length > 0) {
      fail('parent self-implemented instead of dispatching a writer')
    }
    if (app.subagentCalls.length === 0) fail('writer-facing subagent adapter was not invoked')
    log('check-multitask-orchestrator-mode: PASS open-task section, narration, and writer dispatch')
    return catalogFingerprint(active.request.tools)
  } finally {
    await app.dispose()
  }
}

async function assertZeroTasksOmitSection() {
  const app = await compose()
  try {
    const agent = await app.agent('compose-zero')
    const view = modeView(app.ctx, agent)
    if (view !== undefined && (view.active !== false || view.openTasks?.length !== 0)) {
      fail(`zero-task view was ${JSON.stringify(view)}`)
    }
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'implement the feature yourself' }],
      source: { kind: 'user' }
    }))
    await agent.whenIdle()
    const idle = app.calls.find((call) => isParentCall(call))
    if (idle === undefined) fail('zero-task parent request was missing')
    if (hasOrchestratorGuidance(idle.request)) {
      fail('orchestrator section was present with zero open tasks')
    }
    if (modeEvents(agent).length !== 0) fail('zero-task log contained a mode commit')
    log('check-multitask-orchestrator-mode: PASS zero open tasks omit the section')
  } finally {
    await app.dispose()
  }
}

async function assertResumeForkAndCatalog() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-orchestrator-app-resume-'))
  let seed
  let activeCatalog
  {
    const app = await compose({ home })
    try {
      const agent = await app.agent('session-1')
      await runCommand(app, agent, '/multitask restore this mode from the log')
      await agent.whenIdle()
      await waitFor(() => agent.session.snapshotEvents().some((event) =>
        event.type === 'multitask/research'
        && (event.data.phase === 'researched'
          || event.data.phase === 'research-failed'
          || event.data.phase === 'researching')),
      'researcher launched')
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'orchestrate the restored task' }],
        source: { kind: 'user' }
      }))
      await agent.whenIdle()
      const view = modeView(app.ctx, agent)
      if (view?.active !== true || JSON.stringify(view.openTasks) !== JSON.stringify(['MT-1'])) {
        fail(`pre-resume view was ${JSON.stringify(view)}`)
      }
      const active = app.calls.find((call) => isParentCall(call) && hasOrchestratorGuidance(call.request))
      if (active === undefined) fail('active request before restart was missing')
      activeCatalog = catalogFingerprint(active.request.tools)
      seed = agent.session.snapshotEvents()
    } finally {
      await app.dispose()
    }
  }

  const resumed = await compose({ home })
  try {
    const handle = await resumed.ctx.agents.resume({
      resumeSessionId: SessionId('session-1'),
      agentOptions: { provider: 'scripted', model: 'orchestrator' }
    })
    const restored = modeView(resumed.ctx, handle.agent)
    if (restored?.active !== true || JSON.stringify(restored.openTasks) !== JSON.stringify(['MT-1'])) {
      fail(`resume did not restore folded mode state: ${JSON.stringify(restored)}`)
    }

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
    const forked = modeView(resumed.ctx, forkHandle.agent)
    if (forked?.active !== true || JSON.stringify(forked.openTasks) !== JSON.stringify(['MT-1'])) {
      fail(`fork did not restore folded mode state: ${JSON.stringify(forked)}`)
    }

    requireMode(resumed.ctx).noteTaskClosed(handle.agent, 'MT-1')
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'implement the feature yourself after close' }],
      source: { kind: 'user' }
    }))
    await handle.agent.whenIdle()
    const closed = modeView(resumed.ctx, handle.agent)
    if (closed?.active !== false || closed.openTasks?.length !== 0) {
      fail(`close did not deactivate folded mode: ${JSON.stringify(closed)}`)
    }
    const stillForked = modeView(resumed.ctx, forkHandle.agent)
    if (stillForked?.active !== true || JSON.stringify(stillForked.openTasks) !== JSON.stringify(['MT-1'])) {
      fail(`fork diverged unexpectedly after parent close: ${JSON.stringify(stillForked)}`)
    }
    const closedCall = resumed.calls.find((call) =>
      isParentCall(call) && userText(call.request).includes('after close'))
    if (closedCall === undefined) fail('post-close parent request was missing')
    if (hasOrchestratorGuidance(closedCall.request)) {
      fail('orchestrator section remained after all tasks closed')
    }
    if (catalogFingerprint(closedCall.request.tools) !== activeCatalog) {
      fail('request tool catalog changed across mode deactivation')
    }
    if (new Set(headerCatalogs(handle.agent)).size !== 1) {
      fail(`request/header tool catalogs diverged: ${headerCatalogs(handle.agent).join(' | ')}`)
    }
    await forkHandle.dispose()
    await handle.dispose()
    log('check-multitask-orchestrator-mode: PASS resume/fork fold and invariant tool catalog')
  } finally {
    await resumed.dispose()
    await rm(home, { recursive: true, force: true })
  }
}

async function main() {
  await assertZeroTasksOmitSection()
  await assertGuidanceAndDispatch()
  await assertResumeForkAndCatalog()
  log('check-multitask-orchestrator-mode: all observations passed')
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(error instanceof ScenarioFailure ? 1 : 2)
})
