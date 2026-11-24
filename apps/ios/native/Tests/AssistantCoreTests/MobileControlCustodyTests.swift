import Foundation
import XCTest
@testable import AssistantCore

private final class CustodyMemory: HealthSnapshotStorage {
    var bytes: Data?
    var failWrite = false
    func read() throws -> Data? { bytes }
    func replace(_ data: Data) throws { if failWrite { throw CocoaError(.fileWriteNoPermission) }; bytes = data }
}
final class MobileControlCustodyTests: XCTestCase {
    func testOriginalPersistsAndReconciliationDoesNotReplaceIt() throws {
        let storage = CustodyMemory(), principal = UUID(), endpoint = UUID(), session = UUID()
        let scope = MobileControlCustody.Scope(serverDigest: String(repeating: "a", count: 64), principal: principal, endpoint: endpoint, session: session)
        let original = try JSONSerialization.data(withJSONObject: ["schemaVersion":"1.0.0", "operationId":UUID().uuidString.lowercased(), "target":["principalId":principal.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","enrollmentId":NSNull(),"sourceNamespace":NSNull(),"expectedRevision":0],"action":["kind":"enroll"]])
        let owner = MobileControlCustody(storage: storage)
        let request = try owner.prepare(original: original, scope: scope, proof: nil, restrict: { _ in XCTFail("enrollment is not a restriction") })
        XCTAssertEqual((try JSONSerialization.jsonObject(with: request) as? [String:Any])?["operation"] as? String, "control")
        let retained = try XCTUnwrap(storage.bytes)
        XCTAssertThrowsError(try owner.prepare(original: original, scope: scope, proof: nil, restrict: { _ in }))
        let restarted = MobileControlCustody(storage: storage)
        let reconcile = try restarted.reconciliation(serverDigest: scope.serverDigest, principal: principal)
        XCTAssertEqual((try JSONSerialization.jsonObject(with: reconcile) as? [String:Any])?["operation"] as? String, "reconcileControl")
        XCTAssertEqual(storage.bytes, retained)
        XCTAssertThrowsError(try restarted.reconciliation(serverDigest: scope.serverDigest, principal: UUID()))
        if case .held = restarted.assess(scope: scope, response: Data("{}".utf8), reconciliation: true) {} else { XCTFail("invalid receipt must stay held") }
        XCTAssertEqual(storage.bytes, retained)
    }
    func testReviewedStagingRetainsExactOriginalAndBlocksAnotherRequest() throws {
        let storage = CustodyMemory(), principal = UUID(), endpoint = UUID()
        let scope = MobileControlCustody.Scope(serverDigest: String(repeating: "b", count: 64), principal: principal, endpoint: endpoint, session: UUID())
        let original = try JSONSerialization.data(withJSONObject: ["schemaVersion":"1.0.0", "operationId":UUID().uuidString.lowercased(), "target":["principalId":principal.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","enrollmentId":NSNull(),"sourceNamespace":NSNull(),"expectedRevision":0], "action":["kind":"enroll"]])
        let custody = MobileControlCustody(storage:storage)
        let staged = try custody.prepareReviewedOriginal(original:original,scope:scope,proof:nil,restrict:{ _ in XCTFail("unexpected restriction") })
        XCTAssertEqual(staged, try MobileControlOriginal.parse(original).canonical)
        let before = try XCTUnwrap(storage.bytes)
        XCTAssertThrowsError(try custody.prepareReviewedOriginal(original:original,scope:scope,proof:nil,restrict:{ _ in }))
        XCTAssertEqual(storage.bytes,before)
        let reconcile = try custody.reconciliation(serverDigest:scope.serverDigest,principal:principal)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with:reconcile) as? [String:Any])
        let payload = try JSONSerialization.data(withJSONObject:XCTUnwrap(object["payload"]),options:[.sortedKeys,.withoutEscapingSlashes])
        XCTAssertEqual(payload,staged)
        XCTAssertEqual(storage.bytes,before)
    }
    func testFailedPersistenceStopsBeforeDispatch() throws {
        let storage = CustodyMemory(); storage.failWrite = true
        let p = UUID(), e = UUID(), scope = MobileControlCustody.Scope(serverDigest: String(repeating: "a", count: 64), principal:p, endpoint:e, session:UUID())
        let original = try JSONSerialization.data(withJSONObject:["schemaVersion":"1.0.0","operationId":UUID().uuidString.lowercased(),"target":["principalId":p.uuidString.lowercased(),"endpointId":e.uuidString.lowercased(),"collector":"healthKit","enrollmentId":NSNull(),"sourceNamespace":NSNull(),"expectedRevision":0],"action":["kind":"enroll"]])
        XCTAssertThrowsError(try MobileControlCustody(storage:storage).prepare(original:original,scope:scope,proof:nil,restrict:{ _ in }))
        XCTAssertNil(storage.bytes)
    }
}
