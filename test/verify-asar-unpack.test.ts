import { mkdir, mkdtemp, rmdir, unlink, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar') as {
  createPackageWithOptions(src: string, dest: string, options: { unpack?: string }): Promise<void>
}
const { verifyAsarUnpack } = require('../scripts/verify-asar-unpack.cjs') as {
  verifyAsarUnpack(resourcesDir: string): void
}

const roots: string[] = []

/** Requiring @electron/asar patches fs so any .asar path virtualizes into a
 * directory: a recursive rm can descend into the archive and never remove it.
 * Delete the real tree first, then unlink the archive directly, which passes
 * through the patch. */
async function removePackagedApp(root: string): Promise<void> {
  await rm(join(root, 'app'), { recursive: true, force: true })
  // app.asar.unpacked is a real directory (the name does not end in .asar),
  // so a recursive rm is safe for it.
  await rm(join(root, 'Resources', 'app.asar.unpacked'), { recursive: true, force: true })
  await unlink(join(root, 'Resources', 'app.asar'))
  await rmdir(join(root, 'Resources'))
  await rmdir(root)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => removePackagedApp(root)))
})

/** A 64-bit Mach-O header followed by padding. */
const MACHO = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(60)])

async function packagedApp(unpack?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-asar-unpack-'))
  roots.push(root)
  const app = join(root, 'app')
  await mkdir(join(app, 'node_modules', 'tool', 'bin'), { recursive: true })
  await writeFile(join(app, 'node_modules', 'tool', 'index.js'), 'module.exports = 1\n')
  await writeFile(join(app, 'node_modules', 'tool', 'bin', 'tool'), MACHO)
  const resources = join(root, 'Resources')
  await mkdir(resources)
  await asar.createPackageWithOptions(app, join(resources, 'app.asar'), unpack === undefined ? {} : { unpack })
  return resources
}

describe('verifyAsarUnpack', () => {
  it('rejects a native binary packed inside app.asar', async () => {
    const resources = await packagedApp()
    expect(() => verifyAsarUnpack(resources)).toThrow(/node_modules[\\/]tool[\\/]bin[\\/]tool \(Mach-O\)/u)
  })

  it('accepts the binary once asarUnpack places it beside the archive', async () => {
    const resources = await packagedApp('**/bin/tool')
    expect(() => verifyAsarUnpack(resources)).not.toThrow()
  })

  it('rejects an unpacked payload whose physical file is missing', async () => {
    const resources = await packagedApp('**/bin/tool')
    await rm(join(resources, 'app.asar.unpacked', 'node_modules', 'tool', 'bin', 'tool'))
    expect(() => verifyAsarUnpack(resources)).toThrow(/ENOENT|unpacked resource/)
  })

  it('rejects changed bytes even when the unpacked file size still matches', async () => {
    const resources = await packagedApp('**/bin/tool')
    const changed = Buffer.from(MACHO)
    changed[10] = 1
    await writeFile(join(resources, 'app.asar.unpacked', 'node_modules', 'tool', 'bin', 'tool'), changed)
    expect(() => verifyAsarUnpack(resources)).toThrow('integrity mismatch')
  })
})
