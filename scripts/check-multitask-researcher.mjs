#!/usr/bin/env node
// Real composed-application scenario for the [multitask] researcher (issue #5).
//
// Composes the production command path the desktop profile mounts: the
// permanent `dsh-multitask` plugin, real CommandRuntime, real SubagentRuntime
// plus in-process spawn, real JSONL persistence, real session query, and the
// real agent loop. Only the model adapter is scripted, matching the frozen
// `multitask_researcher_gate` seam. The script asserts full history — launch
// while task A runs, child toolFilter denial, structured-report retrieval,
// and every supported settlement failure — not a final-phase-only snapshot.
//
// Exit 0 only when every observation succeeded.

import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as subagentSpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as multitask from '../packages/dsh-multitask/index.js'

const RESEARCHER_LABEL = 'researcher'
const DENIED_TOOLS = ['write', 'edit', 'str_replace_editor']
const REPORT_HEADINGS = [
  'Goal',
  'Affected paths',
  'Implementation plan',
  'Risks',
  'Recommended claim set'
]
const STRUCTURED_REPORT = [
  'Goal: implement the researcher brief for task B',
  'Affected paths: packages/dsh-multitask/index.js, packages/dsh-multitask/researcher.js',
  'Implementation plan: spawn a continuable researcher, then map settlement',
  'Risks: parent-turn interruption and write-tool leakage',
  'Recommended claim set: packages/dsh-multitask/index.js'
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

function taskEvents(agent) {
  return agent.session.snapshotEvents()
    .filter((event) => event.type === 'multitask/research')
    .map((event) => event.data)
}

function turnCount(agent) {
  return agent.session.snapshotEvents().filter((event) => event.type === 'turn/start').length
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

function* writeMutationChunks(probePath) {
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

function* textChunks(text, reason = { kind: 'stop' }) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
  yield { type: 'finish', reason }
}

async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function registerMutationTools(ctx, writes) {
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

async function compose(options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-researcher-app-'))
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
  const probePath = path.join(home, 'researcher-probe.txt')
  registerMutationTools(ctx, writes)

  const calls = []
  const adapter = await ctx.plugin({
    inject: ['llm'],
    apply(pluginCtx) {
      pluginCtx.llm.registerAdapter(['scripted'], new ScriptedAdapter(async (call) => {
        calls.push(call)
        return options.respond?.(call) ?? (isResearcherCall(call) ? STRUCTURED_REPORT : `parent ack: ${call.model}`)
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

  if (options.rejectSubagentSteps === true) {
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent.session.header.origin === 'subagent') return { kind: 'reject' }
      return next()
    })
  }

  const mounted = await ctx.plugin(multitask)
  push(() => mounted.dispose())

  const handle = await ctx.agents.create({
    sessionId: SessionId(options.sessionId ?? 'researcher-app'),
    meta: { cwd: home },
    agentOptions: { provider: 'scripted', model: 'orchestrator' }
  })
  push(() => handle.dispose())

  return {
    ctx,
    home,
    probePath,
    writes,
    calls,
    agent: handle.agent,
    async dispose() {
      for (const dispose of [...disposers].reverse()) await dispose()
      await rm(home, { recursive: true, force: true })
    }
  }
}

async function runCommand(app, line) {
  const execution = await app.ctx.commands.execute(app.agent, line, [], new AbortController().signal)
  if (execution === undefined) fail(`command ${line} was not executed`)
  return execution
}

async function assertLaunchAndDenial() {
  const parentHold = gate()
  const researcherHold = gate()
  let writeCalls = 0
  const app = await compose({
    sessionId: 'launch-denial',
    respond: async (call) => {
      if (isResearcherCall(call)) {
        writeCalls += 1
        if (writeCalls === 1) {
          await holdUntil(call.request.signal, researcherHold.promise)
          return writeMutationChunks(app.probePath)
        }
        return STRUCTURED_REPORT
      }
      await holdUntil(call.request.signal, parentHold.promise)
      return 'task A still running'
    }
  })
  try {
    app.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'task A in progress' }],
      source: { kind: 'user' }
    }))
    await waitFor(() => app.calls.some((call) => !isResearcherCall(call)), 'held task A model call')
    const taskAInput = userText(app.calls.find((call) => !isResearcherCall(call)).request)
    if (app.agent.status !== 'running' || turnCount(app.agent) !== 1) {
      fail('task A was not a single running parent turn')
    }

    const started = Date.now()
    const execution = await runCommand(app, '/multitask research and implement task B')
    if (Date.now() - started >= 5_000) fail('researcher launch took longer than seconds')
    if (execution.result.kind !== 'success') fail(`launch command failed: ${JSON.stringify(execution.result)}`)

    if (!taskEvents(app.agent).some((event) => event.phase === 'researching')) {
      fail('command appended no researching researcher spawn (queued-only task event at base)')
    }
    await waitFor(() => taskEvents(app.agent).some((event) => event.phase === 'researching'), 'researching phase')
    const researching = taskEvents(app.agent).find((event) => event.phase === 'researching')
    if (researching.id !== 'MT-1' || researching.label !== RESEARCHER_LABEL || typeof researching.childId !== 'string') {
      fail(`researching event missing child identity: ${JSON.stringify(researching)}`)
    }
    const children = await app.ctx.subagents.listChildren(app.agent.id)
    if (children.length !== 1 || children[0].id !== researching.childId || children[0].label !== RESEARCHER_LABEL) {
      fail(`lineage does not list the researcher child: ${JSON.stringify(children)}`)
    }
    if (app.agent.status !== 'running' || turnCount(app.agent) !== 1) {
      fail('researcher launch opened or replaced the parent turn')
    }
    if (userText(app.calls.find((call) => !isResearcherCall(call)).request) !== taskAInput) {
      fail('task A model input changed during researcher launch')
    }
    if (app.agent.inbox.nextTurn.length !== 0) fail('researcher launch queued a parent followup')
    log('check-multitask-researcher: PASS launch while task A runs (researching child, lineage, parent turn untouched)')

    await waitFor(() => app.ctx.agents.get(SessionId(researching.childId)) !== undefined, 'live researcher')
    const child = app.ctx.agents.get(SessionId(researching.childId))
    if (app.ctx.tools.get('write', child) !== undefined) fail('write remains visible on the researcher')
    const descriptor = child.session.snapshotEvents().find((event) => event.type === 'subagent/descriptor')
    if (descriptor === undefined) fail('child has no durable descriptor')
    const deny = descriptor.data.toolFilter?.deny ?? []
    if (DENIED_TOOLS.some((name) => !deny.includes(name))) {
      fail(`child toolFilter deny is ${JSON.stringify(deny)}`)
    }
    if (!String(descriptor.data.persona ?? '').toLowerCase().includes('researcher')) {
      fail('spawn request lacks a researcher persona')
    }
    researcherHold.open()
    await waitFor(() =>
      child.session.snapshotEvents().some((event) => event.type === 'tool/result'),
    'denied mutation result')
    const toolResult = child.session.snapshotEvents().find((event) => event.type === 'tool/result')
    const denialText = JSON.stringify(toolResult.data)
    if (!denialText.includes('UNKNOWN_TOOL') || !/unknown tool \\?"write\\?"/i.test(denialText) || !denialText.includes('"isError":true')) {
      fail(`attempted mutation was not denied: ${denialText.slice(0, 300)}`)
    }
    if (denialText.includes('do not modify files')) {
      fail('denial depends on research-brief text')
    }
    parentHold.open()
    await waitFor(() => taskEvents(app.agent).some((event) => event.phase === 'researched'), 'completed → researched')
    if (app.writes.length !== 0 || await fileExists(app.probePath)) {
      fail('probe file was written despite the child toolFilter')
    }
    log('check-multitask-researcher: PASS child toolFilter denial (probe absent, deny not prompt-only)')

    await app.ctx.subagents.sendMessage(app.agent, SessionId(researching.childId), [{
      type: 'text',
      text: 'Return the complete structured research report covering Goal, Affected paths, Implementation plan, Risks, and Recommended claim set.'
    }], { signal: new AbortController().signal })
    await waitFor(() => app.calls.some((call) =>
      isResearcherCall(call) && userText(call.request).includes('complete structured research report')),
    'parent retrieval reached the child')
    await waitFor(() => app.agent.session.deriveMessages()
      .filter((message) => message.source.kind === 'subagent-settled').length >= 2,
    'retrieval settlement')
    const surface = [
      STRUCTURED_REPORT,
      ...app.agent.session.deriveMessages()
        .filter((message) => message.source.kind === 'subagent-settled')
        .map((message) => message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'))
    ].join('\n')
    for (const heading of REPORT_HEADINGS) {
      if (!surface.includes(heading)) fail(`retrieved report is missing ${heading}`)
    }
    const researched = taskEvents(app.agent).find((event) => event.phase === 'researched')
    if (researched?.stopReason !== 'completed') fail('completed settlement was not recorded as researched')
    if (taskEvents(app.agent).some((event) => event.phase === 'research-failed')) {
      fail('completed settlement was reported as research-failed')
    }
    log('check-multitask-researcher: PASS structured report retrieval (sendMessage + researched)')
  } finally {
    await app.dispose()
  }
}

async function assertFailedSettlement(name, options) {
  const researcherHold = gate()
  const app = await compose({
    sessionId: `fail-${name}`,
    rejectSubagentSteps: options.setup === 'reject',
    respond: async (call) => {
      if (!isResearcherCall(call)) return 'parent idle ack'
      if (options.setup === 'throw') throw new Error('scripted researcher transport failure')
      if (options.setup === 'max-tokens') return textChunks('partial report before the ceiling', { kind: 'max-tokens' })
      if (options.setup === 'interrupt') {
        await holdUntil(call.request.signal, researcherHold.promise)
        return STRUCTURED_REPORT
      }
      return STRUCTURED_REPORT
    }
  })
  try {
    await runCommand(app, `/multitask observe ${name} settlement`)
    if (!taskEvents(app.agent).some((event) => event.phase === 'researching')) {
      fail(`command appended no researching researcher spawn before ${name} settlement`)
    }
    const childId = taskEvents(app.agent).find((event) => event.phase === 'researching').childId
    if (options.setup === 'interrupt') {
      app.ctx.subagents.interrupt(SessionId(childId), { kind: 'ancestor', agent: app.agent })
      researcherHold.open()
    }
    await waitFor(() => taskEvents(app.agent).some((event) => event.phase === 'research-failed'), `${name} → research-failed`)
    const failed = taskEvents(app.agent).find((event) => event.phase === 'research-failed')
    if (failed.stopReason !== name) fail(`${name} mapped to ${failed.stopReason}`)
    if (taskEvents(app.agent).some((event) => event.phase === 'researched')) {
      fail(`${name} was reported as researched`)
    }
    if (taskEvents(app.agent).filter((event) => event.phase === 'researching').length !== 1) {
      fail(`${name} left researching permanently or restarted`)
    }
    log(`check-multitask-researcher: PASS ${name} → research-failed`)
  } finally {
    await app.dispose()
  }
}

try {
  await assertLaunchAndDenial()
  for (const row of [
    { name: 'aborted', setup: 'interrupt' },
    { name: 'error', setup: 'throw' },
    { name: 'max-tokens', setup: 'max-tokens' },
    { name: 'refusal', setup: 'reject' }
  ]) {
    await assertFailedSettlement(row.name, row)
  }
  log('check-multitask-researcher: PASS')
} catch (error) {
  if (error instanceof ScenarioFailure) {
    process.stderr.write(`check-multitask-researcher: FAIL\n${error.message}\n`)
  } else {
    process.stderr.write(`check-multitask-researcher: FAIL (unexpected error)\n${error?.stack ?? String(error)}\n`)
  }
  process.exit(1)
}
