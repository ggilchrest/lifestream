// SPDX-License-Identifier: Apache-2.0
import Foundation

/// The closed event vocabulary is the privacy boundary: no message, error text,
/// route/device name, URL, credential, identifier or asset content is accepted.
public enum DiagnosticEvent:String,Codable,CaseIterable {
    case appStarted="app_started", appForeground="app_foreground", appBackground="app_background"
    case settingsOpened="settings_opened", settingsSaved="settings_saved", settingsFailed="settings_failed"
    case connectionRestoreStart="connection_restore_start", connectionRestoreDone="connection_restore_done", connectionRestoreFailed="connection_restore_failed"
    case signInStart="sign_in_start", signInDone="sign_in_done", signInFailed="sign_in_failed", signOut="sign_out"
    case httpAuth="http_auth", httpText="http_text", textStreamComplete="text_stream_complete", httpAudience="http_audience", httpSession="http_session", httpHistory="http_history", httpOther="http_other"
    case audienceBegin="audience_begin", audienceReady="audience_ready", audienceFailed="audience_failed", audienceEnded="audience_ended", privacyProtected="privacy_protected"
    case historyCreate="history_create", historyCreateDone="history_create_done", historyCreateFailed="history_create_failed"
    case historySelect="history_select", historySelectDone="history_select_done", historySelectFailed="history_select_failed", historyRefresh="history_refresh", historyHide="history_hide", historyRefreshDone="history_refresh_done", historyRefreshFailed="history_refresh_failed", historyOlder="history_older"
    case textStart="text_start", textDone="text_done", textFailed="text_failed", textCancelled="text_cancelled", textContextChanged="text_context_changed"
    case voiceSpeech="voice_speech", voiceCommitted="voice_committed", voiceTranscribed="voice_transcribed", voiceResponseStarted="voice_response_started", voiceGenerationDone="voice_generation_done", voiceTurnCompleted="voice_turn_completed"
    case voiceTurnStarted="voice_turn_started", voiceTranscriptEmpty="voice_transcript_empty", voiceTerminalFailed="voice_terminal_failed", voiceTerminalInterrupted="voice_terminal_interrupted"
    case voiceStart="voice_start", voiceReady="voice_ready", voiceFailed="voice_failed", voiceStop="voice_stop", voiceInterrupted="voice_interrupted"
    case socketOpen="socket_open", socketClosed="socket_closed", socketAccepted="socket_accepted", socketFailed="socket_failed"
    case captureReady="capture_ready", captureRecovery="capture_recovery", routeChanged="route_changed", routeSpeaker="route_speaker", routeBluetooth="route_bluetooth", routeWired="route_wired", routeOther="route_other", sampleRate="sample_rate"
    case deliveryGap="delivery_gap", playbackStart="playback_start", playbackDrained="playback_drained", playbackFinished="playback_finished", playbackCancelled="playback_cancelled"
    case avatarLoad="avatar_load", avatarReady="avatar_ready", avatarFailed="avatar_failed", cameraChanged="camera_changed", cameraReset="camera_reset", physicsChanged="physics_changed", animationSelected="animation_selected", animationAutomatic="animation_automatic"
    case diagnosticsEnabled="diagnostics_enabled", diagnosticsDisabled="diagnostics_disabled", diagnosticsCleared="diagnostics_cleared"
}
public enum DiagnosticCode:String,Codable {
    case historyPrivateScopeRequired="history_private_scope_required", runtimeContextChanged="runtime_context_changed", historySelectionBusy="history_selection_busy", historySelectionConflict="history_selection_conflict", authenticationRequired="authentication_required", audienceLeaseRestricted="audience_lease_restricted", effectiveContextChanged="effective_context_changed", historyUnavailable="history_unavailable", networkUnavailable="network_unavailable", cancelled="cancelled", unknown="unknown"
    case contextPreparation="context_preparation", contextValidation="context_validation", audioTurnFailed="audio_turn_failed", audioInterrupted="audio_interrupted", audioDeadlineExceeded="audio_deadline_exceeded", outputOnlyStopped="output_only_stopped"
}
/// Only known terminal codes cross the diagnostic privacy boundary.
public enum VoiceDiagnostic {
    public static func transcript(_ text:String)->DiagnosticEvent {text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty ? .voiceTranscriptEmpty : .voiceTranscribed}
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
    @discardableResult public func record(_ event:DiagnosticEvent,status:Int?=nil,durationMs:Int?=nil,value:Int?=nil,code:DiagnosticCode?=nil,turn:Int?=nil,at:Date=Date())->Bool{
        lock.lock();defer{lock.unlock()};guard active else{return false}
        let seconds=at.timeIntervalSince1970;guard seconds.isFinite,seconds>=0,seconds<10_000_000_000 else{return false}
        sequence=sequence == UInt64.max ? 1:sequence+1
        entries.append(DiagnosticEntry(sequence:sequence,timestampMs:UInt64(seconds*1000),event:event,status:status.flatMap{(100...599).contains($0) ? $0:nil},durationMs:durationMs.flatMap{(0...3_600_000).contains($0) ? $0:nil},value:value.flatMap{(0...384_000).contains($0) ? $0:nil},code:code,turn:turn.flatMap{(1...384_000).contains($0) ? $0:nil}))
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
