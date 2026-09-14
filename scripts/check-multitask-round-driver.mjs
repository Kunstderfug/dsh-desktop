#!/usr/bin/env node
// Real composed-application scenario for the [multitask] round driver (issue #6).
//
// Composes the production scheduling path the desktop profile mounts: the
// permanent `dsh-multitask` plugin, real CommandRuntime, real agent loop,
// real SubagentRuntime plus in-process spawn, real JSONL persistence, and
// real session query. Only the model adapter is scripted, matching the frozen
// `multitask_round_driver_gate` seam. The script asserts full history —
// next-boundary handoff during task A, interleaved user-queue admission, and
// the configured settlement wake bound — not a queue helper or final inbox
// snapshot.
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
import { createUserMessage, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as subagentSpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as multitask from '../packages/dsh-multitask/index.js'

const DENIED_TOOLS = ['write', 'edit', 'str_replace_editor']
const RESEARCHER_LABEL = 'researcher'
const STRUCTURED_REPORT = [
  'Goal: implement the researcher brief for task B',
  'Affected paths: packages/dsh-multitask/round-driver.js',
  'Implementation plan: queue a race-fenced orchestrator handoff',
  'Risks: interrupting task A and unbounded settlement wakes',
  'Recommended claim set: packages/dsh-multitask/round-driver.js'
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

function researchEvents(agent) {
  return agent.session.snapshotEvents()
    .filter((event) => event.type === 'multitask/research')
    .map((event) => event.data)
}

function turnCount(agent) {
  return agent.session.snapshotEvents().filter((event) => event.type === 'turn/start').length
}

function admittedHandoffs(agent) {
  return agent.session.deriveMessages().filter((message) => message.source.kind === 'multitask')
}

function queuedHandoffs(agent) {
  return agent.inbox.nextTurn.filter((message) => message.source.kind === 'multitask')
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
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-round-driver-app-'))
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
    maxConsecutiveWakes: options.maxConsecutiveWakes ?? 3
  })
  push(() => mounted.dispose())

  const handle = await ctx.agents.create({
    sessionId: SessionId(options.sessionId ?? 'round-driver-app'),
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

async function runCommand(app, line) {
  const execution = await app.ctx.commands.execute(app.agent, line, [], new AbortController().signal)
  if (execution === undefined) fail(`command ${line} was not executed`)
  return execution
}

async function spawnExtraChild(app, label) {
  return app.ctx.subagents.startContinuable({
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

async function assertNextBoundaryHandoff() {
  const parentHold = gate()
  const researcherHold = gate()
  const app = await compose({
    sessionId: 'next-boundary',
    respond: async (call) => {
      if (isResearcherCall(call)) {
        await holdUntil(call.request.signal, researcherHold.promise)
        return STRUCTURED_REPORT
      }
      await holdUntil(call.request.signal, parentHold.promise)
      return userText(call.request).includes('MT-1') ? 'orchestrator received MT-1' : 'task A still running'
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

    const execution = await runCommand(app, '/multitask research and implement task B')
    if (execution.result.kind !== 'success') fail(`launch command failed: ${JSON.stringify(execution.result)}`)
    if (!researchEvents(app.agent).some((event) => event.phase === 'researching')) {
      fail('command must still launch the researcher')
    }
    if (app.agent.status !== 'running' || turnCount(app.agent) !== 1) {
      fail('handoff opened or replaced the parent turn')
    }
    if (userText(app.calls.find((call) => !isResearcherCall(call)).request) !== taskAInput) {
      fail('task A model input changed during /multitask')
    }
    const queued = queuedHandoffs(app.agent)
    if (queued.length !== 1 || queued[0].source.kind !== 'multitask' || queued[0].source.taskId !== 'MT-1') {
      fail(`expected one MT-1 handoff in next-turn, got ${JSON.stringify(queued.map((message) => message.source))}`)
    }
    if (admittedHandoffs(app.agent).length !== 0) {
      fail('handoff entered history before the next boundary')
    }

    parentHold.open()
    await waitFor(() =>
      app.calls.some((call) => !isResearcherCall(call) && userText(call.request).includes('MT-1')),
    'handoff admitted as the next parent turn')
    if (turnCount(app.agent) !== 2) fail(`expected exactly one next-boundary turn, got ${turnCount(app.agent)}`)
    if (admittedHandoffs(app.agent).length !== 1) fail('handoff was not admitted exactly once')
    if (admittedHandoffs(app.agent)[0].id !== queued[0].id) fail('a different handoff was admitted')
    researcherHold.open()
    await app.agent.whenIdle()
    if (admittedHandoffs(app.agent).filter((message) => message.id === queued[0].id).length !== 1) {
      fail('command handoff was duplicated after settlement')
    }
    log('check-multitask-round-driver: PASS next-boundary handoff (task A untouched, one MT-1 followup admitted once)')
  } finally {
    await app.dispose()
  }
}

async function assertUserQueueWins() {
  const parentHold = gate()
  const researcherHold = gate()
  const app = await compose({
    sessionId: 'user-wins',
    respond: async (call) => {
      if (isResearcherCall(call)) {
        await holdUntil(call.request.signal, researcherHold.promise)
        return STRUCTURED_REPORT
      }
      await holdUntil(call.request.signal, parentHold.promise)
      return `parent saw: ${userText(call.request)}`
    }
  })
  try {
    app.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'task A in progress' }],
      source: { kind: 'user' }
    }))
    await waitFor(() => app.calls.some((call) => !isResearcherCall(call)), 'held task A model call')
    await runCommand(app, '/multitask research and implement task B')
    const queued = queuedHandoffs(app.agent)
    if (queued.length !== 1) fail('command queued no handoff before the interleaved user message')
    const handoff = queued[0]
    const user = createUserMessage({
      content: [{ type: 'text', text: 'user queued between handoff and boundary' }],
      source: { kind: 'user' }
    })
    app.agent.followup(user)
    parentHold.open()
    await waitFor(() =>
      app.calls.some((call) => !isResearcherCall(call) && userText(call.request).includes('user queued between handoff and boundary')),
    'interleaved user input admitted')
    const admitted = app.agent.session.deriveMessages()
    if (admitted.filter((message) => message.id === user.id).length !== 1) {
      fail('interleaved user input was lost or duplicated')
    }
    if (admitted.some((message) => message.id === handoff.id)) {
      fail('stale handoff became model-visible')
    }
    researcherHold.open()
    await app.agent.whenIdle()
    if (app.agent.session.deriveMessages().filter((message) => message.id === user.id).length !== 1) {
      fail('user input was lost or duplicated after idle')
    }
    if (app.agent.session.deriveMessages().some((message) => message.id === handoff.id)) {
      fail('rejected handoff leaked into history')
    }
    log('check-multitask-round-driver: PASS user-queue wins (stale handoff rejected, user admitted once)')
  } finally {
    await app.dispose()
  }
}

async function assertSettlementBound() {
  const app = await compose({
    sessionId: 'wake-bound',
    maxConsecutiveWakes: 2
  })
  try {
    await runCommand(app, '/multitask research and implement task B')
    await waitFor(() => researchEvents(app.agent).some((event) => event.phase === 'researched'), 'first researcher settled')
    await waitFor(() => admittedHandoffs(app.agent).length >= 1, 'command handoff admitted')
    await app.agent.whenIdle()
    await spawnExtraChild(app, 'settle-2')
    await spawnExtraChild(app, 'settle-3')
    await app.agent.whenIdle()
    const afterSettlements = admittedHandoffs(app.agent).length
    if (afterSettlements > 2) fail(`settlement wakes exceeded the bound: ${afterSettlements}`)
    if (afterSettlements !== 2) fail(`expected 2 automatic rounds, got ${afterSettlements}`)

    await spawnExtraChild(app, 'settle-over-bound')
    await app.agent.whenIdle()
    if (admittedHandoffs(app.agent).length !== afterSettlements) {
      fail('a further settlement produced a wake above the bound')
    }

    app.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'user resets the consecutive wake counter' }],
      source: { kind: 'user' }
    }))
    await app.agent.whenIdle()
    await spawnExtraChild(app, 'settle-after-reset')
    await waitFor(() => admittedHandoffs(app.agent).length > afterSettlements, 'user input resets the wake counter')
    await app.agent.whenIdle()
    if (admittedHandoffs(app.agent).length !== afterSettlements + 1) {
      fail(`reset wake count was ${admittedHandoffs(app.agent).length}, expected ${afterSettlements + 1}`)
    }
    log('check-multitask-round-driver: PASS settlement wake bound (max 2, reset by user input)')
  } finally {
    await app.dispose()
  }
}

try {
  await assertNextBoundaryHandoff()
  await assertUserQueueWins()
  await assertSettlementBound()
  log('check-multitask-round-driver: PASS')
} catch (error) {
  if (error instanceof ScenarioFailure) {
    process.stderr.write(`check-multitask-round-driver: FAIL\n${error.message}\n`)
  } else {
    process.stderr.write(`check-multitask-round-driver: FAIL (unexpected error)\n${error?.stack ?? String(error)}\n`)
  }
  process.exit(1)
}
