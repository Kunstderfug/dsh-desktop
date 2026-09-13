# Multitask spike — runtime composition findings (t1c-runtime-spike)

Epic issue #1, Phase 0 spike. Question: can the real installed Harness
(`@deepseek-ai/*@0.1.5-rc.2`) already compose the §5.2 lifecycle — continuable
children, settlement wake, non-interrupting handoffs, steer, restart
durability — from plugin-reachable seams, with only the MODEL scripted?

Method: `test/spikes/multitask-runtime/multitask-runtime-spike.test.ts` composes
real services in one cordis Context in vitest (no network): SystemPrompt,
SessionProjectionRegistry, SessionStore, ToolRuntime, LlmRuntime (with a
scripted `LlmAdapter` registered through the real `llm.registerAdapter`), JSONL
session persistence, AgentRegistry, AgentLoop, SubagentRuntime +
spawn-in-process provider, SessionQueryEngine. Every behavior under test —
inbox, spawn, settlement, persistence — is the production code path. Gate:
`python3 test/spikes/multitask-runtime/gate.py --filter multitask_runtime_spike`.
All seven specs pass; `VERDICT: go` at the end. Correction round 1 added
`test/spikes/multitask-runtime/scratch-debug-plugin.test.ts` (three more
specs: the ticket's scratch debug plugin driven through the real
`@deepseek-ai/dsh-commands` registry dispatch) and the live dev-app evidence
under `test/spikes/multitask-runtime/evidence/` — see "Real dev-app
observation" below.

Composition order (worked first try once the ordering below was used; this is
the answer to the trap that stalled t1/t1b — the `llm` service must exist
before anything effects it, and the scripted adapter must be registered through
the real registry):

```
SystemPrompt → SessionProjectionRegistry → SessionStore → ToolRuntime
→ LlmRuntime → {inject:['llm']} adapter plugin (ctx.llm.registerAdapter)
→ JsonlSessionPersistence → AgentRegistry → AgentLoop → SubagentRuntime
→ dsh-subagent-spawn-in-process → SessionQueryEngine
```

Parent and child are real loop-driven agents (`ctx.agents.create` /
`resume`); the child route overrides the model id via
`startContinuable`'s `request.agentOptions` (`model: 'researcher'` vs the
parent's `'orchestrator'`), which is what makes scripted parent/child scripts
distinguishable at the adapter.

## Behavior 1 — continuable spawn from a host plugin (spec §4.2)

**OBSERVED.** `ctx.subagents.startContinuable({ provider: 'spawn', label,
request: { prompt, parent, agentOptions }, signal })` establishes a durable
child and resolves `{ childId, messageId }` at initial inbox acceptance
(`node_modules/@deepseek-ai/dsh-subagent/lib/index.js:1643` `SubagentContinuationManager.startContinuable`,
exposed at `:2881` on `SubagentRuntime`). The child is materialized through the
real agent factory (`node_modules/@deepseek-ai/dsh-subagent/lib/index.js:1060` `materializeTracked` → `:1077` `agents.create`),
stamped `origin: 'subagent'` + `parentSession` + `delegationDepth`
(`childSessionMeta`, `:502`), and its initial prompt is delivered with
`delivery: "queue"` — the child starts its own turn with no driver code. After
the child's turn ends with an empty inbox, the activation settles and
`ctx.subagents.listChildren(parentId)` lists it from the durable `subagent`
projection with `{ kind: 'child', mode: 'continuable', label, activity:
'inactive' }` (`node_modules/@deepseek-ai/dsh-subagent/lib/index.js:2071` `listChildren`, public at
`:2981`). A hard composition fact the spec omits: `startContinuable` requires a
session-persistence backend (`node_modules/@deepseek-ai/dsh-subagent/lib/index.js:1959` `requirePersistence` → `PERSISTENCE_UNAVAILABLE`)
and `listChildren` requires `@deepseek-ai/dsh-session-query` (`node_modules/@deepseek-ai/dsh-subagent/lib/index.js:2111`),
plus `sessionProjections` and the session store (`node_modules/@deepseek-ai/dsh-subagent/lib/index.js:2105-2109`).

## Behavior 2 — the settlement notice wakes an idle parent (spec §4.2, §5.2)

**OBSERVED.** The parent was never prompted; when the child settled, the
runtime delivered a `user/message` with source
`{ kind: 'subagent-settled', form: 'notice', senderSessionId: <childId> }`
into the parent's session and inbox — `createSettlementMessage`
(`node_modules/@deepseek-ai/dsh-subagent/lib/index.js:661`), delivered via `sendWaking(parent, message,
parent.status === 'idle' ? 'queue' : 'steer')` (`node_modules/@deepseek-ai/dsh-subagent/lib/index.js:1255`), i.e. the idle parent
got a `next-turn` splice. The durable `agent/inbox/spliced` event records
`target: 'next-turn'` (append site `dsh-agent-loop/lib/index.js:206`), and the
parent then **started and finished a turn on its own** — no poller, no test
kick; the model-facing request of that wake turn contains the notice text
("finished and will do no further work …"). The notice also carries the child's
closing message ("Its closing message: …") built from the child's final
assistant output — this is more than the "summary" the spec promises (§4.2 says
"the notice carries a **summary**, not the full research payload"); a child
that ends its turn with a structured report effectively delivers the payload
for free. The summary wording per stop reason is `settlementSummary`
(`node_modules/@deepseek-ai/dsh-subagent/lib/index.js:641`).

## Behavior 3 — queued followup never interrupts a running turn (spec §2.1/§2.2/§4.1/§5.2)

**OBSERVED.** With the parent's turn 1 held open mid-model-call (abort-aware
gate in the scripted adapter), a host-style `agent.followup(handoff)`:
(a) left `agent.status === 'running'` and `turn/start` count at 1;
(b) parked the handoff in the durable `next-turn` queue (splice event `target:
'next-turn'`; live `agent.inbox.nextTurn`);
(c) never appeared in any model request of the running turn; and
(d) after the held step finished, the loop's kick driver consumed it as turn 2
automatically. Seams: `followup` → `send(input, 'next-turn', true)`
(`node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:789`), turn consumption loop `kick` (`node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:870`) with
the boundary check "pending work ⇒ another turn" (`turn()` tail), claim at
`agent/inbox/claimed` (`node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:104-107`). This is exactly the §2.2 "queued turns are
picked up immediately after the current turn" claim, now proven in-composition.
The same routing is what `session.prompt(content, 'queue')` reaches in
production (`node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js:828-829` —
`mode === 'steer' ? agent.steer(...) : agent.followup(...)`); the spike drives
the loop-level seam directly because the controller surface adds only wire
plumbing around it.

## Behavior 4 — steers the settlement notice into a running turn at the step boundary (spec §2.1/§4.2)

**OBSERVED.** With turn 1 held open, a child settled mid-turn: the settlement
notice was spliced with `target: 'next-step'` (the running-parent arm of
`dsh-subagent/lib/index.js:1255`), and when the held step finished the SAME
turn continued with a further step whose claimed input was the notice —
`turn/start` count stayed 1, two parent model calls total, no idle gap. Loop
mechanics: `steer` → `send(input, 'next-step', true)`
(`node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:792`); after each step the turn loop continues
while `inbox.nextStep.length > 0` and consults the `agent/turn-stopping`
waterfall only when no steer is pending (`node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:967`). A second in-turn delivery
path exists for model-authored adjacency (`sendWaking(parent, …, 'steer')` from
`sendMessage`, `dsh-subagent/lib/index.js:1842`) — not exercised here.

## Behavior 5 — injects the settlement notice without waking during teardown (spec §4.2)

**OBSERVED.** With the child's turn still in flight, disposing the
SubagentRuntime fiber drains the activation graph (`drain`,
`dsh-subagent/lib/index.js:891`; effect wiring `:804`) and the settlement
notice was **injected** into the parent's `next-step` inbox without waking a
turn: `parent.status` stayed `'idle'`, zero parent model calls, and nothing was
appended to the parent's session log (inject splices the inbox only;
`notifySettlement` inject branch `dsh-subagent/lib/index.js:1252` vs the waking
branch `:1255`). This matches the spec's "injected during teardown, else
sendWaking(...)" precisely, and shows the notice is never lost across teardown.

## Behavior 6 — restart durability over a persisted home (spec §4.1/§4.2/§5.4)

**OBSERVED**, with one boundary the spec's wording glosses over (DEVIATES-nuance
below). Session 1: held turn, `followup(handoff)` queued behind it, child
settled while running (steered notice), then `parent.cancel({kind:'user'},
{keepInbox: true})`. Session 2 recomposed a fresh stack over the same JSONL
home and `ctx.agents.resume`d the parent:
(a) the durable inbox fold restored BOTH pending inputs — the queued handoff in
`next-turn` and the steered notice in `next-step` — because every splice is a
durable `agent/inbox/spliced` session event (`node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:206`,
folded by the inbox projection reducer `:34-52`, read back through
`ReactLoopInbox.current()` → `sessionProjections.stateOf(session, 'inbox')`);
(b) `listChildren` discovered the settled child from persistence without
loading it (`activity: 'inactive'`);
(c) the next parent wake consumed the durable backlog first (notice + handoff
as turn input);
(d) the settled child cold-resumed from persistence via the real
`ctx.subagents.sendMessage(parent, childId, …)` seam
(`node_modules/@deepseek-ai/dsh-subagent/lib/index.js:1734`, cold resume through `materializeTracked` →
`agents.resume` `:1071`), ran the new prompt, and settled again with a fresh
notice to the recomposed parent. Live-append durability itself is the
persistence backend's session-event routing
(`node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js:407-409` → `enqueueLive` `:185`),
drained at handle close.

**DEVIATES (boundary, not blocker).** Spec §4.1: "Inbox is durable: queued
handoffs survive restarts." True for **crash-style** restarts only. The
graceful agent disposal behaves differently: a
*graceful* teardown of the loop (which is what an app quit does) durably
CLEARs pending input: agent disposal runs `machine.cancel({ kind: 'disposed' })`
without `keepInbox` → `inbox.clear()` → clearing splices with
`outcome: 'canceled'` appended to the log
(`node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:1656` dispose chain → `:800` `cancel` →
`:796-799` `clear()`), and the recomposed fold honors them — the queued handoff
is gone after recomposition (proved by its own spec). Two corollaries that cost
debugging time, recorded here for the implementers: cordis tears down dependent
fibers when a service they inject disappears, so disposing
`AgentRegistry`/`SessionStore`/`LlmRuntime`/`ToolRuntime`/`SystemPrompt`/
`SessionProjectionRegistry` cascades to the AgentLoop fiber and triggers the
graceful clear; and the multitask driver therefore cannot rely on graceful
teardown to preserve a queued `/multitask` handoff across an app restart.
If v1 wants handoffs to survive a normal quit, it needs either a
keepInbox-aware disposal path in the loop (upstream patch — not
plugin-reachable) or durable handoff records outside the inbox (plugin-level,
e.g. re-queue from a multitask projection on compose). This matches the report
duty: the queue mechanism is real; its crash-only persistence is the finding.

## Deviations and observations vs spec §4.1/§4.2

1. **§4.1 "queued handoffs survive restarts" — DEVIATES as an unconditional
   claim** (see Behavior 6): true across crash-style restarts; a graceful loop
   disposal durably clears the inbox. Everything else in §4.1's submission
   pipeline deep-dive verified as stated (`session.prompt` routing at
   `dsh-api-session-controller/lib/index.js:828-829`; subagent session fencing
   not re-tested here — out of spike scope).
2. **§4.2 "the notice carries a summary, not the full research payload" —
   OBSERVED-with-nuance:** the notice ALSO carries the child's closing message
   blocks (`createSettlementMessage`, `dsh-subagent/lib/index.js:661`), so the
   payload arrives whenever the child ends with it; `send_message` remains the
   route for anything longer than the final turn output.
3. **§4.2 subagent runtime details — OBSERVED, plus two unstated composition
   requirements:** continuable children hard-require a session-persistence
   backend (`node_modules/@deepseek-ai/dsh-subagent/lib/index.js:1959`), and `listChildren`/cold resume hard-require
   `@deepseek-ai/dsh-session-query` (`node_modules/@deepseek-ai/dsh-subagent/lib/index.js:2111`). Both are plain `ctx.plugin`
   loads — no patching needed — but t2/t3 must include them in the bundle
   checklist.
4. **§2.2 "agent/status published on every phase transition" — OBSERVED
   indirectly:** the wake test relies on the idle→running→idle transitions the
   loop publishes (`node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:781`).
5. **Dev-app channel — was UNAVAILABLE in the original delivery, now
   performed; the literal `npm run dev` + scratch-DSH_HOME channel DEVIATES to
   a documented structural blocker while the harness-entry lane is OBSERVED**
   (both lanes, with captured evidence, in "Real dev-app observation" below).
   Still not exercised (legitimate scope cuts): `toolFilter`/persona
   composition, workflow children, one-shot runs, and the plan-mode
   mode-switch — none are required to answer the §5.2 runtime question.

## Real dev-app observation (correction round 1)

The original delivery left the dev-app channel UNAVAILABLE (item 5 below).
The correction round performed it for real, in two parts.

**The ticket's scratch debug plugin (P2) — OBSERVED.**
`/tmp/mt-t1-debug-pkg` (package `mt-t1-debug`, uncommitted) is a cordis plugin
following the `@deepseek-ai/dsh-command-goal` shape (`name`/`inject`/`apply`)
whose `apply` registers ONE debug command on the real registry:
`ctx.commands.register({ name: 'mt-t1-debug', … handler })` — the
plugin-reachable command API (`@deepseek-ai/dsh-commands`, mounted by the
`dsh-base` bundle at `node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:287`,
`CommandRuntime.register` at
`node_modules/@deepseek-ai/dsh-commands/lib/index.js:546`). The handler does
exactly the ticket's two moves: `ctx.subagents.startContinuable({ provider:
'spawn', label, request: { prompt, parent } })` (child inherits the parent's
model when `agentOptions` is omitted — `resolveChildAgentOptions`,
`node_modules/@deepseek-ai/dsh-subagent/lib/index.js:468`), then
`agent.followup(createUserMessage(...))` on the parent
(`node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:789`). It is installed
into this worktree's node_modules with `npm install --no-save --install-links
file:/tmp/mt-t1-debug-pkg` (uncommitted node_modules change) and driven
in-process by `test/spikes/multitask-runtime/scratch-debug-plugin.test.ts`
through the registry's real dispatch path (`ctx.commands.execute(agent, line,
[], signal)` — including the `command/run`/`command/done` lifecycle events the
registry itself appends): three green specs covering catalog listing,
spawn+queue+settle end-to-end, and the non-interrupting queue behind a
running turn. (Review-round-2 note on location/mount: the in-process spec now
imports the plugin vendored in-repo at
`test/spikes/multitask-runtime/scratch-plugin/` — a committed copy of this
same module, resolved by relative path — because a committed test must not
depend on an uncommitted node_modules package, while the live-session overlay
mount described below still used the scratch `/tmp` package.)

**`npm run dev` + scratch DSH_HOME — structurally blocked (documented with
log excerpts).** The brief asked for `npm run dev` with a scratch DSH_HOME.
That combination is impossible with committed code: on macOS Electron resolves
`appData`/`logs` from the real user paths regardless of `$HOME`, and the
desktop pins the harness child's `DSH_HOME` to `userData/harness`
(`configureAppIdentity`, `src/main/index.ts:504-508`;
`buildHarnessSpawnOptions` overrides any inherited `DSH_HOME`,
`src/main/runtime/harness-runtime.ts:283-312`). The probe boot
(`HOME=/tmp/mt-t1-scratch-home/host REMOTE_DEBUGGING_PORT=9226 npm run dev`)
produced `[harness-node] DSH_HOME=/Users/slav/Library/Application Support/
dsh-desktop-dev/harness` — the shared dev home — plus normal shared-home
maintenance lines ("previous Harness stopped", "cleared 1 stale Harness
authentication cookie(s)"). Full excerpt:
`test/spikes/multitask-runtime/evidence/dev-boot-shared-home-excerpt.txt`.
The boot was killed immediately after this became visible; the residual
contact is the desktop's ordinary dev-home maintenance, reported here
honestly.

**Live session in the real composed harness — OBSERVED.** The compliant lane
boots the SAME harness entry the desktop spawns (`node
node_modules/@deepseek-ai/dsh/lib/bin.js web --patch build/dsh-desktop.patch.yml
--no-open --host 127.0.0.1 --port 43140` — the repo's own
`scripts/verify-harness-auth.mjs` precedent) with `DSH_HOME` pointing at the
scratch copy of the dev profile. The scratch profile's `cordis.patch.yml`
gained the overlay row (`- insert: [{id: mt-t1-debug, name: mt-t1-debug}]`)
ONLY there; the package itself was copied into the scratch profile's
`node_modules/` (the loader resolves plugin names from the profile directory —
`createRequire(baseUrl).resolve`, `node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js:288-296`).
The boot composed the full desktop stack ("[multitask] plugin active") and
served `dsh web: http://127.0.0.1:43140/?token=…`; the pnpm shim write landed
inside the scratch home (isolation proof). Evidence:
`test/spikes/multitask-runtime/evidence/harness-boot-stdout-excerpt.txt`.

The live session (`session-e7c29cbe-aa51-4369-adbf-09ce369de541`) was driven
over the harness's authenticated `/api` channel exactly like the web client
(token → cookie → POST `/api/<namespace>/<method>`). Captured transcript:
`test/spikes/multitask-runtime/evidence/live-session-catalog-and-execution.json`.
What the real app showed:

1. **The scratch plugin mounted and the command is discoverable** —
   `commands/list` returned a 7-command catalog including `mt-t1-debug`.
2. **Host-side continuable spawn from the debug command (spec §4.2)** —
   `commands/execute` returned `{ kind: 'success', text: "spawned continuable
   child 0b26692d-d41e-4cec-9a82-05bc01c066e2 …" }`; the durable parent log
   gained `subagent/catalog` at seq 4: `{ childId:
   "0b26692d-…", mode: 'continuable', label: 'mt-t1-debug continuable child' }`
   — the ticket's catalog key, live.
3. **The queued followup did not interrupt and was consumed at the turn
   boundary (spec §4.1/§2.2)** — `agent/inbox/spliced { target: 'next-turn' }`
   at seq 5 parked the handoff; `command/done` (seq 8) recorded the handler's
   success; the handoff was then admitted as the parent's own turn input
   (`user/message` at seq 11 — the session title even fell back to its text).
4. **Settlement steering into a running turn (spec §4.2/§5.2)** — the child
   settled while the parent's handoff turn was still running: the settlement
   notice arrived as `agent/inbox/spliced { target: 'next-step' }` at seq 34
   ("Background subagent 0b26692d-… finished and will do no further work
   unless you send it more.") — the running-parent arm observed live.
5. **Durable children on disk** — both probe runs left child session
   directories under the scratch home
   (`sessions/--tmp-mt-t1-scratch-workspace--/0b26692d-…/` and `2e107009-…`),
   alongside the two parent sessions.

## Verdict

The five §5.2 lifecycle behaviors — host-side continuable spawn, settlement
wake (idle queue / running steer / teardown inject), non-interrupting queued
handoff, and durable restart discovery + cold resume — compose from
plugin-reachable seams of the installed harness with only the model scripted,
and `dsh-goal-round-driver` remains a sound template for the race-fenced
multitask round driver. The single material caveat for design is the
graceful-teardown inbox clearing documented under Behavior 6.

VERDICT: go
