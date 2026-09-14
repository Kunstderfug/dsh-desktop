/**
 * [multitask] issue #13 — documentation + spec closeout contracts.
 *
 * Configured composition at the frozen public seam selected by
 * `multitask_docs_gate`: repository documentation closeout reading
 * `docs/multitask.md`, `README.md`, the research spec, spike-note links,
 * and the shipped `dsh-multitask` default constants. These regressions
 * observe the new-user path and matching defaults — not a README-only
 * mention or a suite that never opens the guide.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_WRITERS } from '../packages/dsh-multitask/guardrails.js'
import { DEFAULT_MAX_CONSECUTIVE_WAKES } from '../packages/dsh-multitask/round-driver.js'

const GUIDE = 'docs/multitask.md'
const README = 'README.md'
const SPEC = 'docs/superpowers/specs/2026-09-13-multitask-orchestrator-mode-research.md'
const SPIKE_RUNTIME = 'docs/superpowers/specs/2026-09-13-multitask-spike-runtime.md'
const SPIKE_CLAIMS = 'docs/superpowers/specs/2026-09-13-multitask-spike-claims.md'

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

function sectionAfter(content: string, heading: string): string {
  const start = content.indexOf(heading)
  expect(start, `missing heading ${heading}`).toBeGreaterThan(-1)
  const rest = content.slice(start + heading.length)
  const next = rest.search(/\n## /)
  return next === -1 ? rest : rest.slice(0, next)
}

describe('multitask docs contracts', () => {
  it('ships the frozen writer cap and shared driver bound', () => {
    expect(DEFAULT_MAX_WRITERS).toBe(2)
    expect(DEFAULT_MAX_CONSECUTIVE_WAKES).toBe(3)
  })

  it('lets a new user run a multitask flow from docs/multitask.md alone', () => {
    expect(existsSync(GUIDE)).toBe(true)
    const guide = read(GUIDE)

    expect(guide).toMatch(/\/multitask/)
    expect(guide).toMatch(/running task|current (?:task|turn|work)|does not interrupt|without interrupting/i)
    expect(guide).toMatch(/claim/i)
    expect(guide).toMatch(/multitask\.maxWriters/)
    expect(guide).toContain(String(DEFAULT_MAX_WRITERS))
    expect(guide).toMatch(/driver bound|maxConsecutiveWakes|DEFAULT_MAX_CONSECUTIVE_WAKES/)
    expect(guide).toContain(String(DEFAULT_MAX_CONSECUTIVE_WAKES))
    expect(guide).toMatch(/bash/i)
    expect(guide).toMatch(/tier-3|tier 3/i)
  })

  it('documents shipped config keys against the plugin defaults', () => {
    const guide = read(GUIDE)
    const writers = guide.match(/multitask\.maxWriters[^\n]*?(\d+)/)
    expect(writers?.[1], 'docs/multitask.md must name multitask.maxWriters with its shipped default').toBe(
      String(DEFAULT_MAX_WRITERS)
    )

    const bound = guide.match(
      /(?:driver bound|maxConsecutiveWakes|DEFAULT_MAX_CONSECUTIVE_WAKES)[^\n]*?(\d+)/i
    )
    expect(bound?.[1], 'docs/multitask.md must name the shared driver bound with its shipped default').toBe(
      String(DEFAULT_MAX_CONSECUTIVE_WAKES)
    )
  })

  it('adds a What DSH Desktop adds bullet that links to the guide', () => {
    const readme = read(README)
    const adds = sectionAfter(readme, '## What DSH Desktop adds')
    expect(adds).toMatch(/multitask/i)
    expect(adds).toMatch(/\]\(docs\/multitask\.md\)/)
  })

  it('gives README a section link to the multitask guide', () => {
    const readme = read(README)
    expect(readme).toMatch(/^## .+/m)
    expect(readme).toMatch(/\]\(docs\/multitask\.md\)/)
    expect(readme).toMatch(/^## /m)
    const headings = [...readme.matchAll(/^## .+$/gm)].map((match) => match[0])
    expect(headings.some((heading) => /multitask/i.test(heading) || readme.includes('](docs/multitask.md)'))).toBe(true)
  })

  it('closes the research spec as implemented with landed commits and spike notes', () => {
    const spec = read(SPEC)
    expect(spec).not.toMatch(/Status:\s*research draft/i)
    expect(spec).toMatch(/Status:\s*implemented/i)
    expect(spec).toMatch(/\b[0-9a-f]{7,40}\b/)
    expect(spec).toMatch(/#(?:3|4|5|6|7|8|9|10|11|12)\b/)

    expect(existsSync(SPIKE_RUNTIME)).toBe(true)
    expect(existsSync(SPIKE_CLAIMS)).toBe(true)
    expect(spec).toMatch(/2026-09-13-multitask-spike-runtime\.md/)
    expect(spec).toMatch(/2026-09-13-multitask-spike-claims\.md/)
  })

  it('keeps relative Markdown links in the closeout set resolvable', () => {
    for (const path of [GUIDE, README, SPEC]) {
      const content = read(path)
      for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1]
        if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue
        const withoutAnchor = target.split('#', 1)[0]
        if (!withoutAnchor) continue
        expect(
          existsSync(resolve(dirname(path), decodeURIComponent(withoutAnchor))),
          `${path} links to missing ${target}`
        ).toBe(true)
      }
    }
  })
})
