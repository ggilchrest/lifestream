// SPDX-License-Identifier: Apache-2.0
import Foundation
import AssistantCore

/// Device-local, opt-in metadata only. Payloads are closed enums plus bounded
/// integers; neither the bridge nor this store accepts arbitrary text.
final class NativeDiagnostics {
    private struct Export:Codable {let schemaVersion:String,appVersion:String,build:String;let createdAtMs:UInt64;let entries:[DiagnosticEntry]}
    private let defaults:UserDefaults,buffer=DiagnosticBuffer(),queue=DispatchQueue(label:"lifestream.diagnostics.write",qos:.utility),state=NSLock()
    private let file:URL,shareDirectory:URL
    private var revision:UInt64=0,pending=false,persistenceFailed=false,turnSequence=0
    private static let enabledKey="lifestream.diagnostics.enabled.v1"
    init(defaults:UserDefaults = .standard,root:URL?=nil){
        self.defaults=defaults
        let base=root ?? FileManager.default.urls(for:.cachesDirectory,in:.userDomainMask).first!
        file=base.appendingPathComponent("lifestream-diagnostics-v1.json")
        shareDirectory=base.appendingPathComponent("lifestream-diagnostics-shares",isDirectory:true)
        if let data=try? Data(contentsOf:file),data.count<=DiagnosticBuffer.maxBytes{buffer.restore(data)}
        turnSequence=buffer.snapshot().compactMap(\.turn).max() ?? 0
        buffer.setEnabled(defaults.bool(forKey:Self.enabledKey))
        // No share can survive a previous process. Keep recent files for 24h in
        // case a receiving app is still opening its copy after completion.
        if let files=try? FileManager.default.contentsOfDirectory(at:shareDirectory,includingPropertiesForKeys:[.contentModificationDateKey],options:[.skipsHiddenFiles]){
            for url in files where url.lastPathComponent.hasPrefix("Lifestream-Diagnostics-"){
                if let date=try? url.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate,Date().timeIntervalSince(date)>86400{DiagnosticExportFile.finish(url)}
            }
        }
    }
    var enabled:Bool{buffer.enabled}
    var count:Int{buffer.count}
    var failed:Bool{state.lock();defer{state.unlock()};return persistenceFailed}
    func setEnabled(_ enabled:Bool){buffer.setEnabled(enabled);defaults.set(enabled,forKey:Self.enabledKey);if enabled{record(.diagnosticsEnabled)}else{schedule()}}
    func clear(){buffer.clear();schedule()}
    func nextTurn()->Int?{guard buffer.enabled else{return nil};state.lock();defer{state.unlock()};turnSequence=turnSequence%384_000+1;return turnSequence}
    func record(_ event:DiagnosticEvent,status:Int?=nil,durationMs:Int?=nil,value:Int?=nil,code:DiagnosticCode?=nil,turn:Int?=nil,failureOrigin:FailureOrigin?=nil){guard buffer.record(event,status:status,durationMs:durationMs,value:value,code:code,turn:turn,failureOrigin:failureOrigin) else{return};schedule()}
    private func schedule(){
        state.lock();revision &+= 1;if pending{state.unlock();return};pending=true;state.unlock()
        queue.asyncAfter(deadline:.now()+0.5){[weak self] in self?.flush()}
    }
    private func flush(){
        state.lock();let captured=revision;state.unlock();let data=buffer.encoded()
        do{guard let data else{throw CocoaError(.fileWriteUnknown)};try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]);try data.write(to:file,options:[.atomic,.completeFileProtection]);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path);state.lock();persistenceFailed=false;state.unlock()}
        catch{state.lock();persistenceFailed=true;state.unlock()}
        state.lock();pending=false;let changed=revision != captured;state.unlock();if changed{schedule()}
    }
    func exportFile()throws->URL{
        let entries=buffer.snapshot();guard !entries.isEmpty else{throw CocoaError(.fileReadNoSuchFile)}
        func safe(_ value:String?)->String{guard let value,value.range(of:"^[0-9A-Za-z._-]{1,32}$",options:.regularExpression) != nil else{return "unknown"};return value}
        let info=Bundle.main.infoDictionary ?? [:],date=Date().timeIntervalSince1970
        let payload=Export(schemaVersion:"1.0.0",appVersion:safe(info["CFBundleShortVersionString"] as? String),build:safe(info["CFBundleVersion"] as? String),createdAtMs:UInt64(max(0,date)*1000),entries:entries)
        let encoder=JSONEncoder();encoder.outputFormatting=[.prettyPrinted,.sortedKeys];let data=try encoder.encode(payload)
        return try DiagnosticExportFile.create(data:data,in:shareDirectory)
    }
}

/// Shared by the production bridge and the host regression probe.
/// No speech, credentials or arbitrary error strings enter this exporter.
enum NativeAuditExport {
    enum Failure:Error {case empty}
    static func prepare(entries:[VoiceAuditEntry],in directory:URL)throws->URL {
        guard !entries.isEmpty else{throw Failure.empty}
        let data=try JSONEncoder().encode(entries)
        return try DiagnosticExportFile.create(data:data,in:directory)
    }
}
