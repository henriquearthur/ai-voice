// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "escuta",
    platforms: [.macOS("26.0")],
    dependencies: [
        // Parakeet TDT v3 (Core ML, Neural Engine) e VAD Silero, para ESCUTA_STT=parakeet.
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.7"),
    ],
    targets: [
        // Regras puras (palavra de ativação, fim de fala, lock da fala), testáveis sem microfone.
        .target(name: "EscutaCore"),
        .executableTarget(
            name: "Escuta",
            dependencies: ["EscutaCore", .product(name: "FluidAudio", package: "FluidAudio")],
            linkerSettings: [
                // Info.plist embutido: o TCC lê daqui as frases de uso do microfone e da fala.
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
                              "-Xlinker", Context.packageDirectory + "/Resources/Info.plist"]),
            ]
        ),
        .testTarget(name: "EscutaCoreTests", dependencies: ["EscutaCore"]),
    ],
    swiftLanguageModes: [.v5]
)
