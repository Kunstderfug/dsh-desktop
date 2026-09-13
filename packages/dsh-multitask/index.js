/**
 * Host half of the [multitask] scaffold (issue #3).
 *
 * This package is the permanent mount target of every later multitask
 * ticket. Its entire feature surface today is one startup line: the
 * composed desktop profile loads this plugin through the
 * `build/dsh-desktop.patch.yml` insert row, and the line in the Harness
 * output is the observable proof that the mount came up.
 *
 * No commands, no events, no claims logic — those land in later tickets.
 *
 * @module dsh-multitask
 */

/** Stable Cordis plugin name. */
export const name = 'dsh-multitask'

/**
 * Log the scaffold startup line.
 *
 * Written straight to the Harness process stdout so it lands in the
 * desktop's `harness.log`, where `scripts/check-multitask-mount.mjs`
 * greps for it.
 *
 * @param ctx - Host context. Unused by the scaffold.
 */
export function apply(ctx) {
  void ctx
  console.log('[multitask] plugin active')
}
