import Foundation
import CryptoKit
let directory=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true),phase=CommandLine.arguments[2],roleName=CommandLine.arguments[3],privateFile=try JSONSerialization.jsonObject(with:Data(contentsOf:directory.appendingPathComponent("host-session-private.json"))) as! [String:Any],seed=try JSONSerialization.jsonObject(with:Data(contentsOf:directory.appendingPathComponent("host-seed.json"))) as! [String:Any]
guard privateFile["syntheticOnly"] as? Bool == true,privateFile["fixtureRunId"] as? String == seed["fixtureRunId"] as? String,let origin=URL(string:privateFile["origin"] as! String),let roles=privateFile["roles"] as? [String:[String:Any]],let role=roles[roleName] else{exit(2)}
func id(_ key:String)->UUID{UUID(uuidString:role[key] as! String)!}
let digest=SHA256.hash(data:Data(origin.absoluteString.trimmingCharacters(in:CharacterSet(charactersIn:"/")).utf8)).map{String(format:"%02x",$0)}.joined(),scope=HealthOriginalControlJournal.Scope(serverDigest:digest,principal:id("principalId"),endpoint:id("endpointId"),session:id("sessionId")),context=MobileControlFixtureHost.Context(scope:scope,transportEpoch:1,contextRevision:role["contextRevision"] as! Int,ordinarySelf:true),adapter=try MobileControlFixtureLoopback(origin:origin,headers:["cookie":role["cookie"] as! String,"x-lifestream-csrf":role["csrf"] as! String,"x-lifestream-user-context":role["contextRef"] as! String],current:{context})
try adapter.verifyFixtureIdentity(expected:context)
let journal=HealthOriginalControlJournal(storage:ProtectedHealthFileStorage(file:directory.appendingPathComponent("remove-journal.json")))
if phase=="foreign-denial" {
 do{_ = try journal.reconciliationOriginalAfterTrustedSelfCheck(serverDigest:digest,principal:scope.principal);exit(3)}catch{}
 // Actual Auth denial uses original synthetic envelope prepared under the owner,
 // without granting foreign native journal access or using it as authority.
 let originalEnvelope=try Data(contentsOf:directory.appendingPathComponent("remove-reconcile-envelope.json")),response=try adapter.exchangeVerified(originalEnvelope,expected:context);guard response.status==403 else{exit(4)};print("synthetic foreign reconcile denied");exit(0)
}
let original=try journal.reconciliationOriginalAfterTrustedSelfCheck(serverDigest:digest,principal:scope.principal),request=try MobileControlOriginal.parse(original)
if phase=="old-apply" {let response=try adapter.exchangeVerified(MobileControlOriginal.envelope(request,reconciliation:false),expected:context);guard response.status==403 else{exit(5)};print("synthetic old-endpoint apply denied");exit(0)}
if phase=="policy" {
 let object=try JSONSerialization.jsonObject(with:original) as! [String:Any],target=object["target"] as! [String:Any],eid=UUID(uuidString:target["enrollmentId"] as! String)!,oldEndpoint=UUID(uuidString:target["endpointId"] as! String)!,bytes=try adapter.policyResponseVerified(enrollment:eid,expected:context),proof=try MobileHealthPolicyParser.parse(bytes,expectedPrincipal:scope.principal,expectedEndpoint:oldEndpoint,expectedEnrollment:eid)
 guard !proof.permitsCollection else{exit(6)};print("synthetic current policy does not permit collection");exit(0)
}
var responseBytes:Data?
let host=MobileControlFixtureHost(journal:journal,current:{context},restrict:{_ in exit(7)},exchange:{body in let response=try adapter.exchangeVerified(body,expected:context);responseBytes=response.body;return response})
let result=try host.reconcile(context:context);guard let data=responseBytes else{exit(8)};try data.write(to:directory.appendingPathComponent(phase+"-reconcile-response.json"),options:.atomic)
if phase=="pending" {guard result == .held else{exit(9)}} else if phase=="applied" {guard result == .applied else{exit(10)}} else{exit(11)}
print("synthetic \(phase) reconciliation: \(result), original retained")
