import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { patchPath, projectRoot } from './patch-path'

const workspacePath = path.join(projectRoot, 'node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js')
const desktopPath = path.join(projectRoot, 'packages/dsh-desktop-client-ui/client.js')

describe('workspace session unread markers', () => {
  it('registers the complete browser bundle without a syntax error', async () => {
    const source = await readFile(workspacePath, 'utf8')
    const registrations: unknown[] = []
    vm.runInNewContext(source, {
      window: { __ModuleLoader__: { load: (module: unknown) => registrations.push(module) } }
    })
    expect(registrations).toHaveLength(1)
  })

  it('keeps draft badges, unread title styling and rename handlers on the row', async () => {
    const source = await readFile(workspacePath, 'utf8')
    const start = source.indexOf('function SessionNodeItem(')
    const end = source.indexOf('\n\t\t//#endregion', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    type Element = { type: string; props: Record<string, unknown> }
    const jsx = (type: string, props: Record<string, unknown>): Element => ({ type, props })
    const render = vm.runInNewContext(`(${source.slice(start, end)})`, {
      react: {
        useState: () => [false, () => {}],
        useMemo: (factory: () => unknown) => factory(),
        useRef: () => ({ current: null }),
        useEffect: () => {}
      },
      react_jsx_runtime: { jsx, jsxs: jsx, Fragment: 'fragment' },
      _deepseek_ai_dsh_client_ui_primitives: { HoverCard: 'hover-card', Menu: 'menu', StateDot: 'state-dot' },
      Rows_module_css_default: { title: 'title', draftBadge: 'draft-badge' },
      clsx: (...names: unknown[]) => names.filter(Boolean).join(' '),
      displayTitle: (node: { title: string }) => node.title,
      sessionStatuses: () => [{ state: 'idle' }],
      useTitleMarquee: () => ({}),
      timeLabel: () => 'now',
      SessionHoverContent: 'hover-content'
    }) as (props: Record<string, unknown>) => Element
    const rename = vi.fn()
    const props = {
      currentId: 'session-1', now: 0, onOpen: vi.fn(), onRenameRequest: rename,
      renderSlot: () => null, t: (key: string) => key
    }
    const childrenOf = (element: Element) => (element.props.anchor as Element).props.children as Element[]
    const regular = childrenOf(render({ ...props, unread: true, node: { id: 'session-1', title: 'Session', blank: false } }))
    const title = regular.find((element) => element && element.props.className === 'title')
    expect(title?.props.style).toEqual({ fontWeight: 600 })
    const stopPropagation = vi.fn()
    const onDoubleClick = title?.props.onDoubleClick as (event: { stopPropagation: () => void }) => void
    onDoubleClick({ stopPropagation })
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(rename).toHaveBeenCalledWith('session-1', 'Session')

    const draft = childrenOf(render({ ...props, node: { id: 'draft-1', title: 'Draft', blank: true, draft: 'Unsent prompt' } }))
    expect(draft.find((element) => element && element.props.className === 'draft-badge')?.props.children).toBe('session.draft')
    const draftTitle = draft.find((element) => element && element.props.className === 'title')
    expect(draftTitle?.props.style).toBeUndefined()
    expect(draftTitle?.props.onDoubleClick).toBeUndefined()
  })

  it('uses the existing persisted view key and upgrades older snapshots on write', async () => {
    const source = await readFile(workspacePath, 'utf8')
    const start = source.indexOf('function createWorkspaceViewStore() {')
    const end = source.indexOf('\n\t\t//#endregion', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const spec = vm.runInNewContext(`(() => { ${source.slice(start, end)}; return createWorkspaceViewStore() })()`, {
      _deepseek_ai_dsh_client_store: { defineStore: (value: unknown) => value }
    }) as {
      init: () => { unreadSessionIds: string[] }
      persist: string
      actions: {
        markSessionUnread: (draft: { unreadSessionIds?: string[] }, id: string) => void
        markSessionRead: (draft: { unreadSessionIds?: string[] }, id: string) => void
      }
    }
    expect(spec.persist).toBe('dsh.workspace.view.v5')
    expect(spec.init().unreadSessionIds).toEqual([])
    const olderSnapshot: { unreadSessionIds?: string[] } = {}
    spec.actions.markSessionUnread(olderSnapshot, 'session-1')
    spec.actions.markSessionUnread(olderSnapshot, 'session-1')
    expect(olderSnapshot.unreadSessionIds).toEqual(['session-1'])
    spec.actions.markSessionRead(olderSnapshot, 'session-1')
    expect(olderSnapshot.unreadSessionIds).toEqual([])
  })

  it('offers a right-click menu action in both session list modes', async () => {
    const [workspace, desktop, patch] = await Promise.all([
      readFile(workspacePath, 'utf8'),
      readFile(desktopPath, 'utf8'),
      readFile(patchPath('@deepseek-ai/dsh-client-ui-workspace'), 'utf8')
    ])
    expect(workspace).toContain('onContextMenu: (event) =>')
    // The fork's draft rows stay right-clickable: the ported workspace patch
    // delivers isDraft into this handler, so the gate admits drafts too.
    expect(workspace).toContain('if (!row.blank || isDraft) setMenuOpen(true)')
    expect(workspace).toContain('unread: unreadSessionIds.includes(node.id)')
    expect(workspace).toContain('onUnreadChange')
    expect(desktop).toContain("id: 'desktop-unread-session'")
    expect(desktop).toContain("'标为未读'")
    expect(desktop).toContain("'标为已读'")
    expect(patch).toContain('markSessionUnread')
  })

  it('renders an unread indicator and clears the marker when opening a session', async () => {
    const source = await readFile(workspacePath, 'utf8')
    expect(source).toContain('StateDot, { state: "done" }')
    expect(source).toContain('style: unread ? { fontWeight: 600 } : void 0')
    expect(source).toContain('children: t("status.unread")')
    expect(source).toContain('this.view.markSessionRead(target)')
    expect(source).toContain('this.view.markSessionRead(sessionId)')
  })
})
