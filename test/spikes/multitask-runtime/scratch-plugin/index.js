/**
 * [multitask ticket #1 spike] scratch cordis plugin — NOT shipped.
 *
 * Vendored in-repo at `test/spikes/multitask-runtime/scratch-plugin/`
 * (review round 2): a committed spec must resolve its imports at any fresh
 * checkout, so `scratch-debug-plugin.test.ts` imports this copy by relative
 * path instead of the uncommitted node_modules install of the /tmp scratch
 * package (`/tmp/mt-t1-debug-pkg`) that the live-session overlay mount used.
 * This file is that same module, byte-for-byte in behavior.
 *
 * Registers one debug slash command, `/mt-t1-debug`, on the real
 * `@deepseek-ai/dsh-commands` registry (`ctx.commands`). The handler is the
 * host-side shape the ticket asks for:
 *
 *   1. spawn a continuable background child with no model tool-call:
 *      `ctx.subagents.startContinuable({ provider: 'spawn', … })` — the child
 *      inherits the parent's provider/model when `agentOptions` is omitted
 *      (`resolveChildAgentOptions`, dsh-subagent), so in the real dev app it
 *      runs the live model;
 *   2. queue a handoff on the parent without touching any running turn:
 *      `agent.followup(...)` — next-turn splice, consumed at the turn
 *      boundary by the loop's kick driver.
 *
 * Plugin shape follows `@deepseek-ai/dsh-command-goal` (name / inject /
 * apply, registering through `ctx.commands.register`). `inject` guarantees
 * both the commands registry and the subagent runtime exist before apply().
 *
 * The single runtime import, `@deepseek-ai/dsh-llm`, is provided by the host
 * repo's own node_modules (the declared version matches the root pin); no
 * install step exists or is needed for this vendored copy.
 *
 * @module mt-t1-debug
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Cordis plugin name (loader row id `mt-t1-debug`). */
const name = 'mt-t1-debug'

/** Both services the handler composes must exist before apply runs. */
const inject = ['commands', 'subagents']

/** Label stamped on every child this plugin spawns. */
export const CHILD_LABEL = 'mt-t1-debug continuable child'

/** Prefix of the followup text queued on the parent. */
export const HANDOFF_PREFIX = 'mt-t1-debug handoff'

/** Default child prompt when the command line carries no input. */
const DEFAULT_PROMPT = 'mt-t1-debug default research prompt: summarize the multitask runtime spike'

/**
 * Module-level bookkeeping of every handler execution, newest last. Exists so
 * the in-process vitest spec (and a curious operator over CDP) can assert on
 * what the handler did without re-reading session logs. Drained via
 * {@link drainDebugLog}; never persisted anywhere.
 * @type {Array<{ childId: string, messageId: string, handoffText: string, promptText: string, at: string }>}
 */
const executions = []

/**
 * Drop everything recorded so far and return it.
 * @returns {Array<{ childId: string, messageId: string, handoffText: string, promptText: string, at: string }>}
 */
export function drainDebugLog() {
  return executions.splice(0)
}

/**
 * The `/mt-t1-debug` handler: spawn + followup, then a direct UI result.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context providing `subagents`
 * @param {import('@deepseek-ai/dsh-commands').CommandInvocation} invocation registry invocation
 * @returns {Promise<import('@deepseek-ai/dsh-commands').CommandResult>}
 */
async function execute(ctx, invocation) {
  const promptText = invocation.rawInput.trim() !== '' ? invocation.rawInput.trim() : DEFAULT_PROMPT
  const parent = invocation.agent

  // (1) Host-side continuable spawn — no model tool-call involved. The child
  // starts its own initial turn on the prompt above.
  const start = await ctx.subagents.startContinuable({
    provider: 'spawn',
    label: CHILD_LABEL,
    request: {
      prompt: [{ type: 'text', text: promptText }],
      parent
    },
    signal: invocation.signal
  })

  // (2) Queue the handoff on the parent. followup() is the non-interrupting
  // next-turn seam: a running turn keeps running; an idle parent is woken.
  const handoffText = `${HANDOFF_PREFIX}: orchestrate while the child works (child ${start.childId})`
  parent.followup(createUserMessage({
    content: [{ type: 'text', text: handoffText }],
    source: { kind: 'user' }
  }))

  executions.push({
    childId: String(start.childId),
    messageId: String(start.messageId),
    handoffText,
    promptText,
    at: new Date().toISOString()
  })

  return {
    kind: 'success',
    text: `spawned continuable child ${start.childId} (message ${start.messageId}); queued followup "${handoffText}"`
  }
}

/**
 * Cordis apply: register the debug command on the real commands registry.
 * @param {import('@deepseek-ai/cordis').Context} ctx host context
 */
function apply(ctx) {
  ctx.commands.register({
    name: 'mt-t1-debug',
    description: '[multitask spike] spawn a continuable child and queue a parent followup',
    input: { hint: '[<prompt for the continuable child>]' },
    handler: (invocation) => execute(ctx, invocation)
  })
}

export { apply, inject, name }
