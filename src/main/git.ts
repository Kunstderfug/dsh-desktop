import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  checkBranchName,
  type GitBranchesResult,
  type GitBranchResult,
  type GitBranchSummary,
  type GitRepositoryState,
  type GitOperationFailure
} from '../shared/git-contracts'

/**
 * Local git access for the composer's branch control.
 *
 * Everything here is a fixed `git` subcommand with an argument array: the
 * renderer supplies a workspace path and a branch name, never a command, and
 * nothing is ever passed through a shell. Only branches in the workspace's own
 * checkout are touched — no fetching, no tracking setup, no force, no stash.
 * Remote branches are deliberately out of scope for this control.
 */

const GIT_EXECUTABLE = 'git'
const GIT_TIMEOUT_MS = 15_000
const GIT_MAX_BUFFER = 1024 * 1024
const DETAIL_MAX_LENGTH = 2_000

/**
 * A variable such as `GIT_DIR` inherited from the launching shell would point
 * every command at a repository other than the session's workspace.
 */
const GIT_SCOPE_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX'
]

type GitRun =
  | { status: 'ok'; stdout: string }
  | { status: 'failed'; stderr: string }
  | { status: 'missing' }
  | { status: 'timeout' }

type RepositoryResolution =
  | { kind: 'repository'; root: string }
  | { kind: 'not-repository' }
  | { kind: 'git-unavailable' }
  | { kind: 'git-failed'; detail: string }

async function runGit(cwd: string, args: string[]): Promise<GitRun> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
    LANG: 'C'
  }
  for (const name of GIT_SCOPE_VARIABLES) delete env[name]
  return await new Promise<GitRun>((resolve) => {
    try {
      execFile(
        GIT_EXECUTABLE,
        args,
        {
          cwd,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
          windowsHide: true,
          encoding: 'utf8',
          env
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ status: 'ok', stdout })
            return
          }
          if (error.killed === true) {
            resolve({ status: 'timeout' })
            return
          }
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            resolve({ status: 'missing' })
            return
          }
          resolve({ status: 'failed', stderr: stderr === '' ? error.message : stderr })
        }
      )
    } catch (error) {
      resolve({ status: 'failed', stderr: error instanceof Error ? error.message : String(error) })
    }
  })
}

async function resolveDirectory(path: unknown): Promise<string | null> {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) return null
  try {
    return (await stat(path)).isDirectory() ? path : null
  } catch {
    // A missing path is not a repository the composer can offer; git would only
    // echo the same fact as a `fatal:` line.
    return null
  }
}

async function resolveRepository(path: unknown): Promise<RepositoryResolution> {
  const directory = await resolveDirectory(path)
  if (directory === null) return { kind: 'not-repository' }
  const topLevel = await runGit(directory, ['rev-parse', '--show-toplevel'])
  if (topLevel.status === 'missing') return { kind: 'git-unavailable' }
  if (topLevel.status === 'timeout') {
    return { kind: 'git-failed', detail: 'git rev-parse --show-toplevel timed out' }
  }
  if (topLevel.status !== 'ok') return { kind: 'not-repository' }
  const root = topLevel.stdout.trim()
  if (root === '') return { kind: 'not-repository' }
  return { kind: 'repository', root }
}

async function readCurrentBranch(root: string): Promise<string | null> {
  // `-q` keeps a detached HEAD quiet: exit 1 with no output instead of `fatal:`.
  const head = await runGit(root, ['symbolic-ref', '--short', '-q', 'HEAD'])
  if (head.status !== 'ok') return null
  const branch = head.stdout.trim()
  return branch === '' ? null : branch
}

async function readHeadSha(root: string): Promise<string | null> {
  // An empty repository has no commit to name; that is a state, not a failure.
  const head = await runGit(root, ['rev-parse', '--verify', '--short', 'HEAD'])
  if (head.status !== 'ok') return null
  const sha = head.stdout.trim()
  return sha === '' ? null : sha
}

function trimDetail(stderr: string): string | null {
  const detail = stderr.trim()
  if (detail === '') return null
  return detail.length > DETAIL_MAX_LENGTH ? `${detail.slice(0, DETAIL_MAX_LENGTH)}…` : detail
}

function classifyGitFailure(stderr: string): GitOperationFailure {
  const text = stderr.toLowerCase()
  if (text.includes('not a git repository')) return 'not-a-repository'
  if (text.includes('already exists')) return 'branch-exists'
  if (
    text.includes('would be overwritten') ||
    text.includes('your local changes') ||
    text.includes('please commit your changes or stash them') ||
    text.includes('please move or remove them')
  ) {
    return 'worktree-changed'
  }
  if (
    text.includes('cannot switch branch while') ||
    text.includes('cannot checkout branch') ||
    text.includes('while merging') ||
    text.includes('while rebasing') ||
    text.includes('while cherry-picking') ||
    text.includes('while reverting')
  ) {
    return 'operation-in-progress'
  }
  if (
    text.includes('invalid reference') ||
    text.includes('did not match any file') ||
    text.includes('did not match any') ||
    text.includes('pathspec')
  ) {
    return 'branch-not-found'
  }
  return 'git-failed'
}

function failed(
  reason: GitOperationFailure,
  detail: string | null = null
): Extract<GitBranchResult, { ok: false }> {
  return { ok: false, reason, detail }
}

function failedFromResolution(
  resolution: Exclude<RepositoryResolution, { kind: 'repository' }>
): Extract<GitBranchResult, { ok: false }> {
  if (resolution.kind === 'not-repository') return failed('not-a-repository')
  if (resolution.kind === 'git-unavailable') return failed('git-unavailable')
  return failed('git-failed', resolution.detail)
}

function failedFromRun(run: Exclude<GitRun, { status: 'ok' }>): Extract<GitBranchResult, { ok: false }> {
  if (run.status === 'missing') return failed('git-unavailable')
  if (run.status === 'timeout') return failed('git-failed', `git did not finish within ${GIT_TIMEOUT_MS} ms`)
  return failed(classifyGitFailure(run.stderr), trimDetail(run.stderr))
}

/** Reads the branch the composer should show for a session's working directory. */
export async function readGitRepositoryState(path: unknown): Promise<GitRepositoryState> {
  const resolution = await resolveRepository(path)
  if (resolution.kind === 'not-repository') return { kind: 'not-repository' }
  if (resolution.kind === 'git-unavailable') return { kind: 'git-unavailable' }
  if (resolution.kind === 'git-failed') return { kind: 'not-repository' }
  const branch = await readCurrentBranch(resolution.root)
  const headSha = branch === null ? await readHeadSha(resolution.root) : null
  return { kind: 'repository', branch, headSha }
}

/** Lists local branches, newest state first: the current branch leads the menu. */
export async function listGitBranches(path: unknown): Promise<GitBranchesResult> {
  const resolution = await resolveRepository(path)
  if (resolution.kind === 'not-repository') return { kind: 'not-repository' }
  if (resolution.kind === 'git-unavailable') return { kind: 'git-unavailable' }
  if (resolution.kind === 'git-failed') return { kind: 'git-failed', detail: resolution.detail }

  const root = resolution.root
  const current = await readCurrentBranch(root)
  const listing = await runGit(root, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads'
  ])
  if (listing.status === 'missing') return { kind: 'git-unavailable' }
  if (listing.status === 'timeout') {
    return { kind: 'git-failed', detail: `git for-each-ref did not finish within ${GIT_TIMEOUT_MS} ms` }
  }
  if (listing.status === 'failed') {
    return { kind: 'git-failed', detail: trimDetail(listing.stderr) ?? 'git for-each-ref failed' }
  }

  const branches = listing.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((name): GitBranchSummary => ({ name, current: name === current }))
  if (current !== null && !branches.some((branch) => branch.current)) {
    // The branch exists only as HEAD: an empty repository has no ref for it yet.
    branches.unshift({ name: current, current: true })
  }
  if (current !== null) {
    branches.sort((left, right) => Number(right.current) - Number(left.current))
  }
  return { kind: 'branches', current, branches }
}

async function updateHead(
  root: string,
  name: string,
  mode: 'switch' | 'create'
): Promise<GitBranchResult> {
  if (mode === 'create') {
    const existing = await runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
    if (existing.status === 'ok') return failed('branch-exists')
    if (existing.status === 'missing') return failed('git-unavailable')
    if (existing.status === 'timeout') {
      return failed('git-failed', `git rev-parse did not finish within ${GIT_TIMEOUT_MS} ms`)
    }
    // Exit 1 is the expected "no such branch"; anything else falls through to
    // `switch -c`, which reports the real reason.
  }

  const primary = mode === 'create' ? ['switch', '-c', name] : ['switch', '--no-guess', name]
  let result = await runGit(root, primary)
  if (result.status === 'failed' && /is not a git command|unknown switch|unknown option/i.test(result.stderr)) {
    // `git switch` arrived in 2.23; the checkout spelling is equivalent here.
    result = await runGit(root, mode === 'create' ? ['checkout', '-b', name] : ['checkout', name])
  }
  if (result.status !== 'ok') return failedFromRun(result)
  return { ok: true, branch: name }
}

/** Switches the workspace to an existing local branch. */
export async function switchGitBranch(path: unknown, branch: unknown): Promise<GitBranchResult> {
  const check = checkBranchName(branch)
  if (!check.ok) return failed('invalid-branch-name')
  const resolution = await resolveRepository(path)
  if (resolution.kind !== 'repository') return failedFromResolution(resolution)
  return await updateHead(resolution.root, check.name, 'switch')
}

/** Creates a local branch from the current HEAD and switches to it. */
export async function createGitBranch(path: unknown, branch: unknown): Promise<GitBranchResult> {
  const check = checkBranchName(branch)
  if (!check.ok) return failed('invalid-branch-name')
  const resolution = await resolveRepository(path)
  if (resolution.kind !== 'repository') return failedFromResolution(resolution)
  return await updateHead(resolution.root, check.name, 'create')
}
