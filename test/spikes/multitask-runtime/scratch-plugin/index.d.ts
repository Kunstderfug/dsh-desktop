/**
 * Types for the vendored scratch debug plugin (`./index.js`, plain JS).
 * This adjacent declaration is what lets `scratch-debug-plugin.test.ts`
 * import the module by relative path under strict TS.
 */
export interface MtT1DebugExecution {
  /** Durable id of the spawned continuable child. */
  childId: string
  /** Durable id of the child's initial queued message. */
  messageId: string
  /** Followup text queued on the parent. */
  handoffText: string
  /** Prompt handed to the child. */
  promptText: string
  /** ISO timestamp of the handler execution. */
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
