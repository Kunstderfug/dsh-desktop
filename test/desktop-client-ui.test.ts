import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')

interface Registration {
  config: { name: string; id?: string; order?: number }
  component: (props: Record<string, unknown>) => unknown
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
  const document = {
    getElementById: vi.fn(() => null),
    createElement: vi.fn(() => ({ id: '', dataset: {}, textContent: '' })),
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
    document,
    navigator: { language: 'en-US' },
    window: sandboxWindow
  })

  expect(definition).toBeDefined()
  return { plugin: definition!.factory, appended, sandboxWindow }
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
