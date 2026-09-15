import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { patchPath } from './patch-path'

describe('global add-directory shortcut wiring', () => {
  it('claims CmdOrCtrl+O in the File menu and forwards it to the main window', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')

    expect(main).toContain("accelerator: 'CmdOrCtrl+O'")
    expect(main).toContain("mainWindow.webContents.send('desktop:add-directory')")
    // One shell-owned File menu hosting the shortcut, next to New Session.
    expect(main).toContain("label: isChinese ? '文件' : 'File'")
    expect(main).toContain("label: isChinese ? '添加目录…' : 'Add Directory…'")
  })

  it('exposes the single-callback page bridge in the preload', async () => {
    const preload = await readFile('src/preload/index.ts', 'utf8')

    expect(preload).toContain("exposeInMainWorld('dshDesktopActions'")
    expect(preload).toContain('onAddDirectory:')
    expect(preload).toContain("ipcRenderer.on('desktop:add-directory'")
    expect(preload).toContain('addDirectoryHandler?.()')
  })

  it('does not register any OS-global shortcut', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')

    expect(main).not.toContain('globalShortcut')
  })
})

describe('sidebar add-directory click target', () => {
  it('queries the patched sidebar add button and honours its expanded state', async () => {
    const client = await readFile(
      'packages/dsh-desktop-client-ui/client.js',
      'utf8'
    )

    // The accelerator activates the sidebar `+` button because `uiWorkspace`
    // exposes no add-directory API.
    expect(client).toContain("document.querySelector('[data-dsh-workspace-add]')")
    // A blind second activation would toggle the open picker shut.
    expect(client).toContain("addButton.getAttribute('aria-expanded') === 'true'")
    expect(client).toContain('addButton.click()')
  })

  it('carries the marker and expanded state in the tracked workspace patch', async () => {
    const patch = await readFile(
      patchPath('@deepseek-ai/dsh-client-ui-workspace'),
      'utf8'
    )

    // Tracked patch, so a reinstall reproduces the marker the plugin queries.
    expect(patch).toMatch(/^\+\s+"data-dsh-workspace-add": "",$/m)
    expect(patch).toMatch(/^\+\s+"aria-expanded": wsPickerOpen,$/m)
    // Anchored to the sidebar `+` button (workspace.add), not another button.
    expect(patch).toContain('"aria-label": t("workspace.add"),')
    expect(patch).toContain('setWsPickerOpen((v) => !v);')
  })
})
