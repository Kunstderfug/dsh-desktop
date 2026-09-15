import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi, type Mock } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')

interface Registration {
  config: { name: string; id?: string; order?: number }
  component: (props: Record<string, unknown>) => unknown
}

interface AddButtonStub {
  click: () => void
  getAttribute: (name: string) => string | null
}

interface PageDocumentStub {
  getElementById: Mock
  createElement: Mock
  querySelector: Mock<() => AddButtonStub | null>
  head: { appendChild: (node: { textContent?: string }) => number }
}

type PluginFactory = (
  require: (id: string) => unknown
) => {
  apply: (ctx: unknown) => void
  inject: string[]
}

async function loadClientPlugin(): Promise<{
  plugin: PluginFactory
  appended: Array<{ textContent?: string }>
  sandboxWindow: Record<string, unknown>
  pageDocument: PageDocumentStub
}> {
  const source = await readFile(
    path.join(projectRoot, 'packages', 'dsh-desktop-client-ui', 'client.js'),
    'utf8'
  )
  let definition: {
    factory: PluginFactory
    inject: string[]
  } | undefined
  const appended: Array<{ textContent?: string }> = []
  const pageDocument: PageDocumentStub = {
    getElementById: vi.fn(() => null),
    createElement: vi.fn(() => ({ id: '', dataset: {}, textContent: '' })),
    querySelector: vi.fn((): AddButtonStub | null => null),
    head: { appendChild: (node: { textContent?: string }) => appended.push(node) }
  }
  const sandboxWindow: Record<string, unknown> = {
    __ModuleLoader__: {
      load: (value: { factory: PluginFactory; inject: string[] }) => {
        definition = value
      }
    }
  }
  vm.runInNewContext(source, {
    document: pageDocument,
    navigator: { language: 'en-US' },
    window: sandboxWindow
  })

  expect(definition).toBeDefined()
  return { plugin: definition!.factory, appended, sandboxWindow, pageDocument }
}

function clientRequire(handlers: Record<string, unknown>): (id: string) => unknown {
  const createElement = (
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): { type: unknown; props: Record<string, unknown> } => ({
    type,
    props: { ...props, children }
  })
  return (id) => {
    if (id in handlers) return handlers[id]
    if (id === 'react') {
      return {
        createElement,
        useEffect: (effect: () => void | (() => void)) => effect(),
        useState: (initial: unknown) => [initial, vi.fn()]
      }
    }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      return { BrandWordmark: vi.fn(), FishLogo: vi.fn() }
    }
    throw new Error(`Unexpected client dependency: ${id}`)
  }
}

/** Apply the plugin with only the deferred uiWorkspace service available. */
function applyWithWorkspace(
  plugin: PluginFactory,
  startSession = vi.fn()
): void {
  plugin(clientRequire({})).apply({
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (): (() => void) => () => undefined
    },
    inject: (services: string[], callback: (scope: Record<string, unknown>) => void) => {
      expect(services).toEqual(['uiWorkspace'])
      callback({ uiWorkspace: { startSession } })
    }
  })
}

/** Capture the single add-directory callback the plugin registers. */
function registerAddDirectory(sandboxWindow: Record<string, unknown>): {
  handler: () => void
  onNewSession: ReturnType<typeof vi.fn>
  onAddDirectory: ReturnType<typeof vi.fn>
} {
  let captured: (() => void) | undefined
  const onNewSession = vi.fn()
  const onAddDirectory = vi.fn((value: unknown) => {
    captured = value as () => void
  })
  sandboxWindow.dshDesktopActions = { onNewSession, onAddDirectory }
  return {
    handler: () => {
      if (typeof captured !== 'function') {
        throw new Error('Expected the plugin to register an add-directory handler')
      }
      captured()
    },
    onNewSession,
    onAddDirectory
  }
}

describe('DSH Desktop client slot occupants', () => {
  it('registers one occupant per brand seat and keeps the official name mark-free', async () => {
    const { plugin, appended } = await loadClientPlugin()
    const BrandWordmark = vi.fn()
    const FishLogo = vi.fn()

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
    plugin(clientRequire({
      '@deepseek-ai/dsh-client-ui-primitives': { BrandWordmark, FishLogo }
    })).apply({
      slots,
      inject: vi.fn()
    })

    expect(registrations.map(({ config }) => config.name)).toEqual([
      'sidebar.brand.mark',
      'sidebar.brand.name',
      'conversation.hero.brand.mark'
    ])
    // The mark is drawn in currentColor, so no theme stylesheet is injected.
    expect(appended).toHaveLength(0)

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

describe('DSH Desktop new-session accelerator', () => {
  it('injects uiWorkspace deferred and forwards desktop requests to startSession', async () => {
    const { plugin, sandboxWindow } = await loadClientPlugin()
    const startSession = vi.fn()
    let handler: (() => void) | undefined
    const registered: string[] = []
    const onNewSession = vi.fn((value: unknown) => {
      handler = value as () => void
    })
    sandboxWindow.dshDesktopActions = { onNewSession }

    plugin(clientRequire({})).apply({
      slots: {
        inject: (_name: string, callback: () => unknown) => {
          const result = callback()
          if (result && typeof result === 'object' && Symbol.iterator in result) {
            for (const _entry of result as Iterable<unknown>) void _entry
          }
          return result
        },
        register: (config: { name: string }): (() => void) => {
          registered.push(config.name)
          return () => undefined
        }
      },
      inject: (services: string[], callback: (scope: Record<string, unknown>) => void) => {
        expect(services).toEqual(['uiWorkspace'])
        callback({ uiWorkspace: { startSession } })
      }
    })

    // The bridge lives in the page world; the plugin must have subscribed once.
    expect(onNewSession).toHaveBeenCalledTimes(1)
    expect(typeof handler).toBe('function')
    handler?.()
    handler?.()
    expect(startSession).toHaveBeenCalledTimes(2)

    // Brand seats still registered alongside the accelerator subscription.
    expect(registered).toEqual([
      'sidebar.brand.mark',
      'sidebar.brand.name',
      'conversation.hero.brand.mark'
    ])
  })

  it('stays inert without the desktop bridge (plain-browser page world)', async () => {
    const { plugin, sandboxWindow } = await loadClientPlugin()
    const startSession = vi.fn()

    plugin(clientRequire({})).apply({
      slots: {
        inject: (_name: string, callback: () => unknown) => callback(),
        register: (): (() => void) => () => undefined
      },
      inject: (services: string[], callback: (scope: Record<string, unknown>) => void) => {
        expect(services).toEqual(['uiWorkspace'])
        callback({ uiWorkspace: { startSession } })
      }
    })

    // No bridge registered, so nothing may reach startSession.
    expect(startSession).not.toHaveBeenCalled()
    expect('dshDesktopActions' in sandboxWindow).toBe(false)
  })

  it('keeps the top-level inject declaration to slots only', async () => {
    const { plugin } = await loadClientPlugin()
    // Deferred uiWorkspace access is deliberate: the brand seats must not
    // wait on (or hard-require) the workspace service.
    expect(plugin(clientRequire({})).inject).toEqual(['slots'])
  })
})

describe('DSH Desktop add-directory accelerator', () => {
  it('activates the patched sidebar add button once per desktop request', async () => {
    const { plugin, sandboxWindow, pageDocument } = await loadClientPlugin()
    const addButton: AddButtonStub = {
      click: vi.fn(),
      getAttribute: vi.fn(() => 'false')
    }
    pageDocument.querySelector.mockReturnValue(addButton)
    const { handler, onNewSession, onAddDirectory } = registerAddDirectory(sandboxWindow)

    applyWithWorkspace(plugin)

    // Both bridge slots take exactly one subscription, and no DOM work happens
    // until the shell actually fires the accelerator.
    expect(onNewSession).toHaveBeenCalledTimes(1)
    expect(onAddDirectory).toHaveBeenCalledTimes(1)
    expect(pageDocument.querySelector).not.toHaveBeenCalled()

    handler()
    handler()
    expect(pageDocument.querySelector).toHaveBeenCalledWith('[data-dsh-workspace-add]')
    expect(addButton.click).toHaveBeenCalledTimes(2)
  })

  it('never toggles an already expanded picker shut', async () => {
    const { plugin, sandboxWindow, pageDocument } = await loadClientPlugin()
    const addButton: AddButtonStub = {
      click: vi.fn(),
      getAttribute: vi.fn(() => 'true')
    }
    pageDocument.querySelector.mockReturnValue(addButton)
    const { handler } = registerAddDirectory(sandboxWindow)

    applyWithWorkspace(plugin)
    handler()

    expect(pageDocument.querySelector).toHaveBeenCalledWith('[data-dsh-workspace-add]')
    expect(addButton.click).not.toHaveBeenCalled()
  })

  it('returns silently when the sidebar marker is missing', async () => {
    const { plugin, sandboxWindow, pageDocument } = await loadClientPlugin()
    pageDocument.querySelector.mockReturnValue(null)
    const { handler } = registerAddDirectory(sandboxWindow)

    applyWithWorkspace(plugin)
    expect(() => handler()).not.toThrow()
  })

  it('stays inert when the bridge has no add-directory slot', async () => {
    const { plugin, sandboxWindow, pageDocument } = await loadClientPlugin()
    const onNewSession = vi.fn()
    // A stale preload exposes only the new-session slot.
    sandboxWindow.dshDesktopActions = { onNewSession }

    expect(() => applyWithWorkspace(plugin)).not.toThrow()
    expect(onNewSession).toHaveBeenCalledTimes(1)
    expect(pageDocument.querySelector).not.toHaveBeenCalled()
  })
})
