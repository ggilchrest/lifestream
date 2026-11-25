import Foundation

/// A transport adapter must only classify an event accepted/duplicate after durable server application.
/// This normalized result is local plumbing, not an independent wire contract.
public enum HealthDeliveryCode: String, Codable { case applied, deleted, invalid, scope, settingsChanged, suppressed, conflict, quota, unavailable }
public struct HealthDeliveryResult {
    public enum Outcome { case accepted, duplicate, retryable, rejected }
    public let eventId: UUID
    public let outcome: Outcome
    public let code: HealthDeliveryCode
    public init(eventId: UUID, outcome: Outcome, code: HealthDeliveryCode) { self.eventId=eventId;self.outcome=outcome;self.code=code }
}
public final class HealthSyncCoordinator {
    public enum SyncError: Error { case busy, invalidReceipt }
    public enum Completion: Equatable { case idle, applied, retry, needsAttention, invalidReceipt, deferred }
    public typealias Send = (Data, @escaping (Result<[HealthDeliveryResult],Error>) -> Void) -> Void
    private let outbox: HealthOutbox
    private let lock=NSLock()
    private var active: UUID?
    private var callbackClaimed=false
    // A fresh policy proof can cover the same queue. Carry the display count
    // only when the next verified window starts with the same outstanding event.
    private var lastWindow: (ticket: HealthCollectionTicket, head: UUID, confirmed: Int)?
    public init(outbox: HealthOutbox) { self.outbox=outbox }
    /// The ticket captures current human, enrollment, type, session generation and policy revision.
    public func sync(ticket: HealthCollectionTicket, progress: @escaping (_ confirmed: Int, _ total: Int) -> Void = { _, _ in }, send: @escaping Send, completion: @escaping (Completion)->Void) {
        let flight=UUID();lock.lock();guard active == nil else { lock.unlock();completion(.deferred);return };active=flight;callbackClaimed=false;lock.unlock()
        let batch: MobileHealthEncoder.Batch
        let previous: Int, total: Int, items: [HealthChange], next: UUID?
        var localRejected=false
        do {
            let window = try outbox.deliveryWindow(ticket: ticket)
            items = window.items
            next = window.next
            if let prior = lastWindow, prior.head == items.first?.eventId,
               prior.ticket.humanId == ticket.humanId, prior.ticket.enrollmentId == ticket.enrollmentId,
               prior.ticket.category == ticket.category, prior.ticket.sourceNamespace == ticket.sourceNamespace,
               prior.ticket.expectedPolicyRevision == ticket.expectedPolicyRevision {
                previous = prior.confirmed
            } else {
                previous = 0
                lastWindow = nil
            }
            total = previous + window.total
            if items.isEmpty { finish(flight);completion(.idle);return }
            progress(previous, total)
            var valid=[HealthChange](),invalid=[UUID:HealthDeliveryCode]()
            for item in items {
                do { _=try MobileHealthEncoder.batch([item],enrollment:ticket.enrollmentId,sourceNamespace:ticket.sourceNamespace,category:ticket.category);valid.append(item) }
                catch { invalid[item.eventId] = .invalid }
            }
            if !invalid.isEmpty { try outbox.settle(ticket:ticket,accepted:[],rejected:invalid);localRejected=true }
            if valid.isEmpty { finish(flight);completion(.needsAttention);return }
            batch=try MobileHealthEncoder.batch(valid,enrollment:ticket.enrollmentId,sourceNamespace:ticket.sourceNamespace,category:ticket.category)
        } catch { finish(flight);completion(.deferred);return }
        send(batch.data) { [weak self] result in
            guard let self else { completion(.deferred);return }
            self.lock.lock();guard self.active == flight, !self.callbackClaimed else { self.lock.unlock();return };self.callbackClaimed=true;self.lock.unlock()
            func done(_ value: Completion) { self.finish(flight);completion(value) }
            guard case .success(let results)=result else { done(.retry);return }
            let ids=Set(batch.eventIds),received=Set(results.map(\.eventId))
            guard results.count==batch.eventIds.count,received.count==results.count,received==ids, results.allSatisfy(Self.valid) else { done(.invalidReceipt);return }
            let accepted=Set(results.filter { $0.outcome == .accepted || $0.outcome == .duplicate }.map(\.eventId))
            let rejected=Dictionary(uniqueKeysWithValues:results.filter { $0.outcome == .rejected }.map { ($0.eventId,$0.code) })
            do { try self.outbox.settle(ticket:ticket,accepted:accepted,rejected:rejected) }
            catch { done(.deferred);return }
            let confirmed = previous + accepted.count
            self.lastWindow = nil
            if rejected.isEmpty && !localRejected,
               let head = items.first(where: { !accepted.contains($0.eventId) })?.eventId ?? next {
                self.lastWindow = (ticket, head, confirmed)
            }
            progress(confirmed, total)
            done(results.contains(where: { $0.outcome == .retryable }) ? .retry : rejected.isEmpty && !localRejected ? .applied : .needsAttention)
        }
    }
    private static func valid(_ item: HealthDeliveryResult) -> Bool {
        switch item.outcome {
        case .accepted,.duplicate: return item.code == .applied || item.code == .deleted
        case .retryable: return item.code == .unavailable
        case .rejected: return [.invalid,.scope,.settingsChanged,.suppressed,.conflict,.quota].contains(item.code)
        }
    }
    private func finish(_ flight: UUID) { lock.lock();if active == flight { active=nil;callbackClaimed=false };lock.unlock() }
}
