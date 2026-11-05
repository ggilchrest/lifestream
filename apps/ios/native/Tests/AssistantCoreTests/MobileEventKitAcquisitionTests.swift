import Foundation
import CryptoKit
import XCTest
@testable import AssistantCore

private final class AcquisitionDisk: HealthSnapshotStorage {
    var data: Data?, writes=0, fail=false, writeThenThrow=false, locked=false
    func read() throws -> Data? {if locked{throw CocoaError(.fileReadNoPermission)};return data}
    func replace(_ value: Data) throws {writes+=1;if fail{throw CocoaError(.fileWriteUnknown)};data=value;if writeThenThrow{throw CocoaError(.fileWriteUnknown)}}
}
private struct AcquisitionEvent: MobileEventKitEventReading {
    var id="event",container="selected",notes: String?=nil,onRead: (() -> Void)?=nil,invalid=false
    func readEvent() throws -> MobileEventKitRawEvent {
        onRead?();if invalid{throw MobileEventKitAcquisition.Failure.invalid}
        return .init(item:.init(itemIdentifier:.observed(id),calendarIdentifier:.observed(container),accountIdentifier:.observed(nil),externalIdentifier:.observed(nil),title:.observed("Synthetic"),notes:.observed(notes),recurrenceRules:.observed(nil)),startDate:.observed(Date(timeIntervalSince1970:1793491200)),endDate:.observed(Date(timeIntervalSince1970:1793494800)),isAllDay:.observed(false),timeZoneIdentifier:.observed("UTC"),occurrenceDate:.observed(nil),isDetached:.observed(false),statusRawValue:.observed(1),alarms:.observed(nil))
    }
}
private struct AcquisitionReminder: MobileEventKitReminderReading {
    var id="task",onRead: (() -> Void)?=nil
    func readReminder() throws -> MobileEventKitRawReminder {
        onRead?();return .init(item:.init(itemIdentifier:.observed(id),calendarIdentifier:.observed("selected"),accountIdentifier:.observed(nil),externalIdentifier:.observed(nil),title:.observed("Synthetic task"),notes:.observed(nil),recurrenceRules:.observed(nil)),dueDateComponents:.observed(nil),isCompleted:.observed(true),completionDate:.observed(nil))
    }
}
private final class AcquisitionBatch: MobileEventKitReminderBatch {
    var total=1,reads=0,onRead: (() -> Void)?
    var count: Int {total}
    func reminder(at index: Int) -> any MobileEventKitReminderReading {reads+=1;onRead?();return AcquisitionReminder(id:"task-\(index)")}
}
private final class AcquisitionCallbackCapture {}
private final class AcquisitionToken: MobileEventKitFetchToken {}
private final class AcquisitionStore: MobileEventKitStoreReading {
    var onAccess: (() -> Void)?
    var permission=MobileEventKitReadAccess.fullRead,events=1,enumerations=0,fetches=0,cancels=0,yields=0,throwQuery=false,throwAfterCallback=false
    var event: (Int) -> AcquisitionEvent = {AcquisitionEvent(id:"event-\($0)")}
    var onFetch: (() -> Void)?,onCancel: (() -> Void)?,completion: (((any MobileEventKitReminderBatch)?) -> Void)?,inlineBatch: AcquisitionBatch?
    func access(_ plan: MobileEventKitAcquisition.Plan) -> MobileEventKitReadAccess {let action=onAccess;onAccess=nil;action?();return permission}
    func enumerateEvents(_ plan: MobileEventKitAcquisition.Plan,yield: @escaping (any MobileEventKitEventReading) -> Bool) throws {
        enumerations+=1;if throwQuery{throw CocoaError(.fileReadUnknown)}
        for index in 0..<events {yields+=1;if !yield(event(index)){break}}
    }
    func fetchReminders(_ plan: MobileEventKitAcquisition.Plan,completion: @escaping ((any MobileEventKitReminderBatch)?) -> Void) throws -> any MobileEventKitFetchToken {
        fetches+=1;if throwQuery{throw CocoaError(.fileReadUnknown)};self.completion=completion;onFetch?();if let inlineBatch{completion(inlineBatch)};if throwAfterCallback{throw CocoaError(.fileReadUnknown)};return AcquisitionToken()
    }
    func cancelFetch(_ token: any MobileEventKitFetchToken) {cancels+=1;onCancel?();completion=nil}
}
private final class AcquisitionShareAuthority: OutboxShareAuthority {
    let lock=NSRecursiveLock()
    func withFence<T>(_ body: () throws -> T) rethrows -> T {lock.lock();defer{lock.unlock()};return try body()}
    func permits(_ context: OutboxShareContext,reading: Bool) -> Bool {context.epoch==1}
}
private final class AcquisitionShareLease: SharedCaptureReadLease {
    let originalSelectionContext: any SharedCaptureBinding
    var values: [Data?]
    init(_ context: OutboxShareContext,_ bytes: Data){originalSelectionContext=context;values=[bytes,nil]}
    func check() throws {}
    func read(maxBytes: Int) throws -> Data? {values.removeFirst()}
    func close() {}
}
final class MobileEventKitAcquisitionTests: XCTestCase {
    typealias A=MobileEventKitAcquisition
    private let human=UUID(uuidString:"50000000-0000-4000-8000-000000000001")!,endpoint=UUID(uuidString:"60000000-0000-4000-8000-000000000001")!,enrollment=UUID(uuidString:"30000000-0000-4000-8000-000000000001")!
    private var ios: URL {URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()}
    private func fixture() throws -> [String:Any] {try XCTUnwrap(JSONSerialization.jsonObject(with:Data(contentsOf:ios.appendingPathComponent("test/mobile-calendar-fixtures/delivery-receipts.json"))) as? [String:Any])}
    private func bytes(_ value: Any) throws -> Data {try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes])}
    private func proof(revision: Int=2,namespace: String?=nil,categories: [String]=["CalendarEvent","Task"],digest: String=String(repeating:"b",count:64)) throws -> MobileCalendarPolicyProof {
        var value=try XCTUnwrap(fixture()["policy"] as? [String:Any]),result=value["result"] as! [String:Any],row=result["enrollment"] as! [String:Any],effective=result["effective"] as! [String:Any]
        row["revision"]=revision;effective["policyRevision"]=revision;effective["categories"]=categories;effective["policyBindingDigest"]=digest
        if let namespace{row["sourceNamespace"]=namespace;effective["sourceNamespace"]=namespace};result["enrollment"]=row;result["effective"]=effective;value["result"]=result
        return try MobileCalendarPolicyParser.parse(bytes(value),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:enrollment)
    }
    private func plan(_ category: String="CalendarEvent",start: TimeInterval=1790812800) -> A.Plan {.init(category:category,selectedContainerIDs:["selected"],mappingVersion:"synthetic-acquisition/1",coverageStart:Date(timeIntervalSince1970:start),coverageEnd:Date(timeIntervalSince1970:start+86400),capturedSDKDefaultTimeZone:TimeZone(secondsFromGMT:0)!)}
    private func clock() -> Date {Date(timeIntervalSince1970:1793404800)}
    private func setup() throws -> (AcquisitionDisk,HealthOutbox,MobileCalendarPolicyProof) {let disk=AcquisitionDisk(),box=HealthOutbox(storage:disk);let proof=try proof();try box.setHuman(human);try box.admitCalendar(proof:proof);return(disk,box,proof)}
    private func getPage(_ core: A,_ box: HealthOutbox,_ proof: MobileCalendarPolicyProof,_ plan: A.Plan, current: @escaping () -> Bool={true},clock: (() throws -> Date)?=nil) throws -> A.Page {
        var result: Result<A.Page,A.Failure>?
        core.acquire(plan:plan,proof:proof,ticket:try box.calendarTicket(enrollment:enrollment,category:plan.category),isCurrent:current,captureClock:clock ?? self.clock){result=$0}
        return try XCTUnwrap(result).get()
    }
    private func drain(_ core: A) {let e=expectation(description:"observable owner retirement");core.whenDrained{e.fulfill()};wait(for:[e],timeout:2);XCTAssertFalse(core.busy)}
    func testEventsAndRemindersUseActualExtractorScanAndFreshTicket() throws {
        for category in ["CalendarEvent","Task"] {
            let(disk,box,proof)=try setup(),store=AcquisitionStore();if category=="Task"{store.inlineBatch=AcquisitionBatch()}
            let core=A(outbox:box,storePort:store,executeOnWorker:{$0()}),page=try getPage(core,box,proof,plan(category))
            let before=disk.writes;try box.confirmCalendarPolicy(proof:proof)
            let ticket=try box.calendarTicket(enrollment:enrollment,category:category),result=core.commit(page:page,reauthorizedProof:proof,ticket:ticket,isCurrent:{true})
            guard case .committed(let count,_)=result else{return XCTFail("commit")};XCTAssertEqual(count,1);XCTAssertEqual(disk.writes,before+2)
            let queued=try box.pendingCalendar(ticket:ticket);XCTAssertEqual(queued.count,1)
            let root=try XCTUnwrap(JSONSerialization.jsonObject(with:queued[0]) as? [String:Any]),change=root["change"] as! [String:Any]
            XCTAssertEqual(change["recordType"] as? String,category);XCTAssertEqual(change["collectedAt"] as? String,"2026-10-31T00:00:00.000Z");XCTAssertEqual(change["operation"] as? String,"upsert");XCTAssertNil(change["deletionEvidence"])
            drain(core)
        }
    }
    func testCaptureClockIsIndependentOfPastAndFutureQueryWindows() throws {
        for start: TimeInterval in [1790812800,1796083200] {
            let(_,box,proof)=try setup(),store=AcquisitionStore(),core=A(outbox:box,storePort:store,executeOnWorker:{$0()}),p=plan(start:start)
            let page=try getPage(core,box,proof,p),ticket=try box.calendarTicket(enrollment:enrollment,category:p.category)
            guard case .committed=core.commit(page:page,reauthorizedProof:proof,ticket:ticket,isCurrent:{true}) else{return XCTFail("independent capture")}
            let scope=try MobileCalendarDelivery.CheckpointScope(collector:"eventKit",namespace:proof.namespace,mappingVersion:p.mappingVersion,coverage:.partial,start:A.timestamp(p.coverageStart),end:A.timestamp(p.coverageEnd))
            let marker=try XCTUnwrap(box.calendarCheckpoint(scope:scope,ticket:ticket)),json=try XCTUnwrap(JSONSerialization.jsonObject(with:marker) as? [String:Any])
            XCTAssertEqual(json["captureStartedAt"] as? String,"2026-10-31T00:00:00.000Z");XCTAssertEqual(json["coverageStart"] as? String,try A.timestamp(p.coverageStart));drain(core)
        }
    }
    func testEventEmpty64AndOverflowBounds() throws {
        for count in [0,64,65] {
            let(disk,box,proof)=try setup(),store=AcquisitionStore();store.events=count;let before=disk.data
            let core=A(outbox:box,storePort:store,executeOnWorker:{$0()})
            var result: Result<A.Page,A.Failure>?
            core.acquire(plan:plan(),proof:proof,ticket:try box.calendarTicket(enrollment:enrollment,category:"CalendarEvent"),isCurrent:{true},captureClock:clock){result=$0}
            if count<=64 {let page=try XCTUnwrap(result).get();guard case .committed(let n,_)=core.commit(page:page,reauthorizedProof:proof,ticket:try box.calendarTicket(enrollment:enrollment,category:"CalendarEvent"),isCurrent:{true}) else{return XCTFail("bounded commit")};XCTAssertEqual(n,count)}
            else {guard case .failure(.truncated)?=result else{return XCTFail("overflow")};XCTAssertEqual(disk.data,before);XCTAssertEqual(store.yields,65)}
            drain(core)
        }
    }
    func testWholeReminderBatchCountBeforeAnyReadAndNilResult() throws {
        for count in [0,64,1000000] {
            let(disk,box,proof)=try setup(),store=AcquisitionStore(),batch=AcquisitionBatch();batch.total=count;store.inlineBatch=batch
            let core=A(outbox:box,storePort:store,executeOnWorker:{$0()}),before=disk.data
            if count<=64 {let page=try getPage(core,box,proof,plan("Task"));guard case .committed(let n,_)=core.commit(page:page,reauthorizedProof:proof,ticket:try box.calendarTicket(enrollment:enrollment,category:"Task"),isCurrent:{true}) else{return XCTFail("Task commit")};XCTAssertEqual(n,count)}
            else {XCTAssertThrowsError(try getPage(core,box,proof,plan("Task")));XCTAssertEqual(batch.reads,0);XCTAssertEqual(disk.data,before)}
            drain(core)
        }
        let(disk,box,proof)=try setup(),store=AcquisitionStore(),core=A(outbox:box,storePort:store,executeOnWorker:{$0()});let before=disk.data;var calls=0
        core.acquire(plan:plan("Task"),proof:proof,ticket:try box.calendarTicket(enrollment:enrollment,category:"Task"),isCurrent:{true},captureClock:clock){result in calls+=1;if case .failure(.incomplete)=result{}else{XCTFail("nil unknown")}}
        store.completion?(nil);XCTAssertEqual(calls,1);XCTAssertEqual(disk.data,before);drain(core)
    }
    func testByteBoundReaderErrorAndContainerMismatchDoNotWritePage() throws {
        for mode in ["bytes","error","container"] {
            let(disk,box,proof)=try setup(),store=AcquisitionStore();store.events=64
            store.event={index in AcquisitionEvent(id:"event-\(index)",container:mode=="container" ? "other":"selected",notes:mode=="bytes" ? String(repeating:"x",count:8192):nil,invalid:mode=="error" && index==1)}
            let core=A(outbox:box,storePort:store,executeOnWorker:{$0()}),before=disk.data
            XCTAssertThrowsError(try getPage(core,box,proof,plan()));XCTAssertEqual(disk.data,before);drain(core)
        }
    }
    func testPermissionAndReentrantCurrentnessChecksFenceReads() throws {
        for permission in [MobileEventKitReadAccess.denied,.restricted,.writeOnly,.unknown] {
            let(disk,box,proof)=try setup(),store=AcquisitionStore();store.permission=permission;let core=A(outbox:box,storePort:store,executeOnWorker:{$0()}),before=disk.data
            XCTAssertThrowsError(try getPage(core,box,proof,plan()));XCTAssertEqual(store.enumerations,0);XCTAssertEqual(disk.data,before)
        }
        let(disk,box,proof)=try setup(),store=AcquisitionStore(),core=A(outbox:box,storePort:store,executeOnWorker:{$0()});var checks=0;let before=disk.data
        XCTAssertThrowsError(try getPage(core,box,proof,plan(),current:{checks+=1;if checks==2{core.cancel()};return true}));XCTAssertEqual(store.enumerations,0);XCTAssertEqual(disk.data,before);drain(core)
    }
    func testInitialAccessReentryCannotStartAnotherQueryOrEscapeCancel() throws {
        let(disk,box,proof)=try setup(),store=AcquisitionStore(),core=A(outbox:box,storePort:store,executeOnWorker:{$0()}),ticket=try box.calendarTicket(enrollment:enrollment,category:"CalendarEvent"),before=disk.data
        store.onAccess={
            core.acquire(plan:self.plan(),proof:proof,ticket:ticket,isCurrent:{true},captureClock:self.clock){result in if case .failure(.busy)=result{}else{XCTFail("reentrant admission busy")}}
            core.cancel()
        }
        XCTAssertThrowsError(try getPage(core,box,proof,plan()));XCTAssertEqual(store.enumerations,0);XCTAssertEqual(disk.data,before);drain(core)
    }
    func testMidReadInvalidationAndAccessLossDiscardWholeScan() throws {
        for invalidation in [true,false] {
            let(disk,box,proof)=try setup(),store=AcquisitionStore();store.events=2;let core=A(outbox:box,storePort:store,executeOnWorker:{$0()}),before=disk.data
            store.event={i in AcquisitionEvent(id:"event-\(i)",onRead:{if invalidation{box.invalidateCalendarPolicy(enrollment:proof.enrollment)}else{store.permission = .denied}})}
            XCTAssertThrowsError(try getPage(core,box,proof,plan()));XCTAssertEqual(disk.data,before);drain(core)
        }
    }
    func testFinalProofChangesCannotRelabelOldPage() throws {
        for newer in [try proof(revision:3),try proof(namespace:UUID().uuidString.lowercased()),try proof(categories:["CalendarEvent"]),try proof(digest:String(repeating:"c",count:64))] {
            let(disk,box,original)=try setup(),store=AcquisitionStore(),core=A(outbox:box,storePort:store,executeOnWorker:{$0()}),page=try getPage(core,box,original,plan()),before=disk.data
            XCTAssertEqual(core.commit(page:page,reauthorizedProof:newer,ticket:try box.calendarTicket(enrollment:enrollment,category:"CalendarEvent"),isCurrent:{true}),.notApplied(.stale));XCTAssertEqual(disk.data,before);drain(core)
        }
    }
    func testFinalExtensibleGuardCannotInvalidateAfterPureCheck() throws {
        let(disk,box,proof)=try setup(),store=AcquisitionStore(),core=A(outbox:box,storePort:store,executeOnWorker:{$0()}),page=try getPage(core,box,proof,plan()),before=disk.data,ticket=try box.calendarTicket(enrollment:enrollment,category:"CalendarEvent")
        XCTAssertEqual(core.commit(page:page,reauthorizedProof:proof,ticket:ticket,isCurrent:{box.invalidateCalendarPolicy(enrollment:proof.enrollment);return true}),.notApplied(.stale));XCTAssertEqual(disk.data,before);drain(core)
    }
    func testWriteThenThrowAndThrowBeforeWriteRemainExactHeldAttempts() throws {
        for saved in [true,false] {
            let(disk,box,proof)=try setup(),store=AcquisitionStore(),core=A(outbox:box,storePort:store,executeOnWorker:{$0()}),page=try getPage(core,box,proof,plan()),ticket=try box.calendarTicket(enrollment:enrollment,category:"CalendarEvent"),before=disk.data
            disk.writeThenThrow=saved;disk.fail = !saved
            let result=core.commit(page:page,reauthorizedProof:proof,ticket:ticket,isCurrent:{true});guard case .unconfirmed=result else{return XCTFail("uncertain invocation")}
            let writes=disk.writes,data=disk.data
            if saved{XCTAssertNotEqual(data,before);XCTAssertEqual(try box.pendingCalendar(ticket:ticket).count,1)}else{XCTAssertEqual(data,before)}
            core.cancel();core.discard(page);XCTAssertEqual(core.commit(page:page,reauthorizedProof:proof,ticket:ticket,isCurrent:{true}),result);XCTAssertEqual(disk.writes,writes);XCTAssertEqual(disk.data,data);XCTAssertTrue(core.busy)
            var retired=false;core.whenDrained{retired=true};RunLoop.main.run(until:Date(timeIntervalSinceNow:0.02));XCTAssertFalse(retired)
        }
    }
    func testCheckpointCASFailureIsConservativelyHeldAfterInvocation() throws {
        let(_,box,proof)=try setup(),store=AcquisitionStore(),core=A(outbox:box,storePort:store,executeOnWorker:{$0()}),p=plan(),page=try getPage(core,box,proof,p),ticket=try box.calendarTicket(enrollment:enrollment,category:"CalendarEvent")
        let scope=try MobileCalendarDelivery.CheckpointScope(collector:"eventKit",namespace:proof.namespace,mappingVersion:p.mappingVersion,coverage:.partial,start:A.timestamp(p.coverageStart),end:A.timestamp(p.coverageEnd))
        try box.commitCalendar(scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([8]),items:[],ticket:ticket)
        guard case .unconfirmed=core.commit(page:page,reauthorizedProof:proof,ticket:ticket,isCurrent:{true}) else{return XCTFail("no exposed write stage")};XCTAssertEqual(try box.calendarCheckpoint(scope:scope,ticket:ticket),Data([8]));XCTAssertTrue(core.busy)
    }
    func testLateTokenInstallAndSuppressedCompletionRetireOnlyAfterReturn() throws {
        let(_,box,proof)=try setup(),store=AcquisitionStore(),core=A(outbox:box,storePort:store,executeOnWorker:{$0()});var retired=false,calls=0
        store.onFetch={core.cancel();core.whenDrained{retired=true};XCTAssertFalse(retired);XCTAssertTrue(core.busy);XCTAssertEqual(store.cancels,0)}
        core.acquire(plan:plan("Task"),proof:proof,ticket:try box.calendarTicket(enrollment:enrollment,category:"Task"),isCurrent:{true},captureClock:clock){_ in calls+=1}
        XCTAssertEqual(store.cancels,1);XCTAssertEqual(calls,1);drain(core);XCTAssertTrue(retired)
    }
    func testAlreadyEnteredCallbackRetiresOnlyAfterBodyExit() throws {
        let(_,box,proof)=try setup(),store=AcquisitionStore(),core=A(outbox:box,storePort:store,executeOnWorker:{$0()}),batch=AcquisitionBatch();var retired=false
        core.acquire(plan:plan("Task"),proof:proof,ticket:try box.calendarTicket(enrollment:enrollment,category:"Task"),isCurrent:{true},captureClock:clock){_ in}
        batch.onRead={core.cancel();core.whenDrained{retired=true};XCTAssertFalse(retired);XCTAssertTrue(core.busy)}
        store.completion?(batch);drain(core);XCTAssertTrue(retired)
    }
    func testDiscardAfterQueryRetirementStartsNoNewCancelWork() throws {
        let(_,box,proof)=try setup(),store=AcquisitionStore();store.inlineBatch=AcquisitionBatch()
        let core=A(outbox:box,storePort:store,executeOnWorker:{$0()}),page=try getPage(core,box,proof,plan("Task"))
        let turn=expectation(description:"query callback retirement delivery");DispatchQueue.main.async{turn.fulfill()};wait(for:[turn],timeout:2)
        core.discard(page);drain(core);XCTAssertEqual(store.cancels,0)
    }
    func testReentrantCaptureClockCancelsBeforeReadingRecord() throws {
        let(disk,box,proof)=try setup(),store=AcquisitionStore(),core=A(outbox:box,storePort:store,executeOnWorker:{$0()}),before=disk.data;var ticks=0,reads=0
        store.event={_ in AcquisitionEvent(onRead:{reads+=1})}
        XCTAssertThrowsError(try getPage(core,box,proof,plan(),clock:{ticks+=1;if ticks==2{core.cancel()};return self.clock()}))
        XCTAssertEqual(reads,0);XCTAssertEqual(disk.data,before);drain(core)
    }
    func testHeldWorkerDoesNotFabricateRetirementOrPermitAnotherRun() throws {
        let(_,box,proof)=try setup(),store=AcquisitionStore();var work:[()->Void]=[];let core=A(outbox:box,storePort:store,executeOnWorker:{work.append($0)});var calls=0,retired=false
        let ticket=try box.calendarTicket(enrollment:enrollment,category:"CalendarEvent")
        core.acquire(plan:plan(),proof:proof,ticket:ticket,isCurrent:{true},captureClock:clock){_ in calls+=1};core.cancel();core.whenDrained{retired=true}
        XCTAssertTrue(core.busy);XCTAssertFalse(retired);XCTAssertEqual(calls,1)
        core.acquire(plan:plan(),proof:proof,ticket:ticket,isCurrent:{true},captureClock:clock){result in if case .failure(.busy)=result{}else{XCTFail("busy")}}
        XCTAssertEqual(work.count,1);work.removeFirst()();drain(core);XCTAssertTrue(retired);XCTAssertEqual(store.enumerations,0)
    }
    func testDuplicateReminderCompletionCannotMutatePublishedPage() throws {
        let(_,box,proof)=try setup(),store=AcquisitionStore(),core=A(outbox:box,storePort:store,executeOnWorker:{$0()});var page:A.Page?,calls=0
        core.acquire(plan:plan("Task"),proof:proof,ticket:try box.calendarTicket(enrollment:enrollment,category:"Task"),isCurrent:{true},captureClock:clock){result in calls+=1;page=try? result.get()}
        let completion=store.completion;completion?(AcquisitionBatch());completion?(AcquisitionBatch())
        XCTAssertEqual(calls,1);let ticket=try box.calendarTicket(enrollment:enrollment,category:"Task")
        guard case .committed(let count,_)=core.commit(page:try XCTUnwrap(page),reauthorizedProof:proof,ticket:ticket,isCurrent:{true}) else{return XCTFail("commit once")};XCTAssertEqual(count,1);drain(core)
    }
    func testInvalidAndBackwardCaptureClockRejectWithoutBackdating() throws {
        for invalid in [Date(timeIntervalSince1970:.infinity),clock().addingTimeInterval(0.0005)] {
            let(disk,box,proof)=try setup(),store=AcquisitionStore(),core=A(outbox:box,storePort:store,executeOnWorker:{$0()}),before=disk.data
            XCTAssertThrowsError(try getPage(core,box,proof,plan(),clock:{invalid}));XCTAssertEqual(disk.data,before);XCTAssertEqual(store.enumerations,0);drain(core)
        }
        let(_,box,proof)=try setup(),store=AcquisitionStore(),core=A(outbox:box,storePort:store,executeOnWorker:{$0()});var n=0
        XCTAssertThrowsError(try getPage(core,box,proof,plan(),clock:{n+=1;return self.clock().addingTimeInterval(n==1 ? 1:0)}));drain(core)
    }
    func testActualBridgeBackgroundWorkerAndCallbacksUseOwnerQueue() throws {
        for category in ["CalendarEvent","Task"] {
            let(_,box,proof)=try setup(),store=AcquisitionStore();if category=="Task"{store.inlineBatch=AcquisitionBatch()}
            let core=A(outbox:box,storePort:store,executeOnWorker:{work in DispatchQueue.global().async{work()}})
            let ready=expectation(description:"actual background bridge");var page:A.Page?
            core.acquire(plan:plan(category),proof:proof,ticket:try box.calendarTicket(enrollment:enrollment,category:category),isCurrent:{XCTAssertTrue(Thread.isMainThread);return true},captureClock:clock){result in XCTAssertTrue(Thread.isMainThread);page=try? result.get();ready.fulfill()}
            wait(for:[ready],timeout:2)
            guard case .committed(let count,_)=core.commit(page:try XCTUnwrap(page),reauthorizedProof:proof,ticket:try box.calendarTicket(enrollment:enrollment,category:category),isCurrent:{true}) else{return XCTFail("background commit")}
            XCTAssertEqual(count,1);drain(core)
        }
    }
    func testSynchronousStoreThrowsRetireWithoutPageOrCheckpoint() throws {
        for category in ["CalendarEvent","Task"] {
            let(disk,box,proof)=try setup(),store=AcquisitionStore();store.throwQuery=true
            let core=A(outbox:box,storePort:store,executeOnWorker:{$0()}),before=disk.data
            XCTAssertThrowsError(try getPage(core,box,proof,plan(category)));XCTAssertEqual(disk.data,before);drain(core)
        }
    }
    func testReminderCallbackBeforeThrowCannotPublishPage() throws {
        let(disk,box,proof)=try setup(),store=AcquisitionStore();store.inlineBatch=AcquisitionBatch();store.throwAfterCallback=true
        let core=A(outbox:box,storePort:store,executeOnWorker:{$0()}),before=disk.data
        XCTAssertThrowsError(try getPage(core,box,proof,plan("Task")),"success callback cannot publish a Page before fetch handle installation succeeds")
        XCTAssertEqual(disk.data,before);core.cancel();drain(core)
    }
    func testOneShotCompletionReleasesCapturedContextWhilePageIsHeld() throws {
        let(_,box,proof)=try setup(),store=AcquisitionStore();store.inlineBatch=AcquisitionBatch()
        let core=A(outbox:box,storePort:store,executeOnWorker:{$0()});var page:A.Page?
        var capture:AcquisitionCallbackCapture?=AcquisitionCallbackCapture();weak var tracked=capture
        core.acquire(plan:plan("Task"),proof:proof,ticket:try box.calendarTicket(enrollment:enrollment,category:"Task"),isCurrent:{true},captureClock:clock){[owned=capture!] result in _=owned;page=try? result.get()}
        capture=nil;XCTAssertNil(tracked,"consumed completion context is released even while opaque page waits for authorization")
        core.discard(try XCTUnwrap(page));drain(core)
    }
    func testCompletedFacadeIsNotRetainedByQueryCallbackCycles() throws {
        let(_,box,proof)=try setup(),store=AcquisitionStore();store.inlineBatch=AcquisitionBatch()
        var core:A?=A(outbox:box,storePort:store,executeOnWorker:{$0()});weak var observed=core
        var page:A.Page?=try getPage(core!,box,proof,plan("Task"))
        guard case .committed=core!.commit(page:page!,reauthorizedProof:proof,ticket:try box.calendarTicket(enrollment:enrollment,category:"Task"),isCurrent:{true}) else{return XCTFail("commit")}
        drain(core!);page=nil;core=nil
        let turn=expectation(description:"completion stack returned");DispatchQueue.main.async{turn.fulfill()};wait(for:[turn],timeout:2)
        XCTAssertNil(observed,"retained SDK callback must not retain completed facade or raw page")
    }
    func testCoreDrainObserverCannotAdmitHeldWorkBeforeRemainingObservers() throws {
        let(_,box,proof)=try setup(),store=AcquisitionStore();var hold=false,work:[()->Void]=[],denials=0
        let core=A(outbox:box,storePort:store,executeOnWorker:{block in if hold{work.append(block)}else{block()}}),p=plan(),page=try getPage(core,box,proof,plan()),ticket=try box.calendarTicket(enrollment:enrollment,category:"CalendarEvent")
        guard case .committed=core.commit(page:page,reauthorizedProof:proof,ticket:ticket,isCurrent:{true}) else{return XCTFail("initial commit")}
        let notified=expectation(description:"remaining original drain observer")
        core.whenDrained{
            hold=true
            core.acquire(plan:p,proof:proof,ticket:ticket,isCurrent:{true},captureClock:self.clock){result in if case .failure(.busy)=result{denials+=1}}
        }
        core.whenDrained{XCTAssertFalse(core.busy,"remaining original drain observer cannot authorize replacement while a new run is held");notified.fulfill()}
        wait(for:[notified],timeout:2)
        XCTAssertEqual(denials,1,"admission is fenced throughout drain publication");XCTAssertEqual(work.count,0)
        core.cancel();while !work.isEmpty{work.removeFirst()()};drain(core)
    }
    func testActualSharedSnapshotHealthAndSharePreservation() throws {
        let disk=AcquisitionDisk(),authority=AcquisitionShareAuthority(),box=HealthOutbox(storage:disk,shareAuthority:authority),p=try proof();try box.setHuman(human)
        let healthEnrollment=UUID(uuidString:"00000000-0000-4000-8000-000000000002")!,healthNamespace=UUID().uuidString.lowercased()
        let configuration:[String:Any]=["categories":["SleepSegment"],"uses":[],"assistantIds":[],"collectionPaused":false,"usePaused":false]
        let health:[String:Any]=["schemaVersion":"1.0.0","producerPin":["schemaId":MobileHealthEncoder.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthEncoder.schemaSHA256],"result":["enrollment":["enrollmentId":healthEnrollment.uuidString.lowercased(),"principalId":human.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":healthNamespace,"revision":1,"state":"active","configuration":configuration],"effective":["policyRevision":1,"sourceBound":true,"collectionAllowed":true,"categories":["SleepSegment"],"uses":[],"assistantIds":[],"sourceNamespace":healthNamespace]]]
        let hp=try MobileHealthPolicyParser.parse(bytes(health),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:healthEnrollment);try box.enroll(proof:hp,selectedTypes:["sleep"]);let ht=try box.ticket(enrollment:healthEnrollment,type:"sleep")
        try box.commit(scope:"synthetic-health",expectedAnchor:nil,nextAnchor:Data([7]),changes:[HealthChange(upstreamId:"synthetic",operation:.delete,body:nil,collectedAt:clock(),expectedPolicyRevision:1,mappingVersion:"healthkit-v1")],ticket:ht)
        try box.admitCalendar(proof:p)
        let rawText=try String(contentsOf:ios.appendingPathComponent("test/mobile-shared-item-fixtures/shared-item-pairs.json"),encoding:.utf8).replacingOccurrences(of:"\\ud800",with:"__UNPAIRED__"),raw=try XCTUnwrap(JSONSerialization.jsonObject(with:Data(rawText.utf8)) as? [String:Any]),pairs=raw["pairs"] as! [[String:Any]]
        var item=pairs.first{$0["case"] as? String=="file-reference"}!["ios"] as! [String:Any],content=item["content"] as! [String:Any],artifact=content["artifact"] as! [String:Any];let shared=Data([0,1,2,3,255]);artifact["byteLength"]=shared.count;artifact["sha256"]=SHA256.hash(data:shared).map{String(format:"%02x",$0)}.joined();content["artifact"]=artifact;item["content"]=content
        let itemBytes=try bytes(item),value=try MobileSharedItem.decode(itemBytes),context=OutboxShareContext(owner:box,human:human,endpoint:endpoint,namespace:value.source.namespace,collector:value.source.collector,epoch:1,recoveryOnly:false)
        guard case .portAcknowledged=MobileSharedCapture.capture(itemJSON:itemBytes,attempt:OutboxShareAttempt(UUID(),context:context),lease:AcquisitionShareLease(context,shared),owner:box) else{return XCTFail("real synthetic share seed")}
        // A successful shared save invalidates Calendar proof generation; actual refresh restores it.
        try box.confirmCalendarPolicy(proof:p)
        let newAttempt=OutboxShareAttempt(UUID(),context:context),payloadDigest=SHA256.hash(data:itemBytes).map{String(format:"%02x",$0)}.joined()
        guard case .reserved(let reservation,_)=try box.reserve(attempt:newAttempt,payloadDigest:payloadDigest,item:value,context:context) else{return XCTFail("active synthetic Share reservation")}
        XCTAssertNoThrow(try box.check(reservation))
        let before=try XCTUnwrap(JSONSerialization.jsonObject(with:XCTUnwrap(disk.data)) as? [String:Any]),store=AcquisitionStore(),core=A(outbox:box,storePort:store,executeOnWorker:{$0()}),page=try getPage(core,box,p,plan()),ticket=try box.calendarTicket(enrollment:enrollment,category:"CalendarEvent")
        guard case .committed=core.commit(page:page,reauthorizedProof:p,ticket:ticket,isCurrent:{true}) else{return XCTFail("same outbox")}
        let after=try XCTUnwrap(JSONSerialization.jsonObject(with:XCTUnwrap(disk.data)) as? [String:Any])
        XCTAssertThrowsError(try box.check(reservation),"existing snapshot save invalidates active Share reservation, not its persisted associations")
        XCTAssertEqual(try bytes(before["enrollments"]!),try bytes(after["enrollments"]!));XCTAssertEqual(try bytes(before["shareAssociations"]!),try bytes(after["shareAssociations"]!));XCTAssertEqual(try box.anchor(for:"synthetic-health",ticket:ht),Data([7]));drain(core)
    }
}
