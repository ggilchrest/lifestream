import Foundation
import CoreFoundation
import AssistantCore

/// Unregistered, native-only composition. Construction grants no access.
final class NativeHealthSessionOwner {
    struct Scope: Equatable { let human: UUID; let enrollment: UUID; let endpoint: UUID; let category: String }
    struct CollectorHooks {
        let policySuspender: NativeHealthPolicySuspending
        let collect: (HealthCollectionTicket, @escaping (Result<Void, Error>) -> Void) -> Void
        let stop: () -> Void
        var whenDrained: ((@escaping () -> Void) -> Void)? = nil
    }
    enum Failure: Error { case unavailable, stale, cancelled, busy }
    private struct Snapshot: Equatable {
        let origin: String, principal: String, session: String
        let epoch: Int, revision: Int, generation: Int, endpointRevision: Int
    }
    private final class Run {
        let scope: Scope, completion: (Result<HealthSyncCoordinator.Completion, Error>) -> Void
        var pending = 0, terminal = false, cancelled = false, reported = false
        var snapshot: Snapshot?, ticket: HealthCollectionTicket?, sender: NativeHealthDelivery.Cancellation?
        init(_ scope: Scope, _ completion: @escaping (Result<HealthSyncCoordinator.Completion, Error>) -> Void) { self.scope = scope; self.completion = completion }
    }
    private let transport: NativeTransport, outbox: HealthOutbox, collector: CollectorHooks
    private let policy: NativeHealthPolicy, delivery: NativeHealthDelivery, coordinator: HealthSyncCoordinator
    private var active: Run?
    private var drainWaiters: [() -> Void] = []
    private var releaseScheduled = false
    var busy: Bool { active != nil }
    func whenDrained(_ done: @escaping () -> Void) {
        precondition(Thread.isMainThread)
        if active == nil { DispatchQueue.main.async(execute: done) }
        else { drainWaiters.append(done) }
    }
    init(transport: NativeTransport, outbox: HealthOutbox, collector: CollectorHooks) {
        self.transport = transport; self.outbox = outbox; self.collector = collector
        policy = NativeHealthPolicy(transport: transport, outbox: outbox, collector: collector.policySuspender)
        delivery = NativeHealthDelivery(transport: transport, outbox: outbox)
        coordinator = HealthSyncCoordinator(outbox: outbox)
    }
    private func report(_ run: Run, _ result: Result<HealthSyncCoordinator.Completion, Error>) {
        guard !run.reported else { return }; run.reported = true; run.completion(result)
    }
    private func release(_ run: Run) {
        guard run.terminal, run.pending == 0, active === run, !releaseScheduled else { return }
        releaseScheduled = true
        DispatchQueue.main.async { [self] in
            releaseScheduled = false
            guard run.terminal, run.pending == 0, active === run else { return }
            active = nil
            let callbacks = drainWaiters; drainWaiters.removeAll(); callbacks.forEach { $0() }
        }
    }
    private func stopCollector(_ run: Run) {
        // Logical collector completion may precede its real SDK callback.
        if let drain = collector.whenDrained {
            begin(run); var reported = false
            collector.stop()
            drain { [self] in
                precondition(Thread.isMainThread)
                guard !reported else { return }; reported = true; end(run)
            }
        } else { collector.stop() } // Legacy unqualified test hooks carry no SDK drain claim.
    }
    private func begin(_ run: Run) { run.pending += 1 }
    private func end(_ run: Run) { run.pending -= 1; release(run) }
    private func finish(_ run: Run, _ result: Result<HealthSyncCoordinator.Completion, Error>) {
        guard !run.terminal else { return }
        run.terminal = true; begin(run)
        let failed: Bool
        switch result {
        case .failure: failed = true
        case .success(.retry), .success(.deferred), .success(.invalidReceipt): failed = true
        default: failed = false
        }
        if failed {
            outbox.invalidatePolicy(enrollment: run.scope.enrollment)
            stopCollector(run)
        }
        report(run, result); end(run)
    }
    func cancel() {
        guard Thread.isMainThread else { DispatchQueue.main.async { self.cancel() }; return }
        guard let run = active, !run.terminal else { return }
        begin(run) // Prevent synchronous stop/sender callbacks from releasing during cancellation.
        run.cancelled = true; run.terminal = true
        outbox.invalidatePolicy(enrollment: run.scope.enrollment)
        stopCollector(run); run.sender?.cancel()
        report(run, .failure(Failure.cancelled)); end(run)
    }
    func run(scope: Scope, completion: @escaping (Result<HealthSyncCoordinator.Completion, Error>) -> Void) {run(scope:scope,collectFirst:true,completion:completion)}
    /// Same owner/coordinator/transport and currentness, with no SDK collection.
    func deliverPending(scope:Scope,completion:@escaping(Result<HealthSyncCoordinator.Completion,Error>)->Void){run(scope:scope,collectFirst:false,completion:completion)}
    private func run(scope:Scope,collectFirst:Bool,completion:@escaping(Result<HealthSyncCoordinator.Completion,Error>)->Void){
        guard Thread.isMainThread else { DispatchQueue.main.async { self.run(scope: scope,collectFirst:collectFirst,completion:completion) }; return }
        guard active == nil else { completion(.success(.deferred)); return }
        let run = Run(scope, completion); active = run
        snapshot(run) { [self] initial in
            guard !run.terminal else { return }
            guard case .success(let value) = initial else { finish(run, .failure(Failure.stale)); return }
            run.snapshot = value
            begin(run); var claimed = false
            policy.reconcile(enrollment: scope.enrollment, expectedEndpoint: scope.endpoint) { [self] result in
                precondition(Thread.isMainThread)
                guard !claimed else { return }; claimed = true
                defer { end(run) }
                if run.terminal { outbox.invalidatePolicy(enrollment: scope.enrollment); return }
                guard case .success(let proof) = result, proof.permitsCollection, localCurrent(run) else { finish(run, .failure(Failure.stale)); return }
                do {
                    let ticket = try outbox.ticket(enrollment: scope.enrollment, type: scope.category)
                    guard ticket.humanId == scope.human, ticket.enrollmentId == scope.enrollment, ticket.category == scope.category else { throw Failure.stale }
                    run.ticket = ticket
                    begin(run); var collected = false
                    let afterCollection:(Result<Void,Error>)->Void = { [self] result in
                        let complete = { [self] in
                        guard !collected else { return }; collected = true
                        defer { end(run) }
                        guard !run.terminal else { return }
                        guard case .success = result, localCurrent(run), (try? outbox.verify(ticket: ticket)) != nil else { finish(run, .failure(Failure.stale)); return }
                        refresh(run) { [self] check in
                            guard !run.terminal else { return }
                            guard case .success = check, valid(run, ticket) else { finish(run, .failure(Failure.stale)); return }
                            // Coordinator may settle local invalid items synchronously.
                            begin(run)
                            coordinator.sync(ticket: ticket, send: { [self] batch, done in
                                let gate = NativeHealthDelivery.Currentness(refresh: { callback in self.refresh(run, callback) }, isCurrent: { self.valid(run, ticket) })
                                let handle = delivery.send(ticket: ticket, batch: batch, currentness: gate, completion: done)
                                run.sender = handle
                                begin(run)
                                handle.whenDrained { [self] in end(run) }
                                if run.cancelled { handle.cancel() }
                            }, completion: { [self] result in
                                precondition(Thread.isMainThread)
                                defer { end(run) }
                                if !run.cancelled { finish(run, .success(result)) }
                            })
                        }
                        }
                        if Thread.isMainThread { complete() } else { DispatchQueue.main.async(execute: complete) }
                    }
                    if collectFirst{collector.collect(ticket,afterCollection)}else{afterCollection(.success(()))}
                } catch { finish(run, .failure(error)) }
            }
        }
    }
    private func valid(_ run: Run, _ ticket: HealthCollectionTicket) -> Bool {
        !run.terminal && !run.cancelled && localCurrent(run) && (try? outbox.verify(ticket: ticket)) != nil
    }
    private func localCurrent(_ run: Run) -> Bool {
        guard active === run, !run.cancelled, let s = run.snapshot, transport.epoch == s.epoch,
              transport.endpoint?.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == s.origin,
              transport.effectiveIsSelf, let owner = transport.currentEffectiveOwner else { return false }
        return owner.principal == s.principal && owner.session == s.session && UUID(uuidString: owner.principal) == run.scope.human
    }
    private func number(_ value: Any?) -> Int? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
              n.doubleValue.rounded() == n.doubleValue, n.doubleValue >= 0, n.doubleValue <= 9007199254740991 else { return nil }
        return n.intValue
    }
    private func snapshot(_ run: Run, _ done: @escaping (Result<Snapshot, Error>) -> Void) {
        guard let url = transport.endpoint, transport.effectiveIsSelf, let owner = transport.currentEffectiveOwner,
              UUID(uuidString: owner.principal) == run.scope.human, UUID(uuidString: owner.session) != nil else { done(.failure(Failure.stale)); return }
        let origin = url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), epoch = transport.epoch
        begin(run); var claimed = false
        transport.request("/api/runtime/v1/session-context", maxBytes: 65536) { [self] result in
            precondition(Thread.isMainThread)
            guard !claimed else { return }; claimed = true
            defer { end(run) }
            guard !run.cancelled, transport.epoch == epoch, transport.endpoint?.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == origin,
                  transport.effectiveIsSelf, let current = transport.currentEffectiveOwner, current.principal == owner.principal, current.session == owner.session,
                  case .success(let (data, http)) = result, http.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let ended = json["ended"] as? NSNumber, CFGetTypeID(ended) == CFBooleanGetTypeID(), !ended.boolValue,
                  let revision = number(json["revision"]), let generation = number(json["contextGeneration"]),
                  let endpoint = json["endpoint"] as? [String: Any], UUID(uuidString: endpoint["endpointId"] as? String ?? "") == run.scope.endpoint,
                  endpoint["privacyClass"] as? String == "personal", let endpointRevision = number(endpoint["configurationRevision"]) else { done(.failure(Failure.stale)); return }
            done(.success(Snapshot(origin: origin, principal: owner.principal, session: owner.session, epoch: epoch, revision: revision, generation: generation, endpointRevision: endpointRevision)))
        }
    }
    private func refresh(_ run: Run, _ done: @escaping (Result<Void, Error>) -> Void) {
        guard localCurrent(run), !run.terminal else { done(.failure(Failure.stale)); return }
        snapshot(run) { [self] result in
            guard case .success(let current) = result, current == run.snapshot, localCurrent(run) else { done(.failure(Failure.stale)); return }
            done(.success(()))
        }
    }
}
