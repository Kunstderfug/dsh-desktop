import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('global new-session shortcut wiring', () => {
  it('claims CmdOrCtrl+N in the application menu and forwards it to the main window', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')

    expect(main).toContain("accelerator: 'CmdOrCtrl+N'")
    expect(main).toContain("mainWindow.webContents.send('desktop:new-session')")
    // One shell-owned File menu hosting the shortcut, next to the app menu.
    expect(main).toContain("label: isChinese ? '文件' : 'File'")
    expect(main).toContain("label: isChinese ? '新建会话' : 'New Session'")
  })

  it('exposes the single-callback page bridge in the preload', async () => {
    const preload = await readFile('src/preload/index.ts', 'utf8')

    expect(preload).toContain("exposeInMainWorld('dshDesktopActions'")
    expect(preload).toContain("ipcRenderer.on('desktop:new-session'")
  })

  it('does not register any OS-global shortcut', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')

    expect(main).not.toContain('globalShortcut')
  })
})
