import Foundation
import XCTest
@testable import AssistantCore
private final class ScanMemory: HealthSnapshotStorage {var bytes:Data?;var fail=false;func read()throws->Data?{bytes};func replace(_ d:Data)throws{if fail{throw CocoaError(.fileWriteNoPermission)};bytes=d}}
final class MobileCalendarScanControllerTests:XCTestCase {
    private func proof()throws->MobileCalendarPolicyProof {
        let ios=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent(),data=try Data(contentsOf:ios.appendingPathComponent("test/mobile-calendar-fixtures/delivery-receipts.json")),root=try XCTUnwrap(JSONSerialization.jsonObject(with:data) as? [String:Any]),policy=try JSONSerialization.data(withJSONObject:XCTUnwrap(root["policy"]))
        let scan=try XCTUnwrap(JSONSerialization.jsonObject(with:Data(contentsOf:ios.appendingPathComponent("test/mobile-calendar-fixtures/eventkit-scan.json"))) as? [String:Any]);XCTAssertEqual(scan["syntheticOnly"] as? Bool,true)
        let principal=try XCTUnwrap(UUID(uuidString:XCTUnwrap(scan["principalId"] as? String))),endpoint=try XCTUnwrap(UUID(uuidString:XCTUnwrap(scan["endpointId"] as? String))),enrollment=try XCTUnwrap(UUID(uuidString:XCTUnwrap(scan["enrollmentId"] as? String)))
        let parsed=try MobileCalendarPolicyParser.parse(policy,expectedPrincipal:principal,expectedEndpoint:endpoint,expectedEnrollment:enrollment)
        XCTAssertEqual(parsed.namespace,UUID(uuidString:try XCTUnwrap(scan["namespace"] as? String)));return parsed
    }
    private func scope(_ p:MobileCalendarPolicyProof)throws->MobileCalendarDelivery.CheckpointScope {try .init(collector:p.collector,namespace:p.namespace,mappingVersion:"synthetic-calendar-mapping/1",coverage:.partial,start:"2026-10-01T00:00:00Z",end:"2026-11-01T00:00:00Z")}
    private func candidate(_ p:MobileCalendarPolicyProof)throws->MobileCalendarScanController.Candidate {
        let source=try MobileCalendarMapping.Source(platform:.eventKit,namespace:p.namespace,containerID:"synthetic",localID:"item",accountID:nil,externalID:nil,revision:nil),event=try MobileCalendarMapping.Event(source:source,time:.allDay(start:"2026-10-30",endExclusive:"2026-10-31"),occurrence:nil,recurrence:.none,status:.confirmed,alarmOffsetsSeconds:nil),e=MobileEventKitAdapter.Envelope(eventId:UUID(),enrollmentId:p.enrollment,policyRevision:p.revision,mappingVersion:"synthetic-calendar-mapping/1",collectedAt:Date(timeIntervalSince1970:1793318400),identityScope:.unknown)
        return .init(observation:.event(event),envelope:e)
    }
    func testPartialScopeCompletePageCommitsAtomicallyAndRestart()throws {
        let p=try proof(),disk=ScanMemory(),outbox=HealthOutbox(storage:disk);try outbox.setHuman(p.principal);try outbox.admitCalendar(proof:p);let ticket=try outbox.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"),scope=try scope(p),value=try candidate(p),controller=MobileCalendarScanController(outbox:outbox),g=controller.begin()
        try controller.commit(generation:g,state:.complete,scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([1]),candidates:[value],ticket:ticket)
        let restart=HealthOutbox(storage:disk);try restart.setHuman(p.principal);try restart.confirmCalendarPolicy(proof:p);let t=try restart.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent")
        XCTAssertEqual(try restart.pendingCalendar(ticket:t),[try MobileEventKitAdapter.item(value.observation,envelope:value.envelope).data]);XCTAssertEqual(try restart.calendarCheckpoint(scope:scope,ticket:t),Data([1]))
        let next=MobileCalendarScanController(outbox:restart),g2=next.begin();try next.commit(generation:g2,state:.complete,scope:scope,expectedCheckpoint:Data([1]),nextCheckpoint:Data([2]),candidates:[],ticket:t);XCTAssertEqual(try restart.pendingCalendar(ticket:t),[try MobileEventKitAdapter.item(value.observation,envelope:value.envelope).data])
    }
    func testIncompletePagesCancellationAndWriteFailureDoNotAdvance()throws {
        let p=try proof(),disk=ScanMemory(),outbox=HealthOutbox(storage:disk);try outbox.setHuman(p.principal);try outbox.admitCalendar(proof:p);let ticket=try outbox.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"),scope=try scope(p),value=try candidate(p),controller=MobileCalendarScanController(outbox:outbox),g=controller.begin(),before=try XCTUnwrap(disk.bytes)
        for state:MobileCalendarScanController.PageState in [.interrupted,.truncated,.unknown,.denied] {XCTAssertThrowsError(try controller.commit(generation:g,state:state,scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([1]),candidates:[value],ticket:ticket));XCTAssertEqual(disk.bytes,before)}
        let unknownScope=try MobileCalendarDelivery.CheckpointScope(collector:p.collector,namespace:p.namespace,mappingVersion:"synthetic-calendar-mapping/1",coverage:.unknown,start:"2026-10-01T00:00:00Z",end:"2026-11-01T00:00:00Z")
        XCTAssertThrowsError(try controller.commit(generation:g,state:.complete,scope:unknownScope,expectedCheckpoint:nil,nextCheckpoint:Data([1]),candidates:[value],ticket:ticket));XCTAssertEqual(disk.bytes,before)
        let source=try MobileCalendarMapping.Source(platform:.eventKit,namespace:p.namespace,containerID:"synthetic",localID:"bad",accountID:nil,externalID:nil,revision:nil),badEvent=try MobileCalendarMapping.Event(source:source,time:.allDay(start:"2026-10-30",endExclusive:"2026-10-31"),occurrence:.init(original:.unknown,detached:true),recurrence:.unknown,status:.unknown,alarmOffsetsSeconds:nil),bad=MobileCalendarScanController.Candidate(observation:.event(badEvent),envelope:value.envelope)
        XCTAssertThrowsError(try controller.commit(generation:g,state:.complete,scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([1]),candidates:[value,bad],ticket:ticket));XCTAssertEqual(disk.bytes,before)
        XCTAssertThrowsError(try controller.commit(generation:g,state:.complete,scope:scope,expectedCheckpoint:Data([99]),nextCheckpoint:Data([1]),candidates:[value],ticket:ticket));XCTAssertEqual(disk.bytes,before)
        controller.cancel();XCTAssertThrowsError(try controller.commit(generation:g,state:.complete,scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([1]),candidates:[value],ticket:ticket));XCTAssertEqual(disk.bytes,before)
        let next=controller.begin();disk.fail=true;XCTAssertThrowsError(try controller.commit(generation:next,state:.complete,scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([1]),candidates:[value],ticket:ticket));XCTAssertEqual(disk.bytes,before)
    }
    func testStalePolicyAccountScopeAndCapacityFailClosed()throws {
        let p=try proof(),disk=ScanMemory(),outbox=HealthOutbox(storage:disk);try outbox.setHuman(p.principal);try outbox.admitCalendar(proof:p);let ticket=try outbox.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"),scope=try scope(p),value=try candidate(p),controller=MobileCalendarScanController(outbox:outbox,maxItems:1),g=controller.begin(),before=try XCTUnwrap(disk.bytes)
        XCTAssertThrowsError(try controller.commit(generation:g,state:.complete,scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([1]),candidates:[value,value],ticket:ticket));XCTAssertEqual(disk.bytes,before)
        outbox.invalidateCalendarPolicy(enrollment:p.enrollment);XCTAssertThrowsError(try controller.commit(generation:g,state:.complete,scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([1]),candidates:[value],ticket:ticket));XCTAssertEqual(disk.bytes,before)
        try outbox.confirmCalendarPolicy(proof:p);let current=try outbox.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent");try outbox.setHuman(UUID());let after=try XCTUnwrap(disk.bytes);XCTAssertThrowsError(try controller.commit(generation:g,state:.complete,scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([1]),candidates:[value],ticket:current));XCTAssertEqual(disk.bytes,after)
    }
    func testMixedPageOverlongRecurrenceDoesNotAdvanceOrCommit()throws {
        let p=try proof(),disk=ScanMemory(),outbox=HealthOutbox(storage:disk);try outbox.setHuman(p.principal);try outbox.admitCalendar(proof:p)
        let ticket=try outbox.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"),scope=try scope(p),good=try candidate(p),controller=MobileCalendarScanController(outbox:outbox),g=controller.begin(),before=try XCTUnwrap(disk.bytes)
        let source=try MobileCalendarMapping.Source(platform:.eventKit,namespace:p.namespace,containerID:"synthetic",localID:"invalid-recurrence",accountID:nil,externalID:nil,revision:nil),event=try MobileCalendarMapping.Event(source:source,time:.allDay(start:"2026-10-30",endExclusive:"2026-10-31"),occurrence:nil,recurrence:.observedNativeRule(String(repeating:"x",count:4097)),status:.unknown,alarmOffsetsSeconds:nil),envelope=MobileEventKitAdapter.Envelope(eventId:UUID(),enrollmentId:p.enrollment,policyRevision:p.revision,mappingVersion:"synthetic-calendar-mapping/1",collectedAt:Date(timeIntervalSince1970:1793318400),identityScope:.unknown),invalid=MobileCalendarScanController.Candidate(observation:.event(event),envelope:envelope)
        XCTAssertThrowsError(try controller.commit(generation:g,state:.complete,scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([1]),candidates:[good,invalid],ticket:ticket))
        XCTAssertEqual(disk.bytes,before);XCTAssertNil(try outbox.calendarCheckpoint(scope:scope,ticket:ticket));XCTAssertEqual(try outbox.pendingCalendar(ticket:ticket),[])
    }
}
