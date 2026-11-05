// SPDX-License-Identifier: Apache-2.0
import Foundation

/// Volatile, explicit diagnostic session; identifiers are correlation labels only.
/// No arbitrary message, header, error, transcript, audio, or credential enters this API.
public enum AuditDiscoveryObservation:String {case absent,invalid,unavailable,expired,deadlineOutOfRange,retired,available,backgroundExcluded}
public enum VoiceAuditConsent:String {case heartbeat,turn}
public enum VoiceAuditEvent:String,Codable {case turnStarted, firstPCM, playbackStart, playbackStop, runtimeStop, speechInterrupt, localStop, auditStopRequested, terminalCompleted, terminalFailed, terminalInterrupted, retiredTerminal, privacyRequestStart, privacyRequestFinish}
public struct VoiceAuditEntry:Codable,Equatable {
    public let session:String,attempt:String,turn:Int?,event:VoiceAuditEvent,atMs:Int64,value:Int?,request:Int?
}
public final class BoundedVoiceAudit {
    public static let maximumDuration:TimeInterval=300,maximumRetention:TimeInterval=3600,maximumEntries=200
    private let now:()->Date,monotonic:()->TimeInterval,attemptFactory:()->UUID
    private var session:UUID?,attempt:UUID?,expires:Date?,hardStop:TimeInterval?,entries=[VoiceAuditEntry](),retired=[UUID]()
    private var issued:UInt64=0,applied:UInt64=0,contentEnabled=false,foreground=true,consentSequence=0
    public private(set) var observation:AuditDiscoveryObservation?
    public init(now:@escaping()->Date=Date.init,monotonic:@escaping()->TimeInterval={ProcessInfo.processInfo.systemUptime},attemptFactory:@escaping()->UUID=UUID.init){self.now=now;self.monotonic=monotonic;self.attemptFactory=attemptFactory}
    /// Any malformed, unavailable, off, or expired server status immediately disarms.
    /// The caller must fetch this authenticated status; this method grants no authority.
    private func isV4(_ value:String)->Bool{guard let id=UUID(uuidString:value),value==id.uuidString.lowercased() else{return false};let chars=Array(value);return chars[14]=="4" && ["8","9","a","b"].contains(chars[19])}
    public func update(version:Int?,active:Bool,session:String?,expiresAt:Date?,contentEnabled:Bool=false) {
        let current=now()
        guard foreground else{observation = .backgroundExcluded;disarm();return}
        guard active,version==1,let raw=session,isV4(raw),let id=UUID(uuidString:raw),let end=expiresAt else{observation = .invalid;disarm();return}
        guard end>current else{observation = .expired;disarm();return}
        guard end.timeIntervalSince(current)<=Self.maximumDuration else{observation = .deadlineOutOfRange;disarm();return}
        guard !retired.contains(id) else{observation = .retired;disarm();return}
        let stop=monotonic()+end.timeIntervalSince(current)
        if self.session != id {if let previous=self.session {retired.append(previous);if retired.count>32{retired.removeFirst()}};attempt=nil;hardStop=stop;expires=end}
        else {hardStop=min(hardStop ?? stop,stop);expires=min(expires ?? end,end)}
        self.session=id;self.contentEnabled=contentEnabled;observation = .available
    }
    public var active:Bool{guard let expires,let hardStop,session != nil,expires>now(),monotonic()<hardStop else{disarm();return false};return true}
    public var recordsContent:Bool{active && contentEnabled}
    /// Read only the closed audit status in an authenticated successful audience response.
    /// Errors, missing status and invalid data disarm without exposing response text.
    public func updateFromAudience(statusCode:Int,data:Data) {
        struct WireStatus:Decodable {let version:Int,active:Bool,session:String,expiresAt:String,contentEnabled:Bool}
        struct Envelope:Decodable {let diagnostics:WireStatus?}
        guard statusCode==200 else{observation = .unavailable;disarm();return}
        guard data.count<=65_536,let envelope=try? JSONDecoder().decode(Envelope.self,from:data) else{observation = .invalid;disarm();return}
        guard let value=envelope.diagnostics else{observation = .absent;disarm();return}
        let formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
        let end=formatter.date(from:value.expiresAt) ?? ISO8601DateFormatter().date(from:value.expiresAt)
        update(version:value.version,active:value.active,session:value.session,expiresAt:end,contentEnabled:value.contentEnabled)
    }
    /// Older HTTP completions cannot undo a newer off/error observation.
    public func beginStatusRequest()->UInt64{issued &+= 1;return issued}
    @discardableResult public func completeStatusRequest(_ ticket:UInt64,statusCode:Int,data:Data)->Bool{
        guard ticket>applied,ticket<=issued else{return false};applied=ticket
        updateFromAudience(statusCode:statusCode,data:data);return true
    }
    public func invalidatePendingStatus(){issued &+= 1;applied=issued;disarm()}
    public func suspend(){foreground=false;invalidatePendingStatus()}
    public func resumeForeground(){foreground=true}
    /// Stop controls affect audit only and must match the active session and attempt.
    @discardableResult public func stopFromServer(version:Int?,session:String?,attempt:String?,reason:String?)->Bool {
        guard version==1,let labels=correlation(),session==labels.session,attempt==labels.attempt,let reason,["operator_off","expired","capture_limit","capture_error","client_off","client_inactive"].contains(reason) else{return false}
        invalidatePendingStatus();return true
    }
    /// One attempt represents an explicitly started listening session. Each turn has its own ordinal.
    public func beginAttempt()->Bool{guard active else{return false};let id=attemptFactory();guard isV4(id.uuidString.lowercased()) else{return false};attempt=id;consentSequence=0;return true}
    public func correlation()->(session:String,attempt:String)?{guard active,let session,let attempt else{return nil};return(session.uuidString.lowercased(),attempt.uuidString.lowercased())}
    public func nextConsent(_ kind:VoiceAuditConsent)->(session:String,attempt:String,sequence:Int,kind:String)? {
        guard let labels=correlation(),consentSequence<1000 else{return nil};consentSequence += 1
        return(labels.session,labels.attempt,consentSequence,kind.rawValue)
    }
    @discardableResult public func record(_ event:VoiceAuditEvent,session:String,attempt:String,turn:Int?,value:Int?=nil,request:Int?=nil)->Bool {
        guard let labels=correlation(),labels.session==session,labels.attempt==attempt,turn.map({(1...4).contains($0)}) ?? true,value.map({(0...384_000).contains($0)}) ?? true,request.map({(1...160).contains($0)}) ?? true else{return false}
        let seconds=now().timeIntervalSince1970;guard seconds.isFinite,seconds>=0,seconds<10_000_000_000 else{return false}
        entries.append(VoiceAuditEntry(session:labels.session,attempt:labels.attempt,turn:turn,event:event,atMs:Int64(seconds*1000),value:value,request:request))
        if entries.count>Self.maximumEntries{entries.removeFirst(entries.count-Self.maximumEntries)}
        return true
    }
    public func prune(){let cutoff=now().timeIntervalSince1970-Self.maximumRetention;entries.removeAll{Double($0.atMs)/1000<cutoff}}
    public func snapshot()->[VoiceAuditEntry]{prune();return entries}
    public func endAttempt(){attempt=nil;consentSequence=0}
    public func clear(){entries.removeAll()}
    public func disarm(){if let old=session,!retired.contains(old){retired.append(old);if retired.count>32{retired.removeFirst()}};session=nil;attempt=nil;expires=nil;hardStop=nil;contentEnabled=false}
}
