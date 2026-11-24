import Foundation
import AssistantCore
let root=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true),suite="test.lifestream.diagnostics."+UUID().uuidString
let defaults=UserDefaults(suiteName:suite)!
defaults.removePersistentDomain(forName:suite)
let log=NativeDiagnostics(defaults:defaults,root:root)
precondition(!log.enabled && log.count==0)
log.record(.httpHistory,code:.historyPrivateScopeRequired);precondition(log.count==0)
log.setEnabled(true);log.record(.historyCreate);log.record(.httpHistory,status:403,durationMs:25,value:2,code:.historyPrivateScopeRequired)
let turn=log.nextTurn()!;log.record(.voiceTranscriptEmpty,turn:turn);log.record(.voiceTerminalFailed,code:.audioTurnFailed,turn:turn)
let exported=try log.exportFile(),bytes=try Data(contentsOf:exported),text=String(data:bytes,encoding:.utf8)!
precondition(text.contains("history_private_scope_required") && text.contains("schemaVersion") && !text.contains("SENTINEL_password_cookie_transcript"))
log.setEnabled(false);let count=log.count;log.record(.voiceStart);let still=try Data(contentsOf:exported);precondition(log.count==count && still==bytes)
Thread.sleep(forTimeInterval:1.4);let restored=NativeDiagnostics(defaults:defaults,root:root);precondition(!restored.enabled && restored.count==count);restored.setEnabled(true);precondition(restored.nextTurn()!>turn);restored.setEnabled(false)
precondition(FileManager.default.fileExists(atPath:exported.path));DiagnosticExportFile.finish(exported);precondition(!FileManager.default.fileExists(atPath:exported.path))
restored.clear();Thread.sleep(forTimeInterval:1.4);let after=NativeDiagnostics(defaults:defaults,root:root);precondition(after.count==0)
do{_=try after.exportFile();fatalError("empty export must fail")}catch{}
defaults.removePersistentDomain(forName:suite);print("native diagnostic persistence, off/on, snapshot, share cleanup and clear passed")
