import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import type { GitBranchesResult, GitRepositoryState, GitBranchResult } from '../src/shared/git-contracts'

const projectRoot = path.resolve(import.meta.dirname, '..')

interface Element {
  type: unknown
  props: Record<string, unknown>
}

interface HookSlot {
  value?: unknown
  current?: unknown
  deps?: unknown[]
  appliedDeps?: unknown[]
  cleanup?: () => void
}

type Props = Record<string, unknown>

const Fragment = Symbol('Fragment')

/**
 * A miniature React: function components, `useState`/`useRef`/`useEffect` and
 * native re-rendering. The composer control owns enough state (repository,
 * menu, dialog, toast) that static element assertions would not exercise it;
 * this keeps the real plugin code under test instead of a reimplementation.
 */
class Renderer {
  private readonly scopes = new Map<unknown, { hooks: HookSlot[] }>()
  private active: { hooks: HookSlot[] } | null = null
  private cursor = 0
  private pending: Array<{ slot: HookSlot; setup: () => void | (() => void) }> = []
  private dirty = false
  private root: unknown = null
  tree: unknown = null

  readonly react = {
    Fragment,
    createElement: (type: unknown, props: Props | null, ...children: unknown[]): Element => {
      const merged: Props = { ...(props ?? {}) }
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
      return { type, props: merged }
    },
    useState: (initial: unknown): [unknown, (next: unknown) => void] => {
      const slot = this.slot()
      if (!('value' in slot)) {
        slot.value = typeof initial === 'function' ? (initial as () => unknown)() : initial
      }
      return [
        slot.value,
        (next: unknown) => {
          const value = typeof next === 'function'
            ? (next as (current: unknown) => unknown)(slot.value)
            : next
          if (Object.is(value, slot.value)) return
          slot.value = value
          this.dirty = true
        }
      ]
    },
    useRef: (initial: unknown): { current: unknown } => {
      const slot = this.slot()
      if (!('current' in slot)) slot.current = initial
      return slot as { current: unknown }
    },
    useEffect: (setup: () => void | (() => void), deps?: unknown[]): void => {
      const slot = this.slot()
      slot.deps = deps
      this.pending.push({ slot, setup })
    }
  }

  mount(element: unknown): void {
    this.root = element
    this.render()
  }

  /** Let promise-backed effects resolve, then repaint. */
  async settle(): Promise<void> {
    for (let pass = 0; pass < 6; pass += 1) {
      this.render()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    this.render()
  }

  render(): void {
    for (let pass = 0; pass < 30; pass += 1) {
      this.dirty = false
      this.pending = []
      this.tree = this.node(this.root)
      this.commit()
      if (!this.dirty) return
    }
    throw new Error('The render loop did not settle')
  }

  private commit(): void {
    const effects = this.pending
    this.pending = []
    for (const { slot, setup } of effects) {
      const deps = slot.deps
      const applied = slot.appliedDeps
      const unchanged = deps !== undefined && applied !== undefined &&
        deps.length === applied.length &&
        deps.every((dep, index) => Object.is(dep, applied[index]))
      if (unchanged) continue
      slot.cleanup?.()
      slot.cleanup = undefined
      const cleanup = setup()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      slot.appliedDeps = deps === undefined ? undefined : [...deps]
    }
  }

  private slot(): HookSlot {
    if (this.active === null) throw new Error('A hook ran outside a component')
    const index = this.cursor
    this.cursor += 1
    const existing = this.active.hooks[index]
    if (existing !== undefined) return existing
    const created: HookSlot = {}
    this.active.hooks[index] = created
    return created
  }

  private node(value: unknown): unknown {
    if (value === null || value === undefined || typeof value === 'boolean') return null
    if (typeof value === 'string' || typeof value === 'number') return value
    if (Array.isArray(value)) return value.map((child) => this.node(child))
    const element = value as Element
    if (element.type === Fragment) return this.node(element.props.children)
    if (typeof element.type === 'function') {
      return this.component(element.type as (props: Props) => unknown, element.props)
    }
    return {
      type: element.type,
      props: { ...element.props, children: this.node(element.props.children) }
    }
  }

  private component(fn: (props: Props) => unknown, props: Props): unknown {
    let scope = this.scopes.get(fn)
    if (scope === undefined) {
      scope = { hooks: [] }
      this.scopes.set(fn, scope)
    }
    const previousScope = this.active
    const previousCursor = this.cursor
    this.active = scope
    this.cursor = 0
    try {
      return this.node(fn(props))
    } finally {
      this.active = previousScope
      this.cursor = previousCursor
    }
  }
}

function walk(value: unknown, visit: (element: Element) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit)
    return
  }
  if (value === null || typeof value !== 'object') return
  const element = value as Element
  visit(element)
  walk(element.props.children, visit)
}

function byTag(tree: unknown, type: string): Element[] {
  const found: Element[] = []
  walk(tree, (element) => {
    if (element.type === type) found.push(element)
  })
  return found
}

function firstByTag(tree: unknown, type: string): Element {
  const [element] = byTag(tree, type)
  if (element === undefined) throw new Error(`Expected a <${type}> element`)
  return element
}

/**
 * Props are `unknown` by design; this surfaces a missing handler as a test
 * failure instead of a no-op optional call that silently passes.
 */
function callable(props: Props, name: string): (...args: unknown[]) => unknown {
  const value = props[name]
  if (typeof value !== 'function') throw new Error(`Expected ${name} to be a function prop`)
  return (...args: unknown[]) => Reflect.apply(value, undefined, args)
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(text).join('')
  if (value !== null && typeof value === 'object') return text((value as Element).props.children)
  return ''
}

interface HarnessOptions {
  cwd?: string | undefined
  running?: boolean
  state?: GitRepositoryState
  branches?: GitBranchesResult
  switchResult?: GitBranchResult
  createResult?: GitBranchResult
}

async function loadPlugin() {
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
  const dictionaries = new Map<string, { zh: Record<string, string>; en: Record<string, string> }>()

  vm.runInNewContext(source, {
    document: {
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => ({ id: '', dataset: {}, textContent: '', remove: vi.fn() })),
      head: { appendChild: vi.fn() }
    },
    navigator: { language: 'en-US' },
    window: {
      __ModuleLoader__: { load: (value: typeof definition) => { definition = value } }
    }
  })
  if (definition === undefined) throw new Error('Expected the client module to register itself')

  return { definition, dictionaries }
}

async function createHarness(options: HarnessOptions = {}) {
  const { definition, dictionaries } = await loadPlugin()
  const renderer = new Renderer()
  const createElement = renderer.react.createElement

  // Primitives become marker host elements so the test can read the props the
  // plugin actually passes without pulling in the real component library.
  const stub = (tag: string) => (props: Props) => createElement(tag, props)
  const primitives = {
    BrandWordmark: stub('brand-wordmark'),
    Button: stub('button-stub'),
    FishLogo: stub('fish-logo'),
    IconBranchOutlineMedium: stub('icon-branch'),
    IconChevronDownOutlineMedium: stub('icon-chevron'),
    IconPlusOutlineMedium: stub('icon-plus'),
    IconWarningOutlineMedium: stub('icon-warning'),
    Input: stub('input'),
    Menu: stub('menu'),
    MenuItemButton: stub('menu-item'),
    Modal: stub('modal'),
    Toast: stub('toast')
  }

  const plugin = definition.factory((id) => {
    if (id === 'react') return renderer.react
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`Unexpected client dependency: ${id}`)
  })

  const registrations: Array<{
    config: { name: string; id?: string }
    component: (props: Props) => unknown
  }> = []
  const slots = {
    inject: (_name: string, callback: () => unknown): unknown => callback(),
    register: (
      config: { name: string; id?: string },
      component: (props: Props) => unknown
    ): (() => void) => {
      registrations.push({ config, component })
      return () => undefined
    }
  }

  plugin.apply({
    slots,
    locale: {
      register: (name: string, value: { zh: Record<string, string>; en: Record<string, string> }) => {
        dictionaries.set(name, value)
        return () => undefined
      }
    },
    inject: (_services: string[], callback: (scope: Props) => void) => {
      callback({ uiWorkspace: { startSession: vi.fn() } })
    },
    effect: (setup: () => (() => void) | undefined) => {
      setup()
    }
  })

  const gitDictionary = dictionaries.get('desktop-git-branch')
  if (gitDictionary === undefined) throw new Error('Expected desktop-git-branch dictionaries')
  const t = (key: string, vars?: Record<string, unknown>): string => {
    const template = gitDictionary.en[key]
    if (template === undefined) throw new Error(`Missing English string: ${key}`)
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(vars?.[name] ?? ''))
  }

  const registration = registrations.find(({ config }) => config.id === 'desktop-git-branch')
  if (registration === undefined) throw new Error('Expected the composer git branch control')

  const running = options.running ?? false
  // `undefined` is meaningful here: no workspace directory means no read.
  const cwd = 'cwd' in options ? options.cwd : '/repo'
  const git = {
    state: vi.fn(async (): Promise<GitRepositoryState> => (
      options.state ?? { kind: 'repository', branch: 'main', headSha: null }
    )),
    branches: vi.fn(async (): Promise<GitBranchesResult> => (
      options.branches ?? {
        kind: 'branches',
        current: 'main',
        branches: [{ name: 'main', current: true }, { name: 'feature', current: false }]
      }
    )),
    switchBranch: vi.fn(async (): Promise<GitBranchResult> => (
      options.switchResult ?? { ok: true, branch: 'feature' }
    )),
    createBranch: vi.fn(async (): Promise<GitBranchResult> => (
      options.createResult ?? { ok: true, branch: 'topic' }
    ))
  }

  const element = createElement(registration.component, {
    sessionId: 'session-1',
    useSessions: (selector: (state: unknown) => unknown) => selector({
      byId: cwd === undefined ? {} : { 'session-1': { cwd } }
    }),
    useSession: (selector: (state: unknown) => unknown) => selector({ running }),
    t,
    git
  })
  renderer.mount(element)
  await renderer.settle()

  const menu = (): Element => firstByTag(renderer.tree, 'menu')
  const anchor = (): Element => menu().props.anchor as Element
  // `Menu` receives the trigger as the `anchor` prop, so the stub forwards it
  // instead of rendering it as a child of the menu element.
  const trigger = (): Element => {
    const element = anchor()
    if (element.props.className !== 'dgb-trigger') throw new Error('Expected the branch trigger')
    return element
  }
  const openMenu = async (): Promise<void> => {
    callable(anchor().props, 'onClick')({})
    await renderer.settle()
  }
  const choose = async (id: string): Promise<void> => {
    callable(menu().props, 'onSelect')(id)
    await renderer.settle()
  }

  return {
    renderer,
    git,
    t,
    menu,
    anchor,
    trigger,
    openMenu,
    choose,
    toast: () => byTag(renderer.tree, 'toast').at(-1),
    dialog: () => byTag(renderer.tree, 'modal')[0]
  }
}

describe('composer git branch control', () => {
  it('hides itself outside a repository or without a workspace directory', async () => {
    const outside = await createHarness({ state: { kind: 'not-repository' } })
    expect(byTag(outside.renderer.tree, 'menu')).toEqual([])
    expect(byTag(outside.renderer.tree, 'button')).toEqual([])

    const unavailable = await createHarness({ cwd: undefined })
    expect(byTag(unavailable.renderer.tree, 'button')).toEqual([])
    expect(unavailable.git.state).not.toHaveBeenCalled()
  })

  it('shows the current branch and disables switching while the session runs', async () => {
    const harness = await createHarness({ running: true })
    const trigger = harness.trigger()
    expect(text(trigger)).toBe('main')
    expect(trigger.props.disabled).toBe(true)
    expect(trigger.props.title).toBe(
      harness.t('branch.busy')
    )
    expect(trigger.props['aria-label']).toBe(harness.t('branch.aria', { name: 'main' }))
    expect(harness.git.state).toHaveBeenCalledWith('/repo')
  })

  it('labels a detached head with the short commit', async () => {
    const harness = await createHarness({
      state: { kind: 'repository', branch: null, headSha: '1825df8' }
    })
    expect(text(harness.trigger())).toBe('1825df8')
    expect(harness.trigger().props.title).toBe(harness.t('branch.detached', { sha: '1825df8' }))
  })

  it('lists branches on open and switches to the chosen one', async () => {
    const harness = await createHarness()
    await harness.openMenu()

    expect(harness.git.branches).toHaveBeenCalledWith('/repo')
    const items = harness.menu().props.items as Array<{ id: string; label: string }>
    expect(items.map(({ id }) => id)).toEqual(['main', 'feature'])
    expect(harness.menu().props.selectedId).toBe('main')

    await harness.choose('feature')
    expect(harness.git.switchBranch).toHaveBeenCalledWith('/repo', 'feature')
    expect(text(harness.trigger())).toBe('feature')
    expect(harness.menu().props.open).toBe(false)

    const toast = harness.toast()
    expect(toast).toBeDefined()
    expect(toast?.props.text).toBe(harness.t('branch.switched', { name: 'feature' }))
    expect(toast?.props.tone).toBe('success')
  })

  it('keeps the old branch and explains a failed switch', async () => {
    const harness = await createHarness({
      switchResult: { ok: false, reason: 'worktree-changed', detail: "would be overwritten: notes.txt" }
    })
    await harness.openMenu()
    await harness.choose('feature')

    expect(text(harness.trigger())).toBe('main')
    const toast = harness.toast()
    expect(toast?.props.text).toBe(harness.t('error.worktree'))
    expect(toast?.props.tone).toBeUndefined()
    expect(text(toast?.props.icon)).toBe('')
  })

  it('closes the menu and reports a branch list failure', async () => {
    const harness = await createHarness({
      branches: { kind: 'git-failed', detail: 'fatal: bad object' }
    })
    await harness.openMenu()

    expect(harness.menu().props.open).toBe(false)
    expect(harness.toast()?.props.text).toBe(harness.t('error.failed'))
  })

  it('creates a branch from the dialog and switches to it', async () => {
    const harness = await createHarness()
    await harness.openMenu()
    await harness.choose('__dsh-desktop-create-branch__')

    const dialog = harness.dialog()
    expect(dialog).toBeDefined()
    expect(dialog?.props.title).toBe(harness.t('create.title'))
    expect(dialog?.props.description).toBe(harness.t('create.description', { name: 'main' }))

    const input = firstByTag(harness.renderer.tree, 'input')
    expect(input.props.placeholder).toBe(harness.t('create.placeholder'))
    callable(input.props, 'onChange')({ target: { value: 'topic' } })
    await harness.renderer.settle()

    const stillOpen = firstByTag(harness.renderer.tree, 'input')
    callable(stillOpen.props, 'onKeyDown')({ key: 'Enter', preventDefault: vi.fn() })
    await harness.renderer.settle()

    expect(harness.git.createBranch).toHaveBeenCalledWith('/repo', 'topic')
    expect(harness.dialog()).toBeUndefined()
    expect(text(harness.trigger())).toBe('topic')
    expect(harness.toast()?.props.text).toBe(harness.t('branch.created', { name: 'topic' }))
  })

  it('ignores Enter while the input method is composing', async () => {
    const harness = await createHarness()
    await harness.openMenu()
    await harness.choose('__dsh-desktop-create-branch__')

    callable(firstByTag(harness.renderer.tree, 'input').props, 'onCompositionStart')()
    callable(firstByTag(harness.renderer.tree, 'input').props, 'onChange')({ target: { value: 'to' } })
    const preventDefault = vi.fn()
    callable(firstByTag(harness.renderer.tree, 'input').props, 'onKeyDown')({
      key: 'Enter',
      preventDefault
    })
    await harness.renderer.settle()

    expect(harness.git.createBranch).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()

    callable(firstByTag(harness.renderer.tree, 'input').props, 'onCompositionEnd')()
    callable(firstByTag(harness.renderer.tree, 'input').props, 'onKeyDown')({
      key: 'Enter',
      preventDefault: vi.fn()
    })
    await harness.renderer.settle()
    expect(harness.git.createBranch).toHaveBeenCalledWith('/repo', 'to')
  })

  it('keeps the dialog open and shows why a creation failed', async () => {
    const harness = await createHarness({
      createResult: { ok: false, reason: 'branch-exists', detail: null }
    })
    await harness.openMenu()
    await harness.choose('__dsh-desktop-create-branch__')

    callable(firstByTag(harness.renderer.tree, 'input').props, 'onChange')({
      target: { value: 'main' }
    })
    await harness.renderer.settle()
    callable(firstByTag(harness.renderer.tree, 'input').props, 'onKeyDown')({
      key: 'Enter',
      preventDefault: vi.fn()
    })
    await harness.renderer.settle()

    expect(harness.dialog()).toBeDefined()
    const alert = byTag(harness.renderer.tree, 'div').find(
      (element) => element.props.className === 'dgb-error'
    )
    expect(text(harness.renderer.tree)).toContain(harness.t('error.exists'))
    expect(alert?.props.role).toBe('alert')
    expect(harness.git.createBranch).toHaveBeenCalledWith('/repo', 'main')
  })
})
