import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { patchPath, projectRoot } from './patch-path'

const chatClient = path.join(
  projectRoot,
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-chat',
  'lib',
  'client.js'
)

/** Extract one CSS-module rule out of the served bundle. */
function rule(css: string, selector: string): string {
  const match = css.match(new RegExp(`\\${selector}\\{([^}]*)\\}`, 'u'))
  const body = match?.[1]
  if (body === undefined) throw new Error(`the bundle carries no ${selector} rule`)
  return body
}

/** The salt comes from the upstream build; read it instead of pinning it. */
function saltOf(client: string): string {
  const match = client.match(/\.([A-Za-z0-9_-]+)_anchor\{min-width:0/u)
  if (match?.[1] === undefined) throw new Error('the bundle carries no StatsPills module')
  return match[1]
}

/**
 * The composer's statistics row reports turns, steps, phase durations,
 * throughput, cache hits, and token counts. Desktop widened it once because the
 * line was capped at the chat content width (64% of the conversation column)
 * and ellipsized into a tooltip on a wide window.
 *
 * 0.2.1 redesigned that line into the composer-dock pill row (`StatsPills`):
 * the capped root is gone, each pill sizes to its own label, and the row lives
 * in the composer dock instead of the chat content column. The old selector
 * cannot restore the cap, so the regression to guard is that the pills stay
 * dock-mounted and self-sizing rather than pinned to a width.
 */
describe('DSH Desktop composer statistics pills', () => {
  it('mounts the statistics in the composer dock instead of the capped content line', async () => {
    const client = await readFile(chatClient, 'utf8')

    for (const id of ['activity', 'usage']) {
      expect(client).toContain(`id: "${id}"`)
    }
    expect(client).toContain('name: "conversation.composer.dock"')
    // The 0.2.0 StatsLine root that carried the 64%-width cap is not emitted
    // any more: the pill row replaced it.
    expect(client).not.toMatch(/\.[A-Za-z0-9_-]+_root\{[^}]*--dsh-chat-content-width/u)
  })

  it('keeps each pill self-sizing with an ellipsized label', async () => {
    const client = await readFile(chatClient, 'utf8')
    const salt = saltOf(client)
    const anchor = rule(client, `.${salt}_anchor`)
    const pill = rule(client, `.${salt}_pill`)
    const label = rule(client, `.${salt}_label`)

    // No fixed or content-column width: the pill takes its content width and
    // is allowed to shrink inside the dock.
    expect(anchor).toContain('min-width:0')
    expect(anchor).toContain('display:inline-flex')
    expect(anchor).not.toContain('--dsh-chat-content-width')
    expect(pill).toContain('max-width:100%')
    expect(pill).toContain('display:inline-flex')
    // The label carries the ellipsis, so a long cached-token reading shortens
    // to "…" instead of stretching the dock.
    expect(label).toContain('text-overflow:ellipsis')
    expect(label).toContain('min-width:0')
  })

  it('carries the desktop price row in the reproducible dependency patch', async () => {
    const patch = await readFile(patchPath('@deepseek-ai/dsh-client-ui-chat'), 'utf8')

    expect(patch).toContain('stats.dialog.price')
    // The provider-failure copy this package already patches stays intact.
    expect(patch).toContain('"message.failure.quota"')
    expect(patch).toContain('"message.failure.forbidden"')
  })
})
