// SPDX-License-Identifier: Apache-2.0
import Foundation

/// Last observed connection/session state, not an always-on reachability probe.
/// Only a validated authenticated response may establish authentication. Privacy,
/// microphone state, saved URLs and saved cookies are deliberately not inputs.
public struct ConnectionStatus {
    public enum State:String {case disconnected, checking, connected}
    public enum Reason:String,CaseIterable {
        case unconfigured, signedOut="signed_out", connecting, restoring, verified
        case unverified, verificationExpired="verification_expired"
        case networkUnavailable="network_unavailable", serviceUnavailable="service_unavailable"
        case authenticationRequired="authentication_required", unavailable
        public var diagnosticCode:DiagnosticCode {
            switch self {
            case .unconfigured:return .connectionUnconfigured
            case .signedOut:return .connectionSignedOut
            case .connecting:return .connectionConnecting
            case .restoring:return .connectionRestoring
            case .verified:return .connectionVerified
            case .unverified:return .connectionUnverified
            case .verificationExpired:return .connectionVerificationExpired
            case .networkUnavailable:return .networkUnavailable
            case .serviceUnavailable:return .connectionServiceUnavailable
            case .authenticationRequired:return .authenticationRequired
            case .unavailable:return .connectionUnavailable
            }
        }
    }
    public enum Observation {case reset, configured, restoring, connecting, retrying, authenticated, reachable, verificationUnavailable, networkFailure, serviceFailure, authenticationFailure, signedOut, unavailable}
    public static let freshnessSeconds:TimeInterval=30
    public private(set) var state:State = .disconnected
    public private(set) var reason:Reason = .unconfigured
    public private(set) var revision=0
    private var authenticated=false
    private var lastVerified:TimeInterval?
    public init(){}
    private mutating func set(_ state:State,_ reason:Reason){
        guard self.state != state || self.reason != reason else{return}
        self.state=state;self.reason=reason;revision += 1
    }
    public mutating func observe(_ observation:Observation,at now:TimeInterval){
        guard now.isFinite,now>=0 else{authenticated=false;lastVerified=nil;set(.checking,.unverified);return}
        switch observation {
        case .reset:authenticated=false;lastVerified=nil;set(.disconnected,.unconfigured)
        case .configured,.signedOut:authenticated=false;lastVerified=nil;set(.disconnected,.signedOut)
        case .restoring:authenticated=false;lastVerified=nil;set(.checking,.restoring)
        case .connecting:lastVerified=nil;set(.checking,.connecting)
        case .retrying:if authenticated && state != .connected{set(.checking,.connecting)}
        case .authenticated:authenticated=true;lastVerified=now;set(.connected,.verified)
        case .reachable:if authenticated{lastVerified=now;set(.connected,.verified)}
        case .verificationUnavailable:lastVerified=nil;set(.checking,.unverified)
        case .networkFailure:set(.disconnected,.networkUnavailable)
        case .serviceFailure:set(.disconnected,.serviceUnavailable)
        case .authenticationFailure:authenticated=false;lastVerified=nil;set(.disconnected,.authenticationRequired)
        case .unavailable:authenticated=false;lastVerified=nil;set(.disconnected,.unavailable)
        }
    }
    public mutating func expire(at now:TimeInterval){
        guard state == .connected,let lastVerified else{return}
        guard now.isFinite,now>=lastVerified else{set(.checking,.unverified);return}
        if now-lastVerified>=Self.freshnessSeconds{set(.checking,.verificationExpired)}
    }
    public func remainingFreshness(at now:TimeInterval)->TimeInterval?{
        guard state == .connected,let lastVerified,now.isFinite,now>=lastVerified else{return nil}
        return max(0,Self.freshnessSeconds-(now-lastVerified))
    }
}
