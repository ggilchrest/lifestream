import XCTest
@testable import AssistantCore

final class AudienceLifecycleTests: XCTestCase {
    func testHomeAlwaysEndsEvenWhenLockContinuationEnabled() {
        var policy=AudienceLifecycle();policy.resignActive()
        XCTAssertFalse(policy.enterBackground(continueWhenLocked:true,protectedDataAvailable:true))
        XCTAssertEqual(policy.state,.ended)
        policy.protectedDataUnavailable()
        XCTAssertEqual(policy.state,.ended,"late lock evidence cannot revive a minimized conversation")
    }
    func testVerifiedLockContinuesOnlyWithOptIn() {
        var on=AudienceLifecycle();on.resignActive();on.protectedDataUnavailable()
        XCTAssertTrue(on.enterBackground(continueWhenLocked:true,protectedDataAvailable:true))
        XCTAssertEqual(on.state,.locked)
        var off=AudienceLifecycle();off.protectedDataUnavailable();off.resignActive()
        XCTAssertFalse(off.enterBackground(continueWhenLocked:false,protectedDataAvailable:false))
        XCTAssertEqual(off.state,.ended)
    }
    func testAlreadyUnavailableDataSupportsLockButUnlockInBackgroundEnds() {
        var policy=AudienceLifecycle()
        XCTAssertTrue(policy.enterBackground(continueWhenLocked:true,protectedDataAvailable:false))
        XCTAssertFalse(policy.protectedDataAvailable())
        XCTAssertEqual(policy.state,.ended)
    }
    func testDelayedBackgroundFirstLockRemainsEndedUntilForeground() {
        var policy=AudienceLifecycle();policy.resignActive()
        XCTAssertFalse(policy.enterBackground(continueWhenLocked:true,protectedDataAvailable:true))
        policy.protectedDataUnavailable()
        XCTAssertEqual(policy.state,.ended)
        policy.becomeActive()
        XCTAssertEqual(policy.state,.foreground)
        policy.resignActive()
        XCTAssertFalse(policy.enterBackground(continueWhenLocked:true,protectedDataAvailable:true),"previous lock evidence never carries into another background transition")
    }
    func testTemporaryInactivityDoesNotEndAndNoSignalClaimsALock() {
        var policy=AudienceLifecycle();policy.resignActive()
        XCTAssertEqual(policy.state,.inactive)
        policy.becomeActive();XCTAssertEqual(policy.state,.foreground)
        XCTAssertTrue(policy.protectedDataAvailable())
        XCTAssertEqual(policy.state,.foreground)
    }
    func testOwnershipExpiryIsSeparateFromShortAutomaticEvidence() throws {
        let now=Date(),id=UUID().uuidString.lowercased(),formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
        let value:[String:Any]=["leaseId":id,"revision":4,"privateAllowed":true,"classification":"solo-supported","expiresAt":formatter.string(from:now.addingTimeInterval(4)),"leaseExpiresAt":formatter.string(from:now.addingTimeInterval(20))]
        let lease=try AudienceConnectionLease(value,expectedId:id,now:now)
        XCTAssertGreaterThan(lease.expiresAt.timeIntervalSince(now),19)
    }
    func testConnectionLeaseRejectsLegacyExpiredAndDifferentOwner() throws {
        let now=Date(),id=UUID().uuidString.lowercased(),other=UUID().uuidString.lowercased()
        let formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
        let value:[String:Any]=["leaseId":id,"revision":4,"privateAllowed":true,"classification":"solo-supported","expiresAt":formatter.string(from:now.addingTimeInterval(20)),"leaseExpiresAt":formatter.string(from:now.addingTimeInterval(20))]
        let lease=try AudienceConnectionLease(value,expectedId:id,now:now)
        XCTAssertEqual(lease.revision,4);XCTAssertEqual(lease.id,id)
        XCTAssertThrowsError(try AudienceConnectionLease(value,expectedId:other,now:now))
        XCTAssertThrowsError(try AudienceConnectionLease(value,expectedId:id,now:now.addingTimeInterval(21)))
        var legacy=value;legacy.removeValue(forKey:"leaseId")
        XCTAssertThrowsError(try AudienceConnectionLease(legacy,expectedId:id,now:now))
        var shared=value;shared["privateAllowed"]=false;shared["classification"]="shared"
        XCTAssertThrowsError(try AudienceConnectionLease(shared,expectedId:id,now:now))
        var indefinite=value;indefinite["expiresAt"]=NSNull()
        XCTAssertThrowsError(try AudienceConnectionLease(indefinite,expectedId:id,now:now))
    }
}
