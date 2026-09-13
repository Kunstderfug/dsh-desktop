import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { patchPath } from './patch-path'

/**
 * Desktop draft sessions: an unsent prompt must survive switching sessions,
 * scope teardown, and app restarts, and keep its provisional row under the
 * project folder in the sidebar until it is sent or cleared.
 *
 * Three bundles cooperate:
 * - `dsh-api-session-controller` (host) materializes the session header at
 *   create, so a never-prompted session exists on disk after a restart.
 * - `dsh-client-ui-conversation` mirrors every draft change into a wipe-proof
 *   `dsh.draft.<sessionId>` localStorage key (the Conversation store's own
 *   persistence is cleared on session-scope teardown) and restores it from
 *   there when the store rehydrates empty.
 * - `dsh-client-ui-workspace` keeps blank sessions with an unsent draft visible
 *   in their Workspace group, shows the draft preview with a Draft badge, and
 *   stops New Session from resuming a draft-carrying blank session.
 */
const readPatch = async (name: string) => readFile(patchPath(name), 'utf8')

describe('draft sessions: durable blank sessions on the host', () => {
  it('materializes the session header at create time', async () => {
    const patch = await readPatch('@deepseek-ai/dsh-api-session-controller')

    expect(patch).toContain('await this.ctx.sessions.flush(adopted.session)')
    expect(patch).toContain('durable header flush for new session')
  })
})

describe('draft sessions: wipe-proof draft mirror in the conversation bundle', () => {
  it('mirrors every draft change into a per-session localStorage key', async () => {
    const patch = await readPatch('@deepseek-ai/dsh-client-ui-conversation')

    expect(patch).toContain('const DRAFT_MIRROR_KEY = "dsh.draft"')
    expect(patch).toContain('localStorage.removeItem(draftMirrorKey)')
    expect(patch).toContain('localStorage.setItem(draftMirrorKey, next)')
  })

  it('wraps the input shell publish, so programmatic writes mirror too', async () => {
    const patch = await readPatch('@deepseek-ai/dsh-client-ui-conversation')

    expect(patch).toContain('shell.publish = () => {')
    expect(patch).toContain('if (next === mirroredDraft) return')
  })

  it('restores the draft from the mirror when the store rehydrates empty', async () => {
    const patch = await readPatch('@deepseek-ai/dsh-client-ui-conversation')

    expect(patch).toContain(
      'const restored = storedDraft !== "" ? storedDraft : readDraftMirror(session.key)'
    )
    expect(patch).toContain('function readDraftMirror(sessionId)')
  })
})

describe('draft sessions: sidebar rows under the project folder', () => {
  it('keeps blank sessions with an unsent draft visible', async () => {
    const patch = await readPatch('@deepseek-ai/dsh-client-ui-workspace')

    expect(patch).toContain('function draftPreviewOf(sessionId)')
    expect(patch).toContain(
      'return session.id === current || draftPreviewOf(session.id) !== ""'
    )
  })

  it('shows the draft preview with a Draft badge on the row', async () => {
    const patch = await readPatch('@deepseek-ai/dsh-client-ui-workspace')

    expect(patch).toContain('draft: s.blank ? draftPreviewOf(s.id) : ""')
    expect(patch).toContain('node.blank ? node.draft || t("session.new") : node.title')
    expect(patch).toContain('Rows_module_css_default.draftBadge')
    expect(patch).toContain('children: t("session.draft")')
    expect(patch).toContain('"session.draft": "草稿"')
    expect(patch).toContain('"session.draft": "Draft"')
    expect(patch).toContain(".YDXeBa_draftBadge{")
    expect(patch).toContain(".YDXeBa_draftTitle{")
  })

  it('keeps only storage-safe actions on draft rows', async () => {
    const patch = await readPatch('@deepseek-ai/dsh-client-ui-workspace')

    expect(patch).toContain('const isDraft = (row.draft ?? "") !== ""')
    expect(patch).toContain(
      'const menuItems = isDraft ? sessionMenuItems.filter((item) => item.id === "markUnread" || item.id === "markRead" || item.id === "archive") : sessionMenuItems'
    )
    expect(patch).toContain('if (!row.blank || isDraft) setMenuOpen(true)')
    expect(patch).toContain(
      '(!row.blank || isDraft) && (0, react_jsx_runtime.jsx)("span", {'
    )
  })

  it('stops New Session from resuming a draft-carrying blank session', async () => {
    const patch = await readPatch('@deepseek-ai/dsh-client-ui-workspace')

    expect(patch).toContain(
      '!archived.includes(summary.id) && draftPreviewOf(summary.id) === ""'
    )
  })

  it('declares the node and locale extensions in the package types', async () => {
    const patch = await readPatch('@deepseek-ai/dsh-client-ui-workspace')

    expect(patch).toContain('draft: string')
    expect(patch).toContain("'session.draft': string")
  })
})
