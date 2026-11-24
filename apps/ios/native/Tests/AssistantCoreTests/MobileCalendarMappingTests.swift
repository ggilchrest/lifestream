import Foundation
import XCTest
@testable import AssistantCore
final class MobileCalendarMappingTests:XCTestCase {
    typealias M = MobileCalendarMapping
    func source(_ platform:M.Platform,namespace:UUID=UUID(),container:String="calendar",local:String="item",external:String?=nil)throws->M.Source {try M.Source(platform:platform,namespace:namespace,containerID:container,localID:local,accountID:nil,externalID:external,revision:nil)}
    func testAllDayCivilRangeAndFloatingRemainDistinctFromInstants() throws {
        let allDay=try M.EventTime.allDay(start:"2026-11-01",endExclusive:"2026-11-02")
        if case .allDay(let range)=allDay {XCTAssertEqual(range.start.text,"2026-11-01");XCTAssertEqual(range.endExclusive.text,"2026-11-02")} else {XCTFail("must remain date range")}
        XCTAssertThrowsError(try M.EventTime.allDay(start:"2026-02-29",endExclusive:"2026-03-01"))
        let a=try M.LocalDateTime(date:"2026-11-01",hour:1,minute:10,second:0),b=try M.LocalDateTime(date:"2026-11-01",hour:1,minute:50,second:0)
        if case .floating(let start,let end)=try M.EventTime.validatedFloating(start:a,end:b) {XCTAssertEqual(start,a);XCTAssertEqual(end,b)} else {XCTFail("must remain floating")}
        let start=Date(timeIntervalSince1970:1793513400),end=Date(timeIntervalSince1970:1793517000)
        if case .instants(_,_,let zone)=try M.EventTime.instants(start:start,end:end,sourceZone:nil) {XCTAssertEqual(zone,.unknown)} else {XCTFail("must remain instants")}
        XCTAssertThrowsError(try M.EventTime.instants(start:end,end:start,sourceZone:nil))
        XCTAssertThrowsError(try M.EventTime.instants(start:Date(timeIntervalSince1970:0.0005),end:Date(timeIntervalSince1970:1),sourceZone:nil))
        XCTAssertThrowsError(try M.EventTime.instants(start:Date(timeIntervalSince1970:0.0000005),end:Date(timeIntervalSince1970:1),sourceZone:nil))
        XCTAssertNoThrow(try M.EventTime.instants(start:Date(timeIntervalSince1970:0.001),end:Date(timeIntervalSince1970:1.001),sourceZone:nil))
        XCTAssertNoThrow(try M.EventTime.instants(start:Date(timeIntervalSince1970:1793513400.123),end:Date(timeIntervalSince1970:1793517000.456),sourceZone:nil))
    }
    func testDetachedOccurrenceAndExplicitCancellationRemainIndependent()throws {
        let original=try M.LocalDateTime(date:"2026-03-08",hour:9,minute:0,second:0),moved=try M.LocalDateTime(date:"2026-03-08",hour:11,minute:0,second:0),end=try M.LocalDateTime(date:"2026-03-08",hour:12,minute:0,second:0)
        let event=try M.Event(source:source(.eventKit),time:M.EventTime.validatedFloating(start:moved,end:end),occurrence:.init(original:.floating(original),detached:true),recurrence:try .observed("FREQ=WEEKLY"),status:.cancelled,alarmOffsetsSeconds:[-900])
        XCTAssertEqual(event.occurrence?.original,.floating(original));XCTAssertEqual(event.status,.cancelled);XCTAssertEqual(event.alarmOffsetsSeconds,[-900])
        XCTAssertNotEqual(M.Recurrence.none,M.Recurrence.unknown)
    }
    func testTaskDueAndCompletionDoNotInventTimeOrStatus()throws {
        let date=try XCTUnwrap(MobileCalendarDate("2026-10-30")),task=try M.Task(source:source(.googleTasks),due:.date(date),completion:.unknown,recurrence:.unknown)
        if case .date(let day)=task.due {XCTAssertEqual(day.text,"2026-10-30")} else {XCTFail("task due is date only")}
        let partial=try M.DueComponents(year:nil,month:10,day:30,hour:nil,minute:nil,second:nil,sourceZone:nil)
        XCTAssertNil(partial.year);XCTAssertNil(partial.hour);XCTAssertEqual(partial.sourceZone,.unknown)
        XCTAssertThrowsError(try M.DueComponents(year:2026,month:2,day:29,hour:nil,minute:nil,second:nil,sourceZone:nil,calendarIdentifier:"gregorian"))
        XCTAssertNotEqual(M.Completion.unknown,.incomplete)
        XCTAssertThrowsError(try M.DueComponents(year:nil,month:2,day:30,hour:nil,minute:nil,second:nil,sourceZone:nil,calendarIdentifier:"gregorian"))
        let hebrew=try M.DueComponents(year:5786,month:13,day:1,hour:nil,minute:nil,second:nil,sourceZone:nil,calendarIdentifier:"hebrew")
        XCTAssertEqual(hebrew.month,13);XCTAssertEqual(hebrew.calendarIdentifier,"hebrew")
        let unknown=try M.DueComponents(year:nil,month:13,day:nil,hour:nil,minute:nil,second:nil,sourceZone:nil)
        XCTAssertEqual(unknown.month,13);XCTAssertNil(unknown.calendarIdentifier)
        XCTAssertThrowsError(try M.DueComponents(year:nil,month:13,day:nil,hour:nil,minute:nil,second:nil,sourceZone:nil,calendarIdentifier:"gregorian"))
        XCTAssertThrowsError(try M.DueComponents(year:nil,month:14,day:nil,hour:nil,minute:nil,second:nil,sourceZone:nil))

        XCTAssertThrowsError(try M.Task(source:source(.androidCalendar),due:.unknown,completion:.unknown,recurrence:.unknown))
    }
    func testScopedIdentityAndDeletionAreNotInferred()throws {
        let ns=UUID(),a=try source(.eventKit,namespace:ns,container:"calendar-a",local:"same",external:"shared"),b=try source(.eventKit,namespace:ns,container:"calendar-b",local:"same",external:"shared")
        XCTAssertNotEqual(a,b);XCTAssertTrue(M.changes(records:[],coverage:.complete).isEmpty);XCTAssertTrue(M.changes(records:[],coverage:.partial).isEmpty);XCTAssertTrue(M.changes(records:[],coverage:.unknown).isEmpty)
        XCTAssertEqual(M.changes(records:[.explicitDeletion(a)],coverage:.partial),[.explicitDeletion(a)])
        XCTAssertThrowsError(try source(.eventKit,container:"",local:"item"))
    }
    func testProducerSemanticOutputPreservesUnknownAndInferred()throws {
        let start=Date(timeIntervalSince1970:1793513400),end=Date(timeIntervalSince1970:1793517000)
        let event=try M.Event(source:source(.eventKit),time:.inferredInstants(start:start,end:end,zone:"America/Chicago",basis:"source fallback"),occurrence:nil,recurrence:try .observed("unsupported-native-rule"),status:.unknown,alarmOffsetsSeconds:nil)
        let root=try XCTUnwrap(JSONSerialization.jsonObject(with:M.producerEvent(event)) as? [String:Any]),time=try XCTUnwrap(root["time"] as? [String:Any]),first=try XCTUnwrap(time["start"] as? [String:Any]),z=try XCTUnwrap(first["timeZone"] as? [String:Any]),recurrence=try XCTUnwrap(root["recurrence"] as? [String:Any])
        XCTAssertEqual(z["kind"] as? String,"inferred");XCTAssertEqual(z["basis"] as? String,"source fallback");XCTAssertEqual(recurrence["kind"] as? String,"unavailable");XCTAssertEqual(recurrence["reason"] as? String,"unsupported");XCTAssertTrue(root["alarms"] is NSNull)
        let evidenced=try M.Event(source:source(.eventKit),time:.evidencedInstants(start:start,end:end,startZone:.supplied("America/Chicago"),endZone:.inferred("America/Chicago",basis:"calendar fallback"),startOffset:.supplied(-300),endOffset:.inferred(-360,basis:"transition")),occurrence:try .init(original:.unknown,detached:true,seriesUpstreamID:"synthetic-series"),recurrence:.unknown,status:.unknown,alarmOffsetsSeconds:nil,title:"Synthetic",notes:nil)
        let output=try XCTUnwrap(JSONSerialization.jsonObject(with:M.producerEvent(evidenced)) as? [String:Any]),range=try XCTUnwrap(output["time"] as? [String:Any]),finish=try XCTUnwrap(range["end"] as? [String:Any]),finishZone=try XCTUnwrap(finish["timeZone"] as? [String:Any]),finishOffset=try XCTUnwrap(finish["offset"] as? [String:Any]),occurrence=try XCTUnwrap(output["occurrence"] as? [String:Any])
        XCTAssertEqual(finishZone["kind"] as? String,"inferred");XCTAssertEqual(finishOffset["kind"] as? String,"inferred");XCTAssertEqual(finishOffset["minutes"] as? Int,-360);XCTAssertEqual(occurrence["seriesUpstreamId"] as? String,"synthetic-series");XCTAssertEqual(output["title"] as? String,"Synthetic")
        XCTAssertThrowsError(try M.Task(source:source(.googleTasks),due:.instant(start,.unknown),completion:.unknown,recurrence:.unknown))
        XCTAssertThrowsError(try M.Task(source:source(.googleTasks),due:.unknown,completion:.unknown,recurrence:.none))
        let components=try M.DueComponents(year:nil,month:10,day:30,hour:nil,minute:nil,second:nil,sourceZone:nil)
        XCTAssertThrowsError(try M.Task(source:source(.googleTasks),due:.components(components),completion:.unknown,recurrence:.unknown))
    }
    func testPermissionKnowledgeAndAppGrantStaySeparate() {
        for access in [M.SystemAccess.writeOnly,.denied,.restricted,.notDetermined,.unknown,.unsupported] {XCTAssertFalse(M.mayRead(system:access,application:.allowed))}
        XCTAssertFalse(M.mayRead(system:.full,application:.unknown));XCTAssertFalse(M.mayRead(system:.full,application:.notAllowed));XCTAssertTrue(M.mayRead(system:.full,application:.allowed))
    }
    private func fixture(_ name:String)throws->[[String:Any]] {
        let ios=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bytes=try Data(contentsOf:ios.appendingPathComponent("test/mobile-calendar-fixtures/"+name))
        let root=try XCTUnwrap(JSONSerialization.jsonObject(with:bytes) as? [String:Any]);XCTAssertEqual(root["syntheticOnly"] as? Bool,true)
        return try XCTUnwrap(root["pairs"] as? [[String:Any]])
    }
    func testSyntheticPairedCalendarSemantics()throws {
        for pair in try fixture("eventkit-android-calendar-pairs.json") {
            let a=try XCTUnwrap(pair["eventKit"] as? [String:Any]),b=try XCTUnwrap(pair["androidCalendar"] as? [String:Any]),expected=try XCTUnwrap(pair["expected"] as? [String:Any])
            switch expected["kind"] as? String {
            case "civilDateRange":
                func range(_ v:[String:Any])throws->M.EventTime {try .allDay(start:XCTUnwrap(v["startDate"] as? String),endExclusive:XCTUnwrap(v["endExclusive"] as? String))}
                XCTAssertEqual(try range(a),try range(b));XCTAssertEqual(try range(a),try range(expected))
            case "floatingException":
                func semantics(_ v:[String:Any])throws->(M.EventTime,M.Occurrence) {
                    let date=try XCTUnwrap(v["originalDate"] as? String),original=try M.LocalDateTime(date:date,hour:XCTUnwrap(v["originalHour"] as? Int),minute:0,second:0),moved=try M.LocalDateTime(date:date,hour:XCTUnwrap(v["movedHour"] as? Int),minute:0,second:0),end=try M.LocalDateTime(date:date,hour:XCTUnwrap(v["endHour"] as? Int),minute:0,second:0)
                    return (try .validatedFloating(start:moved,end:end),try .init(original:.floating(original),detached:XCTUnwrap(v["detached"] as? Bool)))
                }
                let x=try semantics(a),y=try semantics(b),z=try semantics(expected);XCTAssertEqual(x.0,y.0);XCTAssertEqual(x.1,y.1);XCTAssertEqual(x.0,z.0);XCTAssertEqual(x.1,z.1)
            default:XCTFail("unknown fixture")
            }
        }
    }
    func testSyntheticPairedTaskSemantics()throws {
        for pair in try fixture("eventkit-google-task-pairs.json") {
            let a=try XCTUnwrap(pair["eventKitReminder"] as? [String:Any]),b=try XCTUnwrap(pair["googleTasks"] as? [String:Any]),expected=try XCTUnwrap(pair["expected"] as? [String:Any])
            func meaning(_ v:[String:Any])throws->(M.TaskDue,M.Completion) {
                let date=try XCTUnwrap(MobileCalendarDate(XCTUnwrap(v["dueDate"] as? String))),completion=try XCTUnwrap(v["completion"] as? String)
                if completion=="unknown" {return (.date(date),.unknown)}
                guard completion=="completed",v["completedAt"] is NSNull else{throw M.Failure.unsupported};return (.date(date),.completed(at:nil))
            }
            let x=try meaning(a),y=try meaning(b),z=try meaning(expected);XCTAssertEqual(x.0,y.0);XCTAssertEqual(x.1,y.1);XCTAssertEqual(x.0,z.0);XCTAssertEqual(x.1,z.1)
        }
    }

}
