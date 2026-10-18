import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createGitBranch,
  listGitBranches,
  readGitRepositoryState,
  switchGitBranch
} from '../src/main/git'

/**
 * Behaviour against real repositories: the control's contract is git's own
 * safety net, so the fixtures use a real `git` binary in a throwaway HOME
 * rather than stubbing process output. Each fixture owns its repository so a
 * mutation in one case cannot mask a state bug in another.
 */
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
})()

const fixtures: string[] = []
let home = ''

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: 'DSH Test',
    GIT_AUTHOR_EMAIL: 'dsh-test@example.com',
    GIT_COMMITTER_NAME: 'DSH Test',
    GIT_COMMITTER_EMAIL: 'dsh-test@example.com',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
    LANG: 'C'
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: gitEnv(),
    encoding: 'utf8',
    // Keep checkout advice off the test reporter's stderr; failures still
    // throw with git's own message.
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  }).trim()
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(home, prefix))
  fixtures.push(root)
  return root
}

async function createRepository(): Promise<string> {
  const root = await temporaryDirectory('repo-')
  // Pin the initial branch name so assertions do not depend on the user's
  // `init.defaultBranch` setting.
  git(root, ['init', '-b', 'main'])
  await writeFile(path.join(root, 'notes.txt'), 'base\n')
  git(root, ['add', 'notes.txt'])
  git(root, ['commit', '-m', 'initial'])
  return root
}

describe.skipIf(!hasGit)('git repository access', () => {
  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'dsh-git-home-'))
  })

  afterAll(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('reads the current branch of a repository', async () => {
    const root = await createRepository()
    // The short commit is only needed to label a detached HEAD; a named branch
    // is enough for the chip, so the service does not spend a second git call.
    await expect(readGitRepositoryState(root)).resolves.toEqual({
      kind: 'repository',
      branch: 'main',
      headSha: null
    })
  })

  it('hides the control outside a repository without reporting a failure', async () => {
    const plain = await temporaryDirectory('plain-')
    await expect(readGitRepositoryState(plain)).resolves.toEqual({ kind: 'not-repository' })
    await expect(listGitBranches(plain)).resolves.toEqual({ kind: 'not-repository' })
  })

  it.each([42, null, undefined, {}, '', 'relative/path'])(
    'rejects the malformed workspace path %j',
    async (value) => {
      await expect(readGitRepositoryState(value)).resolves.toEqual({ kind: 'not-repository' })
      await expect(listGitBranches(value)).resolves.toEqual({ kind: 'not-repository' })
      await expect(switchGitBranch(value, 'main')).resolves.toMatchObject({
        ok: false,
        reason: 'not-a-repository'
      })
    }
  )

  it('resolves a nested workspace to its repository root', async () => {
    const root = await createRepository()
    const nested = path.join(root, 'nested', 'deeper')
    await mkdir(nested, { recursive: true })
    await expect(readGitRepositoryState(nested)).resolves.toMatchObject({
      kind: 'repository',
      branch: 'main'
    })
    await expect(switchGitBranch(nested, 'main')).resolves.toEqual({
      ok: true,
      branch: 'main'
    })
  })

  it('lists local branches with the current branch first', async () => {
    const root = await createRepository()
    git(root, ['branch', 'feature/one'])
    git(root, ['branch', 'feature/two'])
    await expect(listGitBranches(root)).resolves.toEqual({
      kind: 'branches',
      current: 'main',
      branches: [
        { name: 'main', current: true },
        { name: 'feature/one', current: false },
        { name: 'feature/two', current: false }
      ]
    })
  })

  it('switches between existing local branches', async () => {
    const root = await createRepository()
    git(root, ['branch', 'feature'])
    await expect(switchGitBranch(root, 'feature')).resolves.toEqual({
      ok: true,
      branch: 'feature'
    })
    await expect(readGitRepositoryState(root)).resolves.toMatchObject({
      kind: 'repository',
      branch: 'feature'
    })
    await expect(listGitBranches(root)).resolves.toMatchObject({
      current: 'feature',
      branches: [
        { name: 'feature', current: true },
        { name: 'main', current: false }
      ]
    })
    await expect(switchGitBranch(root, 'main')).resolves.toEqual({ ok: true, branch: 'main' })
  })

  it('reports a missing branch instead of creating it', async () => {
    const root = await createRepository()
    const result = await switchGitBranch(root, 'never-existed')
    expect(result).toMatchObject({ ok: false, reason: 'branch-not-found' })
    await expect(listGitBranches(root)).resolves.toMatchObject({ current: 'main' })
  })

  it('creates a branch from HEAD and switches to it', async () => {
    const root = await createRepository()
    await expect(createGitBranch(root, 'topic/start')).resolves.toEqual({
      ok: true,
      branch: 'topic/start'
    })
    await expect(readGitRepositoryState(root)).resolves.toMatchObject({
      kind: 'repository',
      branch: 'topic/start'
    })
    // Creating the same branch again keeps the repository exactly as it was.
    await expect(createGitBranch(root, 'topic/start')).resolves.toEqual({
      ok: false,
      reason: 'branch-exists',
      detail: null
    })
    await expect(readGitRepositoryState(root)).resolves.toMatchObject({ branch: 'topic/start' })
  })

  it('refuses names git would reject and never touches HEAD', async () => {
    const root = await createRepository()
    await expect(createGitBranch(root, 'bad name')).resolves.toEqual({
      ok: false,
      reason: 'invalid-branch-name',
      detail: null
    })
    await expect(switchGitBranch(root, '-x')).resolves.toEqual({
      ok: false,
      reason: 'invalid-branch-name',
      detail: null
    })
    await expect(readGitRepositoryState(root)).resolves.toMatchObject({ branch: 'main' })
  })

  it('keeps uncommitted work when the switch would overwrite it', async () => {
    const root = await createRepository()
    git(root, ['branch', 'older'])
    await writeFile(path.join(root, 'notes.txt'), 'main-only\n')
    git(root, ['commit', '-am', 'main only'])
    await writeFile(path.join(root, 'notes.txt'), 'local edit\n')

    const result = await switchGitBranch(root, 'older')
    expect(result).toMatchObject({ ok: false, reason: 'worktree-changed' })
    expect(result.ok).toBe(false)
    if (!result.ok && result.detail !== null) {
      expect(result.detail).toContain('notes.txt')
    }
    await expect(readGitRepositoryState(root)).resolves.toMatchObject({ branch: 'main' })
  })

  it('reports the detached commit and lists branches without a current one', async () => {
    const root = await createRepository()
    git(root, ['switch', '--detach', 'HEAD'])
    const shortSha = git(root, ['rev-parse', '--short', 'HEAD'])
    await expect(readGitRepositoryState(root)).resolves.toEqual({
      kind: 'repository',
      branch: null,
      headSha: shortSha
    })
    await expect(listGitBranches(root)).resolves.toEqual({
      kind: 'branches',
      current: null,
      branches: [{ name: 'main', current: false }]
    })
  })

  it('supports an unborn repository before the first commit', async () => {
    const root = await temporaryDirectory('unborn-')
    git(root, ['init', '-b', 'main'])
    await expect(readGitRepositoryState(root)).resolves.toEqual({
      kind: 'repository',
      branch: 'main',
      headSha: null
    })
    await expect(listGitBranches(root)).resolves.toEqual({
      kind: 'branches',
      current: 'main',
      branches: [{ name: 'main', current: true }]
    })
  })

  it('ignores GIT_DIR inherited from the launching shell', async () => {
    const root = await createRepository()
    const bogus = path.join(home, 'not-a-repository')
    await mkdir(bogus, { recursive: true })
    const previous = process.env.GIT_DIR
    process.env.GIT_DIR = bogus
    try {
      await expect(readGitRepositoryState(root)).resolves.toMatchObject({
        kind: 'repository',
        branch: 'main'
      })
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previous
    }
  })
})
