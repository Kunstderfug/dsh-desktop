# Research: Migrating DSH Desktop from Electron to a Native macOS WKWebView Shell

*Status: feasibility research. Inventory sections are based on a direct audit of `src/` in this checkout (Electron 43.4.0, electron-vite 5, TypeScript). Web-sourced claims are cited to Apple/WebKit/Tauri/Electron primary sources.*

---

## 1. Executive summary

**Verdict: Feasible, but not a "thin WKWebView wrapper" — the workload is a hybrid.**

The single most important finding from the code audit: **DSH Desktop does not load a static built renderer from `dist/`.** It spawns a full Node.js harness process (bundled Node 24 + `build/harness-node-entry.mjs` running the `@deepseek-ai/dsh` CLI) that **serves the entire renderer UI over HTTP on `http://127.0.0.1:43129`**, and the Electron `BrowserWindow` simply does `window.loadURL(rendererUrl)` (`src/main/index.ts:1029`). Most application logic (agent loop, tools, sessions, file system, bash/pwsh, plugins) already lives **outside** Electron, in the harness Node process.

This changes the migration picture dramatically:

- The Chromium renderer dependency is weak — the renderer is a plain web app loaded over localhost HTTP, which WKWebView can load unchanged.
- The Node.js dependency is strong — the harness child process *is* Node, and the Electron main process (`src/main/`, ~31 IPC handlers plus plugin recovery, safe mode, profile migration, launch-agent auditing, mobile tunnels) is heavy Node code (`node:fs`, `node:crypto`, `node:net`, `yaml`, `spawn`, tunnels) that would have to be rewritten in Swift or preserved another way.
- Therefore the recommended path is **keep the harness Node backend and the renderer untouched; replace only the Electron main + preload with a Swift/AppKit WKWebView shell**, and keep Electron for the Windows build (`package:win` targets win32 NSIS).

---

## 2. Inventory: what the app actually uses from Electron

### 2.1 Electron imports in `src/`

| Module | Where used | Purpose |
|---|---|---|
| `app` | `src/main/index.ts`, `src/main/glm-quota.ts`, `src/main/update/update-manager.ts` | lifecycle, paths, `process.resourcesPath`, quit behavior |
| `BrowserWindow` | `src/main/index.ts` (main window, mobile window), `src/main/safe-mode-overlay.ts`, `src/main/security.ts`, `src/main/context-menu.ts` | window management, `loadURL`/`loadFile` |
| `WebContentsView` | `src/main/safe-mode-overlay.ts`, `src/main/windows-menu-view.ts` (via `loadFile('windows-menu.html')`) | overlay views (safe-mode banner, native-style menu overlay) |
| `ipcMain` | `src/main/index.ts`, `glm-quota.ts`, `update-manager.ts` | 31 registered handlers (full list in §2.3) |
| `ipcRenderer` | `src/preload/index.ts`, `src/preload/desktop-storage.ts`, `src/preload/windows-menu.ts`, `src/preload/windows-titlebar.ts` | bridge to main |
| `contextBridge` | `src/preload/index.ts` | exposes `window.dshDesktopDirectoryPicker`, `window.dshDesktopActions`, and 4 more bindings (`:385`–`:408`) |
| `Menu` | `src/main/index.ts`, `src/main/context-menu.ts`, `context-menu-template.ts` | application + context menus |
| `Tray` | `src/main/index.ts:906-915` | menu-bar status item with context menu, click-to-restore, close-to-tray behavior (`src/main/close-to-tray.ts`) |
| `dialog` | `src/main/desktop-service/index.ts`, `index.ts` (`MessageBoxOptions`) | directory picker, message boxes |
| `shell` | `src/main/security.ts`, `context-menu.ts`, `index.ts` | `openExternal`, `openPath`/show-in-finder |
| `powerMonitor` | `src/main/update/update-manager.ts` | resume-triggered update checks |
| `utilityProcess` | `src/main/index.ts:2670-2740`, `src/main/runtime/disclaimed-utility-process.ts` | **preferred** launcher for the harness child on macOS (Chromium-free Node process inside Electron) |
| `net` | `src/main/index.ts`, `desktop-service/index.ts` | local HTTP checks against the harness server |
| `nativeTheme` | `src/main/index.ts` | dark/light theme sync |
| `clipboard` | `src/main/context-menu.ts` | copy in context menu |
| `protocol` / `session` / `custom protocols` | **Not used.** No `registerFileProtocol`/`registerBufferProtocol` anywhere in `src/`. Only cookie cleanup against `127.0.0.1` in `src/main/window-navigation.ts` | — |
| `crashReporter` / `globalShortcut` / `screen` / `Notification` | **Not used** | — |

### 2.2 Node integration and renderer security posture

The renderer is already "web-clean": every window sets `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (`src/main/index.ts:467-471`, `:938-942`, `:2687`). The preload script is the only privileged renderer-side code, and it uses only `ipcRenderer` + `contextBridge` — no direct `node:fs` in the renderer. **This is the ideal shape for a WKWebView port**: the preload bridge can be re-implemented almost 1:1.

The harness child process, however, is real Node: `build/harness-node-entry.mjs` runs the `dsh` CLI under either an Electron `utilityProcess` (macOS) or a bundled Node binary (`bundledNodePath()`), serving the UI over HTTP (default port **43129** — the same port this very session's GUI is served on). The main process also shells out for: shell-environment capture (`osascript`/`powershell`, `src/main/runtime/harness-runtime.ts`), plugin install/uninstall (`spawn`, `src/main/runtime/profile-plugin-command.ts`, incl. `taskkill` on win32), launch-agent auditing (`src/main/state/launch-agent-audit.ts`), plugin component cleanup, and **cloudflared/pinggy tunnels** for the mobile pairing feature (`src/main/mobile/*.ts`). Native modules: `koffi` (FFI, pinned 3.1.5) and `node-pty` appear in `allowScripts`; the harness side uses them — these run in the Node child, not in Electron's renderer.

### 2.3 Complete IPC channel list (from grep of `src/`)

**Renderer → main, `ipcMain.handle` (request/response — maps to `WKScriptMessageHandlerWithReply`):**

```
desktop-menu:execute          desktop-menu:get-zoom-factor
desktop-titlebar:close-menu   desktop-titlebar:set-menu-open   desktop-titlebar:set-theme
desktop:about-info            directory-picker:open
glm-quota:get                 harness:open-in-finder
harness:open-recovery         harness:renderer-healthy
harness:reset-plugins         harness:restart                  harness:show-log
market:uninstall              mobile:open-pairing              mobile:status
recovery:action               safe-mode:action                 safe-mode:exit
safe-mode:manage              safe-mode:status
updates:check                 updates:download                 updates:install
updates:install-version       updates:list-versions            updates:skip
updates:status
```

**Renderer → main, `ipcMain.on` (fire-and-forget):** `dsh:storage-load-sync`, `dsh:storage-sync` (localStorage persistence to disk, `src/preload/desktop-storage.ts`).

**Main → renderer push, `webContents.send` (maps to `evaluateJavaScript` or reply-style user-content script injection):**

```
desktop-titlebar:close-menu   desktop-titlebar:theme-changed
desktop:new-session           desktop:add-directory            desktop:show-about
mobile:status-changed         updates:status-changed
```

### 2.4 Other main-process responsibilities that must be ported

- **Window lifecycle**: splash screen (`loadFile('splash.html')`), window raise without focus-stealing (`src/main/window-raise.ts`), main-window recovery, GPU-loss fallback with Chromium switches (`src/main/gpu-fallback.ts` — note: Chromium-specific `--*` switches have **no WKWebView equivalent**), launchd/daemon-mode guard (`src/main/launchd-guard.ts`).
- **Auto-update**: `electron-updater` generic feed at `https://dshdesktop.com/updates/latest/`, dmg/zip targets, hardened runtime, manual update-UI driven over IPC (`src/main/update/update-manager.ts`).
- **Profile/plugin state machine**: safe-mode profile, generation migration, plugin quarantine/recovery, pending-removal ledger — all Node `fs`/`yaml` code in `src/main/state/` (thousands of lines).
- **Multi-window**: main window + a separate mobile-pairing `BrowserWindow` (`index.ts:2678`) + `WebContentsView` overlays. Modest, maps to `NSWindow` + additional `WKWebView`s.
- **Cross-platform**: Windows builds (`package:win`, NSIS, `windows-hidden-console.mjs`, PowerShell env capture, Windows ACL sandbox packages in the harness dependency list) are first-class. A WKWebView shell is macOS-only (see §3.5).

### 2.5 What depends on Chromium/Node vs maps cleanly to WKWebView

| Concern | Depends on | WKWebView mapping |
|---|---|---|
| Renderer UI (served over `http://127.0.0.1:43129`) | Chromium rendering only | Loads in WKWebView as-is (localhost HTTP, no custom protocol needed) |
| Preload bridge (`contextBridge` + `ipcRenderer`) | Electron IPC | `WKScriptMessageHandler` / `WKScriptMessageHandlerWithReply` — clean 1:1 |
| 31 invoke channels + 2 sync channels + 7 push channels | Electron IPC | Direct port (§4.2) |
| Harness child process (`utilityProcess`/`spawn`) | Node runtime | Swift `Process` with stdout/stderr streaming — clean, but the child *is* Node, so Node must still ship (bundled Node binary or keep utility process) |
| Tray | Electron `Tray` | `NSStatusItem` + `NSMenu` — clean |
| Application/context menus | Electron `Menu` | `NSMenu`/`NSMenuItem` — clean; the custom `windows-menu.html` overlay view is only for Windows titlebar and can be dropped on macOS |
| Dialogs (`dialog.showOpenDialog`, message boxes) | Electron | `NSOpenPanel` / `NSAlert` — clean |
| `shell.openExternal` / show-in-finder | Electron | `NSWorkspace.open` / `activateFileViewerSelecting` — clean |
| Auto-update | electron-updater | Sparkle 2 ([sparkle-project.org](https://sparkle-project.org/documentation/)) — same generic appcast-style model, but feed format differs |
| powerMonitor resume | Electron | `NSWorkspace.willWakeNotification` — clean |
| GPU-fallback Chromium switches | **Chromium-only** | No equivalent; WKWebView manages its own GPU process — delete this code path |
| Safe-mode/recovery overlay views (`WebContentsView`) | Electron | Extra `WKWebView` on the same `NSWindow` — clean |
| `net` module local checks | Node/Electron | `URLSession` — clean |
| `src/main/state/*` + `src/main/runtime/*` Node logic | **Node.js** | The hard part: rewrite in Swift, or keep in a Node sidecar process |

---

## 3. WKWebView capability research (primary sources)

### 3.1 IPC replacement — `WKScriptMessageHandler` / `WKScriptMessageHandlerWithReply`

- [`WKScriptMessageHandler`](https://developer.apple.com/documentation/webkit/wkscriptmessagehandler) receives messages posted from JS via `window.webkit.messageHandlers.<name>.postMessage(...)`. Payload types are limited (numbers, strings, arrays, dictionaries, `WKScriptMessage`); binary data needs base64.
- [`WKScriptMessageHandlerWithReply`](https://developer.apple.com/documentation/webkit/wkscriptmessagehandlerwithreply) — [`userContentController(_:didReceive:replyHandler:)`](https://developer.apple.com/documentation/webkit/wkscriptmessagehandlerwithreply/usercontentcontroller(_:didreceive:replyhandler:)) — is the direct analog of `ipcRenderer.invoke` → `ipcMain.handle`: async request/response with a reply block (any `IPC`-encodable value). macOS 11+. Note: under Swift strict concurrency the reply handler must be `@Sendable` ([Apple forums thread 751086](https://developer.apple.com/forums/thread/751086)).
- Main→renderer push (`webContents.send`): `WKWebView.evaluateJavaScript(_:in:in:contentWorld:completionHandler:)` ([WKWebView docs](https://developer.apple.com/documentation/webkit/wkwebview)) or `WKUserContentController.addScriptMessageHandler` in reverse via an injected script plus an event. The cleanest pattern: inject a small shim script that defines `window.dshDesktop.*` with the same method signatures as the current `contextBridge` bindings, backed by `postMessage` + a `dispatchEvent` listener for push events — the renderer code never changes.
- `contextIsolation`-equivalent security: messages arrive in the native layer regardless of page JS; keep the shim in `WKUserContentController` with `WKContentWorld.pageWorld` isolation as needed.

### 3.2 Protocols, configuration, navigation

- [`WKURLSchemeHandler`](https://developer.apple.com/documentation/webkit/wkurlschemehandler) + [`WKURLSchemeTask`](https://developer.apple.com/documentation/webkit/wkurlschemetask) replaces Electron `protocol.register*Protocol` — **not needed here**, since the app loads plain `http://127.0.0.1`. If one ever wants to avoid localhost cookies/CORS, a custom `dsh://` scheme handler proxying the harness server is an option.
- [`WKWebViewConfiguration`](https://developer.apple.com/documentation/webkit/wkwebviewconfiguration): `websiteDataStore` (persistent storage ↔ replaces Electron `session` data), `userContentController` (user scripts ↔ Electron preload/webPreferences), `preferences` (feature flags).
- Navigation control: `WKNavigationDelegate` (`decidePolicyFor navigationAction` ↔ Electron `will-navigate` / the checks in `src/main/window-navigation.ts` restricting navigation to loopback hosts). The existing loopback-host allowlist logic ports directly.
- Popups/new windows: `WKUIDelegate.webView(_:createWebViewWith:for:allowing:windowFeatures:)` ([Apple docs](https://developer.apple.com/documentation/webkit/webuidelegate/webview(_:createwebviewwith:).md)) — equivalent of Electron `setWindowOpenHandler`.

### 3.3 Dev tools

- Safari Web Inspector on any WKWebView by setting [`isInspectable = true`](https://developer.apple.com/documentation/webkit/wkwebview/isinspectable) (macOS 13.3+), then attaching from Safari's Develop menu — see Apple's [Inspect Apps and Devices](https://developer.apple.com/documentation/safari-developer-tools/inspect-apps-and-devices) guide. Dev builds should set it; release builds should leave it `false` (Electron today ships with DevTools reachable, so this is a parity-or-hardening decision).

### 3.4 What WKWebView lacks vs Electron/Chromium

- **No Node.js in the renderer** — irrelevant here: the renderer already runs with `nodeIntegration: false`, and Node lives in the harness child process (which a native shell can still spawn via `Process`; the Node runtime binary still has to ship in the bundle — on macOS it can keep running as a plain child process, replacing the Electron `utilityProcess`, or the harness could ship as a separate Node runtime in `Contents/Resources`, exactly as the Windows/Linux builds already do via `bundledNodePath()`).
- **Rendering engine differences**: WebKit vs Blink. The renderer app is React 18 + standard web APIs; risk is CSS/layout and animation differences, not capability. WebGPU: supported in Safari/WebKit since Safari 26 (macOS 26); on older macOS WKWebView falls back to WebGL — verify against the harness UI's actual usage. WebGL works in WKWebView.
- **Service workers**: long-requested for WKWebView ([WebKit bug 206741](https://auto-bugs.webkit.org/show_bug.cgi?id=206741)); support exists in recent WebKit for first-party contexts but has historically been inconsistent for app-embedded webviews ([Apple forums 773539](https://developer.apple.com/forums/thread/773539)). **This app serves over loopback HTTP without an HTTPS origin, so service workers are effectively unavailable in both engines in this configuration — check the renderer bundle for actual SW registration before relying on any behavior.**
- **Printing / desktop capture / WebNotifications / extensions**: WKWebView has limited/no equivalents (`WKWebView.createPDF` for print-to-PDF; `UNUserNotificationCenter` for native notifications instead of the Web Notifications API). Grep of `src/` shows none of these are used by the Electron shell today, so they are non-blockers.
- **GPU process control**: Electron's `app.commandLine.appendSwitch` GPU fallback (`src/main/gpu-fallback.ts`) has no WKWebView equivalent — WebKit manages its own GPU process. Related feature will be reworked or dropped.
- **Tray/menus**: not WKWebView features at all; native AppKit covers them — `NSStatusItem` (tray), `NSMenu` (menus), `UNUserNotificationCenter` (notifications). 
- **Auto-update**: Sparkle 2 is the standard native framework ([Sparkle docs](https://sparkle-project.org/documentation/)); it handles EdDSA-signed appcasts, differential updates, and requires the same codesign/notarization discipline as electron-updater's macOS flow.
- **Crash reporting**: Electron's built-in `crashReporter` is unused; a native shell can adopt Apple's built-in crash reports (`.crash` files in `DiagnosticReports`) or MetricKit — no third-party dependency was found in the current app, so parity is maintained by doing nothing.

### 3.5 Packaging, distribution, footprint

- **Bundle**: a Swift app is a standard `.app` built by Xcode/`swift build` with an `Info.plist` — but here it must still bundle the Node runtime + harness packages (the bulk of today's install size is `node_modules/**` per `package.json` `build.files`, not the Electron binary itself).
- **Codesigning/notarization**: hardened runtime is already enabled (`build.mac.hardenedRuntime: true`); native path uses `codesign` + `notarytool` per Apple's [Notarizing macOS software before distribution](https://developer.apple.com/documentation/xcode/notarizing-macos-software-before-distribution). A spawned Node child inside a hardened-runtime app needs no special entitlement, but the **App Sandbox must stay off** (the app spawns arbitrary user CLIs — same as today's Electron build, which is not sandboxed).
- **Universal binary**: Xcode "Standard Architectures" produces arm64 + x64 in one build; the harness Node runtime must also be universal (or ship per-arch Node binaries and select at runtime).
- **Size/memory**: widely reported figures put Electron installs at roughly 100–250 MB and baseline RSS in the 150–400 MB range (see e.g. [Electron's own process-model docs](https://www.electronjs.org/docs/latest/tutorial/process-model) for why: one Chromium browser process + GPU + utility + renderer processes). A native AppKit+WKWebView shell is typically a few MB of app binary and meaningfully lower idle memory, since WKWebView shares the system WebKit — **however**, for this app the savings are bounded: the Node harness process (with `koffi`, `node-pty`, SQLite, the whole agent stack) remains and is itself heavyweight. Expect savings mainly from dropping Chromium (~one renderer + GPU + zygote processes), not from dropping Node. (*Figures in this paragraph are order-of-magnitude community/official-doc figures, not measured on this app; measure with Activity Monitor before committing.*)

### 3.6 Alternative middle paths

| Path | Description | Trade-offs |
|---|---|---|
| **A. Swift + WKWebView thin shell (recommended for macOS)** | New Xcode/Swift package; load `http://127.0.0.1:43129` in WKWebView; reimplement the preload bridge with `WKScriptMessageHandlerWithReply`; port tray/menus/dialogs/shell/Sparkle; spawn harness via `Process` (bundled Node, as win32 already does). Renderer + harness untouched. | macOS-only; requires rewriting `src/main` Node logic (~state machine is the bulk) in Swift **or** moving that logic into the harness/sidecar Node process |
| **B. Tauri 2** ([tauri.app](https://tauri.app), [wry](https://github.com/tauri-apps/wry)) | Rust shell using WKWebView on macOS (and WebView2 on Windows / WebKitGTK on Linux) — cross-platform, keeps one codebase | Rust rewrite of the main process; wry's IPC and menu/tray coverage is good but its Windows/Linux engines are *not* WKWebView, so rendering parity work reappears on other platforms; heavy Node sidecar still required |
| **C. Keep Electron, shrink scope** | Keep Electron everywhere; the fact that the UI is already served by the harness means Electron could shrink to a near-empty shell even without leaving | Zero migration cost; keeps Chromium weight |
| **D. Hybrid: native macOS shell + Electron for win32** | Path A plus keep the existing Electron build for `package:win` | Two shells to maintain, but each is small; the IPC surface (§2.3) is small and stable enough that dual maintenance is realistic |

Note the cross-platform constraint: `package.json` ships `package:win` (NSIS, x64) with Windows-specific code paths (hidden console, PowerShell env capture, Windows ACL sandbox packages, taskkill). WKWebView is a macOS/iOS technology only — any WKWebView-based path abandons Windows unless paired with Tauri/WebView2.

---

## 4. Migration plan sketch

### 4.1 Architecture

```
DSH.app (Swift/AppKit)
├── NSWindow + WKWebView  ← loads http://127.0.0.1:43129 (unchanged renderer)
├── Bridge: WKScriptMessageHandlerWithReply ("dshDesktop")
│    ├── injected WKUserScript shim defining window.dshDesktopActions /
│    │   dshDesktopDirectoryPicker / … (same signatures as contextBridge bindings)
│    └── push events via evaluateJavaScript → dispatchEvent
├── NSStatusItem (tray) + NSMenu (app/context menus) + NSOpenPanel/NSAlert (dialogs)
├── NSWorkspace (openExternal / show-in-finder) + UNUserNotificationCenter (unused today)
├── Sparkle 2 (updater; new appcast feed, replacing electron-updater generic feed)
├── Process → bundled Node → harness-node-entry.mjs → dsh serve (port 43129)
│    └── stdout/stderr piped, streamed to the bridge (replaces utilityProcess + log tailing)
└── Main-process Node logic: EITHER port to Swift OR (cheaper) move into the
    harness/sidecar Node process and expose over the existing localhost HTTP/IPC
```

### 4.2 Porting the IPC surface

Implement a generic dispatcher: one message-handler name, envelope `{ channel, id, payload }`, a Swift `switch` over the 31 channels in §2.3 calling native handlers, replying through the `WKScriptMessageHandlerWithReply` reply block. The 7 push channels become `evaluateJavaScript("window.__dshDesktopPush(<json>)")`. The two synchronous storage channels (`dsh:storage-load-sync`) deserve attention: Electron's sync IPC exists because the preload persists localStorage before page scripts run; in WKWebView the equivalent is a `WKUserScript` injected `atDocumentStart` plus `WKWebViewConfiguration.websiteDataStore` — or simply let `localStorage` persist natively and delete `desktop-storage.ts` entirely. Confirm whether the harness server serves the same origin today (it does — `127.0.0.1:43129`), making native `websiteDataStore` persistence a drop-in.

### 4.3 Ordering

1. Prototype: Swift window + WKWebView + `isInspectable` + load harness URL; verify the renderer boots read-only (no bridge) — this validates WebKit rendering parity cheaply.
2. Bridge shim + generic dispatcher; port the 31 channels in dependency order (trivial ones first: `harness:open-in-finder`, `desktop:about-info`; then updates, safe-mode, recovery).
3. Tray, menus, close-to-tray, window raise/recovery.
4. Harness process management via `Process` (reuse `prewarmShellEnvironment` shell-capture logic — port the `osascript` invocation or shell out the same way).
5. Sparkle + codesign/notarize pipeline; decide the `src/main/state` Node logic question (Swift port vs sidecar move) — this is the largest single cost driver and should be scoped before committing.
6. Keep the Electron build for win32 (and as fallback) until the macOS shell is qualified.

---

## 5. Verdict

**Feasibility: moderate-to-high for macOS; do not attempt as the sole shell.**

- **Rating: 7/10 feasibility for macOS-native; low for full cross-platform replacement.**
- **Effort estimate (rough):** 4–8 engineer-weeks for a macOS shell covering the *window/bridge/tray/menu/update/process* surface (the §2.3 IPC list is genuinely small). Add **3–6+ weeks** if the `src/main/state` plugin/profile/safe-mode machinery (~the majority of `src/main`) must be rewritten in Swift rather than relocated into the Node sidecar. The relocation-first strategy could keep the native shell in the 4–8 week range.
- **Biggest risks:**
  1. **WebKit/Blink rendering differences** in the harness UI (React app; likely minor but unmeasured).
  2. **The Node logic in `src/main`** — the hidden bulk; scope it before committing.
  3. **Update feed migration** to Sparkle appcasts and re-notarization.
  4. **Windows regression**: any WKWebView path strands win32 users; keeping Electron for Windows doubles shell maintenance.
  5. **Service-worker / storage behavioral differences** (likely moot — loopback HTTP origin).
  6. **GPU-fallback** logic has no WKWebView equivalent; GPU-loss handling must be redesigned.
- **Recommendation:** **Hybrid (Path D).** Build the Swift + WKWebView thin shell for macOS — the app's architecture (renderer served by the harness over loopback HTTP, renderer already sandboxed with zero Node in the page) makes it unusually well-suited — while retaining the existing Electron build for Windows. Re-evaluate Tauri 2 only if Windows Chromium-weight ever becomes a pressing problem; adopting Tauri buys cross-platform WebView shells at the cost of a Rust rewrite of main-process logic that this app largely doesn't need rewritten (it needs it *moved*, and Node→Node moves are cheaper than Node→Rust).

## Sources

- Apple: [WKWebView](https://developer.apple.com/documentation/webkit/wkwebview) · [WKScriptMessageHandler](https://developer.apple.com/documentation/webkit/wkscriptmessagehandler) · [WKScriptMessageHandlerWithReply reply handler](https://developer.apple.com/documentation/webkit/wkscriptmessagehandlerwithreply/usercontentcontroller(_:didreceive:replyhandler:)) · [concurrency note](https://developer.apple.com/forums/thread/751086) · [WKURLSchemeHandler](https://developer.apple.com/documentation/webkit/wkurlschemehandler) · [WKURLSchemeTask](https://developer.apple.com/documentation/webkit/wkurlschemetask) · [createWebView (UIDelegate)](https://developer.apple.com/documentation/webkit/webuidelegate/webview(_:createwebviewwith:).md) · [isInspectable](https://developer.apple.com/documentation/webkit/wkwebview/isinspectable) · [Inspect Apps and Devices (Web Inspector)](https://developer.apple.com/documentation/safari-developer-tools/inspect-apps-and-devices) · [WKWebViewConfiguration](https://developer.apple.com/documentation/webkit/wkwebviewconfiguration) · [Notarizing macOS software](https://developer.apple.com/documentation/xcode/notarizing-macos-software-before-distribution)
- WebKit: [Service Workers in WKWebView — bug 206741](https://auto-bugs.webkit.org/show_bug.cgi?id=206741) · [Apple forums: SW in WKWebView](https://developer.apple.com/forums/thread/773539)
- Electron: [Process model](https://www.electronjs.org/docs/latest/tutorial/process-model) · [Inter-process communication](https://www.electronjs.org/docs/latest/tutorial/ipc)
- Sparkle: [Documentation](https://sparkle-project.org/documentation/)
- Tauri: [tauri.app](https://tauri.app) · [wry repo](https://github.com/tauri-apps/wry)
- Codebase audit: `src/main/**`, `src/preload/**`, `build/harness-node-entry.mjs`, `package.json` (this checkout).
