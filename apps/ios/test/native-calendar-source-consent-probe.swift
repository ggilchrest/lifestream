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
 var current=true,data:Data?,reads=0,writes=0,ambiguous=false
 func read()throws->Data?{reads+=1;return data}
 func replace(_ bytes:Data)throws{data=bytes;writes+=1;try bytes.write(to:stateURL,options:.atomic);try bytes.write(to:stateURL.deletingLastPathComponent().appendingPathComponent("snapshot-\(stage)-\(writes).json"),options:.atomic);if let pending=((try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any])?["calendarNative"] as? [String:Any],pending["consentPending"] != nil{if cancelStage && (pending["consentPending"] as? [String:Any])?["attempted"] as? Bool==false{cancelStage=false;withdraw?()}};if ambiguous{throw CocoaError(.fileWriteUnknown)}}
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

@MainActor func consentCall(_ source:NativeCalendarSourceOwner,_ operation:String,_ input:[String:Any]=[:])async->[String:Any]{await withCheckedContinuation{c in source.sourceConsent(operation:operation,input:input){c.resume(returning:$0)}}}
@MainActor func run()async{
 let opened=try! JSONSerialization.jsonObject(with:Data(base64Encoded:ProcessInfo.processInfo.environment["CONSENT_DRIVER_OPEN"]!)!) as! [String:Any]
 joinedIdentity=opened["syntheticIdentity"] as! [String:Any];joinedOrigin=opened["transportOrigin"] as! String
 let transport=NativeTransport(store:Store());try! transport.configure("https://offline.invalid")
 let network=URLSessionConfiguration.ephemeral;network.protocolClasses=[ActualProducerNetwork.self];transport.session=URLSession(configuration:network,delegate:transport,delegateQueue:.main)
 transport.csrf=joinedIdentity["csrf"] as! String
 let auth=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}}
 guard case .success((_,let http))=auth else{check(false,"actual Auth transport");return};check(http.statusCode==200 && transport.effectiveIsSelf,"actual ordinary self")
 let connection=NativeHealthConnectionOwner(transport:transport),sdk=JoinedSDK(),handle=JoinedHandle(),files=JoinedFiles(handle)
 let registration=NativeCalendarAppComposition.registration{.init(resolveFile:{current in guard current() else{throw NativeCalendarAdmissionError.stale};joinedFileResolves+=1;return URL(fileURLWithPath:"/synthetic/Library/Application Support/Lifestream/mobile-context.snapshot.json")},filePort:files,limits:.init(maxTotalDays:366,maxScans:8,maxSelectedCalendars:32)!,maxBytes:8*1024*1024,maxEvents:100000,mappingVersion:NativeCalendarAppComposition.mappingVersion,protectedAvailable:{joinedProtected},clock:{joinedClocks+=1;return Date(timeIntervalSince1970:floor(Date().timeIntervalSince1970*1000)/1000)},makeSDK:{joinedSDKFactories+=1;return sdk},deliveryContract:.selected)}
 let source=registration.bind(transport:transport,connection:connection)!
 withdraw={source.withdraw()};transport.healthContextWillChange={source.withdraw();connection.withdraw(authorityChanged:$0)}
 check(files.opens==0 && joinedSDKFactories==0 && joinedQueries==0 && joinedClocks==0,"each new Native process starts INERT with current original file")
 func noSDK(){check(joinedSDKFactories==0 && joinedQueries==0 && sdk.permissionCalls==0 && sdk.metadataCalls==0,"consent/recovery/connect never touches OS/SDK/status/discovery/events")}
 func load()async->[String:Any]{let v=await consentCall(source,"load");check(v["state"] as? String=="review","actual Native source review: \(v["reason"] ?? "none")");return v}
 func request(_ review:[String:Any],_ purpose:String)async->[String:Any]{await consentCall(source,"request",["reviewId":review["reviewId"]!,"purpose":purpose,"validity":["kind":"untilRevoked"],"reviewDeadlineAt":ISO8601DateFormatter().string(from:Date().addingTimeInterval(120))])}
 func confirm(_ review:[String:Any])async->[String:Any]{await consentCall(source,"confirm",["reviewId":review["reviewId"]!,"humanConfirmed":true])}
 func bootstrap()async{
  let p=await joinedSource(source,"permission");check(p["requestState"] as? String=="requestCompleted","explicit OS request")
  let c=await joinedSource(source,"metadata"),choices=c["choices"] as! [[String:Any]],settings=MobileCalendarSyncWindow(lookBackDays:1,lookAheadDays:3,timeZone:"America/Chicago")!
  let p2=await joinedSource(source,"preview",["schemaVersion":"1.0.0","catalogId":c["catalogId"]!,"choices":[choices[0]["choice"]!],"syncWindow":settings.json]);check(p2["state"] as? String=="prepared","explicit selection: \(p2["reason"] ?? "none")")
  let saved=await joinedSource(source,"save",["schemaVersion":"1.0.0","previewId":p2["previewId"]!]);check(saved["state"] as? String=="saved","actual Save: \(saved["reason"] ?? "none")")
  check(joinedQueries==0,"Save never reads events")
 }
 if stage=="warm-connect"{
  await bootstrap()
  for purpose in ["collection","transmission"]{
   let review=await load(),reserved=await request(review,purpose);check(reserved["request"] != nil,"explicit same-process review")
   let result=await confirm(reserved);check(result["state"] as? String=="held","observed never grants locally")
   let settled=await consentCall(source,"recover");check(settled["state"] as? String=="recorded","same-process exact terminal")
  }
  let c=await consentCall(source,"connectionReview"),before=sdk.metadataCalls,queries=joinedQueries
  let connected=await consentCall(source,"connect",["connectionId":c["connectionId"]!,"humanConfirmed":true])
  check(connected["state"] as? String=="saved" && connected["activation"] as? String=="manualOnly" && sdk.metadataCalls==before && joinedQueries==queries,"warm actual Native Connect adopts only existing reviewed selection after fresh policy; zero SDK work")
 }else if stage=="delayed-request" || stage=="never-request"{
  await bootstrap();let review=await load();delayOperation="requestApproval";var result:[String:Any]?,callbacks=0
  source.sourceConsent(operation:"request",input:["reviewId":review["reviewId"]!,"purpose":"collection","validity":["kind":"untilRevoked"],"reviewDeadlineAt":ISO8601DateFormatter().string(from:Date().addingTimeInterval(120))]){result=$0;callbacks+=1}
  for _ in 0..<400{if delayedDelivery != nil || result != nil{break};await joinedTick()}
  check(delayedDelivery != nil && result==nil && source.busy,"entered real handler with no native callback retains original obligation")
  let disk=handle.data,posts=joinedRequestBytes.count
  _=await consentCall(source,"load");check(handle.data==disk && joinedRequestBytes.count==posts,"never callback denies replacement without timeout")
  if stage=="delayed-request"{let delivered=delayedDelivery;delayedDelivery=nil;delivered?();for _ in 0..<12{await joinedTick()};check(callbacks==1 && result?["state"] as? String=="review","actual delayed original reply settles only inert review once")}
 }else if stage=="bootstrap" || stage=="denied" || stage=="cancel-stage"{
  await bootstrap();let reviewed=await load()
  if stage=="denied"{let r=await request(reviewed,"collection");check(r["state"] as? String != "recorded","unconfigured actual policy grants nothing");return}
  if stage=="cancel-stage"{cancelStage=true}else{hideOperation="requestApproval"}
  let r=await request(reviewed,"collection");check(r["state"] as? String=="held","unknown request keeps original hold")
  let before=handle.data,controls=joinedControls,sdkCalls=sdk.metadataCalls
  _=await consentCall(source,"load");_=await request(reviewed,"transmission");_=await joinedSource(source,"metadata")
  check(handle.data==before && joinedControls==controls && sdk.metadataCalls==sdkCalls,"held denies replacement/replay/discovery")
 }else if stage=="recover-request-approve"{
  let r=await consentCall(source,"recover");check(r["state"] as? String=="review" && r["request"] != nil,"new Native process exact request reconcile produces inert review")
  let before=handle.data;let invalid=await consentCall(source,"confirm",["reviewId":r["reviewId"]!,"humanConfirmed":false]);check(invalid["state"] as? String != "recorded" && handle.data==before,"unchecked confirmation never grants")
  // Invalid attempts consume a UI review. Recover the SAME durable request.
  let again=await consentCall(source,"recover");check(again["state"] as? String=="review","same request remains recoverable")
  hideOperation="approve";let approved=await confirm(again);check(approved["state"] as? String=="held","approval completed hidden original remains held");noSDK()
 }else if stage=="recover-approval-transmission"{
  let r=await consentCall(source,"recover");check(r["state"] as? String=="recorded" && r["decision"] as? String=="approved","new Native process exact approval terminal")
  let review=await load(),statuses=review["statuses"] as! [[String:Any]]
  check(statuses.first{$0["purpose"] as? String=="collection"}?["consentState"] as? String=="valid" && statuses.first{$0["purpose"] as? String=="transmission"}?["consentState"] as? String=="absent","collection never implies transmission")
  let reserved=await request(review,"transmission");check(reserved["request"] != nil,"separate transmission review")
  let reply=await confirm(reserved);check(reply["state"] as? String=="held","observed alone never settles approval")
  let settled=await consentCall(source,"recover");check(settled["state"] as? String=="recorded","explicit exact transmission reconciliation")
  let connectionReview=await consentCall(source,"connectionReview");check(connectionReview["state"] as? String=="connectionReview" && connectionReview["collectionPaused"] as? Bool==true && connectionReview["sourceState"] as? String=="disconnected","consent terminal never connects paused source")
  let priorReads=policyReads,unavailable=ProcessInfo.processInfo.environment["CONSENT_POST_POLICY_UNAVAILABLE"]=="1"
  hidePostConnectPolicy=unavailable
  let connected=await consentCall(source,"connect",["connectionId":connectionReview["connectionId"]!,"humanConfirmed":true]);check(connected["state"] as? String=="connected" && connected["activation"] as? String=="unavailable","actual Native Connect changes remote connection; cold selection remains unavailable")
  check(policyReads==priorReads+2,"Connect observes actual original policy BEFORE and AFTER known configure even without preview")
  check(policyValues[policyValues.count-(unavailable ? 1:2)]==false,"paused bootstrap policy observation is denial; connection never requires combined allow true")
  if unavailable{check(connected["reason"] as? String=="connected_policy_unavailable" && connected["policyObservation"] as? String=="unavailable","known connection remains known when actual post-policy response is unavailable")}
  else{check(connected["reason"] as? String=="local_selection_review_required" && connected["policyObservation"] as? String=="allowed","fresh allowed policy never invents a cold local selection")}
  let retained=try! JSONSerialization.jsonObject(with:handle.data!) as! [String:Any],native=retained["calendarNative"] as! [String:Any]
  check(native["pending"]==nil && native["terminal"] != nil,"known configure terminal remains persisted; not converted to unknown")
  noSDK()
 }else if stage=="selection-sync"{
  await bootstrap()
  let catalog=connection.host.calendarSavedChoices();check(catalog["state"] as? String=="available","source locally admitted only after actual effective policy")
  let row=(catalog["choices"] as! [[String:Any]])[0],input:[String:Any]=["schemaVersion":"1.0.0","catalogId":catalog["catalogId"]!,"choice":row["choice"]!]
  let reconnect=await withCheckedContinuation{c in connection.host.performCalendarSavedChoice(.reconnect,input:input){c.resume(returning:$0)}};check(reconnect["reason"] as? String=="ready","explicit saved reconnect")
  for _ in 0..<3{await joinedTick()}
  check(connection.host.calendarCollectionDetailsChoice(input:input)["reason"] as? String=="ready","separate explicit collection/destination review")
  let sync=await withCheckedContinuation{c in connection.host.calendarCollectAndDeliverChoice(input:input){c.resume(returning:$0)}}
  let result=sync["result"] as? [String:Any];check(result?["state"] as? String=="settledPrefix" && (result?["acceptedOrDuplicate"] as? Int ?? 0)>0 && joinedSelected==1 && joinedQueries==1,"actual Native selected2768 and actual production SQL receipt")
 }else if stage=="revoke"{
  let review=await load();hideOperation="revoke"
  let r=await consentCall(source,"revoke",["reviewId":review["reviewId"]!,"purpose":"transmission","humanConfirmed":true]);check(r["state"] as? String=="held","unknown revoke preserved");noSDK()
 }else if stage=="recover-revocation"{
  let r=await consentCall(source,"recover");check(r["state"] as? String=="recorded" && r["decision"] as? String=="revoked","actual cold revocation terminal")
  let review=await load();check((review["statuses"] as! [[String:Any]]).contains{$0["purpose"] as? String=="transmission" && $0["consentState"] as? String=="revoked"},"actual recorded revocation status")
  let c=await consentCall(source,"connectionReview"),before=joinedControls
  _=await consentCall(source,"connect",["connectionId":c["connectionId"]!,"humanConfirmed":true]);check(joinedControls==before,"revoked transmission denies Connect mutation");noSDK()
 }
 let checkpoint=joinedDriver.call("checkpoint");check(checkpoint["listening"] as? Bool==false,"no listening socket")
}

final class WireStore:HealthSnapshotStorage{var data:Data?,writes=0;func read()throws->Data?{data};func replace(_ bytes:Data)throws{data=bytes;writes+=1}}
func wireQualification(){
 let root=URL(fileURLWithPath:ProcessInfo.processInfo.environment["CONSENT_CONTRACT_FREEZE"]!),v=try! JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent("ACTUAL-VECTORS.json"))) as! [String:Any]
 let frames=v["transcript"] as! [[String:Any]];var count=0,originals:[String:MobileCalendarSourceConsent.Original]=[:],reserved:[String:Data]=[:],terminals:[String:Data]=[:]
 for frame in frames where frame["path"] as? String=="/api/runtime/v1/mobile-context-policy"{
  let req=Data(base64Encoded:frame["requestBodyBase64"] as! String)!,resp=Data(base64Encoded:frame["responseBodyBase64"] as! String)!,request=try! JSONSerialization.jsonObject(with:req) as! [String:Any]
  if frame["status"] as? Int != 200 || request["producerPin"] as? [String:String] != MobileCalendarSourceConsent.pin{continue}
  let payload=request["payload"] as! [String:Any],op=request["operation"] as! String
  let original:MobileCalendarSourceConsent.Original?
  if ["requestApproval","approve","revoke","reconcile"].contains(op){
   let kind=payload["command"] as! String,operation=kind=="requestSourceConsent" ? "requestApproval":kind=="approveSourceConsent" ? "approve":"revoke"
   original=try! MobileCalendarSourceConsent.command(MobileCalendarSourceConsent.canonical(["producerPin":MobileCalendarSourceConsent.pin,"operation":operation,"payload":payload]));originals[original!.digest]=original
  }else{original=nil}
  let scope=op=="inspect" ? try! MobileCalendarSourceConsent.scope(payload):nil
  let parsed=try! MobileCalendarSourceConsent.response(resp,expected:original,expectedScope:scope);count+=1
  switch parsed{case .reserved(let r):reserved[r.original.digest]=resp;case .terminal(let t):terminals[t.original.digest]=resp;default:break}
  var altered=try! JSONSerialization.jsonObject(with:resp) as! [String:Any];altered["extra"]=true
  check((try? MobileCalendarSourceConsent.response(try! MobileCalendarSourceConsent.canonical(altered),expected:original))==nil,"closed actual response refuses extra keys")
  altered=try! JSONSerialization.jsonObject(with:resp) as! [String:Any];altered["producerPin"]=MobileCalendarSettingsWire.pin
  check((try? MobileCalendarSourceConsent.response(try! MobileCalendarSourceConsent.canonical(altered),expected:original))==nil,"historical3d cannot replace97ef")
  if let original{
   check((try? MobileCalendarSettingsWire.command(original.original))==nil,"new consent never widens historical3d command parser")
   var forged=original.json;forged["expectedRevision"]=true
   check((try? MobileCalendarSourceConsent.command(try! MobileCalendarSourceConsent.canonical(["producerPin":MobileCalendarSourceConsent.pin,"operation":op,"payload":forged])))==nil,"boolean cannot impersonate revision")
   if let raw=String(data:original.original,encoding:.utf8){let duplicate=Data((String(raw.dropLast())+",\"operation\":\"approve\"}").utf8);check((try? MobileCalendarSourceConsent.command(duplicate))==nil,"duplicate key denied before command")}
  }
 }
 check(count>=20,"actual complete contract transcript covered")
 let approved=originals.values.first{$0.kind == .approve && terminals[$0.digest] != nil}!,request=try! MobileCalendarSourceConsent.command(MobileCalendarSourceConsent.canonical(["producerPin":MobileCalendarSourceConsent.pin,"operation":"requestApproval","payload":try! JSONSerialization.jsonObject(with:approved.request!)])),review=reserved[request.digest]!
 let disk=WireStore(),box=HealthOutbox(storage:disk),human=request.scope.principal,binding=HealthOutbox.CalendarNativeBinding(origin:"https://offline.invalid",principal:human,session:UUID(),endpoint:UUID()),health=UUID()
 try! box.setHuman(human);try! box.enroll(health,human:human,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:"synthetic-health")
 let ticket=try! box.ticket(enrollment:health,type:"sleep");try! box.commit(scope:"synthetic-anchor",expectedAnchor:nil,nextAnchor:Data([1,2]),changes:[.init(upstreamId:"synthetic-health-item",operation:.upsert,body:Data([3]),expectedPolicyRevision:1,mappingVersion:"synthetic/1")],ticket:ticket)
 func healthBytes()->Data{let value=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any];return try! JSONSerialization.data(withJSONObject:value["enrollments"]!,options:[.sortedKeys,.fragmentsAllowed])}
 let prior=healthBytes();try! box.stageCalendarSourceConsent(binding:binding,original:request.original)
 let pending=try! box.calendarSourceConsentPending(origin:binding.origin,principal:human,endpoint:binding.endpoint)!
 check(!pending.attempted && pending.original==request.original,"exact request staged before attempt")
 try! box.markCalendarSourceConsentAttempted(binding:binding,original:request.original);try! box.settleCalendarSourceConsent(binding:binding,original:request.original,response:review,reconciliation:false)
 check(healthBytes()==prior,"mixed Health anchors and queue preserved by request/reserved")
 try! box.stageCalendarSourceConsent(binding:binding,original:approved.original);try! box.markCalendarSourceConsentAttempted(binding:binding,original:approved.original)
 try! box.settleCalendarSourceConsent(binding:binding,original:approved.original,response:terminals[approved.digest]!,reconciliation:true)
 check(healthBytes()==prior,"mixed Health preserved by actual approval terminal")
 let current=HealthOutbox(storage:disk);check((try! current.calendarSourceConsentLastOriginal(origin:binding.origin,principal:human,endpoint:binding.endpoint))==approved.original,"new Core reads latest settled semantics after cold recreation")
 fputs("PASS actual97ef wire \(count) frames and original Core mixed-state custody\n",stderr)
}
if stage=="recovery-read"{
    let transport=NativeTransport(store:Store()),connection=NativeHealthConnectionOwner(transport:transport)
    let registration=NativeCalendarAppComposition.registration{fatalError("disabled recovery evaluated resources")}
    check(!registration.enabled && registration.bind(transport:transport,connection:connection)==nil,"actual compiled disabled branch remains inert")
    for path in CommandLine.arguments.dropFirst(2){
        let original=try! Data(contentsOf:URL(fileURLWithPath:path)),raw=try! JSONSerialization.jsonObject(with:original) as! [String:Any],disk=WireStore();disk.data=original
        let box=HealthOutbox(storage:disk);try! box.setHuman(UUID(uuidString:raw["lastHuman"] as! String)!)
        check(disk.data==original && disk.writes==0,"latest disabled Core reads current pending/reserved/terminal, zero writes")
    }
    fputs("PASS actual latest disabled recovery reader \(CommandLine.arguments.count-2) snapshots\n",stderr);exit(0)
}
if stage=="wire"{wireQualification();exit(0)}
Task{@MainActor in await run();fputs("PASS native \(stage)\n",stderr);exit(0)}
DispatchQueue.main.asyncAfter(deadline:.now()+65){fputs("FAIL native timeout\n",stderr);exit(2)}
RunLoop.main.run()
