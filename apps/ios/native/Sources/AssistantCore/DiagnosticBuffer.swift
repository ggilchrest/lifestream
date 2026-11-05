// SPDX-License-Identifier: Apache-2.0
import Foundation

/// The closed event vocabulary is the privacy boundary: no message, error text,
/// route/device name, URL, credential, identifier or asset content is accepted.
public enum DiagnosticEvent:String,Codable,CaseIterable {
    case appStarted="app_started", appForeground="app_foreground", appBackground="app_background"
    case settingsOpened="settings_opened", settingsSaved="settings_saved", settingsFailed="settings_failed"
    case connectionRestoreNativeStart="connection_restore_native_start", connectionRestoreNativeDone="connection_restore_native_done", connectionRestoreNativeFailed="connection_restore_native_failed"
    case connectionRestoreStart="connection_restore_start", connectionRestoreDone="connection_restore_done", connectionRestoreFailed="connection_restore_failed"
    case signInStart="sign_in_start", signInDone="sign_in_done", signInFailed="sign_in_failed", signOut="sign_out"
    case httpAuth="http_auth", httpText="http_text", textStreamComplete="text_stream_complete", httpAudience="http_audience", httpSession="http_session", httpHistory="http_history", httpOther="http_other"
    case audienceRenewFailure="audience_renew_failure", voicePrivacyFailure="voice_privacy_failure"
    case auditDiscoveryAbsent="audit_discovery_absent", auditDiscoveryInvalid="audit_discovery_invalid", auditDiscoveryUnavailable="audit_discovery_unavailable", auditDiscoveryExpired="audit_discovery_expired", auditDiscoveryDeadlineOutOfRange="audit_discovery_deadline_out_of_range", auditDiscoveryRetired="audit_discovery_retired", auditDiscoveryAvailable="audit_discovery_available", auditDiscoveryBackground="audit_discovery_background"
    case auditAttemptCreated="audit_attempt_created", auditTurnEnrolled="audit_turn_enrolled", auditUnlabeledStart="audit_unlabeled_start", auditBackgroundExcluded="audit_background_excluded", auditShareEmpty="audit_share_empty"
    case audienceBegin="audience_begin", audienceReady="audience_ready", audienceFailed="audience_failed", audienceEnded="audience_ended", privacyProtected="privacy_protected"
    case historyCreate="history_create", historyCreateDone="history_create_done", historyCreateFailed="history_create_failed"
    case historySelect="history_select", historySelectDone="history_select_done", historySelectFailed="history_select_failed", historyRefresh="history_refresh", historyHide="history_hide", historyRefreshDone="history_refresh_done", historyRefreshFailed="history_refresh_failed", historyOlder="history_older"
    case textStart="text_start", textDone="text_done", textFailed="text_failed", textCancelled="text_cancelled", textContextChanged="text_context_changed"
    case voiceSpeech="voice_speech", voiceCommitted="voice_committed", voiceTranscribed="voice_transcribed", voiceResponseStarted="voice_response_started", voiceGenerationDone="voice_generation_done", voiceTurnCompleted="voice_turn_completed"
    case voiceTurnStarted="voice_turn_started", voiceTranscriptEmpty="voice_transcript_empty", voiceTerminalFailed="voice_terminal_failed", voiceTerminalInterrupted="voice_terminal_interrupted"
    case voiceInputLimit="voice_input_limit"
    case voiceStart="voice_start", voiceTransportStarted="voice_transport_started", voiceReady="voice_ready", voiceFailed="voice_failed", voiceStop="voice_stop", voiceInterrupted="voice_interrupted"
    case socketSettlementSent="socket_settlement_sent", socketSettlementFailed="socket_settlement_failed"
    case socketOpen="socket_open", socketClosed="socket_closed", socketAccepted="socket_accepted", socketFailed="socket_failed"
    case captureReady="capture_ready", captureRecovery="capture_recovery", routeChanged="route_changed", routeSpeaker="route_speaker", routeBluetooth="route_bluetooth", routeWired="route_wired", routeOther="route_other", sampleRate="sample_rate"
    case deliveryGap="delivery_gap", playbackStart="playback_start", playbackDrained="playback_drained", playbackFinished="playback_finished", playbackCancelled="playback_cancelled"
    case avatarLoad="avatar_load", avatarReady="avatar_ready", avatarFailed="avatar_failed", cameraChanged="camera_changed", cameraReset="camera_reset", physicsChanged="physics_changed", animationSelected="animation_selected", animationAutomatic="animation_automatic"
    case diagnosticsEnabled="diagnostics_enabled", diagnosticsDisabled="diagnostics_disabled", diagnosticsCleared="diagnostics_cleared"
}
public enum DiagnosticCode:String,Codable {
    case historyPrivateScopeRequired="history_private_scope_required", runtimeContextChanged="runtime_context_changed", historySelectionBusy="history_selection_busy", historySelectionConflict="history_selection_conflict", authenticationRequired="authentication_required", audienceLeaseRestricted="audience_lease_restricted", effectiveContextChanged="effective_context_changed", historyUnavailable="history_unavailable", networkUnavailable="network_unavailable", requestTimedOut="request_timed_out", cancelled="cancelled", unknown="unknown"
    case inputLimit="input_limit"
    case contextPreparation="context_preparation", contextValidation="context_validation", audioTurnFailed="audio_turn_failed", audioInterrupted="audio_interrupted", audioDeadlineExceeded="audio_deadline_exceeded", outputOnlyStopped="output_only_stopped"
}
public enum FailureStage:String,Codable {case recognition,preparation,memory,world,admission,inference,framing,synthesis,delivery,settlement,transport,unknown}
public enum FailureCode:String,Codable {case failed,providerFailed="provider_failed",providerUnavailable="provider_unavailable",providerTimeout="provider_timeout",providerCancelled="provider_cancelled",providerProtocol="provider_protocol",invalidResponse="invalid_response",missingTerminal="missing_terminal",noAudio="no_audio",scopeChanged="scope_changed",inputLimit="input_limit",inputInvalid="input_invalid",outputLimit="output_limit",deadline,stalled,cancelled,disconnected}
public struct FailureOrigin:Equatable {public let stage:FailureStage,code:FailureCode
    public init(stage:FailureStage,code:FailureCode){self.stage=stage;self.code=code}
    public static func decode(_ value:Any?)->FailureOrigin {
        guard let body=value as? [String:Any],let rawStage=body["stage"] as? String,let rawCode=body["code"] as? String,let stage=FailureStage(rawValue:rawStage),let code=FailureCode(rawValue:rawCode) else{return FailureOrigin(stage:.unknown,code:.failed)}
        return FailureOrigin(stage:stage,code:code)
    }
}
/// Only known terminal codes cross the diagnostic privacy boundary.
public enum VoiceDiagnostic {
    public static func transcript(_ text:String)->DiagnosticEvent {text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty ? .voiceTranscriptEmpty : .voiceTranscribed}
    public static func userFailureMessage(_ stage:FailureStage)->String {
        switch stage {
        case .synthesis:return "Your message was transcribed, but the reply could not be spoken."
        case .framing,.delivery,.settlement:return "The reply audio could not be completed. Any generated text remains in the conversation."
        case .recognition:return "A speech segment could not be transcribed. Please try again."
        case .inference:return "The Assistant could not complete that reply. Please try again."
        default:return "The voice response could not be completed. Please try again."
        }
    }
    public static func terminalCode(_ value:String?)->DiagnosticCode {
        switch value {case "audio_turn_failed":return .audioTurnFailed;case "audio_interrupted":return .audioInterrupted;case "audio_deadline_exceeded":return .audioDeadlineExceeded;case "output_only_stopped":return .outputOnlyStopped;default:return .unknown}
    }
    public static func terminal(state:String?,code:String?)->(DiagnosticEvent,DiagnosticCode)? {
        guard state != "completed" else{return nil}
        return (state == "interrupted" ? .voiceTerminalInterrupted:.voiceTerminalFailed,terminalCode(code))
    }
}
public struct DiagnosticEntry:Codable,Equatable {
    public let sequence:UInt64, timestampMs:UInt64
    public let event:DiagnosticEvent
    public let status:Int?,durationMs:Int?,value:Int?
    public let code:DiagnosticCode?
    public let failureStage:FailureStage?,failureCode:FailureCode?
    public let turn:Int?
}
public final class DiagnosticBuffer {
    public static let maxEntries=400, maxBytes=96_000
    private let lock=NSLock();private var active=false,entries=[DiagnosticEntry](),sequence:UInt64=0
    public init(){}
    public var enabled:Bool{lock.lock();defer{lock.unlock()};return active}
    public var count:Int{lock.lock();defer{lock.unlock()};return entries.count}
    public func setEnabled(_ value:Bool){lock.lock();active=value;lock.unlock()}
    public func clear(){lock.lock();entries.removeAll();sequence=0;lock.unlock()}
    @discardableResult public func record(_ event:DiagnosticEvent,status:Int?=nil,durationMs:Int?=nil,value:Int?=nil,code:DiagnosticCode?=nil,turn:Int?=nil,failureOrigin:FailureOrigin?=nil,at:Date=Date())->Bool{
        lock.lock();defer{lock.unlock()};guard active else{return false}
        let seconds=at.timeIntervalSince1970;guard seconds.isFinite,seconds>=0,seconds<10_000_000_000 else{return false}
        sequence=sequence == UInt64.max ? 1:sequence+1
        entries.append(DiagnosticEntry(sequence:sequence,timestampMs:UInt64(seconds*1000),event:event,status:status.flatMap{(100...599).contains($0) ? $0:nil},durationMs:durationMs.flatMap{(0...3_600_000).contains($0) ? $0:nil},value:value.flatMap{(0...384_000).contains($0) ? $0:nil},code:code,failureStage:failureOrigin?.stage,failureCode:failureOrigin?.code,turn:turn.flatMap{(1...384_000).contains($0) ? $0:nil}))
        if entries.count>Self.maxEntries{entries.removeFirst(entries.count-Self.maxEntries)};return true
    }
    public func snapshot()->[DiagnosticEntry]{lock.lock();defer{lock.unlock()};return entries}
    public func encoded()->Data?{let encoder=JSONEncoder();encoder.outputFormatting=[.sortedKeys];let data=try? encoder.encode(snapshot());return data.flatMap{$0.count<=Self.maxBytes ? $0:nil}}
    /// Reject malformed or oversized persisted data; never admit free-form strings.
    public func restore(_ data:Data){guard data.count<=Self.maxBytes,let saved=try? JSONDecoder().decode([DiagnosticEntry].self,from:data),saved.count<=Self.maxEntries,saved.allSatisfy({$0.timestampMs<10_000_000_000_000 && ($0.status.map{(100...599).contains($0)} ?? true) && ($0.durationMs.map{(0...3_600_000).contains($0)} ?? true) && ($0.value.map{(0...384_000).contains($0)} ?? true) && ($0.turn.map{(1...384_000).contains($0)} ?? true)}) else{return};lock.lock();entries=saved;sequence=saved.map(\.sequence).max() ?? 0;lock.unlock()}
}

/// An immutable share snapshot; lifecycle ownership stays with the native share
/// sheet until completion or cancellation. No automatic upload or clipboard.
public enum DiagnosticExportFile {
    public static func create(data:Data,in directory:URL)throws->URL{
        guard !data.isEmpty,data.count<=DiagnosticBuffer.maxBytes+2048 else{throw CocoaError(.fileWriteOutOfSpace)}
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let url=directory.appendingPathComponent("Lifestream-Diagnostics-\(UUID().uuidString).json",isDirectory:false)
        #if os(iOS)
        try data.write(to:url,options:[.atomic,.completeFileProtection]);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path)
        #else
        try data.write(to:url,options:.atomic);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path)
        #endif
        return url
    }
    public static func finish(_ url:URL){try? FileManager.default.removeItem(at:url)}
}
