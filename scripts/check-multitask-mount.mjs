#!/usr/bin/env node
// Real-app mount smoke check for the [multitask] scaffold (issue #3).
//
// Ensures-or-attaches `npm run dev` (the composed desktop profile: the full
// @deepseek-ai/dsh bundle stack with build/dsh-desktop.patch.yml applied),
// waits for boot, then asserts the two scaffold observations in the running
// app:
//   (a) the host startup line "[multitask] plugin active" appears in the
//       desktop's Harness log for the current boot (the Harness child's
//       stdout is what the desktop main process writes there), and
//   (b) the placeholder occupant renders in the live renderer, measured
//       over the Chrome DevTools Protocol the same way scripts/cdp-eval.mjs
//       talks to the app.
//
// electron-vite (the `dev` runner) adds --remote-debugging-port to the
// Electron command line when REMOTE_DEBUGGING_PORT is set in the
// environment, so the script can always attach to the instance it started.
//
// Exit 0 only when both observations succeeded.
//
// Safety: a production DSH Desktop may be running on this machine. The dev
// app runs in its own userData ("dsh-desktop-dev") and on its own ports, and
// cleanup signals only processes descended from the `npm run dev` child this
// script started — never the production app, never anything else.

import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import process from 'node:process'

const STARTUP_LINE = '[multitask] plugin active'
const BOOT_MARKER = '[desktop] starting '
const PLACEHOLDER_SELECTOR = '[data-dsh-multitask-placeholder]'
const CDP_PORT = Number(process.env.DSH_MULTITASK_CDP_PORT ?? 9223)
const CDP_HOST = `127.0.0.1:${CDP_PORT}`
const BOOT_DEADLINE_MS = 300_000
// Generous on purpose: right after a full test suite or on a cold profile the
// Electron boot can take a while. A real boot failure (locked single instance,
// crash at entry) usually shows a recognizable line in the dev output, which
// fails fast below instead of waiting this out.
const CDP_ATTACH_PROBE_MS = 120_000
const STARTUP_LINE_DEADLINE_MS = 60_000

const projectRoot = join(import.meta.dirname, '..')

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function log(message) {
  process.stdout.write(`${message}\n`)
}

function fail(message) {
  process.stderr.write(`check-multitask-mount: FAIL\n${message}\n`)
  process.exit(1)
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
    return undefined // CDP endpoint unreachable right now
  }
}

/**
 * Pick the debuggable Harness page. The desktop window loads the Harness
 * origin; the splash and other desktop surfaces are file:// pages. Any
 * target type on the Harness origin is accepted — while the window
 * navigates, /json/list can serve the page under a non-"page" type.
 */
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

function evaluate(endpoint, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint)
    const timer = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new Error('websocket evaluation timed out'))
    }, 5_000)
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('websocket error'))
    })
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable', params: {} }))
      ws.send(JSON.stringify({
        id: 2,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: false }
      }))
    })
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== 2) return
      clearTimeout(timer)
      ws.close()
      if (message.error) {
        reject(new Error(JSON.stringify(message.error)))
        return
      }
      if (message.result?.exceptionDetails !== undefined) {
        // Execution context torn down mid-navigation and similar — the poll
        // retries on the next tick.
        reject(new Error('evaluation threw in the page'))
        return
      }
      resolve(message.result?.result?.value)
    })
  })
}

/** Candidate paths of the desktop's Harness log (`app.getPath('logs')/harness.log`). */
function harnessLogCandidates() {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Logs', 'DSH Desktop Dev', 'harness.log')]
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return [join(appData, 'DSH Desktop Dev', 'logs', 'harness.log')]
  }
  const config = process.env.XDG_CONFIG_HOME ?? join(home, '.config')
  return [join(config, 'DSH Desktop Dev', 'logs', 'harness.log')]
}

/** Read the file grown from `offset` so only this boot's lines are evidence. */
function readFrom(path, offset) {
  const size = statSync(path).size
  if (size <= offset) return ''
  const buffer = Buffer.alloc(size - offset)
  const handle = openSync(path, 'r')
  try {
    readSync(handle, buffer, 0, buffer.length, offset)
  } finally {
    closeSync(handle)
  }
  return buffer.toString('utf8')
}

function readWhole(path) {
  return readFrom(path, 0)
}

function tail(path, bytes = 4_000) {
  const size = statSync(path).size
  return readFrom(path, Math.max(0, size - bytes))
}

function openHarnessLog() {
  const path = harnessLogCandidates().find((candidate) => existsSync(candidate))
  if (path === undefined) return undefined
  return { path, offset: statSync(path).size }
}

// ---------------------------------------------------------------------------
// Process-tree cleanup: only descendants of the child this script spawned.
// A bare process-group SIGTERM is not enough — npm intercepts the signal and
// can exit before electron-vite does, orphaning the whole Electron tree, so
// the descendants are collected and signalled by PID as well.
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

async function cleanup() {
  if (dev === undefined) return
  signalTree('SIGTERM')
  for (let waited = 0; waited < 10_000; waited += 500) {
    const alive = descendantPids(dev.pid)
    if (alive.length === 0) break
    sleep(500)
  }
  signalTree('SIGKILL')
  // The CDP port must be free again before this script reports done, so a
  // follow-up run cannot attach to a half-dead instance.
  for (let waited = 0; waited < 10_000; waited += 500) {
    if (!(await cdpUp())) return
    sleep(500)
  }
  process.stderr.write(
    `check-multitask-mount: warning: something still listens on 127.0.0.1:${CDP_PORT} after cleanup\n`
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
  const harnessLog = openHarnessLog()
  const startedAt = Date.now()
  let attachMode = false

  if (await cdpUp()) {
    attachMode = true
    log(`check-multitask-mount: attaching to a running dev app on CDP port ${CDP_PORT}`)
  } else {
    if (!existsSync(join(projectRoot, 'node_modules'))) {
      fail('node_modules is missing; run npm install first')
    }
    log(`check-multitask-mount: starting \`npm run dev\` (CDP port ${CDP_PORT}) …`)
    // Two environment poisons must never reach the dev Electron, from either
    // an agent shell or a shell running inside a DSH Desktop Harness child:
    //
    // 1. ELECTRON_RUN_AS_NODE=1 anywhere in this process's own environment
    //    (agent harnesses execute inside Electron-as-Node). Inherited by the
    //    desktop's main process, it boots as a plain Node script and dies on
    //    Electron's ESM exports.
    // 2. The desktop's own `.desktop-bin` PATH entries. The running production
    //    app prepends a directory containing a `node` shim that unconditionally
    //    re-exports ELECTRON_RUN_AS_NODE=1 before exec'ing the Helper binary —
    //    so `npm` several levels down inherits the flag again no matter what
    //    this process strips. Drop those entries so `node`/`npm` resolve to
    //    real installs.
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

  // Phase 1: wait for a debuggable page on the Harness origin.
  let endpoint
  let probe
  do {
    if (Date.now() - startedAt > BOOT_DEADLINE_MS) {
      fail(`timed out waiting for the renderer page on the Harness origin (last probe: ${probe ?? 'starting'})`)
    }
    if (
      !attachMode
      && dev !== undefined
      && Date.now() - startedAt > CDP_ATTACH_PROBE_MS
      && !(await cdpUp())
    ) {
      const lockHint = harnessLog !== undefined
        ? `The Harness log (${harnessLog.path}) shows no new boot for this run.`
        : `No Harness log found at any of: ${harnessLogCandidates().join(', ')}`
      fail(
        [
          `the dev app did not expose a debuggable renderer on 127.0.0.1:${CDP_PORT} within ${Math.round(CDP_ATTACH_PROBE_MS / 1000)}s.`,
          lockHint,
          'Likely causes: a stale DSH Desktop Dev instance from an earlier run still holds the',
          'single-instance lock (per-userData) or the CDP port — stop it, or pick another port',
          'via DSH_MULTITASK_CDP_PORT. Or the dev server failed to start. Captured dev output (tail):',
          ...devOutput.slice(-25).map((line) => `  | ${line}`)
        ].join('\n')
      )
    }
    if (
      !attachMode
      && dev !== undefined
      && devOutput.some((line) =>
        /SyntaxError:|does not provide an export|exited with signal|Cannot find module/u.test(line)
      )
    ) {
      fail(
        [
          'the dev Electron crashed before exposing a debuggable renderer. Captured dev output (tail):',
          ...devOutput.slice(-25).map((line) => `  | ${line}`)
        ].join('\n')
      )
    }
    const found = harnessEndpointOf(await listTargets())
    endpoint = found.endpoint ?? endpoint // stick to the last known good page while /json/list flakes
    probe = found.reason
    if (endpoint === undefined) sleep(1_000)
  } while (endpoint === undefined)
  log('check-multitask-mount: renderer page is up on the Harness origin')

  // Phase 2: wait for boot to finish and the placeholder to render. Two
  // shared-state failure shapes must fail fast with their cause instead of
  // burning the whole boot window:
  //   - the Harness entry rejecting at startup (e.g. a malformed overlay in
  //     the SHARED profile home — that file is user state every dev checkout
  //     on this machine composes into), and
  //   - the desktop's automatic safe-mode fallback, where third-party profile
  //     bundles are blocked and a plugin placeholder can never render.
  const deadline = Date.now() + BOOT_DEADLINE_MS
  let occupantRendered = false
  let lastProbe = 'not probed yet'
  const bootEvidence = () => harnessLog === undefined ? '' : readFrom(harnessLog.path, harnessLog.offset)
  while (!occupantRendered) {
    if (Date.now() > deadline) {
      fail(
        [
          `the placeholder occupant never rendered within the boot window; last renderer probe: ${lastProbe}`,
          'The client module is either not served or its composition failed — search the Harness',
          'log and dev output for client-modules errors. Captured dev output (tail):',
          ...devOutput.slice(-15).map((line) => `  | ${line}`)
        ].join('\n')
      )
    }
    const evidence = bootEvidence()
    if (evidence.includes('Harness entry failed during startup')) {
      const cause = evidence.split('\n').find((line) => line.includes('DSH entry failed:'))
      fail(
        [
          'the Harness entry failed during startup; the desktop will fall back to safe mode, where',
          'third-party profile bundles (and therefore this placeholder) are blocked.',
          cause?.trim() !== undefined ? `Cause: ${cause.trim()}` : 'Cause line not captured; see the Harness log tail.',
          'Note: the overlay parsed at that point is the SHARED profile cordis.patch.yml under the',
          'dev DSH_HOME — state every dev checkout on this machine composes into, not this ticket\'s',
          'build/dsh-desktop.patch.yml rows. Harness log tail:',
          tail(harnessLog.path).split('\n').slice(-25).map((line) => `  | ${line}`).join('\n')
        ].join('\n')
      )
    }
    if (
      evidence.includes('launch requested (safe mode)')
      || evidence.includes('third-party web profile bundles are blocked')
    ) {
      fail(
        [
          'the desktop fell back to SAFE MODE, which blocks third-party profile bundles — the',
          'placeholder occupant cannot render there and the mount cannot be verified in this boot.',
          'Resolve the cause the desktop logged before this fallback (see the Harness log tail),',
          'then re-run. Harness log tail:',
          tail(harnessLog.path).split('\n').slice(-25).map((line) => `  | ${line}`).join('\n')
        ].join('\n')
      )
    }
    const current = harnessEndpointOf(await listTargets()).endpoint ?? endpoint
    if (current !== undefined) {
      try {
        const found = await evaluate(
          current,
          `document.querySelector(${JSON.stringify(PLACEHOLDER_SELECTOR)}) !== null`
        )
        if (found === true) occupantRendered = true
        else lastProbe = `selector ${PLACEHOLDER_SELECTOR} not in the DOM yet`
      } catch (error) {
        lastProbe = `evaluation failed (${error instanceof Error ? error.message : String(error)})`
      }
    } else {
      lastProbe = 'no debuggable Harness page right now'
    }
    if (!occupantRendered) sleep(1_000)
  }
  log(`check-multitask-mount: placeholder occupant rendered (${PLACEHOLDER_SELECTOR} present in the live renderer)`)

  // Phase 3: the host startup line for the current boot. A freshly started
  // app must have appended it since this script began; an attached app must
  // have it in the section of the log since its last `[desktop] starting`
  // marker (the boot that produced the page now on screen).
  if (harnessLog === undefined) {
    fail(`could not locate the desktop Harness log (looked at: ${harnessLogCandidates().join(', ')})`)
  }
  const lineDeadline = Date.now() + STARTUP_LINE_DEADLINE_MS
  let matched
  while (matched === undefined) {
    const evidence = attachMode ? readWhole(harnessLog.path) : readFrom(harnessLog.path, harnessLog.offset)
    const currentBoot = evidence.lastIndexOf(BOOT_MARKER)
    matched = (currentBoot === -1 ? evidence : evidence.slice(currentBoot))
      .split('\n')
      .find((line) => line.includes(STARTUP_LINE))
    if (matched !== undefined) break
    if (attachMode || Date.now() > lineDeadline) {
      fail(
        [
          `"${STARTUP_LINE}" was not found in ${harnessLog.path} for the current boot${attachMode ? ' (attach mode: searched since the last boot marker)' : ` within ${Math.round(STARTUP_LINE_DEADLINE_MS / 1000)}s of the renderer being up`}.`,
          'The host plugin either did not load (mount/closure problem — see the log tail) or its',
          'apply() never ran. Harness log tail:',
          tail(harnessLog.path).split('\n').slice(-25).map((line) => `  | ${line}`).join('\n')
        ].join('\n')
      )
    }
    sleep(1_000)
  }
  log(`check-multitask-mount: startup line observed in ${harnessLog.path}: ${matched.trim()}`)

  log('check-multitask-mount: PASS')
} finally {
  await cleanup()
}
