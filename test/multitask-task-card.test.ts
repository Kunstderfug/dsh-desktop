/**
 * [multitask] issue #11 — task-card chat node, claim badges, queue labels.
 *
 * Source/projection contracts for the browser companion. The live production
 * seam is `scripts/check-multitask-task-card.mjs` (selected by
 * `multitask_task_card_gate`). These tests pin the fold, slot contributions,
 * and narrow-text surface that the live gate observes.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { projectRoot } from './patch-path'

const CLIENT_PACKAGE = 'dsh-multitask-client'
const TASK_CARD_SLOT = 'conversation.chat.node'
const COMMANDVIEW_SLOT = 'conversation.chat.commandview'
const QUEUE_SLOT = 'conversation.input.dock'
const LINEAGE_SLOT = 'conversation.session.header.actions'
const TOOLVIEW_SLOT = 'tool.call.toolview'

const PHASES = [
  'queued',
  'researching',
  'orchestrating',
  'writing',
  'verifying',
  'done',
  'failed'
] as const

interface SlotRegistration {
  options: {
    name: string
    id?: string
    key?: string
    order?: number
    select?: (owner: Record<string, unknown>) => unknown
  }
  component: (props: Record<string, unknown>) => unknown
}

interface LoadedClient {
  id: string
  plugin: {
    apply: (ctx: unknown) => void
    inject: string[]
    foldTasks: (events: Array<Record<string, unknown>>) => unknown[]
    displayPhase: (phase: string) => string
    queueRowKind: (text: string) => string
    claimBadgeForPath: (
      path: string,
      claims: Array<Record<string, unknown>>
    ) => Record<string, unknown> | null
    formatTaskCardText: (task: Record<string, unknown>) => string
    extractTaskId: (text: string) => string | undefined
    TASK_PHASES: readonly string[]
    NARROW_MAX_WIDTH: number
    HANDOFF_PATTERN: RegExp
  }
}

function fakeRequire(id: string): unknown {
  if (id === 'react') {
    return {
      createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
        type,
        props: props ?? {},
        children
      }),
      useSyncExternalStore: (subscribe: (onStoreChange: () => void) => () => void, getSnapshot: () => unknown) => {
        subscribe(() => {})
        return getSnapshot()
      },
      useMemo: (factory: () => unknown) => factory(),
      useEffect: () => {},
      useState: (initial: unknown) => [initial, () => {}],
      memo: (component: unknown) => component
    }
  }
  throw new Error(`the task-card client must not require "${id}"`)
}

async function loadClient(): Promise<LoadedClient> {
  const source = await readFile(
    path.join(projectRoot, 'packages', CLIENT_PACKAGE, 'client.js'),
    'utf8'
  )
  let definition: { id: string; factory: (require: typeof fakeRequire) => LoadedClient['plugin'] } | undefined
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load: (value: typeof definition) => {
          definition = value
        }
      }
    }
  })
  expect(definition).toBeDefined()
  return { id: definition!.id, plugin: definition!.factory(fakeRequire) }
}

function applyClient(plugin: LoadedClient['plugin']) {
  const registrations: SlotRegistration[] = []
  const deferred: Array<[string, () => void]> = []
  const definitions: Array<Record<string, unknown>> = []
  const ctx = {
    inject: (_deps: string[], fn: (live: unknown) => void) => fn(ctx),
    slots: {
        inject: (name: string, factory: () => void) => deferred.push([name, () => {
          const result = factory()
          if (result !== undefined && typeof (result as Iterator<unknown>).next === 'function') {
            for (const _item of result as Iterable<unknown>) { /* drain generator registrations */ }
          }
        }]),
        register: (options: SlotRegistration['options'], component: SlotRegistration['component']) => {
          registrations.push({ options, component })
          return () => {}
        }
      },
    uiConversation: {
      events: {
        register: (definition: Record<string, unknown>) => {
          definitions.push(definition)
          return () => {}
        }
      }
    },
    sessions: {
      binding: () => undefined,
      list: { getSnapshot: () => ({ byId: {} }) }
    },
    locale: {
      register: () => () => {}
    },
    effect: (fn: () => void) => {
      fn()
      return () => {}
    }
  }
  plugin.apply(ctx)
  for (const [, factory] of deferred) factory()
  return { registrations, definitions, deferred }
}

describe('multitask task-card client module', () => {
  it('loads through window.__ModuleLoader__ and waits for slots plus conversation journal', async () => {
    const { id, plugin } = await loadClient()
    expect(id).toBe(CLIENT_PACKAGE)
    expect(plugin.inject).toEqual(['slots'])
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.TASK_PHASES).toEqual([...PHASES])
  })

  it('replaces the scaffold placeholder with keyed chat, command, queue, lineage, and tool seats', async () => {
    const { plugin } = await loadClient()
    const { registrations, deferred } = applyClient(plugin)
    expect(deferred.some(([name]) => name === 'conversation.composer.dock' && registrations.some((row) => row.options.id === 'dsh-multitask-placeholder'))).toBe(false)
    expect(registrations.some((row) => row.options.name === TASK_CARD_SLOT && row.options.key === 'multitask-task')).toBe(true)
    expect(registrations.some((row) => row.options.name === COMMANDVIEW_SLOT && row.options.key === 'multitask')).toBe(true)
    expect(registrations.some((row) => row.options.name === QUEUE_SLOT && row.options.id === 'dsh-multitask-queue-label')).toBe(true)
    expect(registrations.some((row) => row.options.name === LINEAGE_SLOT && row.options.id === 'dsh-multitask-lineage')).toBe(true)
    expect(registrations.some((row) => row.options.name === TOOLVIEW_SLOT && row.options.key === 'claim_files')).toBe(true)
    expect(registrations.some((row) => row.options.name === TOOLVIEW_SLOT && row.options.key === 'write')).toBe(false)
  })

  it('registers one conversation definition that keys cards by task id and folds command plus multitask events', async () => {
    const { plugin } = await loadClient()
    const { definitions } = applyClient(plugin)
    expect(definitions).toHaveLength(1)
    const definition = definitions[0] as {
      kind: string
      target: string
      match: (event: Record<string, unknown>) => { id: string; role: string } | null
      start: (context: unknown, match: { event: Record<string, unknown> }) => Record<string, unknown>
      update: (context: { state: Record<string, unknown> }, match: { event: Record<string, unknown> }) => Record<string, unknown>
      buildViewNode: (context: { key: string; id: string; state: Record<string, unknown>; start?: { event: Record<string, unknown>; location?: unknown } }) => Record<string, unknown> | null
    }
    expect(definition.kind).toBe('multitask-task')
    expect(definition.target).toBe('chat')
    const run = {
      type: 'command/run',
      seq: 1,
      time: 1,
      data: { commandId: 'cmd-1', name: 'multitask', args: ' ship the card' }
    }
    const task = {
      type: 'multitask/task',
      seq: 2,
      time: 2,
      data: { id: 'MT-4', objective: 'ship the card', phase: 'queued', createdAt: '2026-09-14T00:00:00.000Z' }
    }
    const research = {
      type: 'multitask/research',
      seq: 3,
      time: 3,
      data: { id: 'MT-4', objective: 'ship the card', phase: 'researching', childId: 'child-9', label: 'researcher' }
    }
    const done = {
      type: 'command/done',
      seq: 4,
      time: 4,
      data: { commandId: 'cmd-1', kind: 'success', text: 'Multitask task MT-4 queued.' }
    }
    const claim = {
      type: 'multitask/claims',
      seq: 5,
      time: 5,
      data: { path: 'src/card.ts', taskId: 'MT-4', ownerSessionId: 'agent-1', state: 'claimed', since: '2026-09-14T00:00:01.000Z' }
    }
    expect(definition.match(run)).toBeNull()
    expect(definition.match(task)).toEqual({ id: 'MT-4', role: 'start' })
    expect(definition.match(research)).toEqual({ id: 'MT-4', role: 'update' })
    expect(definition.match(done)).toEqual({ id: 'MT-4', role: 'update' })
    expect(definition.match(claim)).toEqual({ id: 'MT-4', role: 'update' })
    expect(definition.match({ type: 'command/run', data: { name: 'goal' } })).toBeNull()

    const started = definition.start({}, { event: task })
    const researched = definition.update({ state: started }, { event: research })
    const settled = definition.update({ state: researched }, { event: done })
    const claimed = definition.update({ state: settled }, { event: claim })
    const node = definition.buildViewNode({
      key: 'multitask-task:MT-4',
      id: 'MT-4',
      state: claimed,
      start: { event: task, location: { kind: 'session' } }
    })
    expect(node).toMatchObject({
      kind: 'multitask-task',
      id: 'MT-4',
      target: 'chat',
      data: expect.objectContaining({
        id: 'MT-4',
        objective: 'ship the card',
        phase: 'researching',
        childIds: ['child-9']
      })
    })
    const second = definition.buildViewNode({
      key: 'multitask-task:MT-4',
      id: 'MT-4',
      state: claimed,
      start: { event: task, location: { kind: 'session' } }
    })
    expect(second?.id).toBe('MT-4')
  })
})

describe('multitask task-card fold', () => {
  it('keeps one card per task and lets later events supersede phase while preserving failure and objective', async () => {
    const { plugin } = await loadClient()
    const events = [
      { type: 'command/run', seq: 1, data: { commandId: 'a', name: 'multitask', args: ' first' } },
      { type: 'multitask/task', seq: 2, data: { id: 'MT-1', objective: 'first', phase: 'queued', createdAt: 't0' } },
      { type: 'command/done', seq: 3, data: { commandId: 'a', kind: 'success', text: 'Multitask task MT-1 queued.' } },
      { type: 'multitask/research', seq: 4, data: { id: 'MT-1', objective: 'first', phase: 'researching', childId: 'r1', label: 'researcher' } },
      { type: 'multitask/research', seq: 5, data: { id: 'MT-1', objective: 'first', phase: 'research-failed', childId: 'r1', label: 'researcher', stopReason: 'error' } },
      { type: 'command/run', seq: 6, data: { commandId: 'b', name: 'multitask', args: ' second' } },
      { type: 'multitask/task', seq: 7, data: { id: 'MT-2', objective: 'second', phase: 'queued', createdAt: 't1' } },
      { type: 'multitask/task', seq: 8, data: { id: 'MT-2', objective: 'second', phase: 'writing', createdAt: 't2' } },
      { type: 'multitask/phase', seq: 9, data: { id: 'MT-2', objective: 'second', phase: 'verifying' } },
      { type: 'multitask/phase', seq: 10, data: { id: 'MT-2', objective: 'second', phase: 'done' } }
    ]
    const cards = plugin.foldTasks(events) as Array<Record<string, unknown>>
    expect(cards.map((card) => card.id)).toEqual(['MT-1', 'MT-2'])
    expect(cards[0]).toMatchObject({
      id: 'MT-1',
      objective: 'first',
      phase: 'failed',
      failed: true,
      childIds: ['r1']
    })
    expect(cards[1]).toMatchObject({
      id: 'MT-2',
      objective: 'second',
      phase: 'done',
      failed: false
    })
  })

  it('maps the host research vocabulary onto the declared chip phases', async () => {
    const { plugin } = await loadClient()
    expect(plugin.displayPhase('queued')).toBe('queued')
    expect(plugin.displayPhase('researching')).toBe('researching')
    expect(plugin.displayPhase('researched')).toBe('orchestrating')
    expect(plugin.displayPhase('research-failed')).toBe('failed')
    expect(plugin.displayPhase('writing')).toBe('writing')
    expect(plugin.displayPhase('verifying')).toBe('verifying')
    expect(plugin.displayPhase('done')).toBe('done')
    expect(plugin.displayPhase('failed')).toBe('failed')
  })

  it('labels orchestrator handoffs apart from plain queued user messages', async () => {
    const { plugin } = await loadClient()
    expect(plugin.queueRowKind('Orchestrator handoff for MT-3: continue research')).toBe('orchestrator-handoff')
    expect(plugin.queueRowKind('please review the diff')).toBe('user')
    expect(plugin.extractTaskId('Multitask task MT-12 queued.')).toBe('MT-12')
  })

  it('badges claimed paths by normalized path, task, and owner', async () => {
    const { plugin } = await loadClient()
    const claims = [
      { path: 'src/a.ts', taskId: 'MT-1', ownerSessionId: 'child-1', state: 'claimed' },
      { path: 'src/b.ts', taskId: 'MT-2', ownerSessionId: 'child-2', state: 'released' }
    ]
    expect(plugin.claimBadgeForPath('src/a.ts', claims)).toEqual({
      path: 'src/a.ts',
      taskId: 'MT-1',
      ownerSessionId: 'child-1'
    })
    expect(plugin.claimBadgeForPath('./src/a.ts', claims)).toEqual({
      path: 'src/a.ts',
      taskId: 'MT-1',
      ownerSessionId: 'child-1'
    })
    expect(plugin.claimBadgeForPath('src/b.ts', claims)).toBeNull()
    expect(plugin.claimBadgeForPath('src/other.ts', claims)).toBeNull()
  })

  it('degrades the card to readable text for narrow and mobile surfaces', async () => {
    const { plugin } = await loadClient()
    expect(plugin.NARROW_MAX_WIDTH).toBeLessThanOrEqual(640)
    const text = plugin.formatTaskCardText({
      id: 'MT-7',
      objective: 'narrow surface',
      phase: 'writing',
      childIds: ['child-3'],
      claims: [{ path: 'src/ui.ts', taskId: 'MT-7', ownerSessionId: 'child-3' }],
      failed: false
    })
    expect(text).toContain('MT-7')
    expect(text).toContain('narrow surface')
    expect(text).toContain('writing')
    expect(text).toContain('child-3')
    expect(text).toContain('src/ui.ts')
    expect(text).not.toMatch(/<[^>]+>/)
  })
})
