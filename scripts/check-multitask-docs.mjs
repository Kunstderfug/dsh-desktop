#!/usr/bin/env node
// Composed documentation closeout check for [multitask] (issue #13).
//
// Reads the production documentation seam selected by `multitask_docs_gate`:
// `docs/multitask.md`, `README.md`, the research spec, spike-note links, and
// the shipped `dsh-multitask` default constants (`DEFAULT_MAX_WRITERS` and
// `DEFAULT_MAX_CONSECUTIVE_WAKES`). Resolves relative Markdown links in that
// closeout set. A README-only mention or a spec-status edit without matching
// defaults is insufficient.
//
// Exit 0 only when every observation succeeded.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

const projectRoot = join(import.meta.dirname, '..')
const GUIDE = join(projectRoot, 'docs/multitask.md')
const README = join(projectRoot, 'README.md')
const SPEC = join(
  projectRoot,
  'docs/superpowers/specs/2026-09-13-multitask-orchestrator-mode-research.md'
)
const SPIKE_RUNTIME = join(
  projectRoot,
  'docs/superpowers/specs/2026-09-13-multitask-spike-runtime.md'
)
const SPIKE_CLAIMS = join(
  projectRoot,
  'docs/superpowers/specs/2026-09-13-multitask-spike-claims.md'
)
const GUARDRAILS = join(projectRoot, 'packages/dsh-multitask/guardrails.js')
const ROUND_DRIVER = join(projectRoot, 'packages/dsh-multitask/round-driver.js')

class CheckFailure extends Error {}

function fail(message) {
  throw new CheckFailure(message)
}

function log(message) {
  process.stdout.write(`${message}\n`)
}

function read(path) {
  if (!existsSync(path)) fail(`missing ${path}`)
  return readFileSync(path, 'utf8')
}

function shippedDefault(source, name) {
  const match = source.match(new RegExp(`export const ${name} = ([0-9]+)`))
  if (match == null) fail(`could not read shipped ${name}`)
  return Number(match[1])
}

function requireMatch(content, pattern, label) {
  if (!pattern.test(content)) fail(`missing required topic: ${label}`)
}

function resolveLinks(path, content) {
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1]
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue
    const withoutAnchor = target.split('#', 1)[0]
    if (!withoutAnchor) continue
    const resolved = resolve(dirname(path), decodeURIComponent(withoutAnchor))
    if (!existsSync(resolved)) fail(`${path} links to missing ${target}`)
  }
}

function sectionAfter(content, heading) {
  const start = content.indexOf(heading)
  if (start < 0) fail(`missing heading ${heading}`)
  const rest = content.slice(start + heading.length)
  const next = rest.search(/\n## /)
  return next === -1 ? rest : rest.slice(0, next)
}

function main() {
  const writers = shippedDefault(read(GUARDRAILS), 'DEFAULT_MAX_WRITERS')
  const wakes = shippedDefault(read(ROUND_DRIVER), 'DEFAULT_MAX_CONSECUTIVE_WAKES')
  if (writers !== 2) fail(`DEFAULT_MAX_WRITERS is ${writers}, expected 2`)
  if (wakes !== 3) fail(`DEFAULT_MAX_CONSECUTIVE_WAKES is ${wakes}, expected 3`)
  log(`shipped defaults: multitask.maxWriters=${writers}, shared driver bound=${wakes}`)

  const guide = read(GUIDE)
  requireMatch(guide, /\/multitask/, 'enter /multitask')
  requireMatch(
    guide,
    /running task|current (?:task|turn|work)|does not interrupt|without interrupting/i,
    'what happens to the running task'
  )
  requireMatch(guide, /claim/i, 'claim system')
  requireMatch(guide, /multitask\.maxWriters/, 'multitask.maxWriters')
  requireMatch(guide, /driver bound|maxConsecutiveWakes|DEFAULT_MAX_CONSECUTIVE_WAKES/i, 'shared driver bound')
  requireMatch(guide, /bash/i, 'bash-write limitation')
  requireMatch(guide, /tier-3|tier 3/i, 'tier-3 limitation')

  const writersDoc = guide.match(/multitask\.maxWriters[^\n]*?(\d+)/)
  if (writersDoc?.[1] !== String(writers)) {
    fail(`docs/multitask.md documents maxWriters=${writersDoc?.[1] ?? 'missing'}, expected ${writers}`)
  }
  const boundDoc = guide.match(
    /(?:driver bound|maxConsecutiveWakes|DEFAULT_MAX_CONSECUTIVE_WAKES)[^\n]*?(\d+)/i
  )
  if (boundDoc?.[1] !== String(wakes)) {
    fail(`docs/multitask.md documents driver bound=${boundDoc?.[1] ?? 'missing'}, expected ${wakes}`)
  }
  log('docs/multitask.md covers the new-user flow and matching defaults')

  const readme = read(README)
  const adds = sectionAfter(readme, '## What DSH Desktop adds')
  if (!/multitask/i.test(adds)) fail('README "What DSH Desktop adds" has no multitask bullet')
  if (!/\]\(docs\/multitask\.md\)/.test(adds) && !/\]\(docs\/multitask\.md\)/.test(readme)) {
    fail('README does not link to docs/multitask.md')
  }
  if (!/\]\(docs\/multitask\.md\)/.test(readme)) fail('README is missing a section link to docs/multitask.md')
  log('README bullet and section link point at docs/multitask.md')

  const spec = read(SPEC)
  if (/Status:\s*research draft/i.test(spec)) fail('research spec is still marked draft')
  if (!/Status:\s*implemented/i.test(spec)) fail('research spec status is not implemented')
  if (!/\b[0-9a-f]{7,40}\b/.test(spec)) fail('research spec does not cite landed commit references')
  if (!existsSync(SPIKE_RUNTIME)) fail('spike runtime notes are missing')
  if (!existsSync(SPIKE_CLAIMS)) fail('spike claims notes are missing')
  if (!/2026-09-13-multitask-spike-runtime\.md/.test(spec)) {
    fail('research spec does not link the #1 runtime spike notes')
  }
  if (!/2026-09-13-multitask-spike-claims\.md/.test(spec)) {
    fail('research spec does not link the #2 claims spike notes')
  }
  log('research spec is implemented and cites commits plus spike notes')

  for (const [path, content] of [
    [GUIDE, guide],
    [README, readme],
    [SPEC, spec]
  ]) {
    resolveLinks(path, content)
  }
  log('relative Markdown links in the closeout set resolve')

  log('check-multitask-docs: all observations succeeded')
}

try {
  main()
} catch (error) {
  process.stderr.write(`check-multitask-docs: FAIL\n${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
