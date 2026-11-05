import Foundation
import CoreFoundation
import AssistantCore

/// Unregistered, native-only Calendar policy lifecycle. The host must call
/// `invalidate` whenever authentication or session currentness becomes uncertain.
/// This owner does not request OS access or start collection.
final class NativeCalendarPolicy {
    enum Failure: Error { case currentness, unavailable, binding }
    enum Admission { case newEnrollment, existingEnrollment }
    struct Binding {
        let enrollment: UUID
        let namespace: UUID
        let collector: String
        let category: String
    }
    private struct Context: Equatable {
        let principal: UUID, session: UUID, endpoint: UUID
        let revision: Int, contextGeneration: Int, endpointRevision: Int
        let subject: Data, reference: String
    }
    private func number(_ value: Any?) -> Int? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
              n.doubleValue >= 0, n.doubleValue <= 9007199254740991, n.doubleValue.rounded() == n.doubleValue else { return nil }
        return n.intValue
    }

    private let transport: NativeTransport
    private let outbox: HealthOutbox
    private var generation: UInt64 = 0
    private var activeEnrollment: UUID?
    init(transport: NativeTransport, outbox: HealthOutbox) {
        self.transport = transport
        self.outbox = outbox
    }

    /// Call on the main queue as soon as the host loses confidence in context.
    func invalidate(enrollment: UUID) {
        dispatchPrecondition(condition: .onQueue(.main))
        generation &+= 1
        outbox.invalidateCalendarPolicy(enrollment: enrollment)
        if let active = activeEnrollment, active != enrollment {
            outbox.invalidateCalendarPolicy(enrollment: active)
        }
        activeEnrollment = nil
    }

    static func readForAdmission(transport:NativeTransport,configuration:NativeCalendarAcquisitionOwner.Configuration,current:@escaping()->Bool)->NativeCalendarAdmission {
        NativeCalendarAdmission(transport:transport,configuration:configuration,current:current)
    }

    func refresh(binding: Binding, admission: Admission, completion: @escaping (Result<MobileCalendarPolicyProof, Error>) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        self.generation &+= 1
        let token = self.generation
        if let active = self.activeEnrollment, active != binding.enrollment {
            self.outbox.invalidateCalendarPolicy(enrollment: active)
        }
        self.activeEnrollment = binding.enrollment
        self.outbox.invalidateCalendarPolicy(enrollment: binding.enrollment)
        let epoch = self.transport.epoch
        guard let origin = self.transport.endpoint?.absoluteString, !origin.isEmpty else {
            completion(.failure(Failure.currentness)); return
        }
        func current() -> Bool {
            self.generation == token && self.transport.epoch == epoch && self.transport.endpoint?.absoluteString == origin
        }
        func fail(_ error: Error) {
            // An obsolete callback must never invalidate a newer refresh.
            if self.generation == token { self.outbox.invalidateCalendarPolicy(enrollment: binding.enrollment) }
            completion(.failure(error))
        }
        func context(_ done: @escaping (Result<Context, Error>) -> Void) {
            self.transport.request("/api/auth/v1/user-context", maxBytes: 65536) { response in
                guard current(), case .success(let (data, http)) = response, http.statusCode == 200,
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let pin = json["producerPin"] as? [String: String], pin == ["schemaId":"https://lifestream.dev/contracts/effective-subject/1.0.0", "schemaVersion":"1.0.0", "digest":"ed098cad970a310a807881ea7a833b96f1c980e8377ee3cfcbdffd68f2bd0cf9"],
                      let c = json["context"] as? [String: Any],
                      Set(c.keys) == Set(["schemaVersion","actorId","effectiveUserId","authenticatedSessionId","installationId","authorityRevision","generation","issuedAt"]), c["schemaVersion"] as? String == "1.0.0",
                      let actor = c["actorId"] as? String, let principal = UUID(uuidString: actor),
                      let effective = c["effectiveUserId"] as? String, UUID(uuidString: effective) == principal,
                      let sessionValue = c["authenticatedSessionId"] as? String, let session = UUID(uuidString: sessionValue),
                      UUID(uuidString: c["installationId"] as? String ?? "") != nil, self.number(c["authorityRevision"]) != nil, self.number(c["generation"]) != nil,
                      let issued = c["issuedAt"] as? String, issued.hasSuffix("Z"),
                      let actorObject = json["actor"] as? [String: Any], UUID(uuidString: actorObject["principalId"] as? String ?? "") == principal,
                      let effectiveObject = json["effectiveUser"] as? [String: Any], UUID(uuidString: effectiveObject["principalId"] as? String ?? "") == principal,
                      let impersonating = json["impersonating"] as? NSNumber, CFGetTypeID(impersonating) == CFBooleanGetTypeID(), !impersonating.boolValue,
                      let ref = json["contextRef"] as? String, !ref.isEmpty, ref.utf8.count <= 512,
                      let subject = try? JSONSerialization.data(withJSONObject: c, options: [.sortedKeys, .withoutEscapingSlashes]),
                      self.transport.effectiveIsSelf, let owner = self.transport.currentEffectiveOwner,
                      UUID(uuidString: owner.principal) == principal, UUID(uuidString: owner.session) == session else {
                    done(.failure(Failure.currentness)); return
                }
                self.transport.request("/api/runtime/v1/session-context", maxBytes: 65536) { reply in
                    guard current(), self.transport.effectiveIsSelf, let now = self.transport.currentEffectiveOwner,
                          UUID(uuidString: now.principal) == principal, UUID(uuidString: now.session) == session,
                          case .success(let (bytes, http)) = reply, http.statusCode == 200,
                          let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                          let ended = value["ended"] as? NSNumber, CFGetTypeID(ended) == CFBooleanGetTypeID(), !ended.boolValue,
                          let revision = self.number(value["revision"]), let contextGeneration = self.number(value["contextGeneration"]),
                          let endpointObject = value["endpoint"] as? [String: Any],
                          endpointObject["privacyClass"] as? String == "personal", let endpointRevision = self.number(endpointObject["configurationRevision"]),
                          let endpointValue = endpointObject["endpointId"] as? String,
                          let endpoint = UUID(uuidString: endpointValue) else {
                        done(.failure(Failure.currentness)); return
                    }
                    done(.success(Context(principal: principal, session: session, endpoint: endpoint, revision: revision, contextGeneration: contextGeneration, endpointRevision: endpointRevision, subject: subject, reference: ref)))
                }
            }
        }
        context { initial in
            guard current(), case .success(let before) = initial else { fail(Failure.currentness); return }
            let request: [String: Any] = [
                "producerPin": ["schemaId": MobileCalendarDelivery.schemaId, "schemaVersion": "1.0.0", "digest": MobileCalendarDelivery.schemaDigest],
                "operation": "calendar",
                "payload": ["schemaVersion": "1.0.0", "operation": "policy", "enrollmentId": binding.enrollment.uuidString.lowercased()]
            ]
            guard let bytes = try? JSONSerialization.data(withJSONObject: request), let body = String(data: bytes, encoding: .utf8) else {
                fail(Failure.unavailable); return
            }
            self.transport.request("/api/runtime/v1/mobile-context", method: "POST", body: body, internalHealth: true, maxBytes: 65536) { response in
                guard current(), case .success(let (data, http)) = response, http.statusCode == 200,
                      let proof = try? MobileCalendarPolicyParser.parse(data, expectedPrincipal: before.principal, expectedEndpoint: before.endpoint, expectedEnrollment: binding.enrollment) else {
                    fail(Failure.unavailable); return
                }
                guard proof.namespace == binding.namespace, proof.collector == binding.collector, proof.categories.contains(binding.category) else {
                    fail(Failure.binding); return
                }
                context { final in
                    guard current(), case .success(let after) = final, before == after else {
                        fail(Failure.currentness); return
                    }
                    do {
                        switch admission {
                        case .newEnrollment: try self.outbox.admitCalendar(proof: proof)
                        case .existingEnrollment: try self.outbox.confirmCalendarPolicy(proof: proof)
                        }
                        completion(.success(proof))
                    } catch { fail(error) }
                }
            }
        }
    }
}
