import Foundation
import CryptoKit
@testable import AssistantCore

final class Store: ConnectionStore { var value: SavedConnection?; func load() throws -> SavedConnection? { value }; func save(_ v: SavedConnection) throws { value = v } }
final class Disk: HealthSnapshotStorage { var data: Data?; func read() throws -> Data? { data }; func replace(_ bytes: Data) throws { data = bytes } }
// Existing internal Share seam, supplied only with synthetic in-memory test authority.
final class SyntheticShareAuthority: OutboxShareAuthority {
    let lock = NSRecursiveLock()
    func withFence<T>(_ body: () throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try body() }
    func permits(_ context: OutboxShareContext, reading: Bool) -> Bool { context.epoch == 1 }
}
final class SyntheticShareLease: SharedCaptureReadLease {
    let originalSelectionContext: any SharedCaptureBinding
    var chunks: [Data?]
    init(_ context: OutboxShareContext, _ chunks: [Data?]) { originalSelectionContext = context; self.chunks = chunks }
    func check() throws {}
    func read(maxBytes: Int) throws -> Data? { chunks.removeFirst() }
    func close() {}
}
final class Suspender: NativeHealthPolicySuspending {
    let outbox: HealthOutbox
    var onSuspend: (() -> Void)?
    init(_ outbox: HealthOutbox) { self.outbox = outbox }
    func suspendForPolicyRefresh(enrollment: UUID) { outbox.invalidatePolicy(enrollment: enrollment); onSuspend?() }
}
let human = UUID(uuidString: "50000000-0000-4000-8000-000000000001")!
let enrollment = UUID(uuidString: "00000000-0000-4000-8000-000000000002")!
let session = UUID(uuidString: "00000000-0000-4000-8000-000000000003")!
let endpoint = UUID(uuidString: "60000000-0000-4000-8000-000000000001")!
let namespace = "00000000-0000-4000-8000-000000000004"
let pin = ["schemaId": MobileHealthEncoder.schemaId, "schemaVersion": "1.0.0", "digest": MobileHealthEncoder.schemaSHA256]
let config: [String: Any] = ["categories": ["SleepSegment"], "uses": [], "assistantIds": [], "collectionPaused": false, "usePaused": false]
let enrollmentJSON: [String: Any] = ["enrollmentId": enrollment.uuidString.lowercased(), "principalId": human.uuidString.lowercased(), "endpointId": endpoint.uuidString.lowercased(), "collector": "healthKit", "sourceNamespace": namespace, "revision": 1, "state": "active", "configuration": config]
let effective: [String: Any] = ["policyRevision": 1, "sourceBound": true, "collectionAllowed": true, "categories": ["SleepSegment"], "uses": [], "assistantIds": [], "sourceNamespace": namespace]
let policyJSON: [String: Any] = ["schemaVersion": "1.0.0", "producerPin": pin, "result": ["enrollment": enrollmentJSON, "effective": effective]]
let mode = CommandLine.arguments[1]
var contexts = 0, ingests = 0, unexpected = 0, revision = 1
var authPrincipal = human.uuidString, authSession = session.uuidString
var collectorHeld = false
var held: (() -> Void)?, collected: ((Result<Void, Error>) -> Void)?, lateCollected: ((Result<Void, Error>) -> Void)?
func check(_ condition: @autoclosure () -> Bool, _ reason: String) { if !condition() { fputs("FAIL: \(reason)\n", stderr); exit(1) } }
func later(_ action: @escaping () -> Void) { DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: action) }
func requestBody(_ request: URLRequest) -> Data {
    if let data = request.httpBody { return data }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open(); defer { stream.close() }; var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }; return data
}
final class Offline: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        DispatchQueue.main.async { [self] in
            guard request.url?.host == "offline.invalid" else { unexpected += 1; client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return }
            let path = request.url?.path ?? ""
            var object: [String: Any]
            switch path {
            case "/api/auth/v1/user-context":
                object = ["contextRef": "synthetic", "context": ["actorId": authPrincipal, "effectiveUserId": authPrincipal, "authenticatedSessionId": authSession]]
            case "/api/runtime/v1/session-context":
                contexts += 1
                if mode.hasPrefix("drift-"), let target = Int(mode.dropFirst(6)), contexts == target { revision = 2 }
                if mode == "invalid-presync" && contexts == 4 { revision = 2 }
                let changed = contexts == 4
                let endpointID = changed && mode == "drift-endpoint" ? UUID().uuidString : endpoint.uuidString
                let privacy = changed && mode == "drift-privacy" ? "public" : "personal"
                object = ["ended": changed && mode == "drift-ended", "revision": revision, "contextGeneration": changed && mode == "drift-generation" ? 2 : 1, "endpoint": ["endpointId": endpointID, "privacyClass": privacy, "configurationRevision": changed && mode == "drift-endpoint-revision" ? 2 : 1]]
            case "/api/runtime/v1/mobile-context":
                let body = (try? JSONSerialization.jsonObject(with: requestBody(request))) as? [String: Any]
                if body?["operation"] as? String == "policy" { object = policyJSON }
                else if body?["operation"] as? String == "ingest", let payload = body?["payload"] as? [String: Any], let changes = payload["changes"] as? [[String: Any]], let id = changes.first?["eventId"] as? String {
                    ingests += 1
                    let receipt: [String: Any] = ["eventId": id, "outcome": "accepted", "code": "deleted"]
                    if mode == "network-error" && ingests == 1 { client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)); return }
                    var receipts: [[String: Any]] = [receipt]
                    if ingests == 1 && mode == "receipt-missing" { receipts = [] }
                    if ingests == 1 && mode == "receipt-duplicate" { receipts = [receipt, receipt] }
                    if ingests == 1 && mode == "receipt-unknown" { receipts = [["eventId": UUID().uuidString.lowercased(), "outcome": "accepted", "code": "deleted"]] }
                    object = ["schemaVersion": "1.0.0", "producerPin": pin, "result": receipts]
                } else { unexpected += 1; client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return }
            default: unexpected += 1; client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return
            }
            let bytes = try! JSONSerialization.data(withJSONObject: object)
            let respond = { [self] in
                guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) else { exit(2) }
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: bytes); client?.urlProtocolDidFinishLoading(self)
            }
            let preIdentity = mode.hasPrefix("identity-pre-") && path == "/api/runtime/v1/session-context" && contexts == 5
            let postIdentity = mode.hasPrefix("identity-post-") && path == "/api/runtime/v1/mobile-context" && ingests == 1 && (try? JSONSerialization.jsonObject(with: requestBody(request)) as? [String: Any])?["operation"] as? String == "ingest"
            if preIdentity || postIdentity {
                if mode.hasSuffix("-epoch") { transport.epoch += 1; respond(); return }
                if mode.hasSuffix("-origin") { transport.endpoint = URL(string: "https://changed.invalid")!; respond(); return }
                if mode.hasSuffix("-human") { authPrincipal = UUID().uuidString }
                if mode.hasSuffix("-session") { authSession = UUID().uuidString }
                transport.request("/api/auth/v1/user-context") { _ in respond() }
                return
            }
            if ((mode == "policy-cancel" && contexts == 3) || (mode.hasPrefix("context-cancel-") && contexts == Int(mode.dropFirst(15)))) && path == "/api/runtime/v1/session-context" { held = respond }
            else if mode == "sender-cancel" && path == "/api/runtime/v1/mobile-context" && ingests == 1 && (try? JSONSerialization.jsonObject(with: requestBody(request)) as? [String: Any])?["operation"] as? String == "ingest" { held = respond }
            else { respond() }
        }
    }
    override func stopLoading() {}
}
let disk = Disk(), shareAuthority = SyntheticShareAuthority(), outbox = HealthOutbox(storage: disk, shareAuthority: shareAuthority)
let proof = try! MobileHealthPolicyParser.parse(try! JSONSerialization.data(withJSONObject: policyJSON), expectedPrincipal: human, expectedEndpoint: endpoint, expectedEnrollment: enrollment)
try! outbox.setHuman(human); try! outbox.enroll(proof: proof, selectedTypes: ["sleep"])
let fixtureURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["CALENDAR_FIXTURE"]!)
let fixture = try! JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as! [String: Any]
let calendarEnrollment = UUID(uuidString: "30000000-0000-4000-8000-000000000001")!
let calendarProof = try! MobileCalendarPolicyParser.parse(try! JSONSerialization.data(withJSONObject: fixture["policy"]!), expectedPrincipal: human, expectedEndpoint: endpoint, expectedEnrollment: calendarEnrollment)
try! outbox.admitCalendar(proof: calendarProof)
let calendarTicket = try! outbox.calendarTicket(enrollment: calendarEnrollment, category: "CalendarEvent")
var calendarItem = (fixture["vectors"] as! [[String: Any]])[0]["item"] as! [String: Any]
var calendarChange = calendarItem["change"] as! [String: Any]; calendarChange["expectedPolicyRevision"] = calendarProof.revision; calendarItem["change"] = calendarChange
let calendarData = try! JSONSerialization.data(withJSONObject: calendarItem, options: [.sortedKeys, .withoutEscapingSlashes])
let calendarScope = try! MobileCalendarDelivery.CheckpointScope(collector: calendarProof.collector, namespace: calendarProof.namespace, mappingVersion: "synthetic-calendar-mapping/1", coverage: .partial, start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z")
try! outbox.commitCalendar(scope: calendarScope, expectedCheckpoint: nil, nextCheckpoint: Data([9]), items: [calendarData], ticket: calendarTicket)
let calendarPending = try! outbox.pendingCalendar(ticket: calendarTicket)

let ticket = try! outbox.ticket(enrollment: enrollment, type: "sleep")
let item = HealthChange(upstreamId: "synthetic", operation: .delete, body: nil, expectedPolicyRevision: 1, mappingVersion: "healthkit-v1")
let invalidItem = HealthChange(upstreamId: "invalid-synthetic", operation: .upsert, body: Data([1]), expectedPolicyRevision: 1, mappingVersion: "healthkit-v1")
try! outbox.commit(scope: "synthetic", expectedAnchor: nil, nextAnchor: Data([1]), changes: mode == "invalid-presync" ? [item, invalidItem] : [item], ticket: ticket)
let shareBytes = Data([0, 1, 2, 3, 255])
let shareText = try! String(contentsOfFile: ProcessInfo.processInfo.environment["SHARE_FIXTURE"]!, encoding: .utf8).replacingOccurrences(of: "\\ud800", with: "__UNPAIRED__")
let shareFixture = try! JSONSerialization.jsonObject(with: Data(shareText.utf8)) as! [String: Any]
let sharePairs = shareFixture["pairs"] as! [[String: Any]]
var shareItem = sharePairs.first { $0["case"] as? String == "file-reference" }!["ios"] as! [String: Any]
var shareContent = shareItem["content"] as! [String: Any], artifact = shareContent["artifact"] as! [String: Any]
artifact["byteLength"] = shareBytes.count; artifact["sha256"] = SHA256.hash(data: shareBytes).map { String(format: "%02x", $0) }.joined(); shareContent["artifact"] = artifact; shareItem["content"] = shareContent
let shareRaw = try! JSONSerialization.data(withJSONObject: shareItem, options: [.sortedKeys, .withoutEscapingSlashes])
let shareValue = try! MobileSharedItem.decode(shareRaw), shareAttemptID = UUID(), leaseID = UUID()
func shareContext(_ recovery: Bool) -> OutboxShareContext { OutboxShareContext(owner: outbox, human: human, endpoint: endpoint, namespace: shareValue.source.namespace, collector: shareValue.source.collector, epoch: 1, leaseToken: leaseID, recoveryOnly: recovery) }
let initialContext = shareContext(false)
let shareInitial = MobileSharedCapture.capture(itemJSON: shareRaw, attempt: OutboxShareAttempt(shareAttemptID, context: initialContext), lease: SyntheticShareLease(initialContext, [shareBytes, nil]), owner: outbox)
if case .portAcknowledged = shareInitial {} else { check(false, "synthetic Share setup") }

let transport = NativeTransport(store: Store()); try! transport.configure("https://offline.invalid", username: "synthetic")
let cfg = URLSessionConfiguration.ephemeral; cfg.protocolClasses = [Offline.self]
transport.session = URLSession(configuration: cfg, delegate: transport, delegateQueue: OperationQueue.main)
let suspender = Suspender(outbox)
if mode == "policy-epoch-race" { suspender.onSuspend = { transport.epoch += 1 } }
let hooks = NativeHealthSessionOwner.CollectorHooks(policySuspender: suspender, collect: { _, done in
    if (mode == "collector-cancel" || mode == "collector-hung" || mode == "collector-late") && !collectorHeld { collectorHeld = true; collected = done }
    else if mode == "collector-background" { DispatchQueue.global().async { done(.success(())) } }
    else { if mode == "drift" { revision = 2 }; done(.success(())) }
}, stop: {})
let owner = NativeHealthSessionOwner(transport: transport, outbox: outbox, collector: hooks)
let scope = NativeHealthSessionOwner.Scope(human: human, enrollment: enrollment, endpoint: endpoint, category: "sleep")
var completions = 0
func complete(_ result: Result<HealthSyncCoordinator.Completion, Error>) {
    completions += 1
    if mode == "happy" || mode == "collector-background" { check((try? result.get()) == .applied, "happy settlement: \(result), contexts=\(contexts), ingests=\(ingests), unexpected=\(unexpected)"); check(ingests == 1 && unexpected == 0, "offline single ingest"); print("\(mode) passed"); exit(0) }
    if mode == "policy-epoch-race" || mode == "invalid-presync" {
        check((try? result.get()) == nil, "stale failure")
        check((try? outbox.ticket(enrollment: enrollment, type: "sleep")) == nil, "stale policy proof must be invalidated")
        let status = try! outbox.status(enrollment: enrollment)
        check(status.pending == (mode == "invalid-presync" ? 2 : 1) && status.quarantined == 0 && ingests == 0, "stale pre-sync leaves queue and quarantine intact")
        check((try? outbox.pendingCalendar(ticket: calendarTicket)) == calendarPending, "stale preserves Calendar")
        print("\(mode) passed"); exit(0)
    }
    if mode.hasPrefix("identity-") {
        check((try? result.get()) == nil || (try? result.get()) == .retry, "identity change rejected")
        check((try? outbox.ticket(enrollment: enrollment, type: "sleep")) == nil, "identity failure invalidates Health proof")
        check((try! outbox.status(enrollment: enrollment)).pending == 1 && unexpected == 0, "identity failure preserves queue and stays offline")
        check((try? outbox.pendingCalendar(ticket: calendarTicket)) == calendarPending, "identity failure preserves Calendar")
        check(ingests == (mode.hasPrefix("identity-post-") ? 1 : 0), "identity change fenced at intended boundary")
        print("\(mode) passed"); exit(0)
    }
    if ["receipt-missing", "receipt-duplicate", "receipt-unknown", "network-error"].contains(mode) {
        check((try? result.get()) == .retry || (try? result.get()) == .invalidReceipt, "bad receipt or transport failure held")
        check((try? outbox.ticket(enrollment: enrollment, type: "sleep")) == nil, "failed admission invalidated")
        check((try! outbox.status(enrollment: enrollment)).pending == 1, "failed receipt retains Health queue")
        check((try? outbox.pendingCalendar(ticket: calendarTicket)) == calendarPending, "failed receipt preserves Calendar")
        later { owner.run(scope: scope) { retry in
            check((try? retry.get()) == .applied && ingests == 2 && unexpected == 0, "fresh retry settles queue")
            print("\(mode) passed"); exit(0)
        } }
        return
    }
    if mode.hasPrefix("drift") { check((try? result.get()) == nil || (try? result.get()) == .retry, "drift rejected"); check(ingests == (mode == "drift-6" ? 1 : 0) && unexpected == 0, "drift fence"); print("\(mode) passed"); exit(0) }
    check((try? result.get()) == nil, "cancellation reported")
}
transport.request("/api/auth/v1/user-context") { result in
    check((try? result.get()) != nil && transport.effectiveIsSelf, "synthetic auth")
    if mode == "sender-duplicate" {
        let sender = NativeHealthDelivery(transport: transport, outbox: outbox)
        let batch = try! MobileHealthEncoder.batch([item], enrollment: enrollment, sourceNamespace: ticket.sourceNamespace, category: "sleep")
        let gate = NativeHealthDelivery.Currentness(refresh: { done in done(.success(())); done(.success(())) }, isCurrent: { true })
        sender.send(ticket: ticket, batch: batch.data, currentness: gate) { result in
            completions += 1; check((try? result.get())?.count == 1, "duplicate sender result")
            later { check(completions == 1 && ingests == 1 && unexpected == 0, "duplicate callbacks ignored"); print("sender-duplicate passed"); exit(0) }
        }
        return
    }
    owner.run(scope: scope, completion: complete)
    if mode == "policy-cancel" || mode == "collector-cancel" || mode == "sender-cancel" || mode == "collector-hung" || mode == "collector-late" || mode.hasPrefix("context-cancel-") {
        func waitForPhase() {
            guard ((mode == "collector-cancel" || mode == "collector-hung" || mode == "collector-late") ? collected != nil : held != nil) else { later(waitForPhase); return }
            let before = disk.data
            let pendingContext = shareContext(false), pendingAttempt = OutboxShareAttempt(UUID(), context: pendingContext)
            let digest = SHA256.hash(data: shareValue.data).map { String(format: "%02x", $0) }.joined()
            let reservation: any SharedCaptureReservation
            if case .reserved(let r, _) = try! outbox.reserve(attempt: pendingAttempt, payloadDigest: digest, item: shareValue, context: pendingContext) { reservation = r } else { check(false, "Share reservation before cancel"); return }
            owner.cancel(); check(completions == 1, "one cancellation completion")
            if mode != "sender-cancel" {
                owner.run(scope: scope) { result in check((try? result.get()) == .deferred, "draining retry deferred") }
                check(disk.data == before, "cancel preserves snapshot")
                check((try? outbox.check(reservation)) != nil, "synthetic Share admission survives cancel")
                let recovery = shareContext(true)
                let recovered = MobileSharedCapture.capture(itemJSON: shareRaw, attempt: OutboxShareAttempt(shareAttemptID, context: recovery), lease: SyntheticShareLease(recovery, []), owner: outbox)
                if case .portAcknowledged = recovered {} else { check(false, "synthetic Share pending survives cancel") }
                check((try? outbox.pendingCalendar(ticket: calendarTicket)) == calendarPending, "calendar admission and pending survive cancel")
            }
            if mode == "collector-hung" {
                later { owner.run(scope: scope) { result in check((try? result.get()) == .deferred, "hung collector remains busy"); check(completions == 1 && unexpected == 0, "hung cancel reported once"); print("collector-hung passed"); exit(0) } }
                return
            }
            if let pending = held { held = nil; pending() }
            if let pending = collected { collected = nil; if mode == "collector-late" { lateCollected = pending }; pending(.success(())) }
            later {
                check((try? outbox.ticket(enrollment: enrollment, type: "sleep")) == nil, "cancelled proof invalid")
                check(completions == 1, "no duplicate cancellation callback")
                if mode == "sender-cancel" { check(unexpected == 0, "offline"); print("sender-cancel passed"); exit(0) }
                owner.run(scope: scope) { result in
                    check((try? result.get()) == .applied, "same-human fresh retry")
                    check(unexpected == 0 && ingests == (mode == "context-cancel-6" ? 2 : 1), "offline retry")
                    if mode == "collector-late" { lateCollected?(.success(())); check((try? outbox.ticket(enrollment: enrollment, type: "sleep")) != nil, "late duplicate cannot revoke fresh proof") }
                    print("\(mode) passed"); exit(0)
                }
            }
        }
        later(waitForPhase)
    }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 12) { fputs("timeout \(mode)\n", stderr); exit(3) }
RunLoop.main.run()
