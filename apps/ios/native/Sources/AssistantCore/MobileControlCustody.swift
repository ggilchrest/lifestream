import Foundation

/// Local custody only. Callers must independently authenticate the current owner
/// and verify session currentness around every use. This does not send or clear.
public final class MobileControlCustody {
    public struct Scope: Equatable {
        public let serverDigest: String, principal: UUID, endpoint: UUID, session: UUID
        public init(serverDigest: String, principal: UUID, endpoint: UUID, session: UUID) {
            self.serverDigest = serverDigest; self.principal = principal; self.endpoint = endpoint; self.session = session
        }
        fileprivate var internalScope: HealthOriginalControlJournal.Scope {
            .init(serverDigest: serverDigest, principal: principal, endpoint: endpoint, session: session)
        }
    }
    public enum Settlement { case applied, rejected, held }
    public enum Failure: Error { case invalid, restrictionRequired }
    private let journal: HealthOriginalControlJournal
    public init(storage: HealthSnapshotStorage) { journal = HealthOriginalControlJournal(storage: storage) }

    /// Restriction must durably fence the real collector/outbox. The caller supplies
    /// it from native-owned state; this facade does not claim to enforce it itself.
    /// Validates an exact owner-scoped original and applies conservative local
    /// restriction where needed. This neither sends nor persists a control.
    public static func narrowForReviewedOriginal(original:Data, scope:Scope, proof:MobileHealthPolicyProof?, restrict:(UUID)throws->Void)throws->Data {
        let request = try MobileControlOriginal.parse(original)
        guard request.principal == scope.principal, request.endpoint == scope.endpoint,
              let object = try JSONSerialization.jsonObject(with: request.canonical) as? [String: Any],
              let target = object["target"] as? [String: Any], target["collector"] as? String == "healthKit",
              let action = object["action"] as? [String: Any], let kind = action["kind"] as? String else { throw Failure.invalid }
        if kind == "configure" || kind == "remove" {
            guard let proof, let enrollment = MobileControlOriginal.uuid(target["enrollmentId"]) else { throw Failure.restrictionRequired }
            _ = try MobileHealthLocalRestriction.plan(original: request.canonical, proof: proof)
            try restrict(enrollment)
        }
        return request.canonical
    }
    private func prepareRetained(original: Data, scope: Scope, proof: MobileHealthPolicyProof?, restrict: (UUID) throws -> Void) throws -> Data {
        let canonical=try Self.narrowForReviewedOriginal(original:original,scope:scope,proof:proof,restrict:restrict)
        try journal.prepare(scope: scope.internalScope, original: canonical)
        return try journal.original(scope: scope.internalScope)
    }
    /// Stages the immutable original for a separately validated reviewed envelope.
    /// This neither authorizes the envelope nor sends or releases the journal.
    public func prepareReviewedOriginal(original: Data, scope: Scope, proof: MobileHealthPolicyProof?, restrict: (UUID) throws -> Void) throws -> Data {
        try prepareRetained(original: original, scope: scope, proof: proof, restrict: restrict)
    }
    public func prepare(original: Data, scope: Scope, proof: MobileHealthPolicyProof?, restrict: (UUID) throws -> Void) throws -> Data {
        let retained = try prepareRetained(original: original, scope: scope, proof: proof, restrict: restrict)
        return try MobileControlOriginal.envelope(MobileControlOriginal.parse(retained), reconciliation: false)
    }
    public func retainedOriginalForReconciliation(serverDigest: String, principal: UUID) throws -> Data {
        try journal.reconciliationOriginalAfterTrustedSelfCheck(serverDigest: serverDigest, principal: principal)
    }
    public func reconciliation(serverDigest: String, principal: UUID) throws -> Data {
        let retained = try journal.reconciliationOriginalAfterTrustedSelfCheck(serverDigest: serverDigest, principal: principal)
        return try MobileControlOriginal.envelope(MobileControlOriginal.parse(retained), reconciliation: true)
    }
    public func assess(scope: Scope, response: Data, reconciliation: Bool) -> Settlement {
        let original: Data
        do {
            original = try reconciliation ? journal.reconciliationOriginalAfterTrustedSelfCheck(serverDigest: scope.serverDigest, principal: scope.principal) : journal.original(scope: scope.internalScope)
        } catch { return .held }
        switch MobileControlReceipt.assess(expected: original, response: response) {
        case .applied: return .applied
        case .rejected: return .rejected
        case .held: return .held
        }
    }
}
