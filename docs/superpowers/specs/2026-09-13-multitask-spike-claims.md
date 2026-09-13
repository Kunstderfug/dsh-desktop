# [multitask] Spike — claims enforcement seams (`tools/pre-execute` + fs intents)

**Status:** throwaway spike lane (issue #2, orchestration run 20260913-194647). Never ships as product code.
**Selector identity:** `multitask_claims_spike`.
**Spec under test:** `docs/superpowers/specs/2026-09-13-multitask-orchestrator-mode-research.md` §4.4, §5.5 (tier 2).
**Artifacts:** `test/spikes/multitask-claims/multitask-claims-spike.test.ts` (9 vitest tests, real harness composition), `test/spikes/multitask-claims/multitask-claims-guard.mjs` (the exact plugin module a profile overlay would mount), `test/spikes/multitask-claims/gate.py` (final gate: `python3 test/spikes/multitask-claims/gate.py --filter multitask_claims_spike`).

All package references below are the **installed** harness packages actually executed by the spike (`node_modules/@deepseek-ai/*`, version 0.1.5-rc.2), cited as `<package>/lib/index.js:<line>`.

---

## 1. Method

The spike composes the **real** harness stack in-process from installed packages — cordis kernel (`Context`), `dsh-system-prompt`, `dsh-session` + `dsh-session-projection`, `dsh-sandbox-policy` (`danger-full-access`), `dsh-fs-sandbox`, `dsh-llm`, `dsh-agent` + `dsh-agent-loop`, `dsh-tools` (`mode: 'native' | 'both'`), `dsh-code-runtime-worker-thread`, `dsh-subprocess-local`, `dsh-bash-local`, `dsh-shell-env`, `dsh-tool-fs`, `dsh-tool-str-replace-editor`, `dsh-tool-bash`, and `dsh-fs-observation-policy` — into a temp workspace, creates **real agents** through the real registry (`ctx.agents.create({ sessionId, meta: { cwd } })`), and drives real tool executions through the public `ctx.tools.execute(...)` pipeline. Nothing is mocked: assertions read the harness's own surfaces (`PreToolDecision`, `ToolExecutionResult.error/info/content`, real `FsError`s, real files on disk).

A second spike artifact, `multitask-claims-guard.mjs`, is the **exact plugin module** the desktop's profile patch layer would mount for the real-app lane (env-gated `insert` row, `name`/`config` via `!!js`). The final test imports that module and mounts it with `apply(ctx, config)` — the same call the cordis-plugin loader makes — so the dev-lane denial is exercised through the identical code path, minus the Electron shell.

**Result: 9/9 tests pass** (`npx vitest run test/spikes/multitask-claims/multitask-claims-spike.test.ts`, ~350 ms).

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

1. **Does an fs-intent denial give an exact fs-only denial, and is there any double-deny interaction?** — Yes and no: `FsError` thrown from `fs/write-intent`/`fs/edit-intent` yields precisely `{ name: 'FsError', code }` info with the guard's reason, touches only fs tools, and when both tiers are mounted the pre-execute deny wins with the fs waterfall never dispatched (no double-deny). Caveat: in a composition where the guard registers **after** `dsh-fs-observation-policy`, the policy's single-slot intent listeners (registered first → outermost, and they never call `next()`) completely own the waterfall — a later-registered fs-intent guard is dead weight. In the spike the fs guard is registered **before** the policy and works; in a real profile that means the claims fs-intent listener must live in a bundle/patch row ordered before `dsh-fs-observation-policy`, not merely "somewhere in the user patch layer".
2. **Do run_code/PTC sub-dispatched tool calls pass through `tools/pre-execute`?** — **Yes** (behavior d above): the PTC binding funnels every program tool call through the same waterfall; denials reach the program as thrown errors carrying the verbatim reason. Sub-dispatched calls are additionally distinguishable (`exec.parent !== undefined`), which is enough for a claims guard to treat program-driven writes identically to model-driven ones — or to attribute them to the parent call if attribution matters.
3. **Does the built-in FS_STALE_VERSION mechanism already provide cross-session mutual exclusion?** — **No** (behavior e above): it is per-target serialized and version-checked (real protection against lost updates), keyed by session, but it is a freshness gate — a session that re-reads can always write. It complements claims enforcement (conflict *detection* + safe retry UX) but does not enforce ownership.

---

## 4. Composition caveats for the tier-2 design

1. **Registration order is authority.** First-registered listener wins and can veto peers; there is no deny priority (behavior c). Claims guards must register at agent-create setup (outermost) and abstain via `next()`.
2. **The monotonic gate exists.** After the waterfall, `dsh-tools` consults `this.guardReason(exec)` (`lib/index.js:3127–3128`) — the API behind `tools.guard()` (`lib/index.js:2807+`) — which cannot be vetoed by listeners. If orchestrator claims must be non-bypassable by composition bugs, tier 3 should target `tools.guard()` rather than (or in addition to) the waterfall.
3. **fs-intent guards must precede the observation policy** in registration order (§3 answer 1); otherwise they are shadowed.
4. **`Error: ` + reason is the only reason channel** on the pre-execute path; keep reasons single-line, actionable, and free of format assumptions (they are embedded in plain tool-result text).

---

## 5. Real-app evidence

### In-process (primary channel) — real harness, real seams, real denial text

The whole suite runs against the real installed harness packages and real pipelines: real cordis waterfall dispatch, real `ToolRuntime.execute`, real `dsh-fs-local` locking/CAS, real worker-thread PTC runtime, real agent registry/loop. The `dev lane` test additionally mounts the **exact plugin module written for the desktop overlay** (`multitask-claims-guard.mjs`) via its real entrypoint (`apply(ctx, config)`) and observes: mount log, `pre-execute deny #1 tool=write` with the probe path, denial reason on both model-visible channels (`error.message` and result content text `Error: <reason>`), probe never created, non-target writes unaffected, `str_replace_editor` covered by the same module. This is the denial end-to-end as the model would receive it, at the production seams.

### `npm run dev` desktop lane — **DEVIATES** (attempted, blocked, cleaned up)

- What was attempted: an env-gated `insert` row in the dev web profile's user patch layer (`~/Library/Application Support/dsh-desktop-dev/harness/profiles/web/cordis.patch.yml`) mounting `multitask-claims-guard.mjs` (via `!!js process.env.MULTITASK_CLAIMS_GUARD_PATH`), then driving a real model turn through the dev app with `--remote-debugging-port` CDP.
- First attempt failed on overlay **YAML syntax** (`!!js` inline expression after `insert:`): `YAMLException: bad indentation of a mapping entry (9:89)` at `loadOverlayPatches` (`dsh-app-boot/lib/index.js:1190`). Fixed by rewriting as a block-scalar `!!js` expression (parse + evaluate validated locally against the dsh YAML dialect: `[]` without the env, the guard row with it).
- Second attempt failed on **patch shape**, and this is the durable finding: `TypeError: patch.insert?.forEach is not a function` at `anchorInsertedPluginNames` (`dsh-app-boot/lib/index.js:1199`, from `loadOverlayPatches:1190`). `!!js` expressions are evaluated by the loader at **entry activation** (`cordis-plugin-loader/lib/index.js:311`), but `applyEntryPatches` dereferences `patch.insert` as a **plain array before** any interpolation — so `!!js` cannot produce the insert *list* itself; it can only fill fields (`name`, `config`, `disabled`) inside a plain YAML insert list. Exact log excerpts (shared harness log): `[harness-node] DSH entry failed: TypeError: patch.insert?.forEach is not a function` at `…/dsh-app-boot/lib/index.js:1199` from both the `t2-claims-spike` and `t3-scaffold` lanes; earlier the same log shows `DSH entry failed: Error: dsh: failed to parse overlay … cordis.patch.yml: YAMLException: bad indentation of a mapping entry (9:89)` from the `t3-scaffold` lane (the first, broken overlay was briefly visible to the sibling lane through the **shared** dev home).
- Machine-wide serialization: concurrent lanes share `dsh-desktop-dev` (userData, single-instance lock, harness home, profile overlay), so dev-app launches cannot be concurrent; per the orchestrator's direction this lane **stopped all dev-app launches** and the scaffold lane owns desktop verification. All local state was restored: the overlay is byte-identical `[]` again (verified against backup), no spike processes remain, the probe file was never created.
- Residual risk for the verdict: the desktop-specific hops (profile patch loading, desktop spawn, real model turn through the GUI) are **not** covered by this lane. The denial *mechanics* — the only behavior tier 2 adds — are fully covered in-process at the same seams the desktop process executes (identical installed packages, identical plugin entrypoint). The untested remainder is profile/boot plumbing, which is generic loader functionality already exercised by every normal dev boot, not claims-specific behavior.

---

## 6. Deviations & surprises

- **PTC sub-dispatch covered by pre-execute** (behavior d) — resolved *better* than feared: no separate PTC seam is needed.
- **No deny priority in waterfalls** (behavior c): an outer allow vetoes an inner deny. A naive "register a guard somewhere" rollout would be silently bypassable by any outer allow — this is the sharpest operational hazard the spike found.
- **fs-intent shadowing by the observation policy** for later-registered listeners (§4.3): the fs seam is only usable by rows ordered before `dsh-fs-observation-policy`.
- **`!!js` cannot build an `insert` list** (§5): patch-list shape is dereferenced before expression evaluation; expressions are field-level only.
- **The dev environment resolves `node` to the production desktop's `.desktop-bin/node` shim**, which hard-exports `ELECTRON_RUN_AS_NODE=1`; launching the dev app from such a shell requires prepending a real node (`/opt/homebrew/bin`) — otherwise electron runs as plain Node and `out/main/index.js` fails to import `electron`.
- Bash remains structurally invisible to both seams (behavior f), matching the spec's expectation.

## Verdict

Tier 2 (`tools/pre-execute` + fs-intent claims guard) is **feasible and correct** for model-directed and PTC sub-dispatched writes: exact verbatim denial, per-agent scoping, no double-deny, built-in stale-version protection as a complement. Conditions: register outermost (agent setup), keep the fs-intent guard ordered before the observation policy, and route non-bypassable enforcement through `tools.guard()` at tier 3. Bash coverage stays out of tier 2, as specified.

VERDICT: go
