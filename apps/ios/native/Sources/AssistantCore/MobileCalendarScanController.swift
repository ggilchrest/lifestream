import Foundation

/// Synchronous, unregistered bounded-page commit. The future host owns fresh
/// Calendar policy, cancellation and auth-currentness; it must invalidate its
/// ticket when currentness is uncertain. No platform reads happen here.
final class MobileCalendarScanController {
    enum Failure: Error { case invalidPage, cancelled }
    enum PageState { case complete, interrupted, truncated, unknown, denied }
    struct Candidate {
        let observation: MobileEventKitAdapter.Observation
        let envelope: MobileEventKitAdapter.Envelope
    }
    private let outbox: HealthOutbox
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private let maxItems: Int, maxBytes: Int
    init(outbox: HealthOutbox, maxItems: Int = 64, maxBytes: Int = 262144) {
        self.outbox = outbox; self.maxItems = maxItems; self.maxBytes = maxBytes
    }
    /// Cancellation ordered before commit prevents that generation from saving.
    /// A commit already holding the lock completes atomically before cancel.
    func cancel() { lock.lock(); defer { lock.unlock() }; generation &+= 1 }
    func begin() -> UInt64 { lock.lock(); defer { lock.unlock() }; generation &+= 1; return generation }
    func commit(generation expected: UInt64, state: PageState, scope: MobileCalendarDelivery.CheckpointScope, expectedCheckpoint: Data?, nextCheckpoint: Data, candidates: [Candidate], ticket: CalendarCollectionTicket) throws {
        lock.lock(); defer { lock.unlock() }
        guard generation == expected else { throw Failure.cancelled }
        guard state == .complete, scope.coverage != .unknown, maxItems > 0, maxItems <= 64, maxBytes > 0, maxBytes <= 262144, candidates.count <= maxItems else { throw Failure.invalidPage }
        // Map every supplied observation before committing any of the page.
        let items = try candidates.map { try MobileEventKitAdapter.item($0.observation, envelope: $0.envelope) }
        guard items.reduce(0, { $0 + $1.data.count }) <= maxBytes else { throw Failure.invalidPage }
        // The outbox performs the final branded-ticket, owner, source, policy,
        // scope and checkpoint CAS checks in the same atomic protected write.
        try outbox.commitCalendar(scope: scope, expectedCheckpoint: expectedCheckpoint, nextCheckpoint: nextCheckpoint, items: items.map(\.data), ticket: ticket)
    }
}
