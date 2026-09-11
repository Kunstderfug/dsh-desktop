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

/**
 * The composer's statistics line reports turns, steps, phase durations,
 * throughput, cache hits, and token counts. It used to be capped at the chat
 * content width, which is 64% of the conversation column, so a normal session
 * summary was ellipsized into a tooltip on a wide window.
 */
describe('DSH Desktop composer statistics line', () => {
  // The rule name tracks upstream's CSS-module hash salt. Upstream 0.1.5-rc.2
  // renamed StatsLine.module.css to StatsPills.module.css, so the selector moved
  // from .XZbVjq_root to .bOPqQW_root; the intent asserted below is unchanged.
  it('fills the conversation column instead of the narrower chat content width', async () => {
    const client = await readFile(chatClient, 'utf8')
    const root = rule(client, '.bOPqQW_root')

    expect(root).toContain('max-width:none')
    expect(root).not.toContain('max-width:var(--dsh-chat-content-width)')
    // Still one responsive full-width block: the fix changes the cap, not the
    // box model. Upstream 0.1.5-rc.2 rebuilt this module as a flex row of pills,
    // so centring is `justify-content` and the ellipsis lives on the pill label
    // rather than on this root. The intent asserted here is only that the cap
    // changed and the box model survived.
    expect(root).toContain('width:100%')
    expect(root).toContain('box-sizing:border-box')
    expect(root).toContain('justify-content:center')
  })

  it('keeps the line aligned with the composer chrome it sits under', async () => {
    const client = await readFile(chatClient, 'utf8')
    const root = rule(client, '.bOPqQW_root')

    // The horizontal inset is what keeps the wider line from touching the
    // column edges, so it has to survive the width change.
    expect(root).toContain('padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0px')
    expect(root).toContain('justify-content:center')
    expect(root).toContain('margin:0 auto')
  })

  it('carries the width in the reproducible dependency patch', async () => {
    const patch = await readFile(patchPath('@deepseek-ai/dsh-client-ui-chat'), 'utf8')

    expect(patch).toContain('max-width:none')
    // The provider-failure copy this package already patches stays intact.
    expect(patch).toContain('"message.failure.quota"')
    expect(patch).toContain('"message.failure.forbidden"')
  })
})
