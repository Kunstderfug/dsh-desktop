import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectRoot } from './patch-path'

/**
 * Permanent session deletion was retired for the Harness 0.1.5 line.
 *
 * Upstream deleted the infrastructure the feature was built on — the
 * `SessionPreparations` class, `deleteStored` on the storage backend, and the
 * coordinator delete path — leaving nothing to attach a patch to. The four
 * patches that carried it now live in
 * `doc/harness-upgrade/retired-session-delete/` and are intentionally absent
 * from `patches/`.
 *
 * These tests guard the retirement decisions rather than the feature, so a
 * later revival has to be deliberate.
 */
const retiredPackages = [
  'dsh-session-persistence',
  'dsh-session-persistence-jsonl',
  'dsh-api-session-controller',
  'dsh-workspace'
] as const

const readNodeModule = (name: string, file: string) =>
  readFile(path.join(projectRoot, 'node_modules', '@deepseek-ai', name, file), 'utf8')

describe('permanent session deletion retired for the 0.1.5 line', () => {
  it.each(retiredPackages)(
    'carries no %s patch, so nothing dead targets the deleted upstream API',
    async (name) => {
      const patchNames = await readdir(path.join(projectRoot, 'patches'))
      const lingering = patchNames.filter((file) =>
        file.startsWith(`${name.replace('/', '+')}+`)
      )
      expect(lingering).toEqual([])
    }
  )

  it('leaves no session-delete API in the installed persistence surface', async () => {
    const index = await readNodeModule('dsh-session-persistence', 'lib/index.js')

    expect(index).not.toContain('assertDeletable')
    expect(index).not.toContain('deleteStored')
    expect(index).not.toContain('waitForRetirement')
  })
})

describe('session deletion UI is absent from the shipped workspace bundle', () => {
  /**
   * The feature is retired, so no delete affordance should reach users. The
   * workspace UI patch is regenerated with gen-patch.sh after any edit here.
   */
  it('exposes no session delete affordance', async () => {
    const ui = await readNodeModule('dsh-client-ui-workspace', 'lib/client.js')

    expect(ui).not.toContain('deleteSession')
    expect(ui).not.toContain('await sessions.delete(')
    expect(ui).not.toContain('"delete.session"')
    expect(ui).not.toContain('工作区文件会保留。此操作无法撤销。')
  })

  it('leaves workspace deletion (a separate feature) intact', async () => {
    const ui = await readNodeModule('dsh-client-ui-workspace', 'lib/client.js')

    expect(ui).toContain('delete.workspace')
    expect(ui).toContain('onDeleteRequest')
  })
})
