import AppKit
import WebKit
import os

/// The WKWebView side of the preload bridge (src/preload/index.ts).
///
/// Injected at document start, it recreates the three `contextBridge` surfaces
/// the harness web UI looks for — `dshDesktopDirectoryPicker`, `dshDesktop`
/// and `dshGlmQuota` — on top of one async message channel. Handlers run in
/// Swift via WKScriptMessageHandlerWithReply, the same request/response shape
/// as ipcMain.handle.
enum DesktopBridge {
    static let messageHandlerName = "dshDesktopBridge"

    static func userScript() -> WKUserScript {
        let source = """
        (function() {
          let seq = 0;
          const pending = new Map();
          function invoke(channel, args) {
            return new Promise((resolve, reject) => {
              const id = ++seq;
              pending.set(id, { resolve, reject });
              window.webkit.messageHandlers.\(messageHandlerName).postMessage({ id, channel, args });
            });
          }
          window.__dshShellResolve = function(id, ok, value) {
            const entry = pending.get(id);
            if (!entry) return;
            pending.delete(id);
            if (ok) entry.resolve(value); else entry.reject(new Error(value));
          };
          window.dshDesktopDirectoryPicker = Object.freeze({
            pick: () => invoke('directory-picker:open', [])
          });
          window.dshDesktop = Object.freeze({
            restartHarness: () => invoke('harness:restart', []),
            uninstallMarket: () => invoke('market:uninstall', []),
            openInFinder: (path) => invoke('harness:open-in-finder', [path])
          });
          window.dshGlmQuota = Object.freeze({
            get: () => invoke('glm-quota:get', [])
          });
          window.dshDesktopActions = Object.freeze({
            onNewSession: (handler) => { window.__dshShellOnNewSession = handler; },
            onAddDirectory: (handler) => { window.__dshShellOnAddDirectory = handler; }
          });

          // Native macOS sidebar toggle support (NSToolbar .toggleSidebar item).
          // The harness sidebar's own collapse button carries locale-dependent
          // aria-labels; match all four shipped strings, then fall back to the
          // first labelled button inside the sidebar root.
          const SIDEBAR_TOGGLE_SELECTOR = [
            '[data-dsh-sidebar-root] button[aria-label="Open sidebar"]',
            '[data-dsh-sidebar-root] button[aria-label="Collapse sidebar"]',
            '[data-dsh-sidebar-root] button[aria-label="打开侧边栏"]',
            '[data-dsh-sidebar-root] button[aria-label="收起侧边栏"]'
          ].join(',');
          window.__dshShellToggleSidebar = function() {
            const button = document.querySelector(SIDEBAR_TOGGLE_SELECTOR);
            if (button) { button.click(); return true; }
            return false;
          };
          window.__dshShellSidebarIsCollapsed = function() {
            const button = document.querySelector(SIDEBAR_TOGGLE_SELECTOR);
            if (!button) return false;
            const label = button.getAttribute('aria-label');
            return label === 'Open sidebar' || label === '打开侧边栏';
          };
        })();
        """
        return WKUserScript(source: source, injectionTime: .atDocumentStart,
                            forMainFrameOnly: true, in: .page)
    }
}

/// Swift-side handlers. Anything not in this table resolves null and logs —
/// the POC ports channels lazily; the full list lives in src/main/index.ts.
final class DesktopBridgeHandler: NSObject, WKScriptMessageHandlerWithReply {
    let log = Logger(subsystem: "app.dsh.shell", category: "bridge")
    weak var webView: WKWebView?

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.name == DesktopBridge.messageHandlerName,
              let body = message.body as? [String: Any],
              let id = body["id"] as? Int,
              let channel = body["channel"] as? String else {
            replyHandler(nil, "bad bridge message")
            return
        }
        let args = body["args"] as? [Any] ?? []

        switch channel {
        case "directory-picker:open":
            pickDirectory(replyHandler: replyHandler, id: id)
        case "harness:open-in-finder":
            if let path = args.first as? String {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
                replyHandler(["ok": true], nil)
            } else {
                replyHandler(["ok": false], nil)
            }
        case "harness:renderer-healthy":
            replyHandler(nil, nil)
        case "harness:restart", "market:uninstall", "glm-quota:get":
            log.notice("channel \(channel, privacy: .public) not ported yet")
            replyHandler(["ok": false], nil)
        default:
            log.notice("unmapped bridge channel \(channel, privacy: .public)")
            replyHandler(nil, nil)
        }
    }

    private func pickDirectory(replyHandler: @escaping (Any?, String?) -> Void, id: Int) {
        DispatchQueue.main.async {
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.allowsMultipleSelection = false
            panel.message = "Choose a workspace directory"
            let result: [String: Any]
            if panel.runModal() == .OK, let url = panel.url {
                result = ["ok": true, "path": url.path]
            } else {
                result = ["ok": false, "canceled": true]
            }
            self.deliver(result, to: id, replyHandler: replyHandler)
        }
    }

    /// Push events (the webContents.send side of Electron IPC) run the
    /// callbacks the page registered through dshDesktopActions.onNewSession /
    /// .onAddDirectory.
    func push(name: String, script: String) {
        guard let webView else { return }
        webView.evaluateJavaScript(script) { _, error in
            if let error { self.log.error("push \(name, privacy: .public): \(String(describing: error), privacy: .public)") }
        }
    }

    private func deliver(_ value: Any?, to id: Int, replyHandler: @escaping (Any?, String?) -> Void) {
        replyHandler(value, nil)
    }
}
