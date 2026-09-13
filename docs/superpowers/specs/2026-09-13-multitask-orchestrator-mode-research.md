# Multitask / Orchestrator Mode — Research & Design Proposal

Date: 2026-09-13
Status: research draft, pending review

## 1. Goal (restated)

Add a Cursor-style **Multitask** capability to DSH Desktop:

1. The main agent can always act as an **orchestrator**: it manages subagents instead of doing all work itself.
2. The user types `/multitask <prompt>` in the input field (like a skill/command) while the main agent is **busy** on another task.
3. That message must **not interrupt** the running main agent. Instead, a **research subagent** starts on the new task immediately. When the main agent finishes its current work, it switches into **Orchestrator mode**, collects the research result, and dispatches a fresh **writer subagent** with (research result + implementation brief).
4. The orchestrator always knows **which files each subagent is working on**, and steers/restricts subagents to avoid write collisions.

## 2. Verified building blocks already in the Harness (first-hand findings)

Everything below was verified directly in the pinned runtime packages
(`node_modules/@deepseek-ai/*@0.1.5-rc.2`) of this repo.

### 2.1 The session inbox already distinguishes "queue" from "steer"

`dsh-api-session-controller` (`lib/types/client/sessions/session.js`):

```js
beginSubmission(input) {
  placement: this.running
    ? input.mode === 'steer' ? 'steering' : 'queued'
    : 'transcript',
  ...
}
/** @param mode - queue appends after the current turn; steer interrupts it. */
async prompt(content, mode, signal, requestId)
```

- **`steer`** = inject at the next step boundary of the *running* turn (interrupts/redirects current work).
- **`queue`** = appended after the current turn; the agent picks it up at the next turn boundary **without interrupting**.
- The UI already renders queued/steering rows (`dsh-client-ui-chat`: `data-chat-flow-kind=steering`, `pendingSteering`, `queue` projection) and the host broadcasts authoritative queue frames (`SessionControlController` → `type: 'queue'`, `queue-mirror.js` — "Authoritative transient queue projection and durable steering handoff").

**Implication:** the "must not interrupt" requirement maps 1:1 onto an existing submission mode. No new runtime concept is needed for queueing.

### 2.2 The agent loop drives queued turns automatically

`dsh-agent-loop/lib/index.js` (`ReactLoopAgent`):

```js
followup(input) { this.send(input, 'next-turn', true); } // queued — no interrupt
steer(input)    { this.send(input, 'next-step', true); } // next step boundary
inject(input)   { this.send(input, 'next-step', false); }
async kick() { try { while (await this.turn()); } ... } // consumes queued turns back-to-back
get status() // 'idle' | 'running', published via `agent/status` events
```

- Queued (`next-turn`) messages become the **next turn's** input; `kick()` loops turns until the inbox is empty, so a queued message is picked up **immediately after** the current turn — exactly the "when the main agent becomes available" moment.
- `agent/status` (`idle`/`running`) is dispatched on every phase transition, and session projections (`sessionProjections`, key `inbox`) expose queue state to the UI and to host-side code.

**Implication:** a host-side `/multitask` handler can call `agent.followup(handoffMessage)` and be certain the main agent consumes it at the next boundary without interrupting, and that "becomes available" is observable.

### 2.3 Plan mode is the exact template for "agent mode"

`dsh-plan-mode/lib/index.js` (module doc, verified):

> Plan mode is **logged per-agent collaboration state**: while active, a deployment-owned guidance section is included in each model request, and `exit_plan_mode` presents the completed plan for user review… The `plan` projection folds the session log, so resume and fork restore the state… entering or leaving plan mode changes **only the prompt section, not the request tool catalog**.

**Implication:** an "Orchestrator mode" can be implemented the same way: a per-agent collaboration state + a system-prompt guidance section + a `/multitask` user command + (optionally) a model-facing tool to leave the mode. Resume/fork safety comes for free by folding the session log.

### 2.4 Slash commands are a plugin-owned registry with host-side handlers

`dsh-commands/lib/types/index.d.ts`:

```ts
export interface CommandDefinition {
  readonly name: string;                 // "multitask" → /multitask
  readonly description: string;          // discovery UI (slash menu)
  readonly input?: CommandInputDescriptor;
  readonly handler: (invocation: CommandInvocation) =>
    CommandResult | Promise<CommandResult>;  // "Execute against the receiving
                                             //  agent WITHOUT sending the
                                             //  command to the model."
}
export declare class CommandRuntime {
  register(definition): () => void;      // global or agent-scoped
  list(agent): readonly CommandDescriptor[];  // feeds the slash autocomplete
  execute(agent, line, attachments, signal): Promise<CommandExecution | undefined>;
}
```

- `ctx.commands` is a normal cordis service — **any plugin can register `/multitask`**; the input field's command menu picks it up from `list()`.
- The handler runs host-side with `invocation.agent` in hand — it can touch the agent's inbox, spawn subagents, and register followups **without a model round-trip** and **without interrupting** anything.
- Lifecycle is durably logged (`command/run` / `command/done`).

**Implication:** `/multitask` is implementable as a first-party cordis plugin command — the same shipping pattern as the bundled PPT plugin (`dsh-ppt-*.tgz` in `package.json`), no frontend patch required for the entry point.

### 2.5 The subagent runtime supports exactly the needed lifecycle

`dsh-subagent` exports `SubagentRuntime` (a Typert remote service), `SubagentInbox`, `ChildLock`, `ContinuableActivationRegistry`, `SubagentContinuationManager`, plus child-config helpers (`resolveChildCwd`, `parentAgentOptionsForDelegation`, `captureDelegatedPolicyOverrides`, `appendDelegatedPolicyOverrides`).

`dsh-tool-subagent/lib/index.js` (verified tool schema + plugin config):

- Tool params: `description`, `prompt`, optional `provider`/`model`/`reasoning_effort`, `run_in_background`.
- Background modes: `one-shot` (job id + `job_output`/`job_kill`) or `continuable` (durable subagent id + `send_message`/steering + parent notices when the child settles).
- **Plugin config already supports per-child `toolFilter` (`allow`/`deny`) and `persona`** — the primitives for restricting a researcher vs a writer's toolset and for role-specific identity.
- `maxDepth` caps delegation chains (default 3).

**Implication:** researcher and writer subagents, parent-settled notifications, and role-scoped tool restrictions are all existing capabilities. The orchestrator does not need new spawn machinery — only policy.

### 2.6 The desktop can ship UI without patching upstream

- `packages/dsh-desktop-client-ui/client.js` shows the injection protocol: `window.__ModuleLoader__.load({ id, factory })` + `ctx.slots.inject/register(...)` for UI slots and `ctx.inject(['service'], fn)` for client services.
- The upstream patch layer (`patches/*.patch`, applied by patch-package in `postinstall`) is available for changes that slots cannot express; `docs/harness-0.1.5-patch-refactor.md` documents its maintenance cost. Prefer slots/plugins; patch only when unavoidable.

## 3. Cursor Multitask (design reference)

Findings from live research against Cursor docs/changelog/forum (sources in §9).

### 3.1 What it is and how it activates

- Cursor 3.2 (Apr 2026) shipped `/multitask` (Agents Window first; editor in 3.3): *"run async subagents to parallelize your requests instead of adding them to the queue. It will also break down larger tasks into smaller chunks for a fleet of async subagents to tackle simultaneously."*
- Activation paths: the `/multitask` slash command; a **"Build in Parallel"** button on plans (3.3); and retroactively on already-queued messages ("Start Multi-Task"). No keyboard shortcut.
- Baseline without it: Cursor 1.2 **queued messages** execute sequentially (reorderable since 2.4). Multitask is explicitly the *queue-breaker*: the new message is dispatched as a **background subagent immediately** instead of being appended to the sequential queue; the foreground chat stays interactive.

### 3.2 Dispatch semantics

- Each subagent gets a **clean context window**; the parent must pack all needed context into the dispatch prompt. Subagents return **only a final summary message** to the parent; intermediate output stays in the child.
- Every run returns an **agent ID** and is resumable later ("Resume agent abc123…"); background subagents persist state under `~/.cursor/subagents/`.
- One large prompt can be **auto-decomposed** into chunks run concurrently; plan-driven parallelism keeps **dependent steps ordered**.
- Nesting: subagents can spawn one more level since 2.5.

### 3.3 Collision story — the weak spot we should beat

- **Default is a shared checkout.** Docs: "Subagents share the parent agent's checkout by default. When several subagents edit files at once, they can overwrite each other's changes."
- Cursor staff (forum, Apr 2026), asked directly about collision prevention in v0: *"there's nothing specific in place… agents have done a pretty good job of coordinating their changes. We're currently working on functionality to further improve this!"*
- Opt-in isolation ladder: per-subagent **git worktree** or cloud VM on request (changes stay on branches **until the parent merges**); whole-agent worktrees with repo bootstrap config (`.cursor/worktrees.json`) and a janitor (25 worktrees / 6h cleanup); cloud subagents (`/in-cloud`).
- Cursor's own research blog ("Towards self-driving codebases") reports: **shared coordination files with locks failed**; what worked is recursive **planners that own a scope and never code**, plus workers on their **own repo copies** that return a written **handoff** (done / concerns / deviations) delivered as a follow-up message to the living planner.

### 3.4 What the UI shows

- Each background run appears as an entry in the Agents Window (inspect / promote / resume); completion summaries return to the parent conversation. No dedicated per-subagent progress bars; users report progress tracking is hard without them.

### 3.5 Comparisons that inform our design

| Product | Queueing | Collision avoidance |
| --- | --- | --- |
| Cursor Multitask | slash toggle: dispatch queued/new prompts as async subagents | shared checkout by default; opt-in worktree/VM; **no enforcement (v0)** |
| Claude Code | background subagents + agent teams | **enforced isolation**: `isolation: worktree` blocks Edit/Write into the main checkout, blocks command cwds resolving to main, blocks `git -C`/`GIT_DIR` escapes; worktree locks + retention sweep |
| Codex cloud | task-level fan-out to cloud environments | architectural: one isolated cloud env per task |
| Factory / Devin "Fleet" | N sessions launched manually | worktree as first-class session option; ephemeral/persistent lifecycle; merge-back button; LRU janitor with safety skips |

### 3.6 Patterns we adopt (and where we go beyond Cursor)

1. **Slash-command activation that changes submission semantics** (`/multitask` = queue-breaker) — matches our §2.1/§2.4 building blocks.
2. **Clean-context dispatch, summary-only return, resumable by id** — already how DSH subagents work (§2.5); we use *continuable* background subagents.
3. **Researcher → orchestrator → writer handoff with written structured output** — the user's requested flow; validated by Cursor's research as superior to shared lock files *for isolation*, but we add an explicit claim registry (below) that Cursor's v0 lacks.
4. **File-claim registry + restriction, enforced not conventional** — our answer to the Cursor v0 gap and to the failure of implicit "coordination": claims recorded host-side, denied at the tool boundary (see §4/§5). This is a deliberate step beyond Cursor v0, inspired by Claude Code's *enforced* isolation.
5. **Isolation ladder** — start with shared-checkout + claims; keep worktree-per-writer as a future escalation rather than day-one scope.

## 4. Gap analysis

| Capability needed by Multitask | Status today | Where |
| --- | --- | --- |
| Non-interrupting submission while busy | **Exists** (`queue` vs `steer` submission modes; UI renders queued rows) | §2.1 |
| "Agent became available" trigger | **Exists** (`followup()` consumed at next turn boundary by the loop driver; `agent/status` events) | §2.2 |
| Per-agent mode switch with prompt guidance, resume-safe | **Exists** (plan mode pattern: logged collaboration state + guidance section) | §2.3 |
| `/multitask` command surface with host-side handler | **Exists** (`CommandRuntime.register`, handler runs without a model round-trip; slash menu from `list()`) | §2.4 |
| Subagent spawn from host handler (not via tool call) | **Exists** (children composed via `ctx.agents.create()` + child composition module; SubagentRuntime service) | §2.5 |
| Researcher/writer tool restriction | **Exists** (`toolFilter` allow/deny + `persona` per child) | §2.5 |
| Parent notified when subagent settles; continuable children | **Exists** (continuation manager; parent notices) — details in §4.2 | §2.5 |
| File-claim registry | **Missing** — must be built (plugin service + projection events) | §5.5 |
| Boundary enforcement of claims | **Missing** — but the seams are confirmed and plugin-reachable (§4.4) | §5.5 |
| Per-subagent UI cards / task board | **Partially exists** (subagent lineage tree, jobs menu, goal node/dock, workflow node) — details in §4.6 | §5.1 |
| Writer count cap / cost guardrails | **Missing** (plugin config) | §5.6 |
| Worktree-per-writer isolation | **Missing, out of scope v1** (design leaves room; registry keyed by workspace-relative paths) | §5.5 |

### 4.1 Submission pipeline details (deep-dive: agent loop & session controller)

- Host routing: `session.prompt(content, mode)` → `mode === "steer" ? agent.steer(msg) : agent.followup(msg)` (`dsh-api-session-controller/lib/index.js` L828). The pending queue is editable (`updateQueue`: edit/remove/steer a queued row), and cancel keeps the inbox (`{keepInbox: true}`).
- **The composer already queues by default when busy**: `dsh-client-ui-conversation` setting `busyEnter` ∈ `queue|steer`, **default `queue`** (`resolveSubmitMode`); Cmd/Ctrl+Enter delivers the opposite. So "don't interrupt" is today's default behavior for plain messages — `/multitask` adds (a) host-side dispatch that never reaches the model verbatim and (b) the immediate researcher spawn.
- Inbox is durable: `next-turn`/`next-step` fold from `agent/inbox/spliced` session events — **queued handoffs survive restarts**.
- Designed in-turn handoff point: `agent/turn-stopping` (serial waterfall before `turn/end` commits); a listener may `agent.steer(...)` there to append one more step without an idle gap. Alternative to the queued-followup handoff, if we want zero UI gap.
- Subagent sessions are fenced: a session with `origin === "subagent"` rejects generic `session/prompt|cancel` ("use subagent delivery") — children are reachable only through the subagent seams. Good isolation property for writers.

### 4.2 Subagent runtime details (deep-dive: subagents & jobs)

- `ctx.subagents: SubagentRuntime` (cordis service) with two child kinds: **one-shot** (`start()` → run + result; stopReasons `completed|aborted|error|max-tokens|refusal`) and **continuable** (`startContinuable(spec)` → durable child id stable across activations; the continuation manager owns every turn through the child's own inbox). **A host plugin can call these directly** — no model tool-call needed.
- **Parent settlement notice exists**: on activation settle, the runtime delivers a `user/message` with merge-extensible source `{kind: "subagent-settled", form: "notice", summary, senderSessionId}` — injected during teardown, else `sendWaking(parent, …, parent.status === "idle" ? "queue" : "steer")`. An idle parent is woken; a running parent is steered. (Resolves open question 1: no extra wake plumbing needed, but the notice carries a **summary**, not the full research payload — for the payload the orchestrator messages the child via `send_message`, which cold-resumes an absent child from persistence.)
- Model-facing control tools already exist: `send_message` / `interrupt_agent` / `list_agents` (statuses `running | idle | ready`).
- **Jobs vs subagents**: jobs (`ctx.jobs`, ids `bash-3` style) are process-local, non-durable result streams; subagents are durable session-backed agents. `dsh-tool-jobs` delivers unreported completions with `completionDelivery: wakeup|quiet` + **`maxConsecutiveWakes` (default 3)** — the anti-self-excitation pattern we should copy for orchestrator dispatch chains.
- Catalog: `ctx.subagents.listChildren(parentSessionId)` / `listDescendants(root)` classify children by the `subagent` projection fold (`subagent/descriptor` events): `{id, activity: running|inactive, mode: one-shot|continuable, label}`. The desktop's existing patch on `dsh-api-session-controller` already adds the client event journal keys (`subagent/catalog`, `subagent/descriptor`) — **the browser already receives subagent state**.

### 4.3 Modes, concurrency, and the driver template (deep-dive: goals & plan mode)

- **One agent loop per session is enforced** (registry keyed by SessionId). Parallel writers are necessarily separate child sessions; the main agent orchestrates — matching the user's model.
- **`dsh-goal-round-driver` is the literal code template** (367 lines): on `agent/status` idle → build a synthetic `user/message` with source `{kind:"goal", …}` → `agent.followup()`. Race fences: `agent/inbox/inserted` marks competing queued turns; `agent/pre-step` validates the reservation and `{kind:"reject"}` + restores other claimed messages if stale; abort/max-tokens disarms. **A `multitask-round-driver` cloned from this structure gets all race-fencing for free.**
- Plan mode controller contract (`PlanModeController.set(agent, active) → 'committed'|'queued'|'cancelled'|'noop'`): during an open turn the change stays pending until the next accepted `agent/pre-step`, then appends `plan/mode` + swaps the prompt section — **never the tool catalog**. This is the orchestrator-mode mechanism; `/plan` itself is registered via `ctx.inject(["commands"], …)` — same seam for `/multitask`.
- Presets (`dsh-agent-presets`) are static per-session plugin sets; per-agent runtime tool shaping exists via `ctx.tools.restrict({allow,deny})` and scoped `ctx.tools.register`.

### 4.4 Enforcement points for claims (deep-dive: sandbox, fs & tools)

Four concrete facts shape the design:

1. **Policy is resolved per tool call, keyed by the calling session**: `ctx.sandboxPolicy.resolve({session})` → `SandboxExecutionPolicy {mode: 'read-only'|'workspace-write'|'danger-full-access', workspaceRoot, sessionId?}`. Children share the parent's workspace root (`childSessionMeta` copies `parentHeader.cwd`) and inherit only the parent's explicit `sandbox/mode` override (`captureDelegatedPolicyOverrides` also pins child approval to `'never'`). **No per-child path scoping exists today** — the `subagent` tool schema has no workdir/sandbox params.
2. **The pre-tool-call seam exists and is the designed policy home**: the `tools/pre-execute` waterfall returns `PreToolDecision {kind:'allow'} | {kind:'deny', reason} | {kind:'ask', reason}` and is scope-filtered per agent (the Claude Code hooks bridge denies through exactly this seam; the bash tool's own TODO names it as the policy home). For fs precision, the `fs/write-intent` / `fs/edit-intent` waterfalls deliver `(target, actor)` **before every write/edit** — throwing an `FsError` there denies exactly and only fs mutations.
3. **A working template plugin exists**: `dsh-fs-observation-policy` — a per-session read-before-write CAS gate (`FS_NOT_OBSERVED`, `FS_STALE_VERSION`). A claim-guard plugin has the same shape (state keyed by session → paths).
4. **Built-in partial mitigation already exists**: writes serialize per target (`LocalFileSystem.withLock`) and a stale-version loser gets `FS_STALE_VERSION` — *torn writes* are already prevented cross-session; what's missing is *exclusive claims* (preventing wasted/overwritten work in the first place). For shells: the sandbox builds deny-by-default per-call profiles (macOS Seatbelt `(deny file-write*)` + subpath allows; Linux bwrap/Landlock; Windows ACL restricted token, enforcement `partial`), but `SandboxExecutionPolicy` has **no per-path deny field** — extending it is a contained change threaded through the policy service, delegation seed, and profile builders. **Everything kernel-grade is inert under `danger-full-access`** (the current deployment mode), so the tool-boundary guard is the tier that always works.

Also verified: `dsh-workflow` (scripted fan-out) spawns children through the same in-process provider and has **zero** file-partitioning support — a claims service at ctx/plugin level covers both `subagent` and `workflow` children.

### 4.5 Plugin packaging (deep-dive: commands & loader)

- A plugin package becomes a bundle via `package.json` → `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`; the profile's `package.json` lists ordered `dsh.profile.bundles`; patch YAML inserts Entries `{id, name, inject, config}`; later layers override earlier. Optional browser half exports `./client` and mounts UI via `ctx.slots.inject()/register()`.
- Commands: `ctx.commands.register({name, description, handler})` — handler executes against the receiving agent **without sending to the model**; lifecycle logged as `command/run|done`.
- Desktop patch reality: additions to the **session-controller wire surface** (new projection keys, new RPCs) are patch-package territory today (the desktop already maintains such a patch for the subagent catalog); pure-slot UI and plugin-scope features need no patch.

### 4.6 Slash-command & UI pipeline (deep-dive: input, commands, skills)

- Full input path for `/multitask do X`: keystroke trigger detection (`dsh-client-ui-input-trigger`) → slash menu candidates from the `commands/list` RPC (host `CommandRuntime.list(agent)`) → Enter adjudication (`matchEnter` per source) → `commands/execute` RPC → `parseCommand` → scoped lookup → `command/run` event → `handler(...)` → `command/done` event. **Every step is generic** — a registered runtime command gets menu listing, space-claim args parsing, attachment gating, durable lifecycle events, and automatic chat flow-node rendering with **zero UI work** (the `/goal` pattern).
- Today `/multitask` is unknown → the whole line falls through as a plain user message. Skills are different mechanics: a skill slash-invocation travels as an ordinary user message and is interpreted at `agent/pre-step` (`dsh-tool-skill` injects `<skill_content>`); **commands never reach the model**. `/multitask` as a command is the right choice — it must execute host-side, not be interpreted by the model.
- Plan mode end-to-end (the mode template): `/plan` command → `plan/mode` events appended at accepted `agent/pre-step` boundaries (mid-turn switches stay *pending*) → host-folded `plan` projection `{active, pending}` (resume/fork-safe) → `plan:policy` system-prompt section only while active → `PlanChip` UI in slot `conversation.input.plan` reading `useProjection("plan")`.
- Frontend client command contributions (`ctx.commandUi.register`) and `commandUi.decorate()` of host commands exist — desktop client modules can add pickers/panels without patches, but orchestration power stays host-side.
- UI surfaces that already exist: subagent **lineage tree** dropdown + read-only composer for child sessions (`dsh-client-ui-subagent`, slot `conversation.session.header.lineage`); jobs menu with live badge (`dsh-client-ui-jobs`, slot `conversation.session.header.actions`); `/goal` command node + `GoalDock` with pause/resume verbs over `remote.goals.*` (`dsh-client-ui-goal`, slots `conversation.chat.node` key `command-input` + `conversation.input.dock`); workflow-run keyed chat node (`dsh-client-ui-workflow-run`).
- The desktop inserts plugin rows via `build/dsh-desktop.patch.yml` (bundle-patch insert + package in the `@deepseek-ai/dsh` closure) — the same path `dsh-ppt-composer` uses; no preset-file patch required.
- Patch risk (per `docs/harness-0.1.5-patch-refactor.md`): ~half of client-ui patches break per upstream upgrade (bundle/CSS-hash churn); `dsh-client-ui-commands` / `-input-trigger` / `-skill` are **not currently patched** and should stay that way.

## 5. Proposed design: Multitask as a first-party harness plugin

### 5.1 Shipping form

A first-party cordis plugin (`dsh-multitask` — host) with an optional browser companion (`dsh-multitask-client`), mounted the way `dsh-ppt-composer` is: an insert row in `build/dsh-desktop.patch.yml` + the package in the `@deepseek-ai/dsh` closure (§4.5). The overall shape copies the proven `/goal` pair (`dsh-command-goal` + `dsh-client-ui-goal`): command → lifecycle events → keyed chat node → dock/panel. It contributes:

1. the `/multitask` command (§2.4/§4.6) — the activation surface the user asked for;
2. an **Orchestrator collaboration state + prompt section** (plan-mode pattern, §2.3/§4.6);
3. a `multitask-round-driver` cloned from `dsh-goal-round-driver` (§4.3) — race-fenced scheduling of orchestrator handoffs and settle-driven re-wakes;
4. a **file-claim registry service** (projection unit, §5.4) + small tool surface (`claim_files` / `release_files` / `list_file_claims`) with boundary enforcement (§5.5);
5. renderers so task cards and claim badges show in the conversation (keyed `conversation.chat.node` + `dsh-client-ui-tool` renderers, not upstream patches).

The desktop app needs **no Electron-main changes** for v1. An optional later step reuses the desktop's patched `conversation.hero.modeActions` slot (already home of the PPT toggle) for a persistent "Multitask" mode pill.

### 5.2 The lifecycle, end to end

```
main agent: busy on task A (turn running)
user:       /multitask research + implement B
            │
            ▼
/multitask command handler (host-side; NO model round-trip, NO interrupt)
 1. mint task id MT-n; write multitask/task event
 2. spawn RESEARCHER subagent (background, continuable), read-biased:
      prompt = research brief template(B) + "do not modify files" +
               "return structured report: goal, affected paths, plan,
                risks, recommended claim set"
 3. agent.followup(orchestrator handoff for MT-n)   ← next-turn queue:
      the running turn of task A is untouched; the message is consumed
      at the next turn boundary (§2.1/§2.2)
 4. pre-claim task A's recently-touched paths for task A in the registry
 5. command result renders a task card in the conversation
            │
            ▼
main agent finishes task A → next turn starts (orchestrator handoff
message is the turn input) → ORCHESTRATOR MODE section now active
  • if research already settled: its summary arrived with the parent
    notice → go to dispatch
  • else: wait on the researcher (send_message / job output) — a
    legitimate orchestrator action inside its turn
            │
            ▼
ORCHESTRATOR (main agent, orchestrator mode)
  • reads researcher's structured report
  • merges claim set: claims the report's paths for MT-n (tool call);
    refuses/buffers if any path is claimed by another live task
  • dispatches WRITER subagent (background or foreground):
      prompt = research report + implementation brief +
               "claim before edit; release when done; do not touch
                paths claimed by others (list provided)"
            │
            ▼
WRITER implements (claims enforced at tool boundary), returns handoff:
  done / concerns / deviations   ← the pattern Cursor's own research
                                   found superior to shared lock files
            │
            ▼
ORCHESTRATOR verifies the handoff (diff review / build), releases
claims, writes multitask/done event, reports to the user; exits
orchestrator mode when no multitask tasks remain
```

Key property: **the user's message never interrupts the running turn.** It becomes a queued followup; the runtime consumes it at the next boundary automatically (`followup()` → `next-turn` → `kick()` loop, §2.2). "Becomes available" requires no new plumbing.

Scheduling details resolved by the deep-dives:

- **When the researcher settles while the orchestrator is idle**, the runtime's settlement notice (source `subagent-settled`) is delivered `queue` + wake — the driver starts a turn on its own; no extra poller. While the orchestrator is *running*, the notice steers in at the next step boundary (§4.2).
- **`multitask-round-driver`** (cloned from `dsh-goal-round-driver`, §4.3) owns the fence logic: it validates that a queued orchestrator handoff is still the right next input at `agent/pre-step` (user messages queued in between win), rejects stale reservations, and bounds dispatch rounds (`maxConsecutiveWakes`-style, borrowing the jobs plugin's anti-self-excitation config, §4.2).
- **Alternative handoff point**: instead of queueing at command time, the driver can wait for `agent/turn-stopping` (the awaited serial waterfall before `turn/end` commits) and `agent.steer()` the handoff there — zero idle gap between task A and the orchestrator turn. v1 uses the simpler queued followup; the turn-stopping variant is a drop-in upgrade.

### 5.3 Roles

| Role | Who | Context | Tools |
| --- | --- | --- | --- |
| Orchestrator | the main agent itself (mode switch, not a new process) | full session history | all tools + claim tools; discouraged from direct edits while tasks are open |
| Researcher | continuable background subagent | clean context; packed research brief | read-only bias via `toolFilter` deny for edit/write tools (config exists, §2.5) |
| Writer | subagent (foreground or background) | clean context; research report + brief | full tools + claim tools; enforced claim respect |

Using the main agent as orchestrator (rather than a separate coordinator process) keeps one conversation, one history, one approval surface — matching the user's requirement and avoiding the "central integrator" bottleneck Cursor's own research rejected (§3.6, pattern 4: written handoffs to a living planner).

### 5.4 State & resume

- `multitask/task` plugin events (id, prompt, phase: `researching → orchestrating → writing → verifying → done/failed`, subagent ids) are appended to the session log — the plan-mode pattern, so **resume and fork restore multitask state by folding the log**.
- The claim registry is host-memory + log-backed: claims reference (task id, subagent id, paths, state). On resume, claims whose subagent is no longer running expire; the orchestrator re-claims as needed.

### 5.5 File-collision avoidance (the part Cursor v0 doesn't have)

Three enforcement tiers, in increasing strength; v1 ships tiers 1–2.

1. **Awareness (prompt-level).** The orchestrator's handoff and every writer's brief include the live claim table ("task A holds `src/x.ts`, `src/y.ts`"). Models follow this well; it is not a guarantee.
2. **Registry claims + boundary denial (host-enforced, always active).** The plugin guards two seams (§4.4): the `tools/pre-execute` waterfall (covers `write`/`edit`/`str_replace_editor` in one place, `PreToolDecision {kind:'deny', reason}`) and the `fs/write-intent`/`fs/edit-intent` waterfalls (exact per-path fs denial by throwing `FsError`). A writer attempting a path claimed by *another live task* gets a structured, actionable denial ("path held by task MT-2; ask the orchestrator or claim a different path"). Shell writes are only catchable heuristically at this tier (command-string inspection) — covered properly by tier 3; meanwhile the built-in per-target serialization + `FS_STALE_VERSION` CAS already prevents torn writes even when two agents do touch the same file (§4.4.4). Template for the whole guard: `dsh-fs-observation-policy`.
3. **Sandbox-policy isolation (per-subagent deny lists / worktrees).** Extend `SandboxExecutionPolicy` with per-path deny entries, seed them per child in the existing delegation window (`captureDelegatedPolicyOverrides`/`appendDelegatedPolicyOverrides`), and emit them in the three profile builders (Seatbelt/Landlock/ACL) — kernel-grade denial that also covers `bash`/`pwsh`. Caveats: inert under `danger-full-access`; Windows enforcement reports `partial`. Worktree-per-writer (Claude-Code-style enforced isolation, §3.5) is explicitly **out of scope for v1** but the design leaves room: claims are keyed by workspace-relative paths, so a future worktree tier reuses the same registry.

Claim lifecycle: orchestrator claims before dispatch → writer re-claims (idempotent for its own task) → releases on completion → registry emits `multitask/claims` projection events so the UI can badge them.

### 5.6 Guardrails

- **Parallel-writer cap** (default 2–3, config): Cursor shipped no cap and a user ran 55 subagents by accident (§3.5); DSH should bound cost by default. The driver also bounds settle-driven re-dispatch with a `maxConsecutiveWakes`-style counter (jobs-plugin pattern, §4.2), reset by user input.
- **Researcher never writes**: enforced by `toolFilter` deny + prompt; its brief demands a structured report (goal / affected paths / plan / risks / claim set).
- **Approvals**: existing delegation behavior applies — children are spawned with approval policy pinned to `'never'` and inherit the parent's sandbox-mode override (§4.4.1), so a writer works inside the inherited sandbox without interactive prompts; the orchestrator reviews the diff handoff afterwards. The orchestrator itself keeps the session's normal approval surface.
- **Failure paths**: researcher failure → parent notice (`stopReason: error|aborted|refusal`) → orchestrator retries once, then reports failure to the user; writer failure → claims released in a host-side `finally` on settle (not model-dependent), mirroring `ownedChildren`-aware settlement in the continuation manager.
- **Idle-entry**: `/multitask` while the agent is idle behaves identically — the followup wakes the driver immediately (§2.2 `wakeDriver`), and the orchestrator's wait on the researcher happens inside its turn.

## 6. Implementation plan

Phased so each step lands on an existing seam and is independently verifiable.

### Phase 0 — spikes (de-risk before building)

1. **Host-side spawn spike**: from a scratch cordis plugin, call the child-composition path (`ctx.agents.create()` + SubagentRuntime) and confirm a spawned child is visible in the session's subagent projections. *(Confirms §2.5 assumption.)*
2. **Followup spike**: from a command handler, `agent.followup(text)` while the agent runs; confirm the running turn is untouched and the text becomes the next turn's input. *(Confirms §2.2.)*
3. **Enforcement spike**: implement a minimal pre-write deny (one hard-coded path) at the chosen boundary from §4.4. *(Confirms §5.5 tier 2.)*

### Phase 1 — `dsh-multitask` plugin core

- Package skeleton (host `dsh-multitask` + browser `dsh-multitask-client`), mounted via an insert row in `build/dsh-desktop.patch.yml` + closure entry (the `dsh-ppt-composer` path, §4.6).
- `/multitask` command: register; parse input; mint task; append `multitask/task` event; return a text result pointing at the task card.
- Researcher spawn via `ctx.subagents.startContinuable` (background, durable child id, `toolFilter` deny edit/write) with the research-brief template.
- `multitask-round-driver` (clone of `dsh-goal-round-driver`, §4.3): queued orchestrator handoff via `agent.followup`; `agent/pre-step` reservation validation; settle-driven re-wake; dispatch-round bound.
- Orchestrator-mode guidance section (plan-mode state pattern) active while tasks are open.
- Writer dispatch from the orchestrator turn (the model does this through the existing `subagent` tool — the guidance section instructs the flow; no new dispatch tool required).

### Phase 2 — claim registry + enforcement

- `multitask.claims` service: claim/release/query; path normalization via `dsh-util-workspace-path`; backed by a session projection unit (the `sandboxMode` projection as reference) so it folds, persists, and feeds the browser.
- Claim tools (`claim_files`/`release_files`/`list_file_claims`) registered agent-scoped.
- Boundary denial on both seams (§4.4): `tools/pre-execute` + `fs/write-intent`/`fs/edit-intent`; actionable denial text; release-on-settle host-side `finally` (not model-dependent).
- Writer-count cap (config, default 2) + pre-claim of the busy main task's touched paths (from the live session's `fs/write-intent` trail).
- Phase 0 spike follow-ups: `run_code` sub-dispatch coverage; waterfall listener ordering.

### Phase 3 — UI

- Keyed `conversation.chat.node` task card folding `command/run|done` + `multitask/*` events (the `/goal` node pattern); phase chips (researching → orchestrating → writing → verifying → done/failed).
- Claim badges on tool-call presenters; queue-row label for orchestrator handoffs; surface in the existing subagent lineage tree.
- Optional desktop pill in the patched `conversation.hero.modeActions` slot.

### Phase 4 — hardening & polish

- Resume/fork folding tests (claims expire with dead subagents; tasks restore).
- Failure paths (researcher retry-once; failed writer releases claims; user-visible failure cards).
- Cap abuse tests; mobile bridge sanity (task cards must render on the paired-phone surface or degrade cleanly).
- Docs: `docs/multitask.md` user guide; README section.

### Validation

- `npm test`, `npm run typecheck`, `npm run build` (repo standard).
- Runtime scenario script: start long task → `/multitask B` → assert A uninterrupted (no steer placement), researcher spawned, B completes after A with claims respected — exercised against the real dev app (`npm run dev`), per the repo's "static checks are not a substitute for runtime verification" rule.

## 7. Risks & open questions

### Risks

| Risk | Mitigation |
| --- | --- |
| Pinned-harness upgrade (0.1.5-rc.2 → future) breaks plugin APIs | Use only stable public seams (commands registry, plan-mode state pattern, goal-driver structure, slots); avoid patching upstream for v1; pin integration tests to the exact harness version |
| Shell writes bypass the claim boundary (`bash` can write anywhere) | v1 tier 2 is containment-by-convention for shells (writer brief + orchestrator diff review; torn writes still prevented by the built-in CAS, §4.4.4); v2 tier 3 adds the `SandboxExecutionPolicy` deny-list threaded through the delegation seed + profile builders (kernel-grade for shells on confined deployments; inert under `danger-full-access`) |
| Orchestrator turn blocks for a long research wait (poor UX) | Guidance section prefers yielding: end turn and let the settle-notice re-wake it; treat blocking wait as fallback only |
| Model ignores claim etiquette despite enforcement text | Denial errors are structured and actionable; release-on-settle is host-side, so stuck claims self-heal |
| Cost blowup from parallel subagents (Cursor's 55-subagent incident) | Writer cap default 2, config-bounded; researcher is cheap (read-biased filter); `maxConsecutiveWakes`-style dispatch bound |
| Rich multitask UI needs new wire surface (projection keys/RPCs) | Reuse the desktop's existing `dsh-api-session-controller` patch family if unavoidable — but prefer plugin-log events already visible to the client journal; new session-controller RPCs are explicitly patch territory (§4.5) |
| Command result rendering differs on mobile bridge | Phase 4 mobile pass; degrade to plain text cards |
| Desktop patch layer conflicts if we later patch UI for multitask | Keep UI in slots/plugin renderers; the desktop's `conversation.hero.modeActions` slot is already desktop-owned, so a pill there is safe |

### Open questions — all resolved by the deep-dives

1. ~~Does a settling child wake an idle parent?~~ **Yes** — the settlement notice (source `subagent-settled`) is delivered `queue` + wake to an idle parent, `steer` to a running one; teardown injects directly (§4.2). The notice carries a **summary**, so the orchestrator pulls the full research payload via `send_message` (which cold-resumes the child from persistence if needed).
2. ~~Enforcement point?~~ **Two seams, both plugin-reachable**: `tools/pre-execute` (allow/deny/ask, scope-filtered per agent) + `fs/write-intent`/`fs/edit-intent` waterfalls (exact fs denial); tier-3 kernel-grade via a `SandboxExecutionPolicy` deny-list extension, inert under `danger-full-access` (§4.4).
3. ~~Does the composer queue by default?~~ **Yes** — `busyEnter` defaults to `queue`; Cmd/Ctrl+Enter steers (§4.1). Moot for `/multitask` anyway: the command executes host-side and never enters the message queue at all; only the *handoff* followup is queued, deliberately.
4. ~~Existing subagent/jobs UI?~~ **Subagent lineage tree** + read-only composer (`conversation.session.header.lineage`), jobs menu with badge (`conversation.session.header.actions`), `/goal` node + `GoalDock`, workflow-run node (§4.6). The multitask task card reuses the `conversation.chat.node` keyed pattern; claim badges render via tool-call presenters.
5. ~~Rich command result rendering?~~ `CommandResult` is text (`success`/`error`); rich UI comes from folding `command/run|done` + `multitask/*` events into a **keyed chat node** (exactly what `dsh-client-ui-goal` and `dsh-client-ui-workflow-run` do) — not from the command result itself (§4.6).
6. Remaining (minor, for implementation): `run_code`/PTC sub-dispatch coverage through `tools/pre-execute` unverified; `dsh-pwsh-sandbox` assumed to mirror bash (flagged unverified by the sandbox deep-dive); listener ordering among multiple waterfall listeners not exercised. Each is a Phase 0 spike checkbox.

## 8. Verified evidence index

| Finding | Package / file | Symbol |
| --- | --- | --- |
| Queue vs steer submission modes | `dsh-api-session-controller/lib/types/client/sessions/session.js` | `beginSubmission`, `prompt(content, mode)` |
| Queue mirror projection | `dsh-api-session-controller/.../queue-mirror.js` | `SessionQueueMirror` |
| Host prompt routing queue→followup, steer→steer | `dsh-api-session-controller/lib/index.js` L828 | `prompt()` |
| Composer default queue-while-busy | `dsh-client-ui-conversation/lib/client.js` | `busyEnter` (`queue` default), `resolveSubmitMode` |
| Followup/steer/inject + idle/running status | `dsh-agent-loop/lib/index.js` | `ReactLoopAgent.followup/steer/inject/kick/status` |
| Plan mode = per-agent collaboration state | `dsh-plan-mode/lib/index.js` | `PlanModeController.set`, `exit_plan_mode`, `plan:policy` section |
| Race-fenced continuation driver (template) | `dsh-goal-round-driver/lib/index.js` | `drive()`, `agent/pre-step` reservation, `agent.followup` |
| Plugin command registry, host-side handlers | `dsh-commands/lib/types/index.d.ts` | `CommandRuntime.register/list/execute` |
| Subagent service + continuable children | `dsh-subagent/lib` | `SubagentRuntime.start/startContinuable`, `listChildren` |
| Settlement notice to parent | `dsh-subagent/lib/index.js` L640–676 | `notifySettlement`, source `{kind:'subagent-settled'}` |
| Per-child tool/persona policy | `dsh-tool-subagent/lib/index.js` | config `toolFilter {allow,deny}`, `persona`, `backgroundMode` |
| Delegation policy seed (approval `never`) | `dsh-subagent/lib/index.js` | `captureDelegatedPolicyOverrides`, `appendDelegatedPolicyOverrides` |
| Per-call sandbox policy keyed by session | `dsh-sandbox-policy/lib/types` | `SandboxPolicyService.resolve({session})`, `sandbox/mode` event |
| Pre-tool-call denial seam | `dsh-tools/lib/types/index.d.ts` | `tools/pre-execute` → `PreToolDecision allow\|deny\|ask` |
| Fs-level denial seam | `dsh-fs/lib/types/index.d.ts`, `dsh-tool-fs/lib/index.js` | `fs/write-intent`, `fs/edit-intent`, `FS_STALE_VERSION` |
| Claim-guard template plugin | `dsh-fs-observation-policy/lib/index.js` | `ObservedStateGate`, `FS_NOT_OBSERVED` |
| Jobs wakeup bound (anti-self-excitation) | `dsh-tool-jobs` | `completionDelivery`, `maxConsecutiveWakes` |
| Subagent/jobs/goal/workflow UI slots | `dsh-client-ui-subagent/-jobs/-goal/-workflow-run` | `conversation.session.header.lineage`, `.header.actions`, `conversation.chat.node`, `conversation.input.dock` |
| Desktop plugin mount | `build/dsh-desktop.patch.yml`, `packages/dsh-desktop-client-ui/client.js` | bundle insert row, `window.__ModuleLoader__`, `ctx.slots` |
| Bundled first-party plugin precedent | `package.json` | `dsh-ppt-composer` tarball dependency |

## 9. Sources

### Cursor (primary, fetched during research)

- Changelog 3.2 "Multitask, Worktrees, and Multi-root Workspaces" — https://cursor.com/changelog/04-24-26
- Changelog 3.3 "PR Review, Build Plan in Parallel, and Split PRs" — https://cursor.com/changelog/05-07-26
- Changelog 1.2 (queued messages, agent to-dos) — https://cursor.com/changelog/1-2
- Changelog 2.4 (subagents intro) — https://cursor.com/changelog/2-4
- Subagents docs — https://cursor.com/docs/subagents.md
- Worktrees docs — https://cursor.com/docs/configuration/worktrees.md
- Agents Window docs — https://cursor.com/docs/agent/agents-window.md
- Help: multi-agent — https://cursor.com/help/ai-features/multi-agent.md
- Blog: "Towards self-driving codebases" — https://cursor.com/blog/self-driving-codebases
- Forum: `/multitask` release thread (staff answers on collisions, models, Build-in-Parallel) — https://forum.cursor.com/t/multitask-in-agents-window/158955
- Forum: launch announcement — https://forum.cursor.com/t/multitask-worktrees-and-multi-root-workspaces/158954
- Forum: multi-task friction (+ staff reply) — https://forum.cursor.com/t/multi-task-friction-experience/160569
- Forum: subagent control / 55-subagent incident — https://forum.cursor.com/t/better-subagent-control-in-the-cursor-ide/161413

### Comparisons (primary)

- Claude Code worktrees (enforced isolation) — https://code.claude.com/docs/en/worktrees.md
- Codex cloud tasks — https://learn.chatgpt.com/docs/cloud.md
- Factory App worktrees — https://docs.factory.ai/factory-app/worktrees
- Devin Desktop worktrees — https://docs.devin.ai/desktop/cascade/worktrees.md

### Secondary (marked)

- AgentPatterns: Cursor /multitask — https://agentpatterns.ai/tools/cursor/multitask-subagents/
- Nextdev: "/multitask ships" — https://www.joinnextdev.com/blog/cursors-multitask-ships-parallel-agents-change-everything

### DSH (read directly in this repo)

- Pinned harness packages: `node_modules/@deepseek-ai/*@0.1.5-rc.2` (see §8 evidence index for exact files/symbols)
- `docs/architecture.md`, `docs/development.md`, `docs/harness-0.1.5-patch-refactor.md`, `docs/plugin-management.zh.md`
- `packages/dsh-desktop-client-ui/`, `build/dsh-desktop.patch.yml`, `scripts/build-ppt-runtime.mjs`
