import Foundation
import AssistantCore
// TEST ONLY: explicit verified synthetic source scope for the stricter request fence.
let syntheticVerifiedCalendarScope=MobileCalendarSyncScope(containers:["selected","fixture-calendar","synthetic-calendar"].map{.init(id:$0,accountID:"synthetic-account")},start:Date(timeIntervalSince1970:1790812800),end:Date(timeIntervalSince1970:1798761600),mappingVersion:"synthetic-calendar-mapping/1")!


// TEST ONLY: original external transport/storage/custody inputs are synthetic.
// Actual connection owner, Host, Runtime, policy, Core and delivery execute unchanged.
let mode=CommandLine.arguments[1],site=CommandLine.arguments[2]
func check(_ b:@autoclosure()->Bool,_ m:String){if !b(){fputs("FAIL: \(m)\n",stderr);exit(1)}}
func bytes(_ v:Any)->Data{try! JSONSerialization.data(withJSONObject:v,options:[.sortedKeys,.withoutEscapingSlashes])}
let human=UUID(uuidString:"50000000-0000-4000-8000-000000000001")!,sessionID=UUID(uuidString:"00000000-0000-4000-8000-000000000003")!,endpoint=UUID(uuidString:"60000000-0000-4000-8000-000000000001")!
let enrollment=UUID(uuidString:"30000000-0000-4000-8000-000000000001")!,namespace=UUID(uuidString:"10000000-0000-4000-8000-000000000001")!
let fixture=try! JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:ProcessInfo.processInfo.environment["CALENDAR_FIXTURE"]!))) as! [String:Any]
let origin="https://offline.invalid"
var requests=0,posts=0,allocations=0,custodyCalls=0,reentryCount=0
var connection:NativeHealthConnectionOwner?,profile:NativeCalendarSavedProfile?,input:[String:Any]=[:]
final class Store:ConnectionStore{var value:SavedConnection?;func load()throws->SavedConnection?{value};func save(_ v:SavedConnection)throws{value=v}}
func queueRows(_ data:Data?)->[[String:Any]]{guard let data,let value=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else{return []};return (value["calendarEnrollments"] as? [Any] ?? []).compactMap{$0 as? [String:Any]}}
func queueBytes(_ data:Data?)->Data{bytes(queueRows(data).map{$0["queue"] ?? []})}
func queueCount(_ data:Data?)->Int{queueRows(data).reduce(0){$0+(($1["queue"] as? [Any])?.count ?? 0)}}
final class Disk:HealthSnapshotStorage{var data:Data?,reads=0,writes=0,failAfter=false,failOnEmptyQueue=false;func read()throws->Data?{reads+=1;return data};func replace(_ d:Data)throws{writes+=1;data=d;if failAfter || failOnEmptyQueue && queueCount(d)==0{throw CocoaError(.fileWriteUnknown)}}}
let disk=Disk(),transport=NativeTransport(store:Store()),originalOwner=NSObject()
final class Custody:NativeSharedOutboxCustodyLease{
 let original:Disk,binding:NativeSharedOutboxOwner.Binding;var released=false
 init(_ d:Disk,_ b:NativeSharedOutboxOwner.Binding){original=d;binding=b}
 func isCurrent(storage:any HealthSnapshotStorage,binding:NativeSharedOutboxOwner.Binding)->Bool{!released && (storage as? Disk) === original && self.binding==binding}
 func withFence<T>(_ body:()throws->T)throws->T{guard !released else{throw CocoaError(.fileReadNoPermission)};return try body()}
 func admissionCurrency(binding:NativeCalendarAdmissionCurrency.Binding)->NativeCalendarAdmissionCurrency?{NativeCalendarAdmissionCurrency(owner:self,binding:binding)}
 func release(){check(!released,"original custody releases once");released=true}
}
func rootConfiguration()->NativeHealthRuntime.RootConfiguration{
 .init(identity:.init(provenance:"fixture-original-root",origin:origin,human:human,session:sessionID,endpoint:endpoint,maxBytes:8*1024*1024,maxEvents:100_000,storageOrigin:origin,protectedFilePolicy:"fixture-in-memory"),protectedAvailable:{true},makeStorage:{
  allocations+=1
  if mode=="fences" && site=="duplicate"{
   let host=connection!.host
   host.performCalendarSavedChoice(.reconnect,input:input){check($0["reason"] as? String=="busy","same wrapper reentry refused");reentryCount+=1}
   host.reconnectCalendar(selection:"fixture-native-selector"){check($0.outcome == .notApplied,"direct API cannot borrow stored permit");reentryCount+=1}
   host.setup(selection:"fixture-health",action:.enrollExistingRemote){check((try? $0.get())==nil,"cross Health entry refused");reentryCount+=1}
  }
  return disk
 })
}
func descriptor(_ invalid:Bool=false,_ missing:Bool=false)->NativeCalendarSavedDescriptor{
 let root=rootConfiguration()
 let config=NativeCalendarAcquisitionOwner.Configuration(provenance:"fixture-original-calendar",origin:origin,human:human,session:sessionID,endpoint:endpoint,enrollment:enrollment,namespace:namespace,plan:.init(category:"CalendarEvent",selectedContainerIDs:["fixture-calendar"],mappingVersion:"synthetic-calendar-mapping/1",coverageStart:Date(timeIntervalSince1970:1793404800),coverageEnd:Date(timeIntervalSince1970:1793491200),capturedSDKDefaultTimeZone:TimeZone(secondsFromGMT:0)!),protectedAvailable:{true},deliveryScope:syntheticVerifiedCalendarScope)
 let categories:Set<String>=["CalendarEvent","Task"]
 let currency=NativeCalendarAdmissionCurrency(owner:originalOwner,binding:.init(root:root.identity,configuration:config,selected:categories,kind:.reconnectExistingLocal))
 let configured=NativeHealthRuntime.CalendarConfiguration(configuration:config,custody:{storage,binding in custodyCalls+=1;check((storage as? Disk) === disk,"original snapshot custody only");return Custody(disk,binding)},makeAcquisition:nil,captureClock:{check(false,"no capture clock or SDK in reconnect/pending");return Date()})
 return .init(selector:"fixture-native-selector",label:invalid ? "":"Synthetic saved Calendar",destinationLabel:"Synthetic destination",selection:.init(runtimeSelection:"fixture-root",configuration:configured,reconnect:.init(owner:originalOwner,currency:missing ? nil:currency,expectedSavedCategories:categories)))
}
func seed(){
 check(fixture["syntheticOnly"] as? Bool==true,"synthetic fixture only")
 let box=HealthOutbox(storage:disk),proof=try! MobileCalendarPolicyParser.parse(bytes(fixture["policy"]!),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:enrollment)
 try! box.setHuman(human);try! box.admitCalendar(proof:proof)
 if !(mode=="pending" && site=="empty"){
  var item=(fixture["vectors"] as! [[String:Any]])[0]["item"] as! [String:Any],change=item["change"] as! [String:Any];change["expectedPolicyRevision"]=proof.revision;var source=change["source"] as! [String:Any];source["accountId"]="synthetic-account";change["source"]=source;var record=change["record"] as! [String:Any];var time=record["time"] as! [String:Any];time["timeZone"]=["kind":"supplied","identifier":"UTC"];record["time"]=time;change["record"]=record;item["change"]=change
  let scope=try! MobileCalendarDelivery.CheckpointScope(collector:"eventKit",namespace:namespace,mappingVersion:"synthetic-calendar-mapping/1",coverage:.partial,start:"2026-10-01T00:00:00Z",end:"2026-10-02T00:00:00Z")
  try! box.commitCalendar(scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([9]),items:[bytes(item)],ticket:box.calendarTicket(enrollment:enrollment,category:"CalendarEvent"))
 }
 if mode=="reconnect" && site=="failed"{
  var state=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any],rows=state["calendarEnrollments"] as! [Any],row=rows[1] as! [String:Any];row["paused"]=true;rows[1]=row;state["calendarEnrollments"]=rows;disk.data=bytes(state)
 }
 disk.reads=0;disk.writes=0
}
func requestBody(_ r:URLRequest)->Data{
 if let d=r.httpBody{return d};guard let stream=r.httpBodyStream else{return Data()};stream.open();defer{stream.close()};var d=Data(),buffer=[UInt8](repeating:0,count:4096)
 while stream.hasBytesAvailable{let n=stream.read(&buffer,maxLength:buffer.count);if n<=0{break};d.append(buffer,count:n)};return d
}
final class Offline:URLProtocol{
 override class func canInit(with r:URLRequest)->Bool{true}
 override class func canonicalRequest(for r:URLRequest)->URLRequest{r}
 override func startLoading(){DispatchQueue.main.async{[self] in
  requests+=1;check(request.url?.host=="offline.invalid","no live origin")
  func send(_ v:Any){client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!,cacheStoragePolicy:.notAllowed);client?.urlProtocol(self,didLoad:bytes(v));client?.urlProtocolDidFinishLoading(self)}
  switch request.url!.path{
  case "/api/auth/v1/session":send(["csrfToken":"synthetic-csrf"])
  case "/api/auth/v1/user-context":send(["producerPin":["schemaId":"https://lifestream.dev/contracts/effective-subject/1.0.0","schemaVersion":"1.0.0","digest":"ed098cad970a310a807881ea7a833b96f1c980e8377ee3cfcbdffd68f2bd0cf9"],"contextRef":"synthetic-current","context":["schemaVersion":"1.0.0","actorId":human.uuidString.lowercased(),"effectiveUserId":human.uuidString.lowercased(),"authenticatedSessionId":sessionID.uuidString.lowercased(),"installationId":"00000000-0000-4000-8000-000000000009","authorityRevision":1,"generation":1,"issuedAt":"2026-10-30T00:00:00Z"],"actor":["principalId":human.uuidString.lowercased()],"effectiveUser":["principalId":human.uuidString.lowercased()],"impersonating":false])
  case "/api/runtime/v1/session-context":send(["ended":false,"revision":1,"contextGeneration":1,"endpoint":["endpointId":endpoint.uuidString.lowercased(),"privacyClass":"personal","configurationRevision":1]])
  case "/api/runtime/v1/mobile-context":
   let body=try! JSONSerialization.jsonObject(with:requestBody(request)) as! [String:Any];check(body["operation"] as? String=="calendar","only original Calendar contract")
   let payload=body["payload"] as! [String:Any]
   if payload["operation"] as? String=="policy"{
    if mode=="reconnect" && site=="late-context"{transport.epoch+=1}
    send(fixture["policy"]!);return
   }
   check(payload["operation"] as? String=="ingest","no new remote enrollment/permission/mutation")
   posts+=1
   if mode=="pending" && site=="transport"{client?.urlProtocol(self,didFailWithError:URLError(.networkConnectionLost));return}
   if mode=="pending" && site=="receipt"{send(["invalid":true]);return}
   if mode=="pending" && site=="unconfirmed" || mode=="fences" && site=="unknown-hold"{disk.failOnEmptyQueue=true}
   let items=(payload["items"] as! [[String:Any]]).map{try! MobileCalendarDelivery.item(bytes($0))}
   send(["schemaVersion":"1.0.0","producerPin":fixture["producerPin"]!,"result":["kind":"sync","receipts":items.map{["eventId":$0.eventId.uuidString.lowercased(),"requestDigest":$0.digest,"outcome":"accepted","code":"applied","durability":"sqlCommit"]}]])
  default:check(false,"no unrelated route")
  }
 }}
 override func stopLoading(){}
}
func chosen(_ catalog:[String:Any])->[String:Any]{
 check(catalog["state"] as? String=="available","configured hints available")
 let choices=catalog["choices"] as! [[String:Any]];check(choices.count==1 && choices[0]["pendingDeliveryReady"] as? Bool==false,"configured hint never readies delivery")
 return ["schemaVersion":"1.0.0","catalogId":catalog["catalogId"]!,"choice":choices[0]["choice"]!]
}
@MainActor func action(_ op:NativeHealthHost.CalendarSavedOperation,_ request:[String:Any],_ host:NativeHealthHost) async->[String:Any]{await withCheckedContinuation{c in host.performCalendarSavedChoice(op,input:request){c.resume(returning:$0)}}}
@MainActor func run() async{
 try! transport.configure(origin)
 let c=URLSessionConfiguration.ephemeral;c.protocolClasses=[Offline.self];transport.session=URLSession(configuration:c,delegate:transport,delegateQueue:.main)
 _=await withCheckedContinuation{c in transport.request("/api/auth/v1/session"){c.resume(returning:$0)}}
 _=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}}
 seed();let before=requests
 if mode=="defaults"{
  if site=="missing-currency"{check(NativeCalendarSavedProfile(root:rootConfiguration(),descriptors:[descriptor(false,true)])==nil,"missing original currency refused")}
  if site=="invalid-descriptor"{check(NativeCalendarSavedProfile(root:rootConfiguration(),descriptors:[descriptor(true)])==nil,"invalid label refused")}
  connection=NativeHealthConnectionOwner(transport:transport);check(connection!.host.calendarSavedChoices()["state"] as? String=="unavailable","default unavailable");check(allocations==0 && disk.reads==0 && disk.writes==0 && requests==before,"default/profile construction inert");return
 }
 profile=NativeCalendarSavedProfile(root:rootConfiguration(),descriptors:[descriptor()]);check(profile != nil,"valid ORIGINAL native inputs")
 connection=NativeHealthConnectionOwner(transport:transport,calendarProfile:profile!);let host=connection!.host
 transport.healthContextWillChange={connection?.withdraw(authorityChanged:$0)}
 check(allocations==0 && disk.reads==0 && disk.writes==0 && requests==before,"binding inert")
 if mode=="binding" && site=="revoked"{profile!.revoke();check(host.calendarSavedChoices()["state"] as? String=="unavailable","revoked source unavailable");return}
 if mode=="binding"{
  let second=NativeHealthConnectionOwner(transport:transport,calendarProfile:profile!);check(second.host.calendarSavedChoices()["state"] as? String=="unavailable","cannot rebind second host");second.withdraw(authorityChanged:true)
 }
 let catalog=host.calendarSavedChoices();input=chosen(catalog)
 check(allocations==0 && disk.reads==0 && disk.writes==0 && custodyCalls==0 && requests==before,"catalog invokes no provider/store/HTTP/custody")
 if mode=="binding"{return}
 if mode=="catalog" && site=="opaque-only"{let text=String(data:bytes(catalog),encoding:.utf8)!;for secret in ["fixture-native-selector",namespace.uuidString.lowercased(),enrollment.uuidString.lowercased(),"rootConfiguration","policyRevision"]{check(!text.contains(secret),"native identifiers/config not exported")};return}
 if mode=="catalog" && site=="inert"{return}
 if mode=="catalog" && site=="refresh"{_ = host.calendarSavedChoices();let value=await action(.reconnect,input,host);check(value["reason"] as? String=="invalid_choice","new catalog invalidates old choice");check(allocations==0,"stale handle invokes nothing");return}
 if mode=="request"{
  if site=="extra"{input["selection"]="fixture-native-selector"};if site=="forged-catalog"{input["catalogId"]=UUID().uuidString.lowercased()};if site=="forged-choice"{input["choice"]=UUID().uuidString.lowercased()};if site=="stale"{_ = host.calendarSavedChoices()}
  let v=await action(.reconnect,input,host);check(v["reason"] as? String=="invalid_choice" && allocations==0 && requests==before,"closed request no provider effects");return
 }
 if mode=="fences" && site=="context"{transport.epoch+=1;let v=await action(.reconnect,input,host);check(v["reason"] as? String=="context_changed" && allocations==0,"stale native context no action");return}
 if mode=="fences" && site=="profile-revoke"{profile!.revoke();let v=await action(.reconnect,input,host);check(v["reason"] as? String != "ready" && allocations==0,"revoked catalog no action");return}
 if mode=="pending" && site=="before-reconnect"{let v=await action(.deliverPending,input,host);check(v["reason"] as? String=="unavailable" && allocations==0 && posts==0,"hint alone cannot deliver");return}
 let beforeData=disk.data,reconnected=await action(.reconnect,input,host),result=reconnected["result"] as! [String:Any]
 check(disk.data==beforeData && disk.writes==0 && posts==0,"actual reconnect is read-only and does not deliver")
 if mode=="reconnect" && site != "positive"{check(reconnected["reason"] as? String != "ready" && result["outcome"] as? String=="notApplied","failed/late result never ready");let v=await action(.deliverPending,input,host);check(v["reason"] as? String != "ready" && posts==0,"failed reconnect cannot deliver");return}
 check(reconnected["reason"] as? String=="ready" && result["outcome"] as? String=="reconnected" && result["snapshotWrite"] as? String=="notRequested","original saved reconnect completed")
 check(allocations==1,"one original root/store")
 if mode=="reconnect"{return}
 if mode=="fences" && site=="duplicate"{check(reentryCount==3,"stored permit excludes wrapper/direct/Health reentry");return}
 let delivered=await action(.deliverPending,input,host),delivery=delivered["result"] as! [String:Any],state=delivery["state"] as? String
 if site=="empty"{check(state=="emptyPending" && posts==0,"empty pending no ingest")}
 else if site=="transport" || site=="receipt"{check(state=="retained" && delivery["reason"] as? String==site && queueBytes(disk.data)==queueBytes(beforeData) && queueCount(disk.data)==1,"transport/receipt retains exact queue payload despite original policy metadata refresh")}
 else if site=="unconfirmed" || site=="unknown-hold"{
  check(state=="unconfirmed" && delivered["reason"] as? String != "ready","unknown settlement not success")
  let held=disk.data,writes=disk.writes,count=requests;_ = await action(.deliverPending,input,host);connection!.withdraw();let second=NativeHealthConnectionOwner(transport:transport,calendarProfile:profile!);_ = second.host.calendarSavedChoices()
  check(connection!.host === host && allocations==1 && disk.data==held && disk.writes==writes && requests==count,"original unknown owner/store/hold not recreated or retried")
 }else{check(state=="settledPrefix" && delivery["acceptedOrDuplicate"] as? Int==1 && delivery["acquired"] is NSNull && posts==1,"separate pending settles original prefix only")}
}
Task{@MainActor in await run();print("\(mode)/\(site) passed");exit(0)}
DispatchQueue.main.asyncAfter(deadline:.now()+15){fputs("FAIL: saved Calendar probe timed out\n",stderr);exit(2)}
RunLoop.main.run()
