import Foundation
import AssistantCore

/// Native-only adapter reusing the existing authenticated HTTPS/CSRF/session transport.
/// It is not registered with the JavaScript bridge and cannot start collection.
final class NativeHealthDelivery {
    enum Failure: Error { case ownerChanged, invalidResponse, unavailable }
    private let transport: NativeTransport
    private let outbox: HealthOutbox
    init(transport: NativeTransport, outbox: HealthOutbox) { self.transport=transport;self.outbox=outbox }
    func send(ticket: HealthCollectionTicket, batch: Data, completion: @escaping (Result<[HealthDeliveryResult],Error>)->Void) {
        DispatchQueue.main.async { [self] in
            guard self.transport.effectiveIsSelf, let owner=self.transport.currentEffectiveOwner,
                  UUID(uuidString:owner.principal)==ticket.humanId else { completion(.failure(Failure.ownerChanged));return }
            let epoch=self.transport.epoch
            do {
                try self.outbox.verify(ticket:ticket)
                let bytes=try MobileHealthWire.request(batch:batch)
                guard let body=String(data:bytes,encoding:.utf8) else { throw Failure.invalidResponse }
                self.transport.request(MobileHealthWire.path,method:"POST",body:body,internalHealth:true,maxBytes:65536) { [self] response in
                    guard self.transport.epoch==epoch,self.transport.effectiveIsSelf,
                          let current=self.transport.currentEffectiveOwner,current.principal==owner.principal,current.session==owner.session else { completion(.failure(Failure.ownerChanged));return }
                    guard case .success(let (data,http))=response,http.statusCode==200 else { completion(.failure(Failure.unavailable));return }
                    do { completion(.success(try MobileHealthWire.receipt(data))) }
                    catch { completion(.failure(Failure.invalidResponse)) }
                }
            } catch { completion(.failure(error)) }
        }
    }

    /// Required by the composed native-only path; there is no permissive default.
    struct Currentness {
        let refresh: (@escaping (Result<Void, Error>) -> Void) -> Void
        let isCurrent: () -> Bool
    }
    final class Cancellation {
        fileprivate var action: (() -> Void)?
        private var pending = 0, terminal = false, drained = false, scheduled = false
        private var waiters: [() -> Void] = []
        func cancel() { precondition(Thread.isMainThread); action?() }
        func whenDrained(_ done: @escaping () -> Void) {
            precondition(Thread.isMainThread)
            if drained { DispatchQueue.main.async(execute: done) } else { waiters.append(done) }
        }
        fileprivate func begin() { precondition(Thread.isMainThread); pending += 1 }
        fileprivate func end() { precondition(Thread.isMainThread); pending -= 1; publish() }
        fileprivate func complete() { terminal = true; publish() }
        private func publish() {
            guard terminal, pending == 0, !scheduled, !drained else { return }
            scheduled = true
            // Return from all SDK/transport handlers before releasing their owner.
            DispatchQueue.main.async { [self] in
                scheduled = false
                guard terminal, pending == 0, !drained else { return }
                drained = true; let callbacks = waiters; waiters.removeAll()
                callbacks.forEach { $0() }
            }
        }
    }
    @discardableResult
    func send(ticket: HealthCollectionTicket, batch: Data, currentness: Currentness,
              completion: @escaping (Result<[HealthDeliveryResult], Error>) -> Void) -> Cancellation {
        precondition(Thread.isMainThread)
        let cancellation = Cancellation()
        var finished = false, task: URLSessionDataTask?
        func finish(_ result: Result<[HealthDeliveryResult], Error>) {
            guard !finished else { return }; finished = true
            cancellation.action = nil
            completion(result)
            cancellation.complete()
        }
        cancellation.action = { task?.cancel(); finish(.failure(Failure.unavailable)) }
        guard transport.effectiveIsSelf, let owner = transport.currentEffectiveOwner,
              UUID(uuidString: owner.principal) == ticket.humanId else {
            finish(.failure(Failure.ownerChanged)); return cancellation
        }
        let epoch = transport.epoch
        func valid() -> Bool {
            guard !finished, currentness.isCurrent(), transport.epoch == epoch, transport.effectiveIsSelf,
                  let now = transport.currentEffectiveOwner, now.principal == owner.principal,
                  now.session == owner.session, (try? outbox.verify(ticket: ticket)) != nil else { return false }
            return true
        }
        var firstClaimed = false
        cancellation.begin()
        currentness.refresh { [self] result in
            precondition(Thread.isMainThread)
            guard !firstClaimed else { return }; firstClaimed = true
            defer { cancellation.end() }
            guard !finished else { return }
            guard case .success = result, valid() else { finish(.failure(Failure.ownerChanged)); return }
            do {
                let bytes = try MobileHealthWire.request(batch: batch)
                guard let body = String(data: bytes, encoding: .utf8) else { throw Failure.invalidResponse }
                // No queue hop between the last local fence and network dispatch.
                guard valid() else { throw Failure.ownerChanged }
                var responseClaimed = false
                cancellation.begin()
                let started = transport.request(MobileHealthWire.path, method: "POST", body: body, internalHealth: true, maxBytes: 65536) { response in
                    guard !responseClaimed else { return }; responseClaimed = true
                    defer { cancellation.end() }
                    guard !finished else { return }
                    var secondClaimed = false
                    cancellation.begin()
                    currentness.refresh { second in
                        precondition(Thread.isMainThread)
                        guard !secondClaimed else { return }; secondClaimed = true
                        defer { cancellation.end() }
                        guard !finished else { return }
                        guard case .success = second, valid() else { finish(.failure(Failure.ownerChanged)); return }
                        guard case .success(let (data, http)) = response, http.statusCode == 200 else { finish(.failure(Failure.unavailable)); return }
                        do {
                            let receipt = try MobileHealthWire.receipt(data)
                            guard valid() else { throw Failure.ownerChanged }
                            // The coordinator may settle synchronously here: no queue hop.
                            finish(.success(receipt))
                        } catch { finish(.failure(error)) }
                    }
                }
                task = started
                if finished { started?.cancel() }
            } catch { finish(.failure(error)) }
        }
        return cancellation
    }
}
