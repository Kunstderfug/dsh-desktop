import AppKit
import WebKit
import os

/// Personal native macOS shell for DSH: AppKit window + WKWebView over the
/// harness's loopback endpoint. Replaces the Electron main process with
/// ~400 lines of Swift; the harness, renderer, and IPC semantics are shared
/// with the Electron app (see src/main/runtime/harness-runtime.ts).
final class AppDelegate: NSObject, NSApplicationDelegate {
    static let preferredPort = 43129
    let log = Logger(subsystem: "app.dsh.shell", category: "app")

    var window: NSWindow?
    var webView: WKWebView?
    var harness: HarnessProcess?
    let bridge = DesktopBridgeHandler()

    /// Same data home the Electron app uses, so sessions, plugins, and
    /// settings are shared between both shells.
    var dshHome: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return appSupport.appendingPathComponent("dsh-desktop/harness")
    }

    /// The Electron app's Resources directory holds the harness entry, the
    /// patch files, and node_modules. It is the *install source* for the
    /// first-run payload copy into shell-runtime (see RuntimeInstall);
    /// override with DSH_SHELL_RESOURCES.
    var sourceResourcesURL: URL {
        if let override = ProcessInfo.processInfo.environment["DSH_SHELL_RESOURCES"] {
            return URL(fileURLWithPath: override)
        }
        // Running from an .app bundle made by make-app.sh (symlinks Resources
        // to the Electron build's Resources).
        let bundleResources = Bundle.main.resourceURL
        if let bundleResources,
           FileManager.default.fileExists(atPath: bundleResources.appendingPathComponent("harness-node-entry.mjs").path) {
            return bundleResources
        }
        // Fallback for `swift run` from the repo: the live Electron build output.
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // Sources/DSHShell
            .deletingLastPathComponent() // Sources
            .deletingLastPathComponent() // native-shell
            .deletingLastPathComponent() // repo root
        return repoRoot
            .appendingPathComponent("dist/mac-arm64/DSH Desktop.app/Contents/Resources")
    }

    /// Where the harness payload lives once installed. Sits beside the
    /// harness home (dsh-desktop/harness) under Application Support.
    var installRoot: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return appSupport.appendingPathComponent("dsh-desktop/shell-runtime")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.regular)

        let node: NodeRuntime
        do {
            node = try NodeLocator.resolve()
            log.notice("using node \(node.executablePath, privacy: .public) (\(node.version.major).\(node.version.minor).\(node.version.patch))")
        } catch {
            presentFatalError(String(describing: error))
            return
        }

        prepareResources { [weak self] resources in
            guard let self else { return }
            let port = HarnessProcess.pickFreePort()
            let process = HarnessProcess(port: port)
            self.harness = process
            process.start(
                node: node,
                resources: resources,
                dshHome: self.dshHome,
                onReady: { [weak self] ready in
                    DispatchQueue.main.async { self?.openWindow(ready: ready) }
                },
                onFailure: { [weak self] message in
                    DispatchQueue.main.async { self?.presentFatalError(message) }
                }
            )
        }
    }

    /// Resolves the harness payload location: DSH_SHELL_RESOURCES for
    /// development, otherwise the first-run install under Application Support
    /// (copied or refreshed from the Electron build's Resources when the
    /// pinned harness version changes).
    private func prepareResources(completion: @escaping (URL) -> Void) {
        if let override = ProcessInfo.processInfo.environment["DSH_SHELL_RESOURCES"] {
            log.notice("using DSH_SHELL_RESOURCES override: \(override, privacy: .public)")
            completion(URL(fileURLWithPath: override))
            return
        }

        let source = sourceResourcesURL
        if RuntimeInstall.isUpToDate(source: source, installRoot: installRoot) {
            log.notice("harness payload up to date at \(self.installRoot.path, privacy: .public)")
            completion(self.installRoot)
            return
        }

        // Show the progress window synchronously: if the first run-loop pass
        // ends with no visible window, AppKit terminates the launch.
        let progress = InstallProgressWindow()
        progress.show()
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let version = try RuntimeInstall.install(source: source, installRoot: self.installRoot) { detail, step, total in
                    DispatchQueue.main.async { progress.update(detail: detail, step: step, of: total) }
                }
                DispatchQueue.main.async {
                    progress.close()
                    self.log.notice("installed harness \(version, privacy: .public) → \(self.installRoot.path, privacy: .public)")
                    completion(self.installRoot)
                }
            } catch {
                // Remove the partial copy so the next launch retries clean.
                RuntimeInstall.removeBrokenInstall(at: self.installRoot)
                DispatchQueue.main.async {
                    progress.close()
                    self.presentFatalError("Harness install failed: \(error)\n\nSource: \(source.path)")
                }
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        harness?.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func openWindow(ready: HarnessProcess.Ready) {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.addUserScript(DesktopBridge.userScript())
        bridge.webView = nil
        let handler: WKScriptMessageHandlerWithReply = bridge
        // Same .page world as the injected user script, so the bridge globals
        // it defines are visible to the harness web app itself.
        configuration.userContentController.addScriptMessageHandler(
            handler, contentWorld: .page, name: DesktopBridge.messageHandlerName
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        if #available(macOS 13.3, *) {
            webView.isInspectable = true // Safari Web Inspector replaces DevTools
        }
        webView.navigationDelegate = self
        bridge.webView = webView

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "DSH"
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("DSHShellMain")
        window.toolbar = makeToolbar()
        if #available(macOS 11.0, *) {
            // Default toolbar style renders a tall titlebar; unifiedCompact
            // merges title and toolbar into one standard-height strip.
            window.toolbarStyle = .unifiedCompact
        }
        makeAppMenu()
        makeStatusItem(window: window)

        // The first navigation carries the launch token; the host trades it
        // for the session cookie (desktopHarnessUrl in window-navigation.ts).
        var components = URLComponents(string: ready.endpoint)!
        if let token = ready.authToken {
            components.queryItems = [URLQueryItem(name: "token", value: token)]
        }
        webView.load(URLRequest(url: components.url!))

        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        self.window = window
        self.webView = webView
        log.notice("window open on \(ready.endpoint, privacy: .public)")
    }

    private func presentFatalError(_ message: String) {
        log.error("\(message, privacy: .public)")
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "DSH shell could not start"
        alert.informativeText = message
        alert.runModal()
        NSApplication.shared.terminate(nil)
    }

    // MARK: Native sidebar toggle

    /// The Finder/Mail-style chevron in the titlebar. AppKit wires it to the
    /// responder-chain `toggleSidebar:` action, which lands in the delegate
    /// below and drives the harness web sidebar's own collapse button — so the
    /// native toggle and the in-page toggle always agree on state.
    func makeToolbar() -> NSToolbar {
        let toolbar = NSToolbar(identifier: "DSHShellMain")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        return toolbar
    }

    @objc func toggleSidebar(_ sender: Any?) {
        webView?.evaluateJavaScript("window.__dshShellToggleSidebar ? window.__dshShellToggleSidebar() : false",
                                    completionHandler: nil)
    }

    // MARK: Menus

    /// The Electron app's menu surface, trimmed to what the shell can honor:
    /// File actions push the same events `webContents.send` did in Electron
    /// (desktop:new-session / desktop:add-directory), View mirrors the zoom
    /// and reload items from desktop-menu:*.
    func makeAppMenu() {
        let newSession = NSMenuItem(title: "New Session", action: #selector(pushNewSession), keyEquivalent: "n")
        newSession.keyEquivalentModifierMask = [.command]
        let addDirectory = NSMenuItem(title: "Add Directory…", action: #selector(pushAddDirectory), keyEquivalent: "o")
        addDirectory.keyEquivalentModifierMask = [.command]

        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(newSession)
        fileMenu.addItem(addDirectory)
        fileItem.submenu = fileMenu

        let reload = NSMenuItem(title: "Reload Page", action: #selector(reloadPage), keyEquivalent: "r")
        let zoomIn = NSMenuItem(title: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
        let zoomOut = NSMenuItem(title: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        let zoomReset = NSMenuItem(title: "Actual Size", action: #selector(zoomReset), keyEquivalent: "0")
        zoomReset.keyEquivalentModifierMask = [.command]
        let toggle = NSMenuItem(title: "Toggle Sidebar", action: #selector(toggleSidebar(_:)), keyEquivalent: "s")
        toggle.keyEquivalentModifierMask = [.command, .control]

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        for item in [reload, toggle, NSMenuItem.separator(), zoomIn, zoomOut, zoomReset] {
            viewMenu.addItem(item)
        }
        viewItem.submenu = viewMenu

        let appMenu = NSMenu()
        let appItem = NSMenuItem()
        appMenu.addItem(NSMenuItem(title: "Quit DSH Shell", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appItem.submenu = appMenu

        let mainMenu = NSMenu()
        for item in [appItem, fileItem, viewItem] {
            mainMenu.addItem(item)
        }
        NSApp.mainMenu = mainMenu
    }

    @objc func pushNewSession() {
        bridge.push(name: "desktop:new-session",
                    script: "window.__dshShellOnNewSession && window.__dshShellOnNewSession()")
    }

    @objc func pushAddDirectory() {
        bridge.push(name: "desktop:add-directory",
                    script: "window.__dshShellOnAddDirectory && window.__dshShellOnAddDirectory()")
    }

    @objc func reloadPage() {
        webView?.reload()
    }

    @objc func zoomIn() { adjustZoom(by: 0.1) }
    @objc func zoomOut() { adjustZoom(by: -0.1) }
    @objc func zoomReset() { webView?.pageZoom = 1.0 }

    private func adjustZoom(by delta: Double) {
        guard let webView else { return }
        webView.pageZoom = min(3.0, max(0.5, webView.pageZoom + delta))
    }

    // MARK: Tray

    var statusItem: NSStatusItem?

    private func makeStatusItem(window: NSWindow) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "DSH"
        let menu = NSMenu()
        let show = NSMenuItem(title: "Show DSH", action: #selector(showWindow), keyEquivalent: "")
        show.target = self
        menu.addItem(show)
        let restart = NSMenuItem(title: "Restart Harness", action: #selector(restartHarness), keyEquivalent: "r")
        restart.target = self
        menu.addItem(restart)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        item.menu = menu
        statusItem = item
    }

    @objc func showWindow() {
        window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    @objc func restartHarness() {
        harness?.stop()
        applicationDidFinishLaunching(Notification(name: Notification.Name("dsh-restart")))
    }
}

extension AppDelegate: NSToolbarDelegate {
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, .toggleSidebar, .flexibleSpace]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.toggleSidebar, .flexibleSpace, .space]
    }
}

extension AppDelegate: WKNavigationDelegate {
    /// Loopback allowlist (window-navigation.ts): only the harness origin may
    /// load in the window; external links open in the default browser.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let harnessHost = webView.url?.host ?? "127.0.0.1"
        if url.host == harnessHost || url.host == "127.0.0.1" {
            decisionHandler(.allow)
            return
        }
        if navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
