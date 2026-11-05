import Foundation
import XCTest
@testable import AssistantCore
final class MobileEventKitAdapterTests: XCTestCase {
    typealias M = MobileCalendarMapping
    func source() throws -> M.Source {try .init(platform:.eventKit,namespace:UUID(uuidString:"10000000-0000-4000-8000-000000000001")!,containerID:"synthetic-calendar",localID:"local-1",accountID:nil,externalID:"observed-external",revision:nil)}
    func envelope() -> MobileEventKitAdapter.Envelope {.init(eventId:UUID(),enrollmentId:UUID(uuidString:"30000000-0000-4000-8000-000000000001")!,policyRevision:2,mappingVersion:"synthetic-calendar-mapping/1",collectedAt:Date(timeIntervalSince1970:1793318400),identityScope:.unknown)}
    func object(_ d:Data)throws->[String:Any] {try XCTUnwrap(JSONSerialization.jsonObject(with:d) as? [String:Any])}
    func testCancelledMovedEventKeepsOccurrenceAndScopedIdentity()throws {
        let original=try M.LocalDateTime(date:"2026-11-01",hour:9,minute:0,second:0),start=try M.LocalDateTime(date:"2026-11-01",hour:11,minute:0,second:0),end=try M.LocalDateTime(date:"2026-11-01",hour:12,minute:0,second:0)
        let event=try M.Event(source:source(),time:.validatedFloating(start:start,end:end),occurrence:.init(original:.floating(original),detached:true,seriesUpstreamID:"observed-series"),recurrence:.unknown,status:.cancelled,alarmOffsetsSeconds:nil,title:"Synthetic")
        let item=try MobileEventKitAdapter.item(.event(event),envelope:envelope()),root=try object(item.data),change=try XCTUnwrap(root["change"] as? [String:Any]),record=try XCTUnwrap(change["record"] as? [String:Any]),source=try XCTUnwrap(change["source"] as? [String:Any]),locator=try XCTUnwrap(root["locator"] as? [String:Any])
        XCTAssertEqual(change["operation"] as? String,"upsert");XCTAssertEqual(record["status"] as? String,"cancelled");XCTAssertEqual(source["upstreamId"] as? String,"local-1");XCTAssertEqual(source["upstreamIdentityScope"] as? String,"unknown");XCTAssertTrue(source["upstreamRevision"] is NSNull);XCTAssertEqual(locator["kind"] as? String,"occurrence");XCTAssertEqual((locator["originalStart"] as? [String:Any])?["local"] as? String,"2026-11-01T09:00:00")
    }
    func testReminderAndOnlyExplicitTypedTombstone()throws {
        let task=try M.Task(source:source(),due:.unknown,completion:.completed(at:nil),recurrence:.unknown),item=try MobileEventKitAdapter.item(.reminder(task),envelope:envelope()),change=try XCTUnwrap(object(item.data)["change"] as? [String:Any])
        XCTAssertEqual(change["recordType"] as? String,"Task");XCTAssertEqual((change["record"] as? [String:Any]).flatMap{$0["completion"] as? [String:Any]}?["state"] as? String,"completed")
        let tombstone=try MobileEventKitAdapter.item(.explicitDeletion(source:source(),kind:.calendarEvent,locator:.occurrence(.civilDate(try XCTUnwrap(MobileCalendarDate("2026-11-01"))))),envelope:envelope())
        let deleted=try XCTUnwrap(object(tombstone.data)["change"] as? [String:Any]);XCTAssertEqual(deleted["operation"] as? String,"delete");XCTAssertEqual(deleted["deletionEvidence"] as? String,"explicitProviderTombstone");XCTAssertNil(deleted["record"])
        XCTAssertThrowsError(try MobileEventKitAdapter.item(.explicitDeletion(source:source(),kind:.calendarEvent,locator:.occurrence(.unknown)),envelope:envelope()))
    }
    func testUnrepresentableOccurrenceAndPrecisionFailClosed()throws {
        let time=try M.EventTime.allDay(start:"2026-11-01",endExclusive:"2026-11-02"),event=try M.Event(source:source(),time:time,occurrence:.init(original:.unknown,detached:true),recurrence:.unknown,status:.unknown,alarmOffsetsSeconds:nil)
        XCTAssertThrowsError(try MobileEventKitAdapter.item(.event(event),envelope:envelope()))
        let bad=MobileEventKitAdapter.Envelope(eventId:UUID(),enrollmentId:UUID(),policyRevision:1,mappingVersion:"v1",collectedAt:Date(timeIntervalSince1970:0.0005),identityScope:.unknown)
        let task=try M.Task(source:source(),due:.unknown,completion:.unknown,recurrence:.unknown);XCTAssertThrowsError(try MobileEventKitAdapter.item(.reminder(task),envelope:bad))
    }
    func testDirectOverlongRecurrenceRejectedForEventAndReminder()throws {
        let recurrence=M.Recurrence.observedNativeRule(String(repeating:"x",count:4097)),time=try M.EventTime.allDay(start:"2026-11-01",endExclusive:"2026-11-02")
        let event=try M.Event(source:source(),time:time,occurrence:nil,recurrence:recurrence,status:.unknown,alarmOffsetsSeconds:nil),task=try M.Task(source:source(),due:.unknown,completion:.unknown,recurrence:recurrence)
        XCTAssertThrowsError(try MobileEventKitAdapter.item(.event(event),envelope:envelope()))
        XCTAssertThrowsError(try MobileEventKitAdapter.item(.reminder(task),envelope:envelope()))
        let unicode=M.Recurrence.observedNativeRule(String(repeating:"e\u{301}",count:2049)),unicodeTask=try M.Task(source:source(),due:.unknown,completion:.unknown,recurrence:unicode)
        XCTAssertThrowsError(try MobileEventKitAdapter.item(.reminder(unicodeTask),envelope:envelope()))
        let boundary=M.Recurrence.observedNativeRule(String(repeating:"e\u{301}",count:2048)),boundaryTask=try M.Task(source:source(),due:.unknown,completion:.unknown,recurrence:boundary)
        XCTAssertNoThrow(try MobileEventKitAdapter.item(.reminder(boundaryTask),envelope:envelope()))
    }
}
