import XCTest
@testable import AssistantCore
final class BoundedVoiceAuditTests:XCTestCase {
    func testDiscoveryBreadcrumbsAreClosedAndIdentifyMissingInvalidExpiredAndRetired() throws {
        let now=Date(timeIntervalSince1970:1000),audit=BoundedVoiceAudit(now:{now}),sid=UUID().uuidString.lowercased()
        audit.updateFromAudience(statusCode:503,data:Data());XCTAssertEqual(audit.observation,.unavailable)
        audit.updateFromAudience(statusCode:200,data:Data("{}".utf8));XCTAssertEqual(audit.observation,.absent)
        audit.updateFromAudience(statusCode:200,data:Data("credential-sentinel".utf8));XCTAssertEqual(audit.observation,.invalid)
        audit.update(version:1,active:true,session:sid,expiresAt:now);XCTAssertEqual(audit.observation,.expired)
        audit.update(version:1,active:true,session:sid,expiresAt:now.addingTimeInterval(301));XCTAssertEqual(audit.observation,.deadlineOutOfRange)
        audit.update(version:1,active:true,session:sid,expiresAt:now.addingTimeInterval(60));XCTAssertEqual(audit.observation,.available)
        audit.invalidatePendingStatus();audit.update(version:1,active:true,session:sid,expiresAt:now.addingTimeInterval(60));XCTAssertEqual(audit.observation,.retired)
        XCTAssertFalse(audit.observation!.rawValue.contains("sentinel"))
    }
    func testOffByDefaultOnOffExpiryAndNoRestartPersistence(){
        var clock=Date(timeIntervalSince1970:1000);let audit=BoundedVoiceAudit(now:{clock});let sid=UUID().uuidString.lowercased()
        XCTAssertFalse(audit.active);XCTAssertFalse(audit.beginAttempt());XCTAssertNil(audit.correlation())
        audit.update(version:1,active:true,session:sid,expiresAt:clock.addingTimeInterval(300));XCTAssertTrue(audit.active);XCTAssertTrue(audit.beginAttempt());let labels=audit.correlation()!
        XCTAssertTrue(audit.record(.turnStarted,session:labels.session,attempt:labels.attempt,turn:1));audit.disarm()
        XCTAssertFalse(audit.record(.firstPCM,session:labels.session,attempt:labels.attempt,turn:1));XCTAssertEqual(audit.snapshot().count,1)
        XCTAssertFalse(BoundedVoiceAudit(now:{clock}).active,"fresh process does not restore an active session")
        audit.update(version:1,active:true,session:sid,expiresAt:clock.addingTimeInterval(300));XCTAssertFalse(audit.active,"retired status cannot reactivate the capture")
        let next=UUID().uuidString.lowercased();audit.update(version:1,active:true,session:next,expiresAt:clock.addingTimeInterval(300));XCTAssertTrue(audit.beginAttempt());let old=audit.correlation()!;clock=clock.addingTimeInterval(300)
        XCTAssertFalse(audit.active);XCTAssertFalse(audit.record(.terminalCompleted,session:old.session,attempt:old.attempt,turn:1))
    }
    func testMonotonicCeilingAndRepeatedStatusCannotExtendSession(){
        var clock=Date(timeIntervalSince1970:1000),uptime:TimeInterval=40;let audit=BoundedVoiceAudit(now:{clock},monotonic:{uptime});let sid=UUID().uuidString.lowercased()
        audit.update(version:1,active:true,session:sid,expiresAt:clock.addingTimeInterval(60));XCTAssertTrue(audit.beginAttempt())
        clock=clock.addingTimeInterval(-100);uptime += 30
        audit.update(version:1,active:true,session:sid,expiresAt:clock.addingTimeInterval(300));XCTAssertTrue(audit.active)
        uptime += 30;XCTAssertFalse(audit.active)
    }
    func testRetainedAuditEntriesExpireAndCanBeCleared(){
        var clock=Date(timeIntervalSince1970:1000);let audit=BoundedVoiceAudit(now:{clock}),sid=UUID().uuidString.lowercased()
        audit.update(version:1,active:true,session:sid,expiresAt:clock.addingTimeInterval(60));XCTAssertTrue(audit.beginAttempt());let labels=audit.correlation()!
        XCTAssertTrue(audit.record(.turnStarted,session:labels.session,attempt:labels.attempt,turn:1));audit.disarm();clock=clock.addingTimeInterval(3601);audit.prune();XCTAssertTrue(audit.snapshot().isEmpty)
    }
    func testMalformedStaleAndOverlongSessionsDisarm(){
        let now=Date(timeIntervalSince1970:1000),audit=BoundedVoiceAudit(now:{now}),good=UUID().uuidString.lowercased()
        audit.update(version:1,active:true,session:good,expiresAt:now.addingTimeInterval(300));XCTAssertTrue(audit.active)
        audit.update(version:1,active:true,session:"credential-sentinel",expiresAt:now.addingTimeInterval(1));XCTAssertFalse(audit.active)
        audit.update(version:1,active:true,session:good,expiresAt:now.addingTimeInterval(301));XCTAssertFalse(audit.active)
        audit.update(version:2,active:true,session:good,expiresAt:now.addingTimeInterval(10));XCTAssertFalse(audit.active)
        audit.update(version:1,active:true,session:"11111111-1111-1111-8111-111111111111",expiresAt:now.addingTimeInterval(10));XCTAssertFalse(audit.active)
        audit.update(version:1,active:true,session:good.uppercased(),expiresAt:now.addingTimeInterval(10));XCTAssertFalse(audit.active)
        audit.update(version:1,active:true,session:good,expiresAt:now);XCTAssertFalse(audit.active)
    }
    func testAuthenticatedAudienceStatusEnablesOnlyExactValidAndErrorsDisarm() throws {
        let now=Date(timeIntervalSince1970:1000),audit=BoundedVoiceAudit(now:{now}),sid=UUID().uuidString.lowercased(),end=ISO8601DateFormatter().string(from:now.addingTimeInterval(60))
        let body=try JSONSerialization.data(withJSONObject:["diagnostics":["version":1,"active":true,"session":sid,"expiresAt":end,"contentEnabled":false],"ignored":"credential-sentinel"])
        audit.updateFromAudience(statusCode:401,data:body);XCTAssertFalse(audit.active)
        audit.updateFromAudience(statusCode:200,data:body);XCTAssertTrue(audit.active)
        audit.updateFromAudience(statusCode:200,data:Data("not json".utf8));XCTAssertFalse(audit.active)
        audit.updateFromAudience(statusCode:200,data:body);XCTAssertFalse(audit.active,"stale successful response cannot reactivate a retired session")
        XCTAssertFalse(String(data:try JSONEncoder().encode(audit.snapshot()),encoding:.utf8)!.contains("credential-sentinel"))
    }
    func testBackgroundSuppressesFreshStatusAndRetiresCurrentSession(){
        let now=Date(timeIntervalSince1970:1000),audit=BoundedVoiceAudit(now:{now}),sid=UUID().uuidString.lowercased()
        audit.update(version:1,active:true,session:sid,expiresAt:now.addingTimeInterval(60));XCTAssertTrue(audit.beginAttempt());let labels=audit.correlation()!
        audit.suspend();audit.update(version:1,active:true,session:UUID().uuidString.lowercased(),expiresAt:now.addingTimeInterval(60));XCTAssertFalse(audit.active)
        XCTAssertFalse(audit.record(.firstPCM,session:labels.session,attempt:labels.attempt,turn:1));audit.resumeForeground();audit.update(version:1,active:true,session:sid,expiresAt:now.addingTimeInterval(60));XCTAssertFalse(audit.active)
    }
    func testInjectedAttemptFactoryMustReturnUUIDv4(){
        let now=Date(timeIntervalSince1970:1000),invalid=UUID(uuidString:"11111111-1111-1111-8111-111111111111")!,audit=BoundedVoiceAudit(now:{now},attemptFactory:{invalid}),sid=UUID().uuidString.lowercased()
        audit.update(version:1,active:true,session:sid,expiresAt:now.addingTimeInterval(60));XCTAssertFalse(audit.beginAttempt());XCTAssertNil(audit.correlation())
    }
    func testOutOfOrderStatusAndResetCannotRearmCapture() throws {
        let now=Date(timeIntervalSince1970:1000),audit=BoundedVoiceAudit(now:{now}),sid=UUID().uuidString.lowercased(),end=ISO8601DateFormatter().string(from:now.addingTimeInterval(60))
        let body=try JSONSerialization.data(withJSONObject:["diagnostics":["version":1,"active":true,"session":sid,"expiresAt":end,"contentEnabled":false]])
        let old=audit.beginStatusRequest(),newer=audit.beginStatusRequest();audit.completeStatusRequest(newer,statusCode:200,data:Data("{}".utf8));audit.completeStatusRequest(old,statusCode:200,data:body);XCTAssertFalse(audit.active)
        let inFlight=audit.beginStatusRequest();audit.invalidatePendingStatus();audit.completeStatusRequest(inFlight,statusCode:200,data:body);XCTAssertFalse(audit.active)
        let current=audit.beginStatusRequest();audit.completeStatusRequest(current,statusCode:200,data:body);XCTAssertTrue(audit.active)
    }
    func testConsentOnlyWhileEnrolledStrictSequenceAndBound(){
        let now=Date(timeIntervalSince1970:1000),audit=BoundedVoiceAudit(now:{now}),sid=UUID().uuidString.lowercased()
        XCTAssertNil(audit.nextConsent(.turn));audit.update(version:1,active:true,session:sid,expiresAt:now.addingTimeInterval(60));XCTAssertTrue(audit.beginAttempt())
        XCTAssertEqual(audit.nextConsent(.heartbeat)?.sequence,1);XCTAssertEqual(audit.nextConsent(.turn)?.sequence,2)
        for expected in 3...1000{XCTAssertEqual(audit.nextConsent(.heartbeat)?.sequence,expected)};XCTAssertNil(audit.nextConsent(.turn));audit.suspend();XCTAssertNil(audit.nextConsent(.heartbeat))
    }
    func testStopControlRequiresMatchingLabelsAndClosedReason(){
        let now=Date(timeIntervalSince1970:1000),audit=BoundedVoiceAudit(now:{now}),sid=UUID().uuidString.lowercased()
        audit.update(version:1,active:true,session:sid,expiresAt:now.addingTimeInterval(60));XCTAssertTrue(audit.beginAttempt());let labels=audit.correlation()!
        XCTAssertFalse(audit.stopFromServer(version:1,session:labels.session,attempt:labels.attempt,reason:"credential-sentinel"));XCTAssertTrue(audit.active)
        XCTAssertFalse(audit.stopFromServer(version:1,session:labels.session,attempt:UUID().uuidString.lowercased(),reason:"operator_off"));XCTAssertTrue(audit.active)
        XCTAssertTrue(audit.stopFromServer(version:1,session:labels.session,attempt:labels.attempt,reason:"operator_off"));XCTAssertFalse(audit.active)
        XCTAssertFalse(audit.record(.firstPCM,session:labels.session,attempt:labels.attempt,turn:1))
    }
    func testEventBoundsCorrelationAndSentinelRedaction() throws {
        let now=Date(timeIntervalSince1970:1000),audit=BoundedVoiceAudit(now:{now}),sid=UUID().uuidString.lowercased()
        audit.update(version:1,active:true,session:sid,expiresAt:now.addingTimeInterval(60));XCTAssertTrue(audit.beginAttempt());let label=audit.correlation()!
        XCTAssertFalse(audit.record(.privacyRequestFinish,session:"secret-header-sentinel",attempt:label.attempt,turn:1));XCTAssertFalse(audit.record(.firstPCM,session:label.session,attempt:label.attempt,turn:0));XCTAssertFalse(audit.record(.firstPCM,session:label.session,attempt:label.attempt,turn:5));XCTAssertFalse(audit.record(.firstPCM,session:label.session,attempt:label.attempt,turn:1,value:-1))
        for n in 1...450{XCTAssertTrue(audit.record(.firstPCM,session:label.session,attempt:label.attempt,turn:(n-1)%4+1,value:1))}
        XCTAssertEqual(audit.snapshot().count,200);XCTAssertEqual(audit.snapshot().first?.turn,3)
        let encoded=String(data:try JSONEncoder().encode(audit.snapshot()),encoding:.utf8)!;XCTAssertFalse(encoded.contains("secret-header-sentinel"));XCTAssertFalse(encoded.contains("credential"));audit.clear();XCTAssertTrue(audit.snapshot().isEmpty)
    }
}
