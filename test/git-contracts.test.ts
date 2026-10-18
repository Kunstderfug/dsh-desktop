import { describe, expect, it } from 'vitest'
import { checkBranchName } from '../src/shared/git-contracts'

/**
 * The composer dialog uses this check for instant, localized feedback. The
 * main process repeats it before touching the repository, so both sides must
 * agree on what is obviously invalid; git remains the final authority for the
 * rest (for example a name that collides with a tag's reflog rules).
 */
describe('checkBranchName', () => {
  it.each([undefined, null, 42, {}, ['x'], 0, true])(
    'treats %j as an empty name',
    (value) => {
      expect(checkBranchName(value)).toEqual({ ok: false, reason: 'empty' })
    }
  )

  it.each(['', '   ', '\t\n'])('treats whitespace-only %j as an empty name', (value) => {
    expect(checkBranchName(value)).toEqual({ ok: false, reason: 'empty' })
  })

  it('accepts ordinary local branch names and trims surrounding space', () => {
    expect(checkBranchName('main')).toEqual({ ok: true, name: 'main' })
    expect(checkBranchName('feature/login-2')).toEqual({ ok: true, name: 'feature/login-2' })
    expect(checkBranchName('release/1.2_hotfix')).toEqual({
      ok: true,
      name: 'release/1.2_hotfix'
    })
    expect(checkBranchName('  feature/x  ')).toEqual({ ok: true, name: 'feature/x' })
  })

  it.each(['-x', '--orphan', '@', 'HEAD'])('reserves the option-like or revision name %j', (value) => {
    expect(checkBranchName(value)).toEqual({ ok: false, reason: 'reserved' })
  })

  it.each([
    'a b',
    'a\tb',
    'a[b',
    'a\\b',
    'a~b',
    'a^b',
    'a:b',
    'a?b',
    'a*b',
    'a\x7fb',
    'a\x00b'
  ])('rejects the character git refuses in %j', (value) => {
    expect(checkBranchName(value)).toEqual({ ok: false, reason: 'invalid' })
  })

  it.each([
    '/leading',
    'trailing/',
    'trailing.',
    'double//slash',
    'two..dots',
    'brace@{1}',
    'name.lock',
    'nested/name.lock',
    '.hidden',
    'nested/.hidden',
    'nested//empty'
  ])('rejects the ref-format violation in %j', (value) => {
    expect(checkBranchName(value)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects names past the ref-length ceiling and accepts the boundary', () => {
    const longest = 'a'.repeat(255)
    expect(checkBranchName(longest)).toEqual({ ok: true, name: longest })
    expect(checkBranchName('a'.repeat(256))).toEqual({ ok: false, reason: 'invalid' })
  })
})
