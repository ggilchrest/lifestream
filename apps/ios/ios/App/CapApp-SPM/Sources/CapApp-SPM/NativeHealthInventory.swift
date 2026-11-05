import Foundation
import AssistantCore

/// Reads owner-scoped source choices; never requests permission or starts collection.
final class NativeHealthInventory {
    enum Failure: Error { case currentness, unavailable, limit }
    struct Snapshot { let sources: [MobileHealthInventoryPage.Source]; let unboundEnrollments: [MobileHealthInventoryPage.UnboundEnrollment] }
    private let transport: NativeTransport
    init(transport: NativeTransport) { self.transport = transport }

    func fetch(expectedEndpoint: UUID, completion: @escaping (Result<Snapshot, Error>) -> Void) {
        DispatchQueue.main.async { [self] in
            guard transport.effectiveIsSelf, let owner = transport.currentEffectiveOwner,
                  let principal = UUID(uuidString: owner.principal) else { completion(.failure(Failure.currentness)); return }
            let epoch = transport.epoch
            func current() -> Bool {
                guard transport.epoch == epoch, transport.effectiveIsSelf, let now = transport.currentEffectiveOwner else { return false }
                return now.principal == owner.principal && now.session == owner.session
            }
            func context(_ done: @escaping (Int?) -> Void) {
                transport.request("/api/runtime/v1/session-context", maxBytes: 65536) { response in
                    guard current(), case .success(let (bytes, http)) = response, http.statusCode == 200,
                          let json = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                          let revision = json["revision"] as? Int, revision >= 0,
                          let endpoint = json["endpoint"] as? [String: Any],
                          let id = endpoint["endpointId"] as? String, UUID(uuidString: id) == expectedEndpoint else { done(nil); return }
                    done(revision)
                }
            }
            context { initial in
                guard let revision = initial, current() else { completion(.failure(Failure.currentness)); return }
                var sources = [MobileHealthInventoryPage.Source](), namespaces = Set<UUID>(), unbound = [UUID: MobileHealthInventoryPage.UnboundEnrollment](), cursors = Set<String>()
                func page(_ cursor: String?, _ count: Int) {
                    guard current() else { completion(.failure(Failure.currentness)); return }
                    guard count < 20 else { completion(.failure(Failure.limit)); return }
                    do {
                        let data = try MobileHealthInventory.request(cursor: cursor)
                        guard let body = String(data: data, encoding: .utf8) else { throw Failure.unavailable }
                        self.transport.request(MobileHealthWire.path, method: "POST", body: body, internalHealth: true, maxBytes: 65536) { response in
                            guard current(), case .success(let (bytes, http)) = response, http.statusCode == 200,
                                  let result = try? MobileHealthInventory.parse(bytes, expectedPrincipal: principal, expectedEndpoint: expectedEndpoint) else { completion(.failure(Failure.unavailable)); return }
                            for source in result.sources {
                                guard namespaces.insert(source.namespace).inserted else { completion(.failure(Failure.unavailable)); return }
                                sources.append(source)
                            }
                            for entry in result.unboundEnrollments {
                                if let prior = unbound[entry.id], prior != entry { completion(.failure(Failure.unavailable)); return }
                                unbound[entry.id] = entry
                            }
                            guard sources.count <= 500, unbound.count <= 2 else { completion(.failure(Failure.limit)); return }
                            if let next = result.nextCursor {
                                guard cursors.insert(next).inserted else { completion(.failure(Failure.unavailable)); return }
                                page(next, count + 1)
                            } else {
                                context { final in
                                    guard current(), final == revision else { completion(.failure(Failure.currentness)); return }
                                    completion(.success(Snapshot(sources: sources, unboundEnrollments: unbound.values.sorted { $0.id.uuidString < $1.id.uuidString })))
                                }
                            }
                        }
                    } catch { completion(.failure(error)) }
                }
                page(nil, 0)
            }
        }
    }
}
