import Foundation

/// Operational status is separate from read-authorization knowledge and coverage.
/// HealthKit does not disclose whether the person denied an individual read type.
public enum HealthSupport: String, Codable { case unknown, supported, unsupported }
public enum HealthReadKnowledge: String, Codable { case unknown, notObservable }
public enum HealthCoverage: String, Codable { case unknown, partial, available }
public enum HealthReadOutcome: String, Codable { case unknown, noReadableData, received }
public enum HealthConnectionState: String, Codable { case notConnected, waitingForRebind, paused, waitingForUnlock, queuedForSync, offline, needsAttention, connected }
public struct HealthStatus: Codable, Equatable {
    public var support: HealthSupport
    public var readKnowledge: HealthReadKnowledge
    public var coverage: HealthCoverage
    public var latestRead: HealthReadOutcome
    public var connection: HealthConnectionState
    public init(support: HealthSupport = .unknown, readKnowledge: HealthReadKnowledge = .unknown, coverage: HealthCoverage = .unknown, latestRead: HealthReadOutcome = .unknown, connection: HealthConnectionState = .notConnected) {
        self.support=support;self.readKnowledge=readKnowledge;self.coverage=coverage;self.latestRead=latestRead;self.connection=connection
    }
    /// A successful empty result is not proof of denial, no sleep, or complete historical coverage.
    public mutating func observedEmptyRead() { latestRead = .noReadableData }
    public var label: String {
        if support == .unsupported { return "Not supported on this device" }
        switch connection {
        case .notConnected: return "Not connected"
        case .waitingForRebind: return "Confirm source owner to continue"
        case .paused: return "Paused"
        case .waitingForUnlock: return "Waiting for iPhone unlock"
        case .queuedForSync: return "Queued for sync"
        case .offline: return "Offline"
        case .needsAttention: return "Needs attention"
        case .connected: return latestRead == .noReadableData && coverage == .unknown ? "No readable data yet" : "Connected"
        }
    }
}
