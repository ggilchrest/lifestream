import Foundation
let dir=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
func seed(_ n:String)throws->[String:Any]{try JSONSerialization.jsonObject(with:Data(contentsOf:dir.appendingPathComponent(n))) as! [String:Any]}
func scope(_ s:[String:Any],_ key:String)->HealthOriginalControlJournal.Scope {let i=s[key] as! [String:String];return .init(serverDigest:s["serverOriginDigest"] as! String,principal:UUID(uuidString:i["principalId"]!)!,endpoint:UUID(uuidString:i["endpointId"]!)!,session:UUID(uuidString:i["sessionId"]!)!)}
let first=try seed("control-seed.json"),second=try seed("alias-seed.json")
for (prefix,context) in [("",scope(first,"originalIdentity")),("alias-",scope(second,"currentIdentity")),("stale-",scope(second,"currentIdentity"))] {
 let journal=HealthOriginalControlJournal(storage:ProtectedHealthFileStorage(file:dir.appendingPathComponent(prefix+"journal.json"))),original=try journal.original(scope:context),request=try MobileControlOriginal.parse(original)
 for (name,reconcile) in [("control-envelope.json",false),("reconcile-envelope.json",true)] {guard try MobileControlOriginal.envelope(request,reconciliation:reconcile)==Data(contentsOf:dir.appendingPathComponent(prefix+name)) else{exit(2)}}
 if prefix.isEmpty {var raw=try JSONSerialization.jsonObject(with:original) as! [String:Any],target=raw["target"] as! [String:Any];target["expectedRevision"]=(target["expectedRevision"] as! Int)+1;raw["target"]=target;let conflict=try MobileControlOriginal.parse(JSONSerialization.data(withJSONObject:raw));guard try MobileControlOriginal.envelope(conflict,reconciliation:false)==Data(contentsOf:dir.appendingPathComponent("conflict-envelope.json")) else{exit(3)}}
}
print("all seven envelope bytes reproduced from three original journals")
