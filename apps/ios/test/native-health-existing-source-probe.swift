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
 func read()throws->Data?{reads+=1;fileReadHook?();return data}
 func replace(_ bytes:Data)throws{if failBefore{throw CocoaError(.fileWriteUnknown)};data=bytes;writes+=1;try bytes.write(to:stateURL,options:.atomic);try bytes.write(to:stateURL.deletingLastPathComponent().appendingPathComponent(stateURL.deletingPathExtension().lastPathComponent+"-snapshot-\(stage)-\(writes).json"),options:.atomic);if let pending=((try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any])?["calendarNative"] as? [String:Any],pending["consentPending"] != nil{if cancelStage && (pending["consentPending"] as? [String:Any])?["attempted"] as? Bool==false{cancelStage=false;withdraw?()}};if ambiguous{throw CocoaError(.fileWriteUnknown)}}
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
@MainActor func runExisting()async{
 let opened=try! JSONSerialization.jsonObject(with:Data(base64Encoded:ProcessInfo.processInfo.environment["CONSENT_DRIVER_OPEN"]!)!) as! [String:Any]
 joinedIdentity=opened["syntheticIdentity"] as! [String:Any];joinedOrigin=opened["transportOrigin"] as! String
 let selected=try! JSONSerialization.jsonObject(with:Data(base64Encoded:ProcessInfo.processInfo.environment["HEALTH_SELECTED_SOURCE"]!)!) as! [String:Any]
 let transport=NativeTransport(store:Store());try! transport.configure("https://offline.invalid");let network=URLSessionConfiguration.ephemeral;network.protocolClasses=[ActualProducerNetwork.self];transport.session=URLSession(configuration:network,delegate:transport,delegateQueue:.main);transport.csrf=joinedIdentity["csrf"] as! String
 let auth=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}};guard case .success((_,let http))=auth else{check(false,"actual Auth");return};check(http.statusCode==200 && transport.effectiveIsSelf,"authenticated self")
 let context=await withCheckedContinuation{c in transport.request("/api/runtime/v1/session-context"){c.resume(returning:$0)}};guard case .success(let (contextData,_))=context else{check(false,"actual context");return};let rawContext=try! JSONSerialization.jsonObject(with:contextData) as! [String:Any]
 let connection=NativeHealthConnectionOwner(transport:transport),originalHost=connection.host,handle=JoinedHandle(),files=JoinedFiles(handle),sdk=HealthSDK()
 var factoryCalls=0,resourceCalls=0,source:NativeCalendarSourceOwner!
 let registration=NativeCalendarAppComposition.registration{resourceCalls+=1;return .init(resolveFile:{current in check(current(),"current locator");joinedFileResolves+=1;return URL(fileURLWithPath:"/synthetic/Library/Application Support/Lifestream/mobile-context.snapshot.json")},filePort:files,limits:.init(maxTotalDays:366,maxScans:8,maxSelectedCalendars:32)!,maxBytes:8388608,maxEvents:100000,mappingVersion:NativeCalendarAppComposition.mappingVersion,protectedAvailable:{joinedProtected},clock:{Date()},makeSDK:{joinedSDKFactories+=1;return NeverSDK()},deliveryContract:.selected,health:stage=="missing-resources" ? nil:.init(mappingVersion:NativeCalendarAppComposition.healthMappingVersion,makeSDK:{factoryCalls+=1;if stage=="factory-reentry"{source.withdraw();connection.withdraw()};return sdk}))}
 source=registration.bind(transport:transport,connection:connection)
 if stage=="disabled"{check(source==nil && resourceCalls==0 && files.opens==0 && factoryCalls==0,"actual disabled registration no resources/store/SDK");finishExisting();return}
 check(source != nil,"same original registration")
 withdraw={source.withdraw();connection.withdraw()};transport.healthContextWillChange={source.withdraw();connection.withdraw(authorityChanged:$0)}
 check(files.opens==0 && factoryCalls==0 && joinedSDKFactories==0 && joinedFileResolves==0,"inert standard resources registration")
 let unloaded=await setupChoices(originalHost);check(unloaded["reason"] as? String=="no_configuration","missing profile honestly unavailable")
 check(files.opens==0 && factoryCalls==0,"catalog no storage/SDK")
 let mode=stage.hasPrefix("confirm-") ? "confirmSavedLocal":"prepareNewLocal"
 var input:[String:Any]=["schemaVersion":"1.0.0","sourceNamespace":selected["sourceNamespace"]!,"enrollmentId":selected["enrollmentId"]!,"endpointId":joinedIdentity["endpointId"]!,"policyRevision":selected["revision"]!,"contextRevision":rawContext["revision"]!,"categories":selected["configuration"].flatMap{$0 as? [String:Any]}?["categories"] ?? [],"rangeStart":"2026-10-01T00:00:00.000Z","rangeEnd":"2026-10-02T00:00:00.000Z","localSetup":mode]
 if stage=="configured-calendar"{
  let human=UUID(uuidString:joinedIdentity["principalId"] as! String)!,session=UUID(uuidString:joinedIdentity["sessionId"] as! String)!,endpoint=UUID(uuidString:joinedIdentity["endpointId"] as! String)!,owner=NSObject()
  let root=NativeHealthRuntime.RootConfiguration(identity:.init(provenance:"inert-existing-calendar",origin:"https://offline.invalid",human:human,session:session,endpoint:endpoint,maxBytes:8388608,maxEvents:100000,storageOrigin:"https://offline.invalid",protectedFilePolicy:"inert-fixture-only"),protectedAvailable:{true},makeStorage:{fatalError("configured owner must not open storage")})
  let config=NativeCalendarAcquisitionOwner.Configuration(provenance:"inert-existing-calendar",origin:"https://offline.invalid",human:human,session:session,endpoint:endpoint,enrollment:UUID(),namespace:UUID(),plan:.init(category:"CalendarEvent",selectedContainerIDs:["inert-fixture-calendar"],mappingVersion:"inert-fixture/1",coverageStart:Date(timeIntervalSince1970:1793404800),coverageEnd:Date(timeIntervalSince1970:1793491200),capturedSDKDefaultTimeZone:TimeZone(secondsFromGMT:0)!),protectedAvailable:{true})
  let currency=NativeCalendarAdmissionCurrency(owner:owner,binding:.init(root:root.identity,configuration:config,selected:["CalendarEvent"],kind:.reconnectExistingLocal))
  let descriptor=NativeCalendarSavedDescriptor(selector:"inert-saved-calendar",label:"Existing Calendar",destinationLabel:"Synthetic existing destination",selection:.init(runtimeSelection:"inert-calendar-root",configuration:.init(configuration:config,custody:{_,_ in throw CocoaError(.fileReadNoPermission)},makeAcquisition:nil,captureClock:{Date()}),reconnect:.init(owner:owner,currency:currency,expectedSavedCategories:["CalendarEvent"])))
  let profile=NativeCalendarSavedProfile(root:root,descriptors:[descriptor]);check(profile != nil && connection.installCalendarConfiguration(profile!),"original existing Calendar profile")
  let configured=connection.host,refusal=await withCheckedContinuation{c in source.prepareExistingHealth(input:input){c.resume(returning:$0)}}
  check(refusal["state"] as? String=="unavailable" && connection.host === configured && configured.runtime==nil && files.opens==0 && factoryCalls==0,"configured Calendar owner refused intact without storage/SDK/retirement")
  finishExisting();return
 }
 if stage=="nonempty-other-domains"{handle.data=historicalStorage(human:UUID(uuidString:joinedIdentity["principalId"] as! String)!)}
 let before=handle.data
 if stage=="invalid-category"{input["categories"]=["hrvRMSSD"]}
 if stage=="duplicate-category"{input["categories"]=["SleepSegment","SleepSegment"]}
 if stage=="invalid-range"{input["rangeEnd"]="2026-11-02T00:00:00.000Z"}
 if stage=="noncanonical-range"{input["rangeStart"]="2026-10-01T00:00:00Z"}
 if stage=="wrong-revision"{input["policyRevision"]=99999}
 if stage=="wrong-context"{input["contextRevision"]=99999}
 if stage=="wrong-endpoint"{input["endpointId"]=UUID().uuidString.lowercased()}
 if stage=="wrong-source"{input["sourceNamespace"]=UUID().uuidString.lowercased()}
 if stage=="wrong-enrollment"{input["enrollmentId"]=UUID().uuidString.lowercased()}
 if stage=="protected-unavailable"{joinedProtected=false}
 if stage=="protected-read-loss"{fileReadHook={fileReadHook=nil;joinedProtected=false}}
 if stage=="file-reentry"{fileReadHook={fileReadHook=nil;source.withdraw();connection.withdraw()}}
 let result=await withCheckedContinuation{c in source.prepareExistingHealth(input:input){c.resume(returning:$0)}}
 let refused:Set<String>=["invalid-category","duplicate-category","invalid-range","noncanonical-range","wrong-revision","wrong-context","wrong-endpoint","wrong-source","wrong-enrollment","missing-resources","denied-policy","file-reentry","durable-pending","corrupt-file","protected-unavailable","file-unavailable","protected-read-loss"]
 if refused.contains(stage){
  check(result["state"] as? String=="unavailable" && result["readKnowledge"] as? String=="unknown","refused without invented readiness")
  check(connection.host === originalHost && originalHost.runtime==nil && factoryCalls==0 && sdk.queries==0 && sdk.permissionEntries==0 && handle.data==before,"refusal preserves original owner and bytes")
  finishExisting();return
 }
 check(result["state"] as? String=="prepared" && result["readKnowledge"] as? String=="unknown","prepared profile: \(result["reason"] ?? "none")")
 guard let originalRuntime=originalHost.runtime else{check(false,"same original runtime attached");return}
 check(connection.host === originalHost && factoryCalls==0 && sdk.statusReads==0 && sdk.queries==0 && sdk.permissionEntries==0 && handle.data==before && files.opens==1,"profile composition read-only inert same file/Host")
 let again=await withCheckedContinuation{c in source.prepareExistingHealth(input:input){c.resume(returning:$0)}};check(again["state"] as? String=="unavailable" && originalHost.runtime === originalRuntime,"configured owner refused intact")
 let catalog=await setupChoices(originalHost);check(catalog["state"] as? String=="available","actual source choices")
 let row=(catalog["choices"] as! [[String:Any]])[0],plans=row["dataChoices"] as! [[String:Any]],request:[String:Any]=["catalogId":catalog["catalogId"]!,"choice":row["choice"]!]
 check(plans.count==(input["categories"] as! [String]).count && row["localSetup"] as? String==mode,"exact selected category/local action")
 if stage=="write-before"{handle.failBefore=true};if stage=="write-after"{handle.ambiguous=true}
 let setup=await choice(originalHost,.setup,request)
 if ["write-before","write-after","factory-reentry","confirm-missing","confirm-paused","duplicate-local"].contains(stage){
  check(setup["setupOutcome"] as? String != "prepared" && sdk.permissionEntries==0 && sdk.queries==0,"no fallback/resume/rebind/SDK effects")
  if stage.hasPrefix("confirm-"){check(factoryCalls==0,"unavailable saved setup refuses before SDK factory")}
  if stage=="factory-reentry"{check(handle.data==before,"SDK reentry before enrollment writes")}
  let calls=factoryCalls;_ = await setupChoices(originalHost);check(factoryCalls==calls && files.opens==1,"unconfirmed owner not replaced")
  finishExisting();return
 }
 check(setup["setupOutcome"] as? String=="prepared" && factoryCalls==1 && sdk.queries==0 && sdk.permissionEntries==0 && sdk.statusReads==0 && originalHost.runtime === originalRuntime,"local setup no OS/status/query, same runtime")
 if stage=="nonempty-other-domains"{
  let beforeObject=try! JSONSerialization.jsonObject(with:before!) as! [String:Any],afterObject=try! JSONSerialization.jsonObject(with:handle.data!) as! [String:Any]
  for key in ["calendarEnrollments","shareAssociations"]{check(stored(beforeObject[key]!)==stored(afterObject[key]!),"retained opaque Calendar/Share values preserved")}
  let prior=healthRows(beforeObject),later=healthRows(afterObject);check(!prior.isEmpty,"nonempty original Health queue/anchor");for (key,value) in prior{check(later[key]==value,"all original Health bytes/paused state/queue/anchor preserved")}
  check(later.count==prior.count+1,"only explicit new local binding added");finishExisting();return
 }
 if stage=="pause-local"{
  let paused=await withCheckedContinuation{c in originalHost.pauseCollection(["schemaVersion":"1.0.0","operationId":UUID().uuidString.lowercased(),"sourceNamespace":selected["sourceNamespace"]!,"enrollmentId":selected["enrollmentId"]!,"endpointId":joinedIdentity["endpointId"]!]){c.resume(returning:$0)}}
  check(paused["persistence"] as? String=="savedPaused" && sdk.queries==0,"actual protective pause saved without query");finishExisting();return
 }
 if stage=="new-local" || stage=="confirm-saved"{finishExisting();return}
 if stage=="temporary-withdraw" || stage=="authority-withdraw"{
  source.withdraw();connection.withdraw(authorityChanged:stage=="authority-withdraw")
  await waitUntil{originalHost.runtime==nil};_ = await setupChoices(originalHost)
  check(connection.host === originalHost && factoryCalls==1 && files.opens==1 && sdk.queries==0,"withdraw keeps same Host/file, no auto effects")
  finishExisting();return
 }
 if stage=="permission-late"{sdk.delayPermission=true;var reply:[String:Any]?
  originalHost.performChoice(.permission,input:request){reply=$0};await waitUntil{sdk.permissionDone != nil};source.withdraw();connection.withdraw()
  let held=await setupChoices(originalHost);check(held["state"] as? String=="unavailable" && reply==nil,"entered never-callback retains owner")
  sdk.permissionDone?(.success(()));sdk.permissionDone=nil;await waitUntil{reply != nil}
  check(reply?["requestState"] as? String=="deferred" && reply?["readKnowledge"] as? String=="unknown" && sdk.queries==0 && factoryCalls==1,"actual late callback releases only deferred observation")
  finishExisting();return
 }
 let permission=await choice(originalHost,.permission,request)
 check(permission["requestState"] as? String=="completedReadNotObservable" && permission["readKnowledge"] as? String=="unknown" && sdk.permissionEntries==1 && sdk.queries==0,"permission completion never read grant or query")
 for plan in plans{
  var syncRequest=request;syncRequest["categoryChoice"]=plan["categoryChoice"]
  let sync=await choice(originalHost,.sync,syncRequest)
  check(sync["syncOutcome"] as? String=="idle" && sync["readKnowledge"] as? String=="unknown" && originalHost.runtime === originalRuntime && files.opens==1,"explicit sync via same runtime/file; empty query remains unknown")
 }
 check(sdk.queries==plans.count && Set(sdk.plans.map(\.category))==HealthKitCollector.supportedCategories && factoryCalls==1,"all five exact SDK category plans share original SDK")
 check(sdk.plans[0].start==ISO8601DateFormatter().date(from:"2026-10-01T00:00:00Z") && sdk.plans[0].end==ISO8601DateFormatter().date(from:"2026-10-02T00:00:00Z") && sdk.plans[0].mappingVersion==NativeCalendarAppComposition.healthMappingVersion,"exact bounded plan reaches original SDK port")
 finishExisting()
}
func finishExisting(){check(joinedSDKFactories==0 && joinedQueries==0,"Calendar SDK never allocated");let checkpoint=joinedDriver.call("checkpoint");check(checkpoint["listening"] as? Bool==false,"no listener");fputs("PASS native existing \(stage)\n",stderr)}
Task{@MainActor in await runExisting();exit(0)}
DispatchQueue.main.asyncAfter(deadline:.now()+75){fputs("FAIL native timeout\n",stderr);exit(2)}
RunLoop.main.run()
