import Foundation
import CryptoKit
@testable import AssistantCore
// TEST ONLY: explicit verified synthetic source scope for the stricter request fence.
let syntheticVerifiedCalendarScope=MobileCalendarSyncScope(containers:["selected","fixture-calendar","synthetic-calendar"].map{.init(id:$0,accountID:"synthetic-account")},start:Date(timeIntervalSince1970:1790812800),end:Date(timeIntervalSince1970:1798761600),mappingVersion:"synthetic-acquisition/1")!


func check(_ value: @autoclosure () -> Bool,_ message: String){if !value(){fputs("FAIL: \(message)\n",stderr);exit(1)}}
func json(_ value: Any) -> Data {try! JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes])}
func later(_ body: @escaping () -> Void){DispatchQueue.main.asyncAfter(deadline:.now()+0.03,execute:body)}
let mode=CommandLine.arguments[1]
let human=UUID(uuidString:"50000000-0000-4000-8000-000000000001")!,session=UUID(uuidString:"00000000-0000-4000-8000-000000000003")!,endpoint=UUID(uuidString:"60000000-0000-4000-8000-000000000001")!,enrollment=UUID(uuidString:"30000000-0000-4000-8000-000000000001")!,namespace=UUID(uuidString:"10000000-0000-4000-8000-000000000001")!
var policyCalls=0,authCalls=0,sessionCalls=0,unexpected=0,healthNotifications=0,outcomes=0,drained=false
var revision=1,contextGeneration=1,endpointRevision=1,authRef="synthetic",authHuman=human.uuidString.lowercased(),authSession=session.uuidString.lowercased(),provenance="native-synthetic",protectedHealthy=true,changed=false,clockCalls=0
var owner: NativeCalendarAcquisitionOwner!
let root=try! JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:ProcessInfo.processInfo.environment["CALENDAR_FIXTURE"]!))) as! [String:Any]
let basePolicy=root["policy"] as! [String:Any]
let proof=try! MobileCalendarPolicyParser.parse(json(basePolicy),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:enrollment)
final class Disk: HealthSnapshotStorage {
    var data: Data?,writes=0,armed=false
    var deliveryWrite=false,deliveryAcquisitionWrite=false,onSettlement:(()->Void)?
    func read() throws -> Data? {data}
    func replace(_ value: Data) throws {
        writes+=1
        let object=try! JSONSerialization.jsonObject(with:value) as! [String:Any]
        let rows=(object["calendarEnrollments"] as? [Any] ?? []).compactMap{$0 as? [String:Any]}
        let prior=(data.flatMap{try? JSONSerialization.jsonObject(with:$0) as? [String:Any]}?["calendarEnrollments"] as? [Any] ?? []).compactMap{$0 as? [String:Any]}
        func count(_ rows:[[String:Any]])->Int {rows.reduce(0){$0+(($1["queue"] as? [Any])?.count ?? 0)}}
        let settling=deliveryWrite && count(rows)<count(prior)
        if settling{onSettlement?()}
        if settling && mode=="delivery-write-before"{throw CocoaError(.fileWriteUnknown)}
        if deliveryAcquisitionWrite && count(rows)>count(prior){data=value;throw CocoaError(.fileWriteUnknown)}
        let commit=armed && rows.contains{($0["queue"] as? [Any] ?? []).count>0}
        if commit && mode=="write-before" {throw CocoaError(.fileWriteUnknown)}
        data=value
        if settling && mode=="delivery-write-after"{throw CocoaError(.fileWriteUnknown)}
        if commit && mode=="write-after" {throw CocoaError(.fileWriteUnknown)}
    }
}
final class Connection: ConnectionStore {func load() throws -> SavedConnection? {nil};func save(_ v: SavedConnection) throws {}}
final class Lease: NativeCalendarAcquisitionLease {
    let outbox: HealthOutbox
    var held=false,healthy=true,releases=0,onCheck:(()->Void)?,onRelease:(()->Void)?
    init(_ box: HealthOutbox){outbox=box}
    func acquire() throws -> any NativeCalendarAcquisitionLease {guard !held else{throw CocoaError(.fileReadNoPermission)};held=true;return self}
    func checkCurrent() -> Bool {onCheck?();return healthy && held}
    func release(){check(held,"release original lease once");held=false;releases+=1;onRelease?()}
}
struct Event: MobileEventKitEventReading {
    func readEvent() throws -> MobileEventKitRawEvent {
        if mode=="config-after"{provenance="changed"}
        if mode=="window-after"{changed=true}
        if mode=="protected-after"{protectedHealthy=false}
        if mode=="lease-after"{lease.healthy=false}
        if mode=="epoch-after"{transport.epoch+=1}
        if mode=="origin-after"{transport.endpoint=URL(string:"https://changed.invalid")}
        return .init(item:.init(itemIdentifier:.observed("synthetic-event"),calendarIdentifier:.observed("selected"),accountIdentifier:.observed("synthetic-account"),externalIdentifier:.observed(nil),title:.observed("Synthetic event"),notes:.observed(nil),recurrenceRules:.observed(nil)),startDate:.observed(Date(timeIntervalSince1970:1793491200)),endDate:.observed(Date(timeIntervalSince1970:1793494800)),isAllDay:.observed(false),timeZoneIdentifier:.observed("UTC"),occurrenceDate:.observed(nil),isDetached:.observed(false),statusRawValue:.observed(1),alarms:.observed(nil))
    }
}
struct Reminder: MobileEventKitReminderReading {
    func readReminder() throws -> MobileEventKitRawReminder {.init(item:.init(itemIdentifier:.observed("synthetic-task"),calendarIdentifier:.observed("selected"),accountIdentifier:.observed("synthetic-account"),externalIdentifier:.observed(nil),title:.observed("Synthetic task"),notes:.observed(nil),recurrenceRules:.observed(nil)),dueDateComponents:.observed(nil),isCompleted:.observed(true),completionDate:.observed(nil))}
}
final class Batch: MobileEventKitReminderBatch {
    var count: Int {1}
    func reminder(at index: Int) -> any MobileEventKitReminderReading {
        if mode=="entered-callback" {owner.cancel();check(lease.held && owner.busy && lease.releases==0,"entered callback retains lease")}
        return Reminder()
    }
}
final class Token: MobileEventKitFetchToken {}
final class Store: MobileEventKitStoreReading {
    var enumerations=0,fetches=0,cancels=0
    func access(_ plan: MobileEventKitAcquisition.Plan) -> MobileEventKitReadAccess {mode=="denied" ? .denied:mode=="write-only" ? .writeOnly:.fullRead}
    func enumerateEvents(_ plan: MobileEventKitAcquisition.Plan,yield: @escaping (any MobileEventKitEventReading) -> Bool) throws {enumerations+=1;if mode=="delivery-acquire-cancel"{owner.cancel()};if mode != "delivery-existing-backlog"{_ = yield(Event())}}
    func fetchReminders(_ plan: MobileEventKitAcquisition.Plan,completion: @escaping ((any MobileEventKitReminderBatch)?) -> Void) throws -> any MobileEventKitFetchToken {
        fetches+=1
        if mode=="late-token" {owner.cancel();check(lease.held && owner.busy && cancels==0,"cancel before token installation held")}
        else if mode=="cancel-sdk" {DispatchQueue.main.async{owner.cancel()}}
        else {DispatchQueue.main.async{completion(Batch());if mode=="duplicate-callback"{completion(Batch())}}}
        return Token()
    }
    func cancelFetch(_ token: any MobileEventKitFetchToken){cancels+=1;check(lease.held && lease.releases==0,"token cancellation is not early owner release")}
}
final class DeliveryShareAuthority: OutboxShareAuthority {
    let lock=NSRecursiveLock()
    func withFence<T>(_ body: () throws -> T) rethrows -> T {lock.lock();defer{lock.unlock()};return try body()}
    func permits(_ context: OutboxShareContext,reading: Bool)->Bool{context.epoch==1}
}
final class DeliveryShareLease: SharedCaptureReadLease {
    let originalSelectionContext: any SharedCaptureBinding
    var values:[Data?]
    init(_ context:OutboxShareContext,_ bytes:Data){originalSelectionContext=context;values=[bytes,nil]}
    func check() throws{}
    func read(maxBytes:Int)throws->Data?{values.removeFirst()}
    func close(){}
}
let disk=Disk(),box=mode.hasPrefix("delivery-") ? HealthOutbox(storage:disk,shareAuthority:DeliveryShareAuthority()):HealthOutbox(storage:disk),store=Store(),transport=NativeTransport(store:Connection())
try! box.setHuman(human);try! box.admitCalendar(proof:proof)
let lease=Lease(box)
try! transport.configure("https://offline.invalid",username:"synthetic")
transport.healthContextWillChange={_ in healthNotifications+=1}
func requestBody(_ r: URLRequest) -> Data {if let body=r.httpBody{return body};guard let stream=r.httpBodyStream else{return Data()};stream.open();defer{stream.close()};var data=Data(),buffer=[UInt8](repeating:0,count:4096);while stream.hasBytesAvailable{let n=stream.read(&buffer,maxLength:buffer.count);if n<=0{break};data.append(buffer,count:n)};return data}
func finish(){check(unexpected==0,"only synthetic intercepted routes");print("\(mode) passed");exit(0)}
func cancelledHeld(_ respond: @escaping () -> Void, never: Bool){
    owner.cancel()
    later {
        check(owner.busy && lease.held && lease.releases==0 && !drained,"original HTTP/policy callback still reserved")
        check(store.enumerations+store.fetches==0,"no SDK before withheld policy")
        owner.collect{check($0 == .notApplied(.busy),"another run cannot bypass withheld original callback")}
        if never {finish()}else{respond();owner.whenDrained{check(!lease.held && lease.releases==1,"release after original callback and barrier");finish()}}
    }
}
final class Offline: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {true}
    override class func canonicalRequest(for request: URLRequest) -> URLRequest {request}
    override func startLoading(){DispatchQueue.main.async{[self] in
        if mode.hasPrefix("delivery-"){deliveryResponse(self);return}
        guard request.url?.host=="offline.invalid" else{unexpected+=1;client?.urlProtocol(self,didFailWithError:URLError(.unsupportedURL));return}
        var object:[String:Any],status=200
        switch request.url!.path {
        case "/api/auth/v1/user-context":
            authCalls+=1
            if authCalls==2 {
                if mode=="auth-401"{status=401};if mode=="auth-503"{status=503}
                if mode=="human-before"{authHuman=UUID().uuidString.lowercased()};if mode=="session-before"{authSession=UUID().uuidString.lowercased()}
            }
            if authCalls==6,mode=="reference-after"{authRef="changed-native-reference"}
            object=["producerPin":["schemaId":"https://lifestream.dev/contracts/effective-subject/1.0.0","schemaVersion":"1.0.0","digest":"ed098cad970a310a807881ea7a833b96f1c980e8377ee3cfcbdffd68f2bd0cf9"],"contextRef":authRef,"context":["schemaVersion":"1.0.0","actorId":authHuman,"effectiveUserId":authHuman,"authenticatedSessionId":authSession,"installationId":"00000000-0000-4000-8000-000000000009","authorityRevision":1,"generation":1,"issuedAt":"2026-10-31T00:00:00Z"],"actor":["principalId":authHuman],"effectiveUser":["principalId":authHuman],"impersonating":false]
        case "/api/runtime/v1/session-context":
            sessionCalls+=1
            if sessionCalls==5 {if mode=="revision-after"{revision=2};if mode=="generation-after"{contextGeneration=2};if mode=="endpoint-revision-after"{endpointRevision=2}}
            object=["ended":sessionCalls==5 && mode=="ended-after","revision":revision,"contextGeneration":contextGeneration,"endpoint":["endpointId":sessionCalls==5 && mode=="endpoint-after" ? UUID().uuidString.lowercased():endpoint.uuidString.lowercased(),"privacyClass":sessionCalls==5 && mode=="privacy-after" ? "public":"personal","configurationRevision":endpointRevision]]
        case "/api/runtime/v1/mobile-context":
            let body=try! JSONSerialization.jsonObject(with:requestBody(request)) as! [String:Any]
            guard body["operation"] as? String=="calendar",let payload=body["payload"] as? [String:Any],payload["operation"] as? String=="policy" else{unexpected+=1;client?.urlProtocol(self,didFailWithError:URLError(.unsupportedURL));return}
            policyCalls+=1;object=basePolicy
            if policyCalls==2 {
                var result=object["result"] as! [String:Any],row=result["enrollment"] as! [String:Any],effective=result["effective"] as! [String:Any]
                if mode=="revision-policy" {row["revision"]=3;effective["policyRevision"]=3}
                if mode=="categories-policy" {effective["categories"]=["Task"]}
                if mode=="source-policy" {row["sourceNamespace"]=UUID().uuidString.lowercased();effective["sourceNamespace"]=row["sourceNamespace"]}
                if mode=="binding-policy" {effective["policyBindingDigest"]=String(repeating:"c",count:64)}
                result["enrollment"]=row;result["effective"]=effective;object["result"]=result
            }
        default:unexpected+=1;client?.urlProtocol(self,didFailWithError:URLError(.unsupportedURL));return
        }
        var responseBytes=json(object)
        let alias: String?=["raw-authority-fraction","raw-generation-fraction","raw-session-fraction","raw-endpoint-fraction"].contains(mode) ? "1.0000000000000001":mode=="raw-near-safe-fraction" ? "9007199254740990.5":mode=="raw-integer-decimal" ? "1.0":mode=="raw-integer-exponent" ? "10e-1":nil
        if let alias {
            var body=String(data:responseBytes,encoding:.utf8)!
            var fields:[String]=[]
            if request.url!.path=="/api/auth/v1/user-context",authCalls>1 {
                if mode=="raw-authority-fraction" || mode=="raw-near-safe-fraction"{fields=["authorityRevision"]}
                else if mode=="raw-generation-fraction"{fields=["generation"]}
                else if mode.hasPrefix("raw-integer-"){fields=["authorityRevision","generation"]}
            }
            if request.url!.path=="/api/runtime/v1/session-context" {
                if mode=="raw-session-fraction"{fields=["revision"]}
                else if mode=="raw-endpoint-fraction"{fields=["configurationRevision"]}
                else if mode.hasPrefix("raw-integer-"){fields=["revision","contextGeneration","configurationRevision"]}
            }
            for field in fields{body=body.replacingOccurrences(of:"\""+field+"\":1",with:"\""+field+"\":"+alias)}
            responseBytes=Data(body.utf8)
        }
        let respond={ [self] in client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:nil)!,cacheStoragePolicy:.notAllowed);client?.urlProtocol(self,didLoad:responseBytes);client?.urlProtocolDidFinishLoading(self)}
        if releaseReentryStarted,request.url!.path=="/api/auth/v1/user-context"{return} // Causal baseline's new run remains pending; no fake acknowledgment.
        if request.url!.path=="/api/runtime/v1/mobile-context",policyCalls==1,["cancel-policy","never-policy"].contains(mode){cancelledHeld(respond,never:mode=="never-policy");return}
        if request.url!.path=="/api/auth/v1/user-context",authCalls==2,mode=="cancel-auth"{cancelledHeld(respond,never:false);return}
        respond()
    }}
    override func stopLoading(){}
}
let network=URLSessionConfiguration.ephemeral;network.protocolClasses=[Offline.self];transport.session=URLSession(configuration:network,delegate:transport,delegateQueue:.main)
var workerBlocks:[()->Void]=[], initialConfigurationEntered=false, reentryReplies=0, releaseReentryStarted=false, extraDrainObserver=false
func configuration() -> NativeCalendarAcquisitionOwner.Configuration {
    if mode=="config-reentry-before",!initialConfigurationEntered {
        initialConfigurationEntered=true
        owner.collect{reply in reentryReplies+=1;check(reply == .notApplied(.busy),"initial native configuration reentry is busy")}
        check(reentryReplies==1 && !lease.held && policyCalls==0 && store.enumerations+store.fetches==0,"configuration reentry denied before lease/policy/SDK")
    }
    if mode=="config-cancel-before",!initialConfigurationEntered {
        initialConfigurationEntered=true;owner.cancel()
    }
    let start: TimeInterval=changed ? 1790899200:mode=="future-window" ? 1796083200:1790812800
    let category=["task","delivery-happy-task","late-token","cancel-sdk","entered-callback","duplicate-callback"].contains(mode) ? "Task":"CalendarEvent"
    let plan=MobileEventKitAcquisition.Plan(category:category,selectedContainerIDs:["selected"],mappingVersion:"synthetic-acquisition/1",coverageStart:Date(timeIntervalSince1970:start),coverageEnd:Date(timeIntervalSince1970:start+86400),capturedSDKDefaultTimeZone:TimeZone(secondsFromGMT:0)!)
    return .init(provenance:provenance,origin:"https://offline.invalid",human:human,session:session,endpoint:endpoint,enrollment:enrollment,namespace:namespace,plan:plan,protectedAvailable:{
        if mode=="final-reentrant",policyCalls==2,!changed{changed=true;owner.cancel()}
        deliveryFinalGuard("protected")
        return protectedHealthy
    },deliveryScope:syntheticVerifiedCalendarScope)
}
func makeOwner() -> NativeCalendarAcquisitionOwner {
    NativeCalendarAcquisitionOwner(transport:transport,outbox:box,configuration:mode=="no-provider" ? nil:configuration,acquireOriginalOwnerLease:{try lease.acquire()},makeAcquisition:{original in
        acquisitionFactoryCalls+=1
        let target=mode=="wrong-box" ? HealthOutbox(storage:Disk()):original
        return MobileEventKitAcquisition(outbox:target,storePort:store,executeOnWorker:{work in if mode=="held-worker"{workerBlocks.append(work)}else{work()}})
    },captureClock:{clockCalls+=1;return Date(timeIntervalSince1970:mode=="invalid-clock" ? .infinity:1793404800)})
}
// External inputs only. These modes execute the original owner, Policy,
// Transport and outbox; no fixture substitutes their admission or settlement.
let deliveryStage=ProcessInfo.processInfo.environment["CALENDAR_DELIVERY_STAGE"] ?? "send"
let withAcquisition=["delivery-happy-event","delivery-happy-task","delivery-existing-backlog","delivery-acquire-unconfirmed","delivery-acquire-cancel"].contains(mode)
let sendPolicy=withAcquisition ? 3:2
let targetPolicy=deliveryStage=="settle" ? sendPolicy+1:sendPolicy
var finalGuardChecks=0,finalGuardFired=false
func deliveryFinalGuard(_ kind:String){
    guard mode=="delivery-final-"+kind+"-config",sessionCalls==4*targetPolicy else{return}
    finalGuardChecks+=1
    if finalGuardChecks==3 {
        finalGuardFired=true
        if kind=="lease"{changed=true}else{provenance="final-protected-change"}
    }
}
var posts:[Data]=[],deliveryResults=0,seeded:[Data]=[],crossDomainBefore:[String:Any]=[:],reservation:(any SharedCaptureReservation)?,settlementWrites=0
/// Observe fixture disk bytes after cancellation without inventing a new grant.
func pendingBytes()->[Data]{
    let state=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any]
    let rows=(state["calendarEnrollments"] as? [Any] ?? []).compactMap{$0 as? [String:Any]}
    return rows.flatMap{($0["queue"] as? [[String:Any]] ?? []).filter{($0["quarantined"] as? Bool) != true}.map{Data(base64Encoded:$0["data"] as! String)!}}
}
func response(_ loader:URLProtocol,_ data:Data,_ status:Int=200){loader.client?.urlProtocol(loader,didReceive:HTTPURLResponse(url:loader.request.url!,statusCode:status,httpVersion:nil,headerFields:nil)!,cacheStoragePolicy:.notAllowed);loader.client?.urlProtocol(loader,didLoad:data);loader.client?.urlProtocolDidFinishLoading(loader)}
func receipt(_ bytes:[Data],_ mixed:Bool=false)->Data {
    let rows=bytes.enumerated().map{index,bytes->[String:Any] in
        let item=try! MobileCalendarDelivery.item(bytes),outcome=mixed ? ["accepted","duplicate","rejected","retryable"][index%4]:"accepted"
        return ["eventId":item.eventId.uuidString.lowercased(),"requestDigest":item.digest,"outcome":outcome,"code":outcome=="rejected" ? "scope":outcome=="retryable" ? "unavailable":"applied","durability":["accepted","duplicate"].contains(outcome) ? "sqlCommit" as Any:NSNull()]
    }
    return json(["schemaVersion":"1.0.0","producerPin":root["producerPin"]!,"result":["kind":"sync","receipts":rows]])
}
func deliveryResponse(_ loader:URLProtocol){
    guard loader.request.url?.host=="offline.invalid" else{unexpected+=1;loader.client?.urlProtocol(loader,didFailWithError:URLError(.unsupportedURL));return}
    switch loader.request.url!.path {
    case "/api/auth/v1/user-context":
        authCalls+=1
        response(loader,json(["producerPin":["schemaId":"https://lifestream.dev/contracts/effective-subject/1.0.0","schemaVersion":"1.0.0","digest":"ed098cad970a310a807881ea7a833b96f1c980e8377ee3cfcbdffd68f2bd0cf9"],"contextRef":authRef,"context":["schemaVersion":"1.0.0","actorId":authHuman,"effectiveUserId":authHuman,"authenticatedSessionId":authSession,"installationId":"00000000-0000-4000-8000-000000000009","authorityRevision":1,"generation":1,"issuedAt":"2026-10-31T00:00:00Z"],"actor":["principalId":authHuman],"effectiveUser":["principalId":authHuman],"impersonating":false]))
    case "/api/runtime/v1/session-context":
        sessionCalls+=1;response(loader,json(["ended":false,"revision":revision,"contextGeneration":contextGeneration,"endpoint":["endpointId":endpoint.uuidString.lowercased(),"privacyClass":"personal","configurationRevision":endpointRevision]]))
    case "/api/runtime/v1/mobile-context":
        let bytes=requestBody(loader.request),body=try! JSONSerialization.jsonObject(with:bytes) as! [String:Any],payload=body["payload"] as! [String:Any]
        check(body["operation"] as? String=="calendar","Calendar wire only")
        if payload["operation"] as? String=="policy" {
            policyCalls+=1;var object=basePolicy
            if policyCalls==targetPolicy {
                if mode=="delivery-auth-drift"{authHuman=UUID().uuidString.lowercased()}
                if mode=="delivery-session-drift"{authSession=UUID().uuidString.lowercased()}
                if mode=="delivery-origin-drift"{transport.endpoint=URL(string:"https://changed.invalid")}
                if mode=="delivery-config-drift"{provenance="changed"}
                if mode=="delivery-protected-drift"{protectedHealthy=false}
                if mode=="delivery-lease-drift"{lease.healthy=false}
                if mode=="delivery-context-drift"{contextGeneration+=1}
                var result=object["result"] as! [String:Any],row=result["enrollment"] as! [String:Any],effective=result["effective"] as! [String:Any]
                if mode=="delivery-policy-revision"{row["revision"]=3;effective["policyRevision"]=3}
                if mode=="delivery-policy-categories"{effective["categories"]=["Task"]}
                if mode=="delivery-policy-binding"{effective["policyBindingDigest"]=String(repeating:"c",count:64)}
                result["enrollment"]=row;result["effective"]=effective;object["result"]=result
                if mode=="delivery-refresh-queue-change" {
                    // A real earlier settlement removes captured rows while the
                    // proof itself is unchanged. Do not silently rebuild batch.
                    // Refresh has invalidated the old ticket. A fixture external
                    // earlier same-proof settlement obtains its own current ticket.
                    try! box.confirmCalendarPolicy(proof:proof)
                    let ticket=try! box.calendarTicket(enrollment:enrollment,category:configuration().plan.category),items=try! box.pendingCalendar(ticket:ticket,limit:64)
                    try! box.settleCalendar(ticket:ticket,submitted:items,response:receipt(items))
                }
                if mode=="delivery-cancel-reauthorize"{owner.cancel();check(owner.busy && lease.held,"original policy callback reserved during cancel")}
            }
            response(loader,json(object));return
        }
        check(payload["operation"] as? String=="ingest","real pinned ingest")
        check(bytes.count<=65536,"full UTF8 native transport cap")
        check(lease.held && lease.releases==0 || mode=="delivery-http-unknown-retry","original lease spans actual POST")
        let items=(payload["items"] as! [[String:Any]]).map{try! MobileCalendarDelivery.canonical($0)}
        check(try! MobileCalendarDelivery.batch(items.map{try MobileCalendarDelivery.item($0)})==bytes,"exact canonical wire body")
        posts.append(bytes)
        if mode=="delivery-prefix-cap"{check(bytes.count==65536,"boundary batch is exactly65536bytes");check(items.count==1,"one bounded prefix retained remainder")}
        if mode=="delivery-never-post" {
            later{check(owner.busy && lease.held && lease.releases==0,"never-returning callback remains owned");assertAllBusy();finish()};return
        }
        if mode=="delivery-cancel-post" {owner.cancel();check(owner.busy && lease.held,"POST cancellation logical reply cannot release outstanding callback");return}
        if mode=="delivery-http-unknown-retry",posts.count==1 {loader.client?.urlProtocol(loader,didFailWithError:URLError(.networkConnectionLost));return}
        if mode=="delivery-http-503"{response(loader,Data(),503);return}
        var object=try! JSONSerialization.jsonObject(with:receipt(items,mode=="delivery-mixed-receipts")) as! [String:Any]
        var result=object["result"] as! [String:Any],rows=result["receipts"] as! [[String:Any]]
        if mode=="delivery-missing-receipt"{rows=[]}
        if mode=="delivery-duplicate-receipt"{rows.append(rows[0])}
        if mode=="delivery-wrong-digest"{rows[0]["requestDigest"]=String(repeating:"0",count:64)}
        if mode=="delivery-wrong-durability"{rows[0]["durability"]=NSNull()}
        if mode=="delivery-wrong-pin"{object["producerPin"]=["schemaId":"wrong"]}
        result["receipts"]=rows;object["result"]=result
        if mode=="delivery-malformed-receipt"{response(loader,Data("invalid".utf8))}else{response(loader,json(object))}
    default:unexpected+=1;loader.client?.urlProtocol(loader,didFailWithError:URLError(.unsupportedURL))
    }
}
func assertAllBusy(){
    owner.collect{check($0 == .notApplied(.busy),"collect cannot bypass active Run")}
    owner.collectAndDeliver{check($0 == .notApplied(.busy),"collectAndDeliver cannot bypass active Run")}
    owner.deliverPending{check($0 == .notApplied(.busy),"deliverPending cannot bypass active Run")}
}
func seedPending(_ count:Int,_ targetSize:Int?=nil){
    let vector=(root["vectors"] as! [[String:Any]])[0]["input"] as? [String:Any] ?? (root["vectors"] as! [[String:Any]])[0]["item"] as! [String:Any]
    var items:[Data]=[]
    for index in 0..<count {
        var item=vector,change=item["change"] as! [String:Any],record=change["record"] as! [String:Any]
        change["eventId"]=UUID().uuidString.lowercased();change["expectedPolicyRevision"]=proof.revision;change["mappingVersion"]=configuration().plan.mappingVersion
        record["notes"]="é";var source=change["source"] as! [String:Any];source["accountId"]="synthetic-account";change["source"]=source;var time=record["time"] as! [String:Any];time["timeZone"]=["kind":"supplied","identifier":"UTC"];record["time"]=time;change["record"]=record;item["change"]=change
        if let targetSize,index==0 {
            let baseline=try! MobileCalendarDelivery.batch([MobileCalendarDelivery.item(json(item))]).count
            check(baseline<targetSize,"fixture baseline smaller than boundary")
            record["notes"]="é"+String(repeating:"a",count:targetSize-baseline);change["record"]=record;item["change"]=change
            check(try! MobileCalendarDelivery.batch([MobileCalendarDelivery.item(json(item))]).count==targetSize,"full canonical UTF8 boundary fixture")
        }
        items.append(try! MobileCalendarDelivery.item(json(item)).data)
    }
    let scope=try! MobileCalendarDelivery.CheckpointScope(collector:"eventKit",namespace:namespace,mappingVersion:configuration().plan.mappingVersion,coverage:.unknown,start:"2026-10-01T00:00:00Z",end:"2026-10-02T00:00:00Z")
    let ticket=try! box.calendarTicket(enrollment:enrollment,category:"CalendarEvent")
    try! box.commitCalendar(scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([1]),items:items,ticket:ticket);seeded=items
}
func seedCrossDomain(){
    let healthEnrollment=UUID(uuidString:"00000000-0000-4000-8000-000000000002")!,healthNamespace=UUID().uuidString.lowercased()
    let c:[String:Any]=["categories":["SleepSegment"],"uses":[],"assistantIds":[],"collectionPaused":false,"usePaused":false]
    let health:[String:Any]=["schemaVersion":"1.0.0","producerPin":["schemaId":MobileHealthEncoder.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthEncoder.schemaSHA256],"result":["enrollment":["enrollmentId":healthEnrollment.uuidString.lowercased(),"principalId":human.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":healthNamespace,"revision":1,"state":"active","configuration":c],"effective":["policyRevision":1,"sourceBound":true,"collectionAllowed":true,"categories":["SleepSegment"],"uses":[],"assistantIds":[],"sourceNamespace":healthNamespace]]]
    let p=try! MobileHealthPolicyParser.parse(json(health),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:healthEnrollment)
    try! box.enroll(proof:p,selectedTypes:["sleep"]);let ticket=try! box.ticket(enrollment:healthEnrollment,type:"sleep")
    try! box.commit(scope:"synthetic-health",expectedAnchor:nil,nextAnchor:Data([7]),changes:[HealthChange(upstreamId:"synthetic",operation:.delete,body:nil,collectedAt:Date(timeIntervalSince1970:1793404800),expectedPolicyRevision:1,mappingVersion:"healthkit-v1")],ticket:ticket)
    let path=URL(fileURLWithPath:ProcessInfo.processInfo.environment["CALENDAR_FIXTURE"]!).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("mobile-shared-item-fixtures/shared-item-pairs.json")
    let raw=try! String(contentsOf:path,encoding:.utf8).replacingOccurrences(of:"\\ud800",with:"__UNPAIRED__"),pairs=(try! JSONSerialization.jsonObject(with:Data(raw.utf8)) as! [String:Any])["pairs"] as! [[String:Any]]
    var item=pairs.first{$0["case"] as? String=="file-reference"}!["ios"] as! [String:Any],content=item["content"] as! [String:Any],artifact=content["artifact"] as! [String:Any];let shared=Data([0,1,2,3,255])
    artifact["byteLength"]=shared.count;artifact["sha256"]=SHA256.hash(data:shared).map{String(format:"%02x",$0)}.joined();content["artifact"]=artifact;item["content"]=content
    let bytes=json(item),value=try! MobileSharedItem.decode(bytes),context=OutboxShareContext(owner:box,human:human,endpoint:endpoint,namespace:value.source.namespace,collector:value.source.collector,epoch:1,recoveryOnly:false)
    guard case .portAcknowledged=MobileSharedCapture.capture(itemJSON:bytes,attempt:OutboxShareAttempt(UUID(),context:context),lease:DeliveryShareLease(context,shared),owner:box) else{check(false,"actual Share seed");return}
    try! box.confirmCalendarPolicy(proof:proof)
    guard case .reserved(let reserved,_)=try! box.reserve(attempt:OutboxShareAttempt(UUID(),context:context),payloadDigest:SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined(),item:value,context:context) else{check(false,"actual Share reservation");return}
    reservation=reserved;try! box.check(reserved)
    crossDomainBefore=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any]
}
func runDelivery(){
    if mode != "delivery-empty" && !withAcquisition{seedPending(mode=="delivery-mixed-receipts" ? 4:mode=="delivery-prefix-cap" ? 2:1,mode=="delivery-prefix-cap" ? 65536:mode=="delivery-single-oversize" ? 65537:nil)}
    if mode=="delivery-existing-backlog"{seedPending(1)}
    if ["delivery-happy-event","delivery-happy-task","delivery-pending-only"].contains(mode){seedCrossDomain()}
    disk.deliveryAcquisitionWrite=mode=="delivery-acquire-unconfirmed"
    disk.deliveryWrite=["delivery-write-before","delivery-write-after","delivery-settle-reentry"].contains(mode)
    disk.onSettlement={settlementWrites+=1;if mode=="delivery-settle-reentry"{owner.cancel();assertAllBusy()}}
    transport.request("/api/auth/v1/user-context"){seed in
        check((try? seed.get()) != nil,"seed actual transport identity")
        owner=makeOwner()
        if mode=="delivery-final-lease-config"{lease.onCheck={deliveryFinalGuard("lease")}}
        if mode=="delivery-release-reentry"{lease.onRelease={assertAllBusy()}}
        func complete(_ result:NativeCalendarAcquisitionOwner.DeliveryOutcome){
            deliveryResults+=1
            if mode=="delivery-http-unknown-retry",deliveryResults==1 {
                check(result == .transportFailure,"unknown HTTP keeps originals");assertAllBusy()
                owner.whenDrained{later{owner.deliverPending(completion:complete)}};return
            }
            if ["delivery-write-before","delivery-write-after","delivery-acquire-unconfirmed"].contains(mode){
                if mode=="delivery-acquire-unconfirmed"{guard case .acquisitionUnconfirmed=result else{check(false,"acquisition unknown");return}}
                else{guard case .settlementUnconfirmed=result else{check(false,"settlement unknown");return};check(settlementWrites==1,"failure armed exactly at settlement")}
                let writes=disk.writes,bytes=disk.data,requests=authCalls+sessionCalls+policyCalls+posts.count
                owner.cancel();assertAllBusy();let replacement=makeOwner();replacement.deliverPending{check($0 == .notApplied(.unavailable),"same held original lease blocks replacement")}
                later{check(owner.busy && lease.held && lease.releases==0,"uncertain original attempt/receipt remains held");check(disk.writes==writes && disk.data==bytes && requests==authCalls+sessionCalls+policyCalls+posts.count,"no replay or readback upgrade");if mode=="delivery-acquire-unconfirmed"{check(posts.isEmpty,"unknown acquisition never sends")};finish()};return
            }
            let drift=mode.hasSuffix("-drift") || mode.hasPrefix("delivery-policy-") || mode=="delivery-refresh-queue-change" || mode.hasPrefix("delivery-final-")
            if mode.hasPrefix("delivery-final-"){
                check(finalGuardFired && finalGuardChecks>=3,"causal mutation armed only on final pre-effect native guard")
                print("Causal final-guard stage=\(deliveryStage) firedAt=3 posts=\(posts.count) outcome=\(result) persistedPending=\(pendingBytes().count)")
            }
            if drift {check(result == .notApplied(.stale),"drift refuses stale batch");check(posts.count==(deliveryStage=="settle" ? 1:0),"drift at selected boundary")}
            else if mode=="delivery-empty"{check(result == .emptyPending(acquired:nil),"empty current queue")}
            else if mode=="delivery-single-oversize"{check(result == .requestTooLarge && posts.isEmpty,"single oversize retained, never sent")}
            else if mode=="delivery-http-503"{check(result == .transportFailure,"503 retains originals")}
            else if ["delivery-malformed-receipt","delivery-missing-receipt","delivery-duplicate-receipt","delivery-wrong-digest","delivery-wrong-pin","delivery-wrong-durability"].contains(mode){check(result == .invalidReceipt,"invalid receipt cannot settle")}
            else if ["delivery-cancel-post","delivery-cancel-reauthorize"].contains(mode){check(result == .notApplied(.cancelled),"cancel prevents stale settlement")}
            else if mode=="delivery-acquire-cancel"{check(result == .acquisitionNotApplied(.cancelled) && posts.isEmpty,"cancelled acquisition never sends")}
            else {
                guard case .settled(let accepted,let rejected,let retryable,let more,let acquired)=result else{check(false,"confirmed bounded settlement");return}
                check(accepted==(mode=="delivery-mixed-receipts" ? 2:1),"accepted includes durable duplicates")
                check(rejected==(mode=="delivery-mixed-receipts" ? 1:0) && retryable==(mode=="delivery-mixed-receipts" ? 1:0),"exact rejected/retryable counts")
                check(more==["delivery-mixed-receipts","delivery-prefix-cap"].contains(mode),"conservative remainder")
                check(acquired==(withAcquisition ? (mode=="delivery-existing-backlog" ? 0:1):nil),"acquisition separate from durable accepted count")
            }
            owner.whenDrained{
                check(!owner.busy && !lease.held,"callbacks actually retired before release")
                if !withAcquisition{check(acquisitionFactoryCalls==0 && store.enumerations+store.fetches==0 && clockCalls==0,"pending-only never constructs SDK/acquisition or clock")}
                if !crossDomainBefore.isEmpty {
                    let after=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any]
                    check(json(after["enrollments"]!)==json(crossDomainBefore["enrollments"]!) && json(after["shareAssociations"]!)==json(crossDomainBefore["shareAssociations"]!),"Health and Share rows preserved")
                    do{try box.check(reservation!);check(false,"snapshot writes invalidate active Share reservation")}catch{}
                }
                if mode=="delivery-http-unknown-retry"{check(posts.count==2 && posts[0]==posts[1],"explicit retry exact body/IDs/digests without reacquisition")}
                if !drift {
                    let pending=pendingBytes()
                    if ["delivery-prefix-cap","delivery-mixed-receipts"].contains(mode){check(pending.count==1,"exact unsent/retryable remainder preserved")}
                    else if result == .transportFailure || result == .invalidReceipt || result == .requestTooLarge || result == .notApplied(.cancelled){check(pending==seeded,"failure retains exact queued originals")}
                    else if mode != "delivery-acquire-cancel"{check(pending.isEmpty,"settled exact prefix removed")}
                }
                later{finish()}
            }
        }
        if withAcquisition{owner.collectAndDeliver(completion:complete)}else{owner.deliverPending(completion:complete)}
        if mode=="delivery-drain-reentry"{owner.whenDrained{assertAllBusy();owner.whenDrained{check(!owner.busy,"new observer on later idle publication")}};owner.whenDrained{check(!owner.busy,"no stale original drain notification")}}
    }
}
var acquisitionFactoryCalls=0
if mode.hasPrefix("delivery-"){runDelivery();RunLoop.main.run();exit(1)}
transport.request("/api/auth/v1/user-context"){seed in
    check((try? seed.get()) != nil,"seed Auth fixture")
    owner=makeOwner();disk.armed=true
    if mode=="release-reentry" {
        lease.onRelease={
            lease.onRelease=nil;releaseReentryStarted=true
            owner.collect{reply in reentryReplies+=1;check(reply == .notApplied(.busy),"lease release cannot admit a new native run during drain publication")}
        }
    }
    owner.collect {result in
        outcomes+=1;check(outcomes==1,"one logical outcome")
        if ["cancel-policy","never-policy","cancel-auth"].contains(mode){check(result == .notApplied(.cancelled),"cancel logical result");return}
        if ["write-after","write-before"].contains(mode){
            guard case .unconfirmed=result else{check(false,"uncertain commit result");return}
            let writes=disk.writes,data=disk.data,requests=authCalls+sessionCalls+policyCalls
            owner.cancel();owner.collect{check($0 == .notApplied(.busy),"uncertain owner cannot restart")}
            let replacement=makeOwner();replacement.collect{check($0 == .notApplied(.unavailable),"original held lease prevents replacement owner")}
            later{check(owner.busy && lease.held && lease.releases==0 && !drained,"uncertain owner remains held after callback retirement");check(disk.writes==writes && disk.data==data && authCalls+sessionCalls+policyCalls==requests,"no retry/relabel/extra HTTP write");finish()};return
        }
        let success=["happy","task","future-window","duplicate-callback","config-reentry-before","raw-integer-decimal","raw-integer-exponent","release-reentry","drain-observer-reentry"].contains(mode)
        if success {guard case .committed(let count,_)=result else{check(false,"confirmed commit");return};check(count==1,"one selected record");let rows=(try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any])["calendarEnrollments"] as! [Any];let row=rows[1] as! [String:Any];let queue=row["queue"] as! [[String:Any]];check(queue.count==1,"one exact queue item");let data=Data(base64Encoded:queue[0]["data"] as! String)!;let item=try! JSONSerialization.jsonObject(with:data) as! [String:Any];check((item["change"] as! [String:Any])["collectedAt"] as? String=="2026-10-31T00:00:00.000Z","capture not backdated into query window")}
        else {guard case .notApplied=result else{check(false,"denied acquisition");return}}
        if mode.hasPrefix("raw-"),!mode.hasPrefix("raw-integer-"){check(store.enumerations+store.fetches==0,"fractional raw snapshot tokens reject before SDK")}
        if mode=="config-cancel-before"{check(result == .notApplied(.cancelled),"cancel during initial config is fenced");check(!lease.held && lease.releases==0 && policyCalls==0 && authCalls==1 && sessionCalls==0 && store.enumerations+store.fetches==0,"initial cancellation precedes lease/transport/SDK")}
        if mode=="auth-401"{check(healthNotifications>0,"existing401 notification preserved")}
        if ["no-provider","wrong-box","auth-401","auth-503","human-before","session-before","denied","write-only","invalid-clock"].contains(mode){check(store.enumerations+store.fetches==0,"pre-read rejection")}
        owner.whenDrained{
            drained=true;check(!owner.busy,"retired owner notification cannot fire while new native work is pending");check(!lease.held,"original lease released only after retirement")
            if !["no-provider","config-cancel-before"].contains(mode){check(lease.releases==1,"lease released once")}
            if ["release-reentry","drain-observer-reentry"].contains(mode){check(reentryReplies==1,"retirement publication admission is fenced")}
            if mode=="drain-observer-reentry"{later{check(extraDrainObserver,"new drain observer deferred safely to next publication");finish()}}else{finish()}
        }
    }
    if mode=="drain-observer-reentry" {
        owner.whenDrained{
            releaseReentryStarted=true
            owner.collect{reply in reentryReplies+=1;check(reply == .notApplied(.busy),"drain observer cannot admit new work before remaining observers")}
            owner.whenDrained{check(!owner.busy,"deferred observer idle");extraDrainObserver=true}
        }
        owner.whenDrained{check(!owner.busy,"remaining original drain observer never fires while a reentrant run is pending")}
    }
    owner.whenDrained{drained=true}
    if mode=="held-worker"{
        func inspect(){if workerBlocks.isEmpty{later{inspect()};return};owner.cancel();check(owner.busy && lease.held && !drained,"unexecuted SDK work remains owned");owner.collect{check($0 == .notApplied(.busy),"no timeout/new run escape")};check(store.enumerations==0,"no SDK query body entered");finish()};later{inspect()}
    }
}
RunLoop.main.run()
