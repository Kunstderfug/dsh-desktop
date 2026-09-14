#!/usr/bin/env node
// Real-app command scenario for the [multitask] /multitask command (issue #4).
//
// Ensures-or-attaches `npm run dev` (the composed desktop profile: the full
// @deepseek-ai/dsh bundle stack with build/dsh-desktop.patch.yml applied, so
// the dsh-multitask host plugin is mounted), then drives the real composer
// over the Chrome DevTools Protocol and asserts the public-seam observations
// for the /multitask command:
//
//   (a) typing `/goal` in the composer lists a goal entry in the slash menu
//       (positive control — the menu reads host `commands/list`), and typing
//       `/multitask` lists the multitask entry with its description;
//   (b) submitting `/multitask <objective>` executes host-side with no model
//       turn: the standard command chat node renders the minted task id with
//       the success card (phase, research, implementation, orchestrator);
//   (c) `/multitask` with no objective is refused through the leading-claim
//       route: it renders no task node and the session log records
//       `command/run` + `command/done` (kind error, usage text) with NO
//       `multitask/task`;
//   (d) a second objective mints the successor ordinal in the same session;
//   (e) the dev session log on disk contains, in order, `command/run`
//       (name `multitask`, verbatim args), `multitask/task`
//       `{id, objective, phase: 'queued', createdAt}` with an ISO timestamp,
//       `command/done` (`kind: 'success'`) under one pairing id — and no
//       model-visible user message or turn records the command line (the
//       command never reaches the model).
//
// Because the composed profile mounts the patch.yml insert rows through the
// dev userData's profile node_modules, and those plugin links are shared
// state left by whichever checkout last installed the profile, the script
// first re-points the `dsh-multitask` / `dsh-multitask-client` links at THIS
// checkout (the same repair profile maintenance performs on a rebuild), so a
// stale plugin from another checkout can never satisfy the scenario.
//
// Session logs live under the dev DSH_HOME (`userData/harness/sessions`) as
// concatenated Zstandard frames of JSONL; the script decodes them with a
// frame walk (a naive one-shot decompress would drop every frame after the
// first). Buffers drain at ordinary checkpoints and teardown, so the script
// polls the log live first and, if needed, re-reads after the app tree is
// torn down.
//
// Exit 0 only when every observation succeeded.
//
// Safety: a production DSH Desktop may be running on this machine. The dev
// app runs in its own userData ("dsh-desktop-dev") and on its own ports, and
// cleanup signals only processes descended from the `npm run dev` child this
// script started — never the production app, never anything else.

import { execFileSync, spawn } from 'node:child_process'
import * as syncFs from 'node:fs'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import { zstdDecompressSync } from 'node:zlib'

const CDP_PORT = Number(process.env.DSH_MULTITASK_CDP_PORT ?? 9223)
const CDP_HOST = `127.0.0.1:${CDP_PORT}`
const BOOT_DEADLINE_MS = 300_000
const CDP_ATTACH_PROBE_MS = 120_000
const RENDERER_DEADLINE_MS = 120_000
const CARD_DEADLINE_MS = 60_000
const LOG_POLL_DEADLINE_MS = 90_000
const POST_TEARDOWN_GRACE_MS = 20_000

const EPOCH = Date.now()
const OBJECTIVE_A = `research the multitask command scenario A ${EPOCH}`
const OBJECTIVE_B = `implement the multitask command scenario B ${EPOCH}`

const projectRoot = join(import.meta.dirname, '..')

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function log(message) {
  process.stdout.write(`${message}\n`)
}

/**
 * A scenario failure. Thrown (never a direct process.exit) so the top-level
 * handler can tear the spawned app tree down before exiting — process.exit
 * would leave the electron tree orphaned.
 */
class ScenarioFailure extends Error {}

function fail(message) {
  throw new ScenarioFailure(message)
}

// ---------------------------------------------------------------------------
// CDP transport: one WebSocket per request, like scripts/cdp-eval.mjs, plus
// Input-domain senders for trusted composer events.
// ---------------------------------------------------------------------------

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
    return undefined // CDP endpoint unreachable right now
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

/** One Runtime.evaluate round-trip; resolves the JSON value of the result. */
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

/** Trusted text insertion into the focused editable (fires real input events). */
async function insertText(endpoint, text) {
  await callCdp(endpoint, 'Input.insertText', { text })
}

/** Trusted key press (keydown + keyup); optional CDP modifier bitmask. */
async function keyPress(endpoint, key, code, virtualKeyCode, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) {
    const params = { type, key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode }
    if (modifiers !== 0) params.modifiers = modifiers
    await callCdp(endpoint, 'Input.dispatchKeyEvent', params)
  }
}

/** Trusted Enter key press (keydown + keyup) for composer adjudication. */
async function pressEnter(endpoint) {
  await keyPress(endpoint, 'Enter', 'Enter', 13)
}

// ---------------------------------------------------------------------------
// In-page helpers (executed inside the renderer through Runtime.evaluate).
// ---------------------------------------------------------------------------

const PAGE_HELPERS = `
  window.__mtcHelper = {
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
    menuOptionTexts() {
      return [...document.querySelectorAll('[role="option"]')].map((el) => (el.textContent ?? '').trim())
    },
    commandCards() {
      return [...document.querySelectorAll('div[data-variant="others"][data-state]')].map((el) => ({
        state: el.getAttribute('data-state'),
        title: el.textContent ?? ''
      }))
    }
  }
  'ready'
`

function pageCall(endpoint, fn, arg = '', awaitPromise = false) {
  return evaluate(endpoint, `window.__mtcHelper.${fn}(${arg})`, { awaitPromise })
}

async function evaluateUntil(endpoint, probe, what, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  let last = 'not probed yet'
  for (;;) {
    try {
      const value = await probe()
      if (value) return value
      last = `probe returned ${JSON.stringify(value)?.slice(0, 120)}`
    } catch (error) {
      last = `probe failed (${error instanceof Error ? error.message : String(error)})`
    }
    if (Date.now() > deadline) fail(`timed out waiting for ${what} (last probe: ${last})`)
    sleep(1_000)
  }
}

/**
 * Empty the composer through trusted key events. The editor is a Lexical
 * contenteditable, so DOM-selection tricks (document.execCommand) do not
 * drive its model — select-all + delete must arrive as real key events.
 * Meta+A selects on macOS, Ctrl+A elsewhere; try both and verify emptiness.
 * A short settle after the delete lets Lexical finish its update before the
 * next insertion targets the caret.
 */
async function clearComposer(endpoint) {
  if (!(await pageCall(endpoint, 'focusComposer'))) return false
  for (const modifiers of [4, 2]) { // 4 = Meta/Command, 2 = Ctrl
    await keyPress(endpoint, 'a', 'KeyA', 65, modifiers)
    await keyPress(endpoint, 'Backspace', 'Backspace', 8)
    if ((await pageCall(endpoint, 'composerText')) === '') {
      sleep(400)
      return (await pageCall(endpoint, 'focusComposer'))
    }
  }
  return false
}

/** Type one line into the composer via the real input path, after clearing. */
async function typeLine(endpoint, line) {
  if (!(await clearComposer(endpoint))) {
    fail('the composer could not be cleared/focused before typing')
  }
  await insertText(endpoint, line)
  let typed = await pageCall(endpoint, 'composerText')
  if (typed !== line) {
    // The editor can detach the caret while settling after the clear; focus
    // it again and retry the insertion once before giving up.
    sleep(500)
    if (!(await pageCall(endpoint, 'focusComposer'))) fail('the composer lost focus while typing')
    await insertText(endpoint, line)
    typed = await pageCall(endpoint, 'composerText')
  }
  if (typed !== line) {
    fail(`the composer did not take the typed line (expected ${JSON.stringify(line)}, saw ${JSON.stringify(typed)})`)
  }
}

// ---------------------------------------------------------------------------
// Session log decoding: concatenated Zstandard frames of JSONL, the container
// the JSONL persistence backend appends. Frame boundaries are walked from the
// frame headers (magic, descriptor, blocks), so a growing multi-frame log
// decodes completely — a naive one-shot decompress would silently drop every
// frame after the first.
// ---------------------------------------------------------------------------

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
    if (singleSegment === 0) p += 1 // window descriptor
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
      if (type === 1) p += 1 // RLE: one repeated byte follows
      else if (type === 0 || type === 2) p += size // Raw or Compressed
      else return { frames, tornStart: start } // Reserved block type
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
  const isZstd = path.endsWith('.zstd')
  if (!isZstd) return buffer.toString('utf8')
  const { frames } = scanZstdFrames(buffer)
  const parts = []
  for (const frame of frames) {
    parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'))
  }
  return parts.join('')
}

function parseSessionLog(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A torn final line can only be the record still being written; the
      // poll retries with a longer file.
    }
  }
  return events
}

/** The dev app's userData directory (`app.setPath('userData')` when developing). */
function devUserDataRoot() {
  const home = homedir()
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'dsh-desktop-dev')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'dsh-desktop-dev')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'dsh-desktop-dev')
}

/** Candidate roots of the dev app's session logs (`userData/harness/sessions`). */
function sessionsRootCandidates() {
  return [join(devUserDataRoot(), 'harness', 'sessions')]
}

const PROFILE_PLUGINS = ['dsh-multitask', 'dsh-multitask-client']

/**
 * Point the dev profile's plugin links at THIS checkout.
 *
 * The composed profile mounts the `insert` rows of build/dsh-desktop.patch.yml
 * by resolving each plugin name against `userData/harness/profiles/node_modules`
 * (Harness profile maintenance creates those links when it installs the
 * profile's file: dependencies). Those links are shared dev-app state: they
 * survive across checkouts, so a link left by an earlier checkout silently
 * mounts a stale plugin copy and this checkout's code never loads. Re-pointing
 * the links here is the same repair profile maintenance performs on a rebuild,
 * restricted to the dev-only userData and the two [multitask] scaffold
 * packages this scenario exists to exercise — never the production userData.
 */
function ensureProfilePluginLinks() {
  const { symlinkSync, readlinkSync, unlinkSync, realpathSync } = syncFs
  const profileModules = join(devUserDataRoot(), 'harness', 'profiles', 'node_modules')
  if (!existsSync(profileModules)) {
    fail(`the dev profile node_modules directory is missing: ${profileModules}`)
  }
  for (const name of PROFILE_PLUGINS) {
    const desiredTarget = join(projectRoot, 'packages', name)
    if (!existsSync(join(desiredTarget, 'package.json'))) {
      fail(`this checkout is missing the plugin package ${desiredTarget}`)
    }
    const link = join(profileModules, name)
    let current = null
    try {
      current = realpathSync(readlinkSync(link))
    } catch {
      // Missing link or a real directory/file in its place.
      if (existsSync(link)) fail(`${link} exists but is not a symlink; refusing to touch it`)
    }
    const desired = realpathSync(desiredTarget)
    if (current === desired) continue
    try { unlinkSync(link) } catch {}
    symlinkSync(desired, link)
    log(`check-multitask-command: profile plugin ${name} linked to ${desired}`)
  }
}

function sessionLogFiles(modifiedSince) {
  const roots = sessionsRootCandidates().filter((candidate) => existsSync(candidate))
  if (roots.length === 0) return []
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'session.v3.jsonl.zstd' || entry.name === 'session.v3.jsonl') files.push(full)
    }
  }
  for (const root of roots) walk(root)
  return files.filter((file) => statSync(file).mtimeMs > modifiedSince - 2_000)
}

/**
 * Read every recent session log and return the events of the one that
 * received this scenario's commands (matched by the unique objective text).
 */
function findScenarioLog(modifiedSince) {
  for (const file of sessionLogFiles(modifiedSince)) {
    let text
    try {
      text = decodeSessionLog(file)
    } catch {
      continue // torn final frame mid-write; the poll retries
    }
    const events = parseSessionLog(text)
    if (events.some((event) => JSON.stringify(event.data ?? {}).includes(String(EPOCH)))) {
      return { file, events }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Process-tree cleanup (verbatim approach of scripts/check-multitask-mount.mjs):
// only descendants of the child this script spawned.
// ---------------------------------------------------------------------------

function descendantPids(rootPid) {
  let table
  try {
    table = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' })
  } catch {
    return []
  }
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
  if (dev === undefined) return // attach mode: never signal a tree we did not start
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
    `check-multitask-command: warning: something still listens on 127.0.0.1:${CDP_PORT} after cleanup\n`
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
  const startedAt = Date.now()
  let attachMode = false

  // The mounted plugin must be THIS checkout's, or the scenario exercises a
  // stale leftover of whichever checkout last installed the dev profile.
  ensureProfilePluginLinks()

  if (await cdpUp()) {
    attachMode = true
    log(`check-multitask-command: attaching to a running dev app on CDP port ${CDP_PORT}`)
  } else {
    if (!existsSync(join(projectRoot, 'node_modules'))) {
      fail('node_modules is missing; run npm install first')
    }
    log(`check-multitask-command: starting \`npm run dev\` (CDP port ${CDP_PORT}) …`)
    // Environment poisons stripped exactly like scripts/check-multitask-mount.mjs:
    // ELECTRON_RUN_AS_NODE (agent harnesses run Electron-as-Node) and the
    // production app's `.desktop-bin` PATH shims that re-export it.
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

  // Phase 1: a debuggable page on the Harness origin.
  let endpoint
  let probe
  do {
    if (Date.now() - startedAt > BOOT_DEADLINE_MS) {
      fail(`timed out waiting for the renderer page on the Harness origin (last probe: ${probe ?? 'starting'})`)
    }
    if (
      !attachMode && dev !== undefined && Date.now() - startedAt > CDP_ATTACH_PROBE_MS && !(await cdpUp())
    ) {
      fail(
        [
          `the dev app did not expose a debuggable renderer on 127.0.0.1:${CDP_PORT} within ${Math.round(CDP_ATTACH_PROBE_MS / 1000)}s.`,
          'Likely causes: a stale DSH Desktop Dev instance still holds the single-instance lock or the CDP',
          'port — stop it, or pick another port via DSH_MULTITASK_CDP_PORT. Captured dev output (tail):',
          ...devOutput.slice(-25).map((line) => `  | ${line}`)
        ].join('\n')
      )
    }
    if (
      !attachMode && dev !== undefined
      && devOutput.some((line) => /SyntaxError:|does not provide an export|exited with signal|Cannot find module/u.test(line))
    ) {
      fail(
        [
          'the dev Electron crashed before exposing a debuggable renderer. Captured dev output (tail):',
          ...devOutput.slice(-25).map((line) => `  | ${line}`)
        ].join('\n')
      )
    }
    const found = harnessEndpointOf(await listTargets())
    endpoint = found.endpoint ?? endpoint
    probe = found.reason
    if (endpoint === undefined) sleep(1_000)
  } while (endpoint === undefined)
  log('check-multitask-command: renderer page is up on the Harness origin')

  // Phase 2: the app is interactive — the composer exists and the in-page
  // helpers installed.
  await evaluateUntil(
    endpoint,
    async () => {
      if ((await evaluate(endpoint, 'document.querySelector("[data-input-scroll]") !== null')) !== true) return false
      if ((await evaluate(endpoint, PAGE_HELPERS)) !== 'ready') return false
      return true
    },
    'the composer to become interactive',
    RENDERER_DEADLINE_MS
  )
  log('check-multitask-command: composer is interactive')

  // Phase 3a: slash-menu probes. Positive control first: /goal must surface
  // (the menu is fed by host commands/list), then /multitask.
  await typeLine(endpoint, '/goal')
  const goalOptions = await evaluateUntil(
    endpoint,
    async () => {
      const options = await pageCall(endpoint, 'menuOptionTexts')
      return options.length > 0 ? options : false
    },
    'the /goal menu options to render',
    CARD_DEADLINE_MS
  )
  if (!goalOptions.some((text) => text.toLowerCase().includes('goal'))) {
    fail(`the positive control /goal is missing from the composer menu; options: ${JSON.stringify(goalOptions)}`)
  }
  log(`check-multitask-command: positive control /goal listed (${goalOptions.length} option rows)`)

  await typeLine(endpoint, '/multitask')
  const multitaskOptions = await evaluateUntil(
    endpoint,
    async () => {
      const options = await pageCall(endpoint, 'menuOptionTexts')
      return options.some((text) => text.toLowerCase().includes('multitask')) ? options : false
    },
    'the /multitask menu entry to render',
    CARD_DEADLINE_MS
  )
  const multitaskRow = multitaskOptions.find((text) => text.toLowerCase().includes('multitask'))
  log(`check-multitask-command: /multitask listed in the composer menu: ${JSON.stringify(multitaskRow)}`)
  if (!(await clearComposer(endpoint))) fail('the composer could not be cleared after the menu probes')

  // Phase 3b: execute /multitask <objective A> through the composer — host
  // dispatch via commands/execute, no model turn. Task ordinals fold from the
  // session's existing events, so the minted ids are read from the cards (a
  // reused dev session may already hold earlier multitask tasks).
  await typeLine(endpoint, `/multitask ${OBJECTIVE_A}`)
  await pressEnter(endpoint)
  const cardA = await evaluateUntil(
    endpoint,
    async () => {
      const cards = await pageCall(endpoint, 'commandCards')
      return cards.find((card) => card.state === 'ok' && card.title.includes(OBJECTIVE_A)) ?? false
    },
    'the objective A success command card to render',
    CARD_DEADLINE_MS
  )
  for (const token of ['multitask', OBJECTIVE_A, 'queued', 'research', 'implementation', 'orchestrator']) {
    if (!cardA.title.includes(token)) {
      fail(`the objective A command card is missing ${JSON.stringify(token)}; card text: ${JSON.stringify(cardA.title.slice(0, 600))}`)
    }
  }
  const idA = /MT-([1-9][0-9]*)/.exec(cardA.title)?.[1]
  if (idA === undefined) {
    fail(`the objective A card does not name a minted task id: ${JSON.stringify(cardA.title.slice(0, 300))}`)
  }
  log(`check-multitask-command: standard command chat node rendered the ${`MT-${idA}`} success card`)

  // Phase 3c: empty objective. A whitespace-only /multitask line is BARE after
  // trim, so the composer's enter adjudication routes it through the leading
  // claim (first Enter inserts `/multitask `), and the second Enter submits
  // the empty args. The handler refuses without appending a task event, and
  // the durable record of that refusal is the session-log run/done(error)
  // pair asserted below. In the renderer this build surfaces claimed-route
  // errors without a persistent flow node or toast, so the observable here is
  // the absence: no multitask card appears and no ordinal is minted.
  const multitaskCardCount = async () => {
    const cards = await pageCall(endpoint, 'commandCards')
    return cards.filter((card) => card.title.startsWith('multitask')).length
  }
  const cardCountBefore = await multitaskCardCount()
  await typeLine(endpoint, '/multitask')
  await pressEnter(endpoint)
  sleep(600)
  await pressEnter(endpoint)
  sleep(2_000)
  const cardCountAfter = await multitaskCardCount()
  if (cardCountAfter !== cardCountBefore) {
    fail(`the refused empty-objective invocation rendered a new chat node (${cardCountBefore} → ${cardCountAfter} multitask cards)`)
  }
  log('check-multitask-command: empty objective refusal rendered no task node (the log records the refusal)')

  // Phase 3d: a second objective mints the NEXT ordinal in the same session.
  await typeLine(endpoint, `/multitask ${OBJECTIVE_B}`)
  await pressEnter(endpoint)
  const cardB = await evaluateUntil(
    endpoint,
    async () => {
      const cards = await pageCall(endpoint, 'commandCards')
      return cards.find((card) => card.state === 'ok' && card.title.includes(OBJECTIVE_B)) ?? false
    },
    'the objective B success command card to render',
    CARD_DEADLINE_MS
  )
  const idB = /MT-([1-9][0-9]*)/.exec(cardB.title)?.[1]
  if (idB === undefined || Number(idB) !== Number(idA) + 1) {
    fail(`the second invocation minted ${idB === undefined ? 'no id' : `MT-${idB}`}; expected the successor of MT-${idA}`)
  }
  log(`check-multitask-command: second invocation rendered the ${`MT-${idB}`} success card`)

  // Phase 4: the durable session log on disk. Buffers drain at ordinary
  // checkpoints, so poll live first; teardown below also forces a drain and
  // the post-teardown pass re-checks before this script reports. Assertions
  // scope to this scenario's events (objectives carry the unique epoch), so
  // the check is valid on a reused dev session too.
  const assertScenarioLog = (found) => {
    const { file, events } = found

    // The two task events of THIS scenario, in append order.
    const taskA = events.find((event) => event.type === 'multitask/task' && event.data.objective === OBJECTIVE_A)
    const taskB = events.find((event) => event.type === 'multitask/task' && event.data.objective === OBJECTIVE_B)
    if (taskA === undefined || taskB === undefined) {
      fail(`multitask/task events for this scenario's objectives are missing from the log: ${file}`)
    }
    for (const [task, id] of [[taskA, `MT-${idA}`], [taskB, `MT-${idB}`]]) {
      const keys = Object.keys(task.data).sort()
      if (JSON.stringify(keys) !== JSON.stringify(['createdAt', 'id', 'objective', 'phase'])) {
        fail(`multitask/task data shape is not the frozen shape: ${JSON.stringify(keys)}`)
      }
      if (task.data.id !== id || task.data.phase !== 'queued') {
        fail(`multitask/task event mismatch: ${JSON.stringify(task.data).slice(0, 300)}`)
      }
      if (Number.isNaN(new Date(task.data.createdAt).getTime())) {
        fail(`multitask/task createdAt is not an ISO timestamp: ${JSON.stringify(task.data.createdAt)}`)
      }
    }

    // Lifecycle pairing: run -> task -> done under one commandId, twice; the
    // rejected invocation records the pair with kind error and no task event.
    const dones = events.filter((event) => event.type === 'command/done' && event.data.commandId !== undefined)
    const runA = events.find((event) => event.type === 'command/run' && event.data.name === 'multitask' && event.data.args === ` ${OBJECTIVE_A}`)
    const runB = events.find((event) => event.type === 'command/run' && event.data.name === 'multitask' && event.data.args === ` ${OBJECTIVE_B}`)
    if (runA === undefined || runB === undefined) {
      fail('this scenario\'s multitask command/run events are missing from the log')
    }
    // The rejected invocation is the empty-args multitask run strictly between
    // this scenario's A-done and B-run records.
    const doneA = dones.find((candidate) => candidate.data.commandId === runA.data.commandId)
    const doneB = dones.find((candidate) => candidate.data.commandId === runB.data.commandId)
    if (doneA === undefined || doneB === undefined) fail('no command/done paired with this scenario\'s command/run records')
    const rejected = events.find(
      (event) => event.type === 'command/run' && event.data.name === 'multitask'
        && typeof event.data.args === 'string' && event.data.args.trim() === ''
        && event.seq > doneA.seq && event.seq < runB.seq
    )
    if (rejected === undefined) fail('the rejected empty-objective invocation left no command/run record')
    const rejectedDone = dones.find((candidate) => candidate.data.commandId === rejected.data.commandId)
    if (rejectedDone === undefined) fail('no command/done paired with the rejected invocation')

    for (const [run, done, objective, expectedText] of [
      [runA, doneA, OBJECTIVE_A, `MT-${idA}`],
      [rejected, rejectedDone, undefined, undefined],
      [runB, doneB, OBJECTIVE_B, `MT-${idB}`]
    ]) {
      if (done.data.kind !== (objective === undefined ? 'error' : 'success')) {
        fail(`command/done kind ${JSON.stringify(done.data.kind)} for ${objective === undefined ? 'the rejected invocation' : objective}`)
      }
      if (objective !== undefined) {
        if (run.data.args !== ` ${objective}`) {
          fail(`command/run args are not the verbatim objective: ${JSON.stringify(run.data.args)}`)
        }
        const taskBetween = events.some(
          (event) => event.type === 'multitask/task' && event.seq > run.seq && event.seq < done.seq
        )
        if (!taskBetween) fail(`no multitask/task event between command/run and command/done for ${objective}`)
        if (done.data.text === undefined || !done.data.text.includes(expectedText)) {
          fail(`success command/done text does not name ${expectedText}: ${JSON.stringify(done.data.text)}`)
        }
      } else {
        const taskBetween = events.some(
          (event) => event.type === 'multitask/task' && event.seq > run.seq && event.seq < done.seq
        )
        if (taskBetween) fail('the rejected invocation appended a multitask/task event')
        if (done.data.text === undefined || !done.data.text.includes('Usage:')) {
          fail(`error command/done text lacks usage guidance: ${JSON.stringify(done.data.text)}`)
        }
      }
    }

    // Ordering across invocations: the first task precedes the second.
    if (!(taskA.seq < taskB.seq)) fail('multitask/task events are out of order (objective A must precede objective B)')

    // The command never reaches the model: the model-visible surface (user
    // messages, turns) carries neither the raw command line nor an objective,
    // and no turn/start falls in any invocation's execution window (the
    // command opened no model turn). The usage text inside a command/done
    // record legitimately mentions `/multitask`, so the surface check is
    // scoped to the model-visible event types.
    for (const event of events) {
      if (!['user/message', 'turn/start', 'assistant/message'].includes(event.type)) continue
      const text = JSON.stringify(event.data ?? {})
      if (text.includes('/multitask') || text.includes(OBJECTIVE_A) || text.includes(OBJECTIVE_B)) {
        fail(`the command line or an objective leaked into the model-visible ${event.type} event: ${text.slice(0, 200)}`)
      }
    }
    for (const [run, done] of [[runA, doneA], [rejected, rejectedDone], [runB, doneB]]) {
      const intruding = events.find(
        (event) => event.type === 'turn/start' && event.seq > run.seq && event.seq < done.seq
      )
      if (intruding !== undefined) {
        fail(`a turn/start (seq ${intruding.seq}) opened inside the command window (${run.seq}→${done.seq}): the command started a model turn`)
      }
    }
    log(`check-multitask-command: session log verified (${events.length} events, 2 multitask/task, pairing + ordering + no model turn): ${file}`)
  }

  let verified = false
  for (let waited = 0; waited < LOG_POLL_DEADLINE_MS; waited += 3_000) {
    const found = findScenarioLog(startedAt)
    if (found !== undefined) {
      try {
        assertScenarioLog(found)
        verified = true
        break
      } catch (error) {
        // A torn or partially drained log mid-write can fail an assertion;
        // retry until the deadline before treating it as a product failure.
        if (Date.now() - startedAt > LOG_POLL_DEADLINE_MS) throw error
      }
    }
    sleep(3_000)
  }

  await teardownDevApp()

  if (!verified) {
    const deadline = Date.now() + POST_TEARDOWN_GRACE_MS
    while (Date.now() < deadline && !verified) {
      const found = findScenarioLog(startedAt)
      if (found !== undefined) {
        assertScenarioLog(found) // final read: fail loud with the real mismatch
        verified = true
      } else {
        sleep(1_000)
      }
    }
  }
  if (!verified) {
    fail(
      [
        `no session log received this scenario's commands (objectives carry the epoch ${EPOCH}).`,
        `Looked under: ${sessionsRootCandidates().join(', ')}`,
        'Captured dev output (tail):',
        ...devOutput.slice(-15).map((line) => `  | ${line}`)
      ].join('\n')
    )
  }

  log('check-multitask-command: PASS')
} catch (error) {
  if (error instanceof ScenarioFailure) {
    process.stderr.write(`check-multitask-command: FAIL\n${error.message}\n`)
  } else {
    process.stderr.write(`check-multitask-command: FAIL (unexpected error)\n${error?.stack ?? String(error)}\n`)
  }
  await teardownDevApp()
  process.exit(1)
}
await teardownDevApp()
