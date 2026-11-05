import Foundation
import CryptoKit
@testable import AssistantCore
func check(_ value:@autoclosure()->Bool,_ message:String){if !value(){fputs("FAIL: \(message)\n",stderr);exit(1)}}
final class Store:ConnectionStore{var value:SavedConnection?,loads=0;var loadHook:(()->Void)?;func load()throws->SavedConnection?{loads+=1;loadHook?();return value};func save(_ value:SavedConnection)throws{self.value=value}}
let stage=CommandLine.arguments[1],stateURL=URL(fileURLWithPath:ProcessInfo.processInfo.environment["CONSENT_SYNTHETIC_STATE"]!)
var savedReceipt:(()->[String:Any])?
var failureDiagnostic:(()->Void)?
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
var joinedSnapshotSerial=0
var joinedPaths:[String]=[]
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
  joinedPaths.append(request.url!.path)
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
final class JoinedHandle:NativeCalendarFileHandle,HealthSnapshotStorage{
 init(){data=try? Data(contentsOf:stateURL)}
 var current=true,data:Data?,reads=0,writes=0,ambiguous=false,failBefore=false
 func read()throws->Data?{reads+=1;fileReadHook?();return data}
 func replace(_ bytes:Data)throws{if failBefore{throw CocoaError(.fileWriteUnknown)};data=bytes;writes+=1;joinedSnapshotSerial+=1;try bytes.write(to:stateURL,options:.atomic);try bytes.write(to:stateURL.deletingLastPathComponent().appendingPathComponent(stateURL.deletingPathExtension().lastPathComponent+"-snapshot-\(stage)-\(joinedSnapshotSerial).json"),options:.atomic);if let pending=((try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any])?["calendarNative"] as? [String:Any],pending["consentPending"] != nil{if cancelStage && (pending["consentPending"] as? [String:Any])?["attempted"] as? Bool==false{cancelStage=false;withdraw?()}};localWriteHook?();if ambiguous{throw CocoaError(.fileWriteUnknown)}}
 func close(){current=false;fileCloseHook?()}
}
final class JoinedFiles:NativeCalendarFilePort{
 var handles:[JoinedHandle]=[],opens=0
 init(_ handle:JoinedHandle){handles=[handle]}
 func openExclusive(snapshot:URL)throws->any NativeCalendarFileHandle{
  check(!handles.prefix(opens).contains(where:{$0.current}),"exclusive original file slot")
  if opens==handles.count{handles.append(JoinedHandle())};let value=handles[opens];opens+=1;return value
 }
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
var fileCloseHook:(()->Void)?
final class Query:NativeHealthQuery{var stops=0;func stop(){stops+=1}}
var heldPage:(()->Void)?,holdNextQuery=false,seenAnchors:[String:[Data?]]=[:]
final class ObserverQuery:NativeHealthQuery{let stopped:()->Void;var done=false;init(_ stop:@escaping()->Void){stopped=stop};func stop(){if !done{done=true;stopped()}}}
final class HealthSDK:NativeHealthSDK{
 var activeBackgroundTypes=Set<String>()
 var controls:[(String,Bool)]=[],heldControls:[(Bool,(NativeHealthBackgroundResult)->Void)]=[]
 var holdEnable=false,holdDisable=false,failEnable=false,failDisable=false,errorEnable=false,errorDisable=false,duplicateControl=false
 var backgroundHook:((Bool)->Void)?,backgroundPrepareHook:((Bool)->Void)?
 func prepareBackgroundDelivery(category:String,enabled:Bool)->NativeHealthBackgroundDelegate?{
  backgroundPrepareHook?(enabled);check(HealthKitCollector.supportedCategories.contains(category),"background exact mapped category")
  return {[self] done in
   controls.append((category,enabled));backgroundHook?(enabled)
   let publish:(NativeHealthBackgroundResult)->Void={result in
    if result.success && result.error==nil{if enabled{self.activeBackgroundTypes.insert(category)}else{self.activeBackgroundTypes.remove(category)}}
    done(result)
   }
   if (enabled && holdEnable) || (!enabled && holdDisable){heldControls.append((enabled,publish));return}
   let result=NativeHealthBackgroundResult(success:!(enabled ? failEnable:failDisable),error:(enabled ? errorEnable:errorDisable) ? CocoaError(.featureUnsupported):nil)
   publish(result);if duplicateControl{publish(result)}
  }
 }
 func releaseControl(success:Bool=true){check(!heldControls.isEmpty,"entered original control exists");let entry=heldControls.removeFirst();entry.1(.init(success:success,error:nil))}
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
  let observation=NativeHealthObservation(upstreamId:stage=="BG23" ? "00000000-0000-4000-8000-000000000023":UUID().uuidString.lowercased(),category:plan.category,start:plan.start,end:plan.end,nativeSleep:plan.category=="sleep" ? HealthSleepValue(nativeValue:3):nil,quantity:plan.category=="sleep" ? nil:60,unit:plan.category=="sleep" ? nil:"bpm",sourceBundle:"synthetic",sourceVersion:nil,deviceName:nil,deviceModel:nil,sourceTimeZone:"UTC")
  let page=NativeHealthPage(observations:stage=="empty" || (stage=="empty-rearm" && queries>1) ? []:[observation],deleted:[],anchor:Data([UInt8(queries)]),mayHaveMore:(stage=="more" && queries==1) || stage.hasPrefix("BG21"))
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
@MainActor func waitUntil(_ predicate:()->Bool)async{for _ in 0..<300{if predicate(){return};try? await Task.sleep(nanoseconds:10000000)};failureDiagnostic?();check(false,"callback reached expected stage")}
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

@MainActor func turn()async{await withCheckedContinuation{c in DispatchQueue.main.async{c.resume()}}}
@MainActor func remembered(_ host:NativeHealthHost,_ operation:String,_ catalog:[String:Any],_ row:[String:Any],enabled:Bool=true)async->[String:Any]{
 var input:[String:Any]=["operation":operation,"catalogId":catalog["catalogId"]!,"choice":row["choice"]!]
 if operation=="remember"{input["humanConfirmed"]=true;input["updatesEnabled"]=enabled}
 return await withCheckedContinuation{c in host.savedHealthChoice(input){c.resume(returning:$0)}}
}
@MainActor func recoveryDone(_ source:NativeCalendarSourceOwner)async->[String:Any]{
 await waitUntil{source.savedHealthRecoveryStatus()["state"] as? String != "pending"};return source.savedHealthRecoveryStatus()
}

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

@MainActor func runBackground()async{
 let opened=try! JSONSerialization.jsonObject(with:Data(base64Encoded:ProcessInfo.processInfo.environment["CONSENT_DRIVER_OPEN"]!)!) as! [String:Any];joinedIdentity=opened["syntheticIdentity"] as! [String:Any];joinedOrigin=opened["transportOrigin"] as! String
 let selected=try! JSONSerialization.jsonObject(with:Data(base64Encoded:ProcessInfo.processInfo.environment["HEALTH_SELECTED_SOURCE"]!)!) as! [String:Any]
 let store=Store(),transport=NativeTransport(store:store),handle=JoinedHandle(),files=JoinedFiles(handle),sdk=HealthSDK();var factories=0,typedAuth=0,cleanupPreparedWrites=0,cleanupPreparedRows=0;var cleanupBefore:Data?
 let registration=NativeCalendarAppComposition.registration{.init(resolveFile:{current in check(current(),"original native locator current");joinedFileResolves+=1;return URL(fileURLWithPath:"/synthetic/Library/Application Support/Lifestream/mobile-context.snapshot.json")},filePort:files,limits:.init(maxTotalDays:366,maxScans:8,maxSelectedCalendars:32)!,maxBytes:8388608,maxEvents:100000,mappingVersion:NativeCalendarAppComposition.mappingVersion,protectedAvailable:{joinedProtected},clock:{Date()},makeSDK:{joinedSDKFactories+=1;return NeverSDK()},deliveryContract:.selected,health:.init(mappingVersion:NativeCalendarAppComposition.healthMappingVersion,makeSDK:{factories+=1;return sdk}))}
 func receipt(){let value:[String:Any]=["stage":stage,"lowestRelayProducerPinFrames":joinedWireEvidence.count,"lowestRelayResponseBodies":joinedResponseBytes.count,"requestCount":joinedPaths.count,"typedAuthNotifications":typedAuth,"fileOpens":files.opens,"SDKFactories":factories,"SDKStatusReads":sdk.statusReads,"permissionEntries":sdk.permissionEntries,"queryEntries":sdk.queries,"observerRegistrations":sdk.registrations,"backgroundEffects":sdk.controls.map{["category":$0.0,"enabled":$0.1]},"heldControlCallbacks":sdk.heldControls.count,"originalConnectionStoreLoads":store.loads,"fakeSDKAndFilePortsOnly":true,"historicalLocalMetadataCohortOnly":stage.hasPrefix("BG14-multiple"),"historicalPreparedRows":cleanupPreparedRows,"historicalPreparedSnapshotWrites":cleanupPreparedWrites,"nativeSnapshotWritesAfterPreparation":handle.writes-cleanupPreparedWrites,"noRawAuthBodiesOrCredentialsRetained":true,"noInstalledOrPhysicalDeviceAcceptance":true];try! stored(value).write(to:stateURL.deletingLastPathComponent().appendingPathComponent(stage+"-native-receipt.json"),options:.atomic)}
 func finish(){receipt();check(joinedSDKFactories==0 && sdk.permissionEntries==0,"no Calendar/mic or OS permission request");check(joinedDriver.call("checkpoint")["listening"] as? Bool==false,"non-listening actual producer");fputs("PASS background health \(stage)\n",stderr)}
 if stage=="BG31"{
  check(registration.applicationOwners(makeTransport:{check(false,"disabled native factory");return transport})==nil,"disabled same application owners absent");registration.startApplication(foreground:false,background:true,makeTransport:{check(false,"disabled launch factory");return transport});for _ in 0..<12{await turn()};check(store.loads==0 && files.opens==0 && factories==0 && joinedPaths.isEmpty,"disabled native composition inert");finish();return
 }
 let cold=stage=="BG27-after-cleanup" || stage.hasPrefix("BG14-multiple") || ["BG01","BG02","BG06","BG07","BG14","BG16"].contains(stage)
 if cold{
  let pair=(joinedIdentity["cookie"] as! String).split(separator:"=",maxSplits:1).map(String.init)
  store.value=SavedConnection(endpoint:"https://offline.invalid",username:"synthetic",cookies:[SavedCookie(name:pair[0],value:pair[1])])
 }else{try! transport.configure("https://offline.invalid")}
 // NativeTransport.restoreConnection resets its URLSession BEFORE loading the
 // original ConnectionStore. This lowest fake store hook reinstalls ONLY the
 // synthetic HTTP port on that new session; store bytes and original restore,
 // Auth parsing, requests and producer replies are unchanged. No global swizzle.
 store.loadHook={
  let config=URLSessionConfiguration.ephemeral;config.protocolClasses=[ActualProducerNetwork.self]
  transport.session.invalidateAndCancel();transport.session=URLSession(configuration:config,delegate:transport,delegateQueue:.main)
 }
 let network=URLSessionConfiguration.ephemeral;network.protocolClasses=[ActualProducerNetwork.self];transport.session=URLSession(configuration:network,delegate:transport,delegateQueue:.main);transport.csrf=joinedIdentity["csrf"] as! String
 // HISTORICAL Core unit-fixture preparation only, BEFORE Native startup.
 // These old rows are NOT current producer enrollments/policy or Native grants.
 // The subsequent Native Auth/restore remain unchanged actual handler requests.
 let excludedHistoricalTypes=Set(["hrvSDNN","respiratoryRate"])
 if stage.hasPrefix("BG14-multiple") || stage=="BG27-after-cleanup"{
  let human=UUID(uuidString:joinedIdentity["principalId"] as! String)!,endpoint=UUID(uuidString:joinedIdentity["endpointId"] as! String)!
  let keepsActualEnabled=stage=="BG14-multiple-active" || stage=="BG27-after-cleanup"
  if !keepsActualEnabled{handle.data=historicalStorage(human:human)}
  do{
   let fixture=HealthOutbox(storage:handle);try fixture.setHuman(human)
   for (index,category) in ["sleep","heartRate","heartRate"].enumerated(){
    let id=UUID(uuidString:String(format:"00000000-0000-4000-8000-%012d",index+1))!,namespace=UUID(uuidString:String(format:"00000000-0000-4000-8000-%012d",index+101))!,wireCategory=category=="sleep" ? "SleepSegment":category
    // Same explicit Core test-fixture proof shape used in Core tests, never
    // fed to Native policy/Auth or asserted to be a current producer witness.
    let unit:[String:Any]=["schemaVersion":"1.0.0","producerPin":["schemaId":MobileHealthEncoder.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthEncoder.schemaSHA256],"result":["enrollment":["enrollmentId":id.uuidString.lowercased(),"principalId":human.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":namespace.uuidString.lowercased(),"revision":1,"state":"active","configuration":["categories":[wireCategory],"uses":[],"assistantIds":[],"collectionPaused":false,"usePaused":true]],"effective":["policyRevision":1,"sourceBound":true,"collectionAllowed":true,"categories":[wireCategory],"uses":[],"assistantIds":[],"sourceNamespace":namespace.uuidString.lowercased()]]]
    let proof=try MobileHealthPolicyParser.parse(stored(unit),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:id)
    try fixture.enroll(proof:proof,selectedTypes:[category]);let ticket=try fixture.ticket(enrollment:id,type:category)
    try fixture.commit(scope:"historical-cleanup-anchor/1:"+id.uuidString,expectedAnchor:nil,nextAnchor:Data([7]),changes:[HealthChange(upstreamId:"synthetic-retained-"+id.uuidString,operation:.upsert,body:Data("synthetic existing queue".utf8),expectedPolicyRevision:1,mappingVersion:"lifestream-healthkit/1")],ticket:ticket)
    let plan=try HealthOutbox.SavedHealthPlan(category:category,scope:"historical-cleanup/1:"+id.uuidString,mappingVersion:"lifestream-healthkit/1",start:Date(timeIntervalSince1970:1790812800),end:Date(timeIntervalSince1970:1790899200))
    let value=try HealthOutbox.SavedHealthSelection(origin:"https://offline.invalid",human:human,endpoint:endpoint,enrollment:id,namespace:namespace,policyRevision:1,plans:[plan],updatesEnabled:false)
    try fixture.saveHealthSelection(value,expected:nil,proof:proof);_ = try fixture.setHealthBackgroundChoice(expected:value,enabled:false)
   }
   // Strictly typed excluded historical metadata: one foreign Human and one
   // same-Human rebind scope. They carry no current policy/collection grant.
   var raw=try JSONSerialization.jsonObject(with:handle.data!) as! [String:Any],rows=try JSONDecoder().decode([UUID:HealthOutbox.SavedHealthSelection].self,from:stored(raw["healthSelections"]!))
   for (index,category) in ["hrvSDNN","respiratoryRate"].enumerated(){
    let id=UUID(uuidString:String(format:"00000000-0000-4000-8000-%012d",index+4))!,namespace=UUID(uuidString:String(format:"00000000-0000-4000-8000-%012d",index+104))!,owner=index==0 ? UUID(uuidString:"00000000-0000-4000-8000-000000000099")!:human
    let plan=try HealthOutbox.SavedHealthPlan(category:category,scope:"excluded-historical/1:"+category,mappingVersion:"lifestream-healthkit/1",start:Date(timeIntervalSince1970:1790812800),end:Date(timeIntervalSince1970:1790899200))
    rows[id]=try .init(origin:"https://offline.invalid",human:owner,endpoint:endpoint,enrollment:id,namespace:namespace,policyRevision:1,plans:[plan],updatesEnabled:false,requiresRebind:index==1,backgroundChoice:.init(enabled:false))
   }
   raw["healthSelections"]=try JSONSerialization.jsonObject(with:JSONEncoder().encode(rows));try handle.replace(stored(raw))
   let decoded=try HealthOutbox(storage:handle).savedHealthSelections(origin:"https://offline.invalid",human:human,endpoint:endpoint)
   check(rows.count==(keepsActualEnabled ? 6:5) && decoded.count==(keepsActualEnabled ? 5:4) && decoded.filter{!$0.requiresRebind}.count==(keepsActualEnabled ? 4:3) && decoded.filter{$0.updatesEnabled || $0.backgroundChoice?.enabled==true}.count==(keepsActualEnabled ? 1:0),"strictly decoded historical Core cohort, not current producer policy")
   sdk.activeBackgroundTypes=excludedHistoricalTypes.union(["heartRate"]) // First sleep harmless; later own type needs disable.
   cleanupPreparedRows=rows.count;cleanupPreparedWrites=handle.writes;cleanupBefore=handle.data;try handle.data!.write(to:stateURL.deletingLastPathComponent().appendingPathComponent("cohort-before-native.json"))
  }catch{check(false,"historical Core fixture preparation failed \(error)")}
  sdk.holdDisable=stage=="BG14-multiple-late" || stage=="BG14-multiple-never";sdk.failDisable=stage=="BG14-multiple-false"
 }
 guard let owners=registration.applicationOwners(makeTransport:{transport}) else{check(false,"single original native application composition");return}
 let connection=owners.connection,source=owners.source
 let notify=transport.healthContextTransition;transport.healthContextTransition={event in typedAuth+=1;notify?(event)}
 check(files.opens==0 && factories==0 && sdk.statusReads==0 && joinedPaths.isEmpty,"application composition constructor inert")
 failureDiagnostic={fputs("STATE stage=\(stage) source=\(source.savedHealthRecoveryStatus()["state"] ?? "nil") obs=\(connection.host.runtime?.observationState ?? "nil") BG=\(connection.host.runtime?.backgroundRegistrationState ?? "nil") pref=\(connection.host.runtime?.backgroundPreferenceState ?? "nil") queries=\(sdk.queries) effects=\(sdk.controls) opens=\(files.opens) paths=\(joinedPaths)\n",stderr)}
 func statusChoice()->String{let rows=source.savedHealthRecoveryStatus()["choices"] as! [[String:Any]];return rows[0]["choice"] as! String}
 func action(_ operation:String,_ extra:[String:Any]=[:])async->[String:Any]{await withCheckedContinuation{c in source.healthBackgroundChoice(["operation":operation,"choice":statusChoice()].merging(extra){_,b in b}){c.resume(returning:$0)}}}
 func settled()async{await waitUntil{let state=connection.host.runtime?.observationState;return (state=="armed" || (stage.hasPrefix("BG21") && state=="deferred")) && connection.host.runtime?.choiceAdmissionAvailable==true};for _ in 0..<5{await turn()}}
 func finite()async{await settled();let q=sdk.queries,e=sdk.controls.count,w=joinedPaths.count;for _ in 0..<12{await turn()};check(sdk.queries==q && sdk.controls.count==e && joinedPaths.count==w,"finite original external opportunity, no timer/recursive effects: query \(q)->\(sdk.queries), control \(e)->\(sdk.controls.count), HTTP \(w)->\(joinedPaths.count)")}
 if cold{
  if stage=="BG16" || stage=="BG14"{registration.startApplication(foreground:false,background:true)}
  else{registration.startApplication(foreground:stage=="BG02",background:stage != "BG02")}
  if stage=="BG07"{
   var replies=0;registration.restoreApplicationConnection{_ in replies+=1;registration.restoreApplicationConnection{_ in replies+=1}};registration.restoreApplicationConnection{_ in replies+=1};await waitUntil{replies==3}
  }
  if stage=="BG01"{await waitUntil{source.savedHealthRecoveryStatus()["state"] as? String=="absent"};check(factories==0 && sdk.statusReads==0 && sdk.controls.isEmpty && sdk.queries==0,"absent native startup no SDK/status/query/effects");finish();return}
  if stage=="BG27-after-cleanup"{
   await waitUntil{source.savedHealthRecoveryStatus()["state"] as? String=="backgroundCleanupOnly"}
   guard let runtime=Mirror(reflecting:source).children.first(where:{$0.label=="controlRuntime"})?.value as? NativeHealthRuntime else{check(false,"same original cleanup Runtime");return}
   await waitUntil{runtime.backgroundRetirementReady};check(sdk.controls.count==2 && sdk.queries==0 && sdk.statusReads==0 && handle.data==cleanupBefore,"complete cold cleanup before foreground restore")
   source.setSavedHealthForeground(true)
   await waitUntil{source.savedHealthRecoveryStatus()["state"] as? String=="restoredEnabled" && runtime.observationState=="armed" && runtime.choiceAdmissionAvailable}
   let rows=source.savedHealthRecoveryStatus()["choices"] as! [[String:Any]],token=rows.first{$0["updatesEnabled"] as? Bool==true && $0["requiresRebind"] as? Bool==false}!["choice"] as! String
   let reviewed=await withCheckedContinuation{c in source.healthBackgroundChoice(["operation":"review","choice":token]){c.resume(returning:$0)}}
   check(reviewed["state"] as? String=="reviewed","genuine foreground saved choice fresh review after cleanup")
   _ = await withCheckedContinuation{c in source.healthBackgroundChoice(["operation":"enable","choice":token,"review":reviewed["review"]!,"humanConfirmed":true]){c.resume(returning:$0)}}
   await waitUntil{sdk.controls.contains{$0.0=="sleep" && $0.1} && runtime.observationState=="armed" && runtime.choiceAdmissionAvailable}
   for _ in 0..<12{await turn()}
   check(runtime.backgroundRegistrationState=="registered","current scope after cleanup reports registered: \(runtime.backgroundRegistrationState), \(sdk.controls)")
   check(factories==1 && files.opens==1 && connection.host.runtime === runtime,"same original SDK/Root/file across cleanup-to-foreground graph")
   finish();return
  }
  if stage=="BG14-multiple-active"{
   await waitUntil{source.savedHealthRecoveryStatus()["state"] as? String=="policyOrLocalStateUnavailable"}
   check(factories==0 && sdk.controls.isEmpty && sdk.queries==0 && sdk.statusReads==0 && joinedSelected==0 && files.opens==1,"actual enabled choice denied by current producer is not blindly disabled by historical off scopes")
   check(handle.data==cleanupBefore,"active-scope denial preserves historical and actual saved bytes")
   finish();return
  }
  if stage.hasPrefix("BG14-multiple"){
   await waitUntil{source.savedHealthRecoveryStatus()["state"] as? String=="backgroundCleanupOnly"}
   guard let runtime=Mirror(reflecting:source).children.first(where:{$0.label=="controlRuntime"})?.value as? NativeHealthRuntime else{check(false,"original cleanup Runtime");return}
   if sdk.holdDisable{
    await waitUntil{sdk.heldControls.count==1};for _ in 0..<12{await turn()};check(!runtime.backgroundRetirementReady && factories==1 && files.opens==1,"pending original multi-scope callback holds same physical owner")
    if stage=="BG14-multiple-never"{source.nativeHealthOpportunity(foreground:false,background:true);for _ in 0..<12{await turn()};check(sdk.controls.count==1 && factories==1 && files.opens==1 && !runtime.backgroundRetirementReady,"never callback cannot be guessed drained or replaced");check(handle.data==cleanupBefore,"never callback preserves full original snapshot");finish();return}
    sdk.holdDisable=false;sdk.releaseControl()
   }
   if stage=="BG14-multiple-false"{await waitUntil{sdk.controls.count==2};check(!runtime.backgroundRetirementReady && runtime.backgroundRegistrationState=="unknown","false cleanup result remains held/unknown")}
   else{await waitUntil{runtime.backgroundRetirementReady};check(Set(sdk.controls.map{$0.0})==Set(["sleep","heartRate"]) && sdk.activeBackgroundTypes==excludedHistoricalTypes,"all retained tagged-off scopes covered, not repeatedly first only")}
   for _ in 0..<12{await turn()}
   check(sdk.controls.count==2 && sdk.controls.allSatisfy{!$0.1} && sdk.queries==0 && sdk.statusReads==0 && joinedSelected==0 && factories==1 && files.opens==1,"multi-scope cleanup is finite per-type only on original SDK/file")
   let before=try! JSONSerialization.jsonObject(with:cleanupBefore!) as! [String:Any],after=try! JSONSerialization.jsonObject(with:handle.data!) as! [String:Any]
   check(stored(before["enrollments"]!)==stored(after["enrollments"]!) && stored(before["healthSelections"]!)==stored(after["healthSelections"]!) && stored(before["calendarEnrollments"]!)==stored(after["calendarEnrollments"]!) && stored(before["shareAssociations"]!)==stored(after["shareAssociations"]!),"all retained source domains/queues/anchors/tags byte-equivalent");check(handle.data==cleanupBefore,"disable-only native cleanup makes zero snapshot writes")
   finish();return
  }
  if stage=="BG14"{await waitUntil{source.savedHealthRecoveryStatus()["state"] as? String=="backgroundCleanupOnly"};await waitUntil{sdk.controls.count==1};for _ in 0..<12{await turn()};check(sdk.controls[0].1==false && sdk.queries==0 && sdk.statusReads==0 && factories==1,"tagged-off cold cleanup disables only, no read/status/query");finish();return}
  if stage=="BG16"{await waitUntil{source.savedHealthRecoveryStatus()["state"] as? String=="policyOrLocalStateUnavailable"};check(factories==0 && sdk.queries==0 && sdk.controls.isEmpty,"fresh actual denied consent cold background creates no SDK");finish();return}
  await waitUntil{source.savedHealthRecoveryStatus()["state"] as? String=="restoredEnabled"};await settled()
  let again=registration.applicationOwners(makeTransport:{check(false,"UI creates second transport");return transport})!;check(again.transport === transport && again.connection === connection && again.source === source,"later UI attaches exact original transport/connection/source")
  if stage=="BG02"{check(sdk.controls.isEmpty,"untagged legacy foreground choice not background permission");source.nativeHealthOpportunity(foreground:false,background:true);for _ in 0..<12{await turn()};check(sdk.controls.isEmpty,"legacy background entry no OS registration");finish();return}
  await waitUntil{connection.host.runtime?.backgroundRegistrationState=="registered"};check(factories==1 && files.opens==1,"cold original exclusive owner once");if stage=="BG07"{check(store.loads==1 && joinedPaths.filter{$0=="/api/auth/v1/session"}.count==1,"same original entered native/UI restores coalesce, no credential cache/reset")};await finite();finish();return
 }
 let auth=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}};guard case .success((_,let http))=auth else{check(false,"actual Auth");return};check(http.statusCode==200 && transport.effectiveIsSelf,"actual authenticated self")
 let context=await withCheckedContinuation{c in transport.request("/api/runtime/v1/session-context"){c.resume(returning:$0)}};guard case .success(let(data,_))=context else{check(false,"actual personal context");return};let rawContext=try! JSONSerialization.jsonObject(with:data) as! [String:Any]
 let input:[String:Any]=["schemaVersion":"1.0.0","sourceNamespace":selected["sourceNamespace"]!,"enrollmentId":selected["enrollmentId"]!,"endpointId":joinedIdentity["endpointId"]!,"policyRevision":selected["revision"]!,"contextRevision":rawContext["revision"]!,"categories":stage=="BG21-multicategory" ? ["SleepSegment","heartRate"]:["SleepSegment"],"rangeStart":"2026-10-01T00:00:00.000Z","rangeEnd":"2026-10-02T00:00:00.000Z","localSetup":"prepareNewLocal"]
 let prepared=await withCheckedContinuation{c in source.prepareExistingHealth(input:input){c.resume(returning:$0)}};check(prepared["state"] as? String=="prepared" && factories==0,"original prepared profile inert")
 let host=connection.host,catalog=await setupChoices(host),row=(catalog["choices"] as! [[String:Any]])[0]
 let setup=await choice(host,.setup,["catalogId":catalog["catalogId"]!,"choice":row["choice"]!]);check(setup["setupOutcome"] as? String=="prepared","original local setup")
 let saved=await remembered(host,"remember",catalog,row);check(saved["persistence"] as? String=="savedEnabled","original foreground remember saved")
 source.setSavedHealthForeground(true);await waitUntil{!(source.savedHealthRecoveryStatus()["choices"] as! [[String:Any]]).isEmpty};await settled()
 guard let runtime=host.runtime else{check(false,"original Runtime exists");return}
 let initialQueries=sdk.queries
 if stage=="seed-foreground"{check(sdk.controls.isEmpty && runtime.savedHealthSelection?.backgroundChoice==nil,"legacy seed untagged");finish();return}
 let review=await action("review");check(review["state"] as? String=="reviewed" && review["readKnowledge"] as? String=="unknown","closed exact background review")
 let enableInput:[String:Any]=["review":review["review"]!,"humanConfirmed":true]
 if stage=="BG04"{let bad=await action("enable",["review":UUID().uuidString.lowercased(),"humanConfirmed":true]);check(bad["state"] as? String=="review_required" && sdk.controls.isEmpty,"stale review before SDK");finish();return}
 if stage=="BG10" || stage=="BG11" || stage=="BG20" || stage=="BG25"{sdk.holdEnable=true}
 if stage=="BG09"{sdk.duplicateControl=true}
 if stage=="BG09-enable-false"{sdk.failEnable=true}
 if stage=="BG09-enable-error"{sdk.errorEnable=true}
 if stage=="BG09-prepare"{sdk.backgroundPrepareHook={enabled in guard enabled else{return};sdk.backgroundPrepareHook=nil;source.healthBackgroundChoice(["operation":"off","choice":statusChoice()]){_ in}}}
 if stage=="BG09-reentrant"{sdk.backgroundHook={enabled in guard enabled else{return};sdk.backgroundHook=nil;source.healthBackgroundChoice(["operation":"off","choice":statusChoice()]){_ in}}}
 if stage=="BG24-read"{fileReadHook={fileReadHook=nil;source.healthBackgroundChoice(["operation":"off","choice":statusChoice()]){_ in}}}
 if stage=="BG24-write"{localWriteHook={localWriteHook=nil;source.healthBackgroundChoice(["operation":"off","choice":statusChoice()]){_ in}}}
 _ = await action("enable",enableInput)
 if stage.hasPrefix("BG24-") && ["BG24-read","BG24-write"].contains(stage){await waitUntil{runtime.backgroundPreferenceState=="disabled"};check(sdk.controls.allSatisfy{!$0.1},"Stop in original preference frame prevents SDK enable");finish();return}
 if ["BG09-prepare","BG09-reentrant"].contains(stage){
  await waitUntil{runtime.backgroundPreferenceState=="disabled" && runtime.backgroundRegistrationState=="disabled"}
  check(sdk.controls.filter{$0.1}.count==(stage=="BG09-prepare" ? 0:1),"actual prepare/entered submission Stop ordering");for _ in 0..<12{await turn()};check(runtime.savedHealthSelection?.backgroundChoice?.enabled==false,"nested SDK callbacks do not revive preference");finish();return
 }
 if ["BG09-enable-false","BG09-enable-error"].contains(stage){
  await waitUntil{runtime.backgroundRegistrationState=="unknown"};check(runtime.backgroundPreferenceState=="enabled" && runtime.backgroundWorkHeld,"saved enable is not a successful OS effect");await finite();finish();return
 }
 if sdk.holdEnable{
  await waitUntil{sdk.heldControls.count==1 && runtime.backgroundPreferenceState=="enabled"};let before=sdk.queries
  if stage=="BG20"{
   await settled();await waitUntil{runtime.choiceAdmissionAvailable};sdk.holdDisable=true;holdNextQuery=true;let dataChoice=(row["dataChoices"] as! [[String:Any]])[0];var manual:[String:Any]?
   host.performChoice(.sync,input:["catalogId":catalog["catalogId"]!,"choice":row["choice"]!,"categoryChoice":dataChoice["categoryChoice"]!]){manual=$0}
   await waitUntil{heldPage != nil};_ = await action("off");await waitUntil{runtime.backgroundPreferenceState=="disabled"}
   heldPage?();heldPage=nil;await waitUntil{manual != nil && runtime.choiceAdmissionAvailable}
   check(manual?["syncOutcome"] as? String=="applied","independent manual query/ACK not held by NEVER background control \(manual ?? [:])");check(sdk.heldControls.count==1 && !runtime.backgroundRetirementReady,"full owner still held independently");finish();return
  }
  _ = await action("off");await waitUntil{runtime.backgroundPreferenceState=="disabled"};check(!runtime.backgroundMayContinue && !runtime.backgroundRetirementReady,"saved off does not fabricate original control drain")
  source.nativeHealthOpportunity(foreground:false,background:true);for _ in 0..<12{await turn()};check(factories==1 && files.opens==1 && sdk.queries==before,"pending original enable prevents background read/replacement")
  if stage=="BG11"{sdk.holdEnable=false;sdk.releaseControl();await waitUntil{sdk.controls.contains{!$0.1}};for _ in 0..<12{await turn()};check(sdk.controls.filter{$0.1}.count==1 && sdk.controls.filter{!$0.1}.count==1,"late enable serialized original disable, no revive")}
  else{check(files.handles[0].current,"never callback keeps original physical custody")}
  finish();return
 }
 await waitUntil{runtime.backgroundRegistrationState=="registered"};await settled()
 if stage=="seed-background"{finish();return}
 if stage=="seed-background-off"{_ = await action("off");await waitUntil{runtime.backgroundPreferenceState=="disabled" && runtime.backgroundRegistrationState=="disabled"};finish();return}
 switch stage{
 case "BG03","BG05","BG08","BG09","BG15","BG21","BG21-multicategory","BG23","BG34":
  check(runtime.savedHealthSelection?.backgroundChoice?.enabled==true && sdk.permissionEntries==0 && sdk.observerBackground.allSatisfy{!$0},"explicit scope, no permission prompt/unowned legacy effect")
  let before=sdk.queries;source.nativeHealthOpportunity(foreground:false,background:true);await waitUntil{sdk.queries>before};await finite();if stage=="BG21-multicategory"{check(sdk.queries==before+2 && Set(sdk.plans.suffix(2).map(\.category))==Set(["sleep","heartRate"]),"one finite page per exact selected category per opportunity")};check(sdk.plans.allSatisfy{$0.start.timeIntervalSince1970==1790812800 && $0.end.timeIntervalSince1970==1790899200},"exact dates never roll")
  if stage=="BG08"{let q=sdk.queries;source.nativeHealthInactive();sdk.observerCallbacks.last?(nil){};for _ in 0..<12{await turn()};check(sdk.queries==q,"inactive notifications no query");source.nativeHealthOpportunity(foreground:false,background:true);await finite()}
  if stage=="BG23"{let q=sdk.queries;sdk.observerCallbacks.last?(nil){};await waitUntil{sdk.queries>q};await finite();check(joinedDriver.call("checkpoint")["records"] as? Int==1,"same actual upstream replay does not duplicate producer record")}
 case "BG12","BG12-error","BG12-never":
  sdk.failDisable=stage=="BG12";sdk.errorDisable=stage=="BG12-error";sdk.holdDisable=stage=="BG12-never";_ = await action("off");await waitUntil{sdk.controls.last?.1==false};for _ in 0..<12{await turn()};check(!runtime.backgroundRetirementReady && runtime.backgroundPreferenceState=="disabled","false/error/never OS disable independent from saved preference")
 case "BG12-duplicate","BG12-reentrant","BG12-late":
  let priorDisables=sdk.controls.filter{!$0.1}.count
  sdk.duplicateControl=stage=="BG12-duplicate";sdk.holdDisable=stage=="BG12-late"
  if stage=="BG12-reentrant"{sdk.backgroundHook={enabled in guard !enabled else{return};sdk.backgroundHook=nil;source.healthBackgroundChoice(["operation":"off","choice":statusChoice()]){_ in}}}
  _ = await action("off")
  if stage=="BG12-late"{await waitUntil{sdk.heldControls.count==1 && runtime.backgroundPreferenceState=="disabled"};for _ in 0..<12{await turn()};check(!runtime.backgroundRetirementReady,"late disable retains real callback hold");sdk.holdDisable=false;sdk.releaseControl()}
  await waitUntil{runtime.backgroundPreferenceState=="disabled" && runtime.backgroundRetirementReady}
  for _ in 0..<12{await turn()};check(sdk.controls.filter{!$0.1}.count==priorDisables+1 && runtime.backgroundRegistrationState=="disabled","nested/double/late disable owns one exact original effect: prior \(priorDisables), actual \(sdk.controls)")
 case "BG13":
  let flagOnlyChoice=statusChoice();_ = await action("off");await waitUntil{runtime.backgroundRegistrationState=="disabled"};check(runtime.savedHealthSelection?.updatesEnabled==true,"background off retains foreground choice");check(statusChoice()==flagOnlyChoice,"flag-only saved update preserves opaque choice identity");let dataChoice=(row["dataChoices"] as! [[String:Any]])[0];let synced=await choice(host,.sync,["catalogId":catalog["catalogId"]!,"choice":row["choice"]!,"categoryChoice":dataChoice["categoryChoice"]!]);check(synced["syncOutcome"] as? String=="applied","background off retains actual manual sync")
 case "BG17":
  let replacement=joinedDriver.call("authSwitch");joinedIdentity=replacement["identity"] as! [String:Any];_ = await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}};await waitUntil{runtime.savedHealthSelection?.requiresRebind==true};check(runtime.savedHealthSelection?.backgroundChoice?.enabled==false,"actual typed Human change disables prior background choice");check(!runtime.backgroundMayContinue,"new Human cannot inherit background")
 case "BG18":
  joinedProtected=false;source.nativeHealthOpportunity(foreground:false,background:false);let q=sdk.queries;for _ in 0..<12{await turn()};check(sdk.queries==q && factories==1 && files.opens==1,"protected unavailable no new SDK/file/query");joinedProtected=true;source.nativeHealthOpportunity(foreground:false,background:true);await waitUntil{source.savedHealthRecoveryStatus()["state"] as? String=="restoredEnabled"};await finite();check(factories==1 && sdk.permissionEntries==0,"unlock hands same original SDK after true retire, no prompt")
 case "BG19":
  source.nativeHealthOpportunity(foreground:false,background:false);for _ in 0..<8{await turn()};source.nativeHealthOpportunity(foreground:false,background:true);await waitUntil{source.savedHealthRecoveryStatus()["state"] as? String=="restoredEnabled"};await finite();check(factories==1 && files.opens==2,"full withdrawal never un-revokes Root, same SDK sequential handback")
 case "BG22":
  holdNextQuery=true;var completed=0;sdk.observerCallbacks.last?(nil){completed+=1};await waitUntil{heldPage != nil && completed==1};for _ in 0..<12{await turn()};check(completed==1,"Health notification completes once without awaiting never query/network");runtime.stopObservation();check(!runtime.backgroundRetirementReady,"actual query still held before real callback");heldPage?();heldPage=nil
 case "BG24-before","BG24-after":
  let disk=files.handles.last!;disk.failBefore=stage=="BG24-before";disk.ambiguous=stage=="BG24-after";_ = await action("off");await waitUntil{runtime.backgroundPreferenceState=="unconfirmed"};check(!runtime.backgroundMayContinue && !runtime.backgroundRetirementReady && disk.current,"ambiguous preference held original, no reset")
 case "BG26":
  let root=Mirror(reflecting:runtime).children.first{$0.label=="root"}!.value as! NativeSharedOutboxOwner,storage=Mirror(reflecting:source).children.first{$0.label=="storage"}!.value as! NativeProtectedCalendarStorage,collector=Mirror(reflecting:runtime).children.first{$0.label=="collector"}!.value as! HealthKitCollector
  var lease:NativeSharedOutboxOwner.CalendarLease?
  root.acquireCalendar(custody:{value,binding in try storage.acquire(storage:value,binding:binding)},drain:{collector.whenDrained($0)}){if case .success(let value)=$0{lease=value}}
  await waitUntil{lease != nil};let before=sdk.queries;sdk.observerCallbacks.last?(nil){};for _ in 0..<12{await turn()};check(sdk.queries==before && files.opens==1 && factories==1,"same original Calendar custody fences Health, no new owner");lease?.release();await finite()
 case "BG16-pause":
  sdk.holdDisable=true
  let request=NativeHealthPauseRequest(["schemaVersion":"1.0.0","operationId":UUID().uuidString.lowercased(),"sourceNamespace":selected["sourceNamespace"]!,"enrollmentId":selected["enrollmentId"]!,"endpointId":joinedIdentity["endpointId"]!])!
  let paused=await withCheckedContinuation{c in runtime.pauseCollection(request){c.resume(returning:$0)}}
  await waitUntil{!sdk.heldControls.isEmpty};for _ in 0..<12{await turn()}
  let held=await withCheckedContinuation{c in runtime.pauseCollection(request){c.resume(returning:$0)}}
  check(paused["persistence"] as? String=="savedPaused" && held["drain"] as? String=="pending" && !runtime.backgroundRetirementReady,"pause cannot publish full drain before original background callback")
  sdk.holdDisable=false;sdk.releaseControl();await waitUntil{runtime.backgroundRetirementReady}
  let drained=await withCheckedContinuation{c in runtime.pauseCollection(request){c.resume(returning:$0)}}
  check(drained["drain"] as? String=="drained","pause publishes full drain after actual original background callback")
 case "BG27-scope":
  let priorScopeChoice=statusChoice(),priorScopeReview=await action("review")
  let beginResult = await configured(source,"begin",["humanConfirmed":true]);fputs("SCOPE begin \(beginResult["state"] ?? "nil")\n",stderr);await waitUntil{connection.configuredHealthSettingsControl};fputs("SCOPE settings ready\n",stderr)
  check(runtime.backgroundRetirementReady && runtime.savedHealthSelection?.backgroundChoice?.enabled==false,"old exact scope cleaned before original settings")
  await edit(source,paused:false);fputs("SCOPE actual remote edit complete\n",stderr)
  let localReview=await configured(source,"localReview",["categories":["heartRate"],"rangeStart":"2026-10-01T00:00:00.000Z","rangeEnd":"2026-10-02T00:00:00.000Z"])
  check(localReview["state"] as? String=="localReview","actual new scope review \(localReview)")
  fputs("SCOPE local review ready\n",stderr)
  let localReturn=await configured(source,"localConfirm",["reviewId":localReview["reviewId"]!,"humanConfirmed":true]);check(localReturn["state"] as? String=="localPrepared","actual new scope return \(localReturn)")
  fputs("SCOPE local return complete\n",stderr)
  let nextCatalog=await setupChoices(host),nextRow=(nextCatalog["choices"] as! [[String:Any]])[0]
  fputs("SCOPE new catalog ready\n",stderr)
  let nextSaved=await remembered(host,"remember",nextCatalog,nextRow);check(nextSaved["persistence"] as? String=="savedEnabled","new exact foreground selection \(nextSaved)")
  fputs("SCOPE remembered new choice\n",stderr)
  source.setSavedHealthForeground(true);await settled();fputs("SCOPE new foreground settled\n",stderr)
  check(statusChoice() != priorScopeChoice,"known new scope has new opaque choice identity")
  let beforeStale=sdk.controls.count
  let stale=await withCheckedContinuation{c in source.healthBackgroundChoice(["operation":"enable","choice":priorScopeChoice,"review":priorScopeReview["review"]!,"humanConfirmed":true]){c.resume(returning:$0)}}
  check(stale["state"] as? String=="unavailable" && sdk.controls.count==beforeStale,"old scope handle/review rejected before effect")
  let nextReview=await action("review");check(nextReview["state"] as? String=="reviewed","new scope has fresh opaque background review \(nextReview)")
  _ = await action("enable",["review":nextReview["review"]!,"humanConfirmed":true])
  await waitUntil{sdk.controls.contains{$0.0=="heartRate" && $0.1}}
  await settled();for _ in 0..<12{await turn()}
  check(runtime.backgroundRegistrationState=="registered","new active scope registered with old scope disabled: \(runtime.backgroundRegistrationState), \(sdk.controls)")
  check(runtime.savedHealthSelection?.plans.map(\.category)==["heartRate"] && factories==1 && files.opens==1,"actual new scope keeps original SDK/Root/file")
 case "BG27":
  sdk.holdDisable=true;let state=connection.beginConfiguredHealthSettings(runtime:runtime,current:{true});check(state=="retiring","original configured settings enters scoped retirement");await waitUntil{!sdk.heldControls.isEmpty};for _ in 0..<12{await turn()};check(!runtime.configuredSettingsReady && runtime.backgroundPreferenceState=="disabled","cannot drop old types before actual original disable");sdk.holdDisable=false;sdk.releaseControl();await waitUntil{runtime.configuredSettingsReady};check(factories==1,"settings never constructs second SDK")
 default:check(false,"unregistered Native BG scenario \(stage)")
 }
 check(sdk.queries>=initialQueries,"query evidence monotonic");finish()
}
Task{@MainActor in await runBackground();exit(0)}
DispatchQueue.main.asyncAfter(deadline:.now()+45){failureDiagnostic?();fputs("FAIL background timeout\n",stderr);exit(2)}
RunLoop.main.run()
