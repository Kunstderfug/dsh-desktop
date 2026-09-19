import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { patchPath, projectRoot } from './patch-path'

describe('workspace Open in Finder integration', () => {
  it('keeps the workspace UI patch on the pinned Harness package', async () => {
    // Resolve by package name: the patch filename carries the Harness version it
    // was captured against, so asserting a literal version would have to be
    // rewritten on every upgrade (which is what patchPath exists to avoid).
    const resolved = patchPath('@deepseek-ai/dsh-client-ui-workspace')
    const patch = await readFile(resolved, 'utf8')
    const patchNames = await readdir(path.join(projectRoot, 'patches'))

    const installed = JSON.parse(
      await readFile(
        path.join(
          projectRoot,
          'node_modules/@deepseek-ai/dsh-client-ui-workspace/package.json'
        ),
        'utf8'
      )
    ) as { version: string }

    // The patch must be named for the version actually installed, otherwise
    // patch-package warns on every install.
    expect(patchNames).toContain(
      `@deepseek-ai+dsh-client-ui-workspace+${installed.version}.patch`
    )
    expect(path.basename(resolved)).toBe(
      `@deepseek-ai+dsh-client-ui-workspace+${installed.version}.patch`
    )
    // Stale patches from superseded Harness versions must not linger.
    expect(patchNames).not.toContain(
      '@deepseek-ai+dsh-client-ui-workspace+0.1.5-rc.1.patch'
    )
    expect(patch).toContain('id: "openInFinder"')
    expect(patch).toContain('t("menu.openInFinder")')
    expect(patch).toContain('window.dshDesktop.openInFinder(row.cwd)')
    expect(patch).toContain('"menu.openInFinder": "在 Finder 中打开"')
    expect(patch).toContain('"menu.openInFinder": "Open in Finder"')
  })

  it('leaves the installed workspace bundle syntactically valid', async () => {
    const bundle = await readFile(
      path.join(
        projectRoot,
        'node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js'
      ),
      'utf8'
    )

    expect(() => new Script(bundle)).not.toThrow()
  })
})
