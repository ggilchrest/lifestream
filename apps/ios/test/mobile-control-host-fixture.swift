import Foundation
final class Disk:HealthSnapshotStorage {var bytes:Data?;var fail=false;func read()throws->Data?{bytes};func replace(_ d:Data)throws{if fail{throw CocoaError(.fileWriteNoPermission)};bytes=d}}
let dir=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true),root=try JSONSerialization.jsonObject(with:Data(contentsOf:dir.appendingPathComponent("mobile-control-outcome-fixtures.json"))) as! [String:Any],cases=root["cases"] as! [[String:Any]]
func fixture(_ name:String)->[String:Any]{cases.first{$0["name"] as? String == name}!}
func bytes(_ x:Any)throws->Data{try JSONSerialization.data(withJSONObject:x)}
let configured=fixture("configure"),original=configured["originalRequest"] as! [String:Any],target=original["target"] as! [String:Any],principal=UUID(uuidString:target["principalId"] as! String)!,endpoint=UUID(uuidString:target["endpointId"] as! String)!,enrollment=UUID(uuidString:target["enrollmentId"] as! String)!,namespace=target["sourceNamespace"] as! String,revision=target["expectedRevision"] as! Int,session=UUID(),scope=HealthOriginalControlJournal.Scope(serverDigest:String(repeating:"a",count:64),principal:principal,endpoint:endpoint,session:session)
let config:[String:Any]=["categories":["SleepSegment"],"uses":["answers"],"assistantIds":[],"collectionPaused":false,"usePaused":false],e:[String:Any]=["enrollmentId":enrollment.uuidString.lowercased(),"principalId":principal.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":namespace,"revision":revision,"state":"active","configuration":config],f:[String:Any]=["policyRevision":revision,"sourceBound":true,"collectionAllowed":true,"categories":["SleepSegment"],"uses":["answers"],"assistantIds":[],"sourceNamespace":namespace]
let policy:[String:Any]=["schemaVersion":"1.0.0","producerPin":["schemaId":MobileHealthEncoder.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthEncoder.schemaSHA256],"result":["enrollment":e,"effective":f]],proof=try MobileHealthPolicyParser.parse(bytes(policy),expectedPrincipal:principal,expectedEndpoint:endpoint,expectedEnrollment:enrollment)
let initial=MobileControlFixtureHost.Context(scope:scope,transportEpoch:1,contextRevision:1,ordinarySelf:true)
for name in ["enroll","bindNew","configure","remove"] {
 let item=fixture(name),disk=Disk(),journal=HealthOriginalControlJournal(storage:disk);var events=[String](),current:MobileControlFixtureHost.Context?=initial
 let host=MobileControlFixtureHost(journal:journal,current:{current},restrict:{_ in events.append("restrict")},exchange:{payload in events.append("send");let x=try JSONSerialization.jsonObject(with:payload) as! [String:Any];guard x["operation"] as? String == "control",disk.bytes != nil else{exit(2)};return (200,try bytes(item["response"]!))})
 guard try host.apply(original:bytes(item["originalRequest"]!),context:initial,proof:["configure","remove"].contains(name) ? proof:nil) == .applied else{exit(3)}
 guard events==(["configure","remove"].contains(name) ? ["restrict","send"]:["send"]) else{exit(4)}
 do{_ = try host.apply(original:bytes(item["originalRequest"]!),context:initial,proof:proof);exit(5)}catch{};current=nil
}
let request=try bytes(configured["originalRequest"]!),disk=Disk();var sends=0,current:MobileControlFixtureHost.Context?=initial
let failing=MobileControlFixtureHost(journal:HealthOriginalControlJournal(storage:disk),current:{current},restrict:{_ in throw CocoaError(.fileWriteNoPermission)},exchange:{_ in sends+=1;return (500,Data())})
do{_ = try failing.apply(original:request,context:initial,proof:proof);exit(6)}catch{};guard sends==0,disk.bytes==nil else{exit(7)}
disk.fail=true;let blocked=MobileControlFixtureHost(journal:HealthOriginalControlJournal(storage:disk),current:{current},restrict:{_ in},exchange:{_ in sends+=1;return (500,Data())});do{_ = try blocked.apply(original:request,context:initial,proof:proof);exit(8)}catch{};guard sends==0 else{exit(9)};disk.fail=false
var wrongCollector=original,wrongTarget=target;wrongTarget["collector"]="healthConnect";wrongCollector["target"]=wrongTarget
let wrongDisk=Disk();let wrongHost=MobileControlFixtureHost(journal:HealthOriginalControlJournal(storage:wrongDisk),current:{initial},restrict:{_ in exit(20)},exchange:{_ in exit(21)})
do{_ = try wrongHost.apply(original:bytes(wrongCollector),context:initial,proof:proof);exit(22)}catch{};guard wrongDisk.bytes==nil else{exit(23)}
let beforeDisk=Disk();var beforeContext:MobileControlFixtureHost.Context?=initial,beforeSends=0
let beforeChange=MobileControlFixtureHost(journal:HealthOriginalControlJournal(storage:beforeDisk),current:{beforeContext},restrict:{_ in beforeContext=MobileControlFixtureHost.Context(scope:scope,transportEpoch:1,contextRevision:2,ordinarySelf:true)},exchange:{_ in beforeSends+=1;return (500,Data())})
do{_ = try beforeChange.apply(original:request,context:initial,proof:proof);exit(16)}catch{};guard beforeSends==0,beforeDisk.bytes==nil else{exit(17)}
let afterDisk=Disk();var afterContext:MobileControlFixtureHost.Context?=initial
let afterChange=MobileControlFixtureHost(journal:HealthOriginalControlJournal(storage:afterDisk),current:{afterContext},restrict:{_ in},exchange:{_ in afterContext=MobileControlFixtureHost.Context(scope:scope,transportEpoch:1,contextRevision:2,ordinarySelf:true);return (200,try bytes(configured["response"]!))})
guard try afterChange.apply(original:request,context:initial,proof:proof) == .held,case .current = try HealthOriginalControlJournal(storage:afterDisk).status(scope:scope) else{exit(18)}
let notSelf=MobileControlFixtureHost.Context(scope:scope,transportEpoch:1,contextRevision:1,ordinarySelf:false);current=notSelf;do{_ = try blocked.apply(original:request,context:notSelf,proof:proof);exit(19)}catch{};current=initial
let lostDisk=Disk();var lostSends=0
let lostHost=MobileControlFixtureHost(journal:HealthOriginalControlJournal(storage:lostDisk),current:{initial},restrict:{_ in},exchange:{_ in lostSends+=1;throw CocoaError(.fileReadUnknown)})
do{_ = try lostHost.apply(original:request,context:initial,proof:proof);exit(24)}catch{};guard lostSends==1,case .current = try HealthOriginalControlJournal(storage:lostDisk).status(scope:scope) else{exit(25)}
do{_ = try lostHost.apply(original:request,context:initial,proof:proof);exit(26)}catch{};guard lostSends==1 else{exit(27)}
let deniedDisk=Disk(),deniedHost=MobileControlFixtureHost(journal:HealthOriginalControlJournal(storage:deniedDisk),current:{initial},restrict:{_ in},exchange:{_ in (403,try bytes(configured["response"]!))})
guard try deniedHost.apply(original:request,context:initial,proof:proof) == .held,case .current = try HealthOriginalControlJournal(storage:deniedDisk).status(scope:scope) else{exit(28)}
let pending=fixture("pendingRemove"),pendingRaw=try bytes(pending["originalRequest"]!),j=HealthOriginalControlJournal(storage:disk)
let changed=MobileControlFixtureHost(journal:j,current:{current},restrict:{_ in},exchange:{_ in sends+=1;current=nil;return (200,try bytes(pending["response"]!))})
guard try changed.apply(original:pendingRaw,context:initial,proof:proof) == .held else{exit(10)};current=initial;guard case .current = try HealthOriginalControlJournal(storage:disk).status(scope:scope) else{exit(11)}
let fresh=HealthOriginalControlJournal.Scope(serverDigest:scope.serverDigest,principal:scope.principal,endpoint:UUID(),session:UUID());let freshContext=MobileControlFixtureHost.Context(scope:fresh,transportEpoch:2,contextRevision:2,ordinarySelf:true);current=freshContext
let reader=MobileControlFixtureHost(journal:HealthOriginalControlJournal(storage:disk),current:{current},restrict:{_ in exit(12)},exchange:{payload in let x=try JSONSerialization.jsonObject(with:payload) as! [String:Any];guard x["operation"] as? String == "reconcileControl" else{exit(13)};return (200,try bytes(pending["response"]!))})
guard try reader.reconcile(context:freshContext) == .held else{exit(14)};let foreign=HealthOriginalControlJournal.Scope(serverDigest:scope.serverDigest,principal:UUID(),endpoint:UUID(),session:UUID());let foreignContext=MobileControlFixtureHost.Context(scope:foreign,transportEpoch:3,contextRevision:3,ordinarySelf:true);current=foreignContext;do{_ = try reader.reconcile(context:foreignContext);exit(15)}catch{}
print("four controls, local-first fencing, restart, context loss and read-only reconciliation passed")
