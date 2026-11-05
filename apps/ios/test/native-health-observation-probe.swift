import Foundation
@testable import AssistantCore
func check(_ value:@autoclosure()->Bool,_ message:String){if !value(){fputs("FAIL: \(message)\n",stderr);exit(1)}}
final class Store:ConnectionStore{var value:SavedConnection?;func load()throws->SavedConnection?{value};func save(_ value:SavedConnection)throws{self.value=value}}
let stage=CommandLine.arguments[1],stateURL=URL(fileURLWithPath:ProcessInfo.processInfo.environment["CONSENT_SYNTHETIC_STATE"]!)
var hideOperation:String?,delayOperation:String?,delayedDelivery:(()->Void)?,cancelStage=false,withdraw:(()->Void)?
var delayPath:String?
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
  if parsed?["operation"] as? String=="control"{
   let raw=try! JSONSerialization.jsonObject(with:Data(contentsOf:stateURL)) as! [String:Any],native=raw["calendarNative"] as! [String:Any],pending=native["pending"] as! [String:Any]
   check(pending["attempted"] as? Bool==true && Data(base64Encoded:pending["original"] as! String)==stored(parsed!["payload"]!),"exact original+attempt durable before POST")
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
  if let delayed=delayPath,request.url!.path==delayed{delayPath=nil;delayedDelivery=deliver;return}
  if let delayed=delayOperation,parsed?["operation"] as? String==delayed{delayOperation=nil;delayedDelivery=deliver;return}
  deliver()
 }}
 override func stopLoading(){}
}
final class JoinedHandle:NativeCalendarFileHandle{
 init(){data=try? Data(contentsOf:stateURL)}
 var current=true,data:Data?,reads=0,writes=0,ambiguous=false,failBefore=false
 func read()throws->Data?{reads+=1;fileReadHook?();return data}
 func replace(_ bytes:Data)throws{if failBefore{throw CocoaError(.fileWriteUnknown)};data=bytes;writes+=1;try bytes.write(to:stateURL,options:.atomic);try bytes.write(to:stateURL.deletingLastPathComponent().appendingPathComponent(stateURL.deletingPathExtension().lastPathComponent+"-snapshot-\(stage)-\(writes).json"),options:.atomic);if let pending=((try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any])?["calendarNative"] as? [String:Any],pending["consentPending"] != nil{if cancelStage && (pending["consentPending"] as? [String:Any])?["attempted"] as? Bool==false{cancelStage=false;withdraw?()}};localWriteHook?();if ambiguous{throw CocoaError(.fileWriteUnknown)}}
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
var prepareHook:(()->Void)?,submitHook:(()->Void)?
var availableHook:(()->Void)?
var localWriteHook:(()->Void)?
var fileReadHook:(()->Void)?
final class Query:NativeHealthQuery{var stops=0;func stop(){stops+=1}}
var heldPage:(()->Void)?,holdNextQuery=false,seenAnchors:[String:[Data?]]=[:]
final class ObserverQuery:NativeHealthQuery{let stopped:()->Void;var done=false;init(_ stop:@escaping()->Void){stopped=stop};func stop(){if !done{done=true;stopped()}}}
final class HealthSDK:NativeHealthSDK{
 var statusReads=0,permissionEntries=0,queries=0,permissionDone:((Result<Void,Error>)->Void)?,delayPermission=false
 var queryHandles:[Query]=[]
 var plans:[NativeHealthCollectionPlan]=[]
 var observerPrepares=0,registrations=0,observerStops=0,automaticCompletions=0,observerBackground:[Bool]=[]
 var observerCallbacks:[(Error?,@escaping()->Void)->Void]=[]
 func prepareObservation(plan:NativeHealthCollectionPlan,background:Bool)->NativeHealthObservationDelegate?{
  observerPrepares+=1;observerBackground.append(background);prepareHook?()
  if stage=="unsupported"{return nil}
  return {[self] notify,registered in
   registrations+=1;observerCallbacks.append(notify);registered(true);submitHook?()
   if stage=="empty-rearm"{DispatchQueue.main.async{notify(nil){self.automaticCompletions+=1}}}
   return ObserverQuery{self.observerStops+=1}
  }
 }
 var available:Bool{statusReads+=1;availableHook?();return true}
 func prepareReadAuthorization(types:Set<String>)->NativeHealthAuthorizationDelegate?{
  check(!types.isEmpty && types.isSubset(of:HealthKitCollector.supportedCategories),"real supported types")
  return {[self] done in permissionEntries+=1;if delayPermission{permissionDone=done}else{done(.success(()))}}
 }
 func query(plan:NativeHealthCollectionPlan,anchor:Data?,completion:@escaping(Result<NativeHealthPage,Error>)->Void)throws->any NativeHealthQuery{
  queries+=1;plans.append(plan);seenAnchors[plan.category,default:[]].append(anchor)
  let observation=NativeHealthObservation(upstreamId:UUID().uuidString.lowercased(),category:plan.category,start:plan.start,end:plan.end,nativeSleep:plan.category=="sleep" ? HealthSleepValue(nativeValue:3):nil,quantity:plan.category=="sleep" ? nil:60,unit:plan.category=="sleep" ? nil:"bpm",sourceBundle:"synthetic",sourceVersion:nil,deviceName:nil,deviceModel:nil,sourceTimeZone:"UTC")
  let page=NativeHealthPage(observations:stage=="empty" || (stage=="empty-rearm" && queries>1) ? []:[observation],deleted:[],anchor:Data([UInt8(queries)]),mayHaveMore:stage=="more" && queries==1)
  let done={completion(.success(page))};if holdNextQuery{holdNextQuery=false;heldPage=done}else if stage=="synchronous"{done()}else{DispatchQueue.main.async{done()}};let q=Query();queryHandles.append(q);return q
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
@MainActor func choice(_ host:NativeHealthHost,_ kind:NativeHealthChoiceAction.Kind,_ request:[String:Any])async->[String:Any]{
 let value:[String:Any]=await withCheckedContinuation{c in host.performChoice(kind,input:request){c.resume(returning:$0)}}
 // Public completion can precede the original session's drain publication.
 // Wait on its real stored admission state; never treat completion as release.
 await waitUntil{host.runtime?.choiceAdmissionAvailable != false};return value
}

@MainActor func configured(_ source:NativeCalendarSourceOwner,_ operation:String,_ input:[String:Any]=[:])async->[String:Any]{await withCheckedContinuation{c in let done:([String:Any])->Void={c.resume(returning:$0)};switch operation{
case "begin":source.healthBeginConfiguredSettings(input:input,completion:done)
case "options":source.healthRemoteSetupOptions(input:input,completion:done)
case "review":source.healthReviewRemoteSetup(input:input,completion:done)
case "apply":source.healthApplyRemoteSetup(input:input,completion:done)
case "recover":source.healthRecoverRemoteSetup(input:input,completion:done)
case "localReview":source.healthReviewConfiguredReturn(input:input,completion:done)
case "localConfirm":source.healthConfirmConfiguredReturn(input:input,completion:done)
default:source.healthResumeConfiguredReturn(input:input,completion:done)}}}
@MainActor func edit(_ source:NativeCalendarSourceOwner,paused:Bool)async{
 let options=await configured(source,"options");check(options["state"] as? String=="options" && options["configuredConnection"] as? Bool==true,"same configured source options \(options)")
 let enrollments=options["enrollments"] as! [[String:Any]];check(enrollments.count==1,"only SAME enrollment exposed")
 let categories:[String]=stage=="zero-categories" ? [] : (stage=="use-only" || stage=="category-narrow" ? ["SleepSegment"]:["SleepSegment","heartRate"])
 let review=await configured(source,"review",["catalogId":options["catalogId"]!,"kind":"configure","enrollmentChoice":enrollments[0]["choice"]!,"state":stage=="server-disconnected" ? "disconnected":"active","configuration":["categories":categories,"uses":stage=="use-only" ? ["summaries"]:[],"assistantIds":[],"collectionPaused":paused || stage=="server-paused","usePaused":stage != "use-only"],"choicesConfirmed":true])
 check(review["state"] as? String=="review","exact edit review \(review)")
 if stage=="hidden-configure"{joinedHideControl=true}
 let applied=await configured(source,"apply",["reviewId":review["reviewId"]!,"humanConfirmed":true]);check(applied["state"] as? String=="held","initial observed stays unconfirmed")
 let recovered=await configured(source,"recover");check(recovered["state"] as? String=="recorded" && recovered["outcome"] as? String=="applied","separate actual original terminal \(recovered)")
}

@MainActor func turn()async{await withCheckedContinuation{c in DispatchQueue.main.async{c.resume()}}}
@MainActor func observe(_ host:NativeHealthHost,_ op:String,_ catalog:[String:Any],_ row:[String:Any],confirmed:Bool=true)async->[String:Any]{
 var input:[String:Any]=["operation":op,"catalogId":catalog["catalogId"]!,"choice":row["choice"]!];if op=="start"{input["humanConfirmed"]=confirmed}
 return await withCheckedContinuation{c in host.observationChoice(input){c.resume(returning:$0)}}
}
@MainActor func runObservation()async{
 let opened=try! JSONSerialization.jsonObject(with:Data(base64Encoded:ProcessInfo.processInfo.environment["CONSENT_DRIVER_OPEN"]!)!) as! [String:Any];joinedIdentity=opened["syntheticIdentity"] as! [String:Any];joinedOrigin=opened["transportOrigin"] as! String
 let selected=try! JSONSerialization.jsonObject(with:Data(base64Encoded:ProcessInfo.processInfo.environment["HEALTH_SELECTED_SOURCE"]!)!) as! [String:Any]
 let transport=NativeTransport(store:Store());try! transport.configure("https://offline.invalid");let network=URLSessionConfiguration.ephemeral;network.protocolClasses=[ActualProducerNetwork.self];transport.session=URLSession(configuration:network,delegate:transport,delegateQueue:.main);transport.csrf=joinedIdentity["csrf"] as! String
 let auth=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}};guard case .success((_,let http))=auth else{check(false,"actual Auth");return};check(http.statusCode==200 && transport.effectiveIsSelf,"actual authenticated self")
 let context=await withCheckedContinuation{c in transport.request("/api/runtime/v1/session-context"){c.resume(returning:$0)}};guard case .success(let (data,_))=context else{check(false,"actual context");return};let rawContext=try! JSONSerialization.jsonObject(with:data) as! [String:Any]
 let connection=NativeHealthConnectionOwner(transport:transport),host=connection.host,handle=JoinedHandle(),files=JoinedFiles(handle),sdk=HealthSDK();var factories=0
 let registration=NativeCalendarAppComposition.registration{.init(resolveFile:{current in check(current(),"same original locator");joinedFileResolves+=1;return URL(fileURLWithPath:"/synthetic/Library/Application Support/Lifestream/mobile-context.snapshot.json")},filePort:files,limits:.init(maxTotalDays:366,maxScans:8,maxSelectedCalendars:32)!,maxBytes:8388608,maxEvents:100000,mappingVersion:NativeCalendarAppComposition.mappingVersion,protectedAvailable:{joinedProtected},clock:{Date()},makeSDK:{joinedSDKFactories+=1;return NeverSDK()},deliveryContract:.selected,health:.init(mappingVersion:NativeCalendarAppComposition.healthMappingVersion,makeSDK:{factories+=1;return sdk}))}
 guard let source=registration.bind(transport:transport,connection:connection) else{check(stage=="disabled" && files.opens==0 && factories==0,"disabled no factories");finishObservation();return}
 transport.healthContextWillChange={source.withdraw();connection.withdraw(authorityChanged:$0)}
 let input:[String:Any]=["schemaVersion":"1.0.0","sourceNamespace":selected["sourceNamespace"]!,"enrollmentId":selected["enrollmentId"]!,"endpointId":joinedIdentity["endpointId"]!,"policyRevision":selected["revision"]!,"contextRevision":rawContext["revision"]!,"categories":stage=="category-narrow" ? ["SleepSegment","heartRate"]:["SleepSegment"],"rangeStart":"2026-10-01T00:00:00.000Z","rangeEnd":"2026-10-02T00:00:00.000Z","localSetup":"prepareNewLocal"]
 let prepared=await withCheckedContinuation{c in source.prepareExistingHealth(input:input){c.resume(returning:$0)}};check(prepared["state"] as? String=="prepared" && factories==0,"actual initial source profile inert \(prepared)")
 var catalog=await setupChoices(host);var row=(catalog["choices"] as! [[String:Any]])[0];var request:[String:Any]=["catalogId":catalog["catalogId"]!,"choice":row["choice"]!]
 if stage=="nonempty-domains"{handle.data=historicalStorage(human:UUID(uuidString:joinedIdentity["principalId"] as! String)!)}
 if stage=="no-setup"{let denied=await observe(host,"start",catalog,row);check(denied["state"] as? String=="unavailable" && factories==0 && sdk.observerPrepares==0,"unconfirmed local setup never constructs SDK/observers");finishObservation();return}
 let setup=await choice(host,.setup,request);check(setup["setupOutcome"] as? String=="prepared" && factories==1,"initial original local setup actual allowed policy \(setup)")
 guard let runtime=host.runtime else{check(false,"same original runtime");return}

 let beforeStart=handle.data!,initialWrites=handle.writes
 if stage=="inert"{connection.foregroundHealthOpportunity();await turn();check(sdk.observerPrepares==0 && sdk.queries==0 && factories==1 && handle.data==beforeStart,"cold/inactive foreground does not infer observation interest");finishObservation();return}
 let status=await observe(host,"status",catalog,row);check(status["state"] as? String=="inactive" && sdk.observerPrepares==0,"state review is SDK/HTTP inert")
 let declined=await observe(host,"start",catalog,row,confirmed:false);check(declined["state"] as? String=="unavailable" && sdk.observerPrepares==0,"separate explicit confirmation required")
 var reentryResult:Result<Void,Error>?
 if stage=="prepare-reentry"{prepareHook={prepareHook=nil;runtime.setup(.enrollExistingRemote){reentryResult=$0}}}
 if stage=="submit-withdraw"{submitHook={submitHook=nil;source.withdraw();connection.withdraw();check(!runtime.choiceAdmissionAvailable,"whole submitted SDK frame retains original Root exclusion")}}
 let started=await observe(host,"start",catalog,row);check(["waiting","deferred"].contains(started["state"] as? String ?? ""),"start acceptance is not SDK/read-grant proof \(started)")
 if stage=="unsupported"{await waitUntil{runtime.observationState=="unsupported"};check(sdk.registrations==0 && sdk.queries==0 && handle.data==beforeStart,"unsupported typed port does not create a query/store/authority");finishObservation();return}
 if stage=="submit-withdraw"{await waitUntil{sdk.observerStops==1};check(host.runtime==nil && sdk.queries==0 && factories==1,"submitted token is stopped after full reentrant withdrawal, not rebound/replaced");finishObservation();return}
 await waitUntil{runtime.observationState=="armed"}
 if stage=="prepare-reentry"{guard case .failure?=reentryResult else{check(false,"SDK preparation cannot reenter direct original setup");return};check(handle.data==beforeStart && sdk.queries==0 && factories==1,"prepare reentry does not mutate or recreate original owner");finishObservation();return}
 if stage != "empty-rearm"{check(sdk.registrations==1 && sdk.queries==0 && sdk.observerBackground==[false] && factories==1 && files.opens==1,"one original foreground-only SDK registration, no automatic query")}
 if stage=="empty-rearm"{
  await waitUntil{sdk.registrations>=2 && sdk.queries>=2 && runtime.observationState=="armed"}
  let wire=joinedRequestBytes.count;for _ in 0..<8{await turn()}
  check(sdk.registrations==2 && sdk.queries==2 && sdk.automaticCompletions==2 && joinedRequestBytes.count==wire,"empty initial callback after rearm never causes query/network self-loop")
  finishObservation();return
 }
 if stage=="manual-stop"{
  holdNextQuery=true;var manual:[String:Any]?
  let data=(row["dataChoices"] as! [[String:Any]])[0];host.performChoice(.sync,input:["catalogId":catalog["catalogId"]!,"choice":row["choice"]!,"categoryChoice":data["categoryChoice"]!]){manual=$0}
  await waitUntil{heldPage != nil};runtime.stopObservation();check(sdk.queryHandles.last!.stops==0,"Stop updates preserves separate original manual query")
  heldPage?();heldPage=nil;await waitUntil{manual != nil};check(manual?["syncOutcome"] as? String=="applied" && sdk.queries==1,"separate original manual sync remains usable and genuinely acknowledged");finishObservation();return
 }
 if stage=="policy-denied"{_ = joinedDriver.call("revokeConsent",["category":"SleepSegment"]);connection.foregroundHealthOpportunity();await waitUntil{runtime.observationState=="deferred"};var done=0;sdk.observerCallbacks[0](nil){done+=1};await waitUntil{done==1};check(sdk.queries==0 && handle.data==beforeStart && sdk.observerStops==1,"actual revoked consent cannot rearm/query or reset original state");finishObservation();return}
 if stage=="write-before"{handle.failBefore=true};if stage=="write-after"{handle.ambiguous=true}
 if stage=="protected"{joinedProtected=false}
 if stage=="auth-never"{delayPath="/api/auth/v1/user-context"}
 if stage=="network-never"{delayOperation="ingest"}
 if stage=="entry-stop"{availableHook={availableHook=nil;runtime.stopObservation()}}
 if stage=="entry-withdraw"{availableHook={availableHook=nil;source.withdraw();connection.withdraw()}}
 var completions=0,pauseReply:[String:Any]?
 let wireAtNotification=joinedRequestBytes.count
 if ["never","late","stop-never","finish-withdraw","finish-pause","duplicate","pause-never","settings-never","manual-overlap","stale-anchor","narrowed-query","commit-read-stop","commit-read-positive","commit-write-stop","independent-fence-stop"].contains(stage){holdNextQuery=true}
 sdk.observerCallbacks[0](nil){completions+=1;check(joinedRequestBytes.count==wireAtNotification,"SDK completion never waits for/enters network");if stage=="finish-withdraw"{source.withdraw();connection.withdraw()};if stage=="finish-pause"{host.pauseCollection(["schemaVersion":"1.0.0","operationId":UUID().uuidString.lowercased(),"sourceNamespace":selected["sourceNamespace"]!,"enrollmentId":selected["enrollmentId"]!,"endpointId":joinedIdentity["endpointId"]!]){pauseReply=$0}}}
 await waitUntil{completions==1}
 if stage=="entry-stop" || stage=="entry-withdraw"{for _ in 0..<5{await turn()};check(sdk.queries==0 && handle.data==beforeStart && joinedRequestBytes.count==wireAtNotification,"extensible SDK preparation Stop/withdraw cannot enter query or commit after cancellation");finishObservation();return}
 if stage=="protected"{check(sdk.queries==0 && handle.data==beforeStart,"protected gate defers notification without query/store/network");finishObservation();return}
 if stage=="empty"{for _ in 0..<10{await turn()};check(sdk.queries==1 && sdk.registrations==1 && joinedRequestBytes.count==wireAtNotification,"empty anchored result needs no network or fresh registration loop");finishObservation();return}
 if stage=="auth-never" || stage=="network-never"{await waitUntil{delayedDelivery != nil};check(handle.writes>initialWrites && sdk.queries==1 && !runtime.choiceAdmissionAvailable && completions==1,"actual local commit/SDK finish precedes NEVER Auth/network while same session/query owner remains held");finishObservation();return}
 if stage=="write-before" || stage=="write-after"{await waitUntil{runtime.observationState=="unavailable"};check(completions==1 && sdk.queries==1 && joinedRequestBytes.count==wireAtNotification && !runtime.choiceAdmissionAvailable,"uncertain local write never permits send/rearm/replacement");check(stage=="write-before" ? handle.data==beforeStart:handle.writes==initialWrites+1,"before/after-write uncertainty preserves actual original bytes without reset");finishObservation();return}
 if ["never","late","stop-never","finish-withdraw","finish-pause","duplicate","pause-never","settings-never","manual-overlap","stale-anchor","narrowed-query","commit-read-stop","commit-read-positive","commit-write-stop","independent-fence-stop"].contains(stage){
  check(sdk.queries==1 && heldPage != nil && (stage=="finish-pause" || handle.data==beforeStart && handle.writes==initialWrites) && !runtime.choiceAdmissionAvailable,"ONE actor-turn logical defer: true never-query owner held, zero false commit/network")
  if stage=="finish-pause"{await waitUntil{pauseReply != nil};check(pauseReply?["persistence"] as? String=="savedPaused" && pauseReply?["drain"] as? String=="pending","completion reentry uses original pause with true query held");let bytes=handle.data;heldPage?();heldPage=nil;for _ in 0..<10{await turn()};check(handle.data==bytes && completions==1,"pause reentry rejects late write and repeat SDK completion");finishObservation();return}
  if stage=="duplicate"{for _ in 0..<30{sdk.observerCallbacks[0](nil){completions+=1}};await waitUntil{completions==31};check(sdk.queries==1 && handle.data==beforeStart,"duplicate notification storm finishes every callback with one true query")}
  if ["commit-read-stop","commit-read-positive","commit-write-stop","independent-fence-stop"].contains(stage){
   let before=handle.data!,writes=handle.writes,queries=sdk.queries,network=joinedRequestBytes.count;var stop:[String:Any]?,hook=0
   // Same actual private Root reached ONLY by the fake test port; no new
   // product issuer/store/gate API or copied admission condition.
   let originalRoot=Mirror(reflecting:runtime).children.first(where:{$0.label=="root"})!.value as! NativeSharedOutboxOwner
   var independentGeneration:UInt64?
   let originalStop={
    hook+=1
    host.observationChoice(["operation":"stop","catalogId":catalog["catalogId"]!,"choice":row["choice"]!]){stop=$0}
   }
   if stage=="commit-read-stop"{fileReadHook={fileReadHook=nil;originalStop()}}
   if stage=="commit-write-stop"{localWriteHook={localWriteHook=nil;originalStop()}}
   if stage=="independent-fence-stop"{fileReadHook={fileReadHook=nil;originalRoot.fenceHealth();independentGeneration=originalRoot.healthGeneration;originalStop()}}
   heldPage?();heldPage=nil
   if stage=="commit-read-positive"{
    await waitUntil{sdk.registrations>=2 && runtime.observationState=="armed"};check(handle.writes>writes && sdk.queries==queries && joinedRequestBytes.count>network && completions==1,"same current commit-read fixture without Stop genuinely commits/ACKs/rearms once");finishObservation();return
   }
   await waitUntil{hook==1 && stop != nil && runtime.observationState=="inactive" && runtime.choiceAdmissionAvailable}
   check(completions==1 && sdk.queries==queries && sdk.registrations==1 && sdk.observerStops==1 && joinedRequestBytes.count==network && factories==1 && files.opens==1,"Stop during actual commit storage frame finishes once without send/rearm/replacement")
   if stage=="independent-fence-stop"{
    check(handle.data==before && handle.writes==writes && !originalRoot.healthIOCurrent && originalRoot.healthGeneration==independentGeneration,"Stop owns NO reopening right for an already-closed independent original Health fence after true query drain")
    var manual:Result<HealthSyncCoordinator.Completion,Error>?;runtime.sync(category:"sleep"){manual=$0};guard case .failure?=manual else{check(false,"independent original gate must still refuse manual collection");return};check(sdk.queries==queries && joinedRequestBytes.count==network,"independent fence cannot be bypassed by a drained Stop");finishObservation();return
   }
   if stage=="commit-read-stop"{check(handle.data==before && handle.writes==writes,"Stop INSIDE commit read must prevent queue write and anchor advance")}
   else{check(handle.data != before && handle.writes==writes+1,"Stop after already-invoked successful replace preserves known durable write and anchor")}
   finishObservation();return
  }
  if stage=="manual-overlap"{
   var result:Result<HealthSyncCoordinator.Completion,Error>?;runtime.sync(category:"sleep"){result=$0};guard case .failure?=result else{check(false,"direct manual sync cannot overlap observer query");return};check(sdk.queries==1 && handle.data==beforeStart,"manual overlap does not enter SDK/store/network");finishObservation();return
  }
  if stage=="settings-never"{let retiring=await configured(source,"begin",["humanConfirmed":true]);check(retiring["state"] as? String=="retiring" && !connection.configuredHealthSettingsControl && runtime.configuration != nil && factories==1,"settings retirement retains true never query and consumed original owner, no ready/profile replacement");finishObservation();return}
  if stage=="pause-never"{let reply:[String:Any]=await withCheckedContinuation{c in host.pauseCollection(["schemaVersion":"1.0.0","operationId":UUID().uuidString.lowercased(),"sourceNamespace":selected["sourceNamespace"]!,"enrollmentId":selected["enrollmentId"]!,"endpointId":joinedIdentity["endpointId"]!]){c.resume(returning:$0)}};check(reply["persistence"] as? String=="savedPaused" && reply["drain"] as? String=="pending" && completions==1 && !runtime.choiceAdmissionAvailable,"original saved pause cannot fake never-query drain or repeat SDK completion");finishObservation();return}
  if stage=="stale-anchor" || stage=="narrowed-query"{
   var raw=try! JSONSerialization.jsonObject(with:handle.data!) as! [String:Any];var rows=raw["enrollments"] as! [Any];var value=rows[1] as! [String:Any]
   if stage=="stale-anchor"{value["anchors"]=["sleep\u{0}"+runtime.configuration!.plans[0].anchorScope:Data([9]).base64EncodedString()]}else{value["enabledTypes"]=[]}
   rows[1]=value;raw["enrollments"]=rows;handle.data=stored(raw);try! handle.data!.write(to:stateURL);let changed=handle.data!
   heldPage?();heldPage=nil;for _ in 0..<10{await turn()};check(handle.data==changed && sdk.queries==1 && completions==1,"negative lowest-file CAS/type change rejects late commit without rewriting actual fixture");finishObservation();return
  }
  if stage=="never" || stage=="duplicate"{finishObservation();return}
  if stage=="stop-never"{let stopped=await observe(host,"stop",catalog,row);check(stopped["state"] as? String=="stopping" && sdk.observerStops==1 && !runtime.choiceAdmissionAvailable && handle.data==beforeStart,"Stop never manufactures query drain or local durability");finishObservation();return}
  heldPage?();heldPage=nil
  if stage=="finish-withdraw"{await turn();await turn();check(handle.data==beforeStart && sdk.queries==1 && completions==1,"completion reentry withdrawal rejects late write and send");finishObservation();return}
 }
 if stage=="more"{
  await waitUntil{sdk.registrations>=2 && runtime.observationState=="deferred"};for _ in 0..<8{await turn()};check(sdk.queries==1,"mayHaveMore does not create an unbounded self-loop")
  connection.foregroundHealthOpportunity();await waitUntil{sdk.queries==2 && runtime.observationState=="armed"};check(seenAnchors["sleep"]!.contains(where:{$0==Data([1])}),"next original opportunity resumes exact persisted anchor");finishObservation();return
 }
 await waitUntil{sdk.registrations>=2 && runtime.observationState=="armed"}
 check(completions==1 && sdk.queries==1 && factories==1 && files.opens==1,"late/normal actual local commit, original delivery-only+refresh rearm has NO second collection/SDK/store")
 let values=healthRows(try! JSONSerialization.jsonObject(with:handle.data!) as! [String:Any]);let key=UUID(uuidString:selected["enrollmentId"] as! String)!.uuidString;let saved=try! JSONSerialization.jsonObject(with:values[key]!) as! [String:Any];check((saved["queue"] as! [Any]).isEmpty && !(saved["anchors"] as! [String:Any]).isEmpty,"actual original receipt acknowledges durable original queue; original anchor retained")
 if stage=="nonempty-domains"{
  let before=try! JSONSerialization.jsonObject(with:beforeStart) as! [String:Any],after=try! JSONSerialization.jsonObject(with:handle.data!) as! [String:Any]
  let rows=healthRows(before);check(rows.count==2 && rows.filter{$0.key != key}==values.filter{$0.key != key},"unrelated historical Health row exact")
  for name in ["calendarEnrollments","shareAssociations"]{check(stored(before[name]!)==stored(after[name]!),"unrelated nonempty Calendar/Share bytes unchanged")}
 }
 if stage=="foreground"{let count=sdk.queries;connection.foregroundHealthOpportunity();await waitUntil{sdk.queries>count};check(sdk.plans.allSatisfy{$0.start==runtime.configuration!.plans[0].start && $0.end==runtime.configuration!.plans[0].end},"foreground never moves or widens selected dates")}
 if stage=="background"{source.withdraw();connection.withdraw();await turn();connection.foregroundHealthOpportunity();await turn();check(host.runtime==nil && factories==1 && sdk.queries==1,"full withdrawal has no observer recovery/Root/SDK recreation")}
 finishObservation()
}
func finishObservation(){check(joinedSDKFactories==0,"Calendar SDK untouched");check(joinedDriver.call("checkpoint")["listening"] as? Bool==false,"actual disposable producer is non-listening");fputs("PASS observation \(stage)\n",stderr)}
Task{@MainActor in await runObservation();exit(0)}
DispatchQueue.main.asyncAfter(deadline:.now()+90){fputs("FAIL observation timeout\n",stderr);exit(2)}
RunLoop.main.run()
