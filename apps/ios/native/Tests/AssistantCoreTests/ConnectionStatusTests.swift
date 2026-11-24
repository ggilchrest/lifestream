import XCTest
@testable import AssistantCore

final class ConnectionStatusTests:XCTestCase {
    func testSavedConfigurationNeverEstablishesAuthentication(){
        var value=ConnectionStatus();XCTAssertEqual(value.state,.disconnected);XCTAssertEqual(value.reason,.unconfigured)
        value.observe(.configured,at:1);value.observe(.reachable,at:2)
        XCTAssertEqual(value.state,.disconnected);XCTAssertEqual(value.reason,.signedOut)
        value.observe(.restoring,at:3);XCTAssertEqual(value.state,.checking)
        value.observe(.reachable,at:4);XCTAssertEqual(value.reason,.restoring)
    }
    func testAuthenticatedObservationAndBoundedFreshness(){
        var value=ConnectionStatus();value.observe(.connecting,at:1);XCTAssertEqual(value.state,.checking)
        value.observe(.authenticated,at:2);XCTAssertEqual(value.state,.connected)
        value.expire(at:31);XCTAssertEqual(value.state,.connected)
        let verifiedRevision=value.revision;value.expire(at:32)
        XCTAssertEqual(value.state,.checking);XCTAssertEqual(value.reason,.verificationExpired);XCTAssertGreaterThan(value.revision,verifiedRevision)
        value.observe(.reachable,at:33);XCTAssertEqual(value.state,.connected)
    }
    func testObservedLossAndDeliberateRetryPreserveSessionKnowledge(){
        var value=ConnectionStatus();value.observe(.authenticated,at:1);value.observe(.networkFailure,at:2)
        XCTAssertEqual(value.state,.disconnected);XCTAssertEqual(value.reason,.networkUnavailable)
        value.observe(.retrying,at:3);XCTAssertEqual(value.state,.checking)
        value.observe(.reachable,at:4);XCTAssertEqual(value.state,.connected)
        value.observe(.serviceFailure,at:5);XCTAssertEqual(value.reason,.serviceUnavailable)
    }
    func testAuthenticationFailureAndSignOutCannotBeClearedByReachability(){
        var value=ConnectionStatus();value.observe(.authenticated,at:1);value.observe(.authenticationFailure,at:2);value.observe(.reachable,at:3)
        XCTAssertEqual(value.state,.disconnected);XCTAssertEqual(value.reason,.authenticationRequired)
        value.observe(.connecting,at:4);XCTAssertEqual(value.state,.checking)
        value.observe(.authenticated,at:5);value.observe(.signedOut,at:6);value.observe(.reachable,at:7)
        XCTAssertEqual(value.state,.disconnected);XCTAssertEqual(value.reason,.signedOut)
        value.observe(.reset,at:8);XCTAssertEqual(value.reason,.unconfigured)
    }
    func testClockUncertaintyCannotKeepGreen(){
        var value=ConnectionStatus();value.observe(.authenticated,at:10);value.expire(at:9)
        XCTAssertEqual(value.state,.checking);XCTAssertEqual(value.reason,.unverified)
        value.observe(.authenticated,at:.nan);XCTAssertNotEqual(value.state,.connected)
    }
    func testUnavailableVerificationPreservesOnlyPreviouslyProvedAuthentication(){
        var known=ConnectionStatus();known.observe(.authenticated,at:1)
        known.observe(.connecting,at:2);XCTAssertEqual(known.state,.checking)
        known.observe(.verificationUnavailable,at:3)
        XCTAssertEqual(known.state,.checking);XCTAssertEqual(known.reason,.unverified)
        XCTAssertNil(known.remainingFreshness(at:3))
        known.observe(.reachable,at:4);XCTAssertEqual(known.state,.connected)
        known.observe(.authenticationFailure,at:5);known.observe(.connecting,at:6)
        known.observe(.verificationUnavailable,at:7);known.observe(.reachable,at:8)
        XCTAssertEqual(known.state,.checking);XCTAssertEqual(known.reason,.unverified)
        var unknown=ConnectionStatus();unknown.observe(.configured,at:1)
        unknown.observe(.connecting,at:2);unknown.observe(.verificationUnavailable,at:3)
        unknown.observe(.reachable,at:4);XCTAssertNotEqual(unknown.state,.connected)
        unknown.observe(.restoring,at:5);unknown.observe(.verificationUnavailable,at:6)
        unknown.observe(.reachable,at:7);XCTAssertNotEqual(unknown.state,.connected)
        known.observe(.authenticated,at:9);known.observe(.signedOut,at:10)
        known.observe(.verificationUnavailable,at:11);known.observe(.reachable,at:12)
        XCTAssertNotEqual(known.state,.connected)
    }
    func testReasonsUseExistingClosedOptionalDiagnostics(){
        let log=DiagnosticBuffer();log.record(.connectionChanged,code:.connectionVerified);XCTAssertEqual(log.count,0)
        log.setEnabled(true);for reason in ConnectionStatus.Reason.allCases{log.record(.connectionChanged,code:reason.diagnosticCode)}
        XCTAssertEqual(log.count,ConnectionStatus.Reason.allCases.count)
        let text=String(decoding:try! XCTUnwrap(log.encoded()),as:UTF8.self)
        XCTAssertFalse(text.contains("SENTINEL_password_token_otp_private_contents"))
        XCTAssertNil(DiagnosticCode(rawValue:"SENTINEL_password_token_otp_private_contents"))
    }
}
