import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')

interface Registration {
  config: {
    name: string
    id?: string
    order?: number
    locale?: string
    inject?: () => Record<string, unknown>
  }
  component: (props: Record<string, unknown>) => unknown
}

describe('DSH Desktop client slot occupants', () => {
  it('registers one occupant per brand seat and keeps the official name mark-free', async () => {
    const source = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-client-ui', 'client.js'),
      'utf8'
    )
    let definition: {
      factory: (require: (id: string) => unknown) => {
        apply: (ctx: unknown) => void
        inject: string[]
      }
    } | undefined
    const appended: Array<{ id?: string; textContent?: string }> = []
    const removeStyle = vi.fn()
    const disposers: Array<() => void> = []
    const dictionaries = new Map<string, { zh: Record<string, string>; en: Record<string, string> }>()
    const document = {
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => ({ id: '', dataset: {}, textContent: '', remove: removeStyle })),
      head: { appendChild: (node: { id?: string; textContent?: string }) => appended.push(node) }
    }
    vm.runInNewContext(source, {
      document,
      navigator: { language: 'en-US' },
      window: {
        __ModuleLoader__: {
          load: (value: typeof definition) => {
            definition = value
          }
        }
      }
    })

    expect(definition).toBeDefined()
    const createElement = (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ): { type: unknown; props: Record<string, unknown> } => ({
      type,
      props: { ...props, children }
    })
    const BrandWordmark = vi.fn()
    const FishLogo = vi.fn()
    const plugin = definition!.factory((id) => {
      if (id === 'react') {
        return {
          createElement,
          useEffect: (effect: () => void | (() => void)) => effect(),
          useState: (initial: unknown) => [initial, vi.fn()]
        }
      }
      if (id === '@deepseek-ai/dsh-client-ui-primitives') {
        return { BrandWordmark, FishLogo }
      }
      throw new Error(`Unexpected client dependency: ${id}`)
    })

    const registrations: Registration[] = []
    const slots = {
      inject: (_name: string, callback: () => unknown): unknown => {
        const result = callback()
        if (result && typeof result === 'object' && Symbol.iterator in result) {
          for (const _entry of result as Iterable<unknown>) void _entry
        }
        return result
      },
      register: (
        config: Registration['config'],
        component: Registration['component']
      ): (() => void) => {
        registrations.push({ config, component })
        return () => undefined
      }
    }
    // Harness 0.1.7 client scopes keep cordis' deferred `inject`; the fork's
    // ⌘N/⌘O accelerator block relies on it, so the stub resolves uiWorkspace
    // eagerly and the block no-ops without the preload bridge.
    plugin.apply({
      slots,
      locale: {
        register: (
          name: string,
          value: { zh: Record<string, string>; en: Record<string, string> }
        ) => {
          dictionaries.set(name, value)
          return () => undefined
        }
      },
      inject: (services: string[], callback: (scope: Record<string, unknown>) => void) => {
        callback({ uiWorkspace: { startSession: vi.fn() } })
      },
      effect: (setup: () => (() => void) | undefined) => {
        const dispose = setup()
        if (typeof dispose === 'function') disposers.push(dispose)
      }
    })

    expect(plugin.inject).toEqual(['slots', 'locale', 'remote.session', 'sessions', 'uiWorkspace'])
    expect(registrations.map(({ config }) => config.name)).toEqual([
      'sidebar.brand.mark',
      'sidebar.brand.name',
      'conversation.hero.brand.mark',
      'sidebar.right.tab.document.unpreviewable',
      'sidebar.workspaces.session.menu.item',
      'sidebar.workspaces.session.menu.item',
      'sidebar.workspaces.session.menu.item',
      'conversation.input.left'
    ])
    // Desktop toolbar styles have an owned lifetime; branding stays in currentColor.
    expect(appended).toHaveLength(2)
    expect(appended[0]?.textContent).toContain(".dgb-trigger")
    expect(appended[1]?.textContent).toContain("[data-dsh-preset-search]")
    for (const dispose of disposers) dispose()
    expect(removeStyle).toHaveBeenCalledTimes(2)

    const gitBranch = registrations.find(
      ({ config }) => config.name === 'conversation.input.left'
    )!
    expect(gitBranch.config.id).toBe('desktop-git-branch')
    expect(gitBranch.config.order).toBe(10)
    expect(gitBranch.config.locale).toBe('desktop-git-branch')

    // Every user-visible string ships in both dictionaries; a key missing
    // from one locale is an unfinished UI, not a fallback.
    const gitDictionary = dictionaries.get('desktop-git-branch')
    if (!gitDictionary) throw new Error('Expected desktop-git-branch dictionaries')
    expect(Object.keys(gitDictionary.zh).sort()).toEqual(Object.keys(gitDictionary.en).sort())
    for (const value of Object.values(gitDictionary.zh)) expect(value).not.toBe('')
    for (const value of Object.values(gitDictionary.en)) expect(value).not.toBe('')

    const sidebarName = registrations.find(
      ({ config }) => config.name === 'sidebar.brand.name'
    )!.component({}) as { type: unknown; props: Record<string, unknown> }
    expect(sidebarName.type).toBe(BrandWordmark)
    expect(sidebarName.props.includeMark).toBe(false)

    const sidebarMark = registrations.find(
      ({ config }) => config.name === 'sidebar.brand.mark'
    )!.component({ size: 24 }) as { type: unknown; props: Record<string, unknown> }
    expect(sidebarMark.type).toBe('svg')
    expect(sidebarMark.props.height).toBe(17)
    const [markPath] = sidebarMark.props.children as Array<{ type: unknown; props: Record<string, unknown> }>
    if (!markPath) throw new Error('Expected the sidebar brand SVG path')
    expect(markPath.type).toBe('path')
    expect(markPath.props.fill).toBe('currentColor')

    const heroMark = registrations.find(
      ({ config }) => config.name === 'conversation.hero.brand.mark'
    )!.component({ size: 48 }) as { type: unknown; props: Record<string, unknown> }
    expect(heroMark.type).toBe(FishLogo)
    expect(heroMark.props.size).toBe(48)
  })
})
