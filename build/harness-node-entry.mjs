import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { enforceWindowsChildProcessHide } from './windows-child-process-hide.mjs'

// On macOS Harness runs inside an Electron utility process (TCC responsibility
// isolation), so `process.execPath` and `argv0` point at the Electron helper
// instead of a Node binary. Plugins re-invoke the dsh CLI through the
// executable running them — dsh-market forwards `process.execArgv` with it —
// and without Node mode that child boots as an Electron app, where the leading
// `--expose-internals` shifts argv and the CLI answers "--profile <name> is
// required" instead of installing. Declaring it here, after this process has
// already parsed the Chromium switches it was launched with, marks only the
// children as Node processes. Bundled-Node hosts (Windows, Linux) skip it.
if (process.versions.electron !== undefined) {
  process.env.ELECTRON_RUN_AS_NODE = '1'
}

const [dshEntryPath, ...dshArguments] = process.argv.slice(2)

function report(label, value) {
  process.stderr.write(`[harness-node] ${label}: ${value}\n`)
}

// Send loader-owned identity before the human-readable error. Do not serialize
// arbitrary Error properties, plugin config, or the entire context/fiber graph.
function reportPluginFailures(error) {
  const failures = []
  const visited = new Set()
  function visit(value) {
    if (!value || typeof value !== 'object' || visited.has(value)) return false
    visited.add(value)
    let nested = visit(value.cause)
    if (value instanceof AggregateError) {
      for (const child of value.errors) nested = visit(child) || nested
    }
    const failure = value.dshPluginFailure
    if (!nested && failure && typeof failure === 'object') {
      const { stage, entryId, packageName, owner, chain, message } = failure
      failures.push({ stage, entryId, packageName, owner, chain, message })
      return true
    }
    return nested
  }
  visit(error)
  if (failures.length) report('plugin failures', JSON.stringify({ version: 1, failures }))
  return failures.length > 0
}

// The entry runs as this process's real main module (see below), so a boot
// failure surfaces here as an uncaught exception or unhandled rejection rather
// than as a rejected import. Send the loader-owned identity first; when nothing
// owns the failure keep the plain label. Either way the process must fail — an
// uncaught exception cannot exit 0 merely because a handler is installed.
function surfaceFailure(label, error) {
  const owned = reportPluginFailures(error)
  report(owned ? 'DSH entry failed' : label, error?.stack ?? error)
  process.exitCode = 1
}

process.on('uncaughtException', (error) => surfaceFailure('uncaught exception', error))
process.on('unhandledRejection', (error) => surfaceFailure('unhandled rejection', error))

process.stdout.write(
  `[harness-node] runtime node=${process.version} platform=${process.platform} arch=${process.arch}\n`
)
process.stdout.write(`[harness-node] execPath=${process.execPath}\n`)
process.stdout.write(`[harness-node] cwd=${process.cwd()}\n`)
process.stdout.write(`[harness-node] DSH_HOME=${process.env.DSH_HOME ?? ''}\n`)

// Harness and the plugins running inside it spawn their own child processes
// (pwsh, git, ripgrep, …) without windowsHide — that flag on the Harness
// process itself only hides Harness's own console, not what it goes on to
// launch. Each of those visible console windows steals foreground focus on
// Windows. Patching child_process here, before dshEntryPath loads, catches
// every spawn made anywhere in this process tree — Harness internals and
// third-party plugins alike — without needing an upstream fix in each of
// them. A caller that explicitly sets windowsHide keeps its own choice.
if (process.platform === 'win32') {
  // The Harness is spawned console-less (detached + windowsHide), so child
  // console apps flash their own window unless the Harness owns a hidden
  // console for them to inherit (issue #233).
  const { createHiddenConsole } = await import('./windows-hidden-console.mjs')
  createHiddenConsole()

  enforceWindowsChildProcessHide(childProcess, syncBuiltinESMExports)

  process.stdout.write('[harness-node] windowsHide enforcement enabled for child processes\n')
}

if (!dshEntryPath) {
  report('startup error', 'missing DSH entry path')
  process.exitCode = 1
} else {
  process.stdout.write(`[harness-node] loading=${dshEntryPath}\n`)
  process.argv = [process.execPath, dshEntryPath, ...dshArguments]
  try {
<<<<<<< HEAD
    // The entry must be this process's main module, not a module this file
    // imported. Harness entries gate their own dispatch behind
    // `import.meta.main` — `@deepseek-ai/dsh/lib/bin.js` does
    // `if (import.meta.main) await runCli()`, and
    // `dsh-subprocess-local/lib/runner.js` guards its body the same way — but
    // Node reports `main` as false for any module reached through `import()`.
    // Loading the entry that way therefore boots nothing at all: the CLI runs
    // no command, the plugin tree is never composed, and the Harness exits 0
    // with no server, no plugin tree, and no error for the desktop to surface.
    // Node's own entry runner is the path `node <entry>` takes, so the entry
    // gets real main-module status while this file keeps preloading first.
    const { runMain } = await import('node:module')
    await runMain()
=======
    // Harness 0.1.5 gates its CLI behind `if (import.meta.main)` and exports
    // `runCli`. This file imports the entry rather than being it, so that guard
    // is false here and a plain import would load the module, run nothing, and
    // let the process exit 0 with no diagnostics. Call the export when the
    // entry offers one; older builds still self-execute on import.
    const entry = await import(pathToFileURL(dshEntryPath).href)
>>>>>>> upstream/v0.9.0
    process.stdout.write('[harness-node] DSH entry loaded\n')
    if (typeof entry.runCli === 'function') {
      process.stdout.write('[harness-node] invoking DSH runCli()\n')
      await entry.runCli()
    }
  } catch (error) {
    surfaceFailure('DSH entry failed', error)
  }
}
