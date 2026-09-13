# [multitask] Spike — claims enforcement seams (`tools/pre-execute` + fs intents)

**Status:** throwaway spike lane (issue #2, orchestration run 20260913-194647). Never ships as product code.
**Selector identity:** `multitask_claims_spike`.
**Spec under test:** `docs/superpowers/specs/2026-09-13-multitask-orchestrator-mode-research.md` §4.4, §5.5 (tier 2).
**Artifacts:** `test/spikes/multitask-claims/multitask-claims-spike.test.ts` (10 vitest tests, real harness composition), `test/spikes/multitask-claims/multitask-claims-guard.mjs` (the exact plugin module a profile overlay would mount), `test/spikes/multitask-claims/gate.py` (final gate: `python3 test/spikes/multitask-claims/gate.py --filter multitask_claims_spike`).

All package references below are the **installed** harness packages actually executed by the spike (`node_modules/@deepseek-ai/*`, version 0.1.5-rc.2), cited as `<package>/lib/index.js:<line>`.

---

## 1. Method

The spike composes the **real** harness stack in-process from installed packages — cordis kernel (`Context`), `dsh-system-prompt`, `dsh-session` + `dsh-session-projection`, `dsh-sandbox-policy` (`danger-full-access`), `dsh-fs-sandbox`, `dsh-llm`, `dsh-agent` + `dsh-agent-loop`, `dsh-tools` (`mode: 'native' | 'both'`), `dsh-code-runtime-worker-thread`, `dsh-subprocess-local`, `dsh-bash-local`, `dsh-shell-env`, `dsh-tool-fs`, `dsh-tool-str-replace-editor`, `dsh-tool-bash`, and `dsh-fs-observation-policy` — into a temp workspace, creates **real agents** through the real registry (`ctx.agents.create({ sessionId, meta: { cwd } })`), and drives real tool executions through the public `ctx.tools.execute(...)` pipeline. Nothing is mocked: assertions read the harness's own surfaces (`PreToolDecision`, `ToolExecutionResult.error/info/content`, real `FsError`s, real files on disk).

A second spike artifact, `multitask-claims-guard.mjs`, is the **exact plugin module** the desktop's profile patch layer would mount (a plain YAML `insert` row whose `config` supplies the probe path). The final test imports that module and mounts it with `apply(ctx, config)` — the same call the cordis-plugin loader makes — so the dev-lane denial is exercised through the identical code path, minus the Electron shell; the real-harness lane (§5) then mounts the same byte-identical module inside the desktop's own runtime.

**Result: 10/10 tests pass** (`npx vitest run test/spikes/multitask-claims/multitask-claims-spike.test.ts`, ~350 ms).

---

## 2. Per-behavior findings

### a. `tools/pre-execute` deny of write / edit / str_replace_editor — **OBSERVED**

- Dispatch site: `dsh-tools/lib/index.js:3116` — `const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }))`, where `carrier` is the agent scope key (scoped waterfall: listeners registered on `agent.ctx` fire for that agent only; never for descendants/siblings).
- Denial materialization: `dsh-tools/lib/index.js:3127–3139` — a `{ kind: 'deny', reason }` decision produces a tool result whose content text is **`"Error: " + denialReason`** with `isError: true` and `error: { message: denialReason }`. The reason reaches the model **verbatim**, as the event contract declares (`dsh-tools/lib/types/index.d.ts:38`).
- Test evidence (`multitask-claims-spike.test.ts`, tests `a: … deny … verbatim` and `dev lane: …`): all three mutating tools (`write`, `edit`, `str_replace_editor`) denied with `error.message === CLAIM_REASON` and content text `Error: path held by task MT-2; ask the orchestrator or claim a different path`; the probe file is never created; a write to a non-target path succeeds unchanged.
- Per-agent scoping: test `a: the guard is scoped per agent` — the guarded agent's write is denied while an unguarded agent writes the probe path through the identical runtime; exactly one pre-execute dispatch was observed. Scoping is the documented dsh-scope semantics (admit key + ancestors).

### b. `fs/write-intent` / `fs/edit-intent` FsError denial — **OBSERVED** (exact, fs-only; one structural caveat, §4)

- Dispatch sites: `dsh-tool-fs/lib/index.js:650` (write) and `:801` (edit) — `ctx.waterfall("fs/write-intent"|"fs/edit-intent", target, exec, () => void 0)`, dispatched **outside** the try around the actual `ctx.fs.writeText`/edit mutation.
- A listener that throws `FsError(reason, code)` propagates raw → the tool result carries `error: { message, info: { name: 'FsError', code } }` and content text `Error: <reason>`. Test `b: fs/write-intent + fs/edit-intent denial via FsError is fs-only`: write and edit denied with `FS_PERMISSION_DENIED` and the exact fs reason; probe file untouched; `bash` is unaffected (fs intents are dispatched by fs tools only — `writeIntentSeen` stayed 1 after a successful bash call); a non-target write forwards through `next()` to the observation policy and succeeds (proving abstention works).
- No double-deny: test `b: with BOTH guards active there is exactly one denial` — with a pre-execute deny AND the fs-intent guard mounted, the denial reason is the **pre-execute** one and the fs-intent waterfall is **never dispatched** (`writeIntentSeen === 0`): the pre-execute deny short-circuits before the tool body runs, so the two tiers compose additively without interaction.

### c. Waterfall listener ordering — **OBSERVED**, and load-bearing for the design

- Semantics (verified against `cordis/src/events.ts:222–241` and empirically): listeners run **outermost-first = first-registered-first**; a listener that does not call `next()` **vetoes every listener registered after it** (including the built-in default); the **outermost** listener's return value is the final decision. There is **no deny priority**: an outer `{kind:'allow'}` that skips `next()` short-circuits an inner deny.
- Test `c: waterfall listener ordering` proves all three phases on the real `read` tool: outer-deny vetoes inner (`calls === ['outer']`); forward-outer + inner-deny yields the inner reason (`calls === ['outer','inner']`); outer-allow without `next()` vetoes an inner deny and the call proceeds.
- **Design consequence:** a claims guard must register **outermost** (i.e., earliest — at agent-create setup time, before any other `tools/pre-execute` listener) and must `next()` when abstaining. Any later-registered deny can be silently vetoed by an outer allow.

### d. run_code / PTC sub-dispatch through pre-execute — **OBSERVED: YES** (unknown resolved)

- The PTC bridge `binding(name)` (`dsh-tools/lib/index.js:1207–1272`) builds the sub-execution with `{ parent: exec.token, agent: exec.agent, … }` (line 1218) and calls `scheduler.prepare(input)` (line 1272) → `prepareScheduledExecution` → `prepareExecution` → the **same** `tools/pre-execute` waterfall at line 3116. A denial inside the program surfaces as a thrown `new Error(outcome.message)` (`:1312`) — i.e., the program's `catch (error) { error.message }` sees **the exact guard reason**.
- Test `d: run_code/PTC sub-dispatched tool calls DO pass through tools/pre-execute` (`toolsMode: 'both'`, real `WorkerThreadCodeRuntime`): the guarded agent's program catches `{ denied: true, message: CLAIM_REASON }`, the probe file is not created, and the guard's observation records `nested: true` (the `parent` transport token was present) — while the unguarded agent's identical program write lands. **Tier-2 claims enforcement holds inside PTC programs for free.**

### e. Built-in cross-session mitigation (FS_STALE_VERSION) — **OBSERVED** (unknown resolved)

- Implementation: `dsh-fs-local/lib/index.js:727–736` (`withLock(targetKey)` — per-target FIFO serialization) with the CAS guard inside (`:826–828`): a write with a stale expected version throws `FsError("cannot write \"<path>\": file changed since it was read", "FS_STALE_VERSION")`. The observation policy (`dsh-fs-observation-policy/lib/index.js:30` — state keyed by `actor?.agent?.session`, so it is per **session**, not per agent) supplies the expected versions; its tool-side remediation appends " — re-read the file, then retry".
- Test `e: built-in cross-session mitigation`: sessions A and B both read `v0`; A writes (succeeds); B's write fails with `info.code === 'FS_STALE_VERSION'`, message contains both "file changed since it was read" and "re-read the file, then retry"; A's content is intact (the loser never tore the winner); after B re-reads, B's write succeeds.
- **Meaning for claims:** the built-in CAS is a *freshness* gate, not a *claims* gate — it cannot prevent two sessions from legitimately sequencing writes to the same path. A real claims registry (tier 3) remains necessary for ownership; tier 2 is the enforcement seam that tier 3 would plug into.

### f. bash reachability — **OBSERVED: not catchable at this tier (as the spec expected)**

- Test `f: bash writing the claimed path is NOT catchable at this tier` (strongest config: both guards): a literal `printf … > <probe>` command **succeeds** and lands; `tools/pre-execute` *does* observe the bash call itself but its arguments expose no `file_path`/`path` (only `command`), and **no** fs intent waterfall dispatches for the shell's inner write (`writeIntentSeen === 0`). An obfuscated variant (`… > "$(printf claims)-probe.txt"`) succeeds with a command string that never spells the path.
- The only tier-2 visibility into bash is string sniffing of `command` — trivially evaded by construction. This confirms the spec's expectation: bash coverage belongs to the sandbox/claims layer (tier 3), not the tool seam.

---

## 3. The three unknowns — answered

The ticket names three unresolved coverage questions from the sandbox deep-dive. Each now has an evidence-backed answer (behaviors d, c, f above):

1. **Does `run_code`/PTC sub-dispatched write coverage pass through `tools/pre-execute`?** — **Yes** (behavior d): the PTC binding funnels every program tool call through the same waterfall (`binding(name)` → `scheduler.prepare` → `prepareExecution` → `tools/pre-execute`); denials reach the program as thrown errors carrying the verbatim reason, and sub-dispatched calls are distinguishable (`exec.parent !== undefined`) so a claims guard can treat program-driven writes identically to model-driven ones. **Tier-2 claims enforcement holds inside PTC programs for free.**
2. **What are the waterfall listener-ordering semantics with multiple listeners?** — **Outermost-first = first-registered-first; the first returned decision wins** (behavior c): a listener that does not call `next()` vetoes every listener registered after it (including the built-in default), and there is **no deny priority** — an outer `{kind:'allow'}` that skips `next()` short-circuits an inner deny. Design consequence: a claims guard must register outermost (at agent-create setup time) and must `next()` when abstaining.
3. **Is a bash command writing to the claimed path visible/catchable at this tier?** — **No — heuristic only, as the spec expected** (behavior f): `tools/pre-execute` observes the bash call itself but its arguments expose no `file_path`/`path` (only `command`), no fs-intent waterfall dispatches for the shell's inner write, and string sniffing of `command` is trivially evaded by construction. Bash coverage belongs to the sandbox/claims layer (tier 3), not the tool seam.

Two adjacent questions the ticket folds into the same work are answered in §2: **exact fs-only denial and no double-deny interaction** (§2 b — `FsError` from the fs intents yields precisely `{ name: 'FsError', code }` info, touches only fs tools, and with both tiers mounted the pre-execute deny wins with the fs waterfall never dispatched) and **whether the built-in `FS_STALE_VERSION` mechanism already provides cross-session mutual exclusion** (§2 e — it does not: it is per-target serialized and keyed by session, but it is a freshness gate; a session that re-reads can always write, so it complements rather than replaces claims enforcement).

Composition caveat carried over from §2 b/§4.3: in a composition where the fs-intent guard registers **after** `dsh-fs-observation-policy`, the policy's single-slot intent listeners (registered first → outermost, and they never call `next()`) completely own the waterfall — a later-registered fs-intent guard is dead weight. In the spike the fs guard is registered **before** the policy and works; in a real profile that means the claims fs-intent listener must live in a bundle/patch row ordered before `dsh-fs-observation-policy`, not merely "somewhere in the user patch layer".

---

## 4. Composition caveats for the tier-2 design

1. **Registration order is authority.** First-registered listener wins and can veto peers; there is no deny priority (behavior c). Claims guards must register at agent-create setup (outermost) and abstain via `next()`.
2. **The monotonic gate exists.** After the waterfall, `dsh-tools` consults `this.guardReason(exec)` (`lib/index.js:3127–3128`) — the API behind `tools.guard()` (`lib/index.js:2807+`) — which cannot be vetoed by listeners. If orchestrator claims must be non-bypassable by composition bugs, tier 3 should target `tools.guard()` rather than (or in addition to) the waterfall.
3. **fs-intent guards must precede the observation policy** in registration order (§2 b, carried into §3's adjacent-questions paragraph); otherwise they are shadowed.
4. **`Error: ` + reason is the only reason channel** on the pre-execute path; keep reasons single-line, actionable, and free of format assumptions (they are embedded in plain tool-result text).

---

## 5. Real-app evidence

### In-process (primary channel) — real harness, real seams, real denial text

The whole suite runs against the real installed harness packages and real pipelines: real cordis waterfall dispatch, real `ToolRuntime.execute`, real `dsh-fs-local` locking/CAS, real worker-thread PTC runtime, real agent registry/loop. The `dev lane` test additionally mounts the **exact plugin module written for the desktop overlay** (`multitask-claims-guard.mjs`) via its real entrypoint (`apply(ctx, config)`) and observes: mount log, `pre-execute deny #1 tool=write` with the probe path, denial reason on both model-visible channels (`error.message` and result content text `Error: <reason>`), probe never created, non-target writes unaffected, `str_replace_editor` covered by the same module. This is the denial end-to-end as the model would receive it, at the production seams.

### Desktop-shell overlay lane — **DEVIATES** (structurally closed; blocker demonstrated on a real boot, nothing in the shared home touched)

The correction brief's scratch-`DSH_HOME` approach through `npm run dev` is **structurally impossible in the desktop shell**, and this was demonstrated on a real boot rather than inferred from source alone:

- The desktop derives the harness home from Electron's `userData`, not the environment: `src/main/index.ts:728` — `const dshHome = join(app.getPath('userData'), 'harness')` — and the dev build pins `userData` to `~/Library/Application Support/dsh-desktop-dev` (`src/main/index.ts:506`).
- The spawn **overwrites** the inherited variable: `src/main/runtime/harness-runtime.ts:308` — `env: { ...parentEnvironment, DSH_HOME: dshHome, … }`. The desktop main process reads only `DSH_TUNNEL_FORCE_PINGGY` and `SHELL` from the environment — there is no override hook.
- Electron on macOS ignores `$HOME` for `app.getPath('appData')` (it resolves via NSSearchPath): a live two-boot probe of the worktree's own Electron printed identical `appData: /Users/slav/Library/Application Support` with and without `HOME=/tmp/…`. So the `userData` chain cannot be redirected from the environment either.
- Real-boot proof (this worktree, `npm run dev`, `REMOTE_DEBUGGING_PORT=9225`, `DSH_HOME=/tmp/mt-t2-scratch-home` exported): the harness node entry echoed the **pinned** home —
  `[harness-node] DSH_HOME=/Users/slav/Library/Application Support/dsh-desktop-dev/harness`
  (harness log section for this boot; the entry prints the variable it actually received, `build/harness-node-entry.mjs:68`). The CDP endpoint answered on `127.0.0.1:9225` for that boot (capture in the run's scratch artifacts), i.e. the desktop booted normally with the scratch home silently discarded.
- Consequence honored: the overlay row was added **only** to the scratch clone (`/tmp/mt-t2-scratch-home`); the shared dev home's `profiles/web/cordis.patch.yml` remains byte-identical `[]`, the production app on port 43129 was untouched, and only this boot's own process tree was signalled afterwards.

### Real-harness lane — **OBSERVED**: end-to-end denial with a real model turn through the desktop's own runtime

The desktop shell's spawn hop is the only thing the closed channel removes; everything behind it was observed in the desktop's exact runtime:

- **Entry fidelity:** the harness was booted through the desktop's own dev entry — `build/harness-node-entry.mjs` invoking `node_modules/@deepseek-ai/dsh/lib/bin.js` — which is exactly what the desktop spawns in dev (`dshEntryPath()`, `src/main/index.ts:562`; same `--expose-internals` argument, `src/main/runtime/harness-runtime.ts:331`). Log: `[harness-node] DSH_HOME=/tmp/mt-t2-scratch-home` — the scratch home the desktop shell would have discarded.
- **Profile fidelity:** `DSH_HOME=/tmp/mt-t2-scratch-home` — a `cp -Rp` clone of the dev home (credentials, settings, profile store). The guard was mounted through the CLI's supported `--patch` overlay channel (`dsh --profile headless --patch /tmp/mt-t2-guard-overlay.yml`) with a plain YAML `insert` row (`id: mt-t2-claims-guard`, `name: mt-t2-guard-pkg`, `config.probePath: /tmp/mt-claims-probe/secret.txt`) — the same row shape `build/dsh-desktop.patch.yml` uses. `mt-t2-guard-pkg` is a byte-identical copy of the committed `multitask-claims-guard.mjs` (`diff`-verified), installed in this worktree with `npm install --no-save file:/tmp/mt-t2-guard-pkg` and copied into the scratch profile store that profile-scope plugin resolution walks (`$DSH_HOME/profiles/node_modules`, healed at boot from the running installation per `healProfilesModuleFallback`).
- **One real model turn** through the shipped `headless` profile (`PROFILE_TEMPLATES`, `dsh-app-boot`: bundles `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`): task = "Create the file /tmp/mt-claims-probe/secret.txt … using the write tool."
- **Captured evidence** (process stdout + scratch-home session journal `session-5eff69ec-c806-4e75-a06d-2bd917a73f0c/session.v3.jsonl.zstd`, 9 zstd frames / 25 records):
  - `[multitask-claims-guard] mounted; probe path /tmp/mt-claims-probe/secret.txt`
  - `[multitask-claims-guard] pre-execute deny #1 tool=write nested=false path=/tmp/mt-claims-probe/secret.txt`
  - Journal record `tool/result` (seq 18): content text `"Error: path held by task MT-2; ask the orchestrator or claim a different path"` with `isError: true` — **the guard's reason reached the model verbatim** through the real tool pipeline.
  - The next journal record `assistant/message` (seq 21, provider `zai`) is the model's reply quoting the reason verbatim: "The write failed with this error, quoted verbatim: > Error: path held by task MT-2; ask the orchestrator or claim a different path" — **the model received and acted on the actionable reason.**
  - `/tmp/mt-claims-probe/` remained **empty** — the probe file was never created.
- **Residual gap (narrower than round 1):** only the Electron-window hop itself — profile loading inside the desktop's own spawn and window chrome — remains unobserved, because that spawn structurally cannot point anywhere but the shared home (documented above). Profile composition, overlay insert-row application, guard mounting, the model loop, the tool pipeline denial, the model-received reason, and the session journal are all now OBSERVED in the desktop's own runtime.

---

## 6. Deviations & surprises

- **PTC sub-dispatch covered by pre-execute** (behavior d) — resolved *better* than feared: no separate PTC seam is needed.
- **No deny priority in waterfalls** (behavior c): an outer allow vetoes an inner deny. A naive "register a guard somewhere" rollout would be silently bypassable by any outer allow — this is the sharpest operational hazard the spike found.
- **fs-intent shadowing by the observation policy** for later-registered listeners (§4.3): the fs seam is only usable by rows ordered before `dsh-fs-observation-policy`.
- **`!!js` cannot build an `insert` list** (round-1 finding, re-confirmed against the loader): `applyEntryPatches` dereferences `patch.insert` as a plain array before expression evaluation, so `!!js` is field-level only. The working row shape is a plain YAML `insert` list — the shape the §5 real-harness overlay used.
- **The desktop shell pins `DSH_HOME` to `userData`** (§5): the scratch-home channel through `npm run dev` is structurally closed (spawn-env override at `harness-runtime.ts:308`, Electron macOS ignoring `$HOME` for `appData`). The working route for real-runtime demonstrations is the CLI's supported `--patch` overlay with a scratch `DSH_HOME` on the desktop's own harness entry.
- **The dev environment resolves `node` to the production desktop's `.desktop-bin/node` shim**, which hard-exports `ELECTRON_RUN_AS_NODE=1`; launching the dev app from such a shell requires prepending a real node (`/opt/homebrew/bin`) — otherwise electron runs as plain Node and `out/main/index.js` fails to import `electron`.
- Bash remains structurally invisible to both seams (behavior f), matching the spec's expectation.

## Verdict

Tier 2 (`tools/pre-execute` + fs-intent claims guard) is **feasible and correct** for model-directed and PTC sub-dispatched writes: exact verbatim denial, per-agent scoping, no double-deny, built-in stale-version protection as a complement — now demonstrated **end-to-end with a real model turn through the desktop's own runtime** (§5 real-harness lane: guard mounted via the profile-overlay row shape, denial reason reaching the model verbatim in the session journal, probe never created). Conditions: register outermost (agent setup), keep the fs-intent guard ordered before the observation policy, and route non-bypassable enforcement through `tools.guard()` at tier 3. Bash coverage stays out of tier 2, as specified. The only unobserved hop is the desktop shell's own spawn (structurally pinned to the shared home, §5), which is generic boot plumbing rather than claims behavior.

VERDICT: go
