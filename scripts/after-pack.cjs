'use strict'

const { rmSync } = require('node:fs')
const { join } = require('node:path')

/**
 * Removes the bundled standalone Node binary from macOS packages.
 *
 * macOS never runs it: the Harness launches in the Electron utility process
 * (ELECTRON_RUN_AS_NODE is declared by harness-node-entry.mjs), and plugin
 * commands plus the .desktop-bin shims run process.execPath under the same
 * variable (see bundledNodePath in src/main/index.ts and
 * profile-plugin-command.ts). Windows and Linux have no Electron process to
 * borrow and keep the binary.
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const bundledNode = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
    'app',
    'node_modules',
    'node'
  )
  rmSync(bundledNode, { recursive: true, force: true })
}
