// SPDX-License-Identifier: Apache-2.0
import Foundation
import CoreFoundation

/// Main-thread preview lease bookkeeping, independent of the audio engine.
public struct PreviewOwnership {
    private var deadline:TimeInterval = 0
    private var settling = false
    private var generation = 0
    public init() {}
    @discardableResult public mutating func begin(now:TimeInterval) -> Int { generation += 1; deadline = now + 360; settling = false; return generation }
    public mutating func retire() { generation += 1 }
    public func isCurrent(_ ticket:Int) -> Bool { ticket == generation }
    public mutating func admitted(now:TimeInterval, remaining:TimeInterval) {
        guard remaining > 0, remaining <= 181 else { return }
        deadline = now + remaining + 1
    }
    public mutating func rejected() { deadline = 0; settling = false }
    public mutating func beginSettlement() { settling = true }
    public mutating func finishSettlement(accepted:Bool) { settling = false; if accepted { deadline = 0 } }
    public func waitSeconds(now:TimeInterval) -> Int { max(0,Int(ceil(deadline-now))) }
    public var isSettling:Bool { settling }
    public func busy(now:TimeInterval) -> Bool { settling || waitSeconds(now:now)>0 }
    public static func settlementAccepted(status:Int,data:Data) -> Bool {
        guard status == 200,let value = (try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else { return false }
        guard let accepted=value["accepted"] as? NSNumber,let physical=value["physicalPlaybackConfirmed"] as? NSNumber,CFGetTypeID(accepted)==CFBooleanGetTypeID(),CFGetTypeID(physical)==CFBooleanGetTypeID() else { return false }
        return accepted.boolValue && !physical.boolValue
    }
}
