import Foundation

/// Resolves a usable Node.js runtime and spawns the harness the same way
/// `HarnessRuntime` + `harness-node-entry.mjs` do in the Electron app.
///
/// Personal build: probe a few standard locations, require Node >= 24 (the
/// version the harness packages are developed against), and fail loudly
/// otherwise. `DSH_SHELL_NODE` overrides everything for experimentation.

struct NodeRuntime {
    let executablePath: String
    let version: (major: Int, minor: Int, patch: Int)
}

enum NodeResolutionError: Error, CustomStringConvertible {
    case notFound
    case tooOld(String)

    var description: String {
        switch self {
        case .notFound:
            return "No Node.js runtime found. Install Node >= 24 (brew install node) or set DSH_SHELL_NODE."
        case .tooOld(let version):
            return "Node \(version) is too old for the harness; Node >= 24 is required."
        }
    }
}

enum NodeLocator {
    static func resolve(environment: [String: String] = ProcessInfo.processInfo.environment) throws -> NodeRuntime {
        if let override = environment["DSH_SHELL_NODE"] {
            return try validate(executablePath: override)
        }
        for candidate in searchPaths(home: FileManager.default.homeDirectoryForCurrentUser) {
            guard FileManager.default.isExecutableFile(atPath: candidate) else { continue }
            if let runtime = try? validate(executablePath: candidate) {
                return runtime
            }
        }
        throw NodeResolutionError.notFound
    }

    private static func searchPaths(home: URL) -> [String] {
        var paths = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node"
        ]
        // nvm: pick the highest installed version directory.
        let nvmVersions = home.appendingPathComponent(".nvm/versions/node")
        if let entries = try? FileManager.default.contentsOfDirectory(atPath: nvmVersions.path) {
            let parsed: [(version: [Int], name: String)] = entries.compactMap { name in
                let parts = name.split(separator: ".").compactMap { Int($0) }
                return parts.count == 3 ? (parts, name) : nil
            }
            let sorted = parsed.sorted { lhs, rhs in
                for (l, r) in zip(lhs.version, rhs.version) where l != r { return l < r }
                return lhs.version.count < rhs.version.count
            }
            for entry in sorted.reversed() {
                paths.append(nvmVersions.appendingPathComponent(entry.name + "/bin/node").path)
            }
        }
        paths.append(home.appendingPathComponent(".volta/bin/node").path)
        return paths
    }

    static func validate(executablePath: String) throws -> NodeRuntime {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executablePath)
        process.arguments = ["--version"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            throw NodeResolutionError.notFound
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard process.terminationStatus == 0,
              let version = parseVersion(output) else {
            throw NodeResolutionError.notFound
        }
        guard version.major >= 24 else {
            throw NodeResolutionError.tooOld(output)
        }
        return NodeRuntime(executablePath: executablePath, version: version)
    }

    private static func parseVersion(_ line: String) -> (major: Int, minor: Int, patch: Int)? {
        // v24.9.0
        let parts = line.dropFirst(line.hasPrefix("v") ? 1 : 0)
            .split(separator: ".").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return (parts[0], parts[1], parts[2])
    }
}

/// One live harness child process. Mirrors buildNodeArguments/buildHarnessArguments
/// in src/main/runtime/harness-runtime.ts.
final class HarnessProcess {
    struct Ready {
        let endpoint: String
        let authToken: String?
    }

    /// Mirrors harness-runtime.ts:extractLaunchToken: the host prints a
    /// `dsh web: http://…?token=…` line once the endpoint is up.
    static let launchTokenRegex = try! NSRegularExpression(pattern: #"\bdsh web:\s*(\S+)"#)

    let endpoint: String
    let port: Int
    private(set) var child: Process?

    init(port: Int) {
        self.port = port
        self.endpoint = "http://127.0.0.1:\(port)"
    }

    static func pickFreePort() -> Int {
        let socket = socket(AF_INET, SOCK_STREAM, 0)
        guard socket >= 0 else { return 43129 }
        defer { close(socket) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr = in_addr(s_addr: INADDR_LOOPBACK.bigEndian)
        let bindResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else { return 43129 }
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        guard getsockname(socket, withUnsafeMutablePointer(to: &addr) {
            UnsafeMutableRawPointer($0).assumingMemoryBound(to: sockaddr.self)
        }, &len) == 0 else { return 43129 }
        let networkOrder = addr.sin_port.bigEndian
        return Int(networkOrder)
    }

    /// Launches the harness and calls `onReady` once the launch token line has
    /// been seen and the endpoint answers. Falls back to `onFailure` otherwise.
    func start(
        node: NodeRuntime,
        resources: URL,
        dshHome: URL,
        onReady: @escaping (Ready) -> Void,
        onFailure: @escaping (String) -> Void
    ) {
        let dshEntry = resources.appendingPathComponent("app/node_modules/@deepseek-ai/dsh/lib/bin.js")
        let nodeEntry = resources.appendingPathComponent("harness-node-entry.mjs")
        let patch = resources.appendingPathComponent("dsh-desktop.patch.yml")

        guard FileManager.default.fileExists(atPath: dshEntry.path) else {
            onFailure("Harness entry not found at \(dshEntry.path) — point DSH_SHELL_RESOURCES at the Electron app's Resources directory.")
            return
        }

        try? FileManager.default.createDirectory(at: dshHome, withIntermediateDirectories: true)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: node.executablePath)
        process.arguments = [
            nodeEntry.path,
            dshEntry.path,
            "web",
            "--patch", patch.path,
            "--no-open",
            "--host", "127.0.0.1",
            "--port", String(port)
        ]

        var environment = ProcessInfo.processInfo.environment
        // GUI apps inherit a minimal PATH; give the harness's tool spawns
        // (git, bash, node itself) the usual Homebrew + node directories.
        let extraPaths = ["/opt/homebrew/bin", "/usr/local/bin",
                          (node.executablePath as NSString).deletingLastPathComponent]
        let currentPath = environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        environment["PATH"] = (extraPaths.filter { !currentPath.contains($0) } + [currentPath]).joined(separator: ":")
        environment["DSH_HOME"] = dshHome.path
        process.environment = environment

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        do {
            try process.run()
        } catch {
            onFailure("Harness could not start: \(error)")
            return
        }
        child = process

        let logPath = logFile.path
        if !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: nil)
        }
        guard let logHandle = FileHandle(forWritingAtPath: logPath) else {
            onFailure("Could not open harness log at \(logPath)")
            return
        }
        logHandle.seekToEndOfFile()
        logHandle.write(Data("[dsh-shell] starting \(Date()) port=\(port)\n".utf8))

        var token: String?
        let tokenReady = DispatchSemaphore(value: 0)
        stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            logHandle.write(data)
            guard token == nil,
                  let text = String(data: data, encoding: .utf8),
                  let extracted = Self.extractToken(from: text) else { return }
            token = extracted
            tokenReady.signal()
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            logHandle.write(data)
        }

        DispatchQueue.global().async { [weak self] in
            _ = tokenReady.wait(timeout: .now() + 60)
            guard let self, let authToken = token else {
                onFailure("Harness did not print a launch token within 60s — see \(self?.logFile.path ?? "the log").")
                return
            }
            self.waitUntilHealthy(authToken: authToken)
            self.child = nil
            onReady(Ready(endpoint: self.endpoint, authToken: authToken))
        }
    }

    func stop() {
        guard let child, child.isRunning else { return }
        child.terminate()
        child.waitUntilExit()
    }

    var logFile: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/dsh-shell.log")
    }

    /// Mirrors isHarnessStartupProbeHealthy: any non-server-error answer with a
    /// token in hand means the endpoint is ours to open.
    private func waitUntilHealthy(authToken: String, timeout: TimeInterval = 45) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            var request = URLRequest(url: URL(string: endpoint)!)
            request.httpMethod = "HEAD"
            request.timeoutInterval = 2
            let semaphore = DispatchSemaphore(value: 0)
            var status = 0
            URLSession.shared.dataTask(with: request) { _, response, _ in
                status = (response as? HTTPURLResponse)?.statusCode ?? 0
                semaphore.signal()
            }.resume()
            _ = semaphore.wait(timeout: .now() + 3)
            if status >= 200 && status < 500 { return }
            usleep(250_000)
        }
        _ = authToken
    }

    static func extractToken(from text: String) -> String? {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = launchTokenRegex.firstMatch(in: text, range: range),
              let urlRange = Range(match.range(at: 1), in: text),
              let components = URLComponents(string: String(text[urlRange])) else { return nil }
        return components.queryItems?.first { $0.name == "token" }?.value
    }
}
