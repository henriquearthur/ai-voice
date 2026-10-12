// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "desktop",
    platforms: [.macOS("14.0")],
    targets: [
        .executableTarget(name: "Jarvis", path: "Sources/Jarvis"),
    ],
    swiftLanguageModes: [.v5]
)
