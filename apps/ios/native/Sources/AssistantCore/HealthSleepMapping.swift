import Foundation

/// HealthKit native sleep category values, preserved separately from any interpretation.
public enum HealthSleepStage: String, Codable { case inBed, awake, coreLight, deep, rem, asleepUnspecified, unknown }
public struct HealthSleepValue: Codable, Equatable {
    public let stage: HealthSleepStage
    public let nativeValue: Int
    public init(nativeValue: Int) {
        self.nativeValue=nativeValue
        switch nativeValue { case 0: stage = .inBed; case 1: stage = .asleepUnspecified; case 2: stage = .awake; case 3: stage = .coreLight; case 4: stage = .deep; case 5: stage = .rem; default: stage = .unknown }
    }
}
