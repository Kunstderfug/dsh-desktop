import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { createGitBranch, listGitBranches, readGitRepositoryState, switchGitBranch } from './git'

export interface GitIpcOptions {
  /**
   * The host's existing main-window/main-frame check. It stays in `index.ts`
   * with the rest of the trusted-source rules; git only borrows it so the
   * composer cannot reach git through another window or a nested frame.
   */
  assertTrusted: (event: IpcMainInvokeEvent) => void
}

/**
 * Registers the narrow git bridge used by the composer's branch control.
 *
 * Each channel maps to one fixed module function; the renderer never supplies a
 * command. Arguments arrive as `unknown` and are validated by the service, so
 * a malformed call yields the same structured failure as a real git error
 * instead of an unhandled exception.
 */
export function registerGitIpc({ assertTrusted }: GitIpcOptions): void {
  ipcMain.removeHandler('git:state')
  ipcMain.handle('git:state', async (event, path: unknown) => {
    assertTrusted(event)
    return await readGitRepositoryState(path)
  })

  ipcMain.removeHandler('git:branches')
  ipcMain.handle('git:branches', async (event, path: unknown) => {
    assertTrusted(event)
    return await listGitBranches(path)
  })

  ipcMain.removeHandler('git:switch')
  ipcMain.handle('git:switch', async (event, path: unknown, branch: unknown) => {
    assertTrusted(event)
    return await switchGitBranch(path, branch)
  })

  ipcMain.removeHandler('git:create')
  ipcMain.handle('git:create', async (event, path: unknown, branch: unknown) => {
    assertTrusted(event)
    return await createGitBranch(path, branch)
  })
}
