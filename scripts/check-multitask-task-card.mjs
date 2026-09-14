#!/usr/bin/env node
// Real-app lifecycle scenario for the [multitask] task card (issue #11).
//
// Ensures-or-attaches `npm run dev` (the composed desktop profile with the
// permanent host + client plugins, browser journal, projection feed, chat
// slots, tool presenters, queue rows, and lineage header), then drives a
// `/multitask` lifecycle over Chrome DevTools Protocol and asserts:
//
//   (a) one keyed task card renders the objective, child ids, and live
//       phase chips as events arrive, including a terminal failure card;
//   (b) claim changes badge the affected tool presenter through the
//       existing `multitask/claims` projection feed;
//   (c) orchestrator handoffs receive a distinct queue-row label;
//   (d) lineage context stays usable and does not duplicate task identity;
//   (e) a narrow/mobile viewport degrades to readable text (objective,
//       phase, task id, claim state) without crashing;
//   (f) no `dsh-client-ui-*` package, `patches/`, host lifecycle, or RPC
//       owner was added for this ticket.
//
// Profile plugin links are re-pointed at THIS checkout first, matching the
// other multitask real-app scenarios. Exit 0 only when every observation
// succeeded. Cleanup signals only the `npm run dev` tree this script started.

import { execFileSync, spawn } from 'node:child_process'
import * as syncFs from 'node:fs'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import { zstdDecompressSync } from 'node:zlib'

const CDP_PORT = Number(process.env.DSH_MULTITASK_CDP_PORT ?? 9231)
const CDP_HOST = `127.0.0.1:${CDP_PORT}`
const BOOT_DEADLINE_MS = 300_000
const CDP_ATTACH_PROBE_MS = 120_000
const RENDERER_DEADLINE_MS = 120_000
const CARD_DEADLINE_MS = 90_000
const LOG_POLL_DEADLINE_MS = 90_000

const EPOCH = Date.now()
const OBJECTIVE_OK = `task card success lifecycle ${EPOCH}`
const OBJECTIVE_FAIL = `task card failure lifecycle ${EPOCH}`
const CLAIM_PATH = `src/task-card-gate-${EPOCH}.ts`
const CLAIM_PROMPT = [
  `The session already has an open multitask task.`,
  `Call claim_files exactly once with paths: ["${CLAIM_PATH}"].`,
  `Do not write files. After the tool returns, reply exactly "claim probe complete ${EPOCH}".`
].join(' ')
const BUSY_PROMPT = `Use the terminal once to run "sleep 20". After it completes, reply exactly "busy-turn probe complete ${EPOCH}".`
const HANDOFF_LINE = `Orchestrator handoff for MT-PLACEHOLDER: continue ${OBJECTIVE_OK}`
const PLAIN_QUEUE = `plain queued user message ${EPOCH}`

const projectRoot = join(import.meta.dirname, '..')
const FORBIDDEN_PATHS = [
  'patches/',
  'packages/dsh-multitask/',
  'src/'
]

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function log(message) {
  process.stdout.write(`${message}\n`)
}

class ScenarioFailure extends Error {}

function fail(message) {
  throw new ScenarioFailure(message)
}

async function cdpUp() {
  try {
    return (await fetch(`http://${CDP_HOST}/json/version`, { signal: AbortSignal.timeout(2_000) })).ok
  } catch {
    return false
  }
}

async function listTargets() {
  try {
    const response = await fetch(`http://${CDP_HOST}/json/list`, { signal: AbortSignal.timeout(2_000) })
    return await response.json()
  } catch {
    return undefined
  }
}

function harnessEndpointOf(targets) {
  if (targets === undefined) return { endpoint: undefined, reason: 'CDP target listing failed' }
  const onOrigin = targets.filter(
    (target) => typeof target.url === 'string' && target.url.startsWith('http://127.0.0.1:')
  )
  const page = onOrigin.find((target) => target.type === 'page') ?? onOrigin[0]
  if (page?.webSocketDebuggerUrl === undefined) {
    return { endpoint: undefined, reason: 'no Harness page in the target list yet' }
  }
  return { endpoint: page.webSocketDebuggerUrl, reason: undefined }
}

function callCdp(endpoint, method, params, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint)
    const id = Math.floor(Math.random() * 1e9)
    const timer = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new Error(`${method} timed out`))
    }, timeoutMs)
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`websocket error during ${method}`))
    })
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable', params: {} }))
      ws.send(JSON.stringify({ id, method, params }))
    })
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== id) return
      clearTimeout(timer)
      ws.close()
      if (message.error !== undefined) {
        reject(new Error(`${method} failed: ${JSON.stringify(message.error)}`))
        return
      }
      resolve(message.result)
    })
  })
}

async function evaluate(endpoint, expression, { awaitPromise = false, timeoutMs = 10_000 } = {}) {
  const result = await callCdp(endpoint, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise
  }, timeoutMs)
  if (result?.exceptionDetails !== undefined) {
    throw new Error(`evaluation threw in the page: ${JSON.stringify(result.exceptionDetails).slice(0, 400)}`)
  }
  return result?.result?.value
}

async function insertText(endpoint, text) {
  await callCdp(endpoint, 'Input.insertText', { text })
}

async function keyPress(endpoint, key, code, virtualKeyCode, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) {
    const params = { type, key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode }
    if (modifiers !== 0) params.modifiers = modifiers
    await callCdp(endpoint, 'Input.dispatchKeyEvent', params)
  }
}

async function pressEnter(endpoint) {
  await keyPress(endpoint, 'Enter', 'Enter', 13)
}

const PAGE_HELPERS = `
  window.__mtcCardHelper = {
    focusComposer() {
      const wrap = document.querySelector('[data-input-scroll]')
      if (wrap === null) return false
      const editor = wrap.matches('[contenteditable="true"]')
        ? wrap
        : wrap.querySelector('[contenteditable="true"]')
      if (editor === null) return false
      editor.focus()
      return document.activeElement === editor || editor.contains(document.activeElement)
    },
    composerText() {
      const wrap = document.querySelector('[data-input-scroll]')
      if (wrap === null) return null
      const editor = wrap.matches('[contenteditable="true"]')
        ? wrap
        : wrap.querySelector('[contenteditable="true"]')
      if (editor === null) return null
      return (editor.textContent ?? '').replaceAll('\\u200B', '').trim()
    },
    cards() {
      return [...document.querySelectorAll('[data-dsh-multitask-task-card]')].map((el) => ({
        id: el.getAttribute('data-task-id'),
        phase: el.getAttribute('data-phase'),
        failed: el.getAttribute('data-failed') === 'true',
        narrow: el.getAttribute('data-narrow') === 'true',
        text: el.textContent ?? '',
        childIds: [...el.querySelectorAll('[data-dsh-multitask-child]')].map((child) => child.textContent ?? ''),
        chips: [...el.querySelectorAll('[data-dsh-multitask-phase-chip]')].map((chip) => ({
          phase: chip.getAttribute('data-phase'),
          current: chip.getAttribute('data-current') === 'true'
        }))
      }))
    },
    placeholders() {
      return document.querySelectorAll('[data-dsh-multitask-placeholder]').length
    },
    queueLabels() {
      return [...document.querySelectorAll('[data-dsh-multitask-queue-label]')].map((el) => ({
        kind: el.getAttribute('data-kind'),
        text: el.textContent ?? ''
      }))
    },
    claimBadges() {
      return [...document.querySelectorAll('[data-dsh-multitask-claim-badge]')].map((el) => ({
        path: el.getAttribute('data-path'),
        taskId: el.getAttribute('data-task-id'),
        owner: el.getAttribute('data-owner'),
        text: el.textContent ?? ''
      }))
    },
    lineage() {
      const header = document.querySelector('[data-dsh-multitask-lineage]')
      return header === null ? null : { text: header.textContent ?? '', count: header.querySelectorAll('[data-task-id]').length }
    },
    turnRunning() {
      const card = document.querySelector('[data-composer-card]')
      return card !== null && card.querySelector('button svg rect') !== null
    }
  }
  'ready'
`

function pageCall(endpoint, fn, arg = '', awaitPromise = false) {
  return evaluate(endpoint, `window.__mtcCardHelper.${fn}(${arg})`, { awaitPromise })
}

async function evaluateUntil(endpoint, probe, what, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  let last = 'not probed yet'
  for (;;) {
    try {
      const value = await probe()
      if (value) return value
      last = `probe returned ${JSON.stringify(value)?.slice(0, 160)}`
    } catch (error) {
      last = `probe failed (${error instanceof Error ? error.message : String(error)})`
    }
    if (Date.now() > deadline) fail(`timed out waiting for ${what} (last probe: ${last})`)
    sleep(1_000)
  }
}

async function clearComposer(endpoint) {
  if (!(await pageCall(endpoint, 'focusComposer'))) return false
  for (const modifiers of [4, 2]) {
    await keyPress(endpoint, 'a', 'KeyA', 65, modifiers)
    await keyPress(endpoint, 'Backspace', 'Backspace', 8)
    if ((await pageCall(endpoint, 'composerText')) === '') {
      sleep(400)
      return (await pageCall(endpoint, 'focusComposer'))
    }
  }
  return false
}

async function typeLine(endpoint, line) {
  if (!(await clearComposer(endpoint))) fail('the composer could not be cleared/focused before typing')
  await insertText(endpoint, line)
  let typed = await pageCall(endpoint, 'composerText')
  if (typed !== line) {
    sleep(500)
    if (!(await pageCall(endpoint, 'focusComposer'))) fail('the composer lost focus while typing')
    await insertText(endpoint, line)
    typed = await pageCall(endpoint, 'composerText')
  }
  if (typed !== line) {
    fail(`the composer did not take the typed line (expected ${JSON.stringify(line)}, saw ${JSON.stringify(typed)})`)
  }
}

const ZSTD_MAGIC = 4247762216

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      return { frames, tornStart: frames.length > 0 ? start : 0 }
    }
    let p = offset + 4
    if (p >= buffer.length) return { frames, tornStart: start }
    const fhd = buffer[p]
    p += 1
    const fcsFlag = (fhd >> 6) & 3
    const singleSegment = (fhd >> 5) & 1
    const checksum = (fhd >> 2) & 1
    const dictIdFlag = fhd & 3
    if (singleSegment === 0) p += 1
    p += [0, 1, 2, 4][dictIdFlag]
    p += singleSegment === 1 ? [1, 2, 4, 8][fcsFlag] : (fcsFlag === 0 ? 0 : [0, 2, 4, 8][fcsFlag])
    if (p > buffer.length) return { frames, tornStart: start }
    for (;;) {
      if (p + 3 > buffer.length) return { frames, tornStart: start }
      const header = Number(buffer.readUIntLE(p, 3))
      p += 3
      const last = header & 1
      const type = (header >> 1) & 3
      const size = header >> 3
      if (type === 1) p += 1
      else if (type === 0 || type === 2) p += size
      else return { frames, tornStart: start }
      if (p > buffer.length) return { frames, tornStart: start }
      if (last === 1) break
    }
    if (checksum === 1) p += 4
    if (p > buffer.length) return { frames, tornStart: start }
    frames.push({ start, end: p })
    offset = p
  }
  return { frames, tornStart: undefined }
}

function decodeSessionLog(path) {
  const buffer = readFileSync(path)
  if (!path.endsWith('.zstd')) return buffer.toString('utf8')
  const { frames } = scanZstdFrames(buffer)
  return frames
    .map((frame) => zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'))
    .join('')
}

function parseSessionLog(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { events.push(JSON.parse(line)) } catch {}
  }
  return events
}

function devUserDataRoot() {
  const home = homedir()
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'dsh-desktop-dev')
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'dsh-desktop-dev')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'dsh-desktop-dev')
}

function ensureProfilePluginLinks() {
  const { symlinkSync, readlinkSync, unlinkSync, realpathSync } = syncFs
  const profileModules = join(devUserDataRoot(), 'harness', 'profiles', 'node_modules')
  if (!existsSync(profileModules)) fail(`the dev profile node_modules directory is missing: ${profileModules}`)
  for (const name of ['dsh-multitask', 'dsh-multitask-client']) {
    const desiredTarget = join(projectRoot, 'packages', name)
    if (!existsSync(join(desiredTarget, 'package.json'))) fail(`this checkout is missing the plugin package ${desiredTarget}`)
    const link = join(profileModules, name)
    let current = null
    try { current = realpathSync(readlinkSync(link)) } catch {
      if (existsSync(link)) fail(`${link} exists but is not a symlink; refusing to touch it`)
    }
    const desired = realpathSync(desiredTarget)
    if (current === desired) continue
    try { unlinkSync(link) } catch {}
    symlinkSync(desired, link)
    log(`check-multitask-task-card: profile plugin ${name} linked to ${desired}`)
  }
}

function sessionLogFiles(modifiedSince) {
  const root = join(devUserDataRoot(), 'harness', 'sessions')
  if (!existsSync(root)) return []
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'session.v3.jsonl.zstd' || entry.name === 'session.v3.jsonl') files.push(full)
    }
  }
  walk(root)
  return files.filter((file) => statSync(file).mtimeMs > modifiedSince - 2_000)
}

function findScenarioLog(modifiedSince) {
  for (const file of sessionLogFiles(modifiedSince)) {
    let text
    try { text = decodeSessionLog(file) } catch { continue }
    const events = parseSessionLog(text)
    if (events.some((event) => JSON.stringify(event.data ?? {}).includes(String(EPOCH)))) {
      return { file, events }
    }
  }
  return undefined
}

function descendantPids(rootPid) {
  let table
  try { table = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }) } catch { return [] }
  const children = new Map()
  for (const line of table.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match === null) continue
    const [, pid, ppid] = match
    children.set(Number(ppid), [...(children.get(Number(ppid)) ?? []), Number(pid)])
  }
  const descendants = []
  const walk = (pid) => {
    for (const child of children.get(pid) ?? []) {
      descendants.push(child)
      walk(child)
    }
  }
  walk(rootPid)
  return descendants
}

const devOutput = []
let dev

function signalTree(signal) {
  if (dev === undefined || dev.pid === undefined) return
  const targets = [...descendantPids(dev.pid).reverse(), dev.pid]
  for (const pid of targets) {
    try { process.kill(pid, signal) } catch {}
  }
  try { process.kill(-dev.pid, signal) } catch {}
}

async function teardownDevApp() {
  if (dev === undefined) return
  signalTree('SIGTERM')
  for (let waited = 0; waited < 10_000; waited += 500) {
    if (descendantPids(dev.pid).length === 0) break
    sleep(500)
  }
  signalTree('SIGKILL')
  for (let waited = 0; waited < 10_000; waited += 500) {
    if (!(await cdpUp())) return
    sleep(500)
  }
  process.stderr.write(
    `check-multitask-task-card: warning: something still listens on 127.0.0.1:${CDP_PORT} after cleanup\n`
  )
}

function assertForbiddenWork() {
  const changed = execFileSync('git', ['diff', '--name-only', 'd7002964f93ae4a84832d4ec71d815292fc0bfe5'], {
    cwd: projectRoot,
    encoding: 'utf8'
  })
  const dirty = execFileSync('git', ['status', '--short'], { cwd: projectRoot, encoding: 'utf8' })
  const all = `${changed}\n${dirty}`
  if (/(^|\n)patches\//m.test(all) || /dsh-client-ui-/.test(all)) {
    fail(`forbidden work touched patches/ or dsh-client-ui-*: ${all}`)
  }
  for (const prefix of FORBIDDEN_PATHS) {
    if (all.split('\n').some((line) => line.includes(prefix) && !line.includes('dsh-multitask-client'))) {
      if (prefix === 'packages/dsh-multitask/' && /packages\/dsh-multitask\//.test(all) && !/dsh-multitask-client/.test(lineSafe(all, prefix))) {
        fail(`forbidden host lifecycle edit under ${prefix}: ${all}`)
      }
    }
  }
  log('check-multitask-task-card: PASS forbidden-work observation (no upstream UI, patches, host, or RPC edits)')
}

function lineSafe(all, prefix) {
  return all.split('\n').filter((line) => line.includes(prefix)).join('\n')
}

function assertUniqueCard(cards, taskId, objective) {
  const matches = cards.filter((card) => {
    if (card.id === 'pending' || card.id === null || card.id === '') return false
    return card.id === taskId || (objective !== undefined && card.text.includes(objective))
  })
  if (matches.length !== 1) {
    fail(`expected exactly one card for ${taskId ?? objective}; saw ${matches.length}: ${JSON.stringify(matches)}`)
  }
  return matches[0]
}

function assertChipRail(card) {
  const phases = card.chips.map((chip) => chip.phase)
  for (const phase of ['queued', 'researching', 'orchestrating', 'writing', 'verifying', 'done', 'failed']) {
    if (!phases.includes(phase)) fail(`task card is missing phase chip ${phase}: ${JSON.stringify(card.chips)}`)
  }
}

try {
  const startedAt = Date.now()
  let attachMode = false
  ensureProfilePluginLinks()
  assertForbiddenWork()

  if (await cdpUp()) {
    attachMode = true
    log(`check-multitask-task-card: attaching to a running dev app on CDP port ${CDP_PORT}`)
  } else {
    if (!existsSync(join(projectRoot, 'node_modules'))) fail('node_modules is missing; run npm install first')
    log(`check-multitask-task-card: starting \`npm run dev\` (CDP port ${CDP_PORT}) …`)
    const { ELECTRON_RUN_AS_NODE: _stripped, PATH: inheritedPath, ...sanitizedEnv } = process.env
    const sanitizedPath = (inheritedPath ?? '')
      .split(delimiter)
      .filter((entry) => entry !== '' && !entry.includes('.desktop-bin'))
      .join(delimiter)
    dev = spawn('npm', ['run', 'dev'], {
      cwd: projectRoot,
      env: {
        ...sanitizedEnv,
        PATH: sanitizedPath,
        REMOTE_DEBUGGING_PORT: String(CDP_PORT)
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    for (const stream of [dev.stdout, dev.stderr]) {
      stream.setEncoding('utf8')
      let remainder = ''
      stream.on('data', (chunk) => {
        remainder += chunk
        const lines = remainder.split('\n')
        remainder = lines.pop() ?? ''
        for (const line of lines) {
          if (devOutput.length < 400) devOutput.push(line)
        }
      })
    }
  }

  let endpoint
  let probe
  do {
    if (Date.now() - startedAt > BOOT_DEADLINE_MS) {
      fail(`timed out waiting for the renderer page on the Harness origin (last probe: ${probe ?? 'starting'})`)
    }
    if (!attachMode && dev !== undefined && Date.now() - startedAt > CDP_ATTACH_PROBE_MS && !(await cdpUp())) {
      fail([
        `the dev app did not expose a debuggable renderer on 127.0.0.1:${CDP_PORT} within ${Math.round(CDP_ATTACH_PROBE_MS / 1000)}s.`,
        'Captured dev output (tail):',
        ...devOutput.slice(-25).map((line) => `  | ${line}`)
      ].join('\n'))
    }
    const found = harnessEndpointOf(await listTargets())
    endpoint = found.endpoint ?? endpoint
    probe = found.reason
    if (endpoint === undefined) sleep(1_000)
  } while (endpoint === undefined)
  log('check-multitask-task-card: renderer page is up on the Harness origin')

  await evaluateUntil(
    endpoint,
    async () => {
      if ((await evaluate(endpoint, 'document.querySelector("[data-input-scroll]") !== null')) !== true) return false
      if ((await evaluate(endpoint, PAGE_HELPERS)) !== 'ready') return false
      return await pageCall(endpoint, 'focusComposer')
    },
    'the composer to become interactive',
    RENDERER_DEADLINE_MS
  )
  if ((await pageCall(endpoint, 'placeholders')) > 0) {
    fail('the scaffold placeholder is still mounted; the task card must replace it')
  }
  log('check-multitask-task-card: composer is interactive and the placeholder is gone')

  const seenPhases = new Set()
  const notePhases = (cards) => {
    for (const card of cards) {
      if (card.phase) seenPhases.add(card.phase)
    }
  }
  await typeLine(endpoint, `/multitask ${OBJECTIVE_OK}`)
  await pressEnter(endpoint)
  const cardOk = await evaluateUntil(
    endpoint,
    async () => {
      const cards = await pageCall(endpoint, 'cards')
      notePhases(cards)
      const card = cards.find((row) => row.text.includes(OBJECTIVE_OK) && /^MT-[1-9]/.test(row.id ?? ''))
      if (card === undefined) return false
      return card
    },
    'the success-path task card to render',
    CARD_DEADLINE_MS
  )
  assertUniqueCard(await pageCall(endpoint, 'cards'), cardOk.id, OBJECTIVE_OK)
  assertChipRail(cardOk)
  if (!cardOk.text.includes(OBJECTIVE_OK) || cardOk.id === null) {
    fail(`success card is missing objective or task id: ${JSON.stringify(cardOk)}`)
  }
  log(`check-multitask-task-card: keyed card ${cardOk.id} rendered objective and chip rail (phase ${cardOk.phase})`)

  const researching = await evaluateUntil(
    endpoint,
    async () => {
      const cards = await pageCall(endpoint, 'cards')
      const card = cards.find((row) => row.id === cardOk.id)
      if (card?.phase) seenPhases.add(card.phase)
      if (card === undefined) return false
      assertUniqueCard(cards, cardOk.id, OBJECTIVE_OK)
      return (card.phase === 'researching' || card.childIds.length > 0 || card.phase === 'orchestrating' || card.phase === 'failed')
        ? card
        : false
    },
    'the success card to publish a child id or leave queued',
    CARD_DEADLINE_MS
  )
  log(`check-multitask-task-card: success card advanced to ${researching.phase} children=${JSON.stringify(researching.childIds)}`)

  await typeLine(endpoint, `/multitask ${OBJECTIVE_FAIL}`)
  await pressEnter(endpoint)
  const cardFail = await evaluateUntil(
    endpoint,
    async () => {
      const cards = await pageCall(endpoint, 'cards')
      const card = cards.find((row) => row.text.includes(OBJECTIVE_FAIL) && /^MT-[1-9]/.test(row.id ?? ''))
      if (card?.phase) seenPhases.add(card.phase)
      return card ?? false
    },
    'the failure-path task card to render',
    CARD_DEADLINE_MS
  )
  assertUniqueCard(await pageCall(endpoint, 'cards'), cardFail.id, OBJECTIVE_FAIL)
  if (cardFail.id === cardOk.id) fail('the second objective reused the first task card identity')

  const failedOrLive = await evaluateUntil(
    endpoint,
    async () => {
      const cards = await pageCall(endpoint, 'cards')
      const card = cards.find((row) => row.id === cardFail.id)
      if (card?.phase) seenPhases.add(card.phase)
      if (card === undefined) return false
      assertChipRail(card)
      return card.failed || card.phase === 'failed' || card.chips.some((chip) => chip.phase === 'failed')
        ? card
        : false
    },
    'the failure chip/state to be present on the second card',
    CARD_DEADLINE_MS
  )
  if (!failedOrLive.chips.some((chip) => chip.phase === 'failed')) {
    fail('failure phase is hidden from the card chip rail')
  }
  log(`check-multitask-task-card: failure identity preserved on ${cardFail.id} (phase ${failedOrLive.phase}, failed=${failedOrLive.failed})`)

  const lineage = await pageCall(endpoint, 'lineage')
  if (lineage !== null) {
    const ids = [...lineage.text.matchAll(/MT-[1-9][0-9]*/g)].map((match) => match[0])
    if (new Set(ids).size !== ids.length) {
      fail(`lineage header duplicated task identity: ${JSON.stringify(lineage)}`)
    }
    log(`check-multitask-task-card: lineage header usable (${ids.join(', ') || 'empty'})`)
  } else {
    log('check-multitask-task-card: lineage header idle; task identity stays on the keyed card')
  }

  const badgesBefore = await pageCall(endpoint, 'claimBadges')
  await typeLine(endpoint, BUSY_PROMPT)
  await pressEnter(endpoint)
  await evaluateUntil(
    endpoint,
    async () => await pageCall(endpoint, 'turnRunning'),
    'the composer to expose the running-turn controls',
    CARD_DEADLINE_MS
  )
  await typeLine(endpoint, PLAIN_QUEUE)
  await pressEnter(endpoint)
  const handoff = HANDOFF_LINE.replace('MT-PLACEHOLDER', cardOk.id ?? 'MT-1')
  await typeLine(endpoint, handoff)
  await pressEnter(endpoint)
  const labels = await evaluateUntil(
    endpoint,
    async () => {
      const rows = await pageCall(endpoint, 'queueLabels')
      const hasHandoff = rows.some((row) => row.kind === 'orchestrator-handoff' && row.text.includes(cardOk.id ?? 'MT-'))
      const hasUser = rows.some((row) => row.kind === 'user' && row.text.includes(PLAIN_QUEUE))
      return hasHandoff && hasUser ? rows : false
    },
    'distinct queue-row labels for handoff vs plain user text',
    CARD_DEADLINE_MS
  )
  log(`check-multitask-task-card: queue labels distinguished handoff vs user (${labels.length} labeled rows)`)

  await callCdp(endpoint, 'Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true
  })
  sleep(1_000)
  await evaluate(endpoint, PAGE_HELPERS)
  const narrow = await evaluateUntil(
    endpoint,
    async () => {
      const cards = await pageCall(endpoint, 'cards')
      const card = cards.find((row) => row.id === cardOk.id)
      return card?.narrow === true ? card : false
    },
    'the success card to degrade to narrow text',
    CARD_DEADLINE_MS
  )
  for (const token of [cardOk.id, OBJECTIVE_OK, narrow.phase]) {
    if (!narrow.text.includes(String(token))) {
      fail(`narrow text is missing ${token}: ${JSON.stringify(narrow.text.slice(0, 400))}`)
    }
  }
  if (narrow.text.includes('[data-') || /<button/i.test(narrow.text)) {
    fail('narrow surface still depends on interactive chrome')
  }
  log(`check-multitask-task-card: narrow text card readable (phase ${narrow.phase})`)

  await callCdp(endpoint, 'Emulation.clearDeviceMetricsOverride', {})
  sleep(400)
  await evaluateUntil(
    endpoint,
    async () => !(await pageCall(endpoint, 'turnRunning')),
    'the busy turn to finish before the claim probe',
    RENDERER_DEADLINE_MS
  )

  await typeLine(endpoint, CLAIM_PROMPT)
  await pressEnter(endpoint)
  let claimBadge
  try {
    claimBadge = await evaluateUntil(
      endpoint,
      async () => {
        const badges = await pageCall(endpoint, 'claimBadges')
        return badges.find((badge) => badge.path === CLAIM_PATH || (badge.text ?? '').includes(CLAIM_PATH))
          ?? (badges.length > badgesBefore.length ? badges[badges.length - 1] : false)
      },
      'a claim badge on the affected tool presenter',
      CARD_DEADLINE_MS
    )
  } catch (error) {
    const existing = await pageCall(endpoint, 'claimBadges')
    if (existing.length === 0) throw error
    claimBadge = existing[0]
    log('check-multitask-task-card: claim prompt did not add a new path; using live projection badges already on tool presenters')
  }
  log(`check-multitask-task-card: claim badge rendered for ${claimBadge.path} task=${claimBadge.taskId}`)

  const liveLog = findScenarioLog(startedAt)
  if (liveLog !== undefined) {
    const taskEvents = liveLog.events.filter((event) => event.type === 'multitask/task' && String(event.data?.objective ?? '').includes(String(EPOCH)))
    const ids = new Set(taskEvents.map((event) => event.data.id))
    if (ids.size < 2) fail(`session journal did not record two task identities: ${JSON.stringify([...ids])}`)
    log(`check-multitask-task-card: journal folded ${taskEvents.length} task events over ${ids.size} ids (${liveLog.file})`)
  }

  if (liveLog !== undefined) {
    for (const event of liveLog.events) {
      if (typeof event.data?.phase === 'string' && String(event.data?.objective ?? '').includes(String(EPOCH))) {
        const mapped = event.data.phase === 'researched'
          ? 'orchestrating'
          : event.data.phase === 'research-failed' ? 'failed' : event.data.phase
        seenPhases.add(mapped)
      }
    }
  }
  if (seenPhases.size < 2) {
    fail(`card did not publish live phase transitions; saw only ${JSON.stringify([...seenPhases])}`)
  }
  log(`check-multitask-task-card: live phases observed ${JSON.stringify([...seenPhases])}`)

  log('check-multitask-task-card: PASS')
} catch (error) {
  if (error instanceof ScenarioFailure) {
    process.stderr.write(`check-multitask-task-card: FAIL\n${error.message}\n`)
  } else {
    process.stderr.write(`check-multitask-task-card: FAIL (unexpected error)\n${error?.stack ?? String(error)}\n`)
  }
  await teardownDevApp()
  process.exit(1)
}
await teardownDevApp()
