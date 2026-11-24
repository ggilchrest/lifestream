import CryptoKit
// TEST ONLY. All OS, EventKit, protection, file and HTTP inputs are fake ports.
var selectionAccesses=0,selectionRequests=0,selectionMetadata=0,selectionQueries=0,selectionFactories=0,selectionClock=0,selectionOpens=0
var selectionAccessHook:(()->Void)?
var selectionPolicyHook:(()->Void)?
var selectionPolicyCount=0
var selectionCallback:((Bool,Error?)->Void)?
final class SelectionHandle:NativeCalendarFileHandle {
 var current=true,data:Data?,writes=0,closes=0
 var onReplace:((Data)->Void)?,failAt:String?
 func read()throws->Data?{data}
 func replace(_ bytes:Data)throws{
  let root=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any],native=root?["calendarNative"] as? [String:Any],pending=native?["pending"] as? [String:Any]
  let phase=pending==nil ? "terminal":pending?["attempted"] as? Bool==true ? "attempt":"stage"
  if failAt==phase+"-before"{throw CocoaError(.fileWriteUnknown)}
  data=bytes;writes+=1;onReplace?(bytes)
  if failAt==phase+"-after"{throw CocoaError(.fileWriteUnknown)}
 }
 func close(){current=false;closes+=1}
}
let selectionHandle=SelectionHandle()
struct SelectionFiles:NativeCalendarFilePort{func openExclusive(snapshot:URL)throws->any NativeCalendarFileHandle{selectionOpens+=1;if site=="lock-fails"{throw CocoaError(.fileReadNoPermission)};return selectionHandle}}
final class SelectionSDK:NativeCalendarSelectionSDK {
 var capability:NativeCalendarReadAccess = mode=="permission" ? .notDetermined:.fullRead
 var values=[NativeCalendarMetadata(containerID:"selected",sourceID:"synthetic-account",title:"Duplicate title",sourceTitle:"Account A",sourceKind:"CalDAV",delegated:nil),NativeCalendarMetadata(containerID:"second",sourceID:"other-account",title:"Duplicate title",sourceTitle:"Account B",sourceKind:"CalDAV",delegated:true)]
 var capturedDefaultTimeZone:TimeZone{TimeZone(secondsFromGMT:0)!}
 func access(category:String)->NativeCalendarReadAccess{check(category=="CalendarEvent","no Reminders status");selectionAccesses+=1;selectionAccessHook?();return capability}
 func request(category:String,current:()->Bool,completion:@escaping(Bool,Error?)->Void)->Bool{
  check(category=="CalendarEvent","no other OS permission");guard current() else{return false};selectionRequests+=1
  if site=="never" || site=="late"{selectionCallback=completion;return true}
  if site=="false"{return false}
  let callback={self.capability = .fullRead;completion(true,site=="error" ? CocoaError(.fileReadUnknown):nil);if site=="duplicate"{completion(false,nil)}}
  if site=="async"{DispatchQueue.main.async(execute:callback)}else if site=="offmain"{DispatchQueue.global().async(execute:callback)}else{callback()};return true
 }
 func eventCalendars(current:()->Bool)throws->[NativeCalendarMetadata]{guard current() else{throw NativeCalendarAdmissionError.stale};return try eventCalendars()}
 func acquisition(outbox:HealthOutbox,selected:[NativeCalendarMetadata],current:()->Bool)->MobileEventKitAcquisition?{guard current() else{return nil};return acquisition(outbox:outbox,selected:selected)}
 func eventCalendars()throws->[NativeCalendarMetadata]{selectionMetadata+=1;if site=="duplicate-identity"{return [values[0],values[0]]};return values}
 func acquisition(outbox:HealthOutbox,selected:[NativeCalendarMetadata])->MobileEventKitAcquisition?{selectionQueries+=1;if site=="post-sync"{return MobileEventKitAcquisition(outbox:outbox,storePort:WindowStore(),executeOnWorker:{$0()})};return nil}
}
let selectionSDK=SelectionSDK()
let selectionLimits=MobileCalendarSyncWindow.Limits(maxTotalDays:120,maxScans:8,maxSelectedCalendars:3)!
let selectionAnchor=ISO8601DateFormatter().date(from:"2026-11-01T16:37:54Z")!
let selectionSettings=MobileCalendarSyncWindow(lookBackDays:7,lookAheadDays:30,timeZone:"America/Chicago")!
var sourceOwner:NativeCalendarSourceOwner!
@MainActor func sourceCall(_ kind:String,_ input:[String:Any]=[:]) async->[String:Any]{await withCheckedContinuation{c in switch kind{case "permission":sourceOwner.requestPermission(input:input){c.resume(returning:$0)};case "metadata":sourceOwner.discover(input:input){c.resume(returning:$0)};case "save":sourceOwner.save(input:input){c.resume(returning:$0)};case "recover":sourceOwner.reconcile(input:input){c.resume(returning:$0)};default:sourceOwner.prepare(input:input){c.resume(returning:$0)}}}}
@MainActor func selectionTick() async{await withCheckedContinuation{(c:CheckedContinuation<Void,Never>) in DispatchQueue.main.asyncAfter(deadline:.now()+0.02){c.resume()}}}
func selectionRequest(_ catalog:[String:Any],_ settings:MobileCalendarSyncWindow=selectionSettings)->[String:Any]{["schemaVersion":"1.0.0","catalogId":catalog["catalogId"]!,"choices":[(catalog["choices"] as! [[String:Any]])[0]["choice"]!],"syncWindow":settings.json]}
final class SelectionLease:NativeCalendarAcquisitionLease{
 let outbox:HealthOutbox;var released=false
 init(_ outbox:HealthOutbox){self.outbox=outbox}
 func checkCurrent()->Bool{!released}
 func release(){released=true}
}
@MainActor func selectionGuard() async{
 let box=HealthOutbox(storage:disk),proof=try! MobileCalendarPolicyParser.parse(bytes(fixture["policy"]!),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:enrollment)
 try! box.setHuman(human);try! box.admitCalendar(proof:proof)
 let ticket=try! box.calendarTicket(enrollment:enrollment,category:"CalendarEvent")
 var items:[Data]=[]
 for index in 0..<(site=="beyond64" ? 65:1){
  var item=(fixture["vectors"] as! [[String:Any]])[0]["item"] as! [String:Any],change=item["change"] as! [String:Any],source=change["source"] as! [String:Any],record=change["record"] as! [String:Any],time=record["time"] as! [String:Any]
  change["eventId"]=UUID().uuidString.lowercased();change["expectedPolicyRevision"]=proof.revision;source["accountId"]="synthetic-account";time["timeZone"]=["kind":"supplied","identifier":"UTC"]
  if site=="container" || site=="quarantined" || site=="beyond64" && index==64{source["containerId"]="outside"}
  if site=="account"{source["accountId"]="outside"};if site=="unknown"{time["timeZone"]=["kind":"unknown"]};if site=="time"{time["startDate"]="2027-01-01";time["endDateExclusive"]="2027-01-02"}
  record["time"]=time;change["source"]=source;change["record"]=record;item["change"]=change;items.append(bytes(item))
 }
 let checkpoint=try! MobileCalendarDelivery.CheckpointScope(collector:"eventKit",namespace:namespace,mappingVersion:"synthetic-calendar-mapping/1",coverage:.partial,start:"2026-10-30T00:00:00Z",end:"2026-10-31T00:00:00Z")
 try! box.commitCalendar(scope:checkpoint,expectedCheckpoint:nil,nextCheckpoint:Data([9]),items:items,ticket:ticket)
 if site=="quarantined"{let item=try! MobileCalendarDelivery.item(items[0]);let response:[String:Any]=["schemaVersion":"1.0.0","producerPin":["schemaId":MobileCalendarDelivery.schemaId,"schemaVersion":"1.0.0","digest":MobileCalendarDelivery.schemaDigest],"result":["kind":"sync","receipts":[["eventId":item.eventId.uuidString.lowercased(),"requestDigest":item.digest,"outcome":"rejected","code":"scope","durability":NSNull()]]]];try! box.settleCalendar(ticket:ticket,submitted:items,response:bytes(response))}
 var before=queueBytes(disk.data)
 let lease=SelectionLease(box),plan=MobileEventKitAcquisition.Plan(category:"CalendarEvent",selectedContainerIDs:["synthetic-calendar"],mappingVersion:"synthetic-calendar-mapping/1",coverageStart:Date(timeIntervalSince1970:1793404800),coverageEnd:Date(timeIntervalSince1970:1793491200),capturedSDKDefaultTimeZone:TimeZone(secondsFromGMT:0)!)
 if site=="tail-drift"{selectionPolicyHook={
  selectionPolicyCount+=1;guard selectionPolicyCount==2 else{return}
  var root=try! JSONSerialization.jsonObject(with:items[0]) as! [String:Any],change=root["change"] as! [String:Any],source=change["source"] as! [String:Any];change["eventId"]=UUID().uuidString.lowercased();source["containerId"]="outside-after-body-preparation";change["source"]=source;root["change"]=change
  // External fake storage mutation during the policy roundtrip (the original
  // policy token is deliberately invalidated then, so never mint a new ticket).
  let parsed=try! MobileCalendarDelivery.item(bytes(root));var state=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any],rows=state["calendarEnrollments"] as! [Any]
  let index=rows.firstIndex{$0 is [String:Any]}!;var row=rows[index] as! [String:Any],queue=row["queue"] as! [[String:Any]],queued=queue[0]
  queued["data"]=parsed.data.base64EncodedString();queued["eventId"]=parsed.eventId.uuidString;queued["digest"]=parsed.digest;queue.append(queued);row["queue"]=queue;rows[index]=row;state["calendarEnrollments"]=rows;disk.data=bytes(state);before=queueBytes(disk.data)
 }}
 let config=NativeCalendarAcquisitionOwner.Configuration(provenance:"synthetic-guard",origin:origin,human:human,session:sessionID,endpoint:endpoint,enrollment:enrollment,namespace:namespace,plan:plan,protectedAvailable:{true},deliveryScope:site=="missing" ? nil:syntheticVerifiedCalendarScope)
 let owner=NativeCalendarAcquisitionOwner(transport:transport,outbox:box,configuration:{config},acquireOriginalOwnerLease:{lease},captureClock:{selectionClock+=1;return selectionAnchor})
 let result=await withCheckedContinuation{c in owner.deliverPending{c.resume(returning:$0)}}
 if site=="valid"{guard case .settled(let accepted,_,_,_,_)=result else{check(false,"in-scope original POST succeeds");return};check(accepted==1 && posts==1,"original HTTP delivery and settlement executes once")}
 else{guard case .notApplied=result else{check(false,"unprovable whole queue denies POST");return};check(posts==0 && queueBytes(disk.data)==before && selectionQueries==0 && selectionClock==0,"entire original pending category retained byte-for-byte, including65/quarantine; no POST/filter/delete/SDK")}
 for _ in 0..<4{await selectionTick()};check(!owner.busy && lease.released,"original queue refusal retires through actual publication")
}
var windowQueries=0,windowStart=selectionAnchor.addingTimeInterval(-86400),windowEnd=selectionAnchor.addingTimeInterval(86400),windowNote="first",windowFail=false
struct WindowEvent:MobileEventKitEventReading{
 func readEvent()throws->MobileEventKitRawEvent{.init(item:.init(itemIdentifier:.observed("same-provider-series"),calendarIdentifier:.observed("selected"),accountIdentifier:.observed("synthetic-account"),externalIdentifier:.observed(nil),title:.observed("Synthetic recurring occurrence"),notes:.observed(windowNote),recurrenceRules:.observed(nil)),startDate:.observed(windowStart),endDate:.observed(windowEnd),isAllDay:.observed(false),timeZoneIdentifier:.observed("UTC"),occurrenceDate:.observed(selectionAnchor.addingTimeInterval(-86400)),isDetached:.observed(true),statusRawValue:.observed(1),alarms:.observed(nil))}
}
final class WindowStore:MobileEventKitStoreReading{
 func access(_ plan:MobileEventKitAcquisition.Plan)->MobileEventKitReadAccess{.fullRead}
 func enumerateEvents(_ plan:MobileEventKitAcquisition.Plan,yield:@escaping(any MobileEventKitEventReading)->Bool)throws{windowQueries+=1;if windowFail{throw CocoaError(.fileReadUnknown)};if windowStart<plan.coverageEnd && windowEnd>plan.coverageStart{_ = yield(WindowEvent())}}
 func fetchReminders(_ plan:MobileEventKitAcquisition.Plan,completion:@escaping((any MobileEventKitReminderBatch)?)->Void)throws->any MobileEventKitFetchToken{fatalError("no Reminders in event source")}
 func cancelFetch(_ token:any MobileEventKitFetchToken){fatalError("no Reminders token")}
}
@MainActor func windowQualification() async{
 let box=HealthOutbox(storage:disk),proof=try! MobileCalendarPolicyParser.parse(bytes(fixture["policy"]!),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:enrollment)
 try! box.setHuman(human);try! box.admitCalendar(proof:proof)
 let snapshot=selectionSettings.plan(anchor:selectionAnchor,selectedCalendars:1,limits:selectionLimits)!,acquisition=MobileEventKitAcquisition(outbox:box,storePort:WindowStore(),executeOnWorker:{$0()})
 var counts:[Int]=[],originalIDs:[UUID]=[],keys:[Data]=[],notes:[String]=[]
 for (index,window) in snapshot.windows.enumerated(){
  if index==0 && site=="moved"{windowStart=selectionAnchor.addingTimeInterval(86400);windowEnd=selectionAnchor.addingTimeInterval(172800)}
  if index==0 && site=="first-failure"{windowFail=true}
  if index==1{check(windowQueries==1,"no automatic second query or rearm");windowFail=false;windowStart=selectionAnchor.addingTimeInterval(-86400);windowEnd=selectionAnchor.addingTimeInterval(86400);if site=="edited"{windowNote="edited between queries"}}
  let plan=MobileEventKitAcquisition.Plan(category:"CalendarEvent",selectedContainerIDs:["selected"],mappingVersion:"synthetic-calendar-mapping/1",coverageStart:window.start,coverageEnd:window.end,capturedSDKDefaultTimeZone:TimeZone(secondsFromGMT:0)!),ticket=try! box.calendarTicket(enrollment:enrollment,category:"CalendarEvent")
  let page=await withCheckedContinuation{c in acquisition.acquire(plan:plan,proof:proof,ticket:ticket,isCurrent:{true},captureClock:{selectionAnchor}){c.resume(returning:$0)}}
  if case .success(let page)=page{
   let outcome=acquisition.commit(page:page,reauthorizedProof:proof,ticket:ticket,isCurrent:{true})
   guard case .committed(let count,_)=outcome else{check(false,"original commit result");return};counts.append(count)
  }else{check(index==0 && site=="first-failure","only explicit fixture first query fails");counts.append(0)}
  await withCheckedContinuation{c in acquisition.whenDrained{c.resume()}}
 }
 let ticket=try! box.calendarTicket(enrollment:enrollment,category:"CalendarEvent"),items=try! box.pendingCalendarWithinVerifiedScope(ticket:ticket,scope:MobileCalendarSyncScope(containers:[.init(id:"selected",accountID:"synthetic-account")],start:snapshot.start,end:snapshot.end,mappingVersion:"synthetic-calendar-mapping/1")!)
 for bytes in items{let item=try! MobileCalendarDelivery.item(bytes),root=try! JSONSerialization.jsonObject(with:item.data) as! [String:Any],change=root["change"] as! [String:Any],record=change["record"] as! [String:Any];originalIDs.append(item.eventId);keys.append(try! MobileCalendarDelivery.canonical(["source":change["source"]!,"locator":root["locator"]!]));notes.append(record["notes"] as! String)}
 if site=="moved" || site=="first-failure"{check(counts==[0,1] && items.count==1,"later matching moved/first-failed observation never omitted")}
 else{check(counts==[1,1] && items.count==2 && Set(originalIDs).count==2 && keys[0]==keys[1],"two observations retain original distinct delivery UUIDs and stable recurring logical identity");if site=="edited"{check(notes==["first","edited between queries"],"later changed observation preserved, no snapshot fiction")}}
 check(windowQueries==2,"only two explicitly invoked original bounded queries")
}
func settingsFixture(_ name:String="examples.json")->[String:Any]{let directory=ProcessInfo.processInfo.environment["CALENDAR_SETTINGS_BUNDLE"]!;return try! JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:directory).appendingPathComponent(name))) as! [String:Any]}
@MainActor func nativeStateQualification(){
 let examples=settingsFixture(),command=try! MobileCalendarSettingsWire.command(bytes(examples["controlRequest"]!)),binding=HealthOutbox.CalendarNativeBinding(origin:origin,principal:command.principal,session:sessionID,endpoint:command.endpoint),box=HealthOutbox(storage:disk)
 if site=="preserve"{
  try! box.setHuman(command.principal);let id=UUID();try! box.enroll(id,human:command.principal,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:"synthetic-health")
  let ticket=try! box.ticket(enrollment:id,type:"sleep");try! box.commit(scope:"health",expectedAnchor:nil,nextAnchor:Data([1]),changes:[HealthChange(upstreamId:"synthetic",operation:.upsert,body:Data([1]),collectedAt:selectionAnchor,expectedPolicyRevision:1,mappingVersion:"synthetic")],ticket:ticket)
 }
 let before=try! JSONSerialization.jsonObject(with:disk.data ?? Data("{\"enrollments\":[]}".utf8)) as! [String:Any]
 try! box.stageCalendarNativeCommand(binding:binding,original:command.original)
 let staged=disk.data!,root=try! JSONSerialization.jsonObject(with:staged) as! [String:Any]
 check(root["version"] as? Int==4 && bytes(root["enrollments"]!)==bytes(before["enrollments"]!),"explicit format4 migration preserves Health rows/anchors/queue and creates no enrollment")
 let cold=HealthOutbox(storage:disk),pending=try! cold.calendarNativeCommandForReconciliation(origin:origin,principal:command.principal,endpoint:command.endpoint)!
 check(pending.original==command.original && pending.operationID==command.operationID && !pending.attempted,"cold retrieval EXACT original bytes/UUID, not inspect reconstruction")
 check((try? cold.stageCalendarNativeCommand(binding:binding,original:command.original))==nil && disk.data==staged,"pending original refuses all new staging, no replay/recreate")
 if site=="emit-v4"{let url=URL(fileURLWithPath:ProcessInfo.processInfo.environment["NATIVE_V4_OUTPUT"]!);try! staged.write(to:url);return}
 if site=="preserve"{
  try! box.setHuman(command.principal);let id=UUID();try! box.enroll(id,human:command.principal,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:"another-health")
  let after=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any];check(after["version"] as? Int==4 && bytes(after["calendarNative"]!)==bytes(root["calendarNative"]!),"original Health writer preserves full pending custody and format4")
  return
 }
 try! cold.markCalendarNativeCommandAttempted(binding:binding,original:command.original)
 let attempted=disk.data!,next=try! cold.calendarNativeCommandForReconciliation(origin:origin,principal:command.principal,endpoint:command.endpoint)!
 check(next.attempted && next.original==command.original,"attempt persisted before send, original retained")
 check((try? cold.markCalendarNativeCommandAttempted(binding:binding,original:command.original))==nil && disk.data==attempted,"no rearm of attempted original")
 for key in ["heldReply","inspectReply"]{check((try? MobileCalendarSettingsWire.terminal(bytes(examples[key]!),original:command))==nil && disk.data==attempted,"held/current row cannot supply terminal")}
 var observed=examples["terminalReply"] as! [String:Any],r=observed["result"] as! [String:Any];r["kind"]="observed";r.removeValue(forKey:"binding");observed["result"]=r;check((try? MobileCalendarSettingsWire.terminal(bytes(observed),original:command))==nil,"observed is not independent terminal evidence")
 if site=="unknown"{check(selectionQueries==0 && posts==0 && selectionRequests==0,"cold unknown never automatically dispatches or reads SDK");return}
 let terminal=try! MobileCalendarSettingsWire.terminal(bytes(examples["terminalReply"]!),original:command)
 try! cold.settleCalendarNativeCommand(binding:binding,terminal:terminal,reconciliation:true)
 check((try! cold.calendarNativeCommandForReconciliation(origin:origin,principal:command.principal,endpoint:command.endpoint))==nil,"only matching original terminal settles custody")
 let settled=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any],native=settled["calendarNative"] as! [String:Any],saved=native["terminal"] as! [String:Any]
 check(Data(base64Encoded:saved["original"] as! String)==command.original && Data(base64Encoded:saved["response"] as! String)==terminal.response,"original exact terminal and command retained, no grant conversion")
 if site=="malformed"{var wrong=settled;wrong["version"]=3;disk.data=bytes(wrong);let fresh=HealthOutbox(storage:disk);check((try? fresh.setHuman(command.principal))==nil,"new field on legacy format refuses before save")}
}
@MainActor func wireQualification(){
 let fixture=settingsFixture("ACTUAL-SYNTHETIC-SCOPED-HANDLER-RESULT-r3.json"),identity=fixture["selectionIdentity"] as! [String:Any],r=(fixture["request"] as! [String:Any])["payload"] as! [String:Any],run=r["run"] as! [String:Any]
 let rows=(identity["calendars"] as! [[String:Any]]).map{MobileCalendarSettingsWire.Selection.CalendarIdentity(containerID:$0["containerId"] as! String,accountID:$0["accountId"] as? String)}
 let selection=MobileCalendarSettingsWire.Selection(principal:UUID(uuidString:identity["principalId"] as! String)!,endpoint:UUID(uuidString:identity["endpointId"] as! String)!,enrollment:UUID(uuidString:identity["enrollmentId"] as! String)!,namespace:UUID(uuidString:identity["sourceNamespace"] as! String)!,revision:identity["configurationRevision"] as! Int,calendars:rows)!
 check(selection.digest==run["selectionDigest"] as? String,"actual producer canonical selection commitment matches unsigned UTF8 ordering")
 let settings=MobileCalendarSyncWindow(fixture["configuredWindow"] as! [String:Any])!,anchor=ISO8601DateFormatter().date(from:run["anchorAt"] as! String)!,snapshot=settings.plan(anchor:anchor,selectedCalendars:1,limits:selectionLimits)!,scoped=MobileCalendarSettingsWire.Run(selection:selection,snapshot:snapshot)
 check(ISO8601DateFormatter().date(from:run["startAt"] as! String)==scoped.start && ISO8601DateFormatter().date(from:run["endAt"] as! String)==scoped.end,"actual produced full union agrees with native EXACT anchor-time DST planner")
 let original=try! (r["items"] as! [[String:Any]]).map{try MobileCalendarDelivery.item(bytes($0))},body=try! MobileCalendarSettingsWire.batch(original,run:scoped),encoded=try! JSONSerialization.jsonObject(with:body) as! [String:Any],payload=encoded["payload"] as! [String:Any],items=payload["items"] as! [[String:Any]]
 check(try! MobileCalendarDelivery.item(bytes(items[0])).data==original[0].data,"new producing envelope preserves original item bytes/digest/eventUUID")
 let response=try! MobileCalendarSettingsWire.originalReceiptEnvelope(bytes(fixture["response"]!),expected:original),receipts=try! MobileCalendarDelivery.receipts(response,expected:original)
 check(receipts.accepted==Set(original.map(\.eventId)),"ACTUAL produced HTTP receipts pass ORIGINAL digest/durability consumer, no terminal conversion")
 var bad=fixture["response"] as! [String:Any],result=bad["result"] as! [String:Any],values=result["receipts"] as! [[String:Any]];values[0]["durability"]=NSNull();result["receipts"]=values;bad["result"]=result
 check((try? MobileCalendarSettingsWire.originalReceiptEnvelope(bytes(bad),expected:original))==nil,"missing original sqlCommit never upgraded")
 let output=ProcessInfo.processInfo.environment["NATIVE_WIRE_OUTPUT"]!;try! body.write(to:URL(fileURLWithPath:output))
}
final class SyntheticShareAuthority:OutboxShareAuthority{
 func withFence<T>(_ body:()throws->T) rethrows->T{try body()}
 func permits(_ context:OutboxShareContext,reading:Bool)->Bool{true}
}
@MainActor func sharePreservationQualification(){
 let examples=settingsFixture(),command=try! MobileCalendarSettingsWire.command(bytes(examples["controlRequest"]!)),box=HealthOutbox(storage:disk,shareAuthority:SyntheticShareAuthority())
 try! box.setHuman(command.principal)
 let raw=try! String(contentsOfFile:ProcessInfo.processInfo.environment["SHARE_FIXTURE"]!,encoding:.utf8).replacingOccurrences(of:"\\ud800",with:"__UNPAIRED__"),fixture=try! JSONSerialization.jsonObject(with:Data(raw.utf8)) as! [String:Any],pairs=fixture["pairs"] as! [[String:Any]],template=pairs.first{$0["case"] as? String=="file-reference"}!["ios"] as! [String:Any]
 func capture(_ payload:Data){
  var item=template,content=item["content"] as! [String:Any],artifact=content["artifact"] as! [String:Any];artifact["byteLength"]=payload.count;artifact["sha256"]=SHA256.hash(data:payload).map{String(format:"%02x",$0)}.joined();content["artifact"]=artifact;item["content"]=content
  let decoded=try! MobileSharedItem.decode(bytes(item)),context=OutboxShareContext(owner:box,human:command.principal,endpoint:command.endpoint,namespace:decoded.source.namespace,collector:decoded.source.collector,epoch:1,recoveryOnly:false),attempt=OutboxShareAttempt(UUID(),context:context),digest=SHA256.hash(data:decoded.data).map{String(format:"%02x",$0)}.joined()
  guard case .reserved(let reservation,_)=try! box.reserve(attempt:attempt,payloadDigest:digest,item:decoded,context:context) else{check(false,"actual Share reservation");return}
  guard case .acknowledged=try! box.commit(reservation,itemJSON:decoded.data,capturedBytes:payload,integrity:MobileSharedItem.verify(decoded,bytes:payload)!) else{check(false,"actual original Share commit");return}
 }
 capture(Data([1,2,3]));let before=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any]
 try! box.stageCalendarNativeCommand(binding:.init(origin:origin,principal:command.principal,session:sessionID,endpoint:command.endpoint),original:command.original)
 let staged=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any];check(bytes(before["shareAssociations"]!)==bytes(staged["shareAssociations"]!),"format3→4 migration retains ORIGINAL Share record bytes")
 capture(Data([4,5,6]));let after=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any]
 check(after["version"] as? Int==4 && (after["shareAssociations"] as! [String:Any]).count==2 && bytes(after["calendarNative"]!)==bytes(staged["calendarNative"]!),"actual Share reserve/commit preserves v4 original command and BOTH Share rows, no downgrade/reset")
 _=try! HealthOutbox(storage:disk).calendarNativeCommandForReconciliation(origin:origin,principal:command.principal,endpoint:command.endpoint)
}
/// Actual disposable handler bytes, not examples or a reconstructed terminal.
@MainActor func producedControlQualification(){
 let url=URL(fileURLWithPath:ProcessInfo.processInfo.environment["CALENDAR_CONTROL_VECTOR"]!),raw=try! Data(contentsOf:url),vector=try! JSONSerialization.jsonObject(with:raw) as! [String:Any]
 check(vector["syntheticOnly"] as? Bool==true,"only disposable producer fixture")
 func entry(_ name:String,_ key:String)->Data{let entry=vector[name] as! [String:Any],value=Data((entry[key+"Utf8"] as! String).utf8);check(bytes(try! JSONSerialization.jsonObject(with:value))==bytes(entry[key]!),"raw produced bytes match exported semantic value");return value}
 let originalBytes=entry("configure","request"),command=try! MobileCalendarSettingsWire.command(originalBytes),reply=entry("configure","response"),reconcile=entry("reconcile","response"),terminal=try! MobileCalendarSettingsWire.terminal(reply,original:command),restored=try! MobileCalendarSettingsWire.terminal(reconcile,original:command)
 check(terminal.command.original==restored.command.original && terminal.response==reply && restored.response==reconcile && terminal.current && terminal.applied,"ACTUAL independent producer SQL receipt/calendarControl binding accepted without response reconstruction")
 check(try! MobileCalendarSettingsWire.reconcile(command)==MobileCalendarDelivery.canonical(try! JSONSerialization.jsonObject(with:entry("reconcile","request"))),"exact original reconcile contract bytes interoperate")
 let before=try! NativeCalendarContext.policy(entry("beforePolicy","response"),human:command.principal,endpoint:command.endpoint,enrollment:command.enrollment!),after=try! NativeCalendarContext.policy(entry("afterPolicy","response"),human:command.principal,endpoint:command.endpoint,enrollment:command.enrollment!)
 check(after.revision==before.revision+1 && before.revision==command.expectedRevision,"actual produced policy revision transition")
 let box=HealthOutbox(storage:disk);try! box.admitCalendarExistingRemote(proof:before,selectedCategories:["CalendarEvent"])
 let binding=HealthOutbox.CalendarNativeBinding(origin:origin,principal:command.principal,session:sessionID,endpoint:command.endpoint)
 try! box.stageCalendarNativeCommand(binding:binding,original:command.original);try! box.markCalendarNativeCommandAttempted(binding:binding,original:command.original)
 let cold=HealthOutbox(storage:disk);try! cold.settleCalendarNativeCommand(binding:binding,terminal:restored,reconciliation:true)
 let identities=[MobileCalendarSettingsWire.Selection.CalendarIdentity(containerID:"synthetic-only-selected",accountID:"synthetic-only-account")],selected=MobileCalendarSettingsWire.Selection(principal:after.principal,endpoint:after.endpoint,enrollment:after.enrollment,namespace:after.namespace,revision:after.revision,calendars:identities)!,snapshot=terminal.window!.plan(anchor:selectionAnchor,selectedCalendars:1,limits:selectionLimits)!,run=MobileCalendarSettingsWire.Run(selection:selected,snapshot:snapshot),plan=MobileEventKitAcquisition.Plan(category:"CalendarEvent",selectedContainerIDs:identities.map(\.containerID),mappingVersion:"synthetic-calendar-mapping/1",coverageStart:snapshot.windows[0].start,coverageEnd:snapshot.windows[0].end,capturedSDKDefaultTimeZone:TimeZone(secondsFromGMT:0)!),selection=try! MobileCalendarSettingsWire.phoneSelection(run:run,plan:plan)
 let pre=disk.data!;check((try? cold.reconnectCalendarExistingLocal(proof:after,expectedCategories:["CalendarEvent"]))==nil && disk.data==pre,"old reconnect cannot advance revision and remains zero-write")
 try! cold.applyCalendarConfiguredExistingLocal(terminal:restored,proof:after,selection:selection)
 let ticket=try! cold.calendarTicket(enrollment:after.enrollment,category:"CalendarEvent");check((try? cold.pendingCalendar(ticket:ticket)) != nil,"fresh actual policy and original terminal adopt SAME saved row")
 let saved=disk.data!;check((try? cold.applyCalendarConfiguredExistingLocal(terminal:restored,proof:after,selection:selection))==nil && disk.data==saved,"configured transaction cannot replay saved revision")
 let next=HealthOutbox(storage:disk);try! next.reconnectCalendarExistingLocal(proof:after,expectedCategories:["CalendarEvent"]);check(disk.data==saved,"new cold reader reconnects revision-equal with ZERO writes")
 wireQualification()
}
var sourceRemote:[String:Any]?,sourceJournal:[UUID:[String:Any]]=[:],sourceCommands:[MobileCalendarSettingsWire.Command]=[]
func selectionPolicyReply()->[String:Any]?{
 guard ["source-save","compose","byte-binding"].contains(mode),let e=sourceRemote else{return nil};var policy=fixture["policy"] as! [String:Any],result=policy["result"] as! [String:Any],effective=result["effective"] as! [String:Any]
 effective["policyRevision"]=e["revision"];effective["categories"]=["CalendarEvent"];effective["collectionAllowed"]=(e["configuration"] as! [String:Any])["collectionPaused"] as? Bool==false
 result["enrollment"]=e;result["effective"]=effective;policy["result"]=result;return policy
}
func sourceControlReply(_ body:[String:Any])->[String:Any]?{
 guard ["source-save","compose","byte-binding"].contains(mode),body["producerPin"] as? [String:String]==MobileCalendarSettingsWire.pin else{return nil}
 let operation=body["operation"] as! String,payload=body["payload"] as! [String:Any]
 if operation=="ingestScoped"{
  posts+=1;let items=(payload["items"] as! [[String:Any]]).map{try! MobileCalendarDelivery.item(bytes($0))}
  return ["schemaVersion":"1.0.0","producerPin":MobileCalendarSettingsWire.pin,"result":["kind":"sync","receipts":items.map{["eventId":$0.eventId.uuidString.lowercased(),"requestDigest":$0.digest,"outcome":"accepted","code":"applied","durability":"sqlCommit"]}]]
 }
 let command=try! MobileCalendarSettingsWire.envelope(payload:payload)
 if operation=="reconcile"{controlReconciles+=1;return sourceJournal[command.operationID]}
 check(operation=="control","only explicitly staged controls");controlPosts+=1;sourceCommands.append(command)
 var e=sourceRemote ?? ["enrollmentId":enrollment.uuidString.lowercased(),"principalId":human.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"eventKit","sourceNamespace":NSNull(),"revision":1,"state":"unbound","configuration":["categories":[],"uses":[],"assistantIds":[],"collectionPaused":true,"usePaused":true]]
 if command.kind=="bindSource"{e["sourceNamespace"]=namespace.uuidString.lowercased();e["revision"]=(e["revision"] as! Int)+1;e["state"]="active"}
 if command.kind=="configure"{check(command.enrollment==enrollment && command.namespace==namespace && command.expectedRevision==e["revision"] as? Int,"same actual server enrollment/namespace and expected revision");e["configuration"]=try! JSONSerialization.jsonObject(with:command.configuration!);e["revision"]=command.expectedRevision+1}
 sourceRemote=e
 let outcome:[String:Any]=["status":"applied","receipt":["operationId":command.operationID.uuidString.lowercased(),"committedAt":"2026-11-01T18:00:00.000Z"],"enrollment":e,"syncWindow":command.settings?.json as Any? ?? NSNull()],selection:[String:Any]=["syntheticOnly":true]
 let response:[String:Any]=["schemaVersion":"1.0.0","producerPin":MobileCalendarSettingsWire.pin,"result":["kind":"terminal","originalRequest":payload,"requestDigest":command.requestDigest,"outcome":outcome,"current":true,"binding":["family":"calendarControl","reservationDigest":MobileCalendarSettingsWire.hash("lifestream/calendar-control/reservation/1",command.payload),"preparedDigest":MobileCalendarSettingsWire.hash("lifestream/calendar-control/prepared/1",try! MobileCalendarDelivery.canonical(["request":payload,"selection":selection])),"terminalDigest":MobileCalendarSettingsWire.hash("lifestream/calendar-control/terminal/1",try! MobileCalendarDelivery.canonical(["request":payload,"selection":selection,"outcome":outcome]))]]]
 sourceJournal[command.operationID]=response
 if site=="held" || site=="never"{return ["schemaVersion":"1.0.0","producerPin":MobileCalendarSettingsWire.pin,"result":["kind":"held","operationId":command.operationID.uuidString.lowercased(),"requestDigest":command.requestDigest,"reason":"unknown"]]}
 return response
}
@MainActor func sourceSaveQualification(_ preview:[String:Any]) async{
 if site != "new-paused"{var e=(fixture["policy"] as! [String:Any])["result"] as! [String:Any];var remote=e["enrollment"] as! [String:Any],config=remote["configuration"] as! [String:Any];config["categories"]=["CalendarEvent"];config["uses"]=[];config["assistantIds"]=[];config["usePaused"]=true;config["collectionPaused"]=site=="paused";remote["configuration"]=config;sourceRemote=remote;e["enrollment"]=remote
  if site=="existing"{var policy=fixture["policy"] as! [String:Any],effective=e["effective"] as! [String:Any];effective["categories"]=["CalendarEvent"];e["effective"]=effective;policy["result"]=e;let proof=try! NativeCalendarContext.policy(bytes(policy),human:human,endpoint:endpoint,enrollment:enrollment),box=HealthOutbox(storage:disk);try! box.admitCalendarExistingRemote(proof:proof,selectedCategories:["CalendarEvent"]);selectionHandle.data=disk.data}
 }
 if site=="adopt-unknown" || site=="adopt-withdraw"{selectionHandle.onReplace={data in
  guard queueRows(data).contains(where:{$0["revision"] as? Int==3}) else{return}
  if site=="adopt-withdraw"{selectionHandle.onReplace=nil;sourceOwner.withdraw()}else{selectionHandle.failAt="terminal-after"}
 }}
 let input:[String:Any]=["schemaVersion":"1.0.0","previewId":preview["previewId"]!]
 if site=="never"{
  var reply:[String:Any]?;sourceOwner.save(input:input){reply=$0};for _ in 0..<10{await selectionTick()};check(reply==nil && sourceOwner.busy && controlPosts==1,"never original HTTP callback keeps source/Runtime/parent obligations");let metadata=selectionMetadata;_=await sourceCall("metadata");check(selectionMetadata==metadata,"never owner cannot be replaced by discovery");return
 }
 let result=await sourceCall("save",input)
 check(selectionQueries==0 && posts==0 && selectionRequests==0 && selectionOpens==1,"Save uses same concrete file and does not query/send events or request OS access")
 if site=="held"{
  check(result["state"] as? String=="held" && controlPosts==1,"original command remains held");let metadata=selectionMetadata,opens=selectionOpens;_=await sourceCall("metadata");_=await sourceCall("save",input);check(selectionMetadata==metadata && selectionOpens==opens && controlPosts==1,"unknown blocks all replacement/read/replay paths");let recovered=await sourceCall("recover");check(recovered["state"] as? String=="reconciled" && controlReconciles==1 && controlPosts==1,"explicit exact-original recovery never continues later mutation");return
 }
 if site=="adopt-unknown"{
  check(result["state"] as? String=="held" && result["settingsState"] as? String=="saved","known remote save retained with unknown original local write");let opens=selectionOpens;_=await sourceCall("metadata");_=await sourceCall("recover");check(selectionOpens==opens,"no new physical file/root after ambiguous adoption");return
 }
 check(result["state"] as? String=="saved" && result["settingsState"] as? String=="saved","terminal-qualified range save")
 if site=="paused" || site=="new-paused" || site=="adopt-withdraw"{check(result["activation"] as? String=="unavailable" && connection!.canInstallCalendarConfiguration,"pause/withdraw never silently enables collection");if site != "adopt-withdraw"{check((sourceRemote!["configuration"] as! [String:Any])["collectionPaused"] as? Bool==true,"existing pause preserved")};return}
 let rows=queueRows(selectionHandle.data);check(rows.count==1 && rows[0]["revision"] as? Int==3 && result["activation"] as? String=="manualOnly","exact same local row reaches new revision after fresh policy")
 if site=="post-sync"{
  let host=connection!.host,catalog=host.calendarSavedChoices(),choice=(catalog["choices"] as! [[String:Any]])[0]["choice"]!,request:[String:Any]=["schemaVersion":"1.0.0","catalogId":catalog["catalogId"]!,"choice":choice]
  let reconnected:[String:Any]=await withCheckedContinuation{c in host.performCalendarSavedChoice(.reconnect,input:request){c.resume(returning:$0)}}
  check((reconnected["result"] as? [String:Any])?["outcome"] as? String=="reconnected","original saved Host cold reconnect uses revision-equal zero-write path")
  for _ in 0..<4{await selectionTick()}
  let details=host.calendarCollectionDetailsChoice(input:request);check(details["reason"] as? String=="ready","explicit original scope details before manual query")
  let sync:[String:Any]=await withCheckedContinuation{c in host.calendarCollectAndDeliverChoice(input:request){c.resume(returning:$0)}}
  check((sync["result"] as? [String:Any])?["state"] as? String=="settledPrefix" && windowQueries==1 && posts==1 && selectionQueries==1 && queueCount(selectionHandle.data)==0,"actual original acquisition→protected commit→new scoped HTTP→original receipt settlement, only after explicit manual action")
  for _ in 0..<4{await selectionTick()}
 }
 let checkpointsBeforeEdit=bytes(queueRows(selectionHandle.data)[0]["checkpoints"]!)
 let before=selectionHandle.data,commands=controlPosts,metadata=await sourceCall("metadata");check(metadata["state"] as? String=="available" && selectionFactories==1 && selectionOpens==1 && controlPosts==commands && selectionHandle.data==before,"profile actual retirement before metadata edit; same original SDK/file")
 let updated=MobileCalendarSyncWindow(lookBackDays:2,lookAheadDays:6,timeZone:"UTC")!,review=await sourceCall("preview",selectionRequest(metadata,updated)),saved=await sourceCall("save",["schemaVersion":"1.0.0","previewId":review["previewId"]!]);check(saved["state"] as? String=="saved" && saved["activation"] as? String=="manualOnly" && selectionFactories==1 && selectionOpens==1,"post-save configurable duration update uses same physical SDK/store after real retirement")
 let next=queueRows(selectionHandle.data);if site=="post-sync"{check(bytes(next[0]["checkpoints"]!)==checkpointsBeforeEdit,"original checkpoint retained byte-for-byte across settings update")};check(next.count==1 && next[0]["revision"] as? Int==4 && sourceCommands.filter{$0.kind=="configure"}.map(\.expectedRevision)==[2,3],"second Save reuses actual enrollment/source, applies3→4 without reconnect or new local row")
}
var controlPosts=0,controlReconciles=0,controlApplies=0,controlCurrent=true
var controlStored:[String:Any]?,controlRuntime:NativeHealthRuntime?
func controlReply(_ body:[String:Any])->[String:Any]?{
 if let response=sourceControlReply(body){return response}
 guard mode=="control",body["producerPin"] as? [String:String]==MobileCalendarSettingsWire.pin else{return nil}
 let operation=body["operation"] as! String,payload=body["payload"] as! [String:Any],command=try! MobileCalendarSettingsWire.envelope(payload:payload)
 if operation=="control"{
  controlPosts+=1;controlApplies+=1
  let configuration=try! JSONSerialization.jsonObject(with:command.configuration!)
  let outcome:[String:Any]=["status":"applied","receipt":["operationId":command.operationID.uuidString.lowercased(),"committedAt":"2026-11-01T18:00:00.000Z"],"enrollment":["enrollmentId":command.enrollment!.uuidString.lowercased(),"principalId":command.principal.uuidString.lowercased(),"endpointId":command.endpoint.uuidString.lowercased(),"collector":"eventKit","sourceNamespace":command.namespace!.uuidString.lowercased(),"revision":command.expectedRevision+1,"state":"active","configuration":configuration],"syncWindow":command.settings!.json]
  let selection:[String:Any]=["syntheticOnly":true,"qualifiedOwner":"offline-original"]
  controlStored=["schemaVersion":"1.0.0","producerPin":MobileCalendarSettingsWire.pin,"result":["kind":"terminal","originalRequest":payload,"requestDigest":command.requestDigest,"outcome":outcome,"current":true,"binding":["family":"calendarControl","reservationDigest":MobileCalendarSettingsWire.hash("lifestream/calendar-control/reservation/1",command.payload),"preparedDigest":MobileCalendarSettingsWire.hash("lifestream/calendar-control/prepared/1",try! MobileCalendarDelivery.canonical(["request":payload,"selection":selection])),"terminalDigest":MobileCalendarSettingsWire.hash("lifestream/calendar-control/terminal/1",try! MobileCalendarDelivery.canonical(["request":payload,"selection":selection,"outcome":outcome]))]]]
 }else{check(operation=="reconcile","only original reconcile");controlReconciles+=1}
 guard var response=controlStored else{return ["schemaVersion":"1.0.0","producerPin":MobileCalendarSettingsWire.pin,"result":["kind":"held","operationId":command.operationID.uuidString.lowercased(),"requestDigest":command.requestDigest,"reason":"unknown"]]}
 if operation=="control" && ["held","wrong-pin","wrong-digest","observed"].contains(site){
  if site=="held"{response["result"]=["kind":"held","operationId":command.operationID.uuidString.lowercased(),"requestDigest":command.requestDigest,"reason":"unknown"]}
  if site=="wrong-pin"{response["producerPin"]=["schemaId":MobileCalendarSettingsWire.schemaID,"schemaVersion":"1.0.0","digest":String(repeating:"0",count:64)]}
  if site=="wrong-digest"{var r=response["result"] as! [String:Any];r["requestDigest"]=String(repeating:"0",count:64);response["result"]=r}
  if site=="observed"{var r=response["result"] as! [String:Any];r["kind"]="observed";r.removeValue(forKey:"binding");response["result"]=r}
 }
 return response
}
@MainActor func commandCall(_ command:MobileCalendarSettingsWire.Command?,_ root:NativeHealthRuntime,_ original:NativeProtectedCalendarStorage,reconcile:Bool=false) async->NativeHealthRuntime.NativeCommandOutcome{
 await withCheckedContinuation{c in root.calendarNativeCommand(command:command,reconcile:reconcile,custody:{storage,binding in try original.acquire(storage:storage,binding:binding)},owner:originalOwner,current:{controlCurrent},makeCurrency:{.init(owner:originalOwner,binding:$0)}){c.resume(returning:$0)}}
}
@MainActor func runtimeControlQualification() async{
 let identity=rootConfiguration().identity,original=NativeProtectedCalendarStorage(identity:identity,file:URL(fileURLWithPath:"/synthetic-only/control"),port:SelectionFiles(),protectedAvailable:{true},current:{true}),configuration=NativeHealthRuntime.RootConfiguration(identity:identity,protectedAvailable:{true},makeStorage:{try original.openStorage()})
 let root=try! NativeHealthRuntime.makeRoot(configuration:configuration,transport:transport);controlRuntime=root
 let payload:[String:Any]=["schemaVersion":"1.0.0","operationId":UUID().uuidString.lowercased(),"target":["principalId":human.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"eventKit","enrollmentId":enrollment.uuidString.lowercased(),"sourceNamespace":namespace.uuidString.lowercased(),"expectedRevision":2],"action":["kind":"configure","state":"active","configuration":["sourceConfiguration":["categories":["CalendarEvent"],"uses":[],"assistantIds":[],"collectionPaused":false,"usePaused":true],"syncWindow":selectionSettings.json]]]
 let command=try! MobileCalendarSettingsWire.envelope(payload:payload)
 if site.hasPrefix("write-"){selectionHandle.failAt=String(site.dropFirst(6))}
 if ["cancel-stage","cancel-attempt","cancel-terminal"].contains(site){let wanted=String(site.dropFirst(7));selectionHandle.onReplace={bytes in
  let object=try! JSONSerialization.jsonObject(with:bytes) as! [String:Any],native=object["calendarNative"] as! [String:Any],pending=native["pending"] as? [String:Any],phase=pending==nil ? "terminal":pending?["attempted"] as? Bool==true ? "attempt":"stage"
  if phase==wanted{selectionHandle.onReplace=nil;controlCurrent=false;root.cancelNativeCommand()}
 }}
 let outcome=await commandCall(command,root,original)
 if site=="normal" || site=="cancel-terminal"{
  guard case .terminal(let terminal)=outcome else{check(false,"known original terminal must survive successful terminal write withdrawal");return}
  check(terminal.command.operationID==command.operationID && terminal.applied && controlPosts==1 && controlApplies==1 && !root.nativeCommandHeld,"known original SQL/journal terminal and original UUID preserved")
  let data=selectionHandle.data!,state=try! JSONSerialization.jsonObject(with:data) as! [String:Any],native=state["calendarNative"] as! [String:Any];check(native["pending"]==nil && native["terminal"] != nil,"exact terminal custody stored in same format4 snapshot")
  var retired=false;root.retire(authorityChanged:false){retired=true};for _ in 0..<4{await selectionTick()};check(retired,"real original command/parent/publication drain before retirement");return
 }
 guard case .held(let id,_)=outcome else{check(false,"uncertain original control retained");return};check(id==command.operationID && root.nativeCommandHeld,"ORIGINAL operation UUID retained through uncertainty")
 if site.hasPrefix("write-"){
  let before=selectionHandle.data,posts=controlPosts,reconciles=controlReconciles;var retired=false;root.retire(authorityChanged:false){retired=true};let other=await commandCall(command,root,original);guard case .held=other else{check(false,"unresolved Root cannot rearm");return};for _ in 0..<4{await selectionTick()};check(!retired && selectionHandle.data==before && controlPosts==posts && controlReconciles==reconciles,"ambiguous original write never readback-upgrades/replaces/replays or retires");return
 }
 if site=="cancel-stage" || site=="cancel-attempt"{check(controlPosts==0,"withdraw during known local write never POSTs staged command");return}
 check(controlPosts==1 && controlReconciles==0 && controlApplies==1,"no automatic retry or inspect settlement")
 let repeated=await commandCall(command,root,original);guard case .held=repeated else{check(false,"new command cannot replace unknown owner");return}
 let recovered=await commandCall(nil,root,original,reconcile:true);guard case .terminal(let terminal)=recovered else{check(false,"explicit exact-original reconcile recovers journal-qualified terminal");return}
 check(terminal.command.original==command.original && terminal.command.operationID==command.operationID && controlPosts==1 && controlReconciles==1 && controlApplies==1,"reconciliation preserves original bytes/UUID and does not replay original mutation")
}
#if CALENDAR_SELECTION_GATED_SDK
var lowerCurrent=true,lowerStatus=0,lowerEnumerations=0,lowerLookups=0,lowerMetadata=0,lowerPreparation=0,lowerDelegates=0
let lowerRow=NativeCalendarMetadata(containerID:"selected",sourceID:"synthetic-account",title:"Synthetic",sourceTitle:"Synthetic",sourceKind:"Local",delegated:nil)
final class LowerCalendar:NativeCalendarSelectedCalendar{
 var metadata:NativeCalendarMetadata?{lowerMetadata+=1;if site=="metadata-withdraw"{lowerCurrent=false};return lowerRow}
}
final class LowerSelectionPort:NativeCalendarSelectionPort{
 var capturedDefaultTimeZone:TimeZone{TimeZone(secondsFromGMT:0)!}
 func access(category:String)->NativeCalendarReadAccess{check(category=="CalendarEvent","event-only status");lowerStatus+=1;if site.hasPrefix("status-"){lowerCurrent=false};return .fullRead}
 func request(category:String,current:()->Bool,completion:@escaping(Bool,Error?)->Void)->Bool{check(false,"adapter metadata/acquisition must not request OS permission");return false}
 func eventCalendars(current:()->Bool)throws->[NativeCalendarMetadata]{guard current() else{throw NativeCalendarAdmissionError.stale};lowerEnumerations+=1;return [lowerRow]}
 func calendar(identifier:String,current:()->Bool)->(any NativeCalendarSelectedCalendar)?{guard current() else{return nil};check(identifier==lowerRow.containerID,"exact captured native calendar lookup");lowerLookups+=1;if site=="lookup-withdraw"{lowerCurrent=false};return LowerCalendar()}
 func makeAcquisition(outbox:HealthOutbox,calendars:[any NativeCalendarSelectedCalendar],current:()->Bool)->MobileEventKitAcquisition?{lowerPreparation+=1;if site=="prepare-withdraw"{lowerCurrent=false};guard current() else{return nil};lowerDelegates+=1;return nil}
}
@MainActor func lowerSDKQualification(){
 let original=NativeCalendarSelectionAdapter(original:LowerSelectionPort()),box=HealthOutbox(storage:disk)
 if site=="status-metadata"{let rows=try? original.eventCalendars(current:{lowerCurrent});check(rows==nil && lowerStatus==1 && lowerEnumerations==0,"actual shared SDK adapter status withdrawal precedes real metadata delegate");return}
 if site=="positive"{check((try! original.eventCalendars(current:{lowerCurrent}))==[lowerRow] && lowerEnumerations==1,"unchanged original adapter metadata positive")}
 _=original.acquisition(outbox:box,selected:[lowerRow],current:{lowerCurrent})
 if site=="positive"{check(lowerStatus==2 && lowerLookups==1 && lowerMetadata==1 && lowerDelegates==1,"unchanged original adapter acquisition preparation positive")}
 else if site=="status-acquisition"{check(lowerLookups==0 && lowerMetadata==0 && lowerDelegates==0,"status withdrawal prevents calendar lookup/preparation")}
 else if site=="lookup-withdraw"{check(lowerLookups==1 && lowerMetadata==0 && lowerDelegates==0,"lookup withdrawal prevents next metadata getter/delegate")}
 else if site=="metadata-withdraw"{check(lowerMetadata==1 && lowerPreparation==0 && lowerDelegates==0,"metadata getter withdrawal prevents next preparation delegate")}
 else{check(lowerPreparation==1 && lowerDelegates==0,"lowest preparation boundary keeps captured pure gate before delegate")}
 check(selectionFactories==0 && selectionRequests==0 && selectionQueries==0 && selectionOpens==0 && posts==0,"low SDK hooks only; no actual store/status/OS/events/transport")
}
#endif
@MainActor func selectionRun() async{
 #if CALENDAR_SELECTION_GATED_SDK
 if mode=="sdk-adapter"{lowerSDKQualification();return}
 #endif
 if mode=="native-state"{if site=="share-preserve"{sharePreservationQualification()}else{nativeStateQualification()};return}
 if mode=="wire"{if site=="produced-control"{producedControlQualification()}else{wireQualification()};return}
 if mode=="windows"{await windowQualification();return}
 if mode=="planner"{
  let p=selectionSettings.plan(anchor:selectionAnchor,selectedCalendars:3,limits:selectionLimits)!
  check(p.windows.count==2 && MobileCalendarSyncScope.timestamp(p.start)=="2026-10-25T15:37:54.000Z" && MobileCalendarSyncScope.timestamp(p.end)=="2026-12-01T16:37:54.000Z" && p.windows[0].end==selectionAnchor && p.windows[1].start==selectionAnchor,"exact Chicago DST fixed 7/30 fixture only")
  let other=MobileCalendarSyncWindow(lookBackDays:31,lookAheadDays:2,timeZone:"America/Chicago")!,q=other.plan(anchor:selectionAnchor,selectedCalendars:1,limits:selectionLimits)!
  check(q.windows.count==3 && q.windows.allSatisfy{$0.end.timeIntervalSince($0.start)<=31*86400},"non7/30 generic bounded adjacent split, no omission")
  for (a,b) in [(0,0),(-1,2),(367,0),(200,167)]{check(MobileCalendarSyncWindow(lookBackDays:a,lookAheadDays:b,timeZone:"UTC")==nil,"invalid duration")}
  for value:Any in [true,0.5,-1,367,"7"]{var json=selectionSettings.json;json["lookBackDays"]=value;check(MobileCalendarSyncWindow(json)==nil,"closed integer intent")}
  check(selectionSettings.plan(anchor:selectionAnchor,selectedCalendars:4,limits:selectionLimits)==nil && other.plan(anchor:selectionAnchor,selectedCalendars:1,limits:.init(maxTotalDays:120,maxScans:1,maxSelectedCalendars:3)!)==nil,"aggregate/calendar/scan bound refuses instead of truncating");return
 }
 try! transport.configure(origin);let configuration=URLSessionConfiguration.ephemeral;configuration.protocolClasses=[Offline.self];transport.session=URLSession(configuration:configuration,delegate:transport,delegateQueue:.main)
 _=await withCheckedContinuation{c in transport.request("/api/auth/v1/session"){c.resume(returning:$0)}};_=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}}
 if mode=="control"{await runtimeControlQualification();return}
 if mode=="guard"{await selectionGuard();return}
 connection=NativeHealthConnectionOwner(transport:transport)
 let resource=NativeCalendarSourceOwner.Resources(file:URL(fileURLWithPath:"/synthetic-only/original-snapshot"),filePort:SelectionFiles(),limits:selectionLimits,maxBytes:8*1024*1024,maxEvents:100000,mappingVersion:"synthetic-calendar-mapping/1",protectedAvailable:{true},clock:{selectionClock+=1;return selectionAnchor},makeSDK:{selectionFactories+=1;if mode=="sdk-reentry" && site.hasPrefix("factory-"){sourceOwner.withdraw()};return selectionSDK})
 sourceOwner=NativeCalendarSourceOwner(transport:transport,connection:connection!,resources:resource)
 check(selectionFactories==0 && selectionAccesses==0 && selectionOpens==0 && selectionClock==0,"construction entirely inert")
 if mode=="permission"{
  if site=="never" || site=="late"{
   var result:[String:Any]?,count=0;sourceOwner.requestPermission(input:[:]){result=$0;count+=1}
   for _ in 0..<8{await selectionTick()};check(sourceOwner.busy && result==nil && selectionRequests==1,"actual callback obligation retained without timeout")
   let refusal=await sourceCall("permission");check(refusal["state"] as? String=="unavailable" && selectionRequests==1,"no replacement SDK/request while held")
   sourceOwner.withdraw();check(sourceOwner.busy,"withdraw never invents callback retirement")
   if site=="late"{selectionSDK.capability = .fullRead;selectionCallback!(true,nil);for _ in 0..<8{await selectionTick()};check(count==1 && result?["requestState"] as? String=="deferred" && result?["attemptId"] is String && !sourceOwner.busy,"late original result preserves attempt/deferred and real drain")};return
  }
  let result=await sourceCall("permission");check(selectionRequests==1 && selectionMetadata==0 && selectionQueries==0 && selectionOpens==0 && posts==0,"permission bootstrap no fake source/root/enrollment/discovery/store/event/send")
  check(result["requestState"] as? String==(site=="false" ? "notInvoked":"requestCompleted"),"actual invocation reported once")
  if site=="error"{check(result["readAccess"] as? String=="unknown","error never proves permission")};return
 }
 if mode=="custody"{
  let d=NativeProtectedCalendarStorage(identity:rootConfiguration().identity,file:URL(fileURLWithPath:"/synthetic-only/store"),port:SelectionFiles(),protectedAvailable:{true},current:{true})
  if site=="lock-fails"{check((try? d.openStorage())==nil,"exclusive lock failure no positive custody");return}
  let original=try! d.openStorage(),binding=NativeSharedOutboxOwner.Binding(origin:origin,human:human,session:sessionID,endpoint:endpoint),lease=try! d.acquire(storage:original,binding:binding)
  check(lease.isCurrent(storage:original,binding:binding) && (try? d.acquire(storage:disk,binding:binding))==nil && (try? d.acquire(storage:original,binding:binding))==nil,"physical exclusive original-object custody")
  selectionHandle.current=false;check(!lease.isCurrent(storage:original,binding:binding),"actual low-level lock currentness required");lease.release();check(!lease.isCurrent(storage:original,binding:binding),"released currency cannot rearm");return
 }

 if mode=="sdk-reentry"{
  if site=="factory-permission"{let result=await sourceCall("permission");check(result["state"] as? String=="unavailable" && selectionAccesses==0 && selectionMetadata==0,"withdraw in ORIGINAL factory prevents next status call");return}
  if site=="factory-discover" || site=="status-discover"{
   if site=="status-discover"{selectionAccessHook={selectionAccessHook=nil;sourceOwner.withdraw()}}
   let result=await sourceCall("metadata");check(result["state"] as? String=="unavailable" && selectionMetadata==0 && (site != "factory-discover" || selectionAccesses==0),"factory/status withdrawal precedes any metadata delegate");return
  }
 }
 if mode=="byte-binding"{let row=selectionSDK.values[0];selectionSDK.values[0] = .init(containerID:site.contains("container") ? "caf\u{00e9}":row.containerID,sourceID:site.contains("source") || site=="exact-byte" ? "caf\u{00e9}":row.sourceID,title:row.title,sourceTitle:row.sourceTitle,sourceKind:row.sourceKind,delegated:row.delegated)}
 let catalog=await sourceCall("metadata")
 if site=="duplicate-identity"{check(catalog["state"] as? String=="unavailable" && selectionQueries==0,"ambiguous native identity denied");return}
 check(catalog["state"] as? String=="available" && selectionRequests==0 && selectionMetadata==1 && selectionQueries==0 && selectionOpens==0 && posts==0,"separate metadata-only action on same SDK")
 let rows=catalog["choices"] as! [[String:Any]];check(rows.count==2 && rows.allSatisfy{$0["selected"] as? Bool==false && $0["ownership"] as? String=="unknown" && $0["sharing"] as? String=="unknown"} && rows[0]["choice"] as? String != rows[1]["choice"] as? String,"duplicate labels distinct real source identities, none selected, unknown ownership")
 if mode=="metadata"{return}
 var input=selectionRequest(catalog)
 if site=="stale"{sourceOwner.withdraw()};if site=="empty"{input["choices"]=[]};if site=="unknown-key"{input["plan"]="forged"};if site=="metadata-change"{selectionSDK.values[0] = .init(containerID:"selected",sourceID:"changed-account",title:"Duplicate title",sourceTitle:"Account A",sourceKind:"CalDAV",delegated:nil)}
 if mode=="sdk-reentry" && site=="status-prepare"{let before=selectionMetadata;selectionAccessHook={selectionAccessHook=nil;sourceOwner.withdraw()};let result=await sourceCall("preview",input);check(result["state"] as? String=="unavailable" && selectionMetadata==before,"prepare status withdrawal prevents metadata delegate");return}
 func changeIdentityBytes(){let row=selectionSDK.values[0];selectionSDK.values[0] = .init(containerID:site.contains("container") ? "cafe\u{0301}":row.containerID,sourceID:site.contains("source") ? "cafe\u{0301}":row.sourceID,title:row.title,sourceTitle:row.sourceTitle,sourceKind:row.sourceKind,delegated:row.delegated)}
 if mode=="byte-binding" && site.hasPrefix("prepare-"){changeIdentityBytes();let result=await sourceCall("preview",input);check(result["state"] as? String=="unavailable" && selectionOpens==0 && controlPosts==0,"byte-distinct providerLocal source/container rejected by ORIGINAL prepare before store/control");return}
 let preview=await sourceCall("preview",input)
 if ["stale","empty","unknown-key","metadata-change"].contains(site){check(preview["state"] as? String=="unavailable" && selectionQueries==0 && posts==0,"stale/forged/changed identity rejected");return}
 check(preview["state"] as? String=="prepared" && preview["settingsState"] as? String=="requestedNotSaved" && preview["activation"] as? String=="unavailable" && selectionQueries==0 && posts==0 && selectionOpens==0 && selectionClock==1,"native exact preview, no fake save or activation")
 if mode=="sdk-reentry" && site=="status-save"{let before=selectionMetadata;selectionAccessHook={selectionAccessHook=nil;sourceOwner.withdraw()};let result=await sourceCall("save",["schemaVersion":"1.0.0","previewId":preview["previewId"]!]);check(result["state"] as? String=="unavailable" && selectionMetadata==before && selectionOpens==0 && controlPosts==0,"save status withdrawal prevents metadata/store/control delegates");return}
 if mode=="byte-binding"{
  var e=(fixture["policy"] as! [String:Any])["result"] as! [String:Any],remote=e["enrollment"] as! [String:Any],config=remote["configuration"] as! [String:Any];config["categories"]=["CalendarEvent"];config["uses"]=[];config["assistantIds"]=[];config["usePaused"]=true;config["collectionPaused"]=false;remote["configuration"]=config;sourceRemote=remote
  if site.hasPrefix("save-"){changeIdentityBytes()}
  let result=await sourceCall("save",["schemaVersion":"1.0.0","previewId":preview["previewId"]!])
  if site=="exact-byte"{check(result["state"] as? String=="saved" && result["activation"] as? String=="manualOnly" && selectionOpens==1 && controlPosts==2,"unchanged exact-byte positive ORIGINAL Save remains usable")}
  else{check(result["state"] as? String=="unavailable" && selectionOpens==0 && controlPosts==0,"byte-distinct providerLocal source/container rejected by ORIGINAL Save before store/control")};return
 }
 if mode=="preview"{return}
 if mode=="source-save" || mode=="compose"{await sourceSaveQualification(preview);return}
}
Task{@MainActor in await selectionRun();print("\(mode)/\(site) passed");exit(0)}
DispatchQueue.main.asyncAfter(deadline:.now()+12){fputs("FAIL: selection probe timed out\n",stderr);exit(2)}
RunLoop.main.run()
