import Foundation

/// Inert EventKit-shaped observations supplied by a future source owner. This
/// code does not instantiate EventKit objects, fetch, request access or grant it.
enum MobileEventKitAdapter {
    enum Failure: Error { case invalid, unrepresentable }
    enum IdentityScope: String { case providerLocal, providerAccount, unknown }
    enum Kind: String { case calendarEvent = "CalendarEvent", task = "Task" }
    enum Locator {
        case sourceItem
        /// Exact producer CalendarPoint for the original occurrence, never the
        /// edited start. Unknown selectors cannot identify an occurrence.
        case occurrence(MobileCalendarMapping.OccurrenceSelector)
    }
    enum Observation {
        case event(MobileCalendarMapping.Event)
        case reminder(MobileCalendarMapping.Task)
        /// Only an independently explicit provider tombstone, never a missing
        /// record or an EventKit store-changed notification.
        case explicitDeletion(source: MobileCalendarMapping.Source, kind: Kind, locator: Locator)
    }
    struct Envelope {
        let eventId: UUID, enrollmentId: UUID
        let policyRevision: Int
        let mappingVersion: String
        let collectedAt: Date
        let identityScope: IdentityScope
    }
    private static func date(_ value: Date) throws -> String {
        guard value.timeIntervalSince1970.isFinite else { throw Failure.invalid }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let text = formatter.string(from: value)
        guard formatter.date(from: text) == value, text.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$", options: .regularExpression) != nil else { throw Failure.unrepresentable }
        return text
    }
    private static func json(_ data: Data) throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure.invalid }; return value
    }
    private static func checkRecurrence(_ recurrence: MobileCalendarMapping.Recurrence) throws {
        if case .observedNativeRule(let rule) = recurrence {
            // Producer JSON Schema length counts Unicode code points, not
            // grapheme clusters. Direct enum construction can bypass factory validation.
            guard !rule.isEmpty, rule.unicodeScalars.count <= 4096 else { throw Failure.unrepresentable }
        }
    }
    private static func locator(_ value: Locator) throws -> [String: Any] {
        switch value {
        case .sourceItem: return ["kind": "sourceItem"]
        case .occurrence(let original):
            let point: [String: Any]
            switch original {
            case .unknown: throw Failure.unrepresentable
            case .civilDate(let value): point = ["kind":"date", "date":value.text]
            case .floating(let value): point = ["kind":"floating", "local":String(format:"%@T%02d:%02d:%02d",value.date.text,value.hour,value.minute,value.second)]
            case .instant(let value): point = ["kind":"instant", "value":["at":try date(value),"timeZone":["kind":"unknown"],"offset":["kind":"unknown"]]]
            }
            return ["kind": "occurrence", "originalStart": point]
        }
    }
    static func item(_ observation: Observation, envelope: Envelope) throws -> MobileCalendarDelivery.Item {
        guard envelope.policyRevision > 0, !envelope.mappingVersion.isEmpty, envelope.mappingVersion.utf8.count <= 64,
              !envelope.mappingVersion.unicodeScalars.contains(where: { $0.value < 32 }) else { throw Failure.invalid }
        let source: MobileCalendarMapping.Source, kind: Kind, record: [String: Any]?, location: [String: Any], operation: String
        switch observation {
        case .event(let event):
            try checkRecurrence(event.recurrence)
            source = event.source; kind = .calendarEvent; operation = "upsert"; record = try json(MobileCalendarMapping.producerEvent(event))
            if event.occurrence != nil {
                guard let occurrence = record?["occurrence"] as? [String: Any], let original = occurrence["originalStart"] as? [String: Any] else { throw Failure.unrepresentable }
                location = ["kind": "occurrence", "originalStart": original]
            } else { location = ["kind": "sourceItem"] }
        case .reminder(let task):
            try checkRecurrence(task.recurrence)
            source = task.source; kind = .task; operation = "upsert"; record = try json(MobileCalendarMapping.producerTask(task)); location = ["kind": "sourceItem"]
        case .explicitDeletion(let supplied, let suppliedKind, let suppliedLocator):
            source = supplied; kind = suppliedKind; operation = "delete"; record = nil; location = try locator(suppliedLocator)
        }
        guard source.platform == .eventKit else { throw Failure.invalid }
        let identity: [String: Any] = ["collector":"eventKit", "namespace":source.namespace.uuidString.lowercased(), "containerKind":kind == .calendarEvent ? "calendar":"taskList", "containerId":source.containerID, "accountId":(source.accountID as Any?) ?? NSNull(), "upstreamId":source.localID, "upstreamIdentityScope":envelope.identityScope.rawValue, "externalId":(source.externalID as Any?) ?? NSNull(), "upstreamRevision":(source.revision as Any?) ?? NSNull(), "originalApp":NSNull(), "originalDevice":NSNull()]
        var change: [String: Any] = ["schemaVersion":"1.0.0", "eventId":envelope.eventId.uuidString.lowercased(), "enrollmentId":envelope.enrollmentId.uuidString.lowercased(), "expectedPolicyRevision":envelope.policyRevision, "source":identity, "collectedAt":try date(envelope.collectedAt), "mappingVersion":envelope.mappingVersion, "operation":operation, "recordType":kind.rawValue]
        if let record { change["record"] = record } else { change["deletionEvidence"] = "explicitProviderTombstone" }
        let data = try JSONSerialization.data(withJSONObject:["change":change,"locator":location],options:[.sortedKeys,.withoutEscapingSlashes])
        return try MobileCalendarDelivery.item(data)
    }
}
