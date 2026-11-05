import Foundation

/// Protected local mapping of one sample; it is not itself the server wire contract.
/// Never include it in routine diagnostics.
public struct NativeHealthObservation: Codable, Equatable {
    public let upstreamId: String
    public let category: String
    public let start: Date
    public let end: Date
    public let nativeSleep: HealthSleepValue?
    public let quantity: Double?
    public let unit: String?
    public let sourceBundle: String
    public let sourceVersion: String?
    public let deviceName: String?
    public let deviceModel: String?
    public let sourceTimeZone: String?
    public init(upstreamId: String, category: String, start: Date, end: Date, nativeSleep: HealthSleepValue?, quantity: Double?, unit: String?, sourceBundle: String, sourceVersion: String?, deviceName: String?, deviceModel: String?, sourceTimeZone: String?) {
        self.upstreamId=upstreamId;self.category=category;self.start=start;self.end=end;self.nativeSleep=nativeSleep;self.quantity=quantity;self.unit=unit;self.sourceBundle=sourceBundle;self.sourceVersion=sourceVersion;self.deviceName=deviceName;self.deviceModel=deviceModel;self.sourceTimeZone=sourceTimeZone
    }
}
