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
var localWriteHook:(()->Void)?
var fileReadHook:(()->Void)?
final class Query:NativeHealthQuery{var stops=0;func stop(){stops+=1}}
var heldPage:(()->Void)?,holdNextQuery=false,seenAnchors:[String:[Data?]]=[:]
final class HealthSDK:NativeHealthSDK{
 var statusReads=0,permissionEntries=0,queries=0,permissionDone:((Result<Void,Error>)->Void)?,delayPermission=false
 var plans:[NativeHealthCollectionPlan]=[]
 var available:Bool{statusReads+=1;return true}
 func prepareReadAuthorization(types:Set<String>)->NativeHealthAuthorizationDelegate?{
  check(!types.isEmpty && types.isSubset(of:HealthKitCollector.supportedCategories),"real supported types")
  return {[self] done in permissionEntries+=1;if delayPermission{permissionDone=done}else{done(.success(()))}}
 }
 func query(plan:NativeHealthCollectionPlan,anchor:Data?,completion:@escaping(Result<NativeHealthPage,Error>)->Void)throws->any NativeHealthQuery{
  queries+=1;plans.append(plan);seenAnchors[plan.category,default:[]].append(anchor)
  let observation=NativeHealthObservation(upstreamId:UUID().uuidString.lowercased(),category:plan.category,start:plan.start,end:plan.end,nativeSleep:plan.category=="sleep" ? HealthSleepValue(nativeValue:3):nil,quantity:plan.category=="sleep" ? nil:60,unit:plan.category=="sleep" ? nil:"bpm",sourceBundle:"synthetic",sourceVersion:nil,deviceName:nil,deviceModel:nil,sourceTimeZone:"UTC")
  let page=NativeHealthPage(observations:[observation],deleted:[],anchor:Data([UInt8(queries)]),mayHaveMore:false)
  let done={completion(.success(page))};if holdNextQuery{holdNextQuery=false;heldPage=done}else{DispatchQueue.main.async{done()}};return Query()
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
@MainActor func runConfigured()async{
 let opened=try! JSONSerialization.jsonObject(with:Data(base64Encoded:ProcessInfo.processInfo.environment["CONSENT_DRIVER_OPEN"]!)!) as! [String:Any];joinedIdentity=opened["syntheticIdentity"] as! [String:Any];joinedOrigin=opened["transportOrigin"] as! String
 let selected=try! JSONSerialization.jsonObject(with:Data(base64Encoded:ProcessInfo.processInfo.environment["HEALTH_SELECTED_SOURCE"]!)!) as! [String:Any]
 let transport=NativeTransport(store:Store());try! transport.configure("https://offline.invalid");let network=URLSessionConfiguration.ephemeral;network.protocolClasses=[ActualProducerNetwork.self];transport.session=URLSession(configuration:network,delegate:transport,delegateQueue:.main);transport.csrf=joinedIdentity["csrf"] as! String
 let auth=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}};guard case .success((_,let http))=auth else{check(false,"actual Auth");return};check(http.statusCode==200 && transport.effectiveIsSelf,"actual authenticated self")
 let context=await withCheckedContinuation{c in transport.request("/api/runtime/v1/session-context"){c.resume(returning:$0)}};guard case .success(let (data,_))=context else{check(false,"actual context");return};let rawContext=try! JSONSerialization.jsonObject(with:data) as! [String:Any]
 let connection=NativeHealthConnectionOwner(transport:transport),host=connection.host,handle=JoinedHandle(),files=JoinedFiles(handle),sdk=HealthSDK();var factories=0
 let registration=NativeCalendarAppComposition.registration{.init(resolveFile:{current in check(current(),"same original locator");joinedFileResolves+=1;return URL(fileURLWithPath:"/synthetic/Library/Application Support/Lifestream/mobile-context.snapshot.json")},filePort:files,limits:.init(maxTotalDays:366,maxScans:8,maxSelectedCalendars:32)!,maxBytes:8388608,maxEvents:100000,mappingVersion:NativeCalendarAppComposition.mappingVersion,protectedAvailable:{joinedProtected},clock:{Date()},makeSDK:{joinedSDKFactories+=1;return NeverSDK()},deliveryContract:.selected,health:.init(mappingVersion:NativeCalendarAppComposition.healthMappingVersion,makeSDK:{factories+=1;return sdk}))}
 guard let source=registration.bind(transport:transport,connection:connection) else{check(stage=="disabled" && files.opens==0 && factories==0,"disabled no factories");finishConfigured();return}
 transport.healthContextWillChange={source.withdraw();connection.withdraw(authorityChanged:$0)}
 let input:[String:Any]=["schemaVersion":"1.0.0","sourceNamespace":selected["sourceNamespace"]!,"enrollmentId":selected["enrollmentId"]!,"endpointId":joinedIdentity["endpointId"]!,"policyRevision":selected["revision"]!,"contextRevision":rawContext["revision"]!,"categories":stage=="category-narrow" ? ["SleepSegment","heartRate"]:["SleepSegment"],"rangeStart":"2026-10-01T00:00:00.000Z","rangeEnd":"2026-10-02T00:00:00.000Z","localSetup":"prepareNewLocal"]
 if stage=="configured-calendar"{
  let human=UUID(uuidString:joinedIdentity["principalId"] as! String)!,session=UUID(uuidString:joinedIdentity["sessionId"] as! String)!,endpoint=UUID(uuidString:joinedIdentity["endpointId"] as! String)!,owner=NSObject()
  let root=NativeHealthRuntime.RootConfiguration(identity:.init(provenance:"inert-existing-calendar",origin:"https://offline.invalid",human:human,session:session,endpoint:endpoint,maxBytes:8388608,maxEvents:100000,storageOrigin:"https://offline.invalid",protectedFilePolicy:"inert-fixture-only"),protectedAvailable:{true},makeStorage:{fatalError("configured owner must not open storage")})
  let config=NativeCalendarAcquisitionOwner.Configuration(provenance:"inert-existing-calendar",origin:"https://offline.invalid",human:human,session:session,endpoint:endpoint,enrollment:UUID(),namespace:UUID(),plan:.init(category:"CalendarEvent",selectedContainerIDs:["inert-fixture-calendar"],mappingVersion:"inert-fixture/1",coverageStart:Date(timeIntervalSince1970:1793404800),coverageEnd:Date(timeIntervalSince1970:1793491200),capturedSDKDefaultTimeZone:TimeZone(secondsFromGMT:0)!),protectedAvailable:{true})
  let currency=NativeCalendarAdmissionCurrency(owner:owner,binding:.init(root:root.identity,configuration:config,selected:["CalendarEvent"],kind:.reconnectExistingLocal))
  let descriptor=NativeCalendarSavedDescriptor(selector:"inert-saved-calendar",label:"Existing Calendar",destinationLabel:"Synthetic existing destination",selection:.init(runtimeSelection:"inert-calendar-root",configuration:.init(configuration:config,custody:{_,_ in throw CocoaError(.fileReadNoPermission)},makeAcquisition:nil,captureClock:{Date()}),reconnect:.init(owner:owner,currency:currency,expectedSavedCategories:["CalendarEvent"])))
  let profile=NativeCalendarSavedProfile(root:root,descriptors:[descriptor]);check(profile != nil && connection.installCalendarConfiguration(profile!),"original existing Calendar profile")
  let configured=connection.host,refusal=await withCheckedContinuation{c in source.healthBeginConfiguredSettings(input:["humanConfirmed":true]){c.resume(returning:$0)}}
  check(refusal["state"] as? String=="unavailable" && connection.host === configured && configured.runtime==nil && files.opens==0 && factories==0,"configured Calendar owner refused intact without storage/SDK/retirement")
  finishConfigured();return
 }
 let prepared=await withCheckedContinuation{c in source.prepareExistingHealth(input:input){c.resume(returning:$0)}};check(prepared["state"] as? String=="prepared" && factories==0,"actual initial source profile inert \(prepared)")
 var catalog=await setupChoices(host);var row=(catalog["choices"] as! [[String:Any]])[0];var request:[String:Any]=["catalogId":catalog["catalogId"]!,"choice":row["choice"]!]
 if stage=="nonempty-domains"{handle.data=historicalStorage(human:UUID(uuidString:joinedIdentity["principalId"] as! String)!)}
 let setup=await choice(host,.setup,request);check(setup["setupOutcome"] as? String=="prepared" && factories==1,"initial original local setup actual allowed policy \(setup)")
 guard let runtime=host.runtime else{check(false,"same original runtime");return}
 let initialRevision=selected["revision"] as! Int
 let plans=row["dataChoices"] as! [[String:Any]];request["categoryChoice"]=plans.first(where:{$0["label"] as? String=="Sleep"})!["categoryChoice"]!
 let sync=await choice(host,.sync,request);check(sync["syncOutcome"] as? String=="applied" && sdk.queries==1,"initial manual fake sample durable and genuinely ingested \(sync)")
 if stage != "permission-late" && stage != "permission-never"{hideOperation="ingest"}
 let queued=await choice(host,.sync,request)
 if stage=="permission-late" || stage=="permission-never"{check(queued["syncOutcome"] as? String=="applied","entered permission starts with original valid policy/tickets; failed sync deliberately invalidates them")}
 else{check(["retry","needsAttention","invalidReceipt"].contains(queued["syncOutcome"] as? String ?? ""),"hidden completed ingest keeps original queued body \(queued)")}
 let originalRaw=try! JSONSerialization.jsonObject(with:handle.data!) as! [String:Any]
 let originalRow=healthRows(originalRaw);check(sdk.queries==2,"two initial fake queries")
 if stage=="local-pause"{let pause=await withCheckedContinuation{c in host.pauseCollection(["schemaVersion":"1.0.0","operationId":UUID().uuidString.lowercased(),"sourceNamespace":selected["sourceNamespace"]!,"enrollmentId":selected["enrollmentId"]!,"endpointId":joinedIdentity["endpointId"]!]){c.resume(returning:$0)}};check(pause["persistence"] as? String=="savedPaused","explicit original saved pause")}
 if stage=="active-drain" || stage=="never-query"{holdNextQuery=true;host.performChoice(.sync,input:request){_ in};await waitUntil{heldPage != nil}}
 if stage=="protected-entry"{joinedProtected=false;let denied=await configured(source,"begin",["humanConfirmed":true]);check(denied["state"] as? String=="unavailable" && runtime.configuration != nil && factories==1,"unavailable protected preflight leaves original profile/owner intact");joinedProtected=true}
 if stage=="permission-late" || stage=="permission-never"{sdk.delayPermission=true;let permissionRequest:[String:Any]=["catalogId":catalog["catalogId"]!,"choice":row["choice"]!];host.performChoice(.permission,input:permissionRequest){_ in};await waitUntil{sdk.permissionDone != nil}}
 let beforeQueries=sdk.queries,beforeStatus=sdk.statusReads,started=await configured(source,"begin",["humanConfirmed":true]);check(started["state"] as? String=="retiring" || started["state"] as? String=="settings","explicit generation retirement \(started)")
 if stage=="never-query" || stage=="permission-never"{try? await Task.sleep(nanoseconds:50000000);let held=await configured(source,"options");check(held["state"] as? String=="held" && connection.host === host && host.runtime === runtime && runtime.configuration != nil && factories==1,"entered never query retains exact old owner/configuration and blocks settings");finishConfigured();return}
 if stage=="permission-late"{check(!connection.configuredHealthSettingsControl && runtime.configuration != nil,"entered permission cannot synthetically drain");sdk.permissionDone?(.success(()));sdk.permissionDone=nil}
 if stage=="active-drain"{check(!connection.configuredHealthSettingsControl && runtime.configuration != nil,"query stop is not callback drain");heldPage?();heldPage=nil}
 await waitUntil{connection.configuredHealthSettingsControl}
 if stage=="close-retained"{let closed=await configured(source,"options",["close":true]);check(closed["state"] as? String=="held" && connection.configuredHealthSettingsControl && runtime.configuration==nil,"close cannot claim original configured owner released before explicit local return")}
 check(connection.host === host && host.runtime === runtime && runtime.configuration==nil && factories==1 && files.opens==1 && joinedFileResolves==1 && sdk.queries==beforeQueries,"same Host/Runtime/Root/file/SDK, no implicit query or second factory")
 let stale=await choice(host,.sync,request);check(stale["syncOutcome"] is NSNull && sdk.queries==beforeQueries,"old consumed profile/catalog/currency cannot be reused")
 await edit(source,paused:stage=="two-remote-edits")
 if !["use-only","category-narrow","server-paused","server-disconnected","zero-categories"].contains(stage){_ = joinedDriver.call("prepareConsent",["category":"heartRate","withhold":stage=="withheld"])}
 let localCategories:[String]=(stage=="use-only" || stage=="category-narrow") ? ["SleepSegment"]:["SleepSegment","heartRate"]
 let localInput:[String:Any]=["categories":localCategories,"rangeStart":"2026-10-01T00:00:00.000Z","rangeEnd":"2026-10-02T00:00:00.000Z"]
 if stage=="two-remote-edits"{let deferred=await configured(source,"localReview",localInput);check(deferred["state"] as? String=="localDeferred","paused save remains local deferred");await edit(source,paused:false)}
 if stage=="local-policy-hidden"{hideOperation="policy"}
 let review=await configured(source,"localReview",localInput)
 if ["server-paused","server-disconnected","zero-categories","local-policy-hidden"].contains(stage){check(review["state"] as? String=="localDeferred" && runtime.configuration==nil && sdk.queries==beforeQueries,"unavailable collection scope never returns local collection");finishConfigured();return}
 if stage=="withheld"{check(review["state"] as? String=="localDeferred" && review["remoteSaved"] as? Bool==true && runtime.configuration==nil,"actual withheld approval keeps known remote save and no local grant");finishConfigured();return}
 check(review["state"] as? String=="localReview","fresh authentic policy local review \(review)")
 let beforeLocal=handle.data!,beforeWrites=handle.writes
 if stage=="unconfirmed-local"{let denied=await configured(source,"localConfirm",["reviewId":review["reviewId"]!,"humanConfirmed":false]);check(denied["state"] as? String=="localDeferred" && handle.data==beforeLocal,"declined native confirmation is no local authority/write");finishConfigured();return}
 if stage=="wrong-local-review"{let denied=await configured(source,"localConfirm",["reviewId":UUID().uuidString.lowercased(),"humanConfirmed":true]);check(denied["state"] as? String=="localDeferred" && handle.data==beforeLocal,"wrong opaque local review held unchanged");finishConfigured();return}
 if stage=="revoked-before-local-confirm"{_ = joinedDriver.call("revokeConsent",["category":"heartRate"])}
 if stage=="context-change"{source.withdraw();connection.withdraw()}
 if ["local-revision-changed","local-pause-changed","local-types-changed","local-rebind-changed","local-source-changed"].contains(stage){var raw=try! JSONSerialization.jsonObject(with:handle.data!) as! [String:Any];var rows=raw["enrollments"] as! [Any];let id=UUID(uuidString:selected["enrollmentId"] as! String)!.uuidString;let index=stride(from:0,to:rows.count,by:2).first{rows[$0] as? String==id}!;var value=rows[index+1] as! [String:Any];if stage=="local-revision-changed"{value["policyRevision"]=999};if stage=="local-pause-changed"{value["paused"]=true};if stage=="local-types-changed"{value["enabledTypes"]=[]};if stage=="local-rebind-changed"{value["requiresRebind"]=true};if stage=="local-source-changed"{value["sourceNamespace"]=UUID().uuidString.lowercased()};rows[index+1]=value;raw["enrollments"]=rows;handle.data=stored(raw);try! handle.data!.write(to:stateURL)}
 if stage=="local-write-before"{handle.failBefore=true};if stage=="local-write-after"{handle.ambiguous=true}
 var reentries=0
 if stage=="local-write-reentry"{localWriteHook={localWriteHook=nil;source.healthRemoteSetupOptions(input:[:]){value in check(value["state"] as? String=="held","entered local storage frame blocks server settings");reentries+=1};source.healthConfirmConfiguredReturn(input:["reviewId":review["reviewId"]!,"humanConfirmed":true]){value in check(value["state"] as? String=="localDeferred","same consumed local review cannot reenter");reentries+=1}}}
 if stage=="local-write-withdraw"{localWriteHook={localWriteHook=nil;source.withdraw();connection.withdraw()}}
 let expectedBeforeConfirm=handle.data!
 let local=await configured(source,"localConfirm",["reviewId":review["reviewId"]!,"humanConfirmed":true])
 if ["revoked-before-local-confirm","context-change","local-revision-changed","local-pause-changed","local-types-changed","local-rebind-changed","local-source-changed","local-write-before","local-write-after","local-write-withdraw"].contains(stage){
  check(local["state"] as? String != "localPrepared" && local["state"] as? String != "localPaused","negative local path never fabricates readiness")
  check(factories==1 && sdk.queries==beforeQueries && sdk.statusReads==beforeStatus,"negative local control no new SDK/query/status")
  if ["local-write-after","local-write-withdraw"].contains(stage){let values=healthRows(try! JSONSerialization.jsonObject(with:handle.data!) as! [String:Any]);let key=UUID(uuidString:selected["enrollmentId"] as! String)!.uuidString;let value=try! JSONSerialization.jsonObject(with:values[key]!) as! [String:Any];check(value["policyRevision"] as? Int==initialRevision+1 && handle.writes==beforeWrites+1,"known/ambiguous entered local write retained; never reset")}
  else{check(handle.data==expectedBeforeConfirm && handle.writes==beforeWrites,"refused local adoption leaves original actual negative fixture unchanged")}
  if stage=="revoked-before-local-confirm"{check(local["remoteSaved"] as? Bool==true,"actual revoked current grant does not erase known saved server settings")}
  finishConfigured();return
 }
 if stage=="local-write-reentry"{check(reentries==2 && handle.writes==beforeWrites+1,"one local write follows complete original reentry frames")}
 check(local["state"] as? String==(stage=="local-pause" ? "localPaused":"localPrepared"),"explicit typed same-source return \(local)")
 check(connection.host === host && host.runtime === runtime && runtime.configuration != nil && factories==1 && files.opens==1 && sdk.queries==beforeQueries && sdk.permissionEntries==(stage=="permission-late" ? 1:0) && sdk.statusReads==beforeStatus,"return reuses originalSDK/Root/store, no permission/status/query effects")
 let after=healthRows(try! JSONSerialization.jsonObject(with:handle.data!) as! [String:Any]);let key=UUID(uuidString:selected["enrollmentId"] as! String)!.uuidString
 let old=try! JSONSerialization.jsonObject(with:originalRow[key]!) as! [String:Any],new=try! JSONSerialization.jsonObject(with:after[key]!) as! [String:Any]
 check(stored(old["anchors"]!)==stored(new["anchors"]!) && stored(old["queue"]!)==stored(new["queue"]!),"EXACT original anchors and queued bodies/eventIDs/revisions survive local adoption")
 check(new["policyRevision"] as? Int==initialRevision+(stage=="two-remote-edits" ? 2:1) && Set(new["enabledTypes"] as! [String])==Set(localCategories.map{$0=="SleepSegment" ? "sleep":$0}),"separate localL/remoteR rails adopt actual latest revision/categories")
 if stage=="nonempty-domains"{
  let afterRaw=try! JSONSerialization.jsonObject(with:handle.data!) as! [String:Any]
  check(originalRow.count>1 && originalRow.filter{$0.key != key}==after.filter{$0.key != key},"unrelated historical Health rows exact unchanged")
  for field in ["calendarEnrollments","shareAssociations"]{check(originalRaw[field] != nil && stored(originalRaw[field]!)==stored(afterRaw[field]!),"nonempty original \(field) exact unchanged")}
 }
 if stage=="local-pause"{check(new["paused"] as? Bool==true,"receipt did not unpause original local pause");let resumed=await configured(source,"resume",["humanConfirmed":true]);check(resumed["state"] as? String=="localPrepared","separate explicit ORIGINAL resume \(resumed)")}
 catalog=await setupChoices(host);row=(catalog["choices"] as! [[String:Any]])[0];check(row["localSetup"] as? String=="configuredLocalConfirmed","existing local controls recognise explicit settings confirmation")
 for plan in row["dataChoices"] as! [[String:Any]]{let value=await choice(host,.sync,["catalogId":catalog["catalogId"]!,"choice":row["choice"]!,"categoryChoice":plan["categoryChoice"]!]);check(value["syncOutcome"] as? String=="applied","separate explicit post-edit manual sync \(value)")}
 check(factories==1 && files.opens==1 && seenAnchors["sleep"]!.contains(where:{$0==Data([2])}),"original predicate anchor reaches same SDK after edit")
 finishConfigured()
}
func finishConfigured(){check(joinedSDKFactories==0,"Calendar SDK untouched");let checkpoint=joinedDriver.call("checkpoint");check(checkpoint["listening"] as? Bool==false,"non-listening actual backend");fputs("PASS configured \(stage)\n",stderr)}
Task{@MainActor in await runConfigured();exit(0)}
DispatchQueue.main.asyncAfter(deadline:.now()+90){fputs("FAIL configured timeout\n",stderr);exit(2)}
RunLoop.main.run()
