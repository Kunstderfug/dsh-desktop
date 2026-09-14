#!/usr/bin/env node
// Real composed-application two-writer workflow for [multitask] claim
// enforcement (issue #9).
//
// Composes the production path the desktop profile mounts: the permanent
// `dsh-multitask` host plugin, command runtime, agents/subagents, the tool
// pre-execute waterfall, native write/edit tools and fs observation policy,
// session event log/projections, round-driver handoff, and task-card text.
// Only the model adapter is scripted, matching the frozen
// `multitask_claim_enforcement_gate` seam. The script asserts full history —
// one actionable denial, recovery, live claim table, host release after holder
// success before retry, no double-deny, and the Bash tier-2 footnote folded
// from live session events — not a helper call or a final-state snapshot.
//
// Exit 0 only when every observation succeeded.

import { readFileSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import BashLocal from '@deepseek-ai/dsh-bash-local'
import Commands from '@deepseek-ai/dsh-commands'
import { FsError } from '@deepseek-ai/dsh-fs'
import * as observationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import { LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import * as shellEnv from '@deepseek-ai/dsh-shell-env'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as subagentSpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as toolBash from '@deepseek-ai/dsh-tool-bash'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import * as strReplaceEditor from '@deepseek-ai/dsh-tool-str-replace-editor'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as multitask from '../packages/dsh-multitask/index.js'

const REMEDY = 'ask the orchestrator or claim a different path'
const STRUCTURED_REPORT = [
  'Goal: claim enforcement composed scenario',
  'Affected paths: src/held.ts',
  'Implementation plan: collide, recover, complete, retry',
  'Risks: leaked claims and double-deny',
  'Recommended claim set: src/held.ts'
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

function isWriterACall(call) {
  return userText(call.request).includes('writer A stays live to claim files')
}

function isWriterBCall(call) {
  return userText(call.request).includes('writer B stays live to claim files')
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

async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
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

function claimEvents(agent) {
  return agent.session.snapshotEvents()
    .filter((event) => event.type === 'multitask/claims')
    .map((event) => event.data)
}

function liveClaimTable(agent) {
  const table = new Map()
  for (const event of claimEvents(agent)) {
    if (event.state === 'released') table.delete(event.path)
    else table.set(event.path, event)
  }
  return [...table.values()]
}

function denialEvents(agent) {
  return agent.session.snapshotEvents()
    .filter((event) => event.type === 'multitask/denial' || event.type === 'multitask/phase')
    .map((event) => event.data)
    .filter((data) => String(data.note ?? data.reason ?? '').includes(REMEDY))
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

function loadMultitaskClient() {
  const source = readFileSync(new URL('../packages/dsh-multitask-client/client.js', import.meta.url), 'utf8')
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
        useEffect: () => {}
      }
    }
    throw new Error(`unexpected client require ${id}`)
  })
}

function foldTaskCardFromLiveSession(agent, taskId) {
  const plugin = loadMultitaskClient()
  const folded = plugin.foldTasks(agent.session.snapshotEvents())
  const task = folded.find((row) => row.id === taskId)
  if (task === undefined) fail(`live session fold is missing task ${taskId}`)
  return plugin.formatTaskCardText(task)
}

async function compose(options = {}) {
  const home = options.home ?? await mkdtemp(path.join(os.tmpdir(), 'dsh-multitask-claim-enforcement-app-'))
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
  const sandbox = await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: home })
  push(() => sandbox.dispose())
  const fs = await ctx.plugin(SandboxedFileSystem, { cwd: home })
  push(() => fs.dispose())
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
    apply(pluginCtx) {
      pluginCtx.llm.registerAdapter(['scripted'], new ScriptedAdapter(async (call) => {
        return options.respond?.(call) ?? (isResearcherCall(call) ? STRUCTURED_REPORT : 'parent ack')
      }))
    }
  })
  push(() => adapter.dispose())
  const loop = await ctx.plugin(AgentLoop)
  push(() => loop.dispose())
  const subprocess = await ctx.plugin(LocalSubprocessRuntime)
  push(() => subprocess.dispose())
  const bash = await ctx.plugin(BashLocal)
  push(() => bash.dispose())
  const env = await ctx.plugin(shellEnv)
  push(() => env.dispose())
  const nativeFs = await ctx.plugin(toolFs)
  push(() => nativeFs.dispose())
  const editor = await ctx.plugin(strReplaceEditor)
  push(() => editor.dispose())
  const bashTool = await ctx.plugin(toolBash)
  push(() => bashTool.dispose())
  const mounted = await ctx.plugin(multitask, { enabled: true })
  push(() => mounted.dispose())
  const observed = await ctx.plugin(observationPolicy)
  push(() => observed.dispose())
  const subagents = await ctx.plugin(SubagentRuntime)
  push(() => subagents.dispose())
  const spawn = await ctx.plugin(subagentSpawnInProcess)
  push(() => spawn.dispose())
  const query = await ctx.plugin(SessionQueryEngine)
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
    sessionId: SessionId(options.sessionId ?? 'session-1'),
    meta: { cwd: home },
    agentOptions: { provider: 'scripted', model: 'orchestrator' }
  })
  push(() => handle.dispose())

  return {
    ctx,
    home,
    counters,
    agent: handle.agent,
    dispose: async () => {
      for (const dispose of [...disposers].reverse()) await dispose()
      if (options.keepHome !== true) await rm(home, { recursive: true, force: true })
    }
  }
}

async function launchTwoHeldChildren(app, hold) {
  await runCommand(app.ctx, app.agent, '/multitask implement shared file A')
  const busy = await runTool(app.ctx, app.agent, 'write', {
    file_path: path.join(app.home, 'parent-busy.ts'),
    content: 'parent already touching this'
  })
  if (busy.isError) fail(`busy-parent write failed: ${busy.error?.message}`)
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
    childIds,
    hold
  }
}

async function runScenario() {
  const holdA = gate()
  const holdB = gate()
  const ends = new Map()
  const app = await compose({
    respond: async (call) => {
      if (isWriterACall(call)) {
        await holdUntil(call.request.signal, holdA.promise)
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
  app.ctx.on('subagent/end', (info) => {
    ends.set(String(info.id), String(info.stopReason ?? ''))
  })
  try {
    const { childA, childB, childIds } = await launchTwoHeldChildren(app, holdA)
    const preclaimed = liveClaimTable(app.agent)
    if (!preclaimed.some((claim) => String(claim.path).includes('parent-busy.ts') && claim.taskId === 'MT-1')) {
      fail('busy-parent touched path was not pre-claimed when /multitask minted MT-2')
    }
    const brief = handoffText(app.agent)
    if (!/Live claims/i.test(brief) || !brief.includes('parent-busy.ts') || !brief.includes('MT-1')) {
      fail('orchestrator handoff is missing the accurate live claim table')
    }
    if (/released/i.test(brief)) fail('handoff listed a released or stale claim row')

    const claimed = await runTool(app.ctx, childA, 'claim_files', { paths: ['src/held.ts'], taskId: 'MT-1' })
    if (claimed.isError) fail(`holder claim failed: ${claimed.error?.message}`)
    const ownerWrite = await runTool(app.ctx, childA, 'write', {
      file_path: path.join(app.home, 'src/held.ts'),
      content: 'owned by MT-1'
    })
    if (ownerWrite.isError) fail(`owning-task write was denied: ${ownerWrite.error?.message}`)

    const intentsBefore = app.counters.writeIntents
    const foreign = await runTool(app.ctx, childB, 'write', {
      file_path: path.join(app.home, 'src/held.ts'),
      content: 'writer B collision'
    })
    if (!foreign.isError) fail('writer B native write on a foreign-claimed path was not denied')
    const reason = String(foreign.error?.message ?? '')
    if (!reason.includes('src/held.ts') || !reason.includes('MT-1') || !reason.includes(REMEDY)) {
      fail(`denial was not actionable: ${reason}`)
    }
    if (foreign.error instanceof FsError === false && foreign.error?.info?.name === 'FsError') {
      /* typed fs fallback is acceptable when pre-execute is skipped */
    }
    if (await readFile(path.join(app.home, 'src/held.ts'), 'utf8') !== 'owned by MT-1') {
      fail('denied write mutated the holder file')
    }
    if (denialEvents(app.agent).length !== 1) {
      fail(`expected one denial event, got ${denialEvents(app.agent).length}`)
    }
    if (app.counters.writeIntents !== intentsBefore) {
      fail('foreign write also dispatched fs/write-intent — double-deny')
    }

    const recovered = await runTool(app.ctx, childB, 'write', {
      file_path: path.join(app.home, 'src/recovered.ts'),
      content: 'writer B recovered'
    })
    if (recovered.isError) fail(`recovery write failed: ${recovered.error?.message}`)
    if (!await fileExists(path.join(app.home, 'src/recovered.ts'))) fail('recovery write did not land')
    if (denialEvents(app.agent).length !== 1) fail('recovery produced a second denial')

    const edit = await runTool(app.ctx, childB, 'edit', {
      file_path: path.join(app.home, 'src/held.ts'),
      old_string: 'owned by MT-1',
      new_string: 'writer B edit'
    })
    if (!edit.isError) fail('writer B native edit on a foreign-claimed path was not denied')
    if (denialEvents(app.agent).length !== 2) fail(`edit must add exactly one more denial, got ${denialEvents(app.agent).length}`)

    const card = foldTaskCardFromLiveSession(app.agent, 'MT-2')
    if (!card.includes('Boundary intervention') || !card.includes('MT-1') || !card.includes('src/held.ts')) {
      fail('task card is missing the boundary-intervention note from the live denial')
    }
    if (!/Bash writes are not covered by tier 2/i.test(card) || !/native write\/edit/i.test(card)) {
      fail('task card is missing the Bash tier-2 footnote')
    }
    if (/Bash writes are (guarded|enforced)|heuristic/i.test(card)) {
      fail('task card claims Bash is enforced or uses a heuristic')
    }

    holdA.open()
    await waitFor(() => ends.get(childIds[0]) === 'completed', 'holder settled as completed')
    await waitFor(
      () => !liveClaimTable(app.agent).some((claim) => claim.path === 'src/held.ts'),
      'holder claims released after success'
    )
    if (!claimEvents(app.agent).some((event) => event.path === 'src/held.ts' && event.state === 'released')) {
      fail('host did not append a released claim after holder success')
    }
    if (!liveClaimTable(app.agent).some((claim) => String(claim.path).includes('parent-busy.ts') && claim.taskId === 'MT-1')) {
      fail('unrelated live claim was released with the holder')
    }
    const reread = await runTool(app.ctx, childB, 'read', {
      file_path: path.join(app.home, 'src/held.ts')
    })
    if (reread.isError) fail(`retry read after host release failed: ${reread.error?.message}`)
    const retry = await runTool(app.ctx, childB, 'write', {
      file_path: path.join(app.home, 'src/held.ts'),
      content: 'retry after completed'
    })
    if (retry.isError) fail(`retry after host success release failed: ${retry.error?.message}`)
    if (await readFile(path.join(app.home, 'src/held.ts'), 'utf8') !== 'retry after completed') {
      fail('retry after holder success did not land')
    }
    if (!liveClaimTable(app.agent).some((claim) => String(claim.path).includes('parent-busy.ts') && claim.taskId === 'MT-1')) {
      fail('unrelated live claim disappeared after the retry')
    }

    const other = await compose({ sessionId: 'session-other' })
    try {
      await runCommand(other.ctx, other.agent, '/multitask unrelated session')
      const leak = await runTool(other.ctx, other.agent, 'write', {
        file_path: path.join(other.home, 'src/held.ts'),
        content: 'other session'
      })
      if (leak.isError) fail('claims leaked across sessions')
    } finally {
      await other.dispose()
    }

    holdB.open()
    await app.agent.whenIdle()
    log('check-multitask-claim-enforcement: PASS collision, recovery, table, success release, bash scope')
  } finally {
    holdA.open()
    holdB.open()
    await app.dispose().catch(() => {})
  }
}

try {
  await runScenario()
  log('check-multitask-claim-enforcement: PASS')
} catch (error) {
  if (error instanceof ScenarioFailure) {
    process.stderr.write(`check-multitask-claim-enforcement: FAIL\n${error.message}\n`)
  } else {
    process.stderr.write(`check-multitask-claim-enforcement: FAIL (unexpected error)\n${error?.stack ?? String(error)}\n`)
  }
  process.exit(1)
}
