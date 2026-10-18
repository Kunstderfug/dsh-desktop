import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { patchPath } from './patch-path'

const require = createRequire(import.meta.url)

const MARKER_BEGIN = '/* @dsh-desktop:begin compose-send-tooltip */'
const MARKER_END = '/* @dsh-desktop:end compose-send-tooltip */'

interface TooltipInput {
  /** The button's own action label, already localized. */
  label: string
  /** Keycaps for the button's own action, when it has one. */
  keys: readonly string[] | undefined
  /** The action the primary-modifier Enter chord performs, or null when it has none. */
  complementaryLabel: string | null
  /** Platform keycaps for that chord, resolved from `shortcuts.describeBinding`. */
  complementaryKeys: readonly string[]
}

interface TooltipContent {
  label: string
  shortcutKeys: readonly string[] | undefined
}

/**
 * Composer Send tooltip: the button runs the preferred busy-Enter behaviour,
 * while Cmd/Ctrl-Enter always runs the complement. Upstream labels the button
 * with its own action and only puts `Esc Esc` on the Stop variant, so the
 * accelerated chord was undiscoverable. The Desktop patch names the complement
 * right before the chord keycaps, because attaching those keycaps to the
 * button's own label would be false whenever the preference is Queue.
 *
 * The composition is read from the installed bundle rather than the patch text
 * so the shipped artifact is what gets exercised; the markers this repository
 * adds are the only locator, and the cases below pin the mapping from state to
 * tooltip content.
 */
async function loadComposition(): Promise<{
  bundle: string
  compose: (input: TooltipInput) => TooltipContent
}> {
  const entry = require
    .resolve('@deepseek-ai/dsh-client-ui-conversation/package.json')
    .replace(/package\.json$/u, 'lib/client.js')
  const bundle = await readFile(entry, 'utf8')
  const start = bundle.indexOf(MARKER_BEGIN)
  const end = bundle.indexOf(MARKER_END)
  if (start < 0 || end < start) {
    throw new Error('compose-send-tooltip markers are missing from the installed conversation bundle')
  }
  const source = bundle.slice(start + MARKER_BEGIN.length, end)
  const compose: (input: TooltipInput) => TooltipContent = runInNewContext(
    `(() => {${source}\nreturn composeSendTooltip })()`,
    {}
  )
  return { bundle, compose }
}

describe('composer Send tooltip', () => {
  it('names the complementary submit action before its keycaps', async () => {
    const { compose } = await loadComposition()
    const macKeys = ['⌘', 'Enter']

    expect(compose({
      label: 'Queue message',
      keys: void 0,
      complementaryLabel: 'Steer message',
      complementaryKeys: macKeys
    })).toEqual({
      label: 'Queue message · Steer message',
      shortcutKeys: macKeys
    })

    expect(compose({
      label: 'Steer message',
      keys: void 0,
      complementaryLabel: 'Queue message',
      complementaryKeys: macKeys
    })).toEqual({
      label: 'Steer message · Queue message',
      shortcutKeys: macKeys
    })
  })

  it('leaves the Stop and plain-Send tooltips without a chord', async () => {
    const { compose } = await loadComposition()
    const stopKeys = ['Esc', 'Esc']

    /* Stop replaces the primary action, so its own keys win over the chord. */
    expect(compose({
      label: 'Stop generating',
      keys: stopKeys,
      complementaryLabel: null,
      complementaryKeys: ['⌘', 'Enter']
    })).toEqual({
      label: 'Stop generating',
      shortcutKeys: stopKeys
    })

    /* An idle or non-steerable composer has no complementary action to name. */
    expect(compose({
      label: 'Send message',
      keys: void 0,
      complementaryLabel: null,
      complementaryKeys: ['⌘', 'Enter']
    })).toEqual({
      label: 'Send message',
      shortcutKeys: void 0
    })

    /* Keycaps resolve asynchronously; never name a chord before it can be shown. */
    expect(compose({
      label: 'Queue message',
      keys: void 0,
      complementaryLabel: 'Steer message',
      complementaryKeys: []
    })).toEqual({
      label: 'Queue message',
      shortcutKeys: void 0
    })
  })

  it('routes the Send tooltip through the composition with platform keycaps', async () => {
    const { bundle } = await loadComposition()

    expect(bundle).toContain('const sendTooltip = composeSendTooltip({')
    expect(bundle).toContain('label: sendTooltip.label,')
    expect(bundle).toContain('shortcutKeys: sendTooltip.shortcutKeys,')
    expect(bundle).not.toContain('shortcutKeys: primaryStops ? stopKeys : void 0,')

    /* The keys come from the same platform formatter the shortcut sheet uses. */
    expect(bundle).toContain('const complementaryShortcut = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)([]);')
    expect(bundle).toContain('complementaryShortcut.set(scope.shortcuts.describeBinding({')

    /* Both resident-composer registrations (no session / live session) feed the hook. */
    expect(bundle.match(/stopShortcut,\n\t{7}complementaryShortcut,/gu)).toHaveLength(2)
  })

  it('records the same wiring in the replayable patch', async () => {
    const patch = await readFile(patchPath('@deepseek-ai/dsh-client-ui-conversation'), 'utf8')

    expect(patch).toContain(MARKER_BEGIN)
    expect(patch).toContain(MARKER_END)
    expect(patch).toContain('function composeSendTooltip({ label, keys, complementaryLabel, complementaryKeys })')
    expect(patch).toContain('const sendTooltip = composeSendTooltip({')
    expect(patch).toContain('complementaryKeys.length === 0')
  })
})
