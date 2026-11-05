import Foundation
import CryptoKit
let dir=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true),phase=CommandLine.arguments[2],seed=try JSONSerialization.jsonObject(with:Data(contentsOf:dir.appendingPathComponent("host-seed.json"))) as! [String:Any],privateFile=try JSONSerialization.jsonObject(with:Data(contentsOf:dir.appendingPathComponent("host-session-private.json"))) as! [String:Any]
guard let runId=seed["fixtureRunId"] as? String,!runId.isEmpty,privateFile["fixtureRunId"] as? String==runId,seed["syntheticOnly"] as? Bool==true,privateFile["syntheticOnly"] as? Bool==true,seed["sourceRevision"] as? String==privateFile["sourceRevision"] as? String,let origin=URL(string:privateFile["origin"] as! String),let roles=privateFile["roles"] as? [String:[String:Any]],let role=roles["owner"] else{exit(2)}
func id(_ key:String)->UUID{UUID(uuidString:role[key] as! String)!}
let digest=SHA256.hash(data:Data(origin.absoluteString.trimmingCharacters(in:CharacterSet(charactersIn:"/")).utf8)).map{String(format:"%02x",$0)}.joined(),scope=HealthOriginalControlJournal.Scope(serverDigest:digest,principal:id("principalId"),endpoint:id("endpointId"),session:id("sessionId")),context=MobileControlFixtureHost.Context(scope:scope,transportEpoch:1,contextRevision:role["contextRevision"] as! Int,ordinarySelf:true),adapter=try MobileControlFixtureLoopback(origin:origin,headers:["cookie":role["cookie"] as! String,"x-lifestream-csrf":role["csrf"] as! String,"x-lifestream-user-context":role["contextRef"] as! String],current:{context}),journal=HealthOriginalControlJournal(storage:ProtectedHealthFileStorage(file:dir.appendingPathComponent("lost-journal.json")))
try adapter.verifyFixtureIdentity(expected:context)
enum DeliberateLoss:Error {case afterResponse}
var received=false,exchanges=0
let host=MobileControlFixtureHost(journal:journal,current:{context},restrict:{_ in exit(3)},exchange:{body in
 exchanges+=1;let response=try adapter.exchangeVerified(body,expected:context)
 if phase=="drop" {guard response.status==200 else{throw MobileControlFixtureHost.Failure.transport};received=true;throw DeliberateLoss.afterResponse}
 return response
})
if phase=="drop" {
 let original=try JSONSerialization.data(withJSONObject:["schemaVersion":"1.0.0","operationId":UUID().uuidString.lowercased(),"target":seed["initialTarget"]!,"action":["kind":"enroll"]])
 do{_ = try host.apply(original:original,context:context,proof:nil);exit(4)}catch DeliberateLoss.afterResponse{};guard received,exchanges==1,case .current = try journal.status(scope:scope) else{exit(5)}
 do{_ = try host.apply(original:original,context:context,proof:nil);exit(6)}catch{};guard exchanges==1 else{exit(7)}
 print("synthetic response deliberately discarded after one authenticated POST; original held")
} else if phase=="reconcile" {
 guard case .current = try journal.status(scope:scope),try host.reconcile(context:context) == .applied,exchanges==1,case .current = try journal.status(scope:scope) else{exit(8)}
 print("fresh process reconciled original applied read-only; journal remains held")
} else {exit(9)}
