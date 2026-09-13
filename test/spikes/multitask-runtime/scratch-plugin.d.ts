/**
 * Ambient types for the scratch debug plugin (`mt-t1-debug`, installed from
 * /tmp/mt-t1-debug-pkg via `npm install --no-save --install-links` — an
 * uncommitted node_modules change, never shipped). The package is plain JS;
 * this declaration is what lets the spike spec import it under strict TS.
 */
declare module 'mt-t1-debug' {
  /** One recorded handler execution (see the plugin's `executions` log). */
  export interface MtT1DebugExecution {
    childId: string
    messageId: string
    handoffText: string
    promptText: string
    at: string
  }

  /** Cordis plugin name (`mt-t1-debug`). */
  export const name: 'mt-t1-debug'
  /** Services required before apply(): the commands registry + subagent runtime. */
  export const inject: ['commands', 'subagents']
  /** Label stamped on every child the plugin spawns. */
  export const CHILD_LABEL: string
  /** Prefix of the followup text queued on the parent. */
  export const HANDOFF_PREFIX: string
  /** Register `/mt-t1-debug` on `ctx.commands`. */
  export function apply(ctx: import('@deepseek-ai/cordis').Context): void
  /** Drop and return everything recorded so far. */
  export function drainDebugLog(): MtT1DebugExecution[]
}
