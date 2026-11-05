import Foundation

/// Raw, read-only SDK property values. Unknown is distinct from observed nil.
enum MobileEventKitRead<Value> { case observed(Value), unknown }
struct MobileEventKitRawRecurrenceEnd {
    var endDate: Date?
    var occurrenceCount: Int
}
struct MobileEventKitRawWeekday {
    var dayOfTheWeek: Int
    var weekNumber: Int
}
struct MobileEventKitRawRecurrenceRule {
    var calendarIdentifier: String
    var frequency: Int
    var interval: Int
    var firstDayOfTheWeek: Int
    var daysOfTheWeek: [MobileEventKitRawWeekday]?
    var daysOfTheMonth: [Int]?
    var monthsOfTheYear: [Int]?
    var weeksOfTheYear: [Int]?
    var daysOfTheYear: [Int]?
    var setPositions: [Int]?
    var end: MobileEventKitRawRecurrenceEnd?
}
struct MobileEventKitRawAlarm {
    var absoluteDate: Date?
    var relativeOffset: TimeInterval
    var proximity: Int
    var hasStructuredLocation: Bool
}
struct MobileEventKitRawItem {
    var itemIdentifier: MobileEventKitRead<String?> = .unknown
    var calendarIdentifier: MobileEventKitRead<String?> = .unknown
    var accountIdentifier: MobileEventKitRead<String?> = .unknown
    var externalIdentifier: MobileEventKitRead<String?> = .unknown
    var title: MobileEventKitRead<String?> = .unknown
    var notes: MobileEventKitRead<String?> = .unknown
    var recurrenceRules: MobileEventKitRead<[MobileEventKitRawRecurrenceRule]?> = .unknown
}
struct MobileEventKitRawEvent {
    var item = MobileEventKitRawItem()
    var startDate: MobileEventKitRead<Date?> = .unknown
    var endDate: MobileEventKitRead<Date?> = .unknown
    var isAllDay: MobileEventKitRead<Bool> = .unknown
    var timeZoneIdentifier: MobileEventKitRead<String?> = .unknown
    var occurrenceDate: MobileEventKitRead<Date?> = .unknown
    var isDetached: MobileEventKitRead<Bool> = .unknown
    var statusRawValue: MobileEventKitRead<Int> = .unknown
    var alarms: MobileEventKitRead<[MobileEventKitRawAlarm]?> = .unknown
}
struct MobileEventKitRawReminder {
    var item = MobileEventKitRawItem()
    var dueDateComponents: MobileEventKitRead<DateComponents?> = .unknown
    var isCompleted: MobileEventKitRead<Bool> = .unknown
    var completionDate: MobileEventKitRead<Date?> = .unknown
}
protocol MobileEventKitEventReading { func readEvent() throws -> MobileEventKitRawEvent }
protocol MobileEventKitReminderReading { func readReminder() throws -> MobileEventKitRawReminder }

/// The only normalization path for both production SDK readers and fixture readers.
/// It neither acquires records nor supplies authority, persistence or a delivery envelope.
enum MobileEventKitSourceExtractor {
    enum Failure: Error { case unavailable, invalid, unrepresentable }
    struct Context {
        let namespace: UUID
        /// How EventKit encoded floating dates, not evidence of a source timezone.
        let capturedSDKDefaultTimeZone: TimeZone?
    }
    private typealias M = MobileCalendarMapping
    private static func required<T>(_ value: MobileEventKitRead<T>) throws -> T {
        guard case .observed(let value) = value else { throw Failure.unavailable }
        return value
    }
    private static func optional<T>(_ value: MobileEventKitRead<T?>) -> T? {
        if case .observed(let value) = value { return value }
        return nil
    }
    private static func source(_ raw: MobileEventKitRawItem, _ context: Context) throws -> M.Source {
        guard let item = try required(raw.itemIdentifier), let calendar = try required(raw.calendarIdentifier) else { throw Failure.unavailable }
        return try M.Source(platform: .eventKit, namespace: context.namespace, containerID: calendar, localID: item,
                            accountID: optional(raw.accountIdentifier), externalID: optional(raw.externalIdentifier), revision: nil)
    }
    private static func instantText(_ date: Date) throws -> String {
        guard date.timeIntervalSince1970.isFinite else { throw Failure.invalid }
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let text = f.string(from: date)
        guard text.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$", options: .regularExpression) != nil,
              f.date(from: text) == date else { throw Failure.unrepresentable }
        return text
    }
    private static func civil(_ date: Date, context: Context, allDay: Bool) throws -> M.LocalDateTime {
        guard date.timeIntervalSince1970.isFinite, let zone = context.capturedSDKDefaultTimeZone else { throw Failure.unavailable }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        guard let year = parts.year, let month = parts.month, let day = parts.day,
              let hour = parts.hour, let minute = parts.minute, let second = parts.second,
              calendar.date(from: parts) == date,
              !allDay || (hour == 0 && minute == 0 && second == 0) else { throw Failure.unrepresentable }
        return try M.LocalDateTime(date: String(format: "%04d-%02d-%02d", year, month, day), hour: hour, minute: minute, second: second)
    }
    private static func recurrence(_ raw: MobileEventKitRead<[MobileEventKitRawRecurrenceRule]?>) throws -> (M.Recurrence, Bool?) {
        guard case .observed(let supplied) = raw else { return (.unknown, nil) }
        let rules = supplied ?? []
        guard !rules.isEmpty else { return (.none, false) }
        guard rules.count <= 32 else { throw Failure.unrepresentable }
        let values: [[String: Any]] = try rules.map { rule in
            guard !rule.calendarIdentifier.isEmpty, rule.calendarIdentifier.utf8.count <= 128, rule.interval > 0,
                  [rule.daysOfTheMonth, rule.monthsOfTheYear, rule.weeksOfTheYear, rule.daysOfTheYear, rule.setPositions].allSatisfy({ ($0?.count ?? 0) <= 366 }),
                  (rule.daysOfTheWeek?.count ?? 0) <= 366 else { throw Failure.unrepresentable }
            let end: Any
            if let supplied = rule.end {
                guard supplied.occurrenceCount >= 0 else { throw Failure.invalid }
                end = ["endDate": try supplied.endDate.map(instantText) as Any? ?? NSNull(), "occurrenceCount": supplied.occurrenceCount] as [String: Any]
            } else { end = NSNull() }
            return ["calendarIdentifier": rule.calendarIdentifier, "frequency": rule.frequency, "interval": rule.interval,
                    "firstDayOfTheWeek": rule.firstDayOfTheWeek,
                    "daysOfTheWeek": rule.daysOfTheWeek.map { $0.map { ["dayOfTheWeek": $0.dayOfTheWeek, "weekNumber": $0.weekNumber] } } as Any? ?? NSNull(),
                    "daysOfTheMonth": rule.daysOfTheMonth as Any? ?? NSNull(), "monthsOfTheYear": rule.monthsOfTheYear as Any? ?? NSNull(),
                    "weeksOfTheYear": rule.weeksOfTheYear as Any? ?? NSNull(), "daysOfTheYear": rule.daysOfTheYear as Any? ?? NSNull(),
                    "setPositions": rule.setPositions as Any? ?? NSNull(), "end": end]
        }
        let bytes = try JSONSerialization.data(withJSONObject: ["format": "eventkit-properties/1", "rules": values], options: [.sortedKeys, .withoutEscapingSlashes])
        guard bytes.count <= 4096, let text = String(data: bytes, encoding: .utf8), text.unicodeScalars.count <= 4096 else { throw Failure.unrepresentable }
        return (.observedNativeRule(text), true)
    }
    private static func alarms(_ raw: MobileEventKitRead<[MobileEventKitRawAlarm]?>) -> [Int]? {
        guard case .observed(let supplied) = raw else { return nil }
        let values = supplied ?? []
        guard values.count <= 32 else { return nil }
        var offsets: [Int] = []
        for alarm in values {
            guard alarm.absoluteDate == nil, alarm.proximity == 0, !alarm.hasStructuredLocation,
                  alarm.relativeOffset.isFinite, alarm.relativeOffset.rounded() == alarm.relativeOffset,
                  (-31536000...31536000).contains(alarm.relativeOffset) else { return nil }
            offsets.append(Int(alarm.relativeOffset))
        }
        return offsets
    }
    static func event(_ reader: any MobileEventKitEventReading, context: Context) throws -> MobileEventKitAdapter.Observation {
        let raw = try reader.readEvent(), source = try source(raw.item, context)
        guard let start = try required(raw.startDate), let end = try required(raw.endDate) else { throw Failure.unavailable }
        let allDay = try required(raw.isAllDay), zone = try required(raw.timeZoneIdentifier), detached = try required(raw.isDetached)
        if let zone { guard TimeZone(identifier: zone) != nil, zone.utf8.count <= 128 else { throw Failure.invalid } }
        let time: M.EventTime
        if allDay {
            let a = try civil(start, context: context, allDay: true), b = try civil(end, context: context, allDay: true)
            guard let range = MobileCalendarAllDayRange(start: a.date.text, endExclusive: b.date.text) else { throw Failure.invalid }
            time = zone.map { .allDayWithZone(range, .supplied($0)) } ?? .allDay(range)
        } else if let zone {
            time = try .instants(start: start, end: end, sourceZone: zone)
        } else {
            time = try .validatedFloating(start: civil(start, context: context, allDay: false), end: civil(end, context: context, allDay: false))
        }
        let (rule, recurring) = try recurrence(raw.item.recurrenceRules)
        let original = try required(raw.occurrenceDate)
        let occurrence: M.Occurrence?
        if let original {
            let selector: M.OccurrenceSelector
            if allDay { selector = .civilDate(try civil(original, context: context, allDay: true).date) }
            else if zone == nil { selector = .floating(try civil(original, context: context, allDay: false)) }
            else { _ = try instantText(original); selector = .instant(original) }
            occurrence = try M.Occurrence(original: selector, detached: detached)
        } else {
            guard !detached, recurring != true else { throw Failure.unrepresentable }
            occurrence = nil
        }
        let status: M.EventStatus
        switch raw.statusRawValue {
        case .observed(1): status = .confirmed
        case .observed(2): status = .tentative
        case .observed(3): status = .cancelled
        default: status = .unknown
        }
        return .event(try M.Event(source: source, time: time, occurrence: occurrence, recurrence: rule, status: status,
                                 alarmOffsetsSeconds: alarms(raw.alarms), title: optional(raw.item.title), notes: optional(raw.item.notes)))
    }
    private static func due(_ raw: MobileEventKitRead<DateComponents?>) throws -> M.TaskDue {
        guard case .observed(let supplied) = raw else { return .unknown }
        guard let value = supplied else { return .absent }
        let unsupported: [Calendar.Component] = [.era, .quarter, .weekday, .weekdayOrdinal, .weekOfMonth, .weekOfYear, .yearForWeekOfYear, .nanosecond]
        guard unsupported.allSatisfy({ value.value(for: $0) == nil }), value.isLeapMonth == nil else { throw Failure.unrepresentable }
        if #available(iOS 18, macOS 15, *) { guard value.dayOfYear == nil else { throw Failure.unrepresentable } }
        guard [value.year, value.month, value.day, value.hour, value.minute, value.second].contains(where: { $0 != nil }) else { return .unknown }
        return .components(try M.DueComponents(year: value.year, month: value.month, day: value.day, hour: value.hour, minute: value.minute, second: value.second,
                                             sourceZone: value.timeZone?.identifier, calendarIdentifier: value.calendar.map { String(describing: $0.identifier) }))
    }
    static func reminder(_ reader: any MobileEventKitReminderReading, context: Context) throws -> MobileEventKitAdapter.Observation {
        let raw = try reader.readReminder(), source = try source(raw.item, context)
        let (rule, _) = try recurrence(raw.item.recurrenceRules)
        let complete: M.Completion
        switch raw.isCompleted {
        case .unknown: complete = .unknown
        case .observed(true): complete = .completed(at: optional(raw.completionDate))
        case .observed(false):
            guard optional(raw.completionDate) == nil else { throw Failure.invalid }
            complete = .incomplete
        }
        return .reminder(try M.Task(source: source, due: due(raw.dueDateComponents), completion: complete, recurrence: rule,
                                  title: optional(raw.item.title), notes: optional(raw.item.notes)))
    }
}
