import Foundation
let directory=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true),seedName=CommandLine.arguments[2],prefix=CommandLine.arguments[3]
let seed=try JSONSerialization.jsonObject(with:Data(contentsOf:directory.appendingPathComponent(seedName))) as! [String:Any]
let selected=(prefix=="stale-" ? seed["staleConfigure"] as? [String:Any] : seed)
guard seed["syntheticOnly"] as? Bool == true,seed["credentialsIncluded"] as? Bool == false,let identity=(seed["originalIdentity"] ?? seed["currentIdentity"]) as? [String:String],let principal=identity["principalId"].flatMap(UUID.init(uuidString:)),let endpoint=identity["endpointId"].flatMap(UUID.init(uuidString:)),let session=identity["sessionId"].flatMap(UUID.init(uuidString:)),let digest=seed["serverOriginDigest"] as? String,let pin=seed["producerPin"] as? [String:String],pin==["schemaId":MobileControlOriginal.schemaId,"schemaVersion":"1.0.0","digest":MobileControlOriginal.schemaSHA256],let target=selected?["target"] as? [String:Any],let action=selected?["action"] as? [String:Any] else{exit(2)}
let original:[String:Any]=["schemaVersion":"1.0.0","operationId":UUID().uuidString.lowercased(),"target":target,"action":action]
let data=try JSONSerialization.data(withJSONObject:original),scope=HealthOriginalControlJournal.Scope(serverDigest:digest,principal:principal,endpoint:endpoint,session:session),journal=HealthOriginalControlJournal(storage:ProtectedHealthFileStorage(file:directory.appendingPathComponent(prefix+"journal.json")))
try journal.prepare(scope:scope,original:data);let stored=try journal.original(scope:scope),request=try MobileControlOriginal.parse(stored)
for (name,reconcile) in [("control-envelope.json",false),("reconcile-envelope.json",true)] {try MobileControlOriginal.envelope(request,reconciliation:reconcile).write(to:directory.appendingPathComponent(prefix+name),options:.atomic)}
if let probe=seed["conflictProbe"] as? [String:Any],probe["targetExpectedRevisionDelta"] as? Int == 1 {
 var changed=original,changedTarget=target;guard let revision=target["expectedRevision"] as? Int else{exit(3)};changedTarget["expectedRevision"]=revision+1;changed["target"]=changedTarget
 let conflict=try MobileControlOriginal.parse(JSONSerialization.data(withJSONObject:changed));try MobileControlOriginal.envelope(conflict,reconciliation:false).write(to:directory.appendingPathComponent("conflict-envelope.json"),options:.atomic)
}
print("synthetic protected-storage journal prepared; original digest \(request.digest)")
