import Foundation
import CryptoKit
@testable import AssistantCore
func check(_ value:@autoclosure()->Bool,_ message:String){if !value(){fputs("FAIL: \(message)\n",stderr);exit(1)}}
final class Store:ConnectionStore{var value:SavedConnection?;func load()throws->SavedConnection?{value};func save(_ value:SavedConnection)throws{self.value=value}}
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
@MainActor func runSavedRecovery()async{
 let opened=try! JSONSerialization.jsonObject(with:Data(base64Encoded:ProcessInfo.processInfo.environment["CONSENT_DRIVER_OPEN"]!)!) as! [String:Any];joinedIdentity=opened["syntheticIdentity"] as! [String:Any];joinedOrigin=opened["transportOrigin"] as! String
 let selected=try! JSONSerialization.jsonObject(with:Data(base64Encoded:ProcessInfo.processInfo.environment["HEALTH_SELECTED_SOURCE"]!)!) as! [String:Any]
 let transport=NativeTransport(store:Store());try! transport.configure("https://offline.invalid");let network=URLSessionConfiguration.ephemeral;network.protocolClasses=[ActualProducerNetwork.self];transport.session=URLSession(configuration:network,delegate:transport,delegateQueue:.main);transport.csrf=joinedIdentity["csrf"] as! String
 let connection=NativeHealthConnectionOwner(transport:transport),handle=JoinedHandle(),files=JoinedFiles(handle),sdk=HealthSDK();var factories=0,typedAuthEvents=0,unrelatedLegacyChecks=0
 let registration=NativeCalendarAppComposition.registration{.init(resolveFile:{current in check(current(),"same original locator");joinedFileResolves+=1;return URL(fileURLWithPath:"/synthetic/Library/Application Support/Lifestream/mobile-context.snapshot.json")},filePort:files,limits:.init(maxTotalDays:366,maxScans:8,maxSelectedCalendars:32)!,maxBytes:8388608,maxEvents:100000,mappingVersion:NativeCalendarAppComposition.mappingVersion,protectedAvailable:{joinedProtected},clock:{Date()},makeSDK:{joinedSDKFactories+=1;return NeverSDK()},deliveryContract:.selected,health:.init(mappingVersion:NativeCalendarAppComposition.healthMappingVersion,makeSDK:{factories+=1;return sdk}))}
 guard let source=registration.bind(transport:transport,connection:connection) else{check(false,"normal registration");return}
 savedReceipt={[
  "stage":stage,"lowestRelayResponseBodies":joinedResponseBytes.count,"lowestRelayProducerPinFrames":joinedWireEvidence.count,"requestCount":joinedRequestBytes.count,"typedAuthNotifications":typedAuthEvents,
  "fileOpens":files.opens,"SDKFactories":factories,"SDKStatusReads":sdk.statusReads,"permissionEntries":sdk.permissionEntries,"queryEntries":sdk.queries,"observerRegistrations":sdk.registrations,"observerStops":sdk.observerStops,"backgroundChoices":sdk.observerBackground,"lowerUnrelatedLegacyReentryChecks":unrelatedLegacyChecks,
  "fakeSDKAndFilePortsOnly":true,"noRawAuthBodiesOrCredentialsRetained":true,"noInstalledOrPhysicalDeviceAcceptance":true
 ]}

 func proveFiniteCatchup(_ label:String)async{
  await waitUntil{connection.host.runtime?.observationState=="armed"}
  let bytes=files.handles.last!.data!,raw=try! JSONSerialization.jsonObject(with:bytes) as! [String:Any],row=try! JSONSerialization.jsonObject(with:healthRows(raw)[UUID(uuidString:selected["enrollmentId"] as! String)!.uuidString]!) as! [String:Any]
  let anchors=row["anchors"] as! [String:String]
  check((row["queue"] as! [Any]).isEmpty && anchors.values.contains(Data([UInt8(sdk.queries)]).base64EncodedString()),"\(label): finite catch-up commits actual next anchor and separately ACKs original queue")
  check(sdk.plans.allSatisfy{$0.start==Date(timeIntervalSince1970:1790812800) && $0.end==Date(timeIntervalSince1970:1790899200)},"catch-up keeps exact reviewed Oct1–2 range")
  let checkpoint=joinedDriver.call("checkpoint");check(checkpoint["records"] as? Int==1 && checkpoint["listening"] as? Bool==false,"\(label): separate original SessionOwner delivery reaches actual producer SQL once")
  let queries=sdk.queries,wire=joinedRequestBytes.count
  for _ in 0..<12{await turn()}
  check(sdk.queries==queries && joinedRequestBytes.count==wire && sdk.automaticCompletions==0,"\(label): no initial OS notice, duplicate catch-up or recursive query/network loop")
 }
 transport.healthContextTransition={event in
  typedAuthEvents+=1
  if stage=="cancel-auth-late"{let fields=Mirror(reflecting:source).children;let generation=fields.first{$0.label=="generation"}!.value;let retiring=fields.first{$0.label=="controlRetiring"}!.value;fputs("AUTH kind=\(event.kind) sameHuman=\(event.oldPrincipal==event.proposedPrincipal) sameSession=\(event.oldSession==event.proposedSession) generation=\(generation) retiring=\(retiring)\n",stderr)}
  source.observeHealthContextTransition(event)
  if stage=="legacy-unrelated",event.kind == .authUnavailable,Mirror(reflecting:source).children.first(where:{$0.label=="controlRetiring"})!.value as? Bool==true{
   // Explicit LOWER reentry representations, not authentic Auth replies. The
   // surrounding old failed Auth callback itself is actual Transport execution.
   func generation()->UInt64{Mirror(reflecting:source).children.first{$0.label=="generation"}!.value as! UInt64}
   let before=generation()
   source.healthContextWillChange(authorityChanged:true) // unrelated/unpaired
   check(generation()==before+1,"unrelated legacy event is never swallowed")
   let different=NativeTransport.HealthContextTransition(kind:.authUnavailable,oldPrincipal:nil,oldSession:nil,proposedPrincipal:nil,proposedSession:nil,authData:nil)
   source.healthContextWillChange(authorityChanged:true,notification:different)
   check(generation()==before+2,"fresh distinct notification is never swallowed by old paired event")
   unrelatedLegacyChecks+=2
  }
 }
 transport.healthContextPairedWillChange={source.healthContextWillChange(authorityChanged:$0,notification:$1)}
 check(files.opens==0 && factories==0 && joinedRequestBytes.isEmpty && sdk.statusReads==0,"construction inert")
 if ["absent","cold","cold-disabled","cold-protected","cold-policy-denied","cold-disabled-stop-enable"].contains(stage) || stage.hasPrefix("cold-stop-"){
  if stage=="cold-protected"{joinedProtected=false}
  if stage.hasPrefix("cold-stop-restore-"){delayOperation="inventory"}
  else if stage.hasPrefix("cold-stop-") && stage != "cold-stop-manual"{holdNextQuery=true}
  source.setSavedHealthForeground(true)
  if stage.hasPrefix("cold-stop-"){
   if stage.hasPrefix("cold-stop-restore-"){await waitUntil{delayedDelivery != nil && !(source.savedHealthRecoveryStatus()["choices"] as! [[String:Any]]).isEmpty}}
   else if stage=="cold-stop-manual"{_ = await recoveryDone(source);await proveFiniteCatchup(stage)}
   else{await waitUntil{heldPage != nil}}
   let info=source.savedHealthRecoveryStatus(),target=(info["choices"] as! [[String:Any]]).first{$0["updatesEnabled"] as? Bool==true}!,token=target["choice"] as! String
   let original=connection.host.runtime ?? (Mirror(reflecting:source).children.first{$0.label=="controlRuntime"}!.value as! NativeHealthRuntime)
   let root=Mirror(reflecting:original).children.first{$0.label=="root"}!.value as! NativeSharedOutboxOwner,currentHandle=files.handles.last!
   let before=currentHandle.data!,writes=currentHandle.writes,queries=sdk.queries
   let stopInput:[String:Any]=["operation":"stop","choice":token]
   func sourceChoice(_ input:[String:Any])async->[String:Any]{await withCheckedContinuation{c in source.savedHealthRecoveryChoice(input:input){c.resume(returning:$0)}}}
   func row(_ bytes:Data)->[String:Any]{let raw=try! JSONSerialization.jsonObject(with:bytes) as! [String:Any];return try! JSONSerialization.jsonObject(with:healthRows(raw)[UUID(uuidString:selected["enrollmentId"] as! String)!.uuidString]!) as! [String:Any]}
   if stage=="cold-stop-foreign"{
    for input:[String:Any] in [["operation":"stop","choice":UUID().uuidString.lowercased()],["operation":"stop","choice":token,"sourceNamespace":selected["sourceNamespace"]!],["operation":"stop","choice":token,"endpointId":UUID().uuidString.lowercased()]]{
     let denied=await sourceChoice(input);check(denied["state"] as? String=="unavailable","foreign or JS-retargeted opaque choice denied")
    }
    check(currentHandle.data==before && currentHandle.writes==writes && sdk.queryHandles.last!.stops==0 && factories==1,"foreign input cannot fence/disable/retarget current choice")
    finishSaved();return
   }
   if stage=="cold-stop-origin"{
    try! transport.configure("https://other.invalid")
    let bytes=currentHandle.data,count=currentHandle.writes,denied=await sourceChoice(stopInput)
    check(denied["state"] as? String=="unavailable" && currentHandle.data==bytes && count==currentHandle.writes && factories==1 && files.opens==1,"old origin/epoch choice cannot mutate another current binding or fabricate saved success")
    finishSaved();return
   }
   if stage=="cold-stop-pref-known-write"{
    localWriteHook={localWriteHook=nil;source.setSavedHealthForeground(false);source.withdraw();connection.withdraw()}
    _ = await sourceChoice(stopInput)
    check(original.savedSelectionPersistence=="savedDisabled" && currentHandle.data != before,"known invoked successful preference write stays known through reentrant full withdrawal")
    let saved=currentHandle.data!;heldPage?();heldPage=nil;for _ in 0..<15{await turn()}
    check(currentHandle.data==saved && sdk.queries==queries && joinedDriver.call("checkpoint")["records"] as? Int==0,"no rollback or automatic late commit/send after known protective write")
    source.setSavedHealthForeground(true);let result=await recoveryDone(source)
    check(result["state"] as? String=="disabled" && factories==1 && sdk.queries==queries,"fresh recovery honors known durable off after real late callback")
    finishSaved();return
   }
   if stage=="cold-stop-human"{
    let switched=joinedDriver.call("authSwitch");joinedIdentity=switched["identity"] as! [String:Any];transport.csrf=joinedIdentity["csrf"] as! String
    let _:Result<(Data,HTTPURLResponse),Error>=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}}
    await waitUntil{original.savedSelectionPersistence=="requiresRebind"};let marked=currentHandle.data,count=currentHandle.writes
    let denied=await sourceChoice(stopInput);check(denied["state"] as? String=="unavailable" && currentHandle.data==marked && currentHandle.writes==count && factories==1,"old Human opaque choice cannot act on new current subject")
    finishSaved();return
   }
   if stage=="cold-stop-manual"{
    let host=connection.host,catalog=await setupChoices(host),choice=(catalog["choices"] as! [[String:Any]])[0],category=(choice["dataChoices"] as! [[String:Any]])[0];holdNextQuery=true;var manual:[String:Any]?
    host.performChoice(.sync,input:["catalogId":catalog["catalogId"]!,"choice":choice["choice"]!,"categoryChoice":category["categoryChoice"]!]){manual=$0};await waitUntil{heldPage != nil}
    localWriteHook={localWriteHook=nil;source.setSavedHealthForeground(true)}
    let query=sdk.queryHandles.last!,generation=root.healthGeneration,stopped=await sourceChoice(stopInput)
    check(stopped["persistence"] as? String=="savedDisabled" && query.stops==0 && root.healthGeneration==generation,"saved-choice Stop preserves independent original manual query and IO generation")
    heldPage?();heldPage=nil;await waitUntil{manual != nil && original.choiceAdmissionAvailable}
    check(manual?["syncOutcome"] as? String=="applied" && joinedDriver.call("checkpoint")["records"] as? Int==2,"independent manual sync remains genuinely ACKed after saved Stop")
    let finalQueries=sdk.queries,finalWire=joinedRequestBytes.count;for _ in 0..<12{await turn()}
    check(finalQueries==queries+1 && sdk.queries==finalQueries && joinedRequestBytes.count==finalWire && files.opens==1 && factories==1,"reentrant foreground during saved Stop neither replaces owner nor creates extra automatic query/commit/send")
    finishSaved();return
   }
   if !stage.hasPrefix("cold-stop-restore-"){
    let unavailable=await setupChoices(connection.host);check(unavailable["state"] as? String=="unavailable" && unavailable["reason"] as? String=="busy","fresh cold UI has no prepared catalog while true query is held")
   }
   if stage=="cold-stop-write-before"{currentHandle.failBefore=true}
   if stage=="cold-stop-write-after"{currentHandle.ambiguous=true}
   var independentGeneration:UInt64?
   if stage=="cold-stop-independent-fence"{root.fenceHealth();independentGeneration=root.healthGeneration}
   var stopped:[String:Any]
   if stage=="cold-stop-known-write"{
    var nested:[String:Any]?
    localWriteHook={localWriteHook=nil;source.savedHealthRecoveryChoice(input:stopInput){nested=$0}}
    heldPage?();heldPage=nil;await waitUntil{nested != nil && original.savedSelectionPersistence=="savedDisabled" && original.choiceAdmissionAvailable};stopped=nested!
    let current=row(currentHandle.data!);check((current["queue"] as! [Any]).count==1 && !(current["anchors"] as! [String:Any]).isEmpty,"already invoked successful catch-up commit/anchor remains known after reentrant Stop; no rollback")
    check(stopped["persistence"] as? String=="pending" && joinedDriver.call("checkpoint")["records"] as? Int==0,"Stop reports pending inside known commit frame and blocks automatic sending")
    finishSaved();return
   }else{stopped=await sourceChoice(stopInput)}
   if stage=="cold-stop-write-before" || stage=="cold-stop-write-after"{
    check(stopped["persistence"] as? String=="unconfirmed" && stopped["drain"] as? String=="pending","before/after write errors report unknown durable preference, not saved")
    check(stage=="cold-stop-write-before" ? currentHandle.data==before:currentHandle.data != before,"actual before/after-write outcomes preserved")
    source.setSavedHealthForeground(true);heldPage?();heldPage=nil;for _ in 0..<20{await turn()}
    check(files.opens==1 && factories==1 && currentHandle.current && original.preservesPauseHold,"ambiguous metadata write retains exact old store/owner even after real late query returns")
    finishSaved();return
   }
   check(stopped["persistence"] as? String=="savedDisabled" && stopped["drain"] as? String=="pending","no-catalog protective Stop reports known durable disabled separately from true pending work \(stopped)")
   check(stored(row(before))==stored(row(currentHandle.data!)),"protective saved Stop changes no queue/anchor or enrollment")
   let disabled=currentHandle.data!
   if stage.hasPrefix("cold-stop-restore-"){
    check(factories==0 && sdk.queries==0 && source.busy && files.opens==1,"Stop while actual restore inventory callback is NEVER held never manufactures completion/SDK/replacement")
    if stage=="cold-stop-restore-never"{finishSaved();return}
    delayedDelivery?();delayedDelivery=nil;await waitUntil{!source.busy}
    check(factories==0 && sdk.queries==0 && currentHandle.data==disabled,"late authentic successful inventory cannot revive stopped restoration")
    source.setSavedHealthForeground(true);let result=await recoveryDone(source);check(result["state"] as? String=="disabled" && factories==0 && sdk.queries==0,"later fresh opportunity honors saved off, no automatic SDK")
    finishSaved();return
   }
   check(sdk.queryHandles.last!.stops==1 && !original.choiceAdmissionAvailable && files.opens==1 && currentHandle.current,"no-catalog Stop synchronously cancels/fences but retains true NEVER query/Root/file")
   let wire=joinedRequestBytes.count;for _ in 0..<12{await turn()};check(sdk.queries==queries && joinedRequestBytes.count==wire && joinedDriver.call("checkpoint")["records"] as? Int==0,"pending Stop cannot send/requery or claim a producer record")
   if stage=="cold-stop-never"{finishSaved();return}
   heldPage?();heldPage=nil;await waitUntil{original.choiceAdmissionAvailable}
   check(currentHandle.data==disabled && sdk.queries==queries && joinedDriver.call("checkpoint")["records"] as? Int==0,"late cancelled page cannot commit/advance anchor or send after no-catalog Stop")
   if let generation=independentGeneration{check(root.healthGeneration==generation && !root.healthIOCurrent,"saved Stop never reopens independent original fence")}
   finishSaved();return
  }
  if stage=="cold-protected"{for _ in 0..<8{await turn()};check(files.opens==0 && factories==0 && joinedRequestBytes.isEmpty,"protected cold event does not bootstrap");finishSaved();return}
  let result=await recoveryDone(source)
  if stage=="absent"{check(result["state"] as? String=="absent" && factories==0 && sdk.statusReads==0 && !FileManager.default.fileExists(atPath:stateURL.path),"absent Auth/control lookup has zero SDK/status/permission/query/writes \(result)")}
  else if stage=="cold-disabled" || stage=="cold-disabled-stop-enable"{check(result["state"] as? String=="disabled" && factories==0 && sdk.statusReads==0 && sdk.queries==0,"disabled cold lookup never creates SDK \(result)")
   let values=result["choices"] as! [[String:Any]];let restored=await withCheckedContinuation{c in source.savedHealthRecoveryChoice(input:["operation":"restore","choice":values[0]["choice"]!]){c.resume(returning:$0)}}
   check(restored["state"] as? String=="restoredManual" && factories==1 && sdk.registrations==0 && sdk.queries==0,"explicit manual restore does not enable updates \(restored)")
   if stage=="cold-disabled-stop-enable"{
    let token=(source.savedHealthRecoveryStatus()["choices"] as! [[String:Any]])[0]["choice"] as! String,host=connection.host,catalog=await setupChoices(host),row=(catalog["choices"] as! [[String:Any]])[0];var stopped:[String:Any]?
    fileReadHook={fileReadHook=nil;source.savedHealthRecoveryChoice(input:["operation":"stop","choice":token]){stopped=$0}}
    _ = await remembered(host,"remember",catalog,row)
    await waitUntil{stopped != nil && host.runtime?.choiceAdmissionAvailable==true}
    check(host.runtime?.savedHealthSelection?.updatesEnabled==false && sdk.registrations==0 && sdk.queries==0,"opaque saved Stop cancels pending enable even when previous durable preference was already disabled")
   }

  }else if stage=="cold-policy-denied"{check(result["state"] as? String != "restoredEnabled" && factories==0 && sdk.queries==0,"actual policy denied cold restore creates no SDK")}
  else{check(result["state"] as? String=="restoredEnabled" && factories==1 && files.opens==1,"cold process restores one SDK after exclusive original file \(result)");await waitUntil{connection.host.runtime?.observationState=="armed"};check(sdk.queries==1 && sdk.permissionEntries==0 && !sdk.observerBackground.isEmpty && sdk.observerBackground.allSatisfy{!$0},"cold restore performs one finite catch-up without OS notice, never prompts or enables background permission=\(sdk.permissionEntries) registrations=\(sdk.registrations) background=\(sdk.observerBackground)")}
  if stage=="cold"{await proveFiniteCatchup("cold")}
  check(typedAuthEvents>0,"actual replies traversed production typed Auth seam");finishSaved();return
 }
 let auth=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}};guard case .success((_,let http))=auth else{check(false,"actual Auth");return};check(http.statusCode==200 && transport.effectiveIsSelf,"actual authenticated self")
 let context=await withCheckedContinuation{c in transport.request("/api/runtime/v1/session-context"){c.resume(returning:$0)}};guard case .success(let(data,_))=context else{check(false,"actual context");return};let rawContext=try! JSONSerialization.jsonObject(with:data) as! [String:Any]
 let input:[String:Any]=["schemaVersion":"1.0.0","sourceNamespace":selected["sourceNamespace"]!,"enrollmentId":selected["enrollmentId"]!,"endpointId":joinedIdentity["endpointId"]!,"policyRevision":selected["revision"]!,"contextRevision":rawContext["revision"]!,"categories":["SleepSegment"],"rangeStart":"2026-10-01T00:00:00.000Z","rangeEnd":"2026-10-02T00:00:00.000Z","localSetup":"prepareNewLocal"]
 let prepared=await withCheckedContinuation{c in source.prepareExistingHealth(input:input){c.resume(returning:$0)}};check(prepared["state"] as? String=="prepared" && factories==0,"existing profile inert")
 let host=connection.host,catalog=await setupChoices(host),row=(catalog["choices"] as! [[String:Any]])[0]
 let setup=await choice(host,.setup,["catalogId":catalog["catalogId"]!,"choice":row["choice"]!]);check(setup["setupOutcome"] as? String=="prepared","actual local setup")
 guard let runtime=host.runtime else{check(false,"original Runtime");return}
 failureDiagnostic={
  for (label,object) in [("Runtime",runtime as Any),("Source",source as Any),("Host",host as Any)]{
   let allowed:Set<String>=["pending","retired","settingUp","observationOperations","drainScheduled","savedRetirementPublished","savedProtectionPending","savedProtectionUnconfirmed","controlRetiring","generation","savedRecoveryState","savedWakeRequested","healthEntering","calendarEntering","healthSettingsRetiring","healthSettingsPublishing"]
   for field in Mirror(reflecting:object).children where allowed.contains(field.label ?? ""){fputs("STATE \(label).\(field.label!)=\(field.value)\n",stderr)}
  }
  let root=Mirror(reflecting:runtime).children.first{$0.label=="root"}!.value as! NativeSharedOutboxOwner
  fputs("STATE Root busy=\(root.busy) storage=\(root.inStorage) unresolved=\(root.unresolved) revoked=\(root.revoked) opens=\(files.opens) factories=\(factories)\n",stderr)
 }

 if stage=="save-stop-read" || stage=="save-stop-write"{
  var stopReply:[String:Any]?,hooked=false
  let hook={hooked=true;host.savedHealthChoice(["operation":"stop","catalogId":catalog["catalogId"]!,"choice":row["choice"]!]){stopReply=$0}}
  if stage=="save-stop-read"{fileReadHook={fileReadHook=nil;hook()}}else{localWriteHook={localWriteHook=nil;hook()}}
  _ = await remembered(host,"remember",catalog,row)
  await waitUntil{stopReply != nil && runtime.choiceAdmissionAvailable};check(hooked && sdk.queries==0 && sdk.registrations==0,"Stop during original save frame does not query/register")
  if stage=="save-stop-read"{check(runtime.savedHealthSelection==nil,"read reentry cancels first save before invocation")}
  else{await waitUntil{runtime.savedSelectionPersistence=="savedDisabled"};check(runtime.savedHealthSelection?.updatesEnabled==false,"known invoked successful save survives reentry then durable disabled preference")
   let data=(row["dataChoices"] as! [[String:Any]])[0],synced=await choice(host,.sync,["catalogId":catalog["catalogId"]!,"choice":row["choice"]!,"categoryChoice":data["categoryChoice"]!]);check(synced["syncOutcome"] as? String=="applied","Stop during known save leaves independent manual sync usable \(synced)")}
  finishSaved();return
 }
 let saved=await remembered(host,"remember",catalog,row,enabled:stage != "seed-disabled")
 check(saved["persistence"] as? String==(stage=="seed-disabled" ? "savedDisabled":"savedEnabled"),"known successful choice write \(saved)")
 if stage=="seed-disabled"{check(sdk.queries==0 && sdk.registrations==0,"disabled save no update query");finishSaved();return}
 await waitUntil{runtime.observationState=="armed"}
 check(sdk.queries==0 && sdk.permissionEntries==0,"remember does not read data or request access")
 if stage=="seed"{finishSaved();return}
 if stage=="stop"{
  let stopped=await remembered(host,"stop",catalog,row);check(["pending","savedDisabled"].contains(stopped["persistence"] as? String ?? ""),"Stop reports actual pending/saved preference")
  await waitUntil{runtime.savedSelectionPersistence=="savedDisabled"};let raw=try! JSONSerialization.jsonObject(with:Data(contentsOf:stateURL)) as! [String:Any];let list=raw["healthSelections"] as! [Any];check((list[1] as! [String:Any])["updatesEnabled"] as? Bool==false,"Stop durable same snapshot");finishSaved();return
 }
 if ["auth-refresh","auth-session","auth-human","auth-return","auth-unavailable"].contains(stage){
  let originalIdentity=joinedIdentity,firstBytes=handle.data!
  if stage=="auth-unavailable"{
   // Authentic 401 from the original handler. No injected Auth payload.
   joinedIdentity["cookie"]="invalid-synthetic-session"
  }else if stage != "auth-refresh"{
   let changed=joinedDriver.call(stage=="auth-session" ? "authSwitchSame":"authSwitch");check(changed["kind"] as? String=="authSwitched","original Auth account/sign-in fixture");joinedIdentity=changed["identity"] as! [String:Any];transport.csrf=joinedIdentity["csrf"] as! String
  }
  let _:Result<(Data,HTTPURLResponse),Error>=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}}
  if stage=="auth-session"{
   check(handle.data==firstBytes && runtime.savedHealthSelection?.requiresRebind==false,"authentic same Human/new session does not mark rebind")
   source.setSavedHealthForeground(true);let result=await recoveryDone(source)
   check(result["state"] as? String=="restoredEnabled" && files.opens==2 && factories==1,"new actual session uses fresh owner and same SDK without rebind \(result)");await proveFiniteCatchup("auth-session")
  }else if stage=="auth-refresh"{check(runtime.savedSelectionPersistence=="savedEnabled" && handle.data==firstBytes && connection.host === host,"same Human/context refresh does not persist rebind or replace")}
  else if stage=="auth-unavailable"{check(handle.data==firstBytes && factories==1,"unknown Auth fences without inventing actual Human change or rebind marker")}
  else{
   await waitUntil{runtime.savedSelectionPersistence=="requiresRebind"};check(handle.data != firstBytes && factories==1 && sdk.queries==0,"actual Human transition persists protective rebind on same old file")
   if stage=="auth-return"{
    joinedIdentity=originalIdentity;transport.csrf=joinedIdentity["csrf"] as! String
    let _:Result<(Data,HTTPURLResponse),Error>=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}}
    source.setSavedHealthForeground(true);let result=await recoveryDone(source)
    check(result["state"] as? String=="requiresRebind" && factories==1 && sdk.queries==0,"authentic A→B→A cannot automatically clear durable rebind \(result)")
   }
  }
  check(typedAuthEvents>1,"auth transitions used production Transport callbacks from authentic replies");finishSaved();return
 }
 if stage=="protect-reentry"{
  // Lower synthetic protective callback representation, NOT authentic Auth
  // transport coverage. Actual Auth transitions have their separate cases.
  localWriteHook={localWriteHook=nil;runtime.protectSavedHealthSelection(disable:false,requireRebind:true)}
  _ = await remembered(host,"stop",catalog,row);await waitUntil{runtime.savedSelectionPersistence=="requiresRebind" && runtime.choiceAdmissionAvailable}
  check(runtime.savedHealthSelection?.updatesEnabled==false && runtime.savedHealthSelection?.requiresRebind==true,"stronger rebind intent during disable write is durably preserved")
  finishSaved();return
 }
 if stage=="stop-commit-read"{
  holdNextQuery=true;var completed=0;sdk.observerCallbacks[0](nil){completed+=1};await waitUntil{heldPage != nil};let before=handle.data!,wire=joinedRequestBytes.count;var stopped:[String:Any]?
  fileReadHook={fileReadHook=nil;host.savedHealthChoice(["operation":"stop","catalogId":catalog["catalogId"]!,"choice":row["choice"]!]){stopped=$0}}
  heldPage?();heldPage=nil;await waitUntil{stopped != nil && runtime.savedSelectionPersistence=="savedDisabled" && runtime.choiceAdmissionAvailable}
  let beforeRaw=try! JSONSerialization.jsonObject(with:before) as! [String:Any],afterRaw=try! JSONSerialization.jsonObject(with:handle.data!) as! [String:Any]
  check(stored(beforeRaw["enrollments"]!)==stored(afterRaw["enrollments"]!) && completed==1 && joinedRequestBytes.count==wire && sdk.registrations==1,"Stop inside Core commit read prevents queue/anchor write, completes once, saves only disabled preference")
  finishSaved();return
 }
 if stage=="held-permission"{
  sdk.delayPermission=true;host.performChoice(.permission,input:["catalogId":catalog["catalogId"]!,"choice":row["choice"]!]){_ in}
  await waitUntil{sdk.permissionDone != nil}
 }
 if stage=="cancel-auth-late" || stage=="cancel-auth-no-late" || stage=="legacy-unrelated"{delayPath="/api/auth/v1/user-context";connection.foregroundHealthOpportunity();await waitUntil{delayedDelivery != nil}}
 if stage=="close-reentry"{fileCloseHook={fileCloseHook=nil;source.setSavedHealthForeground(true);check(files.opens==1,"no replacement inside original close frame")}}
 if ["held-query","never-query"].contains(stage){holdNextQuery=true;var completed=0;sdk.observerCallbacks[0](nil){completed+=1};await waitUntil{heldPage != nil};check(completed==1,"notification finished without waiting for held query")}
 if stage=="write-before"{handle.failBefore=true};if stage=="write-after"{handle.ambiguous=true}
 if stage=="write-before" || stage=="write-after"{
  _ = await remembered(host,"stop",catalog,row);await waitUntil{runtime.savedSelectionPersistence=="unconfirmed"}
 }
 source.setSavedHealthForeground(false);source.withdraw();connection.withdraw();if stage != "legacy-unrelated"{await turn()}
 let originalQueries=sdk.queries
 source.setSavedHealthForeground(true)
 if stage=="legacy-unrelated"{
  await waitUntil{unrelatedLegacyChecks==2 && source.savedHealthRecoveryStatus()["state"] as? String=="contextChanged"}
  check(factories==1 && files.opens==1 && connection.host.runtime==nil,"unrelated nested withdrawal fences/revokes waiting recovery with no new SDK/Root")
  finishSaved();return
 }
 if ["held-query","never-query","held-permission","write-before","write-after"].contains(stage){
  for _ in 0..<12{await turn()};check(files.opens==1 && factories==1 && files.handles[0].current,"true held owner prevents file close/new Root/new SDK")
  if ["never-query","write-before","write-after"].contains(stage){finishSaved();return}
  if stage=="held-query"{heldPage?();heldPage=nil}
  if stage=="held-permission"{sdk.permissionDone?(.success(()));sdk.permissionDone=nil}
 }
 await waitUntil{source.savedHealthRecoveryStatus()["state"] as? String=="restoredEnabled"}
 let recovered=source.savedHealthRecoveryStatus()
 if stage=="cancel-auth-late"{fputs("CHECK cancellation restored=\(recovered["state"] ?? "nil") observation=\(connection.host.runtime?.observationState ?? "nil") prepares=\(sdk.observerPrepares) registrations=\(sdk.registrations)\n",stderr);await waitUntil{connection.host.runtime?.observationState=="armed"};let before=joinedRequestBytes.count;delayedDelivery?();delayedDelivery=nil;for _ in 0..<8{await turn()};check(factories==1 && files.opens==2 && joinedRequestBytes.count==before,"late cancelled Auth transport cannot recreate/retarget original owner")}
 // URLSession cancellation itself returns the true native handler. An uncalled
 // lowest URLProtocol delivery is NOT a never-returned Native request owner.
 check(recovered["state"] as? String=="restoredEnabled" && files.opens==2 && factories==1 && !files.handles[0].current && files.handles[1].current,"same process closes original before new Root and hands same SDK forward \(recovered)")
 await waitUntil{connection.host.runtime?.observationState=="armed"}
 check(connection.host !== host && connection.host.runtime !== runtime && sdk.queries==originalQueries+1 && sdk.permissionEntries==(stage=="held-permission" ? 1:0),"fresh Host/Profile/Runtime, same SDK, one finite catch-up without OS notice and no prompt")
 await proveFiniteCatchup(stage)
 check(typedAuthEvents>2,"production Auth notifications exercised")
 finishSaved()
}
func finishSaved(){if let receipt=savedReceipt{try! stored(receipt()).write(to:stateURL.deletingLastPathComponent().appendingPathComponent(stage+"-native-receipt.json"),options:.atomic)};check(joinedSDKFactories==0,"Calendar SDK untouched");check(joinedDriver.call("checkpoint")["listening"] as? Bool==false,"actual disposable producer non-listening");fputs("PASS saved recovery \(stage)\n",stderr)}
Task{@MainActor in await runSavedRecovery();exit(0)}
DispatchQueue.main.asyncAfter(deadline:.now()+45){fputs("FAIL saved recovery timeout\n",stderr);exit(2)}
RunLoop.main.run()
