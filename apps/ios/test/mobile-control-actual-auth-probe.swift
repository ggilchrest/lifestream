import Foundation
import CryptoKit
let file=URL(fileURLWithPath:CommandLine.arguments[1]),privateFile=try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any],roles=privateFile["roles"] as! [String:[String:Any]],name=CommandLine.arguments[2],r=roles[name]!,origin=URL(string:privateFile["origin"] as! String)!
func id(_ k:String)->UUID {UUID(uuidString:r[k] as! String)!}
let digest=SHA256.hash(data:Data(origin.absoluteString.trimmingCharacters(in:CharacterSet(charactersIn:"/")).utf8)).map{String(format:"%02x",$0)}.joined(),scope=HealthOriginalControlJournal.Scope(serverDigest:digest,principal:id("principalId"),endpoint:id("endpointId"),session:id("sessionId")),context=MobileControlFixtureHost.Context(scope:scope,transportEpoch:1,contextRevision:r["contextRevision"] as! Int,ordinarySelf:true)
let adapter=try MobileControlFixtureLoopback(origin:origin,headers:["cookie":r["cookie"] as! String,"x-lifestream-csrf":r["csrf"] as! String,"x-lifestream-user-context":r["contextRef"] as! String],current:{context})
do{try adapter.verifyFixtureIdentity(expected:context);print("synthetic fixture Auth and session context verified")}catch{print("synthetic fixture currentness validation failed");exit(1)}
