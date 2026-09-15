import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  send: vi.fn(),
  updater: {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    on: vi.fn(),
    autoDownload: false,
    allowDowngrade: false,
    allowPrerelease: false
  }
}))

vi.mock('electron-updater', () => ({ default: { autoUpdater: mocks.updater } }))
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '1.0.0',
    getPath: () => '/nonexistent-desktop-test',
    isReady: () => true
  },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: mocks.send } }
    ]
  },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('../src/main/update/update-policy', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  supportsAutoUpdates: () => true
}))

/**
 * The updater forwards download-progress to the renderer; electron-updater
 * emits one event per downloaded chunk, so the manager coalesces them before
 * they reach the bridge. These tests drive the shipped event handlers with
 * fake clocks and count what actually lands in `webContents.send`.
 */
describe('download-progress coalescing', () => {
  let manager: typeof import('../src/main/update/update-manager')

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.clearAllMocks()
    mocks.handlers.clear()
    mocks.updater.on.mockImplementation((event, callback) => {
      mocks.handlers.set(event as string, callback as (...args: unknown[]) => void)
    })
    manager = await import('../src/main/update/update-manager')
    // Handlers live on autoUpdater, not on the timers: stopping the manager
    // keeps the download-progress wiring while disabling the periodic checks.
    manager.startUpdateManager({ prepareToInstall: async () => {} })
    manager.stopUpdateManager()
  })

  afterEach(() => {
    manager.stopUpdateManager()
    vi.useRealTimers()
  })

  const emitProgress = (percent: number): void => {
    mocks.handlers.get('download-progress')!({ percent })
  }

  const statuses = (): Array<Record<string, unknown>> =>
    mocks.send.mock.calls.map((call) => call[1] as Record<string, unknown>)

  it('forwards at most ~4 progress events per second and flushes the latest percent', () => {
    // A burst of 41 chunk events inside one tick coalesces into one immediate
    // forward plus one trailing flush carrying the newest percent.
    emitProgress(10)
    for (let percent = 11; percent <= 50; percent += 1) emitProgress(percent)
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(statuses()[0]).toMatchObject({ phase: 'downloading', percent: 10 })

    vi.advanceTimersByTime(250)
    expect(mocks.send).toHaveBeenCalledTimes(2)
    expect(statuses()[1]).toMatchObject({ phase: 'downloading', percent: 50 })

    // Events spaced past the coalescing window each go out immediately, so a
    // steady stream never exceeds ~4 forwards per second.
    for (let index = 0; index < 3; index += 1) {
      vi.advanceTimersByTime(300)
      emitProgress(51 + index)
    }
    expect(mocks.send).toHaveBeenCalledTimes(5)
    expect(statuses().at(-1)).toMatchObject({ phase: 'downloading', percent: 53 })
  })

  it('passes the 100% tick straight through with no trailing timer', () => {
    emitProgress(10) // immediate: nothing sent yet
    emitProgress(40) // buffered inside the coalescing window
    emitProgress(100) // completion tick bypasses the window

    expect(mocks.send).toHaveBeenCalledTimes(2)
    expect(statuses()[1]).toMatchObject({ phase: 'downloading', percent: 100 })

    // The buffered 40% was dropped in favor of the completion tick, and no
    // trailing flush may fire afterwards.
    vi.advanceTimersByTime(10_000)
    expect(mocks.send).toHaveBeenCalledTimes(2)
    expect(statuses().at(-1)).toMatchObject({ phase: 'downloading', percent: 100 })
  })

  it('never trails progress behind the downloaded terminal state', () => {
    emitProgress(10) // immediate
    emitProgress(70) // buffered
    mocks.handlers.get('update-downloaded')!({ version: '1.1.0' })

    const phases = statuses().map((status) => status.phase)
    expect(phases).toEqual(['downloading', 'downloaded'])
    expect(statuses().at(-1)).toMatchObject({ phase: 'downloaded', availableVersion: '1.1.0' })

    // The buffered 70% is canceled — nothing progress-shaped follows the
    // terminal state.
    vi.advanceTimersByTime(10_000)
    expect(mocks.send).toHaveBeenCalledTimes(2)
  })

  it('never trails progress behind an error terminal state', () => {
    emitProgress(30) // immediate
    emitProgress(45) // buffered
    mocks.handlers.get('error')!(new Error('download interrupted'))

    const phases = statuses().map((status) => status.phase)
    expect(phases).toEqual(['downloading', 'error'])
    expect(statuses()[1]).toMatchObject({ phase: 'error', message: 'download interrupted' })

    // The buffered 45% is canceled — nothing progress-shaped follows the
    // terminal state.
    vi.advanceTimersByTime(10_000)
    expect(mocks.send).toHaveBeenCalledTimes(2)
  })
})
