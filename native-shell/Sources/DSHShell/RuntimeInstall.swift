import Foundation
import AppKit

/// First-run (and per-update) installation of the harness payload.
///
/// The shell binary itself is a few hundred kilobytes; the harness (node
/// entry loader, cordis patch files, and ~260 MB of node_modules) is copied
/// once from the Electron build's Resources into
/// `~/Library/Application Support/dsh-desktop/shell-runtime`. After that the
/// shell is fully independent of the Electron app — the source tree only
/// matters again when the pinned harness version changes, which triggers a
/// re-copy.
///
/// DSH_SHELL_RESOURCES bypasses the install entirely for development.
enum RuntimeInstall {
    struct Result {
        let resourcesURL: URL
        let didInstall: Bool
        let version: String
    }

    static func markerVersion(at installRoot: URL) -> String? {
        guard let data = try? Data(contentsOf: installRoot.appendingPathComponent("marker.json")),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return object["harnessVersion"] as? String
    }

    /// The harness version an `app/` directory carries (its
    /// `@deepseek-ai/dsh` package.json version).
    static func harnessVersion(inAppDir appDir: URL) -> String? {
        let manifest = appDir.appendingPathComponent("node_modules/@deepseek-ai/dsh/package.json")
        guard let data = try? Data(contentsOf: manifest),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return object["version"] as? String
    }

    /// Whether the destination exists and matches the source harness version.
    static func isUpToDate(source: URL, installRoot: URL) -> Bool {
        guard markerVersion(at: installRoot) != nil,
              let installed = harnessVersion(inAppDir: installRoot.appendingPathComponent("app")),
              let incoming = harnessVersion(inAppDir: source.appendingPathComponent("app")),
              installed == incoming else { return false }
        return FileManager.default.fileExists(atPath: installRoot.appendingPathComponent("harness-node-entry.mjs").path)
    }

    /// Copies the payload with coarse progress reporting: one progress step
    /// per top-level node_modules entry (~300 steps), plus the entry/patch
    /// files. On failure, removes the partial install so the next launch
    /// retries cleanly.
    static func install(
        source: URL,
        installRoot: URL,
        onProgress: @escaping (String, Int, Int) -> Void
    ) throws -> String {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: installRoot, withIntermediateDirectories: true)
        let version = harnessVersion(inAppDir: source.appendingPathComponent("app")) ?? "unknown"

        // Small top-level files first, so a failure can't strand a directory
        // that looks complete. windows-child-process-hide.mjs is a static
        // import of harness-node-entry.mjs and must be present on all
        // platforms; windows-hidden-console.mjs is win32-only but tiny.
        for name in ["harness-node-entry.mjs", "windows-child-process-hide.mjs",
                     "windows-hidden-console.mjs", "dsh-desktop.patch.yml",
                     "dsh-desktop-safe.patch.yml"] {
            let from = source.appendingPathComponent(name)
            guard fileManager.fileExists(atPath: from.path) else { continue }
            let to = installRoot.appendingPathComponent(name)
            if fileManager.fileExists(atPath: to.path) {
                try fileManager.removeItem(at: to)
            }
            try fileManager.copyItem(at: from, to: to)
        }

        let sourceApp = source.appendingPathComponent("app")
        let targetApp = installRoot.appendingPathComponent("app")
        if fileManager.fileExists(atPath: targetApp.path) {
            try fileManager.removeItem(at: targetApp)
        }
        try fileManager.createDirectory(at: targetApp, withIntermediateDirectories: true)
        try fileManager.copyItem(at: sourceApp.appendingPathComponent("package.json"),
                                 to: targetApp.appendingPathComponent("package.json"))

        let modulesSource = sourceApp.appendingPathComponent("node_modules")
        let modulesTarget = targetApp.appendingPathComponent("node_modules")
        try fileManager.createDirectory(at: modulesTarget, withIntermediateDirectories: true)

        let entries = (try? fileManager.contentsOfDirectory(atPath: modulesSource.path))?.sorted() ?? []
        let total = max(entries.count, 1)
        for (index, entry) in entries.enumerated() {
            let from = modulesSource.appendingPathComponent(entry)
            var isDirectory: ObjCBool = false
            fileManager.fileExists(atPath: from.path, isDirectory: &isDirectory)
            let to = modulesTarget.appendingPathComponent(entry)
            try? fileManager.removeItem(at: to)
            try fileManager.copyItem(at: from, to: to)
            onProgress(entry, index + 1, total)
        }

        let marker: [String: Any] = [
            "harnessVersion": version,
            "installedAt": ISO8601DateFormatter().string(from: Date())
        ]
        let markerData = try JSONSerialization.data(withJSONObject: marker, options: [.prettyPrinted, .sortedKeys])
        try markerData.write(to: installRoot.appendingPathComponent("marker.json"))
        return version
    }

    static func removeBrokenInstall(at installRoot: URL) {
        try? FileManager.default.removeItem(at: installRoot)
    }
}

/// A minimal progress window shown while the payload copies (first run or a
/// harness version bump). Modal-feeling but non-blocking to the run loop.
final class InstallProgressWindow {
    private let window: NSWindow
    private let label: NSTextField
    private let spinner: NSProgressIndicator

    init() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 110),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.title = "DSH Shell"

        label = NSTextField(wrappingLabelWithString: "Preparing harness…")
        label.frame = NSRect(x: 20, y: 62, width: 340, height: 36)
        label.isEditable = false
        label.font = .systemFont(ofSize: 12)

        spinner = NSProgressIndicator()
        spinner.style = .bar
        spinner.isIndeterminate = true
        spinner.frame = NSRect(x: 20, y: 30, width: 340, height: 18)
        spinner.startAnimation(nil)

        let content = NSView(frame: NSRect(x: 0, y: 0, width: 380, height: 110))
        content.addSubview(label)
        content.addSubview(spinner)
        window.contentView = content
        window.center()
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
    }

    func update(detail: String, step: Int, of total: Int) {
        label.stringValue = "Installing harness — \(detail) (\(step)/\(total))"
        window.displayIfNeeded()
    }

    func close() {
        window.orderOut(nil)
    }
}
