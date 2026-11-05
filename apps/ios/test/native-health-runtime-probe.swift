import Foundation
import CryptoKit
@testable import AssistantCore
// TEST ONLY: explicit verified synthetic source scope for the stricter request fence.
let syntheticVerifiedCalendarScope=MobileCalendarSyncScope(containers:["selected","fixture-calendar","synthetic-calendar"].map{.init(id:$0,accountID:"synthetic-account")},start:Date(timeIntervalSince1970:1790812800),end:Date(timeIntervalSince1970:1798761600),mappingVersion:"synthetic-calendar-mapping/1")!


func check(_ value:@autoclosure()->Bool,_ reason:String){if !value(){fputs("FAIL: \(reason)\n",stderr);exit(1)}}
func bytes(_ value:Any)->Data{try! JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes])}
func later(_ action:@escaping()->Void){DispatchQueue.main.asyncAfter(deadline:.now()+0.1,execute:action)}
final class Store:ConnectionStore{var value:SavedConnection?;func load()throws->SavedConnection?{value};func save(_ v:SavedConnection)throws{value=v}}
final class Disk:HealthSnapshotStorage{
 var data:Data?;var locked=false,writes=0,reads=0,failWrite=false,writeThenThrow=false,frame=0
 var onRead:(()->Void)?,onReplace:((Data)->Void)?
 func read()throws->Data?{frame+=1;defer{frame-=1};reads+=1;onRead?();if locked{throw CocoaError(.fileReadNoPermission)};return data}
 func replace(_ v:Data)throws{frame+=1;defer{frame-=1};if locked{throw CocoaError(.fileWriteNoPermission)};writes+=1;onReplace?(v);if failWrite{throw CocoaError(.fileWriteNoPermission)};data=v;if writeThenThrow{throw CocoaError(.fileWriteUnknown)}}
}
final class Query:NativeHealthQuery{var stops=0;var onStop:(()->Void)?;func stop(){stops+=1;onStop?()}}
final class SDK:NativeHealthSDK{
 private var availability=true
 var available:Bool{get{if healthChoiceMode && choicePhase=="permission" && mode=="health-permission-sdk-availability-reentry" && !choiceInjected{choiceInjected=true;choiceMutate("plan")};return availability}set{availability=newValue}}
 var queries=0;let handle=Query();var callback:((Result<NativeHealthPage,Error>)->Void)?
 func prepareReadAuthorization(types:Set<String>)->NativeHealthAuthorizationDelegate?{healthChoiceMode ? choicePrepareAuthorization(types):nil}
 func query(plan:NativeHealthCollectionPlan,anchor:Data?,completion:@escaping(Result<NativeHealthPage,Error>)->Void)throws->any NativeHealthQuery{
  queries+=1;callback=completion
  if healthChoiceMode{
   DispatchQueue.main.async{
    choiceSDKDone=true
    completion(.success(NativeHealthPage(observations:[],deleted:mode=="health-choice-sync-outcomes" && healthSetupSite=="idle" ? []:["synthetic-deletion"],anchor:Data([1]),mayHaveMore:false)))
   };return handle
  }
  if ["shared-drain-sdk","shared-never-callback"].contains(mode) || mode.hasPrefix("sdk-") || mode=="status-draining" || ["pause-sdk","pause-never","pause-reentrant","pause-retiring"].contains(mode){later{sdkWithheld?()}}
  else{if mode=="pause-before-send"{pauseContext=true};DispatchQueue.global().async{
   let samples = mode=="observation" ? [NativeHealthObservation(upstreamId:"00000000-0000-4000-8000-000000000044",category:"sleep",start:plan.start,end:plan.end,nativeSleep:HealthSleepValue(nativeValue:3),quantity:nil,unit:nil,sourceBundle:"synthetic",sourceVersion:nil,deviceName:nil,deviceModel:nil,sourceTimeZone:"UTC")] : []
   completion(.success(NativeHealthPage(observations:samples,deleted:["synthetic-deletion"],anchor:Data([1]),mayHaveMore:true)))
  }}
  return handle
 }
}
let mode=CommandLine.arguments[1]
let healthChoiceMode=mode.hasPrefix("health-choice-") || mode.hasPrefix("health-permission-")
let healthSetupSite=ProcessInfo.processInfo.environment["HEALTH_SETUP_SITE"] ?? "default"
let choiceOwner=NSObject()
var choiceCurrency:NativeHealthChoiceCurrency?,choiceOtherHost:NativeHealthHost?
var choicePhase="bootstrap",choiceArmed=false,choiceInjected=false,choiceSourceMarker="original",choicePolicySeen=false
var choiceAuthCalls=0,choicePermissionReplies=0,choiceDelegateReturned=false,choiceSDKDone=false,choicePostQueryContext=false,choiceDeferredReads=0
var choiceSDKCompletion:((Result<Void,Error>)->Void)?,choiceDelegateEntered:(()->Void)?
var choiceUnwindArmed=false,choiceUnwindAttempted=false
var choiceUnwindInput:[String:Any]=[:]
let initialHealthRevision=healthChoiceMode && mode=="health-permission-changed-policy" && healthSetupSite=="regress" ? 2:1
let calendarMode=mode.hasPrefix("calendar-")
let reconnectMode=mode.hasPrefix("calendar-reconnect-")
var healthSDKAllocations=0,healthProofResponses=0
let human=UUID(uuidString:"50000000-0000-4000-8000-000000000001")!,enrollment=UUID(uuidString:"00000000-0000-4000-8000-000000000002")!,session=UUID(uuidString:"00000000-0000-4000-8000-000000000003")!,endpoint=UUID(uuidString:"60000000-0000-4000-8000-000000000001")!
let namespace="00000000-0000-4000-8000-000000000004",origin="https://offline.invalid"
let pin=["schemaId":MobileHealthEncoder.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthEncoder.schemaSHA256]
let selected:[String:Any]=["categories":(["status-category-missing","resume-ui-multicategory"].contains(mode) || mode=="health-permission-types" && healthSetupSite=="configured-pair") ? ["SleepSegment","heartRate"]:["SleepSegment"],"uses":[],"assistantIds":[],"collectionPaused":false,"usePaused":false]
let enrollmentJSON:[String:Any]=["enrollmentId":enrollment.uuidString.lowercased(),"principalId":human.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":namespace,"revision":initialHealthRevision,"state":"active","configuration":selected]
let policy:[String:Any]=["schemaVersion":"1.0.0","producerPin":pin,"result":["enrollment":enrollmentJSON,"effective":["policyRevision":initialHealthRevision,"sourceBound":true,"collectionAllowed":true,"categories":selected["categories"]!,"uses":[],"assistantIds":[],"sourceNamespace":namespace]]]
var calendarTicket:CalendarCollectionTicket?,calendarPending:[Data]?
var provenance="synthetic-native-config"
var authStatus=200,authRef="synthetic",statusHTTP=200
var resumePolicyMode="",resumeMutationAfterWrites:Int?,resumeMutationFired=false
var pauseContext=false,holdPolicy=false,pauseFromProtected=false
var releaseHeld:(()->Void)?,pauseTrigger:(()->Void)?
var requests=0,ingests=0,unexpected=0,allocations=0,contextRevision=1,authHuman=human.uuidString.lowercased(),authSession=session.uuidString.lowercased(),sdkWithheld:(()->Void)?
func requestBody(_ r:URLRequest)->Data{if let data=r.httpBody{return data};guard let stream=r.httpBodyStream else{return Data()};stream.open();defer{stream.close()};var data=Data(),buffer=[UInt8](repeating:0,count:4096);while stream.hasBytesAvailable{let n=stream.read(&buffer,maxLength:buffer.count);if n<=0{break};data.append(buffer,count:n)};return data}
final class Offline:URLProtocol{
 override class func canInit(with request:URLRequest)->Bool{
  if ["shared-health-admission","shared-custody-loss","shared-config-reentry"].contains(mode),request.url?.path=="/api/runtime/v1/mobile-context",request.httpMethod=="POST"{sharedDispatch.record()}
  return true
 }
 override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
 override func startLoading(){DispatchQueue.main.async{[self] in
  requests+=1
  guard request.url?.host=="offline.invalid" else{unexpected+=1;client?.urlProtocol(self,didFailWithError:URLError(.unsupportedURL));return}
  if request.url!.path=="/api/runtime/v1/mobile-context",let body=try? JSONSerialization.jsonObject(with:requestBody(request)) as? [String:Any],body["operation"] as? String=="calendar"{if calendarMode{admissionCalendarResponse(self,body)}else{sharedCalendarResponse(self,body)};return}
  var object:[String:Any];var isPolicy=false
  switch request.url!.path{
  case "/api/auth/v1/user-context":object=["producerPin":["schemaId":"https://lifestream.dev/contracts/effective-subject/1.0.0","schemaVersion":"1.0.0","digest":"ed098cad970a310a807881ea7a833b96f1c980e8377ee3cfcbdffd68f2bd0cf9"],"contextRef":authRef,"context":["schemaVersion":"1.0.0","actorId":authHuman,"effectiveUserId":authHuman,"authenticatedSessionId":authSession,"installationId":"00000000-0000-4000-8000-000000000009","authorityRevision":1,"generation":1,"issuedAt":"2026-10-30T00:00:00Z"],"actor":["principalId":authHuman],"effectiveUser":["principalId":authHuman],"impersonating":false]
  case "/api/runtime/v1/session-context":if mode.hasPrefix("shared-"){sharedSessionCalls+=1};object=["ended":false,"revision":contextRevision,"contextGeneration":1,"endpoint":["endpointId":endpoint.uuidString.lowercased(),"privacyClass":"personal","configurationRevision":1]]
  case "/api/runtime/v1/mobile-context":
   let body=try! JSONSerialization.jsonObject(with:requestBody(request)) as! [String:Any]
   if body["operation"] as? String=="inventory" {
    object=["schemaVersion":"1.0.0","producerPin":["schemaId":MobileHealthInventory.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthInventory.schemaSHA256],"result":["principalId":human.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"sources":[["sourceNamespace":namespace,"collector":"healthKit","policyRevision":initialHealthRevision,"configuration":selected,"enrollmentCount":1,"currentEndpointEnrollment":enrollmentJSON,"coverage":["state":"unknown"]]],"unboundEnrollments":[],"nextCursor":NSNull()]]
    if mode=="status-context-drift"{contextRevision=2}
   }
   else if body["operation"] as? String=="policy" {
    isPolicy=true;healthProofResponses+=1;object=policy
    if !resumePolicyMode.isEmpty {
     var result=object["result"] as! [String:Any],row=result["enrollment"] as! [String:Any],effective=result["effective"] as! [String:Any],configuration=row["configuration"] as! [String:Any]
     if resumePolicyMode=="blocked"{effective["collectionAllowed"]=false;effective["categories"]=[String]()}
     if resumePolicyMode=="categories"{configuration["categories"]=[String]();effective["categories"]=[String]()}
     if resumePolicyMode=="source"{row["sourceNamespace"]="00000000-0000-4000-8000-000000000099";effective["sourceNamespace"]="00000000-0000-4000-8000-000000000099"}
     if resumePolicyMode=="disconnected"{row["state"]="disconnected";effective["collectionAllowed"]=false;effective["categories"]=[String]()}
     if resumePolicyMode=="paused"{configuration["collectionPaused"]=true;effective["collectionAllowed"]=false;effective["categories"]=[String]()}
     row["configuration"]=configuration;result["enrollment"]=row;result["effective"]=effective;object["result"]=result
    }
   }
   else if body["operation"] as? String=="ingest",let payload=body["payload"] as? [String:Any],let changes=payload["changes"] as? [[String:Any]]{
    ingests+=1;object=["schemaVersion":"1.0.0","producerPin":pin,"result":changes.map{["eventId":$0["eventId"]!,"outcome":"accepted","code":"deleted"]}]
    if mode.hasPrefix("shared-") && sharedHoldHealthIngest{sharedHoldHealthIngest=false;releaseHeld={ [self] in client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!,cacheStoragePolicy:.notAllowed);client?.urlProtocol(self,didLoad:bytes(object));client?.urlProtocolDidFinishLoading(self)};sharedLaunchWhileHeld?();return}
    if mode=="delivery-cancel" {host.withdraw();check(host.status()["state"] as? String=="draining","delivery callback still owned");host.setup(selection:"known",action:.confirmExistingLocal){check((try? $0.get())==nil,"no replacement before delivery drain")};later{check(host.status()["state"] as? String=="unavailable","transport cancellation drained");check(allocations==1,"one runtime");print("delivery-cancel passed");exit(0)};return}
   }else{unexpected+=1;client?.urlProtocol(self,didFailWithError:URLError(.unsupportedURL));return}
  default:unexpected+=1;client?.urlProtocol(self,didFailWithError:URLError(.unsupportedURL));return
  }
  if healthChoiceMode{object=choiceWire(request.url!.path,object,isPolicy:isPolicy)}
  let response=HTTPURLResponse(url:request.url!,statusCode:request.url!.path=="/api/auth/v1/user-context" ? authStatus:request.url!.path=="/api/runtime/v1/session-context" ? statusHTTP:200,httpVersion:nil,headerFields:nil)!
  let respond={ [self] in client?.urlProtocol(self,didReceive:response,cacheStoragePolicy:.notAllowed);client?.urlProtocol(self,didLoad:calendarMode ? admissionWire(request.url!.path,object):bytes(object));client?.urlProtocolDidFinishLoading(self) }
  if (pauseContext && request.url!.path=="/api/runtime/v1/session-context") || (holdPolicy && isPolicy) || (mode=="pause-after-send" && ingests==1 && request.url!.path=="/api/runtime/v1/mobile-context") {
   pauseContext=false;holdPolicy=false;releaseHeld=respond;pauseTrigger?();return
  }
  respond()
 }}
 override func stopLoading(){}
}
let disk=Disk(),sdk=SDK(),transport=NativeTransport(store:Store())
try! transport.configure(origin,username:"synthetic")
let cfg=URLSessionConfiguration.ephemeral;cfg.protocolClasses=[Offline.self];transport.session=URLSession(configuration:cfg,delegate:transport,delegateQueue:.main)
let plan=NativeHealthCollectionPlan(category:"sleep",scope:mode.hasPrefix("scope-") ? "caf\u{00e9}":"synthetic",mappingVersion:"healthkit-v1",start:Date(timeIntervalSince1970:1793318400),end:Date(timeIntervalSince1970:1793404800))
let decomposedPlan=NativeHealthCollectionPlan(category:"sleep",scope:"cafe\u{0301}",mappingVersion:plan.mappingVersion,start:plan.start,end:plan.end)
var useDecomposed=false,protectedHealthy=true
var publicationThreshold:Int?,publicationFired=false
func publicationMutation(_ source:String){
 if mode=="resume-ui-final-"+source,let threshold=resumeMutationAfterWrites,disk.writes>=threshold,!resumeMutationFired {resumeMutationFired=true;if source=="protected"{protectedHealthy=false}else{provenance="changed-by-publication"}}
 if (mode=="status-publication-"+source || mode=="status-publication-"+source+"-early"),let limit=publicationThreshold,disk.reads>=limit,!publicationFired {
  publicationFired=true;if source=="protected"{protectedHealthy=false}else{provenance="changed-by-publication"}
 }
}
func configuration()->NativeHealthRuntime.Configuration{
 if mode=="shared-config-reentry",sharedConfigSite=="health-provider",!sharedInjected{sharedInjected=true;host.withdraw()}
 publicationMutation("config")
 return .init(provenance:provenance,origin:origin,human:human,session:session,endpoint:endpoint,enrollment:enrollment,plans:(["status-category-missing","resume-ui-multicategory"].contains(mode) || mode=="health-permission-types" && healthSetupSite=="configured-pair") ? [plan,NativeHealthCollectionPlan(category:"heartRate",scope:plan.scope,mappingVersion:plan.mappingVersion,start:plan.start,end:plan.end)]:[useDecomposed ? decomposedPlan:plan],maxBytes:mode=="oversize-config" ? 8*1024*1024+1:8*1024*1024,maxEvents:100_000,storageOrigin:mode=="origin-config" ? "https://other.invalid":origin,protectedFilePolicy:"synthetic-volatile",protectedAvailable:{if pauseFromProtected{pauseFromProtected=false;pauseTrigger?()};publicationMutation("protected");return protectedHealthy && mode != "protected-unavailable"},makeStorage:{allocations+=1;if healthChoiceMode && choicePhase=="setup" && mode=="health-permission-bootstrap-reentry" && healthSetupSite=="storage-factory"{choiceMutate("config")};if mode=="shared-config-reentry",sharedConfigSite=="storage-factory",!sharedInjected{sharedInjected=true;host.withdraw()};return disk},makeSDK:{healthSDKAllocations+=1;if healthChoiceMode && choicePhase=="setup" && mode=="health-permission-bootstrap-reentry" && healthSetupSite=="SDK-factory"{choiceMutate("config")};if calendarMode{check(healthProofResponses>0,"independent Health proof before actual SDK allocation");if mode=="calendar-then-health-sdk-failure"{throw CocoaError(.coderInvalidValue)}};return sdk})
}
let host=NativeHealthHost(transport:transport,configuration:{selection in healthChoiceMode ? choiceResolve(selection):selection=="known" && mode != "status-no-config" ? configuration():nil},calendarConfiguration:calendarMode ? admissionSelection:sharedSelection,rootConfiguration:calendarMode ? {selection in selection=="known" ? admissionRootConfiguration():nil}:nil,choicePort:healthChoiceMode ? makeChoicePort():nil)
transport.healthContextWillChange={host.withdraw(authorityChanged:$0)}
func finish(){check(unexpected==0,"only intercepted routes");print("\(mode) passed");exit(0)}
// Fixture-only data seeding and byte projections. These are NOT native
// admission tickets or a replacement for the production root. The shared modes
// below verify admission by completing real Calendar operations through the Host.
struct FixtureHealthCategory {let category:String}
final class FixtureInput {
    private lazy var seed=HealthOutbox(storage:disk)
    private var calendarProof:MobileCalendarPolicyProof?
    func state()throws->[String:Any]{guard !disk.locked,let data=disk.data,let value=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else{throw HealthOutboxError.lockedOrUnavailable};return value}
    func row(_ id:UUID)throws->[String:Any]{let a=try state()["enrollments"] as! [Any];for i in stride(from:0,to:a.count,by:2){if UUID(uuidString:a[i] as! String)==id{return a[i+1] as! [String:Any]}};throw HealthOutboxError.notEnrolled}
    func storedPaused(_ id:UUID)throws->Bool{try row(id)["paused"] as! Bool}
    func validateSnapshot()throws{_ = try seed.status(enrollment:enrollment)}
    func makeProtectedUnavailable(enrollment:UUID){protectedHealthy=false}
    func pause(enrollment:UUID)throws{var v=try state(),a=v["enrollments"] as! [Any];for i in stride(from:0,to:a.count,by:2){if UUID(uuidString:a[i] as! String)==enrollment{var r=a[i+1] as! [String:Any];r["paused"]=true;a[i+1]=r}};v["enrollments"]=a;try disk.replace(bytes(v))}
    func admitCalendar(proof:MobileCalendarPolicyProof)throws{try seed.setHuman(human);try seed.admitCalendar(proof:proof);calendarProof=proof}
    func calendarTicket(enrollment:UUID,category:String)throws->CalendarCollectionTicket{try seed.calendarTicket(enrollment:enrollment,category:category)}
    func commitCalendar(scope:MobileCalendarDelivery.CheckpointScope,expectedCheckpoint:Data?,nextCheckpoint:Data,items:[Data],ticket:CalendarCollectionTicket)throws{try seed.commitCalendar(scope:scope,expectedCheckpoint:expectedCheckpoint,nextCheckpoint:nextCheckpoint,items:items,ticket:ticket)}
    func pendingCalendar(ticket:CalendarCollectionTicket)throws->[Data]{return try seed.pendingCalendar(ticket:ticket)}
    func commit(scope:String,expectedAnchor:Data?,nextAnchor:Data,changes:[HealthChange],ticket:FixtureHealthCategory)throws{try seed.setHuman(human);let p=try MobileHealthPolicyParser.parse(bytes(policy),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:enrollment);try seed.confirmEffectivePolicy(proof:p);try seed.commit(scope:scope,expectedAnchor:expectedAnchor,nextAnchor:nextAnchor,changes:changes,ticket:seed.ticket(enrollment:enrollment,type:ticket.category))}
    func anchor(for scope:String,ticket:FixtureHealthCategory)throws->Data?{try seed.anchor(for:scope,ticket:seed.ticket(enrollment:enrollment,type:ticket.category))}
}
let fixtureInput=FixtureInput()
func pauseNow(_ input:[String:Any])->[String:Any]{
    var result:[String:Any]?
    host.pauseCollection(input){result=$0}
    guard let result else{check(false,"legacy pause fixture only calls outside an active storage frame");return [:]};return result
}
func runSelectedStatus(){
 var request:[String:Any]=["schemaVersion":"1.0.0","sourceNamespace":namespace,"enrollmentId":enrollment.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"policyRevision":1,"contextRevision":1]
 let runtime=host.runtime
 if mode=="status-wrong-source"{request["sourceNamespace"]="00000000-0000-4000-8000-000000000099"}
 if mode=="status-wrong-enrollment"{request["enrollmentId"]="00000000-0000-4000-8000-000000000099"}
 if mode=="status-wrong-endpoint"{request["endpointId"]="00000000-0000-4000-8000-000000000099"}
 if mode=="status-wrong-policy"{request["policyRevision"]=2}
 if mode=="status-wrong-context"{request["contextRevision"]=2}
 if mode=="status-bool"{request["policyRevision"]=true}
 if mode=="status-extra"{request["extra"]=true}
 if mode=="status-config-drift"{provenance="changed"}
 if mode=="status-category-missing"{var j=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any];var rows=j["enrollments"] as! [Any];var row=rows[1] as! [String:Any];row["enabledTypes"]=["sleep"];rows[1]=row;j["enrollments"]=rows;disk.data=bytes(j)}
 if mode=="status-no-proof"{fixtureInput.makeProtectedUnavailable(enrollment:enrollment)}
 if mode=="status-paused"{try! fixtureInput.pause(enrollment:enrollment)}
 if mode=="status-rebind"{var j=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any];var rows=j["enrollments"] as! [Any];var row=rows[1] as! [String:Any];row["requiresRebind"]=true;rows[1]=row;j["enrollments"]=rows;disk.data=bytes(j)}
 if mode=="status-pending"{disk.locked=true;_ = pauseNow(pauseRequest());disk.locked=false}
 if mode=="status-locked"{disk.locked=true}
 if mode=="status-503"{statusHTTP=503}
 if mode=="status-401"{statusHTTP=401}
 let before=disk.data,writes=disk.writes,reads=disk.reads,queries=sdk.queries,sent=ingests,allocated=allocations
 
 if mode.hasPrefix("status-publication-"){
  publicationThreshold=disk.reads+(mode.hasSuffix("-early") ? 0:3)
  if !mode.hasSuffix("-early") {
   // Mutate the real external configuration/protection port in the last
   // original proof read, rather than rely on a later callback being called.
   disk.onRead={publicationMutation(mode.hasSuffix("-protected") ? "protected":"config")}
  }
 }
 host.selectedStatus(request){reply in
  check(Set(reply.keys)==Set(["schemaVersion","state","reason","binding","local"]),"closed status DTO")
  if mode.hasPrefix("status-publication-") {
   check(publicationFired,"real publication mutation fired");check(reply["state"] as? String != "ready","real configuration mutation must prevent ready publication")
   print("publication callback fired=\(publicationFired)")
  }
  else if mode=="status-valid"{check(reply["state"] as? String=="ready","confirmed setup can be inspected before sync");let binding=reply["binding"] as! [String:Any];check(binding["sourceNamespace"] as? String==namespace && binding["policyRevision"] as? Int==1,"native binding")}
  else{check(reply["state"] as? String != "ready","invalid or unavailable status is not ready")}
  let expectedReason=["status-paused":"paused","status-rebind":"rebind_required","status-pending":"local_change_pending"][mode]
  if let expectedReason{check(reply["reason"] as? String==expectedReason,"genuine negative reason preserved")}
  if mode=="status-pending"{check(disk.reads==reads && reply["local"] is NSNull,"known pending pause uses no store read or fabricated local snapshot")}
  check(disk.data==before && disk.writes==writes && sdk.queries==queries && ingests==sent && allocations==allocated,"status preserves bytes writes SDK ingestion allocation")
  if reply["state"] as? String=="ready"{host.sync(selection:"known",category:"sleep"){result in check((try? result.get()) == .applied && sdk.queries>0 && ingests>0,"ready verified by actual native SDK and authenticated POST");finish()}}else{finish()}
 }
}
func pauseRequest(_ id:String="00000000-0000-4000-8000-000000000088")->[String:Any]{["schemaVersion":"1.0.0","operationId":id,"sourceNamespace":namespace,"enrollmentId":enrollment.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased()]}
func checkPauseSuperseded(_ value:[String:Any]){check(value["persistence"] as? String=="notApplied" && value["drain"] as? String=="notStarted" && value["reason"] as? String=="context_changed","old pause observation cannot claim current paused")}
func runPause(){
 let runtime=host.runtime!;var request=pauseRequest();let prior=disk.data,initialQueries=sdk.queries,initialIngest=ingests,initialRequests=requests,initialAllocations=allocations
 if mode.hasPrefix("pause-wrong-"){
  let key=["pause-wrong-source":"sourceNamespace","pause-wrong-enrollment":"enrollmentId","pause-wrong-endpoint":"endpointId"][mode]!
  request[key]="00000000-0000-4000-8000-000000000099";let before=disk.data,writes=disk.writes
  let result=pauseNow(request);check(result["persistence"] as? String=="notApplied" && result["reason"] as? String=="source_mismatch","wrong target rejected")
  check(disk.data==before && disk.writes==writes && sdk.queries==initialQueries && requests==initialRequests,"wrong target has no effects");finish();return
 }
 if mode=="pause-protected"{protectedHealthy=false}
 if mode=="pause-offline"{statusHTTP=503}
 if mode=="pause-no-proof"{fixtureInput.makeProtectedUnavailable(enrollment:enrollment)}
 if mode=="pause-locked"{disk.locked=true}
 if mode=="pause-write-fail" || mode=="pause-domains-fail"{disk.failWrite=true}
 if mode=="pause-write-then-throw"{disk.writeThenThrow=true}
 if mode=="pause-corrupt"{disk.data=Data([1])}
 if mode=="pause-already"{try! fixtureInput.pause(enrollment:enrollment)}
 let before=disk.data,writes=disk.writes
 let replacementAttemptsBefore=UInt64(disk.writes)
 if mode=="pause-reentrant"{sdk.handle.onStop={host.sync(selection:"known",category:"sleep"){check((try? $0.get())==nil,"stop callback cannot restart sync")};host.setup(selection:"known",action:.resumeExistingLocal){check((try? $0.get())==nil,"stop callback cannot resume")}}}
 if mode=="pause-retiring"{
  let original=host.runtime
  host.withdraw()
  check(host.runtime==nil && host.status()["state"] as? String=="draining","revoked owner retained until actual callback")
  let reads=disk.reads
  for _ in 0..<3 {
   let refused=pauseNow(request)
   check(refused["persistence"] as? String=="notApplied" && refused["drain"] as? String=="notStarted" && refused["reason"] as? String=="context_changed","revoked Root cannot save a new pause")
  }
  host.setup(selection:"known",action:.resumeExistingLocal){check((try? $0.get())==nil,"retiring owner cannot be replaced")}
  host.sync(selection:"known",category:"sleep"){check((try? $0.get())==nil,"retiring owner cannot sync")}
  check(disk.reads==reads && disk.data==before && disk.writes==writes && requests==initialRequests && ingests==initialIngest && sdk.queries==initialQueries && allocations==initialAllocations,"refusal performs no I/O or replacement")
  sdk.callback?(.success(NativeHealthPage(observations:[],deleted:["late"],anchor:Data([3]),mayHaveMore:false)))
  later {
   check(host.runtime==nil && host.status()["state"] as? String != "draining" && original?.preservesPauseHold==false,"original callback drains without manufacturing a pause hold")
   check(disk.data==before && disk.writes==writes && requests==initialRequests && ingests==initialIngest && sdk.queries==initialQueries && allocations==initialAllocations,"late revoked callback cannot commit or replace owner")
   finish()
  }
  return
 }
 let reply=pauseNow(request)
 let uncertain=["pause-locked","pause-write-fail","pause-write-then-throw","pause-corrupt","pause-domains-fail"].contains(mode)
 check(reply["persistence"] as? String==(uncertain ? "unconfirmed":"savedPaused"),"honest persistence: \(reply)")
 check(reply["drain"] as? String=="pending","drain is separate from logical completion")
 if mode=="pause-already"{check(disk.writes==writes,"already paused does not write")}
 if mode=="pause-locked" || mode=="pause-write-fail" || mode=="pause-domains-fail" {check(disk.data==before,"failed atomic storage preserved")}
 if mode=="pause-domains" || mode=="pause-domains-fail" {
  let replacementAttemptsAfter=UInt64(disk.writes)
  check(replacementAttemptsAfter>replacementAttemptsBefore,"original shared snapshot replacement attempted; private Share generation not observed")
  check((try? fixtureInput.pendingCalendar(ticket:calendarTicket!))==calendarPending,"stored Calendar bytes preserved; actual admission exercised by shared Calendar continuation")
  if let old=before,let data=disk.data {let a=try! JSONSerialization.jsonObject(with:old) as! [String:Any],b=try! JSONSerialization.jsonObject(with:data) as! [String:Any];check(NSDictionary(dictionary:a["shareAssociations"] as! [String:Any]).isEqual(to:b["shareAssociations"] as! [String:Any]),"Share records preserved");func canonicalCalendar(_ value:Any)->Data{var rows=value as! [Any];for i in stride(from:1,to:rows.count,by:2){var row=rows[i] as! [String:Any];row["categories"]=(row["categories"] as! [String]).sorted();rows[i]=row};return bytes(rows)};check(canonicalCalendar(a["calendarEnrollments"]!)==canonicalCalendar(b["calendarEnrollments"]!),"Calendar records/settings preserved")}
 }
 let count=disk.writes,stops=sdk.handle.stops
 let again=pauseNow(request);check(again["persistence"] as? String==reply["persistence"] as? String && disk.writes==count && sdk.handle.stops==stops,"same ID observes without repeated IO")
 let different=pauseNow(pauseRequest("00000000-0000-4000-8000-000000000089"));check(different["persistence"] as? String=="notApplied" && different["drain"] as? String=="notStarted" && disk.writes==count,"different ID cannot replace held action")
 var mismatch=request;mismatch["sourceNamespace"]="00000000-0000-4000-8000-000000000099";check(pauseNow(mismatch)["reason"] as? String=="source_mismatch","same ID cannot retarget")
 check(requests==initialRequests && ingests==initialIngest && sdk.queries==initialQueries && allocations==initialAllocations,"pause itself starts no request query or allocation")
 host.setup(selection:"known",action:.resumeExistingLocal){check((try? $0.get())==nil,"paused runtime cannot resume through setup")}
 host.sync(selection:"known",category:"sleep"){check((try? $0.get())==nil,"paused runtime cannot sync")}
 if mode=="pause-never" {later{check(pauseNow(request)["drain"] as? String=="pending","never arriving SDK callback stays pending");finish()};return}
 if ["pause-sdk","pause-reentrant","pause-retiring"].contains(mode){sdk.callback?(.success(NativeHealthPage(observations:[],deleted:["late"],anchor:Data([3]),mayHaveMore:false)))}
 releaseHeld?();releaseHeld=nil
 later {
  let completed=pauseNow(request)
  if mode != "pause-retiring"{check(completed["drain"] as? String=="drained","physical callbacks drained")}
  if uncertain{check(completed["persistence"] as? String=="unconfirmed","readback never upgrades uncertainty");host.setup(selection:"known",action:.resumeExistingLocal){check((try? $0.get())==nil,"uncertain pause blocks resume after drain")};host.withdraw();later{host.setup(selection:"known",action:.enrollExistingRemote){check((try? $0.get())==nil,"unknown pause cannot escape via runtime replacement")};finish()};return}
  check(disk.writes==count && sdk.queries==initialQueries && ingests==initialIngest,"no late commit or additional send")
  if mode=="pause-rebuild"{let copy=HealthOutbox(storage:disk);try! copy.setHuman(human);let proof=try! MobileHealthPolicyParser.parse(bytes(policy),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:enrollment);do{try copy.confirmEffectivePolicy(proof:proof);check(false,"server active cannot unpause saved state")}catch{};check((try! copy.status(enrollment:enrollment)).paused,"saved pause survives outbox reconstruction")}
  if ["pause-setup-reentrant","pause-sync-reentrant"].contains(mode){check(requests==initialRequests,"callback-triggered pause prevents new work")}
  if ["pause-resume-existing","pause-resume-interval","pause-resume-uncertain"].contains(mode) {
   if mode=="pause-resume-interval" {
    holdPolicy=true;pauseTrigger={let writes=disk.writes;let observation=pauseNow(request);checkPauseSuperseded(observation);check(disk.writes==writes,"in-flight old ID read has no write");releaseHeld?();releaseHeld=nil}
   }
   if mode=="pause-resume-uncertain"{disk.writeThenThrow=true}
   host.setup(selection:"known",action:.resumeExistingLocal){result in
    if mode=="pause-resume-uncertain" {
     check((try? result.get())==nil,"uncertain resume reports failure")
     checkPauseSuperseded(pauseNow(request))
     disk.writeThenThrow=false;let allocationCount=allocations
     host.withdraw();later{host.setup(selection:"known",action:.confirmExistingLocal){check((try? $0.get())==nil && allocations==allocationCount,"uncertain resume cannot escape via replacement")};finish()};return
    }
    check((try? result.get()) != nil,"preexisting explicit resume works after confirmed drained pause")
       let writes=disk.writes,queries=sdk.queries,posts=ingests
    let old=pauseNow(request)
    check(old["persistence"] as? String=="notApplied" && old["drain"] as? String=="notStarted" && old["reason"] as? String=="context_changed","old pause observation is superseded")
    check(disk.writes==writes && sdk.queries==queries && ingests==posts,"old ID cannot repeat effect")
    host.sync(selection:"known",category:"sleep"){result in
     check((try? result.get()) == .applied,"sync works after explicit resume")
     let next=pauseNow(pauseRequest("00000000-0000-4000-8000-000000000089"))
     check(next["persistence"] as? String=="savedPaused","new explicit ID can replace superseded cache")
     finish()
    }
   };return
  }
  _=prior;finish()
 }
}
func resumeRequest()->[String:Any]{["schemaVersion":"1.0.0","operationId":"00000000-0000-4000-8000-000000000090","expectedPauseOperationId":pauseRequest()["operationId"]!,"sourceNamespace":namespace,"enrollmentId":enrollment.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased()]}
func runResumeUI(){
 let runtime=host.runtime!
 if mode=="resume-ui-no-pause" {
  let r=requests,w=disk.writes
  host.resumeCollection(resumeRequest()){reply in check(reply["reason"] as? String=="no_known_pause" && requests==r && disk.writes==w,"known runtime without pause stays inert");finish()};return
 }
 let pause=pauseRequest(),saved=pauseNow(pause)
 if mode=="resume-ui-uncertain-pause"{check(saved["persistence"] as? String=="unconfirmed","uncertain pause fixture")}
 func invoke(){
  var request=resumeRequest()
  if mode=="resume-ui-wrong-pause"{request["expectedPauseOperationId"]="00000000-0000-4000-8000-000000000099"}
  if mode=="resume-ui-wrong-source"{request["sourceNamespace"]="00000000-0000-4000-8000-000000000099"}
  if mode=="resume-ui-config"{provenance="changed"}
  if mode=="resume-ui-protected"{protectedHealthy=false}
  if mode=="resume-ui-auth-503"{authStatus=503}
  if mode=="resume-ui-auth-401"{authStatus=401}
  if mode=="resume-ui-write"{disk.failWrite=true}
  if mode=="resume-ui-write-then-throw"{disk.writeThenThrow=true}
  if mode.hasPrefix("resume-ui-final-"){resumeMutationAfterWrites=disk.writes+1}
  let policyModes=["resume-ui-policy":"blocked","resume-ui-categories":"categories","resume-ui-source":"source","resume-ui-server-paused":"paused","resume-ui-server-disconnected":"disconnected"]
  resumePolicyMode=policyModes[mode] ?? ""
  let initialRequests=requests,writes=disk.writes,allocated=allocations,queries=sdk.queries,posts=ingests
  if mode=="resume-ui-duplicate" {
   holdPolicy=true
   pauseTrigger={
    let r=requests,w=disk.writes
    host.resumeCollection(request){reply in check(reply["reason"] as? String=="busy","pending same ID busy")}
    var changed=request;changed["expectedPauseOperationId"]="00000000-0000-4000-8000-000000000097";host.resumeCollection(changed){reply in check(reply["reason"] as? String=="source_mismatch","same ID changed tuple denied")}
    var other=request;other["operationId"]="00000000-0000-4000-8000-000000000091";host.resumeCollection(other){reply in check(reply["reason"] as? String=="busy","pending other ID busy")}
    check(requests==r && disk.writes==w,"pending duplicates no HTTP or write")
    releaseHeld?();releaseHeld=nil
   }
  }
  if ["resume-ui-new-pause-pending","resume-ui-context-pending","resume-ui-withdraw-pending"].contains(mode) {
   holdPolicy=true
   pauseTrigger={
    if mode=="resume-ui-new-pause-pending"{_ = pauseNow(pauseRequest("00000000-0000-4000-8000-000000000093"))}
    if mode=="resume-ui-context-pending"{contextRevision+=1}
    if mode=="resume-ui-withdraw-pending"{host.withdraw()}
    releaseHeld?();releaseHeld=nil
   }
  }
  host.resumeCollection(request){reply in
   check(Set(reply.keys)==Set(["schemaVersion","operationId","binding","outcome","reason"]),"closed resume DTO")
   let succeeds=["resume-ui-success","resume-ui-duplicate","resume-ui-cached-proof","resume-ui-cached-config","resume-ui-stale","resume-ui-multicategory","resume-ui-cached-busy"].contains(mode)
   let uncertain=["resume-ui-write","resume-ui-write-then-throw","resume-ui-final-protected","resume-ui-final-config"].contains(mode)
   check(reply["outcome"] as? String==(succeeds ? "resumed":uncertain ? "unconfirmed":"notApplied"),"resume outcome: \(reply)")
   check(allocations==allocated && sdk.queries==queries && ingests==posts,"resume never creates runtime or sync/query")
   if ["resume-ui-wrong-pause","resume-ui-wrong-source","resume-ui-config","resume-ui-protected","resume-ui-pending","resume-ui-uncertain-pause"].contains(mode){check(requests==initialRequests && disk.writes==writes,"denied before remote or write")}
   if ["resume-ui-context-pending","resume-ui-auth-503"].contains(mode){check(disk.writes==writes,"pre-mutation denial leaves saved pause unchanged")}
   if succeeds {
    check((try? fixtureInput.storedPaused(enrollment))==false,"definite resume unpauses")
   }
   if mode=="resume-ui-cached-busy" {
    host.setup(selection:"known",action:.resumeExistingLocal){_ in}
    let r=requests,w=disk.writes
    host.resumeCollection(request){cached in check(cached["outcome"] as? String=="notApplied" && cached["reason"] as? String=="context_changed","cached resume cannot claim current enabled during new setup")}
    check(requests==r && disk.writes==w,"cached busy observation has zero HTTP/write");finish();return
   }
   if succeeds {
    var different=request;different["operationId"]="00000000-0000-4000-8000-000000000096"
    let r=requests,w=disk.writes
    host.resumeCollection(different){reply in check(reply["reason"] as? String=="pause_changed","different ID cannot replay superseded pause")}
    check(requests==r && disk.writes==w,"different completed ID inert")
   }
   if mode=="resume-ui-cached-proof"{fixtureInput.makeProtectedUnavailable(enrollment:enrollment)}
   if mode=="resume-ui-cached-config"{provenance="changed again"}
   if mode=="resume-ui-stale"{_ = pauseNow(pauseRequest("00000000-0000-4000-8000-000000000092"))}
   let beforeRepeat=requests,repeatWrites=disk.writes
   host.resumeCollection(request){second in
    if ["resume-ui-cached-proof","resume-ui-cached-config","resume-ui-stale"].contains(mode){check(second["outcome"] as? String=="notApplied","stale cached resume cannot claim current enabled")}
    else{check(second["outcome"] as? String==reply["outcome"] as? String,"stable result observation")}
    check(requests==beforeRepeat && disk.writes==repeatWrites,"completed ID repeat has no HTTP/write")
    if uncertain {
     host.withdraw();later{host.setup(selection:"known",action:.confirmExistingLocal){check((try? $0.get())==nil,"uncertain resume holds recreation")};finish()}
    }else if succeeds && !["resume-ui-cached-proof","resume-ui-cached-config","resume-ui-stale"].contains(mode){host.sync(selection:"known",category:"sleep"){result in check((try? result.get()) == .applied && sdk.queries>queries && ingests>posts,"resumed authority executes actual native collection and POST");finish()}}else{finish()}
   }
  }
 }
 if mode=="resume-ui-pending"{invoke()}else{later{invoke()}}
}
// Production-root integration fixtures. Only these external ports supply data,
// SDK callbacks and original custody. No substituted Runtime, Host or wire owner.
final class SharedDispatchCounter {private let lock=NSLock();private var value=0;func record(){lock.lock();value+=1;lock.unlock()};var count:Int{lock.lock();defer{lock.unlock()};return value}}
let sharedDispatch=SharedDispatchCounter()
let sharedCustodySite=ProcessInfo.processInfo.environment["SHARED_CUSTODY_SITE"] ?? "reply"
let sharedCancelSite=ProcessInfo.processInfo.environment["SHARED_CANCEL_SITE"] ?? "none"
var sharedCalendarPolicies=0,sharedDispatchAtCancel=0,sharedSessionCalls=0,sharedSessionBase=0,sharedFinalProviderChecks=0,sharedMappingFired=false,sharedDispatchAtMapping=0
let sharedConfigSite=ProcessInfo.processInfo.environment["SHARED_CONFIG_SITE"] ?? "calendar"
let sharedWriteStage=ProcessInfo.processInfo.environment["SHARED_WRITE_STAGE"] ?? "collection"
let sharedReadSite=ProcessInfo.processInfo.environment["SHARED_READ_SITE"] ?? "ticket"
let sharedCalendarFixture=try! JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:ProcessInfo.processInfo.environment["CALENDAR_FIXTURE"]!))) as! [String:Any]
let sharedEnrollment=UUID(uuidString:"30000000-0000-4000-8000-000000000001")!,sharedNamespace=UUID(uuidString:"10000000-0000-4000-8000-000000000001")!
var sharedAccessChecks=0
var sharedPosts=0,sharedFactoryCalls=0,sharedQueries=0,sharedClock=0,sharedCustodyAcquires=0,sharedCustodyReleases=0,sharedHealthy=true,sharedInjected=false,sharedReplies=0,sharedHoldHealthIngest=false,sharedLaunchWhileHeld:(()->Void)?,sharedReleasePost:(()->Void)?,sharedConfigReentered=false,sharedUnknownArmed=false,sharedHealthAtLease:[[String:Any]]?
final class SharedCustody:NativeSharedOutboxCustodyLease {
 let original:Disk;let binding:NativeSharedOutboxOwner.Binding
 var released=false
 init(_ storage:Disk,_ binding:NativeSharedOutboxOwner.Binding){original=storage;self.binding=binding}
 func isCurrent(storage:any HealthSnapshotStorage,binding:NativeSharedOutboxOwner.Binding)->Bool{!released && sharedHealthy && (storage as? Disk) === original && self.binding==binding}
 func withFence<T>(_ body:()throws->T)throws->T{
  guard !released,sharedHealthy else{throw CocoaError(.fileReadNoPermission)}
  let value=try body()
  if healthChoiceMode,choiceUnwindArmed,!choiceUnwindAttempted{
   choiceUnwindAttempted=true;let requestsBefore=requests,writesBefore=disk.writes
   // Real Calendar-held parent. New permission MUST deny entry, never borrow it.
   host.performChoice(.permission,input:choiceUnwindInput){reply in check(reply["requestState"] as? String=="notInvoked","permission cannot borrow Calendar withFence unwind")}
   check(requests==requestsBefore && disk.writes==writesBefore && choiceAuthCalls==0,"Calendar-held permission denial no Core/OS effects")
   choiceMutate("plan")
  }
  return value
 }
 func release(){check(!released,"parent release exactly once");released=true;sharedCustodyReleases+=1;if mode=="shared-release-reentry"{checkSharedAdmissionDenied()}}
}
struct SharedEvent:MobileEventKitEventReading {
 func readEvent()throws->MobileEventKitRawEvent{.init(item:.init(itemIdentifier:.observed("synthetic-event"),calendarIdentifier:.observed("selected"),accountIdentifier:.observed("synthetic-account"),externalIdentifier:.observed(nil),title:.observed("Synthetic event"),notes:.observed(nil),recurrenceRules:.observed(nil)),startDate:.observed(Date(timeIntervalSince1970:1793404800)),endDate:.observed(Date(timeIntervalSince1970:1793408400)),isAllDay:.observed(false),timeZoneIdentifier:.observed("UTC"),occurrenceDate:.observed(nil),isDetached:.observed(false),statusRawValue:.observed(1),alarms:.observed(nil))}
}
struct SharedTask:MobileEventKitReminderReading {func readReminder()throws->MobileEventKitRawReminder{.init(item:.init(itemIdentifier:.observed("synthetic-task"),calendarIdentifier:.observed("selected"),accountIdentifier:.observed("synthetic-account"),externalIdentifier:.observed(nil),title:.observed("Synthetic task"),notes:.observed(nil),recurrenceRules:.observed(nil)),dueDateComponents:.observed(nil),isCompleted:.observed(false),completionDate:.observed(nil))}}
final class SharedBatch:MobileEventKitReminderBatch{var count:Int{1};func reminder(at index:Int)->any MobileEventKitReminderReading{SharedTask()}}
final class SharedToken:MobileEventKitFetchToken{}
final class SharedStore:MobileEventKitStoreReading{
 func access(_ plan:MobileEventKitAcquisition.Plan)->MobileEventKitReadAccess{sharedAccessChecks+=1;return .fullRead}
 func enumerateEvents(_ plan:MobileEventKitAcquisition.Plan,yield:@escaping(any MobileEventKitEventReading)->Bool)throws{sharedQueries+=1;_ = yield(SharedEvent())}
 func fetchReminders(_ plan:MobileEventKitAcquisition.Plan,completion:@escaping((any MobileEventKitReminderBatch)?)->Void)throws->any MobileEventKitFetchToken{sharedQueries+=1;DispatchQueue.main.async{completion(SharedBatch())};return SharedToken()}
 func cancelFetch(_ token:any MobileEventKitFetchToken){}
}
func sharedSelection(_ selector:String)->NativeHealthHost.CalendarSelection?{
 guard selector=="calendar",(mode.hasPrefix("shared-") || healthChoiceMode) else{return nil}
 if mode=="shared-config-reentry",!sharedConfigReentered{sharedConfigReentered=true;host.calendarDeliverPending(selection:"calendar"){check($0 == .notApplied(.unavailable),"Host native-config reentry fenced")}}
 if mode=="shared-health-admission",sharedCancelSite != "none",sharedCalendarPolicies==(sharedCancelSite=="final-read" ? 2:3),!sharedInjected {
  sharedInjected=true;disk.onRead={disk.onRead=nil;sharedDispatchAtCancel=sharedDispatch.count;host.calendarCancel()}
 }
 if mode=="shared-custody-loss",sharedCustodySite != "reply",sharedCalendarPolicies==(sharedCustodySite=="final-read" ? 2:3),!sharedInjected {
  sharedInjected=true;var reads=0
  disk.onRead={reads+=1;if reads==2{disk.onRead=nil;sharedDispatchAtCancel=sharedDispatch.count;sharedHealthy=false}}
 }
 if mode=="shared-config-reentry",sharedConfigSite.hasPrefix("final-root-"),sharedSessionCalls==sharedSessionBase+(sharedConfigSite=="final-root-send" ? 8:12) {
  sharedFinalProviderChecks+=1
  if sharedFinalProviderChecks==3{sharedMappingFired=true;sharedDispatchAtMapping=sharedDispatch.count;provenance="remapped-native-root"}
 }
 let category=mode=="shared-calendar-task" ? "Task":"CalendarEvent"
 let config=NativeCalendarAcquisitionOwner.Configuration(provenance:"synthetic-calendar",origin:origin,human:human,session:session,endpoint:endpoint,enrollment:sharedEnrollment,namespace:sharedNamespace,plan:.init(category:category,selectedContainerIDs:["selected"],mappingVersion:"synthetic-calendar-mapping/1",coverageStart:Date(timeIntervalSince1970:1793404800),coverageEnd:Date(timeIntervalSince1970:1793491200),capturedSDKDefaultTimeZone:TimeZone(secondsFromGMT:0)!),protectedAvailable:{protectedHealthy},deliveryScope:syntheticVerifiedCalendarScope)
 let custody:NativeSharedOutboxOwner.Custody? = mode=="shared-custody-absent" ? nil:{ storage,binding in
  sharedCustodyAcquires+=1;sharedHealthAtLease=sharedRows(disk.data,"enrollments")
  if mode=="shared-provider-reentry"{checkSharedAdmissionDenied()}
  let bound=mode=="shared-custody-wrong-scope" ? NativeSharedOutboxOwner.Binding(origin:"https://wrong.invalid",human:human,session:session,endpoint:endpoint):binding
  return SharedCustody(mode=="shared-custody-wrong-store" ? Disk():disk,bound)
 }
 return .init(runtimeSelection:"known",configuration:.init(configuration:config,custody:custody,makeAcquisition:{box in sharedFactoryCalls+=1;return MobileEventKitAcquisition(outbox:box,storePort:SharedStore(),executeOnWorker:{$0()})},captureClock:{sharedClock+=1;return Date(timeIntervalSince1970:1793404800)}))
}
func sharedCalendarResponse(_ loader:URLProtocol,_ body:[String:Any]){
 let payload=body["payload"] as! [String:Any]
 func send(_ object:[String:Any]){loader.client?.urlProtocol(loader,didReceive:HTTPURLResponse(url:loader.request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!,cacheStoragePolicy:.notAllowed);loader.client?.urlProtocol(loader,didLoad:bytes(object));loader.client?.urlProtocolDidFinishLoading(loader)}
 if payload["operation"] as? String=="policy"{sharedCalendarPolicies+=1;send(sharedCalendarFixture["policy"] as! [String:Any]);return}
 check(payload["operation"] as? String=="ingest","actual Calendar ingest operation")
 sharedPosts+=1
 let items=(payload["items"] as! [[String:Any]]).map{try! MobileCalendarDelivery.item(bytes($0))}
 let result:[String:Any]=["schemaVersion":"1.0.0","producerPin":sharedCalendarFixture["producerPin"]!,"result":["kind":"sync","receipts":items.map{["eventId":$0.eventId.uuidString.lowercased(),"requestDigest":$0.digest,"outcome":"accepted","code":"applied","durability":"sqlCommit"]}]]
 sharedReleasePost={send(result)}
 if mode=="shared-health-admission"{checkSharedAdmissionDenied()}
 if mode=="shared-custody-loss",sharedCustodySite=="reply"{sharedHealthy=false;send(result);return}
 if sharedPosts==1,(mode=="shared-pause-calendar" || mode=="shared-pause-duplicates") {
  let before=disk.writes
  if mode=="shared-pause-duplicates"{disk.onReplace={_ in
   disk.onReplace=nil;let n=disk.reads,w=disk.writes
   for _ in 0..<16{host.pauseCollection(pauseRequest()){reply in check(reply["persistence"] as? String=="notApplied" && reply["reason"] as? String=="busy","duplicate invocation only; original still pending")}}
   host.pauseCollection(pauseRequest("00000000-0000-4000-8000-000000000099")){check($0["reason"] as? String=="busy","conflicting pending ID bounded")}
   check(disk.reads==n && disk.writes==w,"duplicate burst no I/O, waiter or extra action")
  }}
  host.pauseCollection(pauseRequest()){reply in check(reply["persistence"] as? String=="savedPaused","first actual protective pause saved while Calendar HTTP pending");check(sharedPosts==1 && sharedCustodyAcquires==1 && sharedCustodyReleases==0,"same retained parent, no HTTP drain wait");check(disk.writes==before+1,"one first protective snapshot write");host.pauseCollection(pauseRequest()){cached in check(cached["persistence"] as? String=="savedPaused" && disk.writes==before+1,"same ID observes actual final pause without another write")};send(result)};return
 }
 if mode.hasPrefix("shared-withdraw-"){host.withdraw(authorityChanged:mode=="shared-withdraw-authority");send(result);return}
 if mode=="shared-calendar-unknown" || (["shared-write-before","shared-write-after"].contains(mode) && sharedWriteStage=="calendarSettlement"){armSharedWrite("calendarSettlement")}
 send(result)
}
func sharedRows(_ data:Data?,_ key:String)->[[String:Any]]{guard let data,let object=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else{return []};return (object[key] as? [Any] ?? []).compactMap{$0 as? [String:Any]}}
func sharedCount(_ data:Data?,_ key:String)->Int{sharedRows(data,key).reduce(0){$0+(($1["queue"] as? [Any])?.count ?? 0)}}
func armSharedWrite(_ stage:String){
 disk.onReplace={value in
  let health=sharedCount(value,"enrollments"),oldHealth=sharedCount(disk.data,"enrollments"),calendar=sharedCount(value,"calendarEnrollments"),oldCalendar=sharedCount(disk.data,"calendarEnrollments")
  let pause=sharedRows(value,"enrollments").contains{$0["paused"] as? Bool==true}
  let hit=stage=="setup" || stage=="collection" && health>oldHealth || stage=="healthSettlement" && oldHealth>health || stage=="calendarSettlement" && oldCalendar>calendar || stage=="pause" && pause
  if hit{sharedUnknownArmed=true;disk.onReplace=nil;if mode=="shared-write-before"{disk.failWrite=true}else{disk.writeThenThrow=true}}
 }
}
func checkSharedAdmissionDenied(){
 let writes=disk.writes,queries=sdk.queries,posts=ingests
 host.setup(selection:"known",action:.confirmExistingLocal){check((try? $0.get())==nil,"normal Health setup excluded")}
 host.sync(selection:"known",category:"sleep"){check((try? $0.get())==nil,"normal Health sync excluded")}
 host.resumeCollection(resumeRequest()){check($0["outcome"] as? String=="notApplied","ordinary resume excluded")}
 check(disk.writes==writes && sdk.queries==queries && ingests==posts,"no normal competing writer/SDK/POST")
}
func seedShared(){
 // Explicit lowest-level input bytes, constructed before a native operation.
 let proof=try! MobileCalendarPolicyParser.parse(bytes(sharedCalendarFixture["policy"]!),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:sharedEnrollment)
 try! fixtureInput.admitCalendar(proof:proof)
 let ticket=try! fixtureInput.calendarTicket(enrollment:sharedEnrollment,category:"CalendarEvent")
 var item=(sharedCalendarFixture["vectors"] as! [[String:Any]])[0]["item"] as! [String:Any],change=item["change"] as! [String:Any];change["expectedPolicyRevision"]=proof.revision;var source=change["source"] as! [String:Any];source["accountId"]="synthetic-account";change["source"]=source;var record=change["record"] as! [String:Any];var time=record["time"] as! [String:Any];time["timeZone"]=["kind":"supplied","identifier":"UTC"];record["time"]=time;change["record"]=record;item["change"]=change
 let scope=try! MobileCalendarDelivery.CheckpointScope(collector:"eventKit",namespace:sharedNamespace,mappingVersion:"synthetic-calendar-mapping/1",coverage:.partial,start:"2026-10-01T00:00:00Z",end:"2026-10-02T00:00:00Z")
 if !["shared-calendar-event","shared-calendar-task"].contains(mode){try! fixtureInput.commitCalendar(scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([9]),items:[bytes(item)],ticket:ticket)}
}
func seedSharedShare(){
 let raw=try! String(contentsOfFile:ProcessInfo.processInfo.environment["SHARE_FIXTURE"]!,encoding:.utf8).replacingOccurrences(of:"\\ud800",with:"__UNPAIRED__")
 let pairs=(try! JSONSerialization.jsonObject(with:Data(raw.utf8)) as! [String:Any])["pairs"] as! [[String:Any]]
 var item=pairs.first{$0["case"] as? String=="file-reference"}!["ios"] as! [String:Any],content=item["content"] as! [String:Any],artifact=content["artifact"] as! [String:Any]
 let payload=Data([0,1,2,3,255]);func hash(_ d:Data)->String{SHA256.hash(data:d).map{String(format:"%02x",$0)}.joined()}
 artifact["byteLength"]=payload.count;artifact["sha256"]=hash(payload);content["artifact"]=artifact;item["content"]=content
 let value=try! MobileSharedItem.decode(bytes(item)),attempt=UUID(),receipt=UUID()
 let key=hash(try! JSONEncoder().encode([human.uuidString.lowercased(),endpoint.uuidString.lowercased(),value.source.namespace.uuidString.lowercased(),value.source.collector,attempt.uuidString.lowercased()]))
 var state=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any];state["version"]=3
 state["shareAssociations"]=[key:["human":human.uuidString,"endpoint":endpoint.uuidString,"namespace":value.source.namespace.uuidString,"collector":value.source.collector,"epoch":1,"attempt":attempt.uuidString,"receipt":receipt.uuidString,"item":value.data.base64EncodedString(),"digest":hash(value.data),"bytes":payload.base64EncodedString(),"contentDigest":hash(payload),"length":payload.count]]
 disk.data=bytes(state)
}
func assertSharedUnknown(){
 check(sharedUnknownArmed || mode=="shared-calendar-unknown","actual targeted replace was invoked")
 disk.failWrite=false;disk.writeThenThrow=false
 let before=disk.data,writes=disk.writes,allocated=allocations,queries=sdk.queries,posts=ingests+sharedPosts
 host.setup(selection:"known",action:.confirmExistingLocal){check((try? $0.get())==nil,"underlying unknown blocks later ordinary writer")}
 host.calendarDeliverPending(selection:"calendar"){check($0 == .notApplied(.unavailable),"unknown root cannot start Calendar")}
 host.withdraw();later{
  host.setup(selection:"known",action:.enrollExistingRemote){check((try? $0.get())==nil,"unknown root held across attempted replacement")}
  check(disk.data==before && disk.writes==writes && allocations==allocated && sdk.queries==queries && ingests+sharedPosts==posts,"no readback upgrade/rewrite/reallocation/query/send")
  check(host.status()["state"] as? String=="draining","original unknown root retained");finish()
 }
}
func startSharedCalendar(){
 sharedSessionBase=sharedSessionCalls
 let pendingOnly = !["shared-calendar-event","shared-calendar-task"].contains(mode)
 let beforeHealth=sharedRows(disk.data,"enrollments")
 let beforeShare=(try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any])["shareAssociations"]
 func done(_ result:NativeCalendarAcquisitionOwner.DeliveryOutcome){
  sharedReplies+=1;check(sharedReplies==1,"one original Calendar logical completion")
  if mode=="shared-health-admission",sharedCancelSite != "none" {
   print("Cancel causal site=\(sharedCancelSite) dispatchesAfterCancel=\(sharedDispatch.count-sharedDispatchAtCancel) queued=\(sharedCount(disk.data,"calendarEnrollments")) result=\(result)")
   check(sharedInjected,"cancel injected at final fresh-ticket read")
   guard case .notApplied=result else{check(false,"cancel before exact queue observation prevents settlement");return}
   if sharedCancelSite=="final-read"{check(sharedDispatch.count==sharedDispatchAtCancel,"cancel before final queue-read return prevents intercepted authenticated POST attempt")}
   check(sharedCount(disk.data,"calendarEnrollments")==1,"cancel before effect retains exact original queued record")
   later{finish()};return
  }
  if mode=="shared-config-reentry",sharedConfigSite.hasPrefix("final-root-") {
   print("Root mapping causal site=\(sharedConfigSite) fired=\(sharedMappingFired) postAttemptsAfterMapping=\(sharedDispatch.count-sharedDispatchAtMapping) queue=\(sharedCount(disk.data,"calendarEnrollments")) result=\(result)")
   check(sharedMappingFired,"provider remapped root only on final native currentness callback")
   guard case .notApplied=result else{check(false,"remapped original root must refuse before settlement");return}
   if sharedConfigSite=="final-root-send"{check(sharedDispatch.count==sharedDispatchAtMapping,"final provider root remap prevents POST")}
   check(sharedCount(disk.data,"calendarEnrollments")==1,"remapped root retains original queued record");later{finish()};return
  }
  if mode=="shared-custody-loss",sharedCustodySite != "reply" {
   print("Custody causal site=\(sharedCustodySite) postAttemptsAfterLoss=\(sharedDispatch.count-sharedDispatchAtCancel) queue=\(sharedCount(disk.data,"calendarEnrollments")) result=\(result)")
   check(sharedInjected && !sharedHealthy,"custody lost only inside final pending read")
   guard case .notApplied=result else{check(false,"lost custody before effect must refuse before settlement invocation, not create ambiguous intent");return}
   if sharedCustodySite=="final-read"{check(sharedDispatch.count==sharedDispatchAtCancel,"post-read custody loss prevents intercepted POST")}
   check(sharedCount(disk.data,"calendarEnrollments")==1,"custody loss retains exact queued record")
   later{check(sharedCustodyReleases==1,"known refusal releases only after callbacks retire");finish()};return
  }
  if mode=="shared-calendar-unknown" || (["shared-write-before","shared-write-after"].contains(mode) && sharedWriteStage=="calendarSettlement") {guard case .settlementUnconfirmed=result else{check(false,"actual Calendar settlement unknown");return};assertSharedUnknown();return}
  if mode.hasPrefix("shared-custody-") || mode=="shared-late-policy" || mode.hasPrefix("shared-withdraw-") {
   guard case .notApplied=result else{check(false,"lost/absent authority or withdrawal refuses original native operation");return}
   if mode != "shared-custody-loss"{check(sharedPosts==0 || mode.hasPrefix("shared-withdraw-"),"no new POST without original custody")}
  }else {
   guard case .settled(let accepted,_,_,_,_)=result else{check(false,"actual Host original Calendar receipt settlement");return};check(accepted==1 && sharedPosts==1,"exact actual native batch settled")
   if pendingOnly{check(sharedFactoryCalls==0 && sharedQueries==0 && sharedClock==0,"pending-only no new acquisition SDK/factory/clock")}
   if !["shared-pause-calendar","shared-pause-duplicates"].contains(mode){check(bytes(sharedRows(disk.data,"enrollments"))==bytes(sharedHealthAtLease ?? beforeHealth),"Calendar preserves Health rows AFTER actual prior Health callbacks drained")}
  }
  if let beforeShare{let after=(try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any])["shareAssociations"]!;check(bytes(beforeShare)==bytes(after),"actual root writes preserve stored Share associations")}
  if mode=="shared-custody-absent"{host.sync(selection:"known",category:"sleep"){result in check((try? result.get()) == .applied && sdk.queries==1 && ingests==1,"missing Calendar custody leaves actual ordinary Health authority intact");host.pauseCollection(pauseRequest()){reply in check(reply["persistence"] as? String=="savedPaused","missing Calendar custody permits actual Health pause");finish()}};return}
  if mode=="shared-drain-reentry" {
   let old=host.runtime!;host.withdraw()
   old.retire(authorityChanged:false){
    let a=allocations
    host.setup(selection:"known",action:.confirmExistingLocal){check((try? $0.get())==nil,"new Host owner cannot enter during old retirement observer publication")}
    check(allocations==a,"retirement observer reentry must not allocate another root")
    old.retire(authorityChanged:false){check(allocations==a,"new drain observer deferred without stale replacement notification");later{check(host.status()["state"] as? String=="unavailable","old host retired after publication barrier");finish()}}
   };return
  }
  if mode=="shared-pause-calendar" {
   later{check(sharedCustodyReleases==1,"first original child drained");host.calendarCollectAndDeliver(selection:"calendar"){fresh in
    guard case .settled(let count,_,_,_,_)=fresh else{check(false,"fresh actual Calendar operation after successful Health-only pause must not require Health resume");return}
    check(count==1 && sharedPosts==2 && sdk.queries==0,"fresh independent Calendar SDK/POST without Health resume")
    later{check(sharedCustodyAcquires==2 && sharedCustodyReleases==2,"new positive parent lease after prior drain");finish()}
   }};return
  }
  later{check(allocations==1,"original physical storage factory once");if !mode.hasPrefix("shared-custody-") || mode=="shared-custody-loss"{check(sharedCustodyReleases==sharedCustodyAcquires,"release parent only after actual child drain")};finish()}
 }
 if pendingOnly{host.calendarDeliverPending(selection:"calendar",completion:done)}else{host.calendarCollectAndDeliver(selection:"calendar",completion:done)}
}
func beginShared(){
 seedShared();seedSharedShare()
 if mode=="shared-write-before" || mode=="shared-write-after" || mode=="shared-readback-unknown" {
  if sharedWriteStage=="calendarSettlement"{startSharedCalendar();return}
  armSharedWrite(mode=="shared-readback-unknown" ? "collection":sharedWriteStage)
  if sharedWriteStage=="pause"{host.pauseCollection(pauseRequest()){reply in check(reply["persistence"] as? String=="unconfirmed","actual pause throw");assertSharedUnknown()};return}
  host.sync(selection:"known",category:"sleep"){_ in assertSharedUnknown()};return
 }
 if mode=="shared-pause-storage-read" || mode=="shared-pause-storage-replace" || mode=="shared-pause-withdraw-deferred" || mode=="shared-denied-write" {
  let hook={
   guard !sharedInjected else{return};sharedInjected=true;disk.onRead=nil;disk.onReplace=nil
   let n=disk.reads,w=disk.writes
   var originalCompletions=0
   host.pauseCollection(pauseRequest()){reply in
    originalCompletions+=1;check(originalCompletions==1,"one original first-pause completion")
    if mode=="shared-pause-withdraw-deferred"{
     check(disk.writes==w,"zero obsolete first-pause write")
     let allocated=allocations
     host.setup(selection:"known",action:.confirmExistingLocal){check((try? $0.get())==nil,"no early replacement before original real drain publication")}
     check(allocations==allocated,"no allocation before actual old callback retirement")
    }
    check(disk.frame==0,"first pause result after original IO frame")
    if mode=="shared-pause-withdraw-deferred"{check(reply["persistence"] as? String=="notApplied","global withdrawal prevents obsolete uninvoked first pause")}
    else{check(reply["persistence"] as? String=="savedPaused","first actual pause saved after full box frame")}
    later{
     check(originalCompletions==1,"no late duplicate of original first-pause result")
     check(ingests==0,"revoked Health cannot POST before queued cancellation");check(disk.writes<=w+2,"first original invoked write and first protective pause only")
     if mode=="shared-pause-withdraw-deferred"{check(host.status()["state"] as? String=="unavailable","uninvoked obsolete pause must not retain a false unknown/undrained hold");host.setup(selection:"known",action:.confirmExistingLocal){result in check((try? result.get()) != nil && allocations==2,"known uninvoked pause allows explicit new owner after real callback retirement");finish()}}
     else if mode=="shared-denied-write"{host.resumeCollection(resumeRequest()){reply in check(reply["outcome"] as? String=="resumed","before-invoke denial did not latch unknown");host.sync(selection:"known",category:"sleep"){result in check((try? result.get()) == .applied && ingests>0,"explicit resume executes actual SDK and POST after non-unknown refusal");finish()}}}else{finish()}
    }
   }
   check(disk.reads==n && disk.writes==w,"pure protective admission under original lock")
   for _ in 0..<8{host.pauseCollection(pauseRequest()){check($0["reason"] as? String=="busy","pending duplicate observes only its invocation")}}
   check(host.status()["state"] as? String=="unavailable" && disk.reads==n,"nested status never reads held box")
   if mode=="shared-pause-withdraw-deferred"{host.withdraw()}
  }
  if mode=="shared-pause-storage-replace"{disk.onReplace={_ in hook()}}
  else if sharedReadSite=="delivery"{disk.onReplace={value in if sharedCount(value,"enrollments")>sharedCount(disk.data,"enrollments"){disk.onReplace=nil;disk.onRead=hook}}}
  else{disk.onRead=hook}
  host.sync(selection:"known",category:"sleep"){_ in};return
 }
 let drainModes=["shared-drain-setup","shared-drain-policy","shared-drain-session","shared-drain-sdk","shared-late-policy","shared-never-callback"]
 if drainModes.contains(mode) {
  func launch(){
   startSharedCalendar()
   later{
    check(sharedCustodyAcquires==0 && sharedFactoryCalls==0 && sharedPosts==0,"real original Health callbacks drain before custody/Calendar acquisition")
    if mode=="shared-never-callback"{host.withdraw();check(host.status()["state"] as? String=="draining","never callback retains original owner");finish();return}
    if mode=="shared-late-policy"{host.withdraw()}
    if let respond=releaseHeld{releaseHeld=nil;respond()}else{sdk.callback?(.success(NativeHealthPage(observations:[],deleted:[],anchor:Data([3]),mayHaveMore:false)))}
   }
  }
  if mode=="shared-drain-sdk" || mode=="shared-never-callback"{sdkWithheld=launch;host.sync(selection:"known",category:"sleep"){_ in}}
  else if mode=="shared-drain-session"{sharedHoldHealthIngest=true;sharedLaunchWhileHeld=launch;host.sync(selection:"known",category:"sleep"){_ in}}
  else{holdPolicy=true;pauseTrigger=launch;if mode=="shared-drain-policy" || mode=="shared-late-policy"{host.sync(selection:"known",category:"sleep"){_ in}}else{host.setup(selection:"known",action:.confirmExistingLocal){_ in}}}
  return
 }
 startSharedCalendar()
}

// Lowest-level offline custody/storage/SDK/HTTP fixture ports only. All admission
// decisions below are exercised through the actual Host/Runtime/Root/Core path.
let admissionOwner=NSObject()
var admissionConfigCurrency:NativeCalendarAdmissionCurrency?,admissionCustodyCurrency:NativeCalendarAdmissionCurrency?
var admissionReading=false,admissionAuthReads=0,admissionPolicyReads=0,admissionReports=0,admissionInjected=false
var admissionProvenance="synthetic-native-config"
let admissionSite=ProcessInfo.processInfo.environment["CALENDAR_ADMISSION_SITE"] ?? "custody-callback"
let admissionObservationSite=ProcessInfo.processInfo.environment["CALENDAR_OBSERVATION_SITE"] ?? "original"
let admissionCallbackSite=ProcessInfo.processInfo.environment["CALENDAR_CALLBACK_SITE"] ?? "ordinary"
var admissionHandlerRetired=false
func admissionRootConfiguration()->NativeHealthRuntime.RootConfiguration? {
 if mode=="calendar-setup-missing-root-provider" || mode=="calendar-reconnect-no-root"{return nil}
 let c=configuration().rootConfiguration,id=c.identity
 return .init(identity:.init(provenance:admissionProvenance,origin:id.origin,human:id.human,session:id.session,endpoint:id.endpoint,maxBytes:id.maxBytes,maxEvents:id.maxEvents,storageOrigin:id.storageOrigin,protectedFilePolicy:id.protectedFilePolicy),protectedAvailable:c.protectedAvailable,makeStorage:{allocations+=1;if mode=="calendar-setup-storage-factory-withdraw"{host.withdraw()};return disk})
}
func admissionBadBinding(_ original:NativeCalendarAdmissionCurrency.Binding)->NativeCalendarAdmissionCurrency.Binding{
 let r=original.root,c=original.configuration
 if admissionSite.hasPrefix("custody-wrong-root"){return .init(root:.init(provenance:admissionSite=="custody-wrong-root-utf8" ? "cafe\u{0301}":"different-original-root",origin:r.origin,human:r.human,session:r.session,endpoint:r.endpoint,maxBytes:r.maxBytes,maxEvents:r.maxEvents,storageOrigin:r.storageOrigin,protectedFilePolicy:r.protectedFilePolicy),configuration:c,selected:original.selected)}
 return .init(root:r,configuration:.init(provenance:c.provenance,origin:c.origin,human:c.human,session:c.session,endpoint:c.endpoint,enrollment:UUID(),namespace:c.namespace,plan:c.plan,protectedAvailable:c.protectedAvailable),selected:original.selected)
}
final class AdmissionCustody:NativeSharedOutboxCustodyLease {
 let storage:Disk,binding:NativeSharedOutboxOwner.Binding
 var released=false
 init(_ storage:Disk,_ binding:NativeSharedOutboxOwner.Binding){self.storage=storage;self.binding=binding}
 func isCurrent(storage:any HealthSnapshotStorage,binding:NativeSharedOutboxOwner.Binding)->Bool {
  if mode=="calendar-setup-reciprocal-revocation",admissionSite=="custody-callback",admissionCustodyCurrency?.attempt != nil,disk.reads>0,!admissionInjected{admissionInjected=true;admissionConfigCurrency!.revoke();admissionProvenance="changed-in-custody"}
  return !released && sharedHealthy && (storage as? Disk) === self.storage && binding==self.binding
 }
 func withFence<T>(_ body:()throws->T)throws->T{guard !released,sharedHealthy else{throw CocoaError(.fileReadNoPermission)};return try body()}
 func admissionCurrency(binding:NativeCalendarAdmissionCurrency.Binding)->NativeCalendarAdmissionCurrency?{
  if mode=="calendar-setup-missing-currencies",admissionSite=="custody-callback"{return nil}
  let token=NativeCalendarAdmissionCurrency(owner:admissionSite=="custody-foreign-owner" ? NSObject():self,binding:admissionSite.hasPrefix("custody-wrong-root") ? admissionBadBinding(binding):binding)
  if admissionSite=="custody-prior-attempt"{try! token.claim(attempt:UUID(),root:NSObject(),parent:self)}
  admissionCustodyCurrency=token;return token
 }
 func release(){
  check(!released,"original admission parent released once")
  if admissionCallbackSite=="retirement"{
   check(admissionHandlerRetired,"original parent must survive final proof HTTP handler return/main-queue barrier")
   host.setupCalendar(selection:"calendar"){check($0.persistence == .notApplied,"parent-release reentry cannot replace retiring original admission")}
  }
  released=true;sharedCustodyReleases+=1
 }
}
func admissionSelection(_ selection:String)->NativeHealthHost.CalendarSelection?{
 if reconnectMode{return reconnectSelection(selection)}
 guard selection=="calendar" || selection=="calendar-task",mode != "calendar-setup-missing-calendar-config" else{return nil}
 if mode=="calendar-setup-config-reentry",!admissionInjected{admissionInjected=true;host.setupCalendar(selection:"calendar"){check($0.persistence == .notApplied,"provider reentry bounded refusal")}}
 if mode=="calendar-setup-reciprocal-revocation",admissionSite=="config-callback",admissionCustodyCurrency?.attempt != nil,!admissionInjected{admissionInjected=true;admissionCustodyCurrency!.revoke();sharedHealthy=false}
 let config=NativeCalendarAcquisitionOwner.Configuration(provenance:"synthetic-calendar",origin:origin,human:human,session:session,endpoint:endpoint,enrollment:sharedEnrollment,namespace:sharedNamespace,plan:.init(category:selection=="calendar-task" ? "Task":"CalendarEvent",selectedContainerIDs:["selected"],mappingVersion:"synthetic-calendar-mapping/1",coverageStart:Date(timeIntervalSince1970:1793404800),coverageEnd:Date(timeIntervalSince1970:1793491200),capturedSDKDefaultTimeZone:TimeZone(secondsFromGMT:0)!),protectedAvailable:{protectedHealthy},deliveryScope:syntheticVerifiedCalendarScope)
 let selected:Set<String> = mode=="calendar-setup-empty-selection" ? []:mode=="calendar-setup-invalid-selection" ? ["sleep"]:["CalendarEvent"]
 if admissionConfigCurrency==nil {
  let binding=NativeCalendarAdmissionCurrency.Binding(root:configuration().rootConfiguration.identity,configuration:config,selected:selected)
  admissionConfigCurrency=NativeCalendarAdmissionCurrency(owner:admissionSite=="config-foreign-owner" ? NSObject():admissionOwner,binding:admissionSite=="config-wrong-source" ? admissionBadBinding(binding):binding)
  if admissionSite=="config-prior-attempt"{try! admissionConfigCurrency!.claim(attempt:UUID(),root:NSObject(),parent:NSObject())}
 }
 let custody:NativeSharedOutboxOwner.Custody? = mode=="calendar-setup-missing-custody" ? nil:{storage,binding in sharedCustodyAcquires+=1;check((storage as? Disk) === disk,"custody original physical store");return AdmissionCustody(disk,binding)}
 let currency:NativeCalendarAdmissionCurrency? = mode=="calendar-setup-missing-currencies" && admissionSite=="config-callback" ? nil:admissionConfigCurrency
 return .init(runtimeSelection:"known",configuration:.init(configuration:config,custody:custody,makeAcquisition:{box in sharedFactoryCalls+=1;return MobileEventKitAcquisition(outbox:box,storePort:SharedStore(),executeOnWorker:{$0()})},captureClock:{sharedClock+=1;return Date(timeIntervalSince1970:1793404800)}),setup:.init(owner:admissionOwner,currency:currency,selectedCategories:selected))
}
func admissionWire(_ path:String,_ object:[String:Any])->Data{
 if reconnectMode{return reconnectWire(path,object)}
 var wire=String(data:bytes(object),encoding:.utf8)!
 guard admissionReading else{return Data(wire.utf8)}
 if path=="/api/auth/v1/user-context"{admissionAuthReads+=1}
 func replace(_ key:String,_ value:String){wire=wire.replacingOccurrences(of:"\""+key+"\":1",with:"\""+key+"\":"+value)}
 if path=="/api/auth/v1/user-context" {
  if mode=="calendar-proof-auth-authority-fraction" || mode=="calendar-proof-near-safe-fraction"{replace("authorityRevision",mode=="calendar-proof-near-safe-fraction" ? "9007199254740990.1":"1.0000000000000000001")}
  if mode=="calendar-proof-auth-generation-fraction"{replace("generation","1.0000000000000000001")}
  if mode=="calendar-proof-duplicate-decoded-key"{wire=wire.replacingOccurrences(of:"\"generation\":1",with:"\"generation\":1,\"gener\\u0061tion\":1")}
  if mode=="calendar-proof-before-after-identity-drift",admissionAuthReads>=2{wire=wire.replacingOccurrences(of:"\"contextRef\":\"synthetic\"",with:"\"contextRef\":\"changed\"")}
 }
 if path=="/api/runtime/v1/session-context" {
  if mode=="calendar-proof-session-revision-fraction"{replace("revision","1.0000000000000000001")}
  if mode=="calendar-proof-session-generation-fraction"{replace("contextGeneration","1.0000000000000000001")}
  if mode=="calendar-proof-endpoint-revision-fraction"{replace("configurationRevision","1.0000000000000000001")}
 }
 if mode=="calendar-proof-safe-integer-decimal" || mode=="calendar-proof-safe-integer-exponent"{
  for key in ["authorityRevision","generation","revision","contextGeneration","configurationRevision"]{replace(key,mode.hasSuffix("decimal") ? "1.0":"1e0")}
 }
 return Data(wire.utf8)
}
func admissionCalendarResponse(_ loader:URLProtocol,_ body:[String:Any]){
 if reconnectMode{reconnectResponse(loader,body);return}
 let payload=body["payload"] as! [String:Any]
 guard payload["operation"] as? String=="policy",admissionReading else{sharedCalendarResponse(loader,body);return}
 admissionPolicyReads+=1
 var value=sharedCalendarFixture["policy"] as! [String:Any]
 if mode=="calendar-setup-policy-denied" || mode=="calendar-setup-policy-binding"{
  var result=value["result"] as! [String:Any],effective=result["effective"] as! [String:Any]
  if mode=="calendar-setup-policy-denied"{effective["collectionAllowed"]=false}else{effective["sourceNamespace"]=UUID().uuidString.lowercased()}
  result["effective"]=effective;value["result"]=result
 }
 var wire=String(data:bytes(value),encoding:.utf8)!
 if mode=="calendar-proof-policy-enrollment-revision-fraction"{wire=wire.replacingOccurrences(of:"\"revision\":2",with:"\"revision\":2.0000000000000000001")}
 if mode=="calendar-proof-policy-effective-revision-fraction"{wire=wire.replacingOccurrences(of:"\"policyRevision\":2",with:"\"policyRevision\":2.0000000000000000001")}
 if mode=="calendar-proof-safe-integer-decimal" || mode=="calendar-proof-safe-integer-exponent"{for key in ["revision","policyRevision"]{wire=wire.replacingOccurrences(of:"\""+key+"\":2",with:"\""+key+"\":"+(mode.hasSuffix("decimal") ? "2.0":"2e0"))}}
 if mode=="calendar-setup-cancel-proof"{
  host.calendarCancel();check(admissionReports==0 && sharedCustodyReleases==0 && disk.writes==0,"cancel waits actual original proof callback before release/completion")
  host.setupCalendar(selection:"calendar"){check($0.persistence == .notApplied,"no replacement while cancelled original callback pending")}
  if admissionCallbackSite=="never-callback"{
   host.withdraw();later{check(admissionReports==0 && sharedCustodyReleases==0 && allocations==1 && disk.writes==0,"never original callback retains admission and parent after cancellation/withdrawal");finish()};return
  }
 }
 let respond={loader.client?.urlProtocol(loader,didReceive:HTTPURLResponse(url:loader.request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!,cacheStoragePolicy:.notAllowed);loader.client?.urlProtocol(loader,didLoad:Data(wire.utf8));loader.client?.urlProtocolDidFinishLoading(loader)}
 respond();if mode=="calendar-setup-late-duplicate-proof"{respond()}
}
func runAdmission(){
 func start(){
  if admissionSite=="custody-wrong-root-utf8"{provenance="caf\u{00e9}";admissionProvenance=provenance}
  admissionReading=true
  if mode=="calendar-setup-auth-denied"{authStatus=503}
  if mode=="calendar-setup-existing-local"{let proof=try! MobileCalendarPolicyParser.parse(bytes(sharedCalendarFixture["policy"]!),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:sharedEnrollment);try! fixtureInput.admitCalendar(proof:proof)}
  if mode=="calendar-setup-human-mismatch"{disk.data=bytes(["version":1,"lastHuman":UUID().uuidString,"enrollments":[]])}
  let before=disk.data,writes=disk.writes,reads=disk.reads
  let readRefusals=["calendar-setup-read-config-drift","calendar-setup-custody-read-loss","calendar-setup-write-before-refusal","calendar-setup-token-aba","calendar-setup-reciprocal-revocation"]
  if readRefusals.contains(mode){disk.onRead={
   disk.onRead=nil
   if mode=="calendar-setup-read-config-drift"{
    let count=requests
    check(host.status()["state"] as? String=="unavailable","status refuses before locked Core")
    host.setup(selection:"known",action:.enrollExistingRemote){check((try? $0.get())==nil,"normal setup reentry refuses before locked Core")}
    host.sync(selection:"known",category:"sleep"){check((try? $0.get())==nil,"sync reentry refuses before locked Core")}
    host.resumeCollection(resumeRequest()){check($0["outcome"] as? String=="notApplied","resume reentry refuses before locked Core")}
    host.calendarDeliverPending(selection:"calendar"){check($0 == .notApplied(.unavailable),"Calendar reentry refuses before locked Core")}
    check(requests==count,"reentry performs no auth/policy/SDK work")
   }
   if mode=="calendar-setup-custody-read-loss"{admissionCustodyCurrency!.revoke();sharedHealthy=false}
   else if mode=="calendar-setup-reciprocal-revocation"{if admissionSite=="config-callback"{_ = admissionSelection("calendar")}}
   else{admissionConfigCurrency!.revoke();admissionProvenance="changed-after-read";if mode=="calendar-setup-token-aba"{admissionProvenance="synthetic-native-config"}}
  }}
  if mode=="calendar-setup-write-after-throw" || mode=="calendar-setup-unknown-no-recreate"{
   disk.failWrite=admissionSite=="throw-before-write";disk.writeThenThrow = !disk.failWrite
  }
  if mode=="calendar-setup-write-success-withdraw"{disk.onReplace={_ in disk.onReplace=nil;admissionConfigCurrency!.revoke();host.withdraw()}}
  host.setupCalendar(selection:"calendar"){result in
   admissionReports+=1;admissionReading=false
   if admissionCallbackSite=="retirement"{
    check(sharedCustodyReleases==0,"original result delivered while parent still held")
    DispatchQueue.main.async{
     admissionHandlerRetired=true
     check(sharedCustodyReleases==0,"handler-return marker precedes original retirement barrier")
     host.setupCalendar(selection:"calendar"){check($0.persistence == .notApplied,"no second admission before original callback retirement")}
     host.calendarDeliverPending(selection:"calendar"){check($0 == .notApplied(.unavailable),"no normal operation before actual admission retirement")}
    }
   }
   check(admissionReports==1,"exact original admission completion")
   let expectedHealth = mode=="health-then-calendar-same-root" ? 1:0
   check(healthSDKAllocations==expectedHealth && sdk.queries==0 && ingests==0,"Calendar setup has no independent Health SDK/collection")
   if ["calendar-setup-write-after-throw","calendar-setup-unknown-no-recreate"].contains(mode){
    check(result.persistence == .unconfirmed && result.availability == .unavailable,"invoked delegate throw unknown")
    check(disk.writes==writes+1 && sharedCustodyReleases==0,"one original invocation retains parent")
    let original=host.runtime;host.withdraw();host.setupCalendar(selection:"calendar"){again in check(again.attempt==result.attempt && again.persistence == .unconfirmed,"same held original attempt, no retry/readback upgrade")}
    func observe(){
     let io=requests,readCount=disk.reads,writeCount=disk.writes,acquires=sharedCustodyAcquires
     let selector=admissionObservationSite=="empty" ? "":admissionObservationSite=="wrong" ? "another-intent":admissionObservationSite=="oversize" ? String(repeating:"x",count:129):"calendar"
     func receive(_ again:NativeHealthRuntime.CalendarSetupResult){
      if admissionObservationSite=="original" || admissionObservationSite=="runtime-original"{check(again.attempt==result.attempt && again.persistence == .unconfirmed,"exact original unknown observable without writable root/currency")}
      else{check(again.attempt==nil && again.persistence == .notApplied && again.availability == .unavailable,"different selector/owner/transport must not receive original unknown attempt")}
     }
     if admissionObservationSite.hasPrefix("runtime-"){
      let supplied=admissionSelection(admissionObservationSite=="runtime-source" ? "calendar-task":"calendar")!
      let setup=admissionObservationSite=="runtime-owner" ? NativeHealthRuntime.CalendarSetup(owner:NSObject(),currency:supplied.setup!.currency,selectedCategories:supplied.setup!.selectedCategories):supplied.setup!
      original!.setupCalendar(supplied:supplied.configuration,setup:setup,selector:"calendar",fresh:{check(false,"historical Runtime observation must not call current providers");return false},completion:receive)
     }else{host.setupCalendar(selection:selector,completion:receive)}
     check(requests==io && disk.reads==readCount && disk.writes==writeCount && sharedCustodyAcquires==acquires && sharedCustodyReleases==0,"historical observation performs no I/O/write/custody/recreation")
     if ["empty","wrong","oversize","origin"].contains(admissionObservationSite){
      transport.endpoint=URL(string:origin)
      host.setupCalendar(selection:"calendar"){again in check(again.attempt==result.attempt && again.persistence == .unconfirmed,"denied observation never clears/relabels original held result")}
     }
     host.setup(selection:"known",action:.enrollExistingRemote){check((try? $0.get())==nil,"held original blocks replacement")}
     later{check(allocations==1 && disk.writes==writes+1 && sharedCustodyReleases==0 && host.status()["state"] as? String=="draining","unknown original root/store/parent retained");_ = original;finish()}
    }
    if admissionObservationSite=="principal" || admissionObservationSite=="session"{
     if admissionObservationSite=="principal"{authHuman=UUID().uuidString.lowercased()}else{authSession=UUID().uuidString.lowercased()}
     transport.request("/api/auth/v1/user-context"){change in check((try? change.get()) != nil,"actual changed transport identity input");observe()}
    }else{
     if admissionObservationSite=="origin"{transport.endpoint=URL(string:"https://changed.invalid")}
     if admissionObservationSite=="epoch"{transport.epoch+=1}
     observe()
    }
    return
   }
   if mode=="calendar-setup-write-success-withdraw"{check(result.persistence == .saved && result.availability == .unavailable && disk.writes==writes+1,"known write remains saved after withdrawal");later{finish()};return}
   let successes=["calendar-setup-only","calendar-setup-then-deliver-pending","calendar-setup-then-collect","calendar-setup-subset","calendar-setup-config-reentry","calendar-setup-late-duplicate-proof","calendar-then-health-same-root","calendar-then-health-sdk-failure","health-then-calendar-same-root","calendar-proof-safe-integer-decimal","calendar-proof-safe-integer-exponent"]
   guard successes.contains(mode) else{
    check(result.persistence == .notApplied && result.availability == .unavailable,"failed admission never saved/current")
    check(disk.writes==writes && disk.data==before,"refusal leaves original snapshot untouched")
    if readRefusals.contains(mode){check(disk.reads==reads+1,"actual final read exercised")}
    later{check(sharedCustodyReleases==sharedCustodyAcquires,"known refusal true callback drain");finish()};return
   }
   check(result.persistence == .saved && result.availability == .available && disk.writes==writes+1,"one atomic independent Calendar admission")
   let state=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any],rows=sharedRows(disk.data,"calendarEnrollments")
   check(state["lastHuman"] as? String==human.uuidString && rows.count==1 && Set(rows[0]["categories"] as! [String])==["CalendarEvent"],"subject+explicit subset durably saved together")
   let original=host.runtime
   later{
    if mode=="calendar-setup-subset"{
     host.calendarCollectAndDeliver(selection:"calendar-task"){value in
      switch value{case .notApplied,.acquisitionNotApplied:break;default:check(false,"unselected Task must be denied by actual Core ticket")}
      check(sharedFactoryCalls==1 && sharedAccessChecks==0 && sharedQueries==0 && sharedClock==0 && sharedPosts==0,"existing inert acquisition construction grants no SDK access/query/clock/POST; unselected Task denied by actual ticket")
      check(Set(sharedRows(disk.data,"calendarEnrollments")[0]["categories"] as! [String])==["CalendarEvent"],"fresh full policy cannot widen saved local subset");later{finish()}
     };return
    }
    if mode=="calendar-setup-then-collect"{host.calendarCollectAndDeliver(selection:"calendar"){value in
     guard case .settled(let accepted,_,_,_,_)=value else{check(false,"actual Calendar collection/delivery: \(value)");return}
     check(accepted==1 && sharedFactoryCalls==1 && sharedQueries==1 && sharedPosts==1 && healthSDKAllocations==0 && allocations==1,"real original Calendar pipeline without Health SDK");later{finish()}
    };return}
    if mode=="calendar-then-health-same-root" || mode=="calendar-then-health-sdk-failure"{
     host.setup(selection:"known",action:.enrollExistingRemote){health in
      check(((try? health.get()) != nil)==(mode=="calendar-then-health-same-root"),"Health factory outcome isolated")
      check(host.runtime === original && allocations==1 && healthSDKAllocations==1,"later real Health child uses SAME root/store")
      host.calendarDeliverPending(selection:"calendar"){value in check(value == .emptyPending(acquired:nil),"Calendar admission still usable after Health setup/factory failure");later{finish()}}
     };return
    }
    if mode=="calendar-setup-then-deliver-pending"{host.calendarDeliverPending(selection:"calendar"){value in check(value == .emptyPending(acquired:nil) && sharedFactoryCalls==0 && sharedQueries==0 && sharedClock==0 && sharedPosts==0,"actual pending-only no SDK/factory/clock/ingest");later{finish()}};return}
    if admissionCallbackSite=="retirement"{
     check(admissionHandlerRetired && sharedCustodyReleases==1,"original parent eventually releases after actual callback retirement")
     host.calendarDeliverPending(selection:"calendar"){value in check(value == .emptyPending(acquired:nil),"actual pending operation available after original retirement");later{finish()}};return
    }
    check(host.runtime === original && allocations==1 && sharedFactoryCalls==0 && sharedPosts==0,"setup alone never collects/delivers")
    finish()
   }
  }
 }
 if mode=="health-then-calendar-same-root"{host.setup(selection:"known",action:.enrollExistingRemote){value in check((try? value.get()) != nil,"original independent Health setup first");start()}}else{start()}
}


// Reconnect fixtures author only original SDK/storage/custody/transport inputs.
// The actual new Host/Root/Core method must cold-adopt before pending can work.
let reconnectSite=ProcessInfo.processInfo.environment["CALENDAR_RECONNECT_SITE"] ?? "default"
let reconnectVariant=ProcessInfo.processInfo.environment["CALENDAR_RECONNECT_VARIANT"] ?? "default"
var reconnectCurrency:NativeCalendarAdmissionCurrency?,reconnectParentCurrency:NativeCalendarAdmissionCurrency?
var reconnectReading=false,reconnectInjected=false,reconnectReports=0,reconnectPolicies=0,reconnectReadBase=0,reconnectHandlerMarker=false,reconnectPauseWrites=0,reconnectUnknownArmed=false
func reconnectBinding(_ b:NativeCalendarAdmissionCurrency.Binding)->NativeCalendarAdmissionCurrency.Binding{
 var root=b.root,source=b.configuration,selected=b.selected,kind=b.kind
 if reconnectSite=="wrong-root"{let v=root;root = .init(provenance:"another-root",origin:v.origin,human:v.human,session:v.session,endpoint:v.endpoint,maxBytes:v.maxBytes,maxEvents:v.maxEvents,storageOrigin:v.storageOrigin,protectedFilePolicy:v.protectedFilePolicy)}
 if reconnectSite=="wrong-selection"{selected=["CalendarEvent"]}
 if reconnectSite=="wrong-action"{kind = .setupExistingRemote}
 return .init(root:root,configuration:source,selected:selected,kind:kind)
}
final class ReconnectCustody:NativeSharedOutboxCustodyLease {
 let original:Disk,binding:NativeSharedOutboxOwner.Binding;var released=false
 init(_ storage:Disk,_ binding:NativeSharedOutboxOwner.Binding){original=storage;self.binding=binding}
 func isCurrent(storage:any HealthSnapshotStorage,binding:NativeSharedOutboxOwner.Binding)->Bool{
  if reconnectReading,!reconnectInjected,reconnectParentCurrency?.attempt != nil,disk.reads>reconnectReadBase,
     (mode=="calendar-reconnect-final-read-fence" && reconnectSite=="final-custody-revokes-config" || mode=="calendar-reconnect-currencies" && reconnectSite=="reciprocal-revocation" && reconnectVariant=="custody"){
   reconnectInjected=true;reconnectCurrency!.revoke();admissionProvenance="changed-in-original-custody"
  }
  return !released && sharedHealthy && (storage as? Disk) === original && self.binding==binding
 }
 func withFence<T>(_ body:()throws->T)throws->T{
  guard !released,sharedHealthy else{throw CocoaError(.fileReadNoPermission)}
  let value=try body()
  // Original custodian callback unwinding, AFTER the wrapper's body checks.
  // Arm only for the final Core reconnect read, never setup or pending reads.
  if mode=="calendar-reconnect-fence-unwind",reconnectReading,!reconnectInjected,reconnectParentCurrency?.attempt != nil,disk.reads>reconnectReadBase{
   reconnectInjected=true
   let snapshot=disk.data,writes=disk.writes
   if reconnectSite=="configuration-ABA"{
    let provenance=admissionProvenance
    reconnectCurrency!.revoke();admissionProvenance="after-body-bound-change";admissionProvenance=provenance
   }else if reconnectSite=="custody-ABA"{
    reconnectParentCurrency!.revoke();sharedHealthy=false;sharedHealthy=true
   }
   check(disk.data==snapshot && disk.writes==writes,"original custodian unwind leaves snapshot/proof inputs untouched")
  }
  return value
 }
 func admissionCurrency(binding:NativeCalendarAdmissionCurrency.Binding)->NativeCalendarAdmissionCurrency?{
  if !reconnectReading || binding.kind == .setupExistingRemote{return NativeCalendarAdmissionCurrency(owner:self,binding:binding)}
  if mode=="calendar-reconnect-currencies",reconnectSite=="absent-custody"{return nil}
  let bad=mode=="calendar-reconnect-currencies" && (["wrong-root","wrong-selection","prior-attempt"].contains(reconnectSite) || ["wrong-owner","wrong-action"].contains(reconnectSite) && reconnectVariant=="custody")
  let owner:AnyObject=bad && reconnectSite=="wrong-owner" ? NSObject():self
  let token=NativeCalendarAdmissionCurrency(owner:owner,binding:bad ? reconnectBinding(binding):binding)
  if bad && reconnectSite=="prior-attempt"{try! token.claim(attempt:UUID(),root:NSObject(),parent:self)}
  reconnectParentCurrency=token;return token
 }
 func release(){
  check(!released,"reconnect original parent release exactly once")
  if mode=="calendar-reconnect-retirement",reconnectReading{
   check(reconnectHandlerMarker && reconnectReports==0,"parent survives actual handler; new reconnect result waits retirement")
   host.reconnectCalendar(selection:"calendar"){check($0.attempt==nil && $0.outcome == .notApplied,"release reentry cannot begin another control")}
  }
  released=true;sharedCustodyReleases+=1
 }
}
func reconnectSelection(_ selection:String)->NativeHealthHost.CalendarSelection?{
 guard selection=="calendar",mode != "calendar-reconnect-no-config" else{return nil}
 if reconnectReading,reconnectParentCurrency?.attempt != nil,!reconnectInjected,
    (mode=="calendar-reconnect-final-read-fence" && reconnectSite=="config-callback-revokes-custody" || mode=="calendar-reconnect-currencies" && reconnectSite=="reciprocal-revocation" && reconnectVariant=="config"){
  reconnectInjected=true;reconnectParentCurrency!.revoke();sharedHealthy=false
 }
 let config=NativeCalendarAcquisitionOwner.Configuration(provenance:"synthetic-calendar",origin:origin,human:human,session:session,endpoint:endpoint,enrollment:sharedEnrollment,namespace:sharedNamespace,plan:.init(category:"CalendarEvent",selectedContainerIDs:["selected"],mappingVersion:"synthetic-calendar-mapping/1",coverageStart:Date(timeIntervalSince1970:1793404800),coverageEnd:Date(timeIntervalSince1970:1793491200),capturedSDKDefaultTimeZone:TimeZone(secondsFromGMT:0)!),protectedAvailable:{protectedHealthy},deliveryScope:syntheticVerifiedCalendarScope)
 let selected:Set<String>=["CalendarEvent","Task"]
 if reconnectCurrency==nil{
  let binding=NativeCalendarAdmissionCurrency.Binding(root:configuration().rootConfiguration.identity,configuration:config,selected:selected,kind:.reconnectExistingLocal)
  let bad=mode=="calendar-reconnect-currencies" && ["wrong-owner","wrong-action"].contains(reconnectSite) && reconnectVariant=="config"
  reconnectCurrency=NativeCalendarAdmissionCurrency(owner:bad && reconnectSite=="wrong-owner" ? NSObject():admissionOwner,binding:bad ? reconnectBinding(binding):binding)
 }
 if admissionConfigCurrency==nil{admissionConfigCurrency=NativeCalendarAdmissionCurrency(owner:admissionOwner,binding:.init(root:configuration().rootConfiguration.identity,configuration:config,selected:selected))}
 let currency:NativeCalendarAdmissionCurrency? = mode=="calendar-reconnect-currencies" && reconnectSite=="absent-config" ? nil:reconnectCurrency
 let custody:NativeSharedOutboxOwner.Custody?=mode=="calendar-reconnect-no-custody" ? nil:{storage,binding in sharedCustodyAcquires+=1;check((storage as? Disk) === disk,"reconnect actual original storage");return ReconnectCustody(disk,binding)}
 return .init(runtimeSelection:"known",configuration:.init(configuration:config,custody:custody,makeAcquisition:{_ in check(false,"reconnect/pending must not construct EventKit acquisition");return nil},captureClock:{check(false,"reconnect/pending must not call capture clock");return Date()}),setup:.init(owner:admissionOwner,currency:admissionConfigCurrency,selectedCategories:selected),reconnect:.init(owner:admissionOwner,currency:currency,expectedSavedCategories:selected))
}
func reconnectWire(_ path:String,_ object:[String:Any])->Data{
 var value=object
 guard reconnectReading,mode=="calendar-reconnect-context" else{return bytes(value)}
 if path=="/api/auth/v1/user-context",reconnectSite=="principal" || reconnectSite=="session"{
  var c=value["context"] as! [String:Any]
  if reconnectSite=="principal"{let id=UUID().uuidString.lowercased();c["actorId"]=id;c["effectiveUserId"]=id;value["actor"]=["principalId":id];value["effectiveUser"]=["principalId":id]}else{c["authenticatedSessionId"]=UUID().uuidString.lowercased()}
  value["context"]=c
 }
 return bytes(value)
}
func reconnectResponse(_ loader:URLProtocol,_ body:[String:Any]){
 let payload=body["payload"] as! [String:Any],operation=payload["operation"] as! String
 func send(_ value:[String:Any]){loader.client?.urlProtocol(loader,didReceive:HTTPURLResponse(url:loader.request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!,cacheStoragePolicy:.notAllowed);loader.client?.urlProtocol(loader,didLoad:bytes(value));loader.client?.urlProtocolDidFinishLoading(loader)}
 if operation=="policy",reconnectReading{
  reconnectPolicies+=1
  var policy=sharedCalendarFixture["policy"] as! [String:Any]
  if mode=="calendar-reconnect-policy-change"{var result=policy["result"] as! [String:Any],row=result["enrollment"] as! [String:Any],effective=result["effective"] as! [String:Any]
   if reconnectSite=="advance" || reconnectSite=="regress"{let rev=reconnectSite=="advance" ? 3:1;row["revision"]=rev;effective["policyRevision"]=rev}
   if reconnectSite=="narrow"{effective["categories"]=["CalendarEvent"]};if reconnectSite=="denied"{effective["collectionAllowed"]=false}
   result["enrollment"]=row;result["effective"]=effective;policy["result"]=result
  }
  if mode=="calendar-reconnect-context"{if reconnectSite=="origin"{transport.endpoint=URL(string:"https://changed.invalid")};if reconnectSite=="epoch"{transport.epoch+=1};if reconnectSite=="before-after-snapshot"{contextRevision+=1}}
  if mode=="calendar-reconnect-action-observation",["reconnect-inflight-to-setup","wrong-selector"].contains(reconnectSite){
   let calls=requests,writes=disk.writes
   if reconnectSite=="reconnect-inflight-to-setup"{host.setupCalendar(selection:"calendar"){check($0.attempt==nil && $0.persistence == .notApplied,"setup cannot observe reconnect attempt")}}
   else{host.reconnectCalendar(selection:"another-selector"){check($0.attempt==nil && $0.outcome == .notApplied,"foreign selector gets no in-flight attempt")}}
   check(requests==calls && disk.writes==writes,"action observation no extra IO")
  }
  if mode=="calendar-reconnect-never-callback"{host.calendarCancel();host.withdraw();later{check(reconnectReports==0 && sharedCustodyReleases==0 && allocations==1,"never actual callback retains reconnect reservation and original parent");finish()};return}
  if mode=="calendar-reconnect-late-callback",reconnectSite=="cancel-late"{host.calendarCancel();check(reconnectReports==0 && sharedCustodyReleases==0,"cancel is not callback drain");DispatchQueue.main.async{send(policy)};return}
  send(policy);if mode=="calendar-reconnect-late-callback",reconnectSite=="duplicate"{send(policy)};return
 }
 if operation=="ingest",mode=="calendar-reconnect-pending-uncertainty" || mode=="calendar-reconnect-action-observation" && reconnectSite=="pending-settlement-unknown"{
  if reconnectSite=="transport-unknown"{sharedPosts+=1;loader.client?.urlProtocol(loader,didFailWithError:URLError(.networkConnectionLost));return}
  if reconnectSite=="invalid-receipt"{sharedPosts+=1;send(["invalid":true]);return}
  if reconnectSite=="cancel"{host.calendarCancel()}
  if reconnectSite=="settlement-write-then-throw" || reconnectSite=="pending-settlement-unknown"{disk.onReplace={next in if sharedCount(next,"calendarEnrollments")==0{reconnectUnknownArmed=true;disk.writeThenThrow=true;disk.onReplace=nil}}}
 }
 sharedCalendarResponse(loader,body)
}
func patchReconnectRow(_ change:(inout [String:Any])->Void){var state=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any],rows=state["calendarEnrollments"] as! [Any],row=rows[1] as! [String:Any];change(&row);rows[1]=row;state["calendarEnrollments"]=rows;disk.data=bytes(state)}
func runReconnect(){
 if mode=="calendar-reconnect-action-observation",reconnectSite=="setup-unknown-to-reconnect"{
  disk.writeThenThrow=true
  host.setupCalendar(selection:"calendar"){setup in
   check(setup.persistence == .unconfirmed,"actual original setup write unknown")
   let r=requests,w=disk.writes,reads=disk.reads
   host.reconnectCalendar(selection:"calendar"){value in check(value.attempt==nil && value.outcome == .notApplied,"reconnect must not borrow setup attempt")}
   host.setupCalendar(selection:"calendar"){value in check(value.attempt==setup.attempt && value.persistence == .unconfirmed,"original setup observation remains exact")}
   check(requests==r && disk.writes==w && disk.reads==reads && sharedCustodyReleases==0,"old unknown retains owner with no new IO")
   later{finish()}
  };return
 }
 seedShared()
 if mode=="calendar-reconnect-share-preservation"{seedSharedShare()}
 if mode=="calendar-reconnect-no-local-row"{var state=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any];state["calendarEnrollments"]=[];disk.data=bytes(state)}
 if mode=="calendar-reconnect-other-human"{var state=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any];state["lastHuman"]=UUID().uuidString;disk.data=bytes(state)}
 if mode=="calendar-reconnect-paused"{patchReconnectRow{$0["paused"]=true}}
 if mode=="calendar-reconnect-rebind"{patchReconnectRow{$0["requiresRebind"]=true}}
 if mode=="calendar-reconnect-saved-binding"{patchReconnectRow{$0[reconnectSite]=reconnectSite=="collector-utf8" ? "event\u{212A}it":UUID().uuidString};if reconnectSite=="collector-utf8"{patchReconnectRow{$0.removeValue(forKey:"collector-utf8");$0["collector"]="event\u{212A}it"}}}
 func start(){
  reconnectReading=true;reconnectReadBase=disk.reads
  if mode=="calendar-reconnect-unavailable-store"{if reconnectSite=="locked"{disk.locked=true}else{disk.data=reconnectSite=="corrupt" ? Data([0]):Data(repeating:0,count:8*1024*1024+1)}}
  if mode=="calendar-reconnect-replace-trap"{disk.failWrite=true}
  let before=disk.data,reads=disk.reads,writes=disk.writes,sdkBefore=healthSDKAllocations
  let readModes=["calendar-reconnect-final-read-fence","calendar-reconnect-read-reentry","calendar-reconnect-read-withdraw","calendar-reconnect-retirement"]
  if readModes.contains(mode) || mode=="calendar-reconnect-currencies" && ["ABA","reciprocal-revocation"].contains(reconnectSite){disk.onRead={
   disk.onRead=nil
   if mode=="calendar-reconnect-retirement"{DispatchQueue.main.async{reconnectHandlerMarker=true;check(sharedCustodyReleases==0 && reconnectReports==0,"handler marker precedes true retirement and result");host.reconnectCalendar(selection:"calendar"){check($0.attempt==nil,"no second control before retirement")}}}
   if mode=="calendar-reconnect-final-read-fence"{
    if reconnectSite=="config-remap"{reconnectCurrency!.revoke();admissionProvenance="remapped-after-read"}
    if reconnectSite=="custody-loss"{reconnectParentCurrency!.revoke();sharedHealthy=false}
    if reconnectSite=="config-callback-revokes-custody"{_ = reconnectSelection("calendar")}
   }
   if mode=="calendar-reconnect-currencies"{if reconnectSite=="ABA"{reconnectCurrency!.revoke();admissionProvenance="changed";admissionProvenance="synthetic-native-config"};if reconnectSite=="reciprocal-revocation",reconnectVariant=="config"{_ = reconnectSelection("calendar")}}
   if mode=="calendar-reconnect-read-reentry"{
    let calls=requests
    switch reconnectSite{
    case "setup":host.setupCalendar(selection:"calendar"){check($0.attempt==nil,"setup read reentry refused")}
    case "reconnect":host.reconnectCalendar(selection:"calendar"){check($0.attempt==nil,"reconnect read reentry refused")}
    case "pending":host.calendarDeliverPending(selection:"calendar"){check($0 == .notApplied(.unavailable),"pending read reentry refused")}
    case "status":check(host.status()["state"] as? String=="unavailable","status read reentry refused")
    default:host.resumeCollection(resumeRequest()){check($0["outcome"] as? String=="notApplied","resume read reentry refused")}
    }
    check(requests==calls,"reentry did not touch IO/locked Core")
   }
   if mode=="calendar-reconnect-read-withdraw"{
    if reconnectSite=="cancel"{host.calendarCancel()}
    if reconnectSite=="temporary-withdraw"{host.withdraw()}
    if reconnectSite=="authority-withdraw"{host.withdraw(authorityChanged:true)}
    if reconnectSite=="protective-pause-after-frame"{disk.onReplace={next in check(sharedRows(next,"enrollments").contains{$0["paused"] as? Bool==true},"only original protective Health writer replaces snapshot");reconnectPauseWrites+=1;disk.onReplace=nil};host.pauseCollection(pauseRequest()){check($0["persistence"] as? String=="savedPaused","actual Health pause waits complete Core frame")}}
   }
  }}
  host.reconnectCalendar(selection:"calendar"){value in
   reconnectReports+=1;reconnectReading=false
   check(reconnectReports==1,"one original reconnect completion")
   let reply=value.response
   check(reply["snapshotWrite"] as? String=="notRequested" && reply["persistence"]==nil && reply["operation"] as? String=="reconnect","read result never claims saved/write unknown")
   check(healthSDKAllocations==sdkBefore && sdk.queries==0 && sharedFactoryCalls==0 && sharedQueries==0 && sharedClock==0,"reconnect creates/queries no SDK/clock")
   if mode=="calendar-reconnect-fence-unwind"{check(reconnectInjected,"actual original withFence after-body arm reached final Core read")}
   let positive=["calendar-reconnect-pending","calendar-reconnect-empty","calendar-reconnect-same-health-root","calendar-reconnect-share-preservation","calendar-reconnect-read-reentry","calendar-reconnect-retirement","calendar-reconnect-replace-trap","calendar-reconnect-pending-uncertainty","calendar-reconnect-original-setup"]
   let success=positive.contains(mode) || mode=="calendar-reconnect-late-callback" && reconnectSite=="duplicate" || mode=="calendar-reconnect-action-observation" || mode=="calendar-reconnect-fence-unwind" && reconnectSite=="positive"
   if mode=="calendar-reconnect-fence-unwind",!success{
    check(disk.writes==writes && disk.data==before,"unwind reconnect zero writes and unchanged original bytes")
    check(sharedCustodyReleases==sharedCustodyAcquires,"unwind result waits original parent retirement")
    let calls=requests,w=disk.writes
    // Await the actual command completion: an immediate count followed by exit
    // could miss wrongly adopted pending work queued onto the real main queue.
    host.calendarDeliverPending(selection:"calendar"){delivery in
     check(requests==calls && disk.writes==w,"failed cold reconnect grants no subsequent pending I/O after original withFence unwind")
     check(delivery == .notApplied(.unavailable),"failed cold reconnect grants no pending path")
     check(value.outcome == .notApplied,"unwind denied before Core/Runtime memory publication")
     finish()
    }
    return
   }
   check((value.outcome == .reconnected)==success,"actual reconnect outcome \(value.response)")
   if reconnectPauseWrites==0{check(disk.writes==writes && disk.data==before,"reconnect zero replacements and exact original persistent bytes")}
   else{check(disk.writes==writes+1 && reconnectPauseWrites==1 && sharedCount(disk.data,"calendarEnrollments")==1,"separate protective pause write attributed, Calendar queue preserved")}
   check(sharedCustodyReleases==sharedCustodyAcquires,"reconnect result follows actual reader+parent retirement")
   if success{check(disk.reads==reads+1,"exactly one actual original snapshot read")}else{
    let calls=requests,w=disk.writes
    host.calendarDeliverPending(selection:"calendar"){check($0 == .notApplied(.unavailable),"failed cold reconnect grants no pending path")}
    check(requests==calls && disk.writes==w,"failed reconnect never adopted Core for later IO")
    finish();return
   }
   disk.failWrite=false
   if mode=="calendar-reconnect-original-setup"{
    host.setupCalendar(selection:"calendar"){setup in check(setup.persistence == .notApplied && disk.data==before,"first-admission action still refuses already local row") ;later{finish()}};return
   }
   if mode=="calendar-reconnect-action-observation",reconnectSite=="changed-owner"{
    authHuman=UUID().uuidString.lowercased();transport.request("/api/auth/v1/user-context"){_ in let r=requests,w=disk.writes;host.reconnectCalendar(selection:"calendar"){check($0.attempt==nil && $0.outcome == .notApplied,"changed owner cannot observe old read attempt")};check(requests==r && disk.writes==w,"foreign read observer no IO");finish()};return
   }
   if mode=="calendar-reconnect-empty"{var state=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any],rows=state["calendarEnrollments"] as! [Any],row=rows[1] as! [String:Any];row["queue"]=[];rows[1]=row;state["calendarEnrollments"]=rows;disk.data=bytes(state)}
   // Separate explicit existing pending call, permitted immediately after the
   // read result's real retirement. Its own policy/settlement writes are counted.
   let pendingWrites=disk.writes
   host.calendarDeliverPending(selection:"calendar"){delivery in
    check(allocations==1 && healthSDKAllocations==sdkBefore && sharedFactoryCalls==0 && sharedQueries==0 && sharedClock==0,"same actual root pending path without SDK")
    if reconnectUnknownArmed{
     guard case .settlementUnconfirmed(let attempt)=delivery else{check(false,"actual settlement uncertainty \(delivery)");return}
     let calls=requests,w=disk.writes,r=disk.reads,releases=sharedCustodyReleases
     host.reconnectCalendar(selection:"calendar"){check($0.attempt==nil && $0.outcome == .notApplied,"reconnect cannot borrow delivery unknown attempt \(attempt)")}
     check(requests==calls && disk.writes==w && disk.reads==r && sharedCustodyReleases==releases,"original settlement unknown hold no IO/release/recreation")
     host.withdraw();later{check(host.status()["state"] as? String=="draining","original delivery unknown remains held");finish()};return
    }
    if mode=="calendar-reconnect-pending-uncertainty"{
     switch delivery{case .transportFailure,.invalidReceipt,.notApplied:break;default:check(false,"pending failure not hidden \(delivery)")}
     check(sharedCount(disk.data,"calendarEnrollments")==1,"unknown/invalid/cancel receipt settles nothing");later{finish()};return
    }
    if mode=="calendar-reconnect-empty"{check(delivery == .emptyPending(acquired:nil) && sharedPosts==0,"actual empty pending no fabricated post")}else{guard case .settled(let accepted,_,_,_,_)=delivery else{check(false,"actual pending original delivery \(delivery)");return};check(accepted==1 && sharedPosts==1 && sharedCount(disk.data,"calendarEnrollments")==0,"actual retained queued item POST and original receipt settlement")}
    check(disk.writes>pendingWrites,"writes belong to separately explicit pending policy/settlement, not reconnect")
    later{finish()}
   }
  }
 }
 if mode=="calendar-reconnect-same-health-root" || mode=="calendar-reconnect-read-withdraw" && reconnectSite=="protective-pause-after-frame"{host.setup(selection:"known",action:.enrollExistingRemote){value in check((try? value.get()) != nil,"actual independent samehuman Health setup");start()}}else{start()}
}

if mode.hasPrefix("shared-"),sharedWriteStage=="setup",["shared-write-before","shared-write-after"].contains(mode){armSharedWrite("setup")}
transport.request("/api/auth/v1/user-context"){seed in
 check((try? seed.get()) != nil,"seed auth")
 if healthChoiceMode{choiceArmed=true;runHealthChoices();return}
 if reconnectMode{runReconnect();return}
 if calendarMode{runAdmission();return}
 if mode=="status-no-config"{runSelectedStatus();return}
 if mode=="resume-ui-no-runtime"{let r=requests,w=disk.writes;host.resumeCollection(resumeRequest()){reply in check(reply["outcome"] as? String=="notApplied" && allocations==0 && requests==r && disk.writes==w,"no runtime resume stays unavailable");finish()};return}
 if mode=="resume-ui-invalid"{
  let r=requests,w=disk.writes
  var cases:[[String:Any]]=[["operationId":"bad"]]
  for key in ["schemaVersion","operationId","expectedPauseOperationId","sourceNamespace","enrollmentId","endpointId"]{var x=resumeRequest();x.removeValue(forKey:key);cases.append(x)}
  for (key,value) in [("schemaVersion","2.0.0"),("sourceNamespace","ABCDEF00-0000-4000-8000-000000000004"),("enrollmentId","bad")]{var x=resumeRequest();x[key]=value;cases.append(x)}
  var extra=resumeRequest();extra["selection"]="known";cases.append(extra)
  var badType=resumeRequest();badType["expectedPauseOperationId"]=true;cases.append(badType)
  for x in cases{host.resumeCollection(x){reply in check(reply["reason"] as? String=="invalid_request","malformed resume rejected");if x["operationId"] as? String=="bad" || x["operationId"]==nil{check(reply["operationId"] is NSNull,"invalid ID never reflected")}}}
  check(requests==r && disk.writes==w && allocations==0,"malformed DTO inert");finish();return
 }
 if mode=="pause-invalid"{let before=requests,writes=disk.writes;let result=pauseNow(["operationId":"bad"]);check(result["reason"] as? String=="invalid_request" && result["operationId"] is NSNull && result["binding"] is NSNull,"invalid ID never echoed");check(disk.writes==writes && requests==before,"invalid action inert");finish();return}
 if mode=="pause-no-known"{let r=try! NativeHealthRuntime.make(configuration:configuration(),transport:transport),before=requests,writes=disk.writes;var result:[String:Any]=[:];r.pauseCollection(NativeHealthPauseRequest(pauseRequest())!){result=$0};check(result["reason"] as? String=="no_local_binding","factory alone has no source binding");check(disk.writes==writes && requests==before && sdk.queries==0,"no binding inert");finish();return}

 if ["oversize-config","origin-config","protected-unavailable","missing-config"].contains(mode){let before=requests;host.setup(selection:mode=="missing-config" ? "absent":"known",action:.enrollExistingRemote){result in check((try? result.get())==nil && allocations==0 && requests==before && sdk.queries==0 && disk.writes==0,"invalid config stays inert");finish()};return}
 if mode=="locked"{disk.locked=true};if mode=="corrupt"{disk.data=Data([1])};if mode=="oversized-store"{disk.data=Data(repeating:0,count:8*1024*1024+1)}
 let original=disk.data
 host.setup(selection:"known",action:.enrollExistingRemote){result in
  if ["locked","corrupt","oversized-store"].contains(mode){check((try? result.get())==nil && disk.data==original && disk.writes==0 && sdk.queries==0,"bad storage preserved");finish();return}
  if mode=="shared-config-reentry",["health-provider","storage-factory"].contains(sharedConfigSite){check((try? result.get())==nil && sdk.queries==0 && ingests==0 && disk.writes==0,"withdrawal from native factory/config must prevent setup IO and ready publication");check(allocations==(sharedConfigSite=="health-provider" ? 0:1),"no replacement allocation after withdrawal callback");later{finish()};return}
  if mode.hasPrefix("shared-"),sharedWriteStage=="setup",["shared-write-before","shared-write-after"].contains(mode){check((try? result.get())==nil,"setup failure observed from actual owner");assertSharedUnknown();return}
  check((try? result.get()) != nil,"actual host setup")
  check(allocations==1 && sdk.queries==0 && ingests==0,"setup does not collect")
  check(allocations==1,"one native storage factory allocation")
  if mode.hasPrefix("shared-"){beginShared();return}
  if mode.hasPrefix("status-") {
   if mode=="status-draining"{sdkWithheld={host.withdraw();runSelectedStatus()};host.sync(selection:"known",category:"sleep"){_ in};return}
   runSelectedStatus();return
  }

  if mode=="scope-equality"{check(plan != decomposedPlan,"opaque plan equality must use exact bytes");finish();return}
  if mode=="scope-anchor"{let box=fixtureInput,ticket=FixtureHealthCategory(category:"sleep");try! box.commit(scope:plan.anchorScope,expectedAnchor:nil,nextAnchor:Data([7]),changes:[],ticket:ticket);check((try! box.anchor(for:decomposedPlan.anchorScope,ticket:ticket))==nil,"distinct UTF8 scopes must not share anchor");finish();return}
  if mode=="scope-host"{useDecomposed=true;host.sync(selection:"known",category:"sleep"){result in check((try? result.get())==nil && sdk.queries==0,"changed opaque scope fences actual host");finish()};return}
  if mode=="config-drift"{provenance="changed-native-plan";host.sync(selection:"known",category:"sleep"){result in check((try? result.get())==nil && sdk.queries==0 && allocations==1,"configuration drift fenced");later{check(host.status()["state"] as? String=="unavailable","changed plan retired");finish()}};return}
  if mode=="health-background" {let before=disk.data;host.withdraw();later{check(disk.data==before && sdk.queries==0 && host.status()["state"] as? String=="unavailable","background retires without collection or mutation");finish()};return}

  if ["paused","resume","rebind"].contains(mode){var j=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any];var e=j["enrollments"] as! [Any];var row=e[1] as! [String:Any];row[mode=="rebind" ? "requiresRebind":"paused"]=true;e[1]=row;j["enrollments"]=e;disk.data=bytes(j);host.setup(selection:"known",action:.confirmExistingLocal){check((try? $0.get())==nil,"paused does not silently resume");check(sdk.queries==0,"paused no query")
   if mode=="paused"{finish();return}
   host.setup(selection:"known",action:mode=="resume" ? .resumeExistingLocal:.rebindExistingLocal){second in
    check((try? second.get()) != nil,"explicit local transition succeeds")
    host.sync(selection:"known",category:"sleep"){third in check((try? third.get()) == .applied,"explicit transition sync");finish()}
   }
  };return}
  if ["sdk-domains","auth-temporary","auth-ref","auth-identity","pause-domains","pause-domains-fail"].contains(mode) {
   let fixture=try! JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:ProcessInfo.processInfo.environment["CALENDAR_FIXTURE"]!))) as! [String:Any]
   let id=UUID(uuidString:"30000000-0000-4000-8000-000000000001")!,outbox=fixtureInput
   let p=try! MobileCalendarPolicyParser.parse(bytes(fixture["policy"]!),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:id)
   try! outbox.admitCalendar(proof:p);let ticket=try! outbox.calendarTicket(enrollment:id,category:"CalendarEvent")
   var item=(fixture["vectors"] as! [[String:Any]])[0]["item"] as! [String:Any],change: [String:Any]
   change=item["change"] as! [String:Any];change["expectedPolicyRevision"]=p.revision;item["change"]=change
   let scope=try! MobileCalendarDelivery.CheckpointScope(collector:p.collector,namespace:p.namespace,mappingVersion:"synthetic-calendar-mapping/1",coverage:.partial,start:"2026-10-01T00:00:00Z",end:"2026-11-01T00:00:00Z")
   try! outbox.commitCalendar(scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([9]),items:[bytes(item)],ticket:ticket)
   calendarTicket=ticket;calendarPending=try! outbox.pendingCalendar(ticket:ticket)
   // Seed a validated synthetic stored Share association through the external storage port.
   // No Share authority or live import is installed in the runtime.
   let sharedText=try! String(contentsOfFile:ProcessInfo.processInfo.environment["SHARE_FIXTURE"]!,encoding:.utf8).replacingOccurrences(of:"\\ud800",with:"__UNPAIRED__")
   let shared=try! JSONSerialization.jsonObject(with:Data(sharedText.utf8)) as! [String:Any]
   var sharedItem=(shared["pairs"] as! [[String:Any]]).first{$0["case"] as? String=="file-reference"}!["ios"] as! [String:Any]
   let contentBytes=Data([0,1,2,3,255])
   func digest(_ value:Data)->String{SHA256.hash(data:value).map{String(format:"%02x",$0)}.joined()}
   var content=sharedItem["content"] as! [String:Any],artifact=content["artifact"] as! [String:Any];artifact["byteLength"]=contentBytes.count;artifact["sha256"]=digest(contentBytes);content["artifact"]=artifact;sharedItem["content"]=content
   let parsed=try! MobileSharedItem.decode(bytes(sharedItem)),attempt=UUID(),receipt=UUID()
   let key=digest(try! JSONEncoder().encode([human.uuidString.lowercased(),endpoint.uuidString.lowercased(),parsed.source.namespace.uuidString.lowercased(),parsed.source.collector,attempt.uuidString.lowercased()]))
   var snapshot=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any]
   snapshot["version"]=3;snapshot["shareAssociations"]=[key:["human":human.uuidString,"endpoint":endpoint.uuidString,"namespace":parsed.source.namespace.uuidString,"collector":parsed.source.collector,"epoch":1,"attempt":attempt.uuidString,"receipt":receipt.uuidString,"item":parsed.data.base64EncodedString(),"digest":digest(parsed.data),"bytes":contentBytes.base64EncodedString(),"contentDigest":digest(contentBytes),"length":contentBytes.count]]
   disk.data=bytes(snapshot)
   check((try? outbox.validateSnapshot()) != nil,"stored Share fixture passes actual snapshot validation")
  }
  if mode.hasPrefix("auth-") {
   let observed=host.runtime!,before=disk.data
   if mode=="auth-temporary"{authStatus=503}
   if mode=="auth-ref"{authRef="renewed-same-identity"}
   if mode=="auth-identity"{authHuman=UUID().uuidString.lowercased()}
   transport.request("/api/auth/v1/user-context"){_ in
    later {
     let preserved=(try? fixtureInput.pendingCalendar(ticket:calendarTicket!))==calendarPending
     check(preserved,"stored Calendar bytes unchanged; actual global gate tested through Host")
     check(disk.data==before,"stored Share/Calendar bytes preserved")
     check(host.status()["state"] as? String=="unavailable" && sdk.queries==0 && allocations==1,"Health retired without replacement or query")
     finish()
    }
   };return
  }
  if mode.hasPrefix("resume-ui-") {
   if mode=="resume-ui-uncertain-pause"{disk.failWrite=true}
   runResumeUI();return
  }
  if mode.hasPrefix("pause-") {
   if ["pause-owner","pause-session","pause-origin"].contains(mode){
    let before=disk.data,writes=disk.writes
    func denied(){let n=requests;let reply=pauseNow(pauseRequest());check(reply["persistence"] as? String=="notApplied" && reply["drain"] as? String=="notStarted","changed native identity cannot pause target");check(disk.data==before && disk.writes==writes && requests==n && sdk.queries==0,"wrong identity does not retarget");finish()}
    if mode=="pause-origin"{transport.endpoint=URL(string:"https://different.invalid");denied()}
    else{if mode=="pause-owner"{authHuman=UUID().uuidString.lowercased()}else{authSession=UUID().uuidString.lowercased()};transport.request("/api/auth/v1/user-context"){_ in denied()}}
    return
   }
   if mode=="pause-setup-reentrant"{pauseTrigger=runPause;pauseFromProtected=true;host.setup(selection:"known",action:.confirmExistingLocal){check((try? $0.get())==nil,"reentrant setup pause fences entry")};return}
   if mode=="pause-sync-reentrant"{pauseTrigger=runPause;pauseFromProtected=true;host.sync(selection:"known",category:"sleep"){check((try? $0.get())==nil,"reentrant sync pause fences entry")};return}
   if ["pause-sdk","pause-never","pause-reentrant","pause-retiring"].contains(mode){sdkWithheld=runPause;host.sync(selection:"known",category:"sleep"){_ in};return}
   if ["pause-before-send","pause-after-send"].contains(mode){pauseTrigger=runPause;host.sync(selection:"known",category:"sleep"){_ in};return}
   if mode=="pause-setup-late"{holdPolicy=true;pauseTrigger=runPause;host.setup(selection:"known",action:.confirmExistingLocal){check((try? $0.get())==nil,"late setup cannot admit after pause")};return}
   runPause();return
  }
  if mode.hasPrefix("sdk-") {let observedRuntime=host.runtime!;sdkWithheld={
   let before=disk.data;host.withdraw();for _ in 0..<32 {host.withdraw()}
   if let calendarTicket {check((try? fixtureInput.pendingCalendar(ticket:calendarTicket))==calendarPending,"Health cancellation preserves stored Calendar inputs")};check(host.status()["state"] as? String=="draining","withheld SDK retains runtime")
   host.setup(selection:"known",action:.confirmExistingLocal){check((try? $0.get())==nil,"replacement blocked")}
   later{
    check(allocations==1 && sdk.handle.stops==1 && disk.data==before && ingests==0,"cancel does not commit or ingest")
    if mode=="sdk-never"{check(host.status()["state"] as? String=="draining","no timeout release");finish()}
    sdk.callback?(.success(NativeHealthPage(observations:[],deleted:["late"],anchor:Data([2]),mayHaveMore:false)))
    later{check(host.status()["state"] as? String=="unavailable" && disk.data==before,"late callback drains without mutation");finish()}
   }
  }}
  if mode=="context-drift"{contextRevision=2;authSession=UUID().uuidString.lowercased();transport.request("/api/auth/v1/user-context"){_ in later{check(host.status()["state"] as? String=="unavailable" && sdk.queries==0,"identity transition withdraws");finish()}};return}
  host.sync(selection:"known",category:"sleep"){result in
   if mode.hasPrefix("sdk-") || mode=="delivery-cancel"{return}
   check((try? result.get()) == .applied,"actual runtime sync succeeds")
   check(sdk.queries==1 && ingests==1 && allocations==1,"same runtime storage SDK and delivery")
   check(host.status()["pending"] as? Int==0 && host.status()["mayHaveMore"] as? Bool==true,"truthful state")
   later{finish()}
  }
 }
}
DispatchQueue.main.asyncAfter(deadline:.now()+12){fputs("timeout \(mode)\n",stderr);exit(3)}
RunLoop.main.run()

// Initial setup/permission fixtures: original configuration, immutable owner
// inputs, low-level SDK callbacks/storage and authenticated HTTP responses only.
func makeChoicePort()->NativeHealthSetupChoicePort?{
 if mode=="health-choice-missing-provider",healthSetupSite=="provider"{return nil}
 let c=configuration()
 func descriptor(_ destination:String="Synthetic private server",category:String?=nil)->NativeHealthSetupDescriptor{
  let config:NativeHealthRuntime.Configuration
  if let category{config = .init(provenance:c.provenance,origin:c.origin,human:c.human,session:c.session,endpoint:c.endpoint,enrollment:c.enrollment,plans:[.init(category:category,scope:plan.scope,mappingVersion:plan.mappingVersion,start:plan.start,end:plan.end)],maxBytes:c.maxBytes,maxEvents:c.maxEvents,storageOrigin:c.storageOrigin,protectedFilePolicy:c.protectedFilePolicy,protectedAvailable:c.protectedAvailable,makeStorage:c.makeStorage,makeSDK:c.makeSDK)}else{config=c}
  return .init(selector:"known",revision:1,title:"This phone's configured Health",destinationLabel:destination,namespace:UUID(uuidString:namespace)!,configuration:config)
 }
 let original=[descriptor()]
 var descriptors=original
 if mode=="health-choice-catalog"{
  if healthSetupSite=="missing-destination"{descriptors=[descriptor("")]}
  if healthSetupSite=="unsupported-plan"{descriptors=[descriptor(category:"hrvRMSSD")]}
  if healthSetupSite=="duplicate"{descriptors+=original}
  if healthSetupSite=="overflow"{descriptors=Array(repeating:original[0],count:9)}
 }
 let owner:AnyObject=mode=="health-choice-bootstrap" && healthSetupSite=="wrong-owner" ? NSObject():choiceOwner
 let currency=NativeHealthChoiceCurrency(owner:owner,descriptors:mode=="health-choice-catalog" && healthSetupSite=="wrong-destination" ? [descriptor("Another destination")]:descriptors);choiceCurrency=currency
 let port=NativeHealthSetupChoicePort(owner:choiceOwner,currency:mode=="health-choice-missing-provider" && healthSetupSite=="currency" ? nil:currency,descriptors:descriptors)
 if mode=="health-choice-bootstrap"{
  if healthSetupSite=="revoked"{currency.revoke()}
  if ["other-host","weak-nil"].contains(healthSetupSite){let other=NativeHealthHost(transport:transport,configuration:{_ in c},choicePort:port);if healthSetupSite=="other-host"{choiceOtherHost=other}}
 }
 return port
}
func choiceMutate(_ field:String){
 let original=choiceCurrency!;original.revoke()
 switch field{
 case "plan":useDecomposed=true;useDecomposed=false
 case "source":choiceSourceMarker="another-source";choiceSourceMarker="original"
 case "protected":protectedHealthy=false;protectedHealthy=true
 case "provider":let changed=NativeHealthChoiceCurrency(owner:choiceOwner,descriptors:[]);choiceCurrency=changed;choiceCurrency=original
 default:let old=provenance;provenance="changed-original-owner";provenance=old
 }
}
func choiceResolve(_ selection:String)->NativeHealthRuntime.Configuration?{
 guard selection=="known",choiceSourceMarker=="original",!(mode=="health-choice-missing-provider" && healthSetupSite=="configuration") else{return nil}
 if choiceArmed,!choiceInjected{
  if mode=="health-permission-direct-runtime-reentry",healthSetupSite=="lookup-setup",choicePhase=="permission"{choiceInjected=true;choiceDirectPreflightReentry()}
  if mode=="health-choice-catalog-drift",healthSetupSite != "inventory"{choiceInjected=true;choiceMutate(healthSetupSite)}
  if mode=="health-permission-bootstrap-reentry",healthSetupSite=="enumeration"{choiceInjected=true;let before=requests;host.loadSetupChoices{check($0["reason"] as? String=="busy","original resolver reentry remains reserved")};check(requests==before,"resolver reentry no nested HTTP/store")}
 }
 return configuration()
}
func choiceWire(_ path:String,_ value:[String:Any],isPolicy:Bool)->[String:Any]{
 var object=value
 if path=="/api/runtime/v1/session-context",choicePhase=="sync",choiceSDKDone{choicePostQueryContext=true}
 if path=="/api/runtime/v1/mobile-context",var result=object["result"] as? [String:Any],var sources=result["sources"] as? [[String:Any]],!sources.isEmpty{
  if mode=="health-permission-direct-runtime-reentry",healthSetupSite=="inventory-setup",choicePhase=="permission",!choiceInjected{choiceInjected=true;choiceDirectPreflightReentry()}
  if mode=="health-choice-catalog"{
   if healthSetupSite=="unbound"{sources[0]["currentEndpointEnrollment"]=NSNull()}
   if healthSetupSite=="foreign"{result["principalId"]=UUID().uuidString.lowercased()}
   if healthSetupSite=="paused"{var cfg=sources[0]["configuration"] as! [String:Any];cfg["collectionPaused"]=true;sources[0]["configuration"]=cfg}
  }
  result["sources"]=sources;object["result"]=result
  if mode=="health-choice-catalog-drift",healthSetupSite=="inventory",!choiceInjected{choiceInjected=true;choiceMutate("provider")}
 }
 if isPolicy,choicePhase=="permission"{
  choicePolicySeen=true
  if mode=="health-permission-changed-policy"{
   var result=object["result"] as! [String:Any],row=result["enrollment"] as! [String:Any],effective=result["effective"] as! [String:Any]
   if healthSetupSite=="advance" || healthSetupSite=="regress"{let revision=healthSetupSite=="advance" ? 2:1;row["revision"]=revision;effective["policyRevision"]=revision}
   if healthSetupSite=="narrow"{effective["categories"]=[String]()}
   if healthSetupSite=="namespace"{let changed=UUID().uuidString.lowercased();row["sourceNamespace"]=changed;effective["sourceNamespace"]=changed}
   result["enrollment"]=row;result["effective"]=effective;object["result"]=result
  }
 }
 if isPolicy,choicePhase=="setup",mode=="health-choice-setup",healthSetupSite=="source-change"{
  var result=object["result"] as! [String:Any],row=result["enrollment"] as! [String:Any],effective=result["effective"] as! [String:Any];let changed=UUID().uuidString.lowercased();row["sourceNamespace"]=changed;effective["sourceNamespace"]=changed;result["enrollment"]=row;result["effective"]=effective;object["result"]=result
 }
 if choicePhase=="sync",mode=="health-choice-sync-outcomes",path=="/api/runtime/v1/mobile-context",var result=object["result"] as? [[String:Any]]{
  if healthSetupSite=="retry"{for i in result.indices{result[i]["outcome"]="retryable";result[i]["code"]="unavailable"};object["result"]=result}
  if healthSetupSite=="needsAttention"{for i in result.indices{result[i]["outcome"]="rejected";result[i]["code"]="invalid"};object["result"]=result}
  if healthSetupSite=="invalidReceipt"{result[0]["eventId"]=UUID().uuidString.lowercased();object["result"]=result}
 }
 return object
}
func choicePrepareAuthorization(_ types:Set<String>)->NativeHealthAuthorizationDelegate?{
 check(choicePhase=="permission","SDK authorization only explicit separate action")
 check(types==Set(configuration().plans.map(\.category)),"SDK receives original configured types only")
 if mode=="health-permission-unavailable-sdk",healthSetupSite=="query-only"{return nil}
 guard sdk.available else{return nil}
 if mode=="health-permission-sdk-preinvoke-reentry"{
  if healthSetupSite=="ticket-read"{disk.onRead={disk.onRead=nil;choiceMutate("plan")}}
  else{choiceMutate(healthSetupSite)}
 }
 if mode=="health-permission-direct-runtime-reentry"{
  let runtime=host.runtime!,r=requests,w=disk.writes
  if healthSetupSite=="resume"{host.pauseCollection(pauseRequest()){check($0["persistence"] as? String=="savedPaused","explicit protective pause remains available")}}
  if ["setup","resume"].contains(healthSetupSite){runtime.setup(healthSetupSite=="resume" ? .resumeExistingLocal:.enrollExistingRemote){check((try? $0.get())==nil,"DIRECT Runtime setup cannot rearm permission root")}}
  if healthSetupSite=="sync"{runtime.sync(category:"sleep"){check((try? $0.get())==nil,"DIRECT Runtime sync cannot enter permission")}}
  if healthSetupSite=="status"{check(runtime.status()["state"] as? String=="unavailable","DIRECT status cannot observe a Core frame")}
  if healthSetupSite=="Calendar",let selected=sharedSelection("calendar"){runtime.calendar(collect:false,supplied:selected.configuration,fresh:{selected.configuration}){check($0 == .notApplied(.unavailable),"DIRECT Calendar reentry denied")}}
  check(requests==r && disk.writes==w+(healthSetupSite=="resume" ? 1:0),"reentry does not acquire HTTP/Core except separate pause")
 }
 return {done in
  choiceAuthCalls+=1;choiceSDKCompletion=done;choiceDelegateEntered?()
  func complete(_ value:Result<Void,Error>){done(value);DispatchQueue.main.async{choiceDelegateReturned=true}}
  if mode=="health-permission-never"{DispatchQueue.main.async{choiceDelegateReturned=true};return}
  if ["health-permission-late","health-permission-pause","health-permission-withdraw","health-permission-calendar-drain","health-permission-delegate-entered-reentry"].contains(mode){return}
  let result:Result<Void,Error> = mode=="health-permission-callback-result" && healthSetupSite != "true" ? .failure(CocoaError(healthSetupSite=="false" ? .userCancelled:.fileReadUnknown)):.success(())
  if mode=="health-permission-positive",healthSetupSite=="sync"{complete(result)}else{DispatchQueue.main.async{complete(result);if mode=="health-permission-duplicate"{done(result)}}}
 }
}
func choiceCheckReply(_ value:[String:Any],kind:String){
 let field=kind=="setup" ? "setupOutcome":kind=="permission" ? "requestState":"syncOutcome"
 check(Set(value.keys)==Set(["schemaVersion","operation","catalogId","choice","attemptId","reason","readKnowledge",field]),"closed native action reply")
 check(value["readKnowledge"] as? String=="unknown" && value["operation"] as? String==kind && bytes(value).count<=4096,"honest bounded native action reply")
}
func choiceInput(_ catalog:[String:Any])->[String:Any]{let row=(catalog["choices"] as! [[String:Any]])[0];return ["catalogId":catalog["catalogId"]!,"choice":row["choice"]!]}
func runHealthChoices(){
 choicePhase="catalog"
 host.loadSetupChoices{catalog in
  check(Set(catalog.keys)==Set(["schemaVersion","state","reason","catalogId","choices"]),"closed native choice catalog")
  check(allocations==0 && healthSDKAllocations==0 && disk.writes==0 && sdk.queries==0 && choiceAuthCalls==0,"catalog metadata only, no Root/store/SDK/prompt")
  let negative=mode=="health-choice-missing-provider" || mode=="health-choice-bootstrap" || mode=="health-choice-catalog" && healthSetupSite != "positive" || mode=="health-choice-catalog-drift"
  if negative{check(catalog["state"] as? String != "available" && catalog["catalogId"] is NSNull && (catalog["choices"] as! [Any]).isEmpty,"invalid original choice unavailable");finish();return}
  check(catalog["state"] as? String=="available","actual original configured choice available \(catalog)")
  var input=choiceInput(catalog)
  if mode=="health-choice-catalog" || mode=="health-permission-bootstrap-reentry" && healthSetupSite=="enumeration"{finish();return}
  if mode=="health-choice-handle-stale"{
   func attempt(){let r=requests,w=disk.writes;host.performChoice(.setup,input:input){value in choiceCheckReply(value,kind:"setup");check(value["setupOutcome"] as? String=="notInvoked" && allocations==0 && requests==r && disk.writes==w,"stale/extra handles inert");finish()}}
   if healthSetupSite=="reload"{host.loadSetupChoices{_ in attempt()};return}
   if healthSetupSite=="catalog"{input["catalogId"]=UUID().uuidString.lowercased()};if healthSetupSite=="choice"{input["choice"]=UUID().uuidString.lowercased()};if healthSetupSite=="extra"{input["enrollmentId"]=enrollment.uuidString.lowercased()};attempt();return
  }
  if mode=="health-choice-foreign-scope"{
   if healthSetupSite=="origin"{transport.endpoint=URL(string:"https://changed.invalid");host.performChoice(.setup,input:input){value in check(value["setupOutcome"] as? String=="notInvoked" && allocations==0,"foreign origin refuses old handles");finish()};return}
   if healthSetupSite=="endpoint"{contextRevision+=1;choiceCurrency!.revoke()}else if healthSetupSite=="human"{authHuman=UUID().uuidString.lowercased()}else{authSession=UUID().uuidString.lowercased()}
   transport.request("/api/auth/v1/user-context"){_ in host.performChoice(.setup,input:input){value in check(value["setupOutcome"] as? String=="notInvoked" && allocations==0,"foreign owner/endpoint refuses old handles");finish()}};return
  }
  if mode=="health-permission-no-setup"{host.performChoice(.permission,input:input){value in choiceCheckReply(value,kind:"permission");check(value["requestState"] as? String=="notInvoked" && allocations==0 && choiceAuthCalls==0,"catalog is not local setup");finish()};return}
  if mode=="health-choice-setup-existing-local"{
   let seed=HealthOutbox(storage:disk);try! seed.setHuman(human);let proof=try! MobileHealthPolicyParser.parse(bytes(policy),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:enrollment);try! seed.enroll(proof:proof,selectedTypes:["sleep"])
  }
  if mode=="health-choice-setup-uncertainty" || mode=="health-permission-unknown-hold" && healthSetupSite=="setup"{if healthSetupSite=="before"{disk.failWrite=true}else{disk.writeThenThrow=true}}
  choicePhase="setup"
  let before=disk.data,writes=disk.writes
  host.performChoice(.setup,input:input){setup in
   choiceCheckReply(setup,kind:"setup")
   if mode=="health-choice-setup-uncertainty" || mode=="health-permission-unknown-hold" && healthSetupSite=="setup"{
    check(setup["setupOutcome"] as? String=="notConfirmed","actual setup uncertainty not fictitious no-write")
    let calls=requests,alloc=allocations;host.loadSetupChoices{value in check(value["state"] as? String != "available" && requests==calls && allocations==alloc,"catalog cannot recreate unresolved original root");finish()};return
   }
   if mode=="health-choice-setup-existing-local" || mode=="health-choice-setup" && healthSetupSite=="source-change" || mode=="health-permission-bootstrap-reentry"{
    check(setup["setupOutcome"] as? String=="notConfirmed" && choiceAuthCalls==0 && sdk.queries==0,"failed original admission never falls back")
    check(disk.data==before && disk.writes==writes,"source/row/bootstrap refusal before save")
    if mode=="health-choice-setup",healthSetupSite=="source-change"{check(healthSDKAllocations==0,"expected namespace checked before SDK/setHuman")};finish();return
   }
   check(setup["setupOutcome"] as? String=="prepared","actual existing-remote local setup \(setup)")
   check(allocations==1 && healthSDKAllocations==1 && sdk.queries==0 && choiceAuthCalls==0 && ingests==0,"setup neither requests access nor queries/sends")
   if mode=="health-choice-setup" || mode=="health-choice-separate-actions" && healthSetupSite=="setup"{
    if healthSetupSite=="duplicate"{let data=disk.data,w=disk.writes;host.performChoice(.setup,input:input){value in check(value["setupOutcome"] as? String=="notConfirmed" && disk.data==data && disk.writes==w,"no duplicate first enrollment/fallback");finish()}}else{finish()};return
   }
   if mode=="health-choice-sync-outcomes" || mode=="health-choice-separate-actions" && healthSetupSite=="sync"{choiceRunSync(catalog,input);return}
   if mode=="health-permission-unknown-hold"{choiceUnknownHold(catalog,input);return}
   if mode=="health-permission-fence-unwind"{choiceFenceUnwind(input);return}
   choiceRunPermission(catalog,input)
  }
 }
}
func choiceCompleteSDK(_ value:Result<Void,Error> = .success(())){
 choiceSDKCompletion?(value);DispatchQueue.main.async{choiceDelegateReturned=true}
}
func choiceRunPermission(_ catalog:[String:Any],_ input:[String:Any]){
 choicePhase="permission";choicePolicySeen=false
 if mode=="health-permission-denied-policy"{resumePolicyMode=healthSetupSite=="denied" ? "blocked":healthSetupSite}
 if mode=="health-permission-unavailable-sdk",healthSetupSite=="unavailable"{sdk.available=false}
 if mode=="health-permission-core-read-fence"{
  disk.onRead={if choicePolicySeen && !choiceInjected{disk.onRead=nil;choiceInjected=true;choiceMutate(healthSetupSite)}}
 }
 if mode=="health-permission-calendar-drain"{seedShared()}
 let before=disk.data,writes=disk.writes,queries=sdk.queries,posts=ingests
 var otherWrites=0,postActionBytes=before
 choiceDelegateEntered={
  check(choiceAuthCalls==1 && choicePermissionReplies==0,"actual OS delegate entered once before reply")
  if mode=="health-permission-never"{
   if healthSetupSite=="pause"{let w=disk.writes;host.pauseCollection(pauseRequest()){check($0["drain"] as? String=="pending","OS callback pending is not fake pause drain")};otherWrites=disk.writes-w;postActionBytes=disk.data}else{host.withdraw()}
   later{
    check(choicePermissionReplies==0 && allocations==1,"never callback keeps original owner and result reservation")
    let calls=requests;host.loadSetupChoices{value in check(value["reason"] as? String=="busy" && requests==calls && allocations==1,"no replacement/catalog effect while actual SDK outstanding")}
    host.setup(selection:"known",action:.confirmExistingLocal){check((try? $0.get())==nil,"never callback cannot replace/rearm owner")}
    check(choiceAuthCalls==1 && sdk.queries==queries && ingests==posts,"never callback no auto-sync")
    finish()
   };return
  }
  if mode=="health-permission-pause"{
   if healthSetupSite=="write-unknown"{disk.writeThenThrow=true}
   let w=disk.writes
   host.pauseCollection(pauseRequest()){value in check(value["persistence"] as? String==(healthSetupSite=="write-unknown" ? "unconfirmed":"savedPaused"),"genuine separate protective pause result");check(value["drain"] as? String=="pending","pause waits actual permission callback")}
   otherWrites=disk.writes-w;postActionBytes=disk.data;disk.writeThenThrow=false
  }
  if mode=="health-permission-withdraw"{
   if healthSetupSite=="config"{choiceMutate("plan")}
   else if healthSetupSite=="protected"{choiceCurrency!.revoke();protectedHealthy=false}
   else{authSession=UUID().uuidString.lowercased();transport.request("/api/auth/v1/user-context"){_ in}}
  }
  if mode=="health-permission-late" || mode=="health-permission-delegate-entered-reentry"{
   if healthSetupSite=="account"{authHuman=UUID().uuidString.lowercased();transport.request("/api/auth/v1/user-context"){_ in}}
   else if healthSetupSite=="endpoint"{choiceCurrency!.revoke();contextRevision+=1}
   else if healthSetupSite=="config"{choiceMutate("config")}
   else{host.withdraw()}
  }
  if mode=="health-permission-calendar-drain"{
   host.calendarDeliverPending(selection:"calendar"){check($0 == .notApplied(.unavailable),"permission reserves normal Calendar admission")}
   check(sharedCustodyAcquires==0,"no original Calendar custody while real SDK callback pending")
   if healthSetupSite=="whole-withdraw"{choiceMutate("config")}
  }
  if ["health-permission-late","health-permission-pause","health-permission-withdraw","health-permission-calendar-drain","health-permission-delegate-entered-reentry"].contains(mode){
   later{check(choicePermissionReplies==0 && allocations==1,"logical cancel/withdraw is not actual callback retirement");choiceCompleteSDK()}
  }
 }
 host.performChoice(.permission,input:input){value in
  choicePermissionReplies+=1;choiceCheckReply(value,kind:"permission")
  check(choicePermissionReplies==1,"one final permission reply")
  let state=value["requestState"] as! String
  let notInvoked=["health-permission-denied-policy","health-permission-changed-policy","health-permission-core-read-fence","health-permission-sdk-availability-reentry","health-permission-sdk-preinvoke-reentry"].contains(mode) || mode=="health-permission-direct-runtime-reentry" && healthSetupSite=="resume"
  let deferred=["health-permission-late","health-permission-pause","health-permission-withdraw","health-permission-delegate-entered-reentry"].contains(mode) || mode=="health-permission-calendar-drain" && healthSetupSite=="whole-withdraw" || mode=="health-permission-callback-result" && healthSetupSite != "true"
  if notInvoked{check(state=="notInvoked" && choiceAuthCalls==0,"stale/denied before actual OS delegate \(value)")}
  else if mode=="health-permission-unavailable-sdk"{check(state=="unsupported" && choiceAuthCalls==0,"old query-only or unavailable SDK never prompts")}
  else{check(state==(deferred ? "deferred":"completedReadNotObservable") && choiceAuthCalls==1 && choiceDelegateReturned,"entered request waits actual handler-return barrier, never read-grant \(value)")}
  if mode=="health-permission-direct-runtime-reentry",healthSetupSite=="resume"{otherWrites=1;postActionBytes=disk.data}
  check(disk.writes==writes+otherWrites && disk.data==(otherWrites>0 ? postActionBytes:before),"permission/policy confirmation zero saved writes; explicit pause separately attributed")
  check(sdk.queries==queries && ingests==posts,"permission never implicitly queries or sends")
  if mode=="health-permission-calendar-drain"{
   if healthSetupSite=="whole-withdraw"{host.calendarDeliverPending(selection:"calendar"){check($0 == .notApplied(.unavailable),"genuine whole-runtime loss also denies Calendar")};finish();return}
   choicePhase="Calendar"
   host.calendarDeliverPending(selection:"calendar"){delivery in guard case .settled(let accepted,_,_,_,_)=delivery else{check(false,"explicit original Calendar after real permission drain \(delivery)");return};check(accepted==1 && sharedCustodyAcquires==1 && sharedPosts==1 && sharedFactoryCalls==0 && sharedQueries==0,"same Root separate pending after real callback, no EventKit");finish()};return
  }
  if mode=="health-permission-positive"{choiceRunSync(catalog,input);return}
  // A request-processing failure is not HealthKit read denial. Separate
  // ordinary sync remains governed by its existing fresh source/SDK owners.
  if mode=="health-permission-callback-result",healthSetupSite != "true"{choiceRunSync(catalog,input);return}
  if (notInvoked || deferred) && mode != "health-permission-changed-policy"{
   host.sync(selection:"known",category:"sleep"){_ in check(sdk.queries==queries && ingests==posts,"actually withdrawn/paused/denied original path no subsequent query/POST");finish()};return
  }
  finish()
 }
}
func choiceRunSync(_ catalog:[String:Any],_ request:[String:Any]){
 choicePhase="sync";choiceSDKDone=false;choicePostQueryContext=false;choiceDeferredReads=0
 var input=request;let row=(catalog["choices"] as! [[String:Any]])[0],data=(row["dataChoices"] as! [[String:Any]])[0];input["categoryChoice"]=data["categoryChoice"]
 let auth=choiceAuthCalls
 if mode=="health-choice-sync-outcomes",healthSetupSite=="deferred"{
  disk.onRead={if choicePostQueryContext{choiceDeferredReads+=1;if choiceDeferredReads==2{disk.onRead=nil;disk.locked=true}}}
 }
 host.performChoice(.sync,input:input){value in
  disk.locked=false;choiceCheckReply(value,kind:"sync")
  let expected=mode=="health-choice-sync-outcomes" ? healthSetupSite:"applied"
  check(value["syncOutcome"] as? String==expected,"actual original sync Completion preserved \(value)")
  check(choiceAuthCalls==auth && sdk.queries==1 && allocations==1,"explicit sync no repeated permission/new SDK/root")
  if expected=="idle"{check(ingests==0,"actual empty pending not fabricated data/denial")}else if expected != "deferred"{check(ingests==1,"actual original HTTP receipt path")}
  finish()
 }
}
func choiceUnknownHold(_ catalog:[String:Any],_ request:[String:Any]){
 if healthSetupSite=="pause"{
  disk.writeThenThrow=true;host.pauseCollection(pauseRequest()){value in check(value["persistence"] as? String=="unconfirmed","actual original pause write-then-throw")};disk.writeThenThrow=false
  let calls=requests,w=disk.writes,a=allocations
  host.loadSetupChoices{value in check(value["state"] as? String != "available" && calls==requests && w==disk.writes && a==allocations,"catalog cannot clear original protective uncertainty");finish()};return
 }
 choicePhase="sync"
 var input=request;input["categoryChoice"]=((catalog["choices"] as! [[String:Any]])[0]["dataChoices"] as! [[String:Any]])[0]["categoryChoice"]
 disk.onReplace={data in if let object=try? JSONSerialization.jsonObject(with:data) as? [String:Any],let rows=object["enrollments"] as? [Any],rows.count>1,let row=rows[1] as? [String:Any],let queue=row["queue"] as? [Any],queue.isEmpty,sdk.queries>0{disk.onReplace=nil;disk.writeThenThrow=true}}
 host.performChoice(.sync,input:input){_ in
  disk.writeThenThrow=false
  let calls=requests,w=disk.writes,a=allocations
  host.loadSetupChoices{value in check(value["state"] as? String != "available" && requests==calls && disk.writes==w && allocations==a,"actual original delivery unknown retains same root, no catalog reconstruction");finish()}
 }
}

func choiceFenceUnwind(_ input:[String:Any]){
 seedShared();choicePhase="Calendar";choiceUnwindInput=input;choiceUnwindArmed=true
 host.calendarDeliverPending(selection:"calendar"){_ in
  check(choiceUnwindAttempted && choiceAuthCalls==0,"real original Calendar parent unwind case reached; NO fictitious normal Health parent")
  finish()
 }
}

func choiceDirectPreflightReentry(){
 let runtime=host.runtime!,calls=requests,writes=disk.writes
 var reported=false
 runtime.setup(.resumeExistingLocal){result in reported=true;check((try? result.get())==nil,"original resolver/inventory direct Runtime reentry denied")}
 check(reported && requests==calls && disk.writes==writes,"permission must reserve actual Runtime BEFORE original resolver/inventory callback")
}
