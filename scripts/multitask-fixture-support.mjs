/**
 * Shared fixture seams for the standalone `check-multitask-*` scripts.
 *
 * Harness 0.2.1 makes `SubagentRuntime` inject `workingDirectory`, whose real
 * provider needs `fs`, `sessionProjections`, and `systemPrompt`. These scripts
 * exercise the multitask plugin and the subagent seams, not directory changes,
 * so they mount a fixed-directory stub instead of the full provider chain.
 *
 * @module scripts/multitask-fixture-support
 */

/**
 * Cordis plugin providing `workingDirectory` over one fixed directory.
 *
 * Pass the directory as the plugin config: `ctx.plugin(workingDirectoryStub, dir)`.
 */
export const workingDirectoryStub = {
  name: 'multitask-script-working-directory',
  apply(ctx, directory) {
    ctx.provide('workingDirectory', {
      get: () => directory,
      ensure: async () => directory,
      set: async (_agent, next) => (next.startsWith('/') ? next : `${directory}/${next}`)
    })
  }
}
