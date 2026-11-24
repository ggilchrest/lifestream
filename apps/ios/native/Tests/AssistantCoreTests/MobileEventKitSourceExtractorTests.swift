import Foundation
import XCTest
@testable import AssistantCore
#if canImport(EventKit)
import EventKit
#endif

final class MobileEventKitSourceExtractorTests: XCTestCase {
    typealias Extractor = MobileEventKitSourceExtractor
    typealias M = MobileCalendarMapping
    private struct EventReader: MobileEventKitEventReading {
        let value: MobileEventKitRawEvent
        func readEvent() throws -> MobileEventKitRawEvent { value }
    }
    private struct ReminderReader: MobileEventKitReminderReading {
        let value: MobileEventKitRawReminder
        func readReminder() throws -> MobileEventKitRawReminder { value }
    }
    private struct ThrowingReader: MobileEventKitEventReading, MobileEventKitReminderReading {
        func readEvent() throws -> MobileEventKitRawEvent { throw Extractor.Failure.unavailable }
        func readReminder() throws -> MobileEventKitRawReminder { throw Extractor.Failure.unavailable }
    }
    private let namespace = UUID(uuidString: "10000000-0000-4000-8000-000000000001")!
    private func context(_ zone: String? = nil) -> Extractor.Context {
        .init(namespace: namespace, capturedSDKDefaultTimeZone: zone.flatMap(TimeZone.init(identifier:)))
    }
    private func date(_ value: String) -> Date { ISO8601DateFormatter().date(from: value)! }
    private func item() -> MobileEventKitRawItem {
        .init(itemIdentifier: .observed("item-e\u{301}"), calendarIdentifier: .observed("calendar"), accountIdentifier: .observed(nil),
              externalIdentifier: .observed("external"), title: .observed("Synthetic title"), notes: .observed("Synthetic notes"), recurrenceRules: .observed(nil))
    }
    private func event() -> MobileEventKitRawEvent {
        .init(item: item(), startDate: .observed(date("2026-11-01T15:00:00Z")), endDate: .observed(date("2026-11-01T16:00:00Z")),
              isAllDay: .observed(false), timeZoneIdentifier: .observed("America/Chicago"), occurrenceDate: .observed(nil),
              isDetached: .observed(false), statusRawValue: .observed(1), alarms: .observed(nil))
    }
    private func reminder() -> MobileEventKitRawReminder {
        .init(item: item(), dueDateComponents: .observed(nil), isCompleted: .observed(false), completionDate: .observed(nil))
    }
    private func extracted(_ value: MobileEventKitRawEvent, _ zone: String? = nil) throws -> M.Event {
        guard case .event(let event) = try Extractor.event(EventReader(value: value), context: context(zone)) else { throw Extractor.Failure.invalid }
        return event
    }
    private func extracted(_ value: MobileEventKitRawReminder) throws -> M.Task {
        guard case .reminder(let task) = try Extractor.reminder(ReminderReader(value: value), context: context()) else { throw Extractor.Failure.invalid }
        return task
    }
    private func wire(_ value: MobileEventKitAdapter.Observation) throws -> [String: Any] {
        let envelope = MobileEventKitAdapter.Envelope(eventId: UUID(), enrollmentId: UUID(), policyRevision: 2,
                                                     mappingVersion: "synthetic-eventkit-properties/1", collectedAt: date("2026-11-01T18:00:00Z"), identityScope: .providerLocal)
        let result = try MobileEventKitAdapter.item(value, envelope: envelope)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: result.data) as? [String: Any])
    }
    private func record(_ value: [String: Any]) throws -> [String: Any] {
        let change = try XCTUnwrap(value["change"] as? [String: Any])
        return try XCTUnwrap(change["record"] as? [String: Any])
    }
    private func rule() -> MobileEventKitRawRecurrenceRule {
        .init(calendarIdentifier: "gregorian", frequency: 1, interval: 2, firstDayOfTheWeek: 0,
              daysOfTheWeek: [.init(dayOfTheWeek: 2, weekNumber: -1)], daysOfTheMonth: nil, monthsOfTheYear: [],
              weeksOfTheYear: nil, daysOfTheYear: nil, setPositions: [-1], end: .init(endDate: nil, occurrenceCount: 4))
    }
    func testActualExtractorAndEncoderPreserveScopedIdentityAndText() throws {
        let observation = try Extractor.event(EventReader(value: event()), context: context())
        let root = try wire(observation), change = try XCTUnwrap(root["change"] as? [String: Any]), source = try XCTUnwrap(change["source"] as? [String: Any])
        let output = try record(root)
        XCTAssertEqual(source["upstreamId"] as? String, "item-e\u{301}")
        XCTAssertEqual(Array((source["upstreamId"] as! String).utf8), Array("item-e\u{301}".utf8))
        XCTAssertEqual(source["namespace"] as? String, namespace.uuidString.lowercased())
        XCTAssertTrue(source["upstreamRevision"] is NSNull); XCTAssertTrue(source["accountId"] is NSNull)
        XCTAssertEqual(source["externalId"] as? String, "external")
        XCTAssertEqual(output["title"] as? String, "Synthetic title"); XCTAssertEqual(output["notes"] as? String, "Synthetic notes")
        XCTAssertEqual(change["operation"] as? String, "upsert")
    }
    func testSuppliedInstantZoneIsIndependentOfDecodeContext() throws {
        let a = try extracted(event(), "Pacific/Auckland"), b = try extracted(event(), "UTC")
        XCTAssertEqual(a, b)
        guard case .instants(let start, let end, let zone) = a.time else { return XCTFail("instant range") }
        XCTAssertEqual(start, date("2026-11-01T15:00:00Z")); XCTAssertEqual(end, date("2026-11-01T16:00:00Z"))
        XCTAssertEqual(zone, .supplied("America/Chicago"))
    }
    func testNilZoneRequiresExplicitFloatingDecoderAndNeverClaimsSuppliedZone() throws {
        var value = event(); value.timeZoneIdentifier = .observed(nil)
        XCTAssertThrowsError(try extracted(value))
        let output = try extracted(value, "America/Chicago")
        guard case .floating(let start, let end) = output.time else { return XCTFail("floating range") }
        XCTAssertEqual(start, try M.LocalDateTime(date: "2026-11-01", hour: 9, minute: 0, second: 0))
        XCTAssertEqual(end.hour, 10)
        let root = try record(wire(.event(output))), time = try XCTUnwrap(root["time"] as? [String: Any])
        XCTAssertEqual(time["kind"] as? String, "floatingRange"); XCTAssertNil(time["timeZone"])
        value.timeZoneIdentifier = .unknown; XCTAssertThrowsError(try extracted(value, "UTC"))
    }
    func testAllDayExclusiveEndAcrossDSTAndYearBoundary() throws {
        for (start, end, a, b) in [("2026-11-01T05:00:00Z", "2026-11-02T06:00:00Z", "2026-11-01", "2026-11-02"),
                                  ("2026-12-31T06:00:00Z", "2027-01-01T06:00:00Z", "2026-12-31", "2027-01-01")] {
            var value = event(); value.startDate = .observed(date(start)); value.endDate = .observed(date(end)); value.isAllDay = .observed(true); value.timeZoneIdentifier = .observed(nil)
            XCTAssertThrowsError(try extracted(value))
            let output = try extracted(value, "America/Chicago")
            guard case .allDay(let range) = output.time else { return XCTFail("civil range") }
            XCTAssertEqual(range.start.text, a); XCTAssertEqual(range.endExclusive.text, b)
            value.timeZoneIdentifier = .observed("Europe/Paris")
            guard case .allDayWithZone(let same, let zone) = try extracted(value, "America/Chicago").time else { return XCTFail("zone evidence") }
            XCTAssertEqual(same, range); XCTAssertEqual(zone, .supplied("Europe/Paris"))
        }
    }
    func testAllDayNonMidnightAndUnrepresentablePrecisionFail() throws {
        var value = event(); value.isAllDay = .observed(true)
        XCTAssertThrowsError(try extracted(value, "America/Chicago"))
        value = event(); value.startDate = .observed(date("2026-11-01T15:00:00Z").addingTimeInterval(0.0005))
        XCTAssertThrowsError(try extracted(value))
        value.timeZoneIdentifier = .observed(nil); XCTAssertThrowsError(try extracted(value, "UTC"))
    }
    func testMovedOriginalOccurrenceAndDetachedFlagStaySeparate() throws {
        var value = event(); value.occurrenceDate = .observed(date("2026-11-01T13:00:00Z")); value.isDetached = .observed(true)
        let result = try extracted(value)
        XCTAssertEqual(result.occurrence?.original, .instant(date("2026-11-01T13:00:00Z")))
        XCTAssertEqual(result.occurrence?.detached, true); XCTAssertNil(result.occurrence?.seriesUpstreamID)
        let root = try wire(.event(result)), locator = try XCTUnwrap(root["locator"] as? [String: Any])
        let original = try XCTUnwrap(locator["originalStart"] as? [String: Any]), instant = try XCTUnwrap(original["value"] as? [String: Any])
        XCTAssertEqual(instant["at"] as? String, "2026-11-01T13:00:00.000Z")
        value.timeZoneIdentifier = .observed(nil)
        guard case .floating(let local)? = try extracted(value, "America/Chicago").occurrence?.original else { return XCTFail("floating original") }
        XCTAssertEqual(local.hour, 7)
        value.occurrenceDate = .observed(nil); XCTAssertThrowsError(try extracted(value, "America/Chicago"))
    }
    func testAllDayOriginalOccurrenceUsesCivilSelector() throws {
        var value = event(); value.isAllDay = .observed(true); value.timeZoneIdentifier = .observed(nil)
        value.startDate = .observed(date("2026-11-02T06:00:00Z")); value.endDate = .observed(date("2026-11-03T06:00:00Z"))
        value.occurrenceDate = .observed(date("2026-11-01T05:00:00Z")); value.isDetached = .observed(true)
        XCTAssertEqual(try extracted(value, "America/Chicago").occurrence?.original, .civilDate(try XCTUnwrap(MobileCalendarDate("2026-11-01"))))
    }
    func testNoneUnknownAndUnsupportedRecurrenceStayDistinct() throws {
        var value = reminder()
        guard case .none = try extracted(value).recurrence else { return XCTFail("known none") }
        value.item.recurrenceRules = .observed([])
        guard case .none = try extracted(value).recurrence else { return XCTFail("empty means none") }
        value.item.recurrenceRules = .unknown
        guard case .unknown = try extracted(value).recurrence else { return XCTFail("unknown") }
        value.item.recurrenceRules = .observed([rule()])
        let result = try extracted(value)
        guard case .observedNativeRule(let text) = result.recurrence else { return XCTFail("opaque rules") }
        guard case .observedNativeRule(let repeatText) = try extracted(value).recurrence else { return XCTFail("repeat rules") }
        XCTAssertEqual(text, repeatText); XCTAssertFalse(text.contains("RRULE"))
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(raw["format"] as? String, "eventkit-properties/1")
        let rows = try XCTUnwrap(raw["rules"] as? [[String: Any]]), row = try XCTUnwrap(rows.first)
        XCTAssertTrue(row["daysOfTheMonth"] is NSNull); XCTAssertEqual(row["monthsOfTheYear"] as? [Int], [])
        XCTAssertEqual(row["firstDayOfTheWeek"] as? Int, 0)
        XCTAssertEqual((row["end"] as? [String: Any])?["occurrenceCount"] as? Int, 4)
        let wireRecord = try record(wire(.reminder(result))), recurrence = try XCTUnwrap(wireRecord["recurrence"] as? [String: Any])
        XCTAssertEqual(recurrence["kind"] as? String, "unavailable"); XCTAssertEqual(recurrence["reason"] as? String, "unsupported")
        XCTAssertEqual(recurrence["nativeRule"] as? String, text)
    }
    func testKnownRecurringEventWithoutOriginalFails() throws {
        var value = event(); value.item.recurrenceRules = .observed([rule()])
        XCTAssertThrowsError(try extracted(value))
        value.occurrenceDate = .observed(date("2026-11-01T15:00:00Z")); XCTAssertNoThrow(try extracted(value))
        value.occurrenceDate = .unknown; XCTAssertThrowsError(try extracted(value))
    }
    func testRecurrenceBoundsAndDatesRejectRatherThanTruncate() throws {
        var value = reminder(), r = rule()
        value.item.recurrenceRules = .observed(Array(repeating: r, count: 33)); XCTAssertThrowsError(try extracted(value))
        r.daysOfTheMonth = Array(repeating: 1, count: 367); value.item.recurrenceRules = .observed([r]); XCTAssertThrowsError(try extracted(value))
        r = rule(); r.calendarIdentifier = String(repeating: "e\u{301}", count: 65); value.item.recurrenceRules = .observed([r]); XCTAssertThrowsError(try extracted(value))
        r = rule(); r.daysOfTheMonth = Array(repeating: Int.max, count: 366); value.item.recurrenceRules = .observed([r]); XCTAssertThrowsError(try extracted(value))
        r = rule(); r.end = .init(endDate: date("2026-11-01T00:00:00Z").addingTimeInterval(0.0005), occurrenceCount: 0)
        value.item.recurrenceRules = .observed([r]); XCTAssertThrowsError(try extracted(value))
        r.end = .init(endDate: date("2026-11-01T00:00:00Z"), occurrenceCount: 0); value.item.recurrenceRules = .observed([r]); XCTAssertNoThrow(try extracted(value))
    }
    func testReminderAbsentUnknownPartialAndNonGregorianDue() throws {
        var value = reminder()
        XCTAssertEqual(try extracted(value).due, .absent)
        value.dueDateComponents = .unknown; XCTAssertEqual(try extracted(value).due, .unknown)
        value.dueDateComponents = .observed(DateComponents()); XCTAssertEqual(try extracted(value).due, .unknown)
        var parts = DateComponents(); parts.month = 13; parts.day = 2; parts.calendar = Calendar(identifier: .hebrew)
        value.dueDateComponents = .observed(parts)
        guard case .components(let due) = try extracted(value).due else { return XCTFail("components") }
        XCTAssertNil(due.year); XCTAssertNil(due.hour); XCTAssertEqual(due.month, 13); XCTAssertEqual(due.calendarIdentifier, "hebrew"); XCTAssertEqual(due.sourceZone, .unknown)
        parts = DateComponents(); parts.year = 2028; parts.month = 2; parts.day = 29; parts.hour = 9; parts.calendar = Calendar(identifier: .gregorian); parts.timeZone = TimeZone(identifier: "America/Chicago")
        value.dueDateComponents = .observed(parts)
        guard case .components(let full) = try extracted(value).due else { return XCTFail("full components") }
        XCTAssertEqual(full.hour, 9); XCTAssertNil(full.minute); XCTAssertEqual(full.sourceZone, .supplied("America/Chicago"))
    }
    func testUnsupportedReminderComponentsAreNotDiscarded() throws {
        for component: Calendar.Component in [.era, .quarter, .weekday, .weekdayOrdinal, .weekOfMonth, .weekOfYear, .yearForWeekOfYear, .nanosecond] {
            var parts = DateComponents(); parts.year = 2026; parts.setValue(1, for: component)
            var value = reminder(); value.dueDateComponents = .observed(parts); XCTAssertThrowsError(try extracted(value), "\(component)")
        }
        var parts = DateComponents(); parts.year = 2026; parts.isLeapMonth = true
        var value = reminder(); value.dueDateComponents = .observed(parts); XCTAssertThrowsError(try extracted(value))
        if #available(iOS 18, macOS 15, *) { parts = DateComponents(); parts.dayOfYear = 15; value.dueDateComponents = .observed(parts); XCTAssertThrowsError(try extracted(value)) }
    }
    func testReminderCompletionPreservesKnownWithoutDateAndUnknown() throws {
        var value = reminder(); value.isCompleted = .observed(true)
        XCTAssertEqual(try extracted(value).completion, .completed(at: nil))
        value.completionDate = .observed(date("2026-11-01T15:00:00Z")); XCTAssertEqual(try extracted(value).completion, .completed(at: date("2026-11-01T15:00:00Z")))
        value.isCompleted = .observed(false); XCTAssertThrowsError(try extracted(value))
        value.isCompleted = .unknown; XCTAssertEqual(try extracted(value).completion, .unknown)
        value.isCompleted = .observed(true); value.completionDate = .observed(date("2026-11-01T15:00:00Z").addingTimeInterval(0.0005)); XCTAssertThrowsError(try extracted(value))
    }
    func testStatusAndAlarmFieldNeverProduceTaskOrDeletion() throws {
        var value = event()
        for (raw, expected) in [(0, M.EventStatus.unknown), (1, .confirmed), (2, .tentative), (3, .cancelled), (91, .unknown)] {
            value.statusRawValue = .observed(raw); XCTAssertEqual(try extracted(value).status, expected)
        }
        value.statusRawValue = .observed(3)
        value.alarms = .observed([.init(absoluteDate: nil, relativeOffset: -60, proximity: 0, hasStructuredLocation: false)])
        XCTAssertEqual(try extracted(value).alarmOffsetsSeconds, [-60])
        let change = try XCTUnwrap(wire(.event(extracted(value)))["change"] as? [String: Any])
        XCTAssertEqual(change["recordType"] as? String, "CalendarEvent"); XCTAssertEqual(change["operation"] as? String, "upsert"); XCTAssertNil(change["deletionEvidence"])
        for alarm in [MobileEventKitRawAlarm(absoluteDate: Date(timeIntervalSince1970: 0), relativeOffset: -60, proximity: 0, hasStructuredLocation: false),
                      .init(absoluteDate: nil, relativeOffset: -60, proximity: 1, hasStructuredLocation: false),
                      .init(absoluteDate: nil, relativeOffset: -60, proximity: 0, hasStructuredLocation: true),
                      .init(absoluteDate: nil, relativeOffset: 0.5, proximity: 0, hasStructuredLocation: false),
                      .init(absoluteDate: nil, relativeOffset: .infinity, proximity: 0, hasStructuredLocation: false)] {
            value.alarms = .observed([.init(absoluteDate: nil, relativeOffset: -30, proximity: 0, hasStructuredLocation: false), alarm])
            XCTAssertNil(try extracted(value).alarmOffsetsSeconds)
        }
        value.alarms = .observed(nil); XCTAssertEqual(try extracted(value).alarmOffsetsSeconds, [])
        value.alarms = .unknown; XCTAssertNil(try extracted(value).alarmOffsetsSeconds)
        value.alarms = .observed(Array(repeating: .init(absoluteDate: nil, relativeOffset: 1, proximity: 0, hasStructuredLocation: false), count: 33)); XCTAssertNil(try extracted(value).alarmOffsetsSeconds)
    }
    func testRequiredValuesAndReaderFailuresDoNotReturnPartialObservation() throws {
        var value = event(); value.item.itemIdentifier = .observed(nil); XCTAssertThrowsError(try extracted(value))
        value = event(); value.item.calendarIdentifier = .unknown; XCTAssertThrowsError(try extracted(value))
        value = event(); value.item.itemIdentifier = .observed(String(repeating: "x", count: 1025)); XCTAssertThrowsError(try extracted(value))
        value = event(); value.item.title = .observed(String(repeating: "x", count: 1025)); XCTAssertThrowsError(try extracted(value))
        value = event(); value.endDate = value.startDate; XCTAssertThrowsError(try extracted(value))
        value = event(); value.timeZoneIdentifier = .observed("invented-zone"); XCTAssertThrowsError(try extracted(value))
        value = event(); value.startDate = .observed(Date(timeIntervalSince1970: .infinity)); XCTAssertThrowsError(try extracted(value))
        value = event(); value.startDate = .unknown; XCTAssertThrowsError(try extracted(value))
        XCTAssertThrowsError(try Extractor.event(ThrowingReader(), context: context()))
        XCTAssertThrowsError(try Extractor.reminder(ThrowingReader(), context: context()))
    }
    #if canImport(EventKit)
    func testSDKWrapperAndDirectEntrySignaturesCompileWithoutSDKObjects() {
        func acceptsEvent<T: MobileEventKitEventReading>(_: T.Type) {}
        func acceptsReminder<T: MobileEventKitReminderReading>(_: T.Type) {}
        acceptsEvent(MobileEventKitSDKEventProperties.self); acceptsReminder(MobileEventKitSDKReminderProperties.self)
        let eventEntry: (EKEvent, Extractor.Context) throws -> MobileEventKitAdapter.Observation = Extractor.event
        let reminderEntry: (EKReminder, Extractor.Context) throws -> MobileEventKitAdapter.Observation = Extractor.reminder
        _ = eventEntry; _ = reminderEntry // Typecheck only; no SDK objects or store.
    }
    #endif
}
