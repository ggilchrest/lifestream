import Foundation
import AssistantCore
let root=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
do{_=try NativeAuditExport.prepare(entries:[],in:root);fatalError("empty export must fail")}catch NativeAuditExport.Failure.empty{}catch{fatalError("wrong empty error")}
let now=Date(),audit=BoundedVoiceAudit(now:{now}),sid=UUID().uuidString.lowercased();audit.update(version:1,active:true,session:sid,expiresAt:now.addingTimeInterval(60));precondition(audit.beginAttempt());let id=audit.correlation()!;precondition(audit.record(.turnStarted,session:id.session,attempt:id.attempt,turn:1))
let blocked=root.appendingPathComponent("not-a-directory");precondition(FileManager.default.createFile(atPath:blocked.path,contents:Data()))
do{_=try NativeAuditExport.prepare(entries:audit.snapshot(),in:blocked);fatalError("invalid output location must fail")}catch{}
let file=try NativeAuditExport.prepare(entries:audit.snapshot(),in:root),body=try Data(contentsOf:file);let obj=try JSONSerialization.jsonObject(with:body) as! [[String:Any]];precondition(obj.count==1 && obj[0]["event"] as? String=="turnStarted")
let text=String(data:body,encoding:.utf8)!;precondition(!text.contains("credential-sentinel"));let perms=try FileManager.default.attributesOfItem(atPath:file.path)[.posixPermissions] as! NSNumber;precondition(perms.intValue & 0o077 == 0)
DiagnosticExportFile.finish(file);precondition(!FileManager.default.fileExists(atPath:file.path));print("actual audit exporter handles empty, bounded content and cleanup")
