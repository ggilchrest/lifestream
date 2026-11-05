// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "AssistantCore", platforms: [.iOS(.v15), .macOS(.v13)], products: [.library(name: "AssistantCore", targets: ["AssistantCore"])], targets: [.target(name: "AssistantCore", resources: [.process("Resources")]), .testTarget(name: "AssistantCoreTests", dependencies: ["AssistantCore"])])
