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
  if parsed?["operation"] as? String=="control" {
   let persisted=try! Data(contentsOf:stateURL),state=try! JSONSerialization.jsonObject(with:persisted) as! [String:Any],native=state["calendarNative"] as! [String:Any],pending=native["pending"] as! [String:Any]
   check(native["format"] as? String=="CalendarNative/4" && pending["attempted"] as? Bool==true,"same /4 slot attempted durable BEFORE control POST")
   let original=Data(base64Encoded:pending["original"] as! String)!
   check(stored(parsed!["payload"]!)==original && native["consentPending"]==nil,"exact canonical inner durable before POST, no second pending slot")
  }

  var headers=(request.allHTTPHeaderFields ?? [:]).map{[$0.key.lowercased(),$0.value]}.filter{!["origin","host","cookie"].contains($0[0])}
  // Lowest synthetic transport metadata/session cookie supplied by ACTUAL setup.
  // Native's csrf/context and the entire request body remain unchanged.
  headers.append(["origin",joinedOrigin]);headers.append(["cookie",joinedIdentity["cookie"] as! String])
  let reply=joinedDriver.call("request",["method":request.httpMethod ?? "GET","path":request.url!.path,"headers":headers,"bodyBase64":body.base64EncodedString()])
  joinedRequestBytes.append(body)
  if reply["kind"] as? String=="responseHidden"{client?.urlProtocol(self,didFailWithError:URLError(.networkConnectionLost));return}
  check(reply["kind"] as? String=="response","actual handler response only")
  var bytes=Data(base64Encoded:reply["bodyBase64"] as! String)!,pairs=reply["headers"] as! [[String]],fields=Dictionary(pairs.map{($0[0],$0[1])},uniquingKeysWith:{$1})
  if stage=="wrong-pin" && parsed?["operation"] as? String=="reconcile",var raw=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any],var pin=raw["producerPin"] as? [String:Any]{pin["digest"]=String(repeating:"0",count:64);raw["producerPin"]=pin;bytes=stored(raw)}
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
 func read()throws->Data?{reads+=1;fileReadHook?();return data}
 func replace(_ bytes:Data)throws{if failBefore{throw CocoaError(.fileWriteUnknown)};data=bytes;writes+=1;try bytes.write(to:stateURL,options:.atomic);try bytes.write(to:stateURL.deletingLastPathComponent().appendingPathComponent(stateURL.deletingPathExtension().lastPathComponent+"-snapshot-\(stage)-\(writes).json"),options:.atomic);if let pending=((try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any])?["calendarNative"] as? [String:Any],pending["pending"] != nil{if cancelStage && (pending["pending"] as? [String:Any])?["attempted"] as? Bool==false{cancelStage=false;withdraw?()}};if let native=((try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any])?["calendarNative"] as? [String:Any],native["healthControlResult"] != nil,native["pending"]==nil{terminalWriteHook?()};if ambiguous{throw CocoaError(.fileWriteUnknown)}}
 func close(){current=false}
}
final class JoinedFiles:NativeCalendarFilePort{
 let handle:JoinedHandle;var opens=0
 init(_ handle:JoinedHandle){self.handle=handle}
 func openExclusive(snapshot:URL)throws->any NativeCalendarFileHandle{opens+=1;if stage=="file-unavailable"{throw CocoaError(.fileReadNoPermission)};return handle}
}
final class NeverSDK:NativeCalendarSelectionSDK{
 var capturedDefaultTimeZone:TimeZone{fatalError("no SDK time zone")}
 func access(category:String)->NativeCalendarReadAccess{fatalError("no SDK status")}
 func request(category:String,current:()->Bool,completion:@escaping(Bool,Error?)->Void)->Bool{fatalError("no OS permission")}
 func eventCalendars(current:()->Bool)throws->[NativeCalendarMetadata]{fatalError("no discovery")}
 func acquisition(outbox:HealthOutbox,selected:[NativeCalendarMetadata],current:()->Bool)->MobileEventKitAcquisition?{fatalError("no data read")}
}
var terminalWriteHook:(()->Void)?
var fileReadHook:(()->Void)?
final class Query:NativeHealthQuery{var stops=0;func stop(){stops+=1}}
final class HealthSDK:NativeHealthSDK{
 var statusReads=0,permissionEntries=0,queries=0,permissionDone:((Result<Void,Error>)->Void)?,delayPermission=false
 var plans:[NativeHealthCollectionPlan]=[]
 var available:Bool{statusReads+=1;return true}
 func prepareReadAuthorization(types:Set<String>)->NativeHealthAuthorizationDelegate?{
  check(!types.isEmpty && types.isSubset(of:HealthKitCollector.supportedCategories),"real supported types")
  return {[self] done in permissionEntries+=1;if delayPermission{permissionDone=done}else{done(.success(()))}}
 }
 func query(plan:NativeHealthCollectionPlan,anchor:Data?,completion:@escaping(Result<NativeHealthPage,Error>)->Void)throws->any NativeHealthQuery{
  queries+=1;plans.append(plan);DispatchQueue.main.async{completion(.success(.init(observations:[],deleted:[],anchor:Data([1,2,3]),mayHaveMore:false)))};return Query()
 }
}
// Lowest fake storage only: these retained opaque rows grant no SDK/source authority.
final class StorageOnlyMemory:HealthSnapshotStorage{var data:Data?;init(_ d:Data){data=d};func read()throws->Data?{data};func replace(_ d:Data)throws{data=d}}
func stored(_ value:Any)->Data{try! JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes])}
func historicalStorage(human:UUID)->Data{
 let path=ProcessInfo.processInfo.environment["HEALTH_EXISTING_STORAGE_FIXTURE"]!,memory=StorageOnlyMemory(try! Data(contentsOf:URL(fileURLWithPath:path))),box=HealthOutbox(storage:memory)
 try! box.setHuman(human);let enrollment=UUID();try! box.enroll(enrollment,human:human,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:UUID().uuidString.lowercased())
 let ticket=try! box.ticket(enrollment:enrollment,type:"sleep");try! box.commit(scope:"inert-retained-scope",expectedAnchor:nil,nextAnchor:Data([1,2]),changes:[HealthChange(upstreamId:"inert-retained-record",operation:.upsert,body:Data("opaque synthetic old Health".utf8),expectedPolicyRevision:1,mappingVersion:"storage-only/1")],ticket:ticket);try! box.pause(enrollment:enrollment)
 var raw=try! JSONSerialization.jsonObject(with:memory.data!) as! [String:Any]
 raw["calendarEnrollments"]=[UUID().uuidString,["human":human.uuidString,"endpoint":UUID().uuidString,"namespace":UUID().uuidString,"collector":"eventKit","revision":1,"categories":["CalendarEvent"],"paused":true,"requiresRebind":true,"checkpoints":["inert-checkpoint":Data([3,4]).base64EncodedString()],"queue":[["data":Data("opaque synthetic old Calendar".utf8).base64EncodedString(),"eventId":UUID().uuidString,"digest":String(repeating:"1",count:64),"category":"CalendarEvent","quarantined":true,"code":"scope"]]]]
 return stored(raw)
}
func healthRows(_ raw:[String:Any])->[String:Data]{let list=raw["enrollments"] as! [Any];var values:[String:Data]=[:];for index in stride(from:0,to:list.count,by:2){values[list[index] as! String]=stored(list[index+1])};return values}
@MainActor func waitUntil(_ predicate:()->Bool)async{for _ in 0..<300{if predicate(){return};try? await Task.sleep(nanoseconds:10000000)};check(false,"callback reached expected stage")}
@MainActor func setupChoices(_ host:NativeHealthHost)async->[String:Any]{await withCheckedContinuation{c in host.loadSetupChoices{c.resume(returning:$0)}}}
@MainActor func choice(_ host:NativeHealthHost,_ kind:NativeHealthChoiceAction.Kind,_ request:[String:Any])async->[String:Any]{await withCheckedContinuation{c in host.performChoice(kind,input:request){c.resume(returning:$0)}}}


var codecSnapshot=0
final class CodecDisk:HealthSnapshotStorage {var data:Data;var writes=0;init(_ d:Data){data=d};func read()throws->Data?{data};func replace(_ d:Data)throws{data=d;writes+=1;codecSnapshot+=1;try d.write(to:stateURL.deletingLastPathComponent().appendingPathComponent("codec-snapshot-\(codecSnapshot).json"))}}
func refused(_ disk:CodecDisk,_ action:()throws->Void,_ message:String){let before=disk.data,writes=disk.writes;do{try action();check(false,message)}catch{};check(disk.data==before && disk.writes==writes,message+" unchanged")}
func runCodecMatrix(_ originalState:Data){
 let raw=try! JSONSerialization.jsonObject(with:originalState) as! [String:Any],native=raw["calendarNative"] as! [String:Any],last=native["healthControlResult"] as! [String:Any],binding=last["binding"] as! [String:String]
 let human=UUID(uuidString:binding["principal"]!)!,endpoint=UUID(uuidString:binding["endpoint"]!)!,session=UUID(uuidString:binding["session"]!)!,origin=binding["origin"]!
 let b=HealthOutbox.CalendarNativeBinding(origin:origin,principal:human,session:session,endpoint:endpoint)
 let terminal=try! MobileOrdinaryControl.terminalValue(response:Data(base64Encoded:last["response"] as! String)!,original:Data(base64Encoded:last["original"] as! String)!)
 var request=try! JSONSerialization.jsonObject(with:terminal.original.canonical) as! [String:Any]
 request["operationId"]=UUID().uuidString.lowercased();request["target"]=["principalId":human.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","enrollmentId":NSNull(),"sourceNamespace":NSNull(),"expectedRevision":0];request["action"]=["kind":"enroll"]
 let newOriginal=stored(request)
 let scope:[String:Any]=["kind":"sourceConsent","principalId":human.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":UUID().uuidString.lowercased(),"category":"SleepSegment","installationId":UUID().uuidString.lowercased(),"environmentId":"synthetic-only","destinationId":"synthetic-only","purpose":"collection","recipient":NSNull()]
 let hc=try! MobileHealthSourceConsent.revoke(operationID:UUID(),scope:MobileHealthSourceConsent.scope(scope),revision:0)
 var cs=scope;cs["collector"]="eventKit";cs["category"]="CalendarEvent"
 let cc=try! MobileCalendarSourceConsent.revoke(operationID:UUID(),scope:MobileCalendarSourceConsent.scope(cs),revision:0)
 var calendar=request;var target=request["target"] as! [String:Any];target["collector"]="eventKit";calendar["target"]=target
 let calendarOriginal=try! MobileCalendarSettingsWire.envelope(payload:calendar).original
 for family in ["health","calendar","healthConsent","calendarConsent"]{
  let disk=CodecDisk(originalState),box=HealthOutbox(storage:disk)
  switch family{case "health":try! box.stageHealthControl(binding:b,original:newOriginal)
  case "calendar":try! box.stageCalendarNativeCommand(binding:b,original:calendarOriginal)
  case "healthConsent":try! box.stageHealthSourceConsent(binding:b,original:hc.original)
  default:try! box.stageCalendarSourceConsent(binding:b,original:cc.original)}
  let after=try! JSONSerialization.jsonObject(with:disk.data) as! [String:Any],value=after["calendarNative"] as! [String:Any]
  check(value["format"] as? String=="CalendarNative/4" && stored(value["healthControlResult"]!)==stored(last),"all four writers preserve /4 and original bounded Health result")
  refused(disk,{try box.stageHealthControl(binding:b,original:newOriginal)},"Health cannot add second pending over \(family)")
  refused(disk,{try box.stageCalendarNativeCommand(binding:b,original:calendarOriginal)},"Calendar cannot add second pending over \(family)")
  refused(disk,{try box.stageHealthSourceConsent(binding:b,original:hc.original)},"Health consent cannot add second pending over \(family)")
  refused(disk,{try box.stageCalendarSourceConsent(binding:b,original:cc.original)},"Calendar consent cannot add second pending over \(family)")
  if family=="health"{
   let pending=try! box.healthControlPending(origin:origin,principal:human)!
   check(pending.original==newOriginal && !pending.attempted,"exact unattempted original")
   refused(disk,{try box.markCalendarNativeCommandAttempted(binding:b,original:newOriginal)},"Calendar cannot mark a Health pending")
   refused(disk,{try box.markHealthSourceConsentAttempted(binding:b,original:newOriginal)},"Consent cannot mark a Health pending")
  }
 }
 let disk=CodecDisk(originalState),box=HealthOutbox(storage:disk)
 refused(disk,{try box.settleHealthControl(binding:b,terminal:terminal,reconciliation:false)},"initial typed positive cannot settle")
 refused(disk,{_ = try box.healthControlLastOriginal(origin:origin,principal:UUID())},"foreign Human cannot retrieve original")
 refused(disk,{_ = try box.healthControlLastOriginal(origin:"https://foreign.invalid",principal:human)},"foreign origin cannot retrieve original")
 let changed=HealthOutbox.CalendarNativeBinding(origin:origin,principal:human,session:UUID(),endpoint:UUID())
 try! box.settleHealthControl(binding:changed,terminal:terminal,reconciliation:true)
 let persisted=try! JSONSerialization.jsonObject(with:disk.data) as! [String:Any],result=(persisted["calendarNative"] as! [String:Any])["healthControlResult"] as! [String:Any]
 check(stored(result["binding"]!)==stored(binding),"changed endpoint read-only recovery retains historical original binding")
 var changedRequest=request;var changedTarget=request["target"] as! [String:Any];changedTarget["endpointId"]=changed.endpoint.uuidString.lowercased();changedRequest["target"]=changedTarget
 refused(disk,{try box.stageHealthControl(binding:changed,original:stored(changedRequest))},"historical terminal is no new endpoint mutation authority")
 var nonempty=try! JSONSerialization.jsonObject(with:historicalStorage(human:human)) as! [String:Any];nonempty["version"]=4;nonempty["calendarNative"]=native
 let all=CodecDisk(stored(nonempty)),allBox=HealthOutbox(storage:all);try! allBox.stageHealthControl(binding:b,original:newOriginal)
 let saved=try! JSONSerialization.jsonObject(with:all.data) as! [String:Any]
 for key in ["enrollments","calendarEnrollments","shareAssociations"]{check(stored(nonempty[key]!)==stored(saved[key]!),"new /4 preserves nonempty \(key) queues/anchors/paused/rebind values")}
 fputs("PASS codec four-family one-slot, /4 no downgrade, cross-endpoint historical-only and nonempty domains\n",stderr)
}
func runWireVectors(){
 let path=ProcessInfo.processInfo.environment["HEALTH_REMOTE_VECTORS"]!,v=try! JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:path))) as! [String:Any]
 var observed=0,terminal=0,negative=0
 for frame in v["frames"] as! [[String:Any]]{
  guard let request=frame["request"] as? [String:Any],let response=frame["response"] as? [String:Any],request["command"] as? String=="request",request["path"] as? String=="/api/runtime/v1/mobile-context",let body64=request["bodyBase64"] as? String,let response64=response["bodyBase64"] as? String else{continue}
  let bytes=Data(base64Encoded:response64)!,body=try! JSONSerialization.jsonObject(with:Data(base64Encoded:body64)!) as! [String:Any]
  guard let payload=body["payload"],let original=try? MobileOrdinaryControl.original(stored(payload)) else{continue}
  let root=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any],result=root?["result"] as? [String:Any]
  if result?["kind"] as? String=="observed"{check(MobileOrdinaryControl.assessTerminal(response:bytes,original:original.canonical) == .held,"observed nested applied never terminal");observed+=1}
  if body["operation"] as? String=="reconcile",result?["kind"] as? String=="terminal"{
   let actual=try! MobileOrdinaryControl.terminalValue(response:bytes,original:original.canonical);check(actual.settlement != .held,"actual raw typed terminal");terminal+=1
   for variant in ["pin","family","original","reservation","unknown"]{var bad=root!;var result=result!
    switch variant{case "pin":bad["producerPin"]=["schemaId":"bad","schemaVersion":"1.0.0","digest":String(repeating:"0",count:64)]
    case "family":var binding=result["binding"] as! [String:Any];binding["family"]="calendar";result["binding"]=binding
    case "original":var control=result["control"] as! [String:Any];var outcome=control["result"] as! [String:Any];outcome["requestDigest"]=String(repeating:"0",count:64);control["result"]=outcome;result["control"]=control
    case "reservation":var binding=result["binding"] as! [String:Any];binding["reservationDigest"]=String(repeating:"0",count:64);result["binding"]=binding
    default:result["unexpected"]=true};bad["result"]=result
    check(MobileOrdinaryControl.assessTerminal(response:stored(bad),original:original.canonical) == .held,"wrong typed original/pin/family/reservation/unknown held");negative+=1
   }
  }
 }
 check(observed>=3 && terminal>=3 && negative>=15,"actual raw wire coverage");fputs("PASS wire observed=\(observed) terminal=\(terminal) negative=\(negative)\n",stderr)
}
@MainActor func remote(_ source:NativeCalendarSourceOwner,_ method:String,_ input:[String:Any]=[:])async->[String:Any]{await withCheckedContinuation{c in
 let done:([String:Any])->Void={c.resume(returning:$0)}
 switch method{case "options":source.healthRemoteSetupOptions(input:input,completion:done);case "review":source.healthReviewRemoteSetup(input:input,completion:done);case "apply":source.healthApplyRemoteSetup(input:input,completion:done);default:source.healthRecoverRemoteSetup(input:input,completion:done)}
}}
@MainActor func runRemote()async{
 let opened=try! JSONSerialization.jsonObject(with:Data(base64Encoded:ProcessInfo.processInfo.environment["CONSENT_DRIVER_OPEN"]!)!) as! [String:Any]
 joinedIdentity=opened["syntheticIdentity"] as! [String:Any];joinedOrigin=opened["transportOrigin"] as! String
 let transport=NativeTransport(store:Store());try! transport.configure("https://offline.invalid");let network=URLSessionConfiguration.ephemeral;network.protocolClasses=[ActualProducerNetwork.self];transport.session=URLSession(configuration:network,delegate:transport,delegateQueue:.main);transport.csrf=joinedIdentity["csrf"] as! String
 let auth=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}};guard case .success((_,let http))=auth else{check(false,"actual Auth");return};check(http.statusCode==200 && transport.effectiveIsSelf,"actual authenticated self")
 let connection=NativeHealthConnectionOwner(transport:transport),originalHost=connection.host,handle=JoinedHandle(),files=JoinedFiles(handle),sdk=HealthSDK()
 var factoryCalls=0,resourceCalls=0
 let registration=NativeCalendarAppComposition.registration{resourceCalls+=1;return .init(resolveFile:{current in check(current(),"current locator");joinedFileResolves+=1;return URL(fileURLWithPath:"/synthetic/Library/Application Support/Lifestream/mobile-context.snapshot.json")},filePort:files,limits:.init(maxTotalDays:366,maxScans:8,maxSelectedCalendars:32)!,maxBytes:8388608,maxEvents:100000,mappingVersion:NativeCalendarAppComposition.mappingVersion,protectedAvailable:{joinedProtected},clock:{Date()},makeSDK:{joinedSDKFactories+=1;return NeverSDK()},deliveryContract:.selected,health:.init(mappingVersion:NativeCalendarAppComposition.healthMappingVersion,makeSDK:{factoryCalls+=1;return sdk}))}
 guard let source=registration.bind(transport:transport,connection:connection) else{check(stage=="disabled" && resourceCalls==0 && files.opens==0 && factoryCalls==0,"disabled registration refuses before any resource");finishRemote();return}
 check(stage != "disabled","actual disabled compile")
 withdraw={source.withdraw();connection.withdraw()};transport.healthContextWillChange={source.withdraw();connection.withdraw(authorityChanged:$0)}
 check(files.opens==0 && factoryCalls==0 && joinedSDKFactories==0,"inert actual registration")
 if stage=="wire"{runWireVectors();finishRemote();return}
 if stage=="codec"{runCodecMatrix(handle.data!);finishRemote();return}
 if stage=="configured-calendar"{
  let human=UUID(uuidString:joinedIdentity["principalId"] as! String)!,session=UUID(uuidString:joinedIdentity["sessionId"] as! String)!,endpoint=UUID(uuidString:joinedIdentity["endpointId"] as! String)!,owner=NSObject()
  let root=NativeHealthRuntime.RootConfiguration(identity:.init(provenance:"inert-existing-calendar",origin:"https://offline.invalid",human:human,session:session,endpoint:endpoint,maxBytes:8388608,maxEvents:100000,storageOrigin:"https://offline.invalid",protectedFilePolicy:"inert-fixture-only"),protectedAvailable:{true},makeStorage:{fatalError("configured owner must not open storage")})
  let config=NativeCalendarAcquisitionOwner.Configuration(provenance:"inert-existing-calendar",origin:"https://offline.invalid",human:human,session:session,endpoint:endpoint,enrollment:UUID(),namespace:UUID(),plan:.init(category:"CalendarEvent",selectedContainerIDs:["inert-fixture-calendar"],mappingVersion:"inert-fixture/1",coverageStart:Date(timeIntervalSince1970:1793404800),coverageEnd:Date(timeIntervalSince1970:1793491200),capturedSDKDefaultTimeZone:TimeZone(secondsFromGMT:0)!),protectedAvailable:{true})
  let currency=NativeCalendarAdmissionCurrency(owner:owner,binding:.init(root:root.identity,configuration:config,selected:["CalendarEvent"],kind:.reconnectExistingLocal))
  let descriptor=NativeCalendarSavedDescriptor(selector:"inert-saved-calendar",label:"Existing Calendar",destinationLabel:"Synthetic existing destination",selection:.init(runtimeSelection:"inert-calendar-root",configuration:.init(configuration:config,custody:{_,_ in throw CocoaError(.fileReadNoPermission)},makeAcquisition:nil,captureClock:{Date()}),reconnect:.init(owner:owner,currency:currency,expectedSavedCategories:["CalendarEvent"])))
  let profile=NativeCalendarSavedProfile(root:root,descriptors:[descriptor]);check(profile != nil && connection.installCalendarConfiguration(profile!),"original existing Calendar profile")
  let configured=connection.host,refusal=await withCheckedContinuation{c in source.healthRemoteSetupOptions(input:[:]){c.resume(returning:$0)}}
  check(refusal["state"] as? String=="held" && connection.host === configured && configured.runtime==nil && files.opens==0 && factoryCalls==0,"configured Calendar owner refused intact without storage/SDK/retirement")
  finishRemote();return
 }
 let initial=handle.data
 if stage=="corrupt-file" || stage=="raw-legacy"{let result=await remote(source,"options");check(result["state"] as? String=="held" && handle.data==initial && handle.writes==0,"unreadable/legacy bytes held unchanged");finishRemote();return}
 if stage=="protected-unavailable"{joinedProtected=false}
 if stage=="file-reentry"{fileReadHook={fileReadHook=nil;source.withdraw();connection.withdraw()}}
 if stage=="nonempty-other-domains"{handle.data=historicalStorage(human:UUID(uuidString:joinedIdentity["principalId"] as! String)!)}
 let before=handle.data
 if stage=="no-original"{let result=await remote(source,"recover");check(result["state"] as? String=="unavailable" && handle.writes==0,"missing original never fabricated or dispatched");finishRemote();return}
 if stage.hasPrefix("recover") || stage=="wrong-pin"{
  if stage=="recover-publish-withdraw"{terminalWriteHook={terminalWriteHook=nil;source.withdraw();connection.withdraw()}}
  let controls=joinedControls,result=await remote(source,"recover")
  if stage=="recover-publish-withdraw"{let raw=try! JSONSerialization.jsonObject(with:handle.data!) as! [String:Any],native=raw["calendarNative"] as! [String:Any];check(result["state"] as? String=="held" && native["pending"]==nil && native["healthControlResult"] != nil,"known terminal write survives nested withdrawal while UI stays context-held");finishRemote();return}
  check(joinedControls==controls,"recovery never redispatches control")
  if stage=="wrong-pin" || stage=="recover-never-sent"{check(result["state"] as? String=="held" && handle.data==before,"unqualified recovery stays held without write");finishRemote();return}
  check(result["state"] as? String=="recorded" && result["outcome"] as? String=="applied" && result["readKnowledge"] as? String=="unknown" && result["activation"] as? String=="unavailable","actual separate terminal recorded: \(result)")
  let root=try! JSONSerialization.jsonObject(with:handle.data!) as! [String:Any],native=root["calendarNative"] as! [String:Any]
  check(native["pending"]==nil && native["healthControlResult"] != nil && native["format"] as? String=="CalendarNative/4","only exact typed terminal clears same pending slot")
  let again=await remote(source,"recover");check(again["state"] as? String=="recorded" && again["operationId"] as? String==result["operationId"] as? String,"second read-only recovery preserves historical identity")
  // A result is never automatically composed as a local Health profile.
  check(connection.host === originalHost && originalHost.runtime==nil && factoryCalls==0 && sdk.statusReads==0 && sdk.permissionEntries==0 && sdk.queries==0,"server result is no local SDK/profile/readiness")
  finishRemote();return
 }
 let options=await remote(source,"options")
 if ["protected-unavailable","file-unavailable","file-reentry","protected-read-loss"].contains(stage){check(options["state"] as? String=="held" && handle.data==before && handle.writes==0,"original resources refuse unchanged");finishRemote();return}
 check(options["state"] as? String=="options" && options["readKnowledge"] as? String=="unknown" && handle.writes==0,"fresh actual inventory options no writes: \(options)")
 if stage=="close"{let value=await remote(source,"options",["close":true]);check(value["reason"] as? String=="closed" && handle.writes==0 && factoryCalls==0,"explicit close idle owner only");finishRemote();return}
 var input:[String:Any]=["catalogId":options["catalogId"]!,"kind":"enroll"]
 if stage.hasPrefix("bind"){
  let e=(options["enrollments"] as! [[String:Any]]).first(where:{$0["bound"] as? Bool==false})!;input["kind"]="bindSource";input["enrollmentChoice"]=e["choice"];input["bindingMode"]="createNew"
 }
 if stage.hasPrefix("configure"){
  let e=(options["enrollments"] as! [[String:Any]]).first(where:{$0["bound"] as? Bool==true})!;input["kind"]="configure";input["enrollmentChoice"]=e["choice"];input["state"]="disconnected";input["configuration"]=["categories":["SleepSegment"],"uses":[],"assistantIds":[],"collectionPaused":true,"usePaused":true] as [String:Any];input["choicesConfirmed"]=true
 }
 if stage=="invalid-choice"{input=["catalogId":options["catalogId"]!,"kind":"bindSource","enrollmentChoice":UUID().uuidString.lowercased(),"bindingMode":"createNew"]}
 if stage=="invalid-extra"{input["readKnowledge"]="granted"}
 let review=await remote(source,"review",input)
 if stage.hasPrefix("invalid-") || stage=="missing-bundle"{check(review["state"] as? String=="unavailable" && handle.writes==0 && joinedControls==0,"invalid closed input refused before stage");finishRemote();return}
 check(review["state"] as? String=="review" && handle.writes==0 && joinedControls==0,"separate exact native review is inert: \(review)")
 if stage=="review-only"{finishRemote();return}
 if ["unconfirmed-apply","wrong-review"].contains(stage){let value=await remote(source,"apply",["reviewId":stage=="wrong-review" ? UUID().uuidString.lowercased():review["reviewId"]!,"humanConfirmed":stage != "unconfirmed-apply"]);check(value["state"] as? String=="held" && handle.writes==0 && joinedControls==0,"explicit exact review/confirmation required before stage");finishRemote();return}
 if stage=="write-before"{handle.failBefore=true};if stage=="write-after"{handle.ambiguous=true};if stage=="cancel-staged"{cancelStage=true}
 if stage=="enroll-hidden"{joinedHideControl=true}
 if stage=="nonempty-other-domains"{joinedHideControl=true}
 if ["late-control","never-control"].contains(stage){
  delayOperation="control";var reply:[String:Any]?
  source.healthApplyRemoteSetup(input:["reviewId":review["reviewId"]!,"humanConfirmed":true]){reply=$0}
  await waitUntil{delayedDelivery != nil};check(reply==nil && joinedControls==1,"entered original reply not optimistically published")
  source.withdraw();connection.withdraw();await waitUntil{reply != nil}
  check(reply?["state"] as? String=="held","withdrawn original remains unconfirmed")
  let pending=handle.data,blocked=await remote(source,"options");check(blocked["state"] as? String=="held" && handle.data==pending && joinedControls==1,"never/late original does not permit replacement or replay")
  if stage=="late-control"{delayedDelivery?();delayedDelivery=nil;try? await Task.sleep(nanoseconds:50000000);check(handle.data==pending && joinedControls==1,"late callback cannot settle initial or duplicate dispatch")}
  finishRemote();return
 }
 let value=await remote(source,"apply",["reviewId":review["reviewId"]!,"humanConfirmed":true])
 check(value["state"] as? String=="held" || stage=="write-before" && value["state"] as? String=="unavailable","initial response never settles even observed nested applied: \(value)")
 if ["write-before","write-after","cancel-staged"].contains(stage){check(joinedControls==0,"uncertain staged store/cancel forbids dispatch");if stage=="write-before"{check(handle.data==before,"failed prewrite preserves bytes")};finishRemote();return}
 check(joinedControls==1,"exactly one explicit control")
 let raw=try! JSONSerialization.jsonObject(with:handle.data!) as! [String:Any],native=raw["calendarNative"] as! [String:Any]
 let priorResult=before.flatMap{try? JSONSerialization.jsonObject(with:$0) as? [String:Any]}.flatMap{$0["calendarNative"] as? [String:Any]}?["healthControlResult"]
 check(native["pending"] != nil && (priorResult==nil ? native["healthControlResult"]==nil:stored(priorResult!)==stored(native["healthControlResult"]!)),"initial control keeps exact pending and previous result despite observed applied row")
 if stage=="nonempty-other-domains"{let old=try! JSONSerialization.jsonObject(with:before!) as! [String:Any];for key in ["enrollments","calendarEnrollments","shareAssociations"]{check(stored(old[key]!)==stored(raw[key]!),"all retained nonempty \(key) preserved")}}
 let blocked=await remote(source,"options");check(blocked["state"] as? String=="held" && joinedControls==1,"held original cannot be replaced")
 check(connection.host === originalHost && originalHost.runtime==nil && factoryCalls==0 && sdk.statusReads==0 && sdk.queries==0 && sdk.permissionEntries==0,"server setup never installed/configured SDK/OS/profile")
 finishRemote()
}
func finishRemote(){check(joinedSDKFactories==0 && joinedQueries==0,"Calendar SDK never allocated");let cp=joinedDriver.call("checkpoint");check(cp["listening"] as? Bool==false,"no actual listener");fputs("PASS native remote \(stage)\n",stderr)}
Task{@MainActor in await runRemote();exit(0)}
DispatchQueue.main.asyncAfter(deadline:.now()+75){fputs("FAIL native remote timeout\n",stderr);exit(2)}
RunLoop.main.run()
