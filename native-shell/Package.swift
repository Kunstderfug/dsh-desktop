// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "dsh-shell",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "DSHShell",
            path: "Sources/DSHShell"
        )
    ]
)
