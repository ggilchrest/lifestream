// SPDX-License-Identifier: Apache-2.0
import Foundation

/// Public UIKit lifecycle signals do not always distinguish screen lock from Home.
/// Continuation needs positive lock evidence; a late signal cannot resume a stopped
/// conversation. No timing guess, screen brightness or private lock API is used.
public struct AudienceLifecycle {
    public enum State { case foreground,inactive,locked,ended }
    public private(set) var state:State = .foreground
    private var lockEvidence=false
    public init() {}
    public mutating func becomeActive(){state = .foreground;lockEvidence=false}
    public mutating func resignActive(){if state == .foreground{state = .inactive}}
    public mutating func protectedDataUnavailable(){lockEvidence=true}
    public mutating func enterBackground(continueWhenLocked:Bool,protectedDataAvailable:Bool)->Bool {
        if !protectedDataAvailable{lockEvidence=true}
        guard state != .ended,continueWhenLocked,lockEvidence else{state = .ended;return false}
        state = .locked;return true
    }
    public mutating func protectedDataAvailable()->Bool {
        lockEvidence=false
        if state == .locked {state = .ended;return false}
        return true
    }
    public mutating func end(){state = .ended;lockEvidence=false}
}

/// Ownership and freshness are required in addition to a private classification.
/// A legacy timed declaration cannot masquerade as this app's live connection.
public struct AudienceConnectionLease {
    public let id:String,revision:Int,expiresAt:Date
    public init(_ value:[String:Any],expectedId:String,now:Date) throws {
        guard UUID(uuidString:expectedId) != nil,value["leaseId"] as? String == expectedId,
              let revision=value["revision"] as? Int,revision>=0,
              value["privateAllowed"] as? Bool == true,value["classification"] as? String == "solo-supported" else{throw VoiceError.invalidMessage}
        _=try AudienceLease(value,now:now)
        let parser=ISO8601DateFormatter();parser.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
        guard let raw=value["leaseExpiresAt"] as? String,let expires=parser.date(from:raw),expires>now,expires.timeIntervalSince(now)<=25 else{throw VoiceError.invalidMessage}
        id=expectedId;self.revision=revision;expiresAt=expires
    }
}
