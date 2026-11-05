import Foundation
import CryptoKit
let directory=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true),phase=CommandLine.arguments[2],roleName=CommandLine.arguments.count>3 ? CommandLine.arguments[3] : "owner",seed=try JSONSerialization.jsonObject(with:Data(contentsOf:directory.appendingPathComponent("host-seed.json"))) as! [String:Any],priv=try JSONSerialization.jsonObject(with:Data(contentsOf:directory.appendingPathComponent("host-session-private.json"))) as! [String:Any]
guard let runId=seed["fixtureRunId"] as? String,!runId.isEmpty,priv["fixtureRunId"] as? String == runId,seed["syntheticOnly"] as? Bool == true,priv["syntheticOnly"] as? Bool == true,seed["sourceRevision"] as? String == priv["sourceRevision"] as? String,let origin=URL(string:priv["origin"] as! String),let roles=priv["roles"] as? [String:[String:Any]],let role=roles[roleName] else{exit(2)}
func rid(_ name:String)->UUID {UUID(uuidString:role[name] as! String)!}
let originText=origin.absoluteString.trimmingCharacters(in:CharacterSet(charactersIn:"/")),serverDigest=SHA256.hash(data:Data(originText.utf8)).map{String(format:"%02x",$0)}.joined(),scope=HealthOriginalControlJournal.Scope(serverDigest:serverDigest,principal:rid("principalId"),endpoint:rid("endpointId"),session:rid("sessionId")),context=MobileControlFixtureHost.Context(scope:scope,transportEpoch:1,contextRevision:role["contextRevision"] as! Int,ordinarySelf:true)
let adapter=try MobileControlFixtureLoopback(origin:origin,headers:["cookie":role["cookie"] as! String,"x-lifestream-csrf":role["csrf"] as! String,"x-lifestream-user-context":role["contextRef"] as! String],current:{context})
try adapter.verifyFixtureIdentity(expected:context)
func previous(_ name:String)throws->[String:Any] {let frame=try JSONSerialization.jsonObject(with:Data(contentsOf:directory.appendingPathComponent(name+"-response.json"))) as! [String:Any],outcome=frame["result"] as! [String:Any],receipt=outcome["receipt"] as! [String:Any],result=receipt["result"] as! [String:Any];return result["enrollment"] as! [String:Any]}
func target(_ e:[String:Any])->[String:Any] {["principalId":e["principalId"]!,"endpointId":e["endpointId"]!,"collector":e["collector"]!,"enrollmentId":e["enrollmentId"]!,"sourceNamespace":e["sourceNamespace"]!,"expectedRevision":e["revision"]!]}
var targetValue:[String:Any],action:[String:Any],proof:MobileHealthPolicyProof?
switch phase {
case "enroll":targetValue=seed["initialTarget"] as! [String:Any];action=["kind":"enroll"]
case "bind":targetValue=target(try previous("enroll"));action=["kind":"bindSource","binding":["createNew":true]]
case "configure":let e=try previous("bind");targetValue=target(e);action=["kind":"configure","state":"active","configuration":seed["configuration"]!];proof=try adapter.policyVerified(enrollment:UUID(uuidString:e["enrollmentId"] as! String)!,expected:context)
case "remove":let e=try previous("configure");targetValue=target(e);action=["kind":"remove","scope":"wholeSource"];proof=try adapter.policyVerified(enrollment:UUID(uuidString:e["enrollmentId"] as! String)!,expected:context)
case "capacity":let command=try JSONSerialization.jsonObject(with:Data(contentsOf:directory.appendingPathComponent("capacity-seed-result.json"))) as! [String:Any],result=command["result"] as! [String:Any],e=result["enrollment"] as! [String:Any];guard result["seededRecords"] as? Int == 129,result["retainedRecords"] as? Int == 129 else{exit(6)};targetValue=target(e);action=["kind":"remove","scope":"wholeSource"];proof=try adapter.policyVerified(enrollment:UUID(uuidString:e["enrollmentId"] as! String)!,expected:context)
default:exit(3)
}
let original=try JSONSerialization.data(withJSONObject:["schemaVersion":"1.0.0","operationId":UUID().uuidString.lowercased(),"target":targetValue,"action":action]),journal=HealthOriginalControlJournal(storage:ProtectedHealthFileStorage(file:directory.appendingPathComponent(phase+"-journal.json")))
// Synthetic local queue only; no HealthKit/OS source is accessed. This gives the
// remove case a real outbox pause/preservation check before any POST.
var syntheticOutbox:HealthOutbox?
if phase=="remove" || phase=="capacity" {
 guard let proof,proof.permitsCollection else{exit(5)}
 let outbox=HealthOutbox(storage:ProtectedHealthFileStorage(file:directory.appendingPathComponent(phase+"-synthetic-outbox.json")))
 try outbox.setHuman(scope.principal);try outbox.enroll(proof:proof,selectedTypes:["sleep"])
 let ticket=try outbox.ticket(enrollment:proof.enrollment,type:"sleep"),change=HealthChange(upstreamId:"synthetic-queued-delete",operation:.delete,body:nil,expectedPolicyRevision:proof.revision,mappingVersion:"synthetic-v1")
 try outbox.commit(scope:"synthetic-local",expectedAnchor:nil,nextAnchor:Data([1]),changes:[change],ticket:ticket);syntheticOutbox=outbox
}
var captured:Data?,capturedStatus:Int?,fenced=false
let host=MobileControlFixtureHost(journal:journal,current:{context},restrict:{plan in
 if let outbox=syntheticOutbox {guard plan.stopCollection,let proof else{throw MobileControlFixtureHost.Failure.restrictionRequired};try outbox.pause(enrollment:proof.enrollment);let status=try outbox.status(enrollment:proof.enrollment);guard status.paused,status.pending==1,!status.localChangePending else{throw MobileControlFixtureHost.Failure.restrictionRequired}}
 let data=try JSONSerialization.data(withJSONObject:["stopCollection":plan.stopCollection,"categoryCount":plan.keepCategories.count,"useCount":plan.keepUses.count,"assistantCount":plan.keepAssistants.count]);try ProtectedHealthFileStorage(file:directory.appendingPathComponent(phase+"-local-fence.json")).replace(data);fenced=true
},exchange:{body in if phase=="configure" || phase=="remove" || phase=="capacity" {guard fenced else{throw MobileControlFixtureHost.Failure.restrictionRequired}};let response=try adapter.exchangeVerified(body,expected:context);captured=response.body;capturedStatus=response.status;return response})
let observed=try host.apply(original:original,context:context,proof:proof);guard let data=captured,let status=capturedStatus,status==200,case .current = try journal.status(scope:scope) else{exit(4)}
try data.write(to:directory.appendingPathComponent(phase+"-response.json"),options:.atomic)
let canonical=try journal.original(scope:scope),parsed=try MobileControlOriginal.parse(canonical)
if phase=="remove" {try MobileControlOriginal.envelope(parsed,reconciliation:true).write(to:directory.appendingPathComponent("remove-reconcile-envelope.json"),options:.atomic)}
print("synthetic \(phase): \(observed), original retained, digest \(parsed.digest)")
