/**
 * Serializable contracts for the composer's git branch control.
 *
 * The renderer never runs git. The main process resolves the repository, lists
 * the local branches and performs the two mutations, so every result is a
 * tagged union: the UI maps `kind` / `reason` to its own localized copy instead
 * of parsing git's stderr. Nothing here imports Electron or Node APIs; the
 * branch-name rules live here so the dialog and the main process agree on what
 * is obviously invalid while the main process stays the only authority.
 */

/** The state the composer chip needs; it never carries the repository's root. */
export type GitRepositoryState =
  | { kind: 'repository'; branch: string | null; headSha: string | null }
  | { kind: 'not-repository' }
  | { kind: 'git-unavailable' }

export interface GitBranchSummary {
  name: string
  current: boolean
}

export type GitBranchesResult =
  | { kind: 'branches'; current: string | null; branches: GitBranchSummary[] }
  | { kind: 'not-repository' }
  | { kind: 'git-unavailable' }
  | { kind: 'git-failed'; detail: string }

export type GitOperationFailure =
  | 'git-unavailable'
  | 'not-a-repository'
  | 'invalid-branch-name'
  | 'branch-exists'
  | 'branch-not-found'
  | 'worktree-changed'
  | 'operation-in-progress'
  | 'git-failed'

export type GitBranchResult =
  | { ok: true; branch: string }
  | { ok: false; reason: GitOperationFailure; detail: string | null }

export type BranchNameProblem = 'empty' | 'reserved' | 'invalid'

export type BranchNameCheck = { ok: true; name: string } | { ok: false; reason: BranchNameProblem }

/**
 * `refs/heads/...` accepts more than the composer allows, but the dialog only
 * needs to reject what a person can reasonably type by accident. Git itself
 * still decides the final word; this check exists so the common mistakes get
 * localized copy instead of a raw `fatal:` line.
 */
const BRANCH_NAME_MAX_LENGTH = 255
const FORBIDDEN_CHARACTERS = /[\u0000-\u0020\u007f~^:?*\[\\]/

export function checkBranchName(value: unknown): BranchNameCheck {
  if (typeof value !== 'string') return { ok: false, reason: 'empty' }
  const name = value.trim()
  if (name === '') return { ok: false, reason: 'empty' }
  if (name.length > BRANCH_NAME_MAX_LENGTH) return { ok: false, reason: 'invalid' }
  // `git switch` and `git checkout` read a leading dash as an option.
  if (name.startsWith('-')) return { ok: false, reason: 'reserved' }
  if (name === '@' || name === 'HEAD') return { ok: false, reason: 'reserved' }
  if (FORBIDDEN_CHARACTERS.test(name)) return { ok: false, reason: 'invalid' }
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) {
    return { ok: false, reason: 'invalid' }
  }
  if (name.includes('//') || name.includes('..') || name.includes('@{')) {
    return { ok: false, reason: 'invalid' }
  }
  if (name.endsWith('.lock')) return { ok: false, reason: 'invalid' }
  const components = name.split('/')
  if (components.some((component) => component === '' || component.startsWith('.'))) {
    return { ok: false, reason: 'invalid' }
  }
  if (components.some((component) => component.endsWith('.lock'))) {
    return { ok: false, reason: 'invalid' }
  }
  return { ok: true, name }
}
