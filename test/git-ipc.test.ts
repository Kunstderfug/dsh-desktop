import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerGitIpc } from '../src/main/git-ipc'

/**
 * The bridge is the only place git becomes reachable from the renderer, so the
 * registration itself is the contract: one fixed channel per operation, the
 * trusted-window check first, and structured results for malformed arguments.
 */
type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const handlers = new Map<string, InvokeHandler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  }
}))

const event = { senderFrame: {} } as unknown as IpcMainInvokeEvent

function handlerFor(channel: string): InvokeHandler {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Expected a ${channel} handler`)
  return handler
}

describe('registerGitIpc', () => {
  beforeEach(() => {
    handlers.clear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('registers exactly the four composer channels', () => {
    registerGitIpc({ assertTrusted: vi.fn() })
    expect([...handlers.keys()].sort()).toEqual([
      'git:branches',
      'git:create',
      'git:state',
      'git:switch'
    ])
  })

  it('replaces a previous registration instead of stacking handlers', async () => {
    const { ipcMain } = await import('electron')
    registerGitIpc({ assertTrusted: vi.fn() })
    registerGitIpc({ assertTrusted: vi.fn() })
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('git:state')
    expect(handlers.size).toBe(4)
  })

  it('checks the trusted window before touching the filesystem', async () => {
    const denied = new Error('untrusted')
    const assertTrusted = vi.fn(() => {
      throw denied
    })
    registerGitIpc({ assertTrusted })

    await expect(handlerFor('git:state')(event, '/definitely/not/a/repo')).rejects.toBe(denied)
    expect(assertTrusted).toHaveBeenCalledWith(event)
  })

  it.each([
    ['git:state', [42]],
    ['git:branches', [null]],
    ['git:switch', [42, 'bad name']],
    ['git:create', ['/definitely/not/a/repo', 42]]
  ] satisfies Array<[string, unknown[]]>)(
    'answers %s with a structured result for malformed arguments',
    async (channel, args) => {
      registerGitIpc({ assertTrusted: vi.fn() })

      const result = await handlerFor(channel)(event, ...args)
      if (channel === 'git:state' || channel === 'git:branches') {
        expect(result).toEqual({ kind: 'not-repository' })
        return
      }
      expect(result).toMatchObject({ ok: false, reason: 'invalid-branch-name' })
    }
  )

  it('passes the branch name through to the service unchanged', async () => {
    registerGitIpc({ assertTrusted: vi.fn() })
    // The path does not exist, so the service reports a repository failure
    // rather than a name problem: proof the name survived the bridge intact.
    const result = await handlerFor('git:switch')(event, '/definitely/not/a/repo', 'feature/x')
    expect(result).toMatchObject({ ok: false, reason: 'not-a-repository' })
  })
})
