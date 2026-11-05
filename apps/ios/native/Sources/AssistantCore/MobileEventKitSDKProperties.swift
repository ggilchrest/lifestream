#if canImport(EventKit)
import Foundation
import EventKit

/// Reads properties only from an object supplied by a future authorized owner.
/// No store acquisition, permission, refresh, save, observer or delete operation.
private enum MobileEventKitSDKSnapshot {
    typealias Failure = MobileEventKitSourceExtractor.Failure
    static func integers(_ values: [NSNumber]?) throws -> [Int]? {
        guard let values else { return nil }
        guard values.count <= 366 else { throw Failure.unrepresentable }
        return try values.map { number in
            let value = number.intValue
            guard NSNumber(value: value) == number else { throw Failure.unrepresentable }
            return value
        }
    }
    static func rule(_ rule: EKRecurrenceRule) throws -> MobileEventKitRawRecurrenceRule {
        let weekdays = rule.daysOfTheWeek
        guard (weekdays?.count ?? 0) <= 366 else { throw Failure.unrepresentable }
        let end: MobileEventKitRawRecurrenceEnd?
        if let supplied = rule.recurrenceEnd {
            guard supplied.occurrenceCount <= UInt(Int.max) else { throw Failure.unrepresentable }
            end = .init(endDate: supplied.endDate, occurrenceCount: Int(supplied.occurrenceCount))
        } else { end = nil }
        return try .init(calendarIdentifier: rule.calendarIdentifier, frequency: rule.frequency.rawValue,
                         interval: rule.interval, firstDayOfTheWeek: rule.firstDayOfTheWeek,
                         daysOfTheWeek: weekdays?.map { .init(dayOfTheWeek: $0.dayOfTheWeek.rawValue, weekNumber: $0.weekNumber) },
                         daysOfTheMonth: integers(rule.daysOfTheMonth), monthsOfTheYear: integers(rule.monthsOfTheYear),
                         weeksOfTheYear: integers(rule.weeksOfTheYear), daysOfTheYear: integers(rule.daysOfTheYear),
                         setPositions: integers(rule.setPositions), end: end)
    }
    static func item(_ item: EKCalendarItem) throws -> MobileEventKitRawItem {
        let calendar = item.calendar, suppliedRules = item.recurrenceRules
        guard (suppliedRules?.count ?? 0) <= 32 else { throw Failure.unrepresentable }
        return try .init(itemIdentifier: .observed(item.calendarItemIdentifier),
                         calendarIdentifier: .observed(calendar?.calendarIdentifier),
                         accountIdentifier: .observed(calendar?.source?.sourceIdentifier),
                         externalIdentifier: .observed(item.calendarItemExternalIdentifier),
                         title: .observed(item.title), notes: .observed(item.notes),
                         recurrenceRules: .observed(suppliedRules.map { try $0.map(rule) }))
    }
    static func alarms(_ alarms: [EKAlarm]?) -> MobileEventKitRead<[MobileEventKitRawAlarm]?> {
        guard let alarms else { return .observed(nil) }
        // No partial list when an SDK field exceeds the representable boundary.
        guard alarms.count <= 32 else { return .unknown }
        return .observed(alarms.map { .init(absoluteDate: $0.absoluteDate, relativeOffset: $0.relativeOffset,
                                          proximity: $0.proximity.rawValue, hasStructuredLocation: $0.structuredLocation != nil) })
    }
}
struct MobileEventKitSDKEventProperties: MobileEventKitEventReading {
    private let event: EKEvent
    init(_ event: EKEvent) { self.event = event }
    func readEvent() throws -> MobileEventKitRawEvent {
        try .init(item: MobileEventKitSDKSnapshot.item(event), startDate: .observed(event.startDate), endDate: .observed(event.endDate),
                  isAllDay: .observed(event.isAllDay), timeZoneIdentifier: .observed(event.timeZone?.identifier),
                  occurrenceDate: .observed(event.occurrenceDate), isDetached: .observed(event.isDetached),
                  statusRawValue: .observed(event.status.rawValue), alarms: MobileEventKitSDKSnapshot.alarms(event.alarms))
    }
}
struct MobileEventKitSDKReminderProperties: MobileEventKitReminderReading {
    private let reminder: EKReminder
    init(_ reminder: EKReminder) { self.reminder = reminder }
    func readReminder() throws -> MobileEventKitRawReminder {
        try .init(item: MobileEventKitSDKSnapshot.item(reminder), dueDateComponents: .observed(reminder.dueDateComponents),
                  isCompleted: .observed(reminder.isCompleted), completionDate: .observed(reminder.completionDate))
    }
}
extension MobileEventKitSourceExtractor {
    static func event(_ event: EKEvent, context: Context) throws -> MobileEventKitAdapter.Observation {
        try self.event(MobileEventKitSDKEventProperties(event), context: context)
    }
    static func reminder(_ reminder: EKReminder, context: Context) throws -> MobileEventKitAdapter.Observation {
        try self.reminder(MobileEventKitSDKReminderProperties(reminder), context: context)
    }
}
#endif
