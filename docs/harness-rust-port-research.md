# Research: Porting the DeepSeek Harness (dsh CLI/backend) from Node/TypeScript to Rust

Date: 2026-02-14
Motivation: reduce the packaged size of DSH Desktop (measured: **625 MB** `.app` on macOS arm64), of which ~389 MB is the shipped `node_modules` under `Contents/Resources/app`.
Companion document: `docs/native-macos-migration-research.md` (renderer → WKWebView; this report covers the Node harness that serves `http://127.0.0.1:43129`).

All codebase numbers below were measured directly on the local checkouts (`/Volumes/DEV/deepseek-harness`, `/Volumes/DEV/dsh-desktop`) and the last built `dist/mac-arm64/DSH Desktop.app`. External claims cite primary sources.

---

## 1. Measured size baseline

### 1.1 The packaged app (`dist/mac-arm64/DSH Desktop.app`, 625 MB)

| Component | Size | Notes |
|---|---|---|
| `Contents/Frameworks` (Electron/Chromium) | 229 MB | not addressable by a harness port; addressed by the WKWebView research |
| `Contents/Resources/app/node_modules` | 389 MB | the target of this research |
| — `node_modules/node` (Node 24.9.0 binary) | **112 MB** | bundled full Node runtime |
| — `@deepseek-ai/*` (harness packages) | **38 MB** | incl. `dsh-typert-generator` 24 MB, `dsh-web-frontend` 5.7 MB |
| — `echarts` + `zrender` | 36 MB | web UI asset dep |
| — `dsh-ppt` | 21 MB | PPT skill/runtime assets |
| — `typescript` | 21 MB | **shippable by mistake** (build-time only) |
| — `@img` (sharp prebuilds) | 18 MB | only the current-platform triple is needed |
| — `pnpm` | 12 MB | **shippable by mistake** |
| — `jsdom` | 12 MB | **likely shippable by mistake** in the desktop host |
| — `@opentelemetry` | 10 MB | optional telemetry |
| — everything else (~460 packages) | ~100 MB | zod, typebox (6 MB), openai, anthropic-sdk, aws-sdk smithy stack, react-dom, dshmarket, @vscode, @google, undici, … |

Also in the repo but *not* obviously shipped: workspace `packages/ppt-bundles` 10 MB + `packages/ppt-runtime` 19 MB (the packaged `dsh-ppt` 21 MB corresponds to the built bundle).

**Key finding — the 112 MB Node binary may already be removable on macOS.** `build/harness-node-entry.mjs` sets `ELECTRON_RUN_AS_NODE=1` because "On macOS Harness runs inside an Electron utility process… Bundled-Node hosts (Windows, Linux) skip it." I.e. macOS already boots the harness on the Electron binary in Node mode; the standalone `node_modules/node` (112 MB) exists for Win/Linux parity but is packaged on macOS too. Deleting it from the mac build alone is a **-112 MB (~18%)** win with zero porting.

### 1.2 The harness monorepo (`/Volumes/DEV/deepseek-harness`)

- **54 workspace packages** under `packages/` (plus `apps/cli`, `apps/web`, `native/landlock-run`, `vendor/`).
- **~527,000 lines of TypeScript** (`find packages apps -name '*.ts'` excluding `node_modules`/`dist`; includes tests and generated `.d.ts`).
- Largest packages by LOC: `client` 94k, `core` 46k, `subagent` 27k, `host` 27k, `session` 24k, `llm` 24k, `extensions` 22k, `typert` 16k, `fs` 15k, `session-query` 13k, `shell` 12k, `context` 11k, `sandbox` 11k.
- Subsystems present as packages: agent loop (`dsh-agent-loop`), LLM clients (`dsh-llm`, `dsh-llm-deepseek`, `dsh-llm-pi-ai`, `dsh-llm-retry`), tools (bash/persistent, pwsh/persistent, fs + search, web fetch/search, workflow, subagent, todo, goal, skill, ask-user, ralph, present, cordis, jobs, str-replace-editor), session persistence (`session-persistence-jsonl` 724 KB shipped, `session-query-sqlite`, three format migrations v0→v1→v2→v3), sandbox (`sandbox`, `sandbox-local`, `sandbox-policy`, `sandbox-windows-acl`), plugin system (`cordis` + cordis-plugin-loader/hmr/group/include/timer, `dsh-tool-cordis`, `dsh-cordis-host-runner` 532 KB), typert (`typert`, `dsh-typert-protocol`, `dsh-typert-registry`, `dsh-typert-loader`, `dsh-typert-generator` — the generator alone is 24 MB shipped), web host (`dsh-host-webserver`, `dsh-web-app`, `dsh-web-frontend` 5.7 MB static assets), skills (`dsh-skill`, `dsh-skill-filesystem`), compaction, telemetry (`dsh-session-telemetry-otel`).

### 1.3 Native addons and runtime machinery found

- **`node-pty` 1.2.0-beta.15** — `packages/subprocess/subprocess-local` (persistent bash/pwsh shells).
- **`koffi` ^3.1.0** (FFI) — `packages/fs/fs-local`.
- **Custom native addon: `@deepseek-ai/node-addon-landlock-run`** — ~300 lines of C11 over the Linux Landlock UAPI, statically linked against musl, for sandboxing subprocesses on Linux (`native/landlock-run/README.md`). Distributed as prebuilt per-platform packages.
- **`sandbox-windows-acl`** — Windows ACL sandboxing package (180 KB shipped).
- **`workflow-worker-thread`, `code-runtime-worker-thread`** — `worker_threads` usage for workflow/code execution.
- **Dynamically-typed/reflective machinery**: `cordis` (IoC container / plugin runtime, "everything is a plugin" per the README), `schemastery` (runtime schema validation), `typebox` (6 MB shipped), `typert` (a bespoke runtime type system with a 24 MB generator package).

### 1.4 Stated design constraints (docs/architecture.md, README)

- README: "everything is a plugin… powered by Cordis"; **developer preview, "THERE WILL BE COMPATIBILITY-BREAKING CHANGES"**; engines `node ^22.19 || >=24`; plugin ecosystem on npm/GitHub (`dsh-plugin` topic), which pins the ecosystem to JavaScript.
- DSH Desktop `docs/architecture.md`: DSH Desktop "does not maintain a second agent runtime"; macOS runs harness in an Electron UtilityProcess with Node capabilities; Windows runs the bundled target-native Node executable; sessions/plugins live under `userData/harness/` and must survive app upgrades; Safe Mode runs official core bundles with plugins blocked; cordis HMR uses `--expose-internals` in the isolated process only.

---

## 2. Size analysis: what would a Rust harness weigh?

### 2.1 Rust CLI binary size on macOS arm64

A tokio + axum (hyper) HTTP-server CLI compiles to roughly **5–20 MB** in optimized release builds. Standard shrink techniques (`opt-level = "z"`, `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, `strip = true`) reliably bring typical service binaries to the low single-digit-to-~10 MB range; these are the canonical settings documented in the community [min-sized-rust guide](https://github.com/johnthagen/min-sized-rust) and [measured before/after in the field](https://zenn.dev/collabostyle/articles/9ef563c290f3b2#1). UPX can cut a further 50–60% but is problematic for code signing / Gatekeeper on macOS (notarized apps should not UPX-pack binaries).

Realistically for the full harness feature set (rusqlite, portable-pty, reqwest, tokio, serde, tracing/otel, embedded web assets):

- lean web-server core: **8–15 MB**
- full harness parity: **15–25 MB** (before compression; ~8–12 MB after `strip`+`lto`, less with section-level dead stripping)

Compare per-option floors for the "harness runtime" component:

| Path | Runtime component size | Needs node_modules? |
|---|---|---|
| Bundled Node 24 (today) | 112 MB | yes, 277 MB more (389 − 112) |
| **Rust rewrite** | **~10–25 MB** | **no (except JS plugins/skills at runtime)** |
| `deno compile` | ~82 MB (Deno 2.5 hello-world standalone, [measured table](https://zenn.dev/ryuapp/scraps/3c707478a6af5d)) | no — npm deps can be bundled (with reach-scoped embedding since [Deno PR #34532](https://github.com/denoland/deno/pull/34532)) |
| `bun build --compile` | ~113 MB (Bun 1.2 hello-world, [same table](https://zenn.dev/ryuapp/scraps/3c707478a6af5d)) | no for bundled deps |
| Harness-download-on-first-run | 0 MB in app | downloaded (~40–100 MB) at first launch |

Note the JS-runtime-compile paths are **not size wins over the status quo** on macOS, where the harness already runs on the Electron binary (no extra runtime) — Deno/Bun would *add* an ~82–113 MB runtime to replace ~0 MB of marginal runtime. They only pay off on Windows/Linux, where they would replace the 112 MB Node binary with a similar-sized standalone — a wash.

### 2.2 What still ships regardless

The web UI is static JS/HTML assets, not Node code, and ships under any architecture:

- `@deepseek-ai/dsh-web-frontend/dist`: **5.7 MB** (4.7 MB `assets/` + 1 MB logo) — measured.
- `echarts`+`zrender`: 36 MB in node_modules today, but the frontend dist already bundles what it needs; the loose `echarts` package (32 MB in the .app) is plausibly prunable.
- `dsh-ppt`: **21 MB** skill/bundle assets.
- `dshmarket`: 6 MB.

So the **irreducible asset floor is roughly 30–35 MB** (web UI + PPT + brand assets) even in a fully-Rust world. A Rust harness would therefore land the `Resources/app` payload at roughly **~50 MB (25 MB binary + 30 MB assets + small runtime extras)** vs 389 MB today.

---

## 3. Effort analysis, grounded in the codebase

### 3.1 Subsystem-by-subsystem port difficulty

| Subsystem | Evidence (measured) | Rust difficulty | Notes |
|---|---|---|---|
| LLM HTTP clients | `dsh-llm` 456 KB, `dsh-llm-deepseek` 304 KB, `dsh-llm-pi-ai` 368 KB, retry | **Easy** | reqwest + serde + SSE streaming is a solved problem; the hard part is behavioral parity of retry/stream parsing |
| Bash/pwsh tools, PTYs | `dsh-tool-bash*`, `dsh-pwsh*`, `subprocess-local` uses **node-pty** | **Medium** | [`portable-pty`](https://crates.io/crates/portable-pty) (from wezterm) covers ConPTY/Unix PTYs; persistent-shell session semantics need careful re-testing |
| File tools | `dsh-tool-fs`, `dsh-tool-fs-search`, `dsh-fs-local` (uses **koffi** FFI) | Easy–Medium | std fs + `ignore`/`grep`-style crates; koffi usage must be identified and replaced per-platform |
| SQLite persistence | `dsh-session-query-sqlite` | **Medium** | [`rusqlite`](https://github.com/rusqlite/rusqlite) (bundled SQLite, no system dep) or [sqlx](https://github.com/launchbadge/sqlx) |
| JSONL session format + v0→v3 migrations | `dsh-session-persistence-jsonl` 724 KB, three migration packages | Medium | mostly mechanical serde work but must be byte-compatible (see Risks) |
| Sandbox | `sandbox`, `sandbox-local`, `sandbox-policy`, `sandbox-windows-acl`, native `landlock-run` (C11/musl) | **Medium–Hard** | landlock-run is already native C and could be kept as-is or absorbed; Windows ACL needs a Rust ACL story (windows-rs); macOS Seatbelt (sandbox-exec) profiles need re-implementation |
| Web host/server | `dsh-host-webserver`, `dsh-web-app`, `dsh-http-proxy`, `dsh-webhook(-github)` | **Easy** | axum/hyper; static asset serving + proxy + webhooks are straightforward |
| Agent loop / core | `packages/core` 46k LOC, `dsh-agent-loop` | **Hard (volume, not tech)** | reqwest-free, pure orchestration — Rust handles this fine, but 46k LOC of TS with heavy async semantics is the single biggest chunk; behavioral regressions here are the product |
| **typert / schemastery / typebox** | `typert` 16k LOC, `dsh-typert-generator` 24 MB, schemastery, typebox 6 MB | **Hard** | bespoke runtime type system + generator; in Rust this machinery becomes unnecessary *internally* (types are compile-time) but must be preserved **at the plugin boundary** |
| **cordis plugin system** | `cordis` + 5 plugin packages, `dsh-tool-cordis`, cordis host/client runners | **Very hard** | cordis is a JS IoC container with lifecycle/HMR; the plugin ecosystem (npm `dsh-plugin` topic, DSH Desktop's own plugin-recovery/market code) is JavaScript by contract. A Rust host cannot execute these plugins without a JS engine or an ABI redesign |
| Skills / agent instructions | `dsh-skill`, `dsh-skill-filesystem`, `dsh-agent-instructions`, `dsh-agent-presets`, `dsh-system-prompt` | Easy | markdown + small JS glue; ship as data |
| Subagents / workflow | `dsh-subagent` 668 KB, workflow + worker-thread packages | Medium | Rust tokio tasks replace worker_threads, but workflow *scripts* are JS running in workers — needs the embedded-JS answer |
| Compaction, telemetry, misc | compaction 8.8k LOC, `dsh-session-telemetry-otel` | Easy–Medium | [tracing-opentelemetry](https://crates.io/crates/tracing-opentelemetry) exists; otel adds a few MB to the binary |

### 3.2 The plugin problem is the crux

The harness's own README defines the architecture as "everything is a plugin, powered by Cordis", and the plugin contract is JavaScript packages discovered from npm/disk. Three possible Rust-side answers, none cheap:

1. **Embed a JS engine** — [`deno_core`](https://docs.rs/deno_core) (V8) or [`rquickjs`](https://github.com/dellsalmon/rquickjs)/QuickJS inside the Rust binary. Preserves plugin compat; adds ~10–30 MB (V8) and a large FFI surface to expose cordis-like lifecycle APIs. This erodes much of the size win.
2. **WASM plugin ABI** — redesign plugins as [wasmtime](https://github.com/bytecodealliance/wasmtime)-loaded modules (+~20–40 MB runtime, plus a new SDK and ecosystem breakage; wasmtime's component model is production-grade but this is a *new platform*, not a port).
3. **Drop/break the plugin ecosystem** — DSH Desktop ships its own plugins (cordis-plugin-loader/hmr/etc. in its dependencies) and has substantial desktop code for plugin recovery, markets, and safe mode. Breaking JS plugins breaks product features beyond size.

### 3.3 Incremental strategies

**(a) Full rewrite.** ~527k LOC of TS, of which maybe 60–70% is host-side relevant (the 94k-LOC `client` package is largely the web UI's client, already covered by the static frontend dist). Even discounting tests, a realistic host-side port is on the order of 150–250k LOC-equivalent. With strong AI assistance, rough order: **60–120 engineer-weeks** to feature parity, plus an unbounded tail of behavioral-parity regressions in the agent loop, and a permanent two-language maintenance burden *or* a hard ecosystem cutover. Highest risk, largest payoff (389 MB → ~50 MB).

**(b) Strangler-fig (Rust core + embedded JS for plugins/skills).** Port size-critical leaves (LLM clients, fs tools, session persistence, web server) to Rust while keeping a small JS runtime (deno_core or a sidecar Node/Deno) only for cordis plugins and workflow scripts. Binary lands ~30–50 MB + V8 (~15–30 MB) → **app payload ~80–120 MB**. Effort **40–80 engineer-weeks**, and it still carries most plugin-compat risk. The middle path exists but the middle is muddy: the cordis dependency graph reaches nearly everywhere (every package depends on cordis/cosmokit), so "just the core" is hard to carve.

**(c) Keep Node, stop shipping mistakes (no port).** Measured, immediate, zero-porting wins on the macOS build:
- drop `node_modules/node` on macOS (harness already runs via `ELECTRON_RUN_AS_NODE=1`): **−112 MB**
- drop `typescript` (21 MB), `pnpm` (12 MB), `jsdom` (12 MB): **−45 MB**
- prune loose `echarts`/`zrender` if the frontend dist is self-contained: up to **−36 MB**
- dedupe `@img`/sharp to the arm64 triple: up to **−10 MB**
- audit otel/aws-sdk/google/Vscode extras: plausibly **−10–20 MB**
Total realistic: **−180 to −220 MB → app ~405–445 MB** (with the 229 MB Electron still in place; the WKWebView work addresses that separately → **~180–220 MB total app**). Effort: **1–3 engineer-weeks**, mostly electron-builder `files` config + regression testing of plugin runtime (typescript/pnpm may be loaded lazily by plugins — verify before cutting; if a plugin truly needs tsc at runtime, keep it out of the mac build only if plugins-in-safe-mode don't hit it).

**(d) Deno/Bun single-file compile.** `deno compile` (~82 MB floor) or `bun build --compile` (~113 MB floor) for hello-world ([measured](https://zenn.dev/ryuapp/scraps/3c707478a6af5d)); real harness-size standalone will be larger once npm deps and the frontend assets are embedded, though Deno's reach-scoped npm embedding ([PR #34532](https://github.com/denoland/deno/pull/34532)) helps. Replaces (112 MB Node + 277 MB node_modules) with roughly **90–130 MB** → app payload ~100–140 MB. Effort: **3–8 engineer-weeks** (mostly making ~460 npm packages bundle cleanly under Deno/Bun, native addons are the pain: node-pty, koffi, sharp, landlock-run, better sqlite paths). Compatibility risk is much lower than Rust. But note on macOS it *adds* a runtime where Electron-as-Node already works — its win is really "one standalone binary for all three OSes", not size on mac.

---

## 4. Risks (Rust path)

1. **Session-format compatibility.** Existing user sessions are JSONL with three recorded format migrations (v0→v1→v2→v3 packages). A Rust reimplementation must read/write byte-compatible JSONL and the SQLite projection schema, and keep migrating old sessions. Gettable (serde is precise) but every divergence corrupts user history silently. Desktop docs mandate that upgrades never touch session data.
2. **Plugin ecosystem breakage.** cordis plugins are JavaScript by contract; `@deepseek-ai/cordis` is an explicit DSH Desktop dependency and the desktop app has first-class plugin market/recovery/safe-mode features. A Rust harness without a JS story breaks these products, not just third-party plugins.
3. **Windows parity.** Windows uses the bundled native Node exe today; the harness ships `sandbox-windows-acl`, pwsh tools, and win32 process helpers. Rust must reproduce ACL sandboxing (windows-rs), ConPTY (portable-pty does), and the windows child-process-hide tricks currently in `build/windows-child-process-hide.mjs`.
4. **Agent-loop regression risk.** `packages/core` is 46k LOC of orchestration whose *behavior* (tool-call ordering, compaction refusals — see `docs/upstream-compaction-refusal-2026-09-10.md` — approval flows, goal rounds) is the product. Snapshot tests exist upstream (`vitest.snapshot.config.ts`) and would need porting; cross-language behavioral drift is the classic rewrite killer.
5. **Two-language maintenance.** The harness is in rapid, compatibility-breaking iteration ("developer preview", breaking changes promised in the README). Pinning DSH Desktop to a Rust fork means re-porting every upstream release; the desktop repo already carries a patch layer per harness upgrade (`docs/harness-0.1.5-*.md`), and a Rust fork would multiply that cost.
6. **Native-addon replacement tail.** node-pty, koffi FFI in fs-local, sharp, landlock-run: each needs a Rust equivalent or keep-as-subprocess decision; individually small, collectively they touch sandbox-critical code.

---

## 5. Verdict and recommendation

**A Rust port is the wrong first tool for the size goal.** The goal is achievable with a ~5–20x smaller payload, but the codebase audit shows the cost driver is not the language — it is the 527k-LOC, cordis-plugin-coupled architecture whose ecosystem is JavaScript by contract. The decisive facts:

- **~157 MB of the 389 MB node_modules is waste or removable on macOS today** (112 MB Node binary that the mac build already doesn't need — the harness boots via `ELECTRON_RUN_AS_NODE=1` — plus typescript/pnpm/jsdom at 45 MB), and up to ~200 MB with echarts/sharp/otel pruning. Effort: **1–3 engineer-weeks.**
- The web UI assets (dsh-web-frontend 5.7 MB, dsh-ppt 21 MB, dshmarket 6 MB) ship under *any* backend; they set a ~35 MB asset floor.
- Deno/Bun compile floors (~82–113 MB) exceed what a tuned Rust binary costs (~10–25 MB), but they beat Rust's **60–120 engineer-weeks** with **3–8 weeks** — and on macOS they're not even a win versus Electron-as-Node.

### Recommended path, in order

| Step | Effort | `Resources/app` payload | Full .app (with Electron) | With WKWebView renderer |
|---|---|---|---|---|
| 0. Today | — | 389 MB | 625 MB | — |
| 1. Prune: drop mac `node` binary, typescript, pnpm, jsdom, prune echarts/sharp/otel | 1–3 wks | **~180–210 MB** | ~415–445 MB | **~190–220 MB** |
| 2. (Optional) Deno compile sidecar for Win/Linux to kill the 112 MB Node there | 3–8 wks | n/a (mac unchanged) | platform-dependent | — |
| 3. Rust harness rewrite | 60–120 wks + permanent fork maintenance | **~50 MB** | ~280 MB | **~85 MB** |

Do step 1 now. Re-evaluate step 3 only if (a) the size target after steps 0–1 + WKWebView is still unmet, and (b) the harness API stabilizes enough that a fork is maintainable. If a native harness ever happens, prefer **strategy (b) strangler-fig with an embedded JS engine for cordis plugins** (40–80 wks, ~80–120 MB payload) over a full rewrite — the plugin boundary, not the agent loop, is what forces JavaScript to survive.

### Key sources

- Rust binary-size techniques: [min-sized-rust](https://github.com/johnthagen/min-sized-rust), [measured opts](https://zenn.dev/collabostyle/articles/9ef563c290f3b2)
- JS-runtime standalone sizes (Deno 82 MB / Bun 113 MB / Node 89 MB hello-world): [zenn.dev/ryuapp](https://zenn.dev/ryuapp/scraps/3c707478a6af5d)
- Deno compile docs: [docs.deno.com/examples/deno_compile](https://docs.deno.com/examples/deno_compile/); npm reach-scoped embedding: [denoland/deno#34532](https://github.com/denoland/deno/pull/34532)
- SQLite: [rusqlite](https://github.com/rusqlite/rusqlite); PTY: [portable-pty (wezterm)](https://crates.io/crates/portable-pty); WASM: [wasmtime](https://github.com/bytecodealliance/wasmtime); embedded JS: [deno_core](https://docs.rs/deno_core), [rquickjs](https://github.com/dellsalmon/rquickjs)
- Landlock launcher design: `native/landlock-run/README.md` in the harness checkout
- Harness positioning/plugin contract: `/Volumes/DEV/deepseek-harness/README.md`; desktop runtime topology: `docs/architecture.md`
