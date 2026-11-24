import Foundation
import CryptoKit
let dir=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true),seed=try JSONSerialization.jsonObject(with:Data(contentsOf:dir.appendingPathComponent("host-seed.json"))) as! [String:Any],priv=try JSONSerialization.jsonObject(with:Data(contentsOf:dir.appendingPathComponent("host-session-private.json"))) as! [String:Any],roles=priv["roles"] as! [String:[String:Any]],origin=priv["origin"] as! String,digest=SHA256.hash(data:Data(origin.trimmingCharacters(in:CharacterSet(charactersIn:"/")).utf8)).map{String(format:"%02x",$0)}.joined()
guard seed["syntheticOnly"] as? Bool == true,priv["syntheticOnly"] as? Bool == true,seed["fixtureRunId"] as? String == priv["fixtureRunId"] as? String else{exit(2)}
func scope(_ role:[String:Any])->HealthOriginalControlJournal.Scope {.init(serverDigest:digest,principal:UUID(uuidString:role["principalId"] as! String)!,endpoint:UUID(uuidString:role["endpointId"] as! String)!,session:UUID(uuidString:role["sessionId"] as! String)!)}
let owner=scope(roles["owner"]!),fresh=scope(roles["freshSelf"]!)
for (phase,scope) in [("enroll",owner),("bind",owner),("configure",owner),("remove",owner),("capacity",fresh)] {
 let journal=HealthOriginalControlJournal(storage:ProtectedHealthFileStorage(file:dir.appendingPathComponent(phase+"-journal.json"))),original=try journal.original(scope:scope),request=try MobileControlOriginal.parse(original)
 guard case .current = try journal.status(scope:scope) else{exit(3)}
 if phase=="remove" || phase=="capacity" {let raw=try JSONSerialization.jsonObject(with:request.canonical) as! [String:Any],target=raw["target"] as! [String:Any],enrollment=UUID(uuidString:target["enrollmentId"] as! String)!,outbox=HealthOutbox(storage:ProtectedHealthFileStorage(file:dir.appendingPathComponent(phase+"-synthetic-outbox.json")));try outbox.setHuman(scope.principal);let state=try outbox.status(enrollment:enrollment);guard state.paused,state.pending==1,!state.localChangePending else{exit(4)}}
}
print("five original journals and two paused synthetic queues retained after restart")
