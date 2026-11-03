// swift-tools-version: 6.0
// Ayudante nativo de Buddy para macOS: Apple Intelligence (Foundation Models), dictado de Apple
// (SpeechAnalyzer), OCR (Vision) y teclado/ratón (CGEvent) para las rutinas.
// Compílalo con ./build.sh (Xcode 26 o superior). Con Xcode 27 activa también las imágenes.
import PackageDescription

let package = Package(
    name: "BuddyApple",
    platforms: [.macOS("26.0")],
    products: [.executable(name: "buddy-apple", targets: ["BuddyApple"])],
    targets: [
        .executableTarget(
            name: "BuddyApple",
            path: "Sources/BuddyApple",
            // Modo Swift 5: las comprobaciones de concurrencia estricta quedan como avisos.
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
