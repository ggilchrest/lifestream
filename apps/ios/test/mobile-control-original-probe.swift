import Foundation
final class Disk:HealthSnapshotStorage {var bytes:Data?;var fail=false;func read()throws->Data?{bytes};func replace(_ data:Data)throws{if fail{throw CocoaError(.fileWriteNoPermission)};bytes=data}}
let dir=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
func load(_ name:String)throws->[String:Any]{try JSONSerialization.jsonObject(with:Data(contentsOf:dir.appendingPathComponent(name))) as! [String:Any]}
let vector=try load("mobile-control-canonical-vectors.json"),cases=try load("mobile-control-outcome-fixtures.json")
for item in vector["vectors"] as! [[String:Any]] {let req=try MobileControlOriginal.parse(JSONSerialization.data(withJSONObject:item["request"]!));guard req.canonical==Data((item["canonicalUtf8"] as! String).utf8),req.digest==item["sha256"] as? String else{exit(2)}}
for item in cases["cases"] as! [[String:Any]] {
 let raw=try JSONSerialization.data(withJSONObject:item["originalRequest"]!),response=try JSONSerialization.data(withJSONObject:item["response"]!)
 _ = try MobileControlOriginal.parse(raw)
 let actual=String(describing:MobileControlReceipt.assess(expected:raw,response:response))
 guard actual==item["expectedSettlement"] as? String else{print("fixture mismatch: \(item["name"]!) expected \(item["expectedSettlement"]!) got \(actual)");exit(9)}
}
if CommandLine.arguments.count>2 {
 let edge=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[2]))) as! [String:Any]
 for item in edge["cases"] as! [[String:Any]] {let original=item["request"]!,raw=try JSONSerialization.data(withJSONObject:original,options:[.sortedKeys,.withoutEscapingSlashes]),parsed=try MobileControlOriginal.parse(raw);guard parsed.canonical==raw else{exit(20)}}
}
let configurationCase=(cases["cases"] as! [[String:Any]]).first{$0["name"] as? String == "configure"}!
for symbol in ["é","🦉"] {for count in [600,1024,1025] {
 var request=configurationCase["originalRequest"] as! [String:Any],action=request["action"] as! [String:Any],configuration=action["configuration"] as! [String:Any]
 configuration["preferredSource"]=String(repeating:symbol,count:count);action["configuration"]=configuration;request["action"]=action
 let data=try JSONSerialization.data(withJSONObject:request);if count<=1024 {_ = try MobileControlOriginal.parse(data)}else{do{_ = try MobileControlOriginal.parse(data);exit(21)}catch{}}
}}
var urnRequest=configurationCase["originalRequest"] as! [String:Any],urnAction=urnRequest["action"] as! [String:Any],urnConfig=urnAction["configuration"] as! [String:Any]
let urn="urn:uuid:ABCDEF00-1234-4ABC-8DEF-123456ABCDEF";urnConfig["assistantIds"]=[urn];urnAction["configuration"]=urnConfig;urnRequest["action"]=urnAction
let urnRaw=try JSONSerialization.data(withJSONObject:urnRequest,options:[.sortedKeys,.withoutEscapingSlashes]),urnParsed=try MobileControlOriginal.parse(urnRaw);guard urnParsed.canonical==urnRaw,String(data:urnParsed.canonical,encoding:.utf8)!.contains(urn) else{exit(23)}
let badSurrogate=Data("{\"s\":\"\\ud800\"}".utf8);do{_ = try JSONSerialization.jsonObject(with:badSurrogate);exit(22)}catch{}
let removeCase=(cases["cases"] as! [[String:Any]]).first{$0["name"] as? String == "remove"}!
let expectedRemove=try JSONSerialization.data(withJSONObject:removeCase["originalRequest"]!)
for change in 0..<5 {
 var response=removeCase["response"] as! [String:Any],outcome=response["result"] as! [String:Any],receipt=outcome["receipt"] as! [String:Any],result=receipt["result"] as! [String:Any]
 switch change {
 case 0:response["producerPin"]=["schemaId":"wrong","schemaVersion":"1.0.0","digest":MobileControlOriginal.schemaSHA256]
 case 1:outcome["requestDigest"]=String(repeating:"0",count:64)
 case 2:result["suppressionCommitted"]=false
 case 3:result["removedCount"]=1;result["suppressionEpoch"]=0
 default:receipt["durability"]="pending"
 }
 receipt["result"]=result;outcome["receipt"]=receipt;response["result"]=outcome
 guard MobileControlReceipt.assess(expected:expectedRemove,response:try JSONSerialization.data(withJSONObject:response)) == .held else{exit(12)}
}
let configureCase=(cases["cases"] as! [[String:Any]]).first{$0["name"] as? String == "configure"}!
for invalid:Any in [true,-1,1.5,9007199254740992] {
 var original=configureCase["originalRequest"] as! [String:Any],target=original["target"] as! [String:Any];target["expectedRevision"]=invalid;original["target"]=target
 do{_ = try MobileControlOriginal.parse(JSONSerialization.data(withJSONObject:original));exit(13)}catch{}
}
var maximum=configureCase["originalRequest"] as! [String:Any],maximumTarget=maximum["target"] as! [String:Any];maximumTarget["expectedRevision"]=9007199254740991;maximum["target"]=maximumTarget
do{_ = try MobileControlOriginal.parse(JSONSerialization.data(withJSONObject:maximum));exit(14)}catch{}
maximumTarget["expectedRevision"]=9007199254740990;maximum["target"]=maximumTarget;_ = try MobileControlOriginal.parse(JSONSerialization.data(withJSONObject:maximum))
let expectedConfigure=try JSONSerialization.data(withJSONObject:configureCase["originalRequest"]!)
for change in 0..<7 {
 var response=configureCase["response"] as! [String:Any],outcome=response["result"] as! [String:Any],receipt=outcome["receipt"] as! [String:Any],result=receipt["result"] as! [String:Any],enrollment=result["enrollment"] as! [String:Any]
 switch change {case 0:enrollment["sourceNamespace"]="00000000-0000-4000-8000-000000000099";case 1:enrollment["revision"]=9;case 2:var config=enrollment["configuration"] as! [String:Any];config["usePaused"]=true;enrollment["configuration"]=config;case 3:enrollment["principalId"]="00000000-0000-4000-8000-000000000099";case 4:enrollment["endpointId"]="00000000-0000-4000-8000-000000000099";case 5:enrollment["collector"]="healthConnect";default:receipt["committedAt"]="not-a-date"}
 result["enrollment"]=enrollment;receipt["result"]=result;outcome["receipt"]=receipt;response["result"]=outcome
 guard MobileControlReceipt.assess(expected:expectedConfigure,response:try JSONSerialization.data(withJSONObject:response)) == .held else{exit(15)}
}
let item=(cases["cases"] as! [[String:Any]])[0],raw=try JSONSerialization.data(withJSONObject:item["originalRequest"]!),req=try MobileControlOriginal.parse(raw),session=UUID(),scope=HealthOriginalControlJournal.Scope(serverDigest:String(repeating:"a",count:64),principal:req.principal,endpoint:req.endpoint,session:session),disk=Disk()
let control=try MobileControlOriginal.envelope(req,reconciliation:false),reconcile=try MobileControlOriginal.envelope(req,reconciliation:true)
let a=try JSONSerialization.jsonObject(with:control) as! [String:Any],b=try JSONSerialization.jsonObject(with:reconcile) as! [String:Any]
guard a["operation"] as? String == "control",b["operation"] as? String == "reconcileControl",let payloadA=a["payload"],let payloadB=b["payload"],try MobileControlOriginal.parse(JSONSerialization.data(withJSONObject:payloadA)).canonical==req.canonical,try MobileControlOriginal.parse(JSONSerialization.data(withJSONObject:payloadB)).canonical==req.canonical else{exit(24)}
try HealthOriginalControlJournal(storage:disk).prepare(scope:scope,original:raw)
let resumed=HealthOriginalControlJournal(storage:disk);guard try resumed.original(scope:scope)==req.canonical else{exit(10)};guard case .current(let op,let hash)=try resumed.status(scope:scope),op==req.operationId,hash==req.digest else{exit(3)}
do{try resumed.prepare(scope:scope,original:raw);exit(4)}catch{}
let other=HealthOriginalControlJournal.Scope(serverDigest:String(repeating:"b",count:64),principal:req.principal,endpoint:req.endpoint,session:session);guard case .heldElsewhere = try resumed.status(scope:other) else{exit(5)};do{_ = try resumed.original(scope:other);exit(11)}catch{}
let otherScopes=[HealthOriginalControlJournal.Scope(serverDigest:scope.serverDigest,principal:UUID(),endpoint:scope.endpoint,session:scope.session),HealthOriginalControlJournal.Scope(serverDigest:scope.serverDigest,principal:scope.principal,endpoint:UUID(),session:scope.session),HealthOriginalControlJournal.Scope(serverDigest:scope.serverDigest,principal:scope.principal,endpoint:scope.endpoint,session:UUID())]
for different in otherScopes {guard case .heldElsewhere = try resumed.status(scope:different) else{exit(16)};do{_ = try resumed.original(scope:different);exit(17)}catch{}}
let saved=disk.bytes!;disk.bytes=Data("{}".utf8);do{_ = try resumed.status(scope:scope);exit(6)}catch{};disk.bytes=saved
let failing=Disk();failing.fail=true;do{try HealthOriginalControlJournal(storage:failing).prepare(scope:scope,original:raw);exit(7)}catch{};guard failing.bytes==nil else{exit(8)}
print("9 canonical vectors, 11 receipt fixtures and restart fences passed")
