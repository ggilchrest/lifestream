import XCTest
@testable import AssistantCore
final class HealthAvailabilityTests:XCTestCase {
 func testEmptyResultDoesNotInferPermissionOrZero(){var s=HealthStatus(support:.supported,readKnowledge:.notObservable,connection:.connected);s.observedEmptyRead();XCTAssertEqual(s.readKnowledge,.notObservable);XCTAssertEqual(s.latestRead,.noReadableData);XCTAssertEqual(s.coverage,.unknown);XCTAssertEqual(s.label,"No readable data yet")}
 func testLockedAndUnsupportedRemainDistinctFromPermission(){let waiting=HealthStatus(support:.supported,readKnowledge:.notObservable,connection:.waitingForUnlock);XCTAssertEqual(waiting.label,"Waiting for iPhone unlock");XCTAssertEqual(waiting.coverage,.unknown);let unsupported=HealthStatus(support:.unsupported);XCTAssertEqual(unsupported.label,"Not supported on this device");XCTAssertEqual(unsupported.readKnowledge,.unknown)}
 func testQuarantineAndOfflineHaveDistinctRecoveryStates(){XCTAssertEqual(HealthStatus(connection:.waitingForRebind).label,"Confirm source owner to continue");XCTAssertEqual(HealthStatus(connection:.offline).label,"Offline");XCTAssertEqual(HealthStatus(connection:.queuedForSync).label,"Queued for sync")}
 func testEmptyReadDoesNotEraseHistoricalCoverage(){var s=HealthStatus(support:.supported,readKnowledge:.notObservable,coverage:.available,connection:.connected);s.observedEmptyRead();XCTAssertEqual(s.coverage,.available);XCTAssertEqual(s.latestRead,.noReadableData);XCTAssertEqual(s.label,"Connected")}

}
