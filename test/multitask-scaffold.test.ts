import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { patchPath, projectRoot } from './patch-path'

/**
 * The [multitask] scaffold (issue #3): the permanent plugin pair and its
 * desktop mount. This file asserts the scaffold surface only — manifests,
 * exports, mount rows, closure injection, and the one startup line / one
 * placeholder occupant. Closure wiring itself is the binding contract of
 * `desktop-plugin-closure.test.ts`, which must keep passing unmodified.
 */

const HOST_PACKAGE = 'dsh-multitask'
const CLIENT_PACKAGE = 'dsh-multitask-client'

/** The one startup line the host plugin logs (grepped by the mount smoke script). */
const STARTUP_LINE = '[multitask] plugin active'

const profileConfigTags = [
  {
    tag: 'tag:yaml.org,2002:js',
    resolve: (value: string) => value
  }
]

interface PackageManifest {
  name?: string
  main?: string
  exports?: Record<string, unknown>
  dsh?: { client?: { platform?: string; inject?: string[] } }
}

async function readJson(relative: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(projectRoot, relative), 'utf8'))
}

async function readManifest(packageName: string): Promise<PackageManifest> {
  return (await readJson(path.join('packages', packageName, 'package.json'))) as PackageManifest
}

interface InsertRow {
  id?: string
  name?: string
}

async function readMountedNames(): Promise<string[]> {
  const profilePatch = parseYaml(
    await readFile(path.join(projectRoot, 'build', 'dsh-desktop.patch.yml'), 'utf8'),
    { customTags: profileConfigTags }
  ) as { insert?: InsertRow[] }[]
  return profilePatch
    .flatMap((row) => row.insert ?? [])
    .map((entry) => entry.name)
    .filter((name): name is string => typeof name === 'string')
}

describe('multitask scaffold manifests', () => {
  it('declares the host plugin package with the exact package id', async () => {
    const manifest = await readManifest(HOST_PACKAGE)
    expect(manifest.name).toBe(HOST_PACKAGE)
    expect(manifest.main).toBe('./index.js')
    expect(manifest.exports?.['.']).toBeDefined()
  })

  it('declares the browser companion with the ./client export it is served through', async () => {
    const manifest = await readManifest(CLIENT_PACKAGE)
    expect(manifest.name).toBe(CLIENT_PACKAGE)
    expect(manifest.main).toBe('./index.js')
    expect(manifest.exports?.['./client']).toBeDefined()
    expect(manifest.dsh?.client?.platform).toBe('web')
  })

  it('exports a cordis host plugin that logs the one startup line', async () => {
    const source = await readFile(
      path.join(projectRoot, 'packages', HOST_PACKAGE, 'index.js'),
      'utf8'
    )
    const logged: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    })
    try {
      const module = await import(
        `${pathToFileUrl(path.join(projectRoot, 'packages', HOST_PACKAGE, 'index.js'))}?scaffold-test`
      )
      expect(module.name).toBe(HOST_PACKAGE)
      expect(typeof module.apply).toBe('function')
      module.apply({})
      expect(logged.some((line) => line.includes(STARTUP_LINE))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

function pathToFileUrl(absolute: string): string {
  return `file://${absolute.split(path.sep).map(encodeURIComponent).join('/')}`
}

interface SlotRegistration {
  options: { name: string; id?: string; order?: number }
  component: (props: Record<string, never>) => unknown
}

type ClientFactory = (require: (id: string) => unknown) => {
  apply: (ctx: unknown) => void
  inject: string[]
}

/** Minimal React stand-in: the factory resolves modules the same way the served combo does. */
function fakeRequire(id: string): unknown {
  if (id === 'react') {
    return {
      createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
        type,
        props,
        children
      })
    }
  }
  throw new Error(`the placeholder client must not require "${id}"`)
}

async function loadClientModule(): Promise<{
  id: string
  factory: ClientFactory
}> {
  const source = await readFile(
    path.join(projectRoot, 'packages', CLIENT_PACKAGE, 'client.js'),
    'utf8'
  )
  let definition: { id: string; factory: ClientFactory } | undefined
  const sandboxWindow = {
    __ModuleLoader__: {
      load: (value: { id: string; factory: ClientFactory }) => {
        definition = value
      }
    }
  }
  vm.runInNewContext(source, { window: sandboxWindow })
  expect(definition).toBeDefined()
  return definition!
}

describe('multitask scaffold client module', () => {
  it('loads through window.__ModuleLoader__ and injects the slots service', async () => {
    const { id, factory } = await loadClientModule()
    expect(id).toBe(CLIENT_PACKAGE)
    const plugin = factory(fakeRequire)
    expect(plugin.inject).toEqual(['slots'])
    expect(typeof plugin.apply).toBe('function')
  })

  it('registers exactly one placeholder occupant on a conversation slot', async () => {
    const { factory } = await loadClientModule()
    const plugin = factory(fakeRequire)
    const registrations: SlotRegistration[] = []
    const deferred: Array<[string, () => void]> = []
    plugin.apply({
      slots: {
        inject: (name: string, factory: () => void) => deferred.push([name, factory]),
        register: (options: SlotRegistration['options'], component: SlotRegistration['component']) => {
          registrations.push({ options, component })
          return () => {}
        }
      }
    })
    expect(deferred).toHaveLength(1)
    const [slotName] = deferred[0]!
    expect(slotName).toBe('conversation.composer.dock')
    deferred[0]![1]()
    expect(registrations).toHaveLength(1)
    expect(registrations[0]!.options.name).toBe('conversation.composer.dock')
    expect(registrations[0]!.options.id).toBe('dsh-multitask-placeholder')
    // The rendered element carries the marker the mount smoke script greps
    // for in the live renderer, and is visibly labelled Multitask.
    const element = registrations[0]!.component({}) as {
      props: Record<string, unknown>
    }
    expect(element.props['data-dsh-multitask-placeholder']).toBe('')
  })
})

describe('multitask scaffold mount', () => {
  it('mounts both packages as insert rows in the desktop profile patch', async () => {
    const mounted = await readMountedNames()
    expect(mounted).toContain(HOST_PACKAGE)
    expect(mounted).toContain(CLIENT_PACKAGE)
  })

  it('declares both packages as file:packages/ production dependencies', async () => {
    const manifest = (await readJson('package.json')) as {
      dependencies: Record<string, string>
    }
    for (const name of [HOST_PACKAGE, CLIENT_PACKAGE]) {
      expect(manifest.dependencies[name]).toBe(`file:packages/${name}`)
    }
  })

  it('injects both packages into the @deepseek-ai/dsh dependency closure', async () => {
    const dshPatch = await readFile(patchPath('@deepseek-ai/dsh'), 'utf8')
    for (const name of [HOST_PACKAGE, CLIENT_PACKAGE]) {
      expect(dshPatch).toContain(`+    "${name}":`)
    }
  })
})
