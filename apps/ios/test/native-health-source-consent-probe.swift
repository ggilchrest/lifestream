import Foundation
@testable import AssistantCore
func check(_ value:@autoclosure()->Bool,_ message:String){if !value(){fputs("FAIL: \(message)\n",stderr);exit(1)}}
final class Store:ConnectionStore{var value:SavedConnection?;func load()throws->SavedConnection?{value};func save(_ value:SavedConnection)throws{self.value=value}}
let stage=CommandLine.arguments[1],stateURL=URL(fileURLWithPath:ProcessInfo.processInfo.environment["CONSENT_SYNTHETIC_STATE"]!)
var hideOperation:String?,delayOperation:String?,delayedDelivery:(()->Void)?,cancelStage=false,withdraw:(()->Void)?
var policyReads=0,policyValues:[Bool]=[],connectObserved=false,hidePostConnectPolicy=false
final class ProducerDriver {
 var serial=0
 func call(_ command:String,_ args:[String:Any]=[:])->[String:Any]{
  serial+=1;let id="native-\(serial)",frame=args.merging(["id":id,"command":command]){_,b in b}
  let data=try! JSONSerialization.data(withJSONObject:frame);try! FileHandle.standardOutput.write(contentsOf:data+Data([10]))
  var bytes=Data();while let byte=try! FileHandle.standardInput.read(upToCount:1),!byte.isEmpty{if byte[0]==10{break};bytes.append(byte);check(bytes.count<=1048576,"bounded relay")}
  let reply=try! JSONSerialization.jsonObject(with:bytes) as! [String:Any];check(reply["id"] as? String==id && reply["kind"] as? String != "driverError","actual driver reply");return reply
 }
}
var joinedDriver=ProducerDriver(),joinedIdentity:[String:Any]=[:],joinedOrigin="",joinedHideControl=false,joinedControls=0,joinedSelected=0,joinedSDKFactories=0,joinedQueries=0,joinedClocks=0,joinedProtected=true,joinedFileResolves=0
var joinedRequestBytes:[Data]=[],joinedResponseBytes:[Data]=[],joinedWireEvidence:[[String:Any]]=[]
func joinedBody(_ request:URLRequest)->Data{
 if let bytes=request.httpBody{return bytes};guard let stream=request.httpBodyStream else{return Data()};stream.open();defer{stream.close()};var bytes=Data(),buffer=[UInt8](repeating:0,count:4096)
 while stream.hasBytesAvailable{let count=stream.read(&buffer,maxLength:buffer.count);if count<=0{break};bytes.append(buffer,count:count)};return bytes
}
final class ActualProducerNetwork:URLProtocol {
 override class func canInit(with request:URLRequest)->Bool{true}
 override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
 override func startLoading(){DispatchQueue.main.async{[self] in
  check(request.url?.host=="offline.invalid","fake transport refuses real origin")
  let body=joinedBody(request),parsed=(try? JSONSerialization.jsonObject(with:body)) as? [String:Any]
  if parsed?["operation"] as? String=="control"{joinedControls+=1;if joinedHideControl{joinedHideControl=false;_ = joinedDriver.call("fault",["mode":"hideNextCompletedResponse"])}}
  if parsed?["operation"] as? String=="ingestSelected"{joinedSelected+=1}
  if parsed?["operation"] as? String=="calendar",(parsed?["payload"] as? [String:Any])?["operation"] as? String=="policy"{
    policyReads+=1
    if hidePostConnectPolicy && connectObserved{hidePostConnectPolicy=false;_ = joinedDriver.call("fault",["mode":"hideNextCompletedResponse"])}
  }

  if let hidden=hideOperation,parsed?["operation"] as? String==hidden{hideOperation=nil;_ = joinedDriver.call("fault",["mode":"hideNextCompletedResponse"])}
  if request.url?.path=="/api/runtime/v1/mobile-context-policy",let operation=parsed?["operation"] as? String,["requestApproval","approve","revoke"].contains(operation){
   let persisted=try! Data(contentsOf:stateURL),state=try! JSONSerialization.jsonObject(with:persisted) as! [String:Any],native=state["calendarNative"] as! [String:Any],pending=native["consentPending"] as! [String:Any]
   check(pending["attempted"] as? Bool==true && Data(base64Encoded:pending["original"] as! String)==body,"exact Native original and attempted durable BEFORE POST")
  }

  var headers=(request.allHTTPHeaderFields ?? [:]).map{[$0.key.lowercased(),$0.value]}.filter{!["origin","host","cookie"].contains($0[0])}
  // Lowest synthetic transport metadata/session cookie supplied by ACTUAL setup.
  // Native's csrf/context and the entire request body remain unchanged.
  headers.append(["origin",joinedOrigin]);headers.append(["cookie",joinedIdentity["cookie"] as! String])
  let reply=joinedDriver.call("request",["method":request.httpMethod ?? "GET","path":request.url!.path,"headers":headers,"bodyBase64":body.base64EncodedString()])
  joinedRequestBytes.append(body)
  if reply["kind"] as? String=="responseHidden"{client?.urlProtocol(self,didFailWithError:URLError(.networkConnectionLost));return}
  check(reply["kind"] as? String=="response","actual handler response only")
  let bytes=Data(base64Encoded:reply["bodyBase64"] as! String)!,pairs=reply["headers"] as! [[String]],fields=Dictionary(pairs.map{($0[0],$0[1])},uniquingKeysWith:{$1})
  joinedResponseBytes.append(bytes)
  if parsed?["operation"] as? String=="control",let action=(parsed?["payload"] as? [String:Any])?["action"] as? [String:Any],action["kind"] as? String=="configure",action["state"] as? String=="active"{connectObserved=true}
  if parsed?["operation"] as? String=="calendar",(parsed?["payload"] as? [String:Any])?["operation"] as? String=="policy",let value=try? JSONSerialization.jsonObject(with:bytes) as? [String:Any],let effective=(value["result"] as? [String:Any])?["effective"] as? [String:Any],let allowed=effective["collectionAllowed"] as? Bool{policyValues.append(allowed)}

  if parsed?["producerPin"] != nil{joinedWireEvidence.append(["path":request.url!.path,"requestBodyBase64":body.base64EncodedString(),"status":reply["status"]!,"responseBodyBase64":bytes.base64EncodedString()])}
  let deliver={ [self] in
    client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:reply["status"] as! Int,httpVersion:nil,headerFields:fields)!,cacheStoragePolicy:.notAllowed)
    client?.urlProtocol(self,didLoad:bytes);client?.urlProtocolDidFinishLoading(self)
  }
  if let delayed=delayOperation,parsed?["operation"] as? String==delayed{delayOperation=nil;delayedDelivery=deliver;return}
  deliver()
 }}
 override func stopLoading(){}
}
final class JoinedHandle:NativeCalendarFileHandle{
 init(){data=try? Data(contentsOf:stateURL)}
 var current=true,data:Data?,reads=0,writes=0,ambiguous=false,failBefore=false
 func read()throws->Data?{reads+=1;return data}
 func replace(_ bytes:Data)throws{if failBefore{throw CocoaError(.fileWriteUnknown)};data=bytes;writes+=1;try bytes.write(to:stateURL,options:.atomic);try bytes.write(to:stateURL.deletingLastPathComponent().appendingPathComponent(stateURL.deletingPathExtension().lastPathComponent+"-snapshot-\(stage)-\(writes).json"),options:.atomic);if let pending=((try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any])?["calendarNative"] as? [String:Any],pending["consentPending"] != nil{if cancelStage && (pending["consentPending"] as? [String:Any])?["attempted"] as? Bool==false{cancelStage=false;withdraw?()}};if ambiguous{throw CocoaError(.fileWriteUnknown)}}
 func close(){current=false}
}
final class JoinedFiles:NativeCalendarFilePort{
 let handle:JoinedHandle;var opens=0
 init(_ handle:JoinedHandle){self.handle=handle}
 func openExclusive(snapshot:URL)throws->any NativeCalendarFileHandle{opens+=1;return handle}
}
final class NeverSDK:NativeCalendarSelectionSDK{
 var capturedDefaultTimeZone:TimeZone{fatalError("no SDK time zone")}
 func access(category:String)->NativeCalendarReadAccess{fatalError("no SDK status")}
 func request(category:String,current:()->Bool,completion:@escaping(Bool,Error?)->Void)->Bool{fatalError("no OS permission")}
 func eventCalendars(current:()->Bool)throws->[NativeCalendarMetadata]{fatalError("no discovery")}
 func acquisition(outbox:HealthOutbox,selected:[NativeCalendarMetadata],current:()->Bool)->MobileEventKitAcquisition?{fatalError("no data read")}
}
func canonical(_ v:Any)->Data{try! MobileHealthSourceConsent.canonical(v)}
func envelopeOriginal(_ q:[String:Any])->MobileHealthSourceConsent.Original?{
 guard let payload=q["payload"] as? [String:Any],let command=payload["command"] as? String else{return nil}
 let op=command=="requestSourceConsent" ? "requestApproval":command=="approveSourceConsent" ? "approve":"revoke"
 return try? MobileHealthSourceConsent.command(canonical(["producerPin":MobileHealthSourceConsent.pin,"operation":op,"payload":payload]))
}
final class Memory:HealthSnapshotStorage{var data:Data?,writes=0,fail=false,after=false;func read()throws->Data?{data};func replace(_ bytes:Data)throws{if fail{throw CocoaError(.fileWriteUnknown)};data=bytes;writes+=1;if after{throw CocoaError(.fileWriteUnknown)}}}
func wire(){
 let path=ProcessInfo.processInfo.environment["HEALTH_CONSENT_VECTORS"]!,v=try! JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:path))) as! [String:Any],frames=v["vectors"] as! [[String:Any]]
 let disk=Memory(),box=HealthOutbox(storage:disk);var binding:HealthOutbox.CalendarNativeBinding?,request:MobileHealthSourceConsent.Original?,states=0
 for f in frames{
  let q=try! JSONSerialization.jsonObject(with:Data(base64Encoded:f["requestBodyBase64"] as! String)!) as! [String:Any],data=Data(base64Encoded:f["responseBodyBase64"] as! String)!,expected=envelopeOriginal(q)
  let result=try! MobileHealthSourceConsent.response(data,expected:expected)
  switch result{
  case .descriptor(let d):binding = .init(origin:"https://offline.invalid",principal:d.principal,session:UUID(),endpoint:d.endpoint);check(d.collector=="healthKit" && d.category=="SleepSegment","literal Health descriptor")
  case .reserved(let r):
   if q["operation"] as? String=="requestApproval"{try! box.stageHealthSourceConsent(binding:binding!,original:r.original.original);try! box.markHealthSourceConsentAttempted(binding:binding!,original:r.original.original);try! box.settleHealthSourceConsent(binding:binding!,original:r.original.original,response:data,reconciliation:false);request=r.original}
  case .observed:
   let cmd=expected!;try! box.stageHealthSourceConsent(binding:binding!,original:cmd.original);try! box.markHealthSourceConsentAttempted(binding:binding!,original:cmd.original);let before=disk.data
   do{try box.settleHealthSourceConsent(binding:binding!,original:cmd.original,response:data,reconciliation:false);check(false,"observed cannot settle")}catch{}
   check(disk.data==before,"observed preserves exact pending")
   // A new Core process/object can recover only the same durable original.
   let reopened=HealthOutbox(storage:disk);check((try! reopened.healthSourceConsentPending(origin:binding!.origin,principal:binding!.principal,endpoint:binding!.endpoint))?.original==cmd.original,"cold exact pending")
   do{try reopened.stageHealthSourceConsent(binding:binding!,original:request!.original);check(false,"second pending forbidden")}catch{}
   do{_ = try reopened.calendarSourceConsentPending(origin:binding!.origin,principal:binding!.principal,endpoint:binding!.endpoint);check(false,"Calendar cannot adopt Health pending")}catch{}
  case .terminal(let terminal):
   if (try! box.healthSourceConsentPending(origin:binding!.origin,principal:binding!.principal,endpoint:binding!.endpoint)) != nil{try! box.settleHealthSourceConsent(binding:binding!,original:terminal.original.original,response:data,reconciliation:true)}
  case .held,.status:break
  }
  if let state=disk.data{states+=1;try! state.write(to:stateURL.deletingLastPathComponent().appendingPathComponent("wire-state-\(states).json"))}
  var bad=try! JSONSerialization.jsonObject(with:data) as! [String:Any];bad["producerPin"]=MobileCalendarSourceConsent.pin
  do{_ = try MobileHealthSourceConsent.response(canonical(bad));check(false,"wrong Calendar pin")}catch{}
 }
 check(frames.count==12 && disk.writes>0,"all literal frames consumed")
 let original=disk.data!,foreignEndpoint=UUID(),foreign=HealthOutbox.CalendarNativeBinding(origin:binding!.origin,principal:binding!.principal,session:binding!.session,endpoint:foreignEndpoint)
 let unrelated=try! MobileCalendarSettingsWire.envelope(payload:["schemaVersion":"1.0.0","operationId":UUID().uuidString.lowercased(),"target":["principalId":binding!.principal.uuidString.lowercased(),"endpointId":foreignEndpoint.uuidString.lowercased(),"collector":"eventKit","enrollmentId":NSNull(),"sourceNamespace":NSNull(),"expectedRevision":0],"action":["kind":"enroll"]])
 do{try box.stageCalendarNativeCommand(binding:foreign,original:unrelated.original);check(false,"Calendar settings cannot disregard retained Health binding")}catch{}
 var otherScope=request!.scope.json;otherScope["collector"]="eventKit";otherScope["category"]="CalendarEvent"
 let oldRequest=try! MobileCalendarSourceConsent.request(operationID:UUID(),scope:MobileCalendarSourceConsent.scope(otherScope),revision:0,validity:.untilRevoked,reviewDeadline:"2026-12-01T00:00:00Z")
 do{try box.stageCalendarSourceConsent(binding:foreign,original:oldRequest.original);check(false,"Calendar consent cannot disregard retained Health binding")}catch{}
 check(disk.data==original,"foreign family targeting performs no writes")
 let retained=disk.data!,before=disk.writes;var corrupt=try! JSONSerialization.jsonObject(with:retained) as! [String:Any];var n=corrupt["calendarNative"] as! [String:Any];n["format"]="CalendarNative/2";corrupt["calendarNative"]=n;disk.data=canonical(corrupt)
 do{_ = try box.healthSourceConsentPending(origin:binding!.origin,principal:binding!.principal,endpoint:binding!.endpoint);check(false,"old-format unknown semantics rejected")}catch{}
 check(disk.writes==before,"invalid codec does not write");disk.data=retained
 fputs("PASS native wire twelve actual frames, one pending/cold/unknown/typed codec\n",stderr)
}
// Storage-only historical-data fixture. These inert intents are never sent and
// none of this fixture's local data is evidence of Native authority or SDK access.
func legacyIntentPreservation(){
 func storedBytes(_ v:Any)->Data{try! JSONSerialization.data(withJSONObject:v,options:[.sortedKeys,.withoutEscapingSlashes])}
 guard let path=ProcessInfo.processInfo.environment["HEALTH_CONSENT_LEGACY_SHARE"] else{return}
 let disk=Memory();disk.data=try! Data(contentsOf:URL(fileURLWithPath:path));let box=HealthOutbox(storage:disk),root=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any],human=UUID(uuidString:root["lastHuman"] as! String)!,enrollment=UUID(),namespace=UUID(),endpoint=UUID()
 try! box.setHuman(human);try! box.enroll(enrollment,human:human,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:namespace.uuidString.lowercased())
 let ticket=try! box.ticket(enrollment:enrollment,type:"sleep");try! box.commit(scope:"pre-existing-synthetic-scope",expectedAnchor:nil,nextAnchor:Data([1,2,3]),changes:[HealthChange(upstreamId:"pre-existing-synthetic-record",operation:.upsert,body:Data("synthetic retained health".utf8),expectedPolicyRevision:1,mappingVersion:"legacy-fixture/1")],ticket:ticket);try! box.pause(enrollment:enrollment)
 var raw=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any]
 raw["calendarEnrollments"]=[UUID().uuidString,["human":human.uuidString,"endpoint":endpoint.uuidString,"namespace":UUID().uuidString,"collector":"eventKit","revision":1,"categories":["CalendarEvent"],"paused":true,"requiresRebind":true,"checkpoints":["legacy-checkpoint":Data([5,6]).base64EncodedString()],"queue":[["data":Data("opaque retained synthetic calendar".utf8).base64EncodedString(),"eventId":UUID().uuidString,"digest":String(repeating:"1",count:64),"category":"CalendarEvent","quarantined":true,"code":"scope"]]]]
 disk.data=storedBytes(raw);let before=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any]
 let binding=HealthOutbox.CalendarNativeBinding(origin:"https://offline.invalid",principal:human,session:UUID(),endpoint:endpoint),scope=try! MobileHealthSourceConsent.scope(["kind":"sourceConsent","principalId":human.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":namespace.uuidString.lowercased(),"category":"SleepSegment","installationId":UUID().uuidString.lowercased(),"environmentId":"synthetic-storage-only","destinationId":"not-a-real-service","purpose":"collection","recipient":NSNull()])
 let intent=try! MobileHealthSourceConsent.request(operationID:UUID(),scope:scope,revision:0,validity:.untilRevoked,reviewDeadline:"2026-12-01T00:00:00Z")
 try! box.stageHealthSourceConsent(binding:binding,original:intent.original);try! box.markHealthSourceConsentAttempted(binding:binding,original:intent.original)
 let after=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any]
 check(before["lastHuman"] as? String==after["lastHuman"] as? String,"original owner retained")
 for key in ["enrollments","calendarEnrollments","shareAssociations"]{check(storedBytes(before[key]!)==storedBytes(after[key]!),"all original domain fields and queued bytes preserved")}
 let nativeBefore=storedBytes(after["calendarNative"]!),shareBefore=storedBytes(after["shareAssociations"]!),calendarBefore=storedBytes(after["calendarEnrollments"]!)
 // A protective existing writer still preserves the extended command state and
 // the unrelated domains. No collection or transmission is started by it.
 try! box.pause(enrollment:enrollment)
 let narrowed=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any]
 check(storedBytes(narrowed["calendarNative"]!)==nativeBefore && storedBytes(narrowed["shareAssociations"]!)==shareBefore && storedBytes(narrowed["calendarEnrollments"]!)==calendarBefore,"existing protective writer retains extension and other domains")
 try! disk.data!.write(to:stateURL.deletingLastPathComponent().appendingPathComponent("legacy-domains-extended.json"));fputs("PASS original nonempty Health Calendar Share bytes/checkpoints/queues preserved by inert intent and protective writer; no authority claim\n",stderr)
}
@MainActor func call(_ source:NativeCalendarSourceOwner,_ operation:String,_ input:[String:Any]=[:])async->[String:Any]{await withCheckedContinuation{c in source.healthSourceConsent(operation:operation,input:input){c.resume(returning:$0)}}}
@MainActor func run()async{
 let opened=try! JSONSerialization.jsonObject(with:Data(base64Encoded:ProcessInfo.processInfo.environment["CONSENT_DRIVER_OPEN"]!)!) as! [String:Any]
 joinedIdentity=opened["syntheticIdentity"] as! [String:Any];joinedOrigin=opened["transportOrigin"] as! String
 let selected=try! JSONSerialization.jsonObject(with:Data(base64Encoded:ProcessInfo.processInfo.environment["HEALTH_SELECTED_SOURCE"]!)!) as! [String:Any],category=ProcessInfo.processInfo.environment["HEALTH_SELECTED_CATEGORY"]!
 let transport=NativeTransport(store:Store());try! transport.configure("https://offline.invalid");let network=URLSessionConfiguration.ephemeral;network.protocolClasses=[ActualProducerNetwork.self];transport.session=URLSession(configuration:network,delegate:transport,delegateQueue:.main);transport.csrf=joinedIdentity["csrf"] as! String
 let auth=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}};guard case .success((_,let http))=auth else{check(false,"actual Auth");return};check(http.statusCode==200 && transport.effectiveIsSelf,"authenticated self")
 let connection=NativeHealthConnectionOwner(transport:transport),handle=JoinedHandle(),files=JoinedFiles(handle)
 let registration=NativeCalendarAppComposition.registration{.init(resolveFile:{current in check(current(),"current locator");joinedFileResolves+=1;return URL(fileURLWithPath:"/synthetic/Library/Application Support/Lifestream/mobile-context.snapshot.json")},filePort:files,limits:.init(maxTotalDays:366,maxScans:8,maxSelectedCalendars:32)!,maxBytes:8388608,maxEvents:100000,mappingVersion:NativeCalendarAppComposition.mappingVersion,protectedAvailable:{joinedProtected},clock:{Date()},makeSDK:{joinedSDKFactories+=1;return NeverSDK()},deliveryContract:.selected)}
 guard let source=registration.bind(transport:transport,connection:connection) else{check(false,"original registration");return};withdraw={source.withdraw()};transport.healthContextWillChange={source.withdraw();connection.withdraw(authorityChanged:$0)}
 check(files.opens==0 && joinedSDKFactories==0 && joinedFileResolves==0,"production composition inert")
 func load()async->[String:Any]{let v=await call(source,"load",["sourceNamespace":selected["sourceNamespace"]!,"enrollmentId":selected["enrollmentId"]!,"category":category]);check(v["state"] as? String=="review","Health review: \(v["reason"] ?? "none")");return v}
 func prepare(_ purpose:String)async->[String:Any]{let review=await load();let v=await call(source,"request",["reviewId":review["reviewId"]!,"purpose":purpose,"validity":["kind":"untilRevoked"],"reviewDeadlineAt":ISO8601DateFormatter().string(from:Date().addingTimeInterval(300))]);return v}
 func confirm(_ review:[String:Any])async->[String:Any]{await call(source,"confirm",["reviewId":review["reviewId"]!,"humanConfirmed":true])}
 if stage=="decisions"{
  for purpose in ["collection","transmission"]{let r=await prepare(purpose);check(r["state"] as? String=="review" && r["request"] != nil,"durable inert request review");let observed=await confirm(r);check(observed["state"] as? String=="held","observed stays held");let terminal=await call(source,"recover");check(terminal["state"] as? String=="recorded" && terminal["activation"] as? String=="unavailable","actual original terminal recorded only")}
  let latest=await load();check((latest["statuses"] as! [[String:Any]]).allSatisfy{$0["consentState"] as? String=="valid"},"both independent purpose decisions")
 }else if stage=="hidden-request"{
  hideOperation="requestApproval";let r=await prepare("collection");check(r["state"] as? String=="held","hidden request held");let reads=handle.reads,writes=handle.writes;let denied=await call(source,"load",["sourceNamespace":selected["sourceNamespace"]!,"enrollmentId":selected["enrollmentId"]!,"category":category]);check(denied["state"] as? String=="held" && handle.reads==reads && handle.writes==writes,"unknown original excludes new operation")
 }else if stage=="recover-request"{
  let r=await call(source,"recover");check(r["state"] as? String=="review" && r["request"] != nil,"cold exact request reconciliation");let o=await confirm(r);check(o["state"] as? String=="held","approval observed held")
 }else if stage=="recover-approval"{
  let r=await call(source,"recover");check(r["state"] as? String=="recorded","cold exact approval terminal")
 }else if stage=="revoke"{
  let r=await load(),o=await call(source,"revoke",["reviewId":r["reviewId"]!,"purpose":"collection","humanConfirmed":true]);check(o["state"] as? String=="held","revocation observed is not terminal")
 }else if stage=="recover-revoke"{let value=await call(source,"recover");check(value["state"] as? String=="recorded","cold original revoke terminal")
 }else if stage=="cancel"{cancelStage=true;let r=await prepare("collection");check(r["state"] as? String=="held","withdraw during durable stage retains hold")
 }else if stage=="write-before" || stage=="write-after"{
  let r=await load(),before=handle.data
  if stage=="write-before"{handle.failBefore=true}else{handle.ambiguous=true}
  let sent=joinedRequestBytes.count
  let result=await call(source,"request",["reviewId":r["reviewId"]!,"purpose":"collection","validity":["kind":"untilRevoked"],"reviewDeadlineAt":ISO8601DateFormatter().string(from:Date().addingTimeInterval(300))])
  check(result["state"] as? String=="held","ambiguous write held")
  let writes=handle.writes,reads=handle.reads,after=handle.data
  let recovery=await call(source,"recover")
  check(recovery["state"] as? String=="held" && handle.writes==writes && handle.reads==reads && handle.data==after,"unknown write cannot reopen or escape")
  let mutations=joinedRequestBytes.dropFirst(sent).compactMap{try? JSONSerialization.jsonObject(with:$0) as? [String:Any]}.filter{["requestApproval","approve","revoke"].contains($0["operation"] as? String ?? "")}
  check(mutations.isEmpty,"no POST after unconfirmed stage")
  if stage=="write-before"{check(handle.data==before,"before-write storage bytes preserved")}else{check(handle.data != nil,"after-write original retained")}
 }else if stage=="delayed-request" || stage=="never-request"{
  let r=await load();delayOperation="requestApproval"
  let pending=Task{@MainActor in await call(source,"request",["reviewId":r["reviewId"]!,"purpose":"collection","validity":["kind":"untilRevoked"],"reviewDeadlineAt":ISO8601DateFormatter().string(from:Date().addingTimeInterval(300))])}
  for _ in 0..<100 where delayedDelivery==nil{await withCheckedContinuation{(c:CheckedContinuation<Void,Never>) in DispatchQueue.main.asyncAfter(deadline:.now()+0.01){c.resume()}}}
  check(delayedDelivery != nil,"actual handler completed but response withheld")
  let denied=await call(source,"load",["sourceNamespace":selected["sourceNamespace"]!,"enrollmentId":selected["enrollmentId"]!,"category":category]);check(denied["state"] as? String=="held","entered response excludes other work")
  source.withdraw();let result=await pending.value;check(result["state"] as? String=="held","cancellation preserves original hold")
  let writes=handle.writes
  if stage=="delayed-request"{delayedDelivery?();delayedDelivery=nil;await withCheckedContinuation{(c:CheckedContinuation<Void,Never>) in DispatchQueue.main.asyncAfter(deadline:.now()+0.03){c.resume()}};check(handle.writes==writes,"late response cannot settle cancelled original")}
 }else{check(false,"known stage")}
 check(joinedSDKFactories==0 && joinedQueries==0,"no SDK/witness/discovery/data activation")
 let checkpoint=joinedDriver.call("checkpoint");check(checkpoint["listening"] as? Bool==false,"no listener")
 fputs("PASS native \(stage)\n",stderr)
}
if stage=="recovery-read"{
 let registration=NativeCalendarAppComposition.registration{fatalError("disabled recovery must not create resources")}
 check(!registration.enabled,"actual disabled registration")
 for path in CommandLine.arguments.dropFirst(2){let data=try! Data(contentsOf:URL(fileURLWithPath:path)),raw=try! JSONSerialization.jsonObject(with:data) as! [String:Any],native=raw["calendarNative"] as! [String:Any],record=(native["consentPending"] ?? native["healthConsentResult"] ?? native["consentResult"]) as! [String:Any],b=record["binding"] as! [String:Any];let disk=Memory();disk.data=data;let box=HealthOutbox(storage:disk)
  _ = try! box.healthSourceConsentPending(origin:b["origin"] as! String,principal:UUID(uuidString:b["principal"] as! String)!,endpoint:UUID(uuidString:b["endpoint"] as! String)!)
  check(disk.data==data && disk.writes==0,"latest disabled codec reads without writes")
 }
 fputs("PASS actual disabled recovery latest codec zero writes\n",stderr);exit(0)
}
if stage=="wire"{wire();legacyIntentPreservation();exit(0)}
Task{@MainActor in await run();exit(0)}
DispatchQueue.main.asyncAfter(deadline:.now()+75){fputs("FAIL native timeout\n",stderr);exit(2)}
RunLoop.main.run()
