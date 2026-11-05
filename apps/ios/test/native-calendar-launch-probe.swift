import Foundation
@testable import AssistantCore
// TEST ONLY: lowest ports; no EventKit construction, OS status or real files.
func check(_ value:@autoclosure()->Bool,_ message:String){if !value(){fputs("FAIL: \(message)\n",stderr);exit(1)}}
final class Store:ConnectionStore{var loads=0,writes=0,value:SavedConnection?;func load()throws->SavedConnection?{loads+=1;return value};func save(_ value:SavedConnection)throws{writes+=1;self.value=value}}
final class Files:NativeCalendarFilePort{var opens=0;let handle=JoinedHandle();func openExclusive(snapshot:URL)throws->any NativeCalendarFileHandle{opens+=1;return handle}}
var resources=0,homes=0,protection=0,clocks=0,sdks=0
let files=Files(),store=Store(),transport=NativeTransport(store:store)
let seededV4=try! Data(contentsOf:URL(fileURLWithPath:ProcessInfo.processInfo.environment["NATIVE_RECOVERY_V4"]!))
files.handle.data=seededV4
func inputs()->NativeCalendarSourceOwner.Resources{
 resources+=1
 return .init(resolveFile:{current in homes+=1;guard current() else{throw NativeCalendarAdmissionError.stale};return URL(fileURLWithPath:"/synthetic/Library/Application Support/Lifestream/mobile-context.snapshot.json")},filePort:files,limits:.init(maxTotalDays:366,maxScans:8,maxSelectedCalendars:32)!,maxBytes:8*1024*1024,maxEvents:100000,mappingVersion:NativeCalendarAppComposition.mappingVersion,protectedAvailable:{protection+=1;return true},clock:{clocks+=1;fatalError("no implicit anchor")},makeSDK:{sdks+=1;fatalError("no implicit EventKit")})
}
func selectedWireQualification(){
 let root=URL(fileURLWithPath:ProcessInfo.processInfo.environment["CALENDAR_SELECTED_PRODUCER"]!)
 let document=try! JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent("explicitApprovedSynthetic.json"))) as! [String:Any]
 let captured=document["captured"] as! [[String:Any]],vector=captured.first{($0["request"] as? [String:Any])?["operation"] as? String=="ingestSelected"}!
 let request=vector["request"] as! [String:Any],payload=request["payload"] as! [String:Any],selection=payload["selection"] as! [String:Any],run=payload["run"] as! [String:Any]
 func id(_ key:String)->UUID{UUID(uuidString:selection[key] as! String)!}
 let calendars=(selection["calendars"] as! [[String:Any]]).map{MobileCalendarSettingsWire.Selection.CalendarIdentity(containerID:$0["containerId"] as! String,accountID:$0["accountId"] as? String)}
 let selected=MobileCalendarSettingsWire.Selection(principal:id("principalId"),endpoint:id("endpointId"),enrollment:id("enrollmentId"),namespace:id("sourceNamespace"),revision:selection["configurationRevision"] as! Int,calendars:calendars)!
 let formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
 let settings=MobileCalendarSyncWindow(lookBackDays:1,lookAheadDays:3,timeZone:run["timeZone"] as! String)!,snapshot=settings.plan(anchor:formatter.date(from:run["anchorAt"] as! String)!,selectedCalendars:calendars.count,limits:.init(maxTotalDays:366,maxScans:8,maxSelectedCalendars:32)!)!
 let scoped=MobileCalendarSettingsWire.Run(selection:selected,snapshot:snapshot),items=try! (payload["items"] as! [[String:Any]]).map{try MobileCalendarDelivery.item(MobileCalendarDelivery.canonical($0))}
 let body=try! MobileCalendarSelectedDelivery.batch(items,run:scoped)
 check(body == (try! MobileCalendarDelivery.canonical(request)),"consumer matches ACTUAL frozen producer selected request byte-for-byte canonical")
 let raw=try! MobileCalendarDelivery.canonical(vector["response"]!),original=try! MobileCalendarSelectedDelivery.originalReceiptEnvelope(raw,expected:items)
 check((try! MobileCalendarDelivery.receipts(original,expected:items)).accepted.count==items.count,"actual producer receipt parsed through unchanged original semantics")
 check((try? MobileCalendarSettingsWire.originalReceiptEnvelope(raw,expected:items))==nil,"old settings parser cannot erase new producer provenance")
 var altered=vector["response"] as! [String:Any];altered["extra"]=true
 check((try? MobileCalendarSelectedDelivery.originalReceiptEnvelope(try! MobileCalendarDelivery.canonical(altered),expected:items))==nil,"closed actual new producer envelope")
 altered=vector["response"] as! [String:Any];altered["producerPin"]=MobileCalendarSettingsWire.pin
 check((try? MobileCalendarSelectedDelivery.originalReceiptEnvelope(try! MobileCalendarDelivery.canonical(altered),expected:items))==nil,"wrong producer cannot qualify selected receipt")
 check((try? MobileCalendarSelectedDelivery.batch([],run:scoped))==nil,"no empty selected delivery")
}
@MainActor func registrationReentryQualification(){
 let transport=NativeTransport(store:Store()),connection=NativeHealthConnectionOwner(transport:transport)
 var registration:NativeCalendarAppComposition.Registration!,nested:NativeCalendarSourceOwner?,calls=0
 registration=NativeCalendarAppComposition.registration{
  calls+=1
  if calls==1{nested=registration.bind(transport:transport,connection:connection)}
  return inputs()
 }
 let original=registration.bind(transport:transport,connection:connection)
 check(original != nil && nested==nil && calls==1,"reservation before resource callback refuses reentrant second SourceOwner")
 check(registration.bind(transport:transport,connection:connection) === original && calls==1,"positive retains same original after reservation publishes")
 print("registration reentry causal fixture passed")
}
@MainActor func run() async{
 selectedWireQualification()
 let connection=NativeHealthConnectionOwner(transport:transport)
 let registration=NativeCalendarAppComposition.registration(resources:inputs)
 check(resources==0 && homes==0 && files.opens==0 && sdks==0 && protection==0 && clocks==0 && store.loads==0 && store.writes==0,"registration is inert")
 let owner=registration.bind(transport:transport,connection:connection)
 #if LIFESTREAM_NATIVE_RECOVERY_DISABLED
 check(!registration.enabled && owner==nil && resources==0,"actual compiled recovery branch never builds resources")
 #else
 check(registration.enabled && owner != nil && resources==1,"actual normal registration binds original source")
 check(registration.bind(transport:transport,connection:connection) === owner && resources==1,"same original source retained")
 let second=NativeTransport(store:Store()),other=NativeHealthConnectionOwner(transport:second)
 check(registration.bind(transport:second,connection:other)==nil && resources==1,"binding cannot be transferred")
 for operation in 0..<5{
  let result:[String:Any]=await withCheckedContinuation{c in
   let done:([String:Any])->Void={c.resume(returning:$0)}
   switch operation{case 0:owner!.requestPermission(input:[:],completion:done);case 1:owner!.discover(input:[:],completion:done);case 2:owner!.prepare(input:[:],completion:done);case 3:owner!.save(input:[:],completion:done);default:owner!.reconcile(input:[:],completion:done)}
  }
  check(result["state"] as? String=="unavailable","unconfigured launch cannot seed identity/policy or query SDK")
 }
 owner!.withdraw()
 #endif
 check(homes==0 && files.opens==0 && sdks==0 && protection==0 && clocks==0 && store.loads==0 && store.writes==0 && files.handle.data==seededV4 && files.handle.reads==0 && files.handle.writes==0,"no automatic store, clock, SDK, credentials or recovery hold mutation")
 // An existing original Health profile is never silently replaced by launch.
 let plan=NativeHealthCollectionPlan(category:"sleep",scope:"synthetic-window",mappingVersion:"healthkit-v1",start:Date(timeIntervalSince1970:1793318400),end:Date(timeIntervalSince1970:1793404800))
 let healthConfig=NativeHealthRuntime.Configuration(provenance:"synthetic-original-health",origin:"https://offline.invalid",human:UUID(),session:UUID(),endpoint:UUID(),enrollment:UUID(),plans:[plan],maxBytes:8*1024*1024,maxEvents:100000,storageOrigin:"https://offline.invalid",protectedFilePolicy:"synthetic",protectedAvailable:{fatalError("no Health protection query")},makeStorage:{fatalError("no Health storage")},makeSDK:{fatalError("no Health SDK")})
 let profile=NativeHealthConnectionOwner.Profile(descriptor:.init(selector:"original-health",revision:1,title:"Synthetic Health",destinationLabel:"Synthetic",namespace:UUID(),configuration:healthConfig))!
 let occupied=NativeHealthConnectionOwner(transport:transport,profile:profile),host=occupied.host,beforeResources=resources
 let denied=NativeCalendarAppComposition.registration(resources:inputs)
 check(denied.bind(transport:transport,connection:occupied)==nil && occupied.host === host && resources==beforeResources,"original Health profile/host preserved without Calendar resources or takeover")
 let base=URL(fileURLWithPath:"/synthetic",isDirectory:true),expected=base.appendingPathComponent(NativeCalendarAppComposition.relativeSnapshot)
 var count=0,current=true
 let location=NativeCalendarAppComposition.Location(home:{count+=1;return base})
 check(count==0,"location construction inert")
 do{let first=try location.resolve(current:{current});let second=try location.resolve(current:{current});check(first==expected && first==second && count==1,"one exact lazy original binding")}
 catch{check(false,"valid location refused")}
 current=false
 do{_ = try location.resolve(current:{current});check(false,"stale cached binding accepted")}catch{}
 let mismatch=NativeCalendarAppComposition.Location(home:{base},knownOriginal:URL(fileURLWithPath:"/another/snapshot"))
 do{_ = try mismatch.resolve(current:{true});check(false,"known different original relocated")}catch{}
 current=true
 let reentry=NativeCalendarAppComposition.Location(home:{current=false;return base})
 do{_ = try reentry.resolve(current:{current});check(false,"home callback withdrawal ignored")}catch{}
 current=true
 let original=NativeCalendarAppComposition.Location(home:{base},knownOriginal:expected)
 do{let resolved=try original.resolve(current:{true});check(resolved==expected,"known original reused")}catch{check(false,"exact original rejected")}
 print("launch registration, original binding, withdrawal and recovery inactivity passed")
}


// Actual persistent Main producer over existing SSH. No HTTP listener or live API.
final class ProducerDriver {
 let process=Process(),input=Pipe(),output=Pipe();var serial=0,closed=false
 init(){
  process.executableURL=URL(fileURLWithPath:"/usr/bin/ssh")
  process.arguments=["-T","-o","BatchMode=yes","lifestream","/home/gg/.local/share/lifestream/toolchains/node-v24.21.0-linux-x64/bin/node","--experimental-transform-types",ProcessInfo.processInfo.environment["CALENDAR_PRODUCER_DRIVER"]!]
  process.standardInput=input;process.standardOutput=output;process.standardError=FileHandle.standardError
  try! process.run()
 }
 func call(_ command:String,_ arguments:[String:Any]=[:])->[String:Any]{
  serial+=1;let id=String(serial),frame=arguments.merging(["id":id,"command":command]){_,b in b}
  let bytes=try! JSONSerialization.data(withJSONObject:frame);try! input.fileHandleForWriting.write(contentsOf:bytes+Data([10]))
  var line=Data()
  while let byte=try! output.fileHandleForReading.read(upToCount:1),!byte.isEmpty{if byte[0]==10{break};line.append(byte);check(line.count<=1048576,"bounded actual producer frame")}
  guard let response=try? JSONSerialization.jsonObject(with:line) as? [String:Any] else{check(false,"actual producer closed without frame");return [:]}
  check(response["id"] as? String==id && response["kind"] as? String != "driverError","actual producer correlation/qualification refused: \(response["code"] ?? "none")")
  return response
 }
 func close(){guard !closed else{return};closed=true;_ = call("close");try? input.fileHandleForWriting.close();process.waitUntilExit();check(process.terminationStatus==0,"actual driver clean shutdown")}
}
var joinedDriver:ProducerDriver!,joinedIdentity:[String:Any]=[:],joinedOrigin="",joinedHideControl=false,joinedControls=0,joinedSelected=0,joinedSDKFactories=0,joinedQueries=0,joinedClocks=0,joinedProtected=true,joinedFileResolves=0
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
  if parsed?["producerPin"] != nil{joinedWireEvidence.append(["path":request.url!.path,"requestBodyBase64":body.base64EncodedString(),"status":reply["status"]!,"responseBodyBase64":bytes.base64EncodedString()])}
  client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:reply["status"] as! Int,httpVersion:nil,headerFields:fields)!,cacheStoragePolicy:.notAllowed)
  client?.urlProtocol(self,didLoad:bytes);client?.urlProtocolDidFinishLoading(self)
 }}
 override func stopLoading(){}
}
final class JoinedHandle:NativeCalendarFileHandle{
 var current=true,data:Data?,reads=0,writes=0,ambiguous=false
 func read()throws->Data?{reads+=1;return data}
 func replace(_ bytes:Data)throws{data=bytes;writes+=1;if ambiguous{throw CocoaError(.fileWriteUnknown)}}
 func close(){current=false}
}
final class JoinedFiles:NativeCalendarFilePort{
 let handle:JoinedHandle;var opens=0
 init(_ handle:JoinedHandle){self.handle=handle}
 func openExclusive(snapshot:URL)throws->any NativeCalendarFileHandle{opens+=1;return handle}
}
struct JoinedEvent:MobileEventKitEventReading{
 let start:Date,end:Date,container:String,account:String
 func readEvent()throws->MobileEventKitRawEvent{.init(item:.init(itemIdentifier:.observed("synthetic-series"),calendarIdentifier:.observed(container),accountIdentifier:.observed(account),externalIdentifier:.observed(nil),title:.observed("Synthetic occurrence"),notes:.observed(nil),recurrenceRules:.observed(nil)),startDate:.observed(start),endDate:.observed(end),isAllDay:.observed(false),timeZoneIdentifier:.observed("America/Chicago"),occurrenceDate:.observed(start),isDetached:.observed(true),statusRawValue:.observed(1),alarms:.observed(nil))}
}
final class JoinedEventStore:MobileEventKitStoreReading{
 func access(_ plan:MobileEventKitAcquisition.Plan)->MobileEventKitReadAccess{.fullRead}
 func enumerateEvents(_ plan:MobileEventKitAcquisition.Plan,yield:@escaping(any MobileEventKitEventReading)->Bool)throws{
  joinedQueries+=1
  _ = yield(JoinedEvent(start:plan.coverageStart.addingTimeInterval(300),end:plan.coverageStart.addingTimeInterval(600),container:plan.selectedContainerIDs[0],account:"synthetic-account"))
 }
 func fetchReminders(_ plan:MobileEventKitAcquisition.Plan,completion:@escaping((any MobileEventKitReminderBatch)?)->Void)throws->any MobileEventKitFetchToken{fatalError("no Reminders")}
 func cancelFetch(_ token:any MobileEventKitFetchToken){fatalError("no Reminders")}
}
final class JoinedSDK:NativeCalendarSelectionSDK{
 var status:NativeCalendarReadAccess = .notDetermined,permissionCalls=0,metadataCalls=0
 var capturedDefaultTimeZone:TimeZone{TimeZone(identifier:"America/Chicago")!}
 func access(category:String)->NativeCalendarReadAccess{check(category=="CalendarEvent","events only");return status}
 func request(category:String,current:()->Bool,completion:@escaping(Bool,Error?)->Void)->Bool{guard current() else{return false};permissionCalls+=1;status = .fullRead;completion(true,nil);return true}
 func eventCalendars(current:()->Bool)throws->[NativeCalendarMetadata]{guard current() else{throw NativeCalendarAdmissionError.stale};metadataCalls+=1;return ["native-selected","native-shared"].map{.init(containerID:$0,sourceID:"synthetic-account",title:"Same display name",sourceTitle:"Synthetic account",sourceKind:"CalDAV",delegated:nil)}}
 func acquisition(outbox:HealthOutbox,selected:[NativeCalendarMetadata],current:()->Bool)->MobileEventKitAcquisition?{guard current() else{return nil};return MobileEventKitAcquisition(outbox:outbox,storePort:JoinedEventStore(),executeOnWorker:{$0()})}
}
@MainActor func joinedTick()async{await withCheckedContinuation{(c:CheckedContinuation<Void,Never>) in DispatchQueue.main.asyncAfter(deadline:.now()+0.02){c.resume()}}}
@MainActor func joinedSource(_ source:NativeCalendarSourceOwner,_ kind:String,_ input:[String:Any]=[:])async->[String:Any]{await withCheckedContinuation{c in
 let done:([String:Any])->Void={c.resume(returning:$0)}
 switch kind{case "permission":source.requestPermission(input:input,completion:done);case "metadata":source.discover(input:input,completion:done);case "save":source.save(input:input,completion:done);case "recover":source.reconcile(input:input,completion:done);default:source.prepare(input:input,completion:done)}
}}
func joinedEvidence(_ scenario:String,_ handle:JoinedHandle){
 guard let directory=ProcessInfo.processInfo.environment["NATIVE_JOIN_EVIDENCE"] else{return}
 let root=URL(fileURLWithPath:directory,isDirectory:true)
 let value:[String:Any]=["schemaVersion":"1.0.0","syntheticOnly":true,"scenario":scenario,"actualOriginalProducer":true,"selectedPin":MobileCalendarSelectedDelivery.pin,"entries":joinedWireEvidence,"metrics":["controlInvocations":joinedControls,"selectedInvocations":joinedSelected,"sdkFactories":joinedSDKFactories,"eventQueries":joinedQueries,"fileResolves":joinedFileResolves,"clocks":joinedClocks],"notDeviceOrLiveAcceptance":true]
 try! JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]).write(to:root.appendingPathComponent("joined-"+scenario+"-wire.json"))
 if let bytes=handle.data{try! bytes.write(to:root.appendingPathComponent("joined-"+scenario+"-synthetic-v4.json"))}
}
@MainActor func joinedRun(_ scenario:String)async{
 joinedDriver=ProducerDriver();let opened=joinedDriver.call("open",["case":scenario=="denied" ? "deniedUnconfigured":"explicitApprovedSynthetic"])
 joinedIdentity=opened["syntheticIdentity"] as! [String:Any];joinedOrigin=opened["transportOrigin"] as! String
 let store=Store(),transport=NativeTransport(store:store);try! transport.configure("https://offline.invalid")
 let network=URLSessionConfiguration.ephemeral;network.protocolClasses=[ActualProducerNetwork.self];transport.session=URLSession(configuration:network,delegate:transport,delegateQueue:.main)
 // Actual token from original synthetic Auth setup; no effective-owner override.
 transport.csrf=joinedIdentity["csrf"] as! String
 let result=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}}
 guard case .success((_,let http))=result else{check(false,"actual Auth context transport");return};check(http.statusCode==200 && transport.effectiveIsSelf,"actual Auth determines ordinary self")
 let connection=NativeHealthConnectionOwner(transport:transport),sdk=JoinedSDK(),handle=JoinedHandle(),files=JoinedFiles(handle)
 let formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds];let anchor=formatter.date(from:"2026-11-01T18:00:00.123Z")!
 let registration=NativeCalendarAppComposition.registration{.init(resolveFile:{current in guard current() else{throw NativeCalendarAdmissionError.stale};joinedFileResolves+=1;return URL(fileURLWithPath:"/synthetic/Library/Application Support/Lifestream/mobile-context.snapshot.json")},filePort:files,limits:.init(maxTotalDays:366,maxScans:8,maxSelectedCalendars:32)!,maxBytes:8*1024*1024,maxEvents:100000,mappingVersion:NativeCalendarAppComposition.mappingVersion,protectedAvailable:{joinedProtected},clock:{joinedClocks+=1;return anchor},makeSDK:{joinedSDKFactories+=1;return sdk},deliveryContract:.selected)}
 let source=registration.bind(transport:transport,connection:connection)!
 transport.healthContextWillChange={source.withdraw();connection.withdraw(authorityChanged:$0)}
 check(joinedSDKFactories==0 && files.opens==0 && joinedClocks==0,"real registration stays inert")
 let permission=await joinedSource(source,"permission");check(permission["requestState"] as? String=="requestCompleted" && sdk.permissionCalls==1 && sdk.metadataCalls==0 && files.opens==0,"separate native permission, no grant or store")
 var catalog=await joinedSource(source,"metadata");check(catalog["state"] as? String=="available","actual self/phone metadata admission")
 let choices=catalog["choices"] as! [[String:Any]];check(choices.count==2 && choices.allSatisfy{$0["selected"] as? Bool==false && $0["sharing"] as? String=="unknown"},"shared/duplicate display metadata not guessed authority")
 let settings=MobileCalendarSyncWindow(lookBackDays:1,lookAheadDays:3,timeZone:"America/Chicago")!
 func prepareInput(_ catalog:[String:Any],_ settings:MobileCalendarSyncWindow,_ index:Int=0)->[String:Any]{["schemaVersion":"1.0.0","catalogId":catalog["catalogId"]!,"choices":[(catalog["choices"] as! [[String:Any]])[index]["choice"]!],"syncWindow":settings.json]}
 var preview=await joinedSource(source,"preview",prepareInput(catalog,settings));check(preview["state"] as? String=="prepared" && preview["anchor"] as? String=="2026-11-01T18:00:00.123Z" && joinedClocks==1 && files.opens==0,"exact fractional one-shot anchor; no duration defaults or implicit storage")
 let windows=preview["windows"] as! [[String:String]];check(windows.first?["start"]=="2026-10-31T17:00:00.123Z" && windows.last?["endExclusive"]=="2026-11-04T18:00:00.123Z" && windows.count==2,"full Chicago DST civil-day union, no midnight/rolling rounding")
 if scenario=="hidden"{joinedHideControl=true}
 var saved=await joinedSource(source,"save",["schemaVersion":"1.0.0","previewId":preview["previewId"]!])
 check(files.opens==1 && joinedFileResolves==1 && joinedQueries==0 && joinedSDKFactories==1,"one original SDK/file, Save never reads events")
 if scenario=="hidden"{
  check(saved["state"] as? String=="held" && joinedControls==1,"actual completed mutation hidden; exact original held")
  let before=handle.data,metadata=sdk.metadataCalls;_ = await joinedSource(source,"metadata");_ = await joinedSource(source,"save",["schemaVersion":"1.0.0","previewId":preview["previewId"]!]);check(handle.data==before && sdk.metadataCalls==metadata && joinedControls==1,"unknown denies replacement/replay")
  _ = joinedDriver.call("reopen")
  let recovered=await joinedSource(source,"recover");check(recovered["state"] as? String=="reconciled" && joinedControls==1,"exact original reconcile after real server cold reopen; no continuation")
  joinedEvidence(scenario,handle);joinedDriver.close();print("joined hidden actual producer passed");return
 }
 check(saved["state"] as? String=="saved","actual terminal saves settings")
 if scenario=="denied"{
  check(saved["activation"] as? String=="unavailable" && joinedQueries==0 && joinedSelected==0,"absent actual mapping/retention denies local activation and SDK read")
  let checkpoint=joinedDriver.call("checkpoint");check(checkpoint["records"] as? Int==0 && checkpoint["listening"] as? Bool==false,"actual denied producer has zero records/socket")
  joinedEvidence(scenario,handle);joinedDriver.close();print("joined denied actual producer passed");return
 }
 // New sources are paused/disconnected by the REAL producer. Save preserves
 // that, including in the approved-classification fixture. No implicit unpause.
 check(saved["activation"] as? String=="unavailable","initial actual source pause/disconnected preserved")
 let entry=joinedWireEvidence.last{entry in
  guard let raw=Data(base64Encoded:entry["requestBodyBase64"] as! String),let object=try? JSONSerialization.jsonObject(with:raw) as? [String:Any] else{return false}
  return object["operation"] as? String=="control" && ((object["payload"] as? [String:Any])?["action"] as? [String:Any])?["kind"] as? String=="configure"
 }!
 let command=try! MobileCalendarSettingsWire.command(Data(base64Encoded:entry["requestBodyBase64"] as! String)!),terminal=try! MobileCalendarSettingsWire.terminal(Data(base64Encoded:entry["responseBodyBase64"] as! String)!,original:command),existing=terminal.enrollment!
 check(existing.collectionPaused && existing.state=="disconnected" && joinedQueries==0,"actual original pause denies event read")
 // Explicit test-only source choice through ORIGINAL handler/command/terminal,
 // separate from mapping/retention and independent fixture collection consent.
 let activate=try! MobileCalendarSettingsWire.envelope(payload:["schemaVersion":"1.0.0","operationId":UUID().uuidString.lowercased(),"target":["principalId":existing.principal.uuidString.lowercased(),"endpointId":existing.endpoint.uuidString.lowercased(),"collector":"eventKit","enrollmentId":existing.id.uuidString.lowercased(),"sourceNamespace":existing.namespace!.uuidString.lowercased(),"expectedRevision":existing.revision],"action":["kind":"configure","state":"active","configuration":["sourceConfiguration":["categories":["CalendarEvent"],"uses":[],"assistantIds":[],"collectionPaused":false,"usePaused":true],"syncWindow":settings.json]]])
 let activationReply=joinedDriver.call("request",["method":"POST","path":"/api/runtime/v1/mobile-context","headers":[["cookie",joinedIdentity["cookie"] as! String],["x-lifestream-csrf",joinedIdentity["csrf"] as! String],["x-lifestream-user-context",joinedIdentity["contextRef"] as! String]],"bodyBase64":activate.original.base64EncodedString()])
 check(activationReply["status"] as? Int==200,"actual explicit fixture source decision")
 let activationRaw=Data(base64Encoded:activationReply["bodyBase64"] as! String)!,activated=try! MobileCalendarSettingsWire.terminal(activationRaw,original:activate)
 check(activated.applied && activated.current && activated.enrollment?.collectionPaused==false && activated.enrollment?.state=="active","only actual authenticated producer terminal qualifies fixture activation")
 joinedWireEvidence.append(["path":"/api/runtime/v1/mobile-context","fixtureExplicitSourceChoice":true,"requestBodyBase64":activate.original.base64EncodedString(),"status":200,"responseBodyBase64":activationRaw.base64EncodedString()])
 catalog=await joinedSource(source,"metadata");preview=await joinedSource(source,"preview",prepareInput(catalog,settings))
 saved=await joinedSource(source,"save",["schemaVersion":"1.0.0","previewId":preview["previewId"]!])
 check(saved["activation"] as? String=="manualOnly" && files.opens==1 && joinedFileResolves==1 && joinedSDKFactories==1,"fresh real policy and explicit source decision admit same original saved row")
 let host=connection.host
 for index in 0..<2{
  let available=host.calendarSavedChoices();let choices=available["choices"] as! [[String:Any]]
  check(choices.count==2,"every bounded window remains manually addressable")
  let request:[String:Any]=["schemaVersion":"1.0.0","catalogId":available["catalogId"]!,"choice":choices[index]["choice"]!]
  let reconnect:[String:Any]=await withCheckedContinuation{c in host.performCalendarSavedChoice(.reconnect,input:request){c.resume(returning:$0)}}
  check((reconnect["result"] as? [String:Any])?["outcome"] as? String=="reconnected","real original Host reconnect")
  for _ in 0..<3{await joinedTick()}
  check(host.calendarCollectionDetailsChoice(input:request)["reason"] as? String=="ready","manual original window review")
  let sync:[String:Any]=await withCheckedContinuation{c in host.calendarCollectAndDeliverChoice(input:request){c.resume(returning:$0)}}
  check((sync["result"] as? [String:Any])?["state"] as? String=="settledPrefix","actual SDK→Core→selected producer→original receipt settlement")
  for _ in 0..<3{await joinedTick()}
 }
 let checkpoint=joinedDriver.call("checkpoint");check(checkpoint["records"] as? Int==2 && checkpoint["listening"] as? Bool==false && joinedQueries==2 && joinedSelected==2,"both exact union windows delivered through non-listening actual producer")
 // The exact original selected body repeats only as an explicit server duplicate
 // qualification, never Native automatic retry. Producer/receipt bytes stay raw.
 let originalBody=joinedRequestBytes.first{(try? JSONSerialization.jsonObject(with:$0) as? [String:Any])?["operation"] as? String=="ingestSelected"}!
 _ = joinedDriver.call("reopen")
 let duplicate=joinedDriver.call("request",["method":"POST","path":"/api/runtime/v1/mobile-context","headers":[["cookie",joinedIdentity["cookie"] as! String],["x-lifestream-csrf",joinedIdentity["csrf"] as! String],["x-lifestream-user-context",joinedIdentity["contextRef"] as! String]],"bodyBase64":originalBody.base64EncodedString()])
 let raw=Data(base64Encoded:duplicate["bodyBase64"] as! String)!,root=try! JSONSerialization.jsonObject(with:raw) as! [String:Any]
 check(duplicate["status"] as? Int==200 && root["producerPin"] as? [String:String]==MobileCalendarSelectedDelivery.pin,"actual selected producer provenance retained after cold reopen")
 let receipts=(root["result"] as! [String:Any])["receipts"] as! [[String:Any]];check(receipts[0]["outcome"] as? String=="duplicate","exact item identity duplicate, no extra record")
 let before=handle.data;catalog=await joinedSource(source,"metadata");check(catalog["state"] as? String=="available" && files.opens==1 && handle.data==before,"actual original profile retires before edit, same snapshot")
 let edited=MobileCalendarSyncWindow(lookBackDays:2,lookAheadDays:5,timeZone:"America/Chicago")!
 preview=await joinedSource(source,"preview",prepareInput(catalog,edited,1));saved=await joinedSource(source,"save",["schemaVersion":"1.0.0","previewId":preview["previewId"]!]);check(saved["state"] as? String=="saved" && saved["activation"] as? String=="manualOnly" && files.opens==1 && joinedFileResolves==1 && joinedSDKFactories==1,"post-sync selection/duration edit through actual original revision/custody")
 check(joinedResponseBytes.contains{(try? JSONSerialization.jsonObject(with:$0) as? [String:Any])?["producerPin"] as? [String:String]==MobileCalendarSelectedDelivery.pin},"actual raw new-pin response captured, not generated")
 joinedEvidence(scenario,handle);source.withdraw();joinedDriver.close();print("joined positive actual producer passed")
}

Task{@MainActor in
 if CommandLine.arguments.count>1 && CommandLine.arguments[1]=="reentry"{registrationReentryQualification()}else if CommandLine.arguments.count>1{await joinedRun(CommandLine.arguments[1])}else{await run()}
 exit(0)
}
DispatchQueue.main.asyncAfter(deadline:.now()+110){fputs("FAIL: launch probe timed out\n",stderr);exit(2)}
RunLoop.main.run()
