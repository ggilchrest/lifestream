import Foundation
import CoreFoundation
import CryptoKit
import AssistantCore

/// Unregistered source-only owner. Call only from native code after explicit user
/// intent. It does not request HealthKit permission, retry, clear, or activate.
final class NativeMobileControlOwner {
    enum Failure: Error { case currentness, unavailable, busy, cancelled }
    fileprivate struct Snapshot: Equatable {
        let scope: MobileControlCustody.Scope
        let epoch: Int, revision: Int, contextGeneration: Int, endpointRevision: Int
        let origin: String, subject: Data
    }
    struct ReviewedPreview {
        fileprivate let preview: MobileInterpretation.Preview
        fileprivate let snapshot: Snapshot
    }
    struct InterpretationRead {
        let result: MobileInterpretation.ReadResult
        let reviewedPreview: ReviewedPreview?
    }
    private let transport: NativeTransport
    private let custody: MobileControlCustody
    private let restrict: (UUID) throws -> Void
    private let legacyStorage: any HealthSnapshotStorage
    private let exclusivity: any MobileControlExclusivity
    private var token = 0
    private var active = false
    private var task: URLSessionDataTask?
    private var cancelCurrent: (() -> Void)?
    init(transport: NativeTransport, storage: ProtectedHealthFileStorage, collector: HealthKitCollector, exclusivity: any MobileControlExclusivity = UnavailableMobileControlExclusivity()) {
        self.transport = transport; self.custody = MobileControlCustody(storage: storage); self.legacyStorage = storage; self.exclusivity = exclusivity
        self.restrict = { enrollment in try collector.pause(enrollment: enrollment) }
    }
    /// Synthetic external storage and collector seam; no production authority is supplied.
    init(transport: NativeTransport, storage: any HealthSnapshotStorage, exclusivity: any MobileControlExclusivity, restrict: @escaping (UUID) throws -> Void) {
        self.transport=transport;self.custody=MobileControlCustody(storage:storage);self.legacyStorage=storage;self.exclusivity=exclusivity;self.restrict=restrict
    }
    private func claim(_ scope: MobileControlCustody.Scope) throws -> any MobileControlExclusiveLease {
        guard let lease = try exclusivity.acquire(serverDigest: scope.serverDigest, principal: scope.principal) else { throw Failure.unavailable }
        do {
            try lease.withFence {
                guard lease.isCurrent(serverDigest:scope.serverDigest,principal:scope.principal), try legacyStorage.read() == nil else { throw Failure.unavailable }
            }
            return lease
        } catch { lease.release(); throw error }
    }
    /// Cancellation invalidates callbacks. A request already sent remains held.
    func cancel() { precondition(Thread.isMainThread); token += 1; task?.cancel(); task = nil; cancelCurrent?() }
    private func number(_ value: Any?) -> Int? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
              n.doubleValue.rounded() == n.doubleValue, n.doubleValue >= 0, n.doubleValue <= 9007199254740991 else { return nil }
        return n.intValue
    }
    private func live(_ scope: MobileControlCustody.Scope, epoch: Int, origin: String) -> Bool {
        guard transport.epoch == epoch, transport.endpoint?.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == origin,
              transport.effectiveIsSelf, let owner = transport.currentEffectiveOwner else { return false }
        return UUID(uuidString: owner.principal) == scope.principal && UUID(uuidString: owner.session) == scope.session
    }
    private func snapshot(run: Int, _ done: @escaping (Result<Snapshot, Error>) -> Void) {
        guard token == run, let url = transport.endpoint, transport.effectiveIsSelf, let owner = transport.currentEffectiveOwner,
              let principal = UUID(uuidString: owner.principal), let session = UUID(uuidString: owner.session) else { done(.failure(Failure.currentness)); return }
        let origin = url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), epoch = transport.epoch
        let digest = SHA256.hash(data: Data(origin.utf8)).map { String(format: "%02x", $0) }.joined()
        task = transport.request("/api/auth/v1/user-context", maxBytes: 65536) { [self] response in
            guard token == run, case .success(let (data, http)) = response, http.statusCode == 200,
                  let a = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let pin = a["producerPin"] as? [String: String], pin == ["schemaId":"https://lifestream.dev/contracts/effective-subject/1.0.0", "schemaVersion":"1.0.0", "digest":"ed098cad970a310a807881ea7a833b96f1c980e8377ee3cfcbdffd68f2bd0cf9"],
                  let c = a["context"] as? [String: Any], Set(c.keys) == Set(["schemaVersion","actorId","effectiveUserId","authenticatedSessionId","installationId","authorityRevision","generation","issuedAt"]), c["schemaVersion"] as? String == "1.0.0",
                  let actor = a["actor"] as? [String: Any], let effective = a["effectiveUser"] as? [String: Any],
                  let impersonating = a["impersonating"] as? NSNumber, CFGetTypeID(impersonating) == CFBooleanGetTypeID(), !impersonating.boolValue,
                  let ref = a["contextRef"] as? String, !ref.isEmpty, ref.utf8.count <= 512,
                  UUID(uuidString: c["actorId"] as? String ?? "") == principal, UUID(uuidString: c["effectiveUserId"] as? String ?? "") == principal,
                  UUID(uuidString: actor["principalId"] as? String ?? "") == principal, UUID(uuidString: effective["principalId"] as? String ?? "") == principal,
                  UUID(uuidString: c["authenticatedSessionId"] as? String ?? "") == session,
                  UUID(uuidString: c["installationId"] as? String ?? "") != nil, number(c["authorityRevision"]) != nil, number(c["generation"]) != nil,
                  let issued = c["issuedAt"] as? String, issued.hasSuffix("Z"),
                  let subject = try? JSONSerialization.data(withJSONObject: c, options: [.sortedKeys, .withoutEscapingSlashes]) else { done(.failure(Failure.currentness)); return }
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if formatter.date(from: issued) == nil { formatter.formatOptions = [.withInternetDateTime]; guard formatter.date(from: issued) != nil else { done(.failure(Failure.currentness)); return } }
            // Check lifecycle before requesting endpoint authority.
            guard transport.epoch == epoch, transport.endpoint?.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == origin,
                  transport.effectiveIsSelf, let current = transport.currentEffectiveOwner,
                  UUID(uuidString: current.principal) == principal, UUID(uuidString: current.session) == session else { done(.failure(Failure.currentness)); return }
            self.task = transport.request("/api/runtime/v1/session-context", maxBytes: 65536) { [self] result in
                guard token == run, case .success(let (bytes, http)) = result, http.statusCode == 200,
                      let j = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                      let ended = j["ended"] as? NSNumber, CFGetTypeID(ended) == CFBooleanGetTypeID(), !ended.boolValue,
                      let revision = number(j["revision"]), let generation = number(j["contextGeneration"]),
                      let endpoint = j["endpoint"] as? [String: Any], let endpointID = UUID(uuidString: endpoint["endpointId"] as? String ?? ""),
                      endpoint["privacyClass"] as? String == "personal", let endpointRevision = number(endpoint["configurationRevision"]) else { done(.failure(Failure.currentness)); return }
                let scope = MobileControlCustody.Scope(serverDigest: digest, principal: principal, endpoint: endpointID, session: session)
                guard live(scope, epoch: epoch, origin: origin) else { done(.failure(Failure.currentness)); return }
                done(.success(Snapshot(scope: scope, epoch: epoch, revision: revision, contextGeneration: generation, endpointRevision: endpointRevision, origin: origin, subject: subject)))
            }
        }
    }
    func apply(original: Data, proof: MobileHealthPolicyProof?, completion: @escaping (Result<MobileControlCustody.Settlement, Error>) -> Void) {
        // Legacy mutation has no qualified shared-ledger exclusion. It must not
        // write its separate journal or dispatch while another owner may hold it.
        precondition(Thread.isMainThread);completion(.failure(Failure.unavailable))
    }
    func reconcile(completion: @escaping (Result<MobileControlCustody.Settlement, Error>) -> Void) {
        run(original: nil, proof: nil, reconciliation: true, completion: completion)
    }
    private func run(original: Data?, proof: MobileHealthPolicyProof?, reconciliation: Bool, completion: @escaping (Result<MobileControlCustody.Settlement, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !active else { completion(.failure(Failure.busy)); return }
        active = true; token += 1; let run = token
        var finished = false, retained = false
        func finish(_ result: Result<MobileControlCustody.Settlement, Error>) {
            guard !finished else { return }; finished = true; self.active = false; self.task = nil; self.cancelCurrent = nil; completion(result)
        }
        cancelCurrent = { finish(retained ? .success(.held) : .failure(Failure.cancelled)) }
        snapshot(run: run) { [self] first in
            guard token == run else { finish(.failure(Failure.cancelled)); return }
            guard case .success(let initial) = first, live(initial.scope, epoch: initial.epoch, origin: initial.origin) else { finish(.failure(Failure.currentness)); return }
            do {
                let bytes: Data
                if reconciliation { bytes = try custody.reconciliation(serverDigest: initial.scope.serverDigest, principal: initial.scope.principal) }
                else { guard let original else { throw Failure.unavailable }; bytes = try custody.prepare(original: original, scope: initial.scope, proof: proof, restrict: restrict) }
                retained = true
                guard token == run, live(initial.scope, epoch: initial.epoch, origin: initial.origin), let body = String(data: bytes, encoding: .utf8) else { finish(.success(.held)); return }
                task = transport.request(MobileHealthWire.path, method: "POST", body: body, internalHealth: true, maxBytes: 65536) { response in
                    guard self.token == run, case .success(let (data, http)) = response, http.statusCode == 200 else { finish(.success(.held)); return }
                    self.snapshot(run: run) { second in
                        guard self.token == run, case .success(let final) = second, final == initial else { finish(.success(.held)); return }
                        finish(.success(self.custody.assess(scope: initial.scope, response: data, reconciliation: reconciliation)))
                    }
                }
            } catch { finish(.failure(error)) }
        }
    }
    /// Read-only A22 inspection/preview. No production bridge registers this owner.
    func readInterpretation(payload: Data, completion: @escaping (Result<InterpretationRead, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !active else { completion(.failure(Failure.busy)); return }
        active = true; token += 1; let run = token; var finished = false
        func finish(_ result: Result<InterpretationRead, Error>) {
            guard !finished else { return }; finished = true; self.active = false; self.task = nil; self.cancelCurrent = nil; completion(result)
        }
        cancelCurrent = { finish(.failure(Failure.cancelled)) }
        snapshot(run:run) { [self] first in
            guard token == run, case .success(let initial) = first, live(initial.scope,epoch:initial.epoch,origin:initial.origin) else { finish(.failure(Failure.currentness)); return }
            do {
                let envelope = try MobileInterpretation.readEnvelope(payload:payload)
                guard let body=String(data:envelope,encoding:.utf8) else { throw Failure.unavailable }
                task = transport.request(MobileHealthWire.path,method:"POST",body:body,internalHealth:true,maxBytes:262144) { response in
                    guard self.token==run,case .success(let (data,http))=response,http.statusCode==200 else { finish(.failure(Failure.unavailable));return }
                    self.snapshot(run:run) { second in
                        guard self.token==run,case .success(let final)=second,final==initial else { finish(.failure(Failure.currentness));return }
                        do {
                            let decoded = try MobileInterpretation.decodeRead(data,expectedPayload:payload,principal:initial.scope.principal,endpoint:initial.scope.endpoint)
                            let reviewed = decoded.preview.map { ReviewedPreview(preview:$0,snapshot:initial) }
                            finish(.success(InterpretationRead(result:decoded,reviewedPreview:reviewed)))
                        }
                        catch { finish(.failure(error)) }
                    }
                }
            } catch { finish(.failure(error)) }
        }
    }
    func applyInterpretation(preview: ReviewedPreview, proof: MobileHealthPolicyProof?, completion: @escaping (Result<MobileInterpretation.Settlement, Error>) -> Void) {
        // The legacy mutation path lacks the qualified shared-ledger lease.
        precondition(Thread.isMainThread);completion(.failure(Failure.unavailable))
    }
    func reconcileInterpretation(completion: @escaping (Result<MobileInterpretation.Settlement, Error>) -> Void) {
        runInterpretation(preview:nil,proof:nil,completion:completion)
    }
    private func runInterpretation(preview: ReviewedPreview?, proof: MobileHealthPolicyProof?, completion: @escaping (Result<MobileInterpretation.Settlement, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !active else { completion(.failure(Failure.busy)); return }
        active = true; token += 1; let run = token; var finished=false, retained=false
        func finish(_ result:Result<MobileInterpretation.Settlement,Error>) {
            guard !finished else{return};finished=true;self.active=false;self.task=nil;self.cancelCurrent=nil;completion(result)
        }
        cancelCurrent = { finish(retained ? .success(.held):.failure(Failure.cancelled)) }
        snapshot(run:run) { [self] first in
            guard token==run,case .success(let initial)=first,live(initial.scope,epoch:initial.epoch,origin:initial.origin) else{finish(.failure(Failure.currentness));return}
            do {
                let original:Data, envelope:Data
                if let reviewed = preview {
                    guard initial == reviewed.snapshot else { throw Failure.currentness }
                    original = try custody.prepareReviewedOriginal(original:reviewed.preview.original,scope:initial.scope,proof:proof,restrict:restrict)
                    retained=true
                    envelope = try MobileInterpretation.reviewedEnvelope(preview:reviewed.preview,stagedOriginal:original)
                } else {
                    original = try custody.retainedOriginalForReconciliation(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal)
                    retained=true
                    envelope = try MobileInterpretation.reconciliationEnvelope(original:original)
                }
                guard token==run,live(initial.scope,epoch:initial.epoch,origin:initial.origin),let body=String(data:envelope,encoding:.utf8) else{finish(.success(.held));return}
                task=transport.request(MobileHealthWire.path,method:"POST",body:body,internalHealth:true,maxBytes:262144) { response in
                    guard self.token==run,case .success(let (data,http))=response,http.statusCode==200 else{finish(.success(.held));return}
                    self.snapshot(run:run) { second in
                        guard self.token==run,case .success(let final)=second,final==initial else{finish(.success(.held));return}
                        finish(.success(MobileInterpretation.assessMutation(data,original:original,expectedRevision:preview?.preview.nextRevision)))
                    }
                }
            } catch { finish(retained ? .success(.held):.failure(error)) }
        }
    }

    /// Stage an ordinary intent with a qualified lease. The direct producer
    /// reply is observational; only the separate reconcile path settles it.
    func applyOrdinaryWithLedger(original: Data, proof: MobileHealthPolicyProof?, ledger: MobileControlSettlementLedger, completion: @escaping (Result<MobileControlCustody.Settlement, Error>) -> Void) {
        precondition(Thread.isMainThread); guard !active else { completion(.failure(Failure.busy)); return }
        active=true;token+=1;let run=token;var finished=false,retained=false;var lease:(any MobileControlExclusiveLease)?
        func finish(_ result:Result<MobileControlCustody.Settlement,Error>){guard !finished else{return};finished=true;DispatchQueue.main.async {lease?.release();self.active=false;self.task=nil;self.cancelCurrent=nil;completion(result)}}
        cancelCurrent={} // Wait for the outstanding transport callback to drain before releasing the lease.
        snapshot(run:run) { [self] first in
            guard token==run,case .success(let initial)=first,live(initial.scope,epoch:initial.epoch,origin:initial.origin) else { finish(.failure(Failure.currentness));return }
            do {
                let scoped=MobileControlSettlementLedger.Scope(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal,endpoint:initial.scope.endpoint,session:initial.scope.session)
                let acquired=try claim(initial.scope);lease=acquired
                let narrowed=try acquired.withFence { guard acquired.isCurrent(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal),token==run,live(initial.scope,epoch:initial.epoch,origin:initial.origin) else {throw Failure.currentness};return try MobileControlCustody.narrowForReviewedOriginal(original:original,scope:initial.scope,proof:proof,restrict:restrict) }
                let envelope=try MobileOrdinaryControl.envelope(original:narrowed,operation:.control)
                guard envelope.count<=65536,let body=String(data:envelope,encoding:.utf8),token==run,acquired.isCurrent(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal),live(initial.scope,epoch:initial.epoch,origin:initial.origin) else {finish(.failure(Failure.currentness));return}
                // A failed store/CAS may have changed durable state; report held
                // even if staging throws before its success is observable.
                retained=true;_ = try ledger.stageOrdinary(scope:scoped,original:narrowed,lease:acquired)
                guard token==run,acquired.isCurrent(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal),live(initial.scope,epoch:initial.epoch,origin:initial.origin) else {finish(.success(.held));return}
                task=try acquired.withFence {
                    guard token==run,acquired.isCurrent(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal),live(initial.scope,epoch:initial.epoch,origin:initial.origin) else {throw Failure.currentness}
                    return transport.request(MobileHealthWire.path,method:"POST",body:body,internalHealth:true,maxBytes:524288) { _ in DispatchQueue.main.async { finish(.success(.held)) } }
                }
            } catch {finish(retained ? .success(.held):.failure(error))}
        }
    }
    func reconcileOrdinaryWithLedger(ledger: MobileControlSettlementLedger, revalidateSettled: Bool = false, completion: @escaping (Result<MobileControlCustody.Settlement, Error>) -> Void) {
        precondition(Thread.isMainThread);guard !active else {completion(.failure(Failure.busy));return}
        active=true;token+=1;let run=token;var finished=false;var lease:(any MobileControlExclusiveLease)?
        func finish(_ result:Result<MobileControlCustody.Settlement,Error>){guard !finished else{return};finished=true;DispatchQueue.main.async {lease?.release();self.active=false;self.task=nil;self.cancelCurrent=nil;completion(result)}}
        cancelCurrent={} // Wait for the outstanding transport callback to drain before releasing the lease.
        snapshot(run:run) { [self] first in
            guard token==run,case .success(let initial)=first,live(initial.scope,epoch:initial.epoch,origin:initial.origin) else {finish(.success(.held));return}
            do {
                let scoped=MobileControlSettlementLedger.Scope(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal,endpoint:initial.scope.endpoint,session:initial.scope.session)
                let acquired=try claim(initial.scope);lease=acquired
                let original=try revalidateSettled ? ledger.lastSettledControlOriginal(scope:scoped):ledger.pendingOrdinary(scope:scoped)
                guard let original else {finish(.success(.held));return}
                let envelope=try MobileOrdinaryControl.envelope(original:original,operation:.reconcile)
                guard envelope.count<=65536,let body=String(data:envelope,encoding:.utf8),token==run,acquired.isCurrent(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal),live(initial.scope,epoch:initial.epoch,origin:initial.origin) else {finish(.success(.held));return}
                task=try acquired.withFence {
                    guard token==run,acquired.isCurrent(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal),live(initial.scope,epoch:initial.epoch,origin:initial.origin) else {throw Failure.currentness}
                    return transport.request(MobileHealthWire.path,method:"POST",body:body,internalHealth:true,maxBytes:524288) { response in
                    DispatchQueue.main.async {
                    guard self.token==run,acquired.isCurrent(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal),self.live(initial.scope,epoch:initial.epoch,origin:initial.origin),case .success(let (data,http))=response,http.statusCode==200 else{finish(.success(.held));return}
                    self.snapshot(run:run) { second in
                        guard self.token==run,case .success(let final)=second,final==initial,acquired.isCurrent(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal) else{finish(.success(.held));return}
                        let status=MobileOrdinaryControl.assessTerminal(response:data,original:original)
                        do {
                            guard status != .held else{finish(.success(.held));return}
                            if revalidateSettled {try ledger.revalidateAuthenticatedOrdinaryTerminal(scope:scoped,response:data,lease:acquired)}
                            else {try ledger.appendAuthenticatedOrdinaryTerminal(scope:scoped,response:data,lease:acquired)}
                            finish(.success(status == .applied ? .applied : .rejected))
                        } catch {finish(.success(.held))}
                    }
                    }
                    }
                }
            } catch {finish(.success(.held))}
        }
    }

    /// Versioned settlement experiment. The supplied ledger must use an
    /// independently qualified witness; no production caller registers this.
    func applyInterpretationWithLedger(preview:ReviewedPreview,proof:MobileHealthPolicyProof?,ledger:MobileControlSettlementLedger,completion:@escaping(Result<MobileInterpretation.Settlement,Error>)->Void) {
        precondition(Thread.isMainThread);guard !active else{completion(.failure(Failure.busy));return}
        active=true;token+=1;let run=token;var finished=false,retained=false;var lease:(any MobileControlExclusiveLease)?
        func finish(_ result:Result<MobileInterpretation.Settlement,Error>){guard !finished else{return};finished=true;DispatchQueue.main.async {lease?.release();self.active=false;self.task=nil;self.cancelCurrent=nil;completion(result)}}
        cancelCurrent={} // Wait for the outstanding transport callback to drain before releasing the lease.
        snapshot(run:run){[self] first in
            guard token==run,case .success(let initial)=first,initial==preview.snapshot,live(initial.scope,epoch:initial.epoch,origin:initial.origin) else{finish(.failure(Failure.currentness));return}
            do {
                let scoped=MobileControlSettlementLedger.Scope(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal,endpoint:initial.scope.endpoint,session:initial.scope.session)
                let acquired=try claim(initial.scope);lease=acquired
                let narrowed=try acquired.withFence { guard acquired.isCurrent(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal),token==run,live(initial.scope,epoch:initial.epoch,origin:initial.origin) else {throw Failure.currentness};return try MobileControlCustody.narrowForReviewedOriginal(original:preview.preview.original,scope:initial.scope,proof:proof,restrict:restrict) }
                guard narrowed==preview.preview.original,acquired.isCurrent(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal),token==run,live(initial.scope,epoch:initial.epoch,origin:initial.origin) else{finish(.failure(Failure.currentness));return}
                retained=true
                let original=try ledger.stageInterpretation(scope:scoped,preview:preview.preview,lease:acquired)
                let envelope=try MobileInterpretation.reviewedEnvelope(preview:preview.preview,stagedOriginal:original)
                guard token==run,acquired.isCurrent(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal),live(initial.scope,epoch:initial.epoch,origin:initial.origin),let body=String(data:envelope,encoding:.utf8) else{finish(.success(.held));return}
                task=try acquired.withFence {
                    guard token==run,acquired.isCurrent(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal),live(initial.scope,epoch:initial.epoch,origin:initial.origin) else {throw Failure.currentness}
                    return transport.request(MobileHealthWire.path,method:"POST",body:body,internalHealth:true,maxBytes:262144){ response in
                    DispatchQueue.main.async {
                    guard self.token==run,acquired.isCurrent(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal),self.live(initial.scope,epoch:initial.epoch,origin:initial.origin),case .success(let (data,http))=response,http.statusCode==200 else{finish(.success(.held));return}
                    self.snapshot(run:run){ second in
                        guard self.token==run,case .success(let final)=second,final==initial else{finish(.success(.held));return}
                        // Direct apply is observed only. It does not settle the ledger.
                        finish(.success(MobileInterpretation.assessMutation(data,original:original,expectedRevision:preview.preview.nextRevision)))
                    }
                    }
                    }
                }
            } catch {finish(retained ? .success(.held):.failure(error))}
        }
    }
    /// Reconcile the exact witnessed original; append its terminal receipt only
    /// after fresh actual Auth/currentness checks on both sides of the request.
    func reconcileInterpretationWithLedger(ledger:MobileControlSettlementLedger,revalidateSettled:Bool=false,completion:@escaping(Result<MobileInterpretation.Settlement,Error>)->Void) {
        precondition(Thread.isMainThread);guard !active else{completion(.failure(Failure.busy));return}
        active=true;token+=1;let run=token;var finished=false;var lease:(any MobileControlExclusiveLease)?
        func finish(_ result:Result<MobileInterpretation.Settlement,Error>){guard !finished else{return};finished=true;DispatchQueue.main.async {lease?.release();self.active=false;self.task=nil;self.cancelCurrent=nil;completion(result)}}
        cancelCurrent={} // Wait for the outstanding transport callback to drain before releasing the lease.
        snapshot(run:run){[self] first in
            guard token==run,case .success(let initial)=first,live(initial.scope,epoch:initial.epoch,origin:initial.origin) else{finish(.success(.held));return}
            do {
                let scoped=MobileControlSettlementLedger.Scope(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal,endpoint:initial.scope.endpoint,session:initial.scope.session)
                let acquired=try claim(initial.scope);lease=acquired
                let record=try revalidateSettled ? ledger.lastSettledOriginal(scope:scoped):ledger.pending(scope:scoped)
                guard let record else{finish(.success(.held));return}
                let envelope=try MobileInterpretation.reconciliationEnvelope(original:record.original)
                guard token==run,acquired.isCurrent(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal),live(initial.scope,epoch:initial.epoch,origin:initial.origin),let body=String(data:envelope,encoding:.utf8) else{finish(.success(.held));return}
                task=try acquired.withFence {
                    guard token==run,acquired.isCurrent(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal),live(initial.scope,epoch:initial.epoch,origin:initial.origin) else {throw Failure.currentness}
                    return transport.request(MobileHealthWire.path,method:"POST",body:body,internalHealth:true,maxBytes:262144){ response in
                    DispatchQueue.main.async {
                    guard self.token==run,acquired.isCurrent(serverDigest:initial.scope.serverDigest,principal:initial.scope.principal),self.live(initial.scope,epoch:initial.epoch,origin:initial.origin),case .success(let (data,http))=response,http.statusCode==200 else{finish(.success(.held));return}
                    self.snapshot(run:run){ second in
                        guard self.token==run,case .success(let final)=second,final==initial else{finish(.success(.held));return}
                        let assessed=MobileInterpretation.assessMutation(data,original:record.original,expectedRevision:record.expectedRevision)
                        do {
                            switch assessed {
                            case .applied,.rejected:
                                if revalidateSettled {try ledger.revalidateAuthenticatedInterpretationTerminal(scope:scoped,response:data,lease:acquired)}
                                else {try ledger.appendAuthenticatedInterpretationTerminal(scope:scoped,response:data,lease:acquired)}
                                finish(.success(assessed))
                            case .held:finish(.success(.held))
                            }
                        } catch {finish(.success(.held))}
                    }
                    }
                    }
                }
            } catch {finish(.success(.held))}
        }
    }

}
