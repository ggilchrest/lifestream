import XCTest
@testable import AssistantCore

final class PreviewOwnershipTests:XCTestCase {
    func testCancellationBeforeHeadersRetainsBoundedWait() {
        var state=PreviewOwnership();state.begin(now:10)
        XCTAssertTrue(state.busy(now:11));XCTAssertEqual(state.waitSeconds(now:11),359)
        XCTAssertFalse(state.busy(now:370));XCTAssertEqual(state.waitSeconds(now:371),0)
    }
    func testKnownLeaseAndUnconfirmedSettlementCannotReleaseEarly() {
        var state=PreviewOwnership();state.begin(now:0);state.admitted(now:5,remaining:180)
        XCTAssertEqual(state.waitSeconds(now:5),181);state.beginSettlement();state.finishSettlement(accepted:false)
        XCTAssertTrue(state.busy(now:185));XCTAssertFalse(state.busy(now:186))
    }
    func testSettlementWaitsForResultAndOnlyAcceptanceClears() {
        var state=PreviewOwnership();state.begin(now:0);state.beginSettlement()
        XCTAssertTrue(state.busy(now:400));state.finishSettlement(accepted:true);XCTAssertFalse(state.busy(now:400))
        state.begin(now:500);state.admitted(now:501,remaining:182);XCTAssertEqual(state.waitSeconds(now:501),359)
        state.rejected();XCTAssertFalse(state.busy(now:501))
    }
    func testRetiredGenerationRejectsLateHeaderTerminalAndCompletion() {
        var state=PreviewOwnership();let old=state.begin(now:0);XCTAssertTrue(state.isCurrent(old))
        state.retire();XCTAssertFalse(state.isCurrent(old))
        let next=state.begin(now:400);XCTAssertFalse(state.isCurrent(old));XCTAssertTrue(state.isCurrent(next))
    }
    func testSettlementRequiresSuccessAndExplicitUnconfirmedPhysicalPlayback() {
        func data(_ text:String)->Data { Data(text.utf8) }
        XCTAssertTrue(PreviewOwnership.settlementAccepted(status:200,data:data(#"{"accepted":true,"physicalPlaybackConfirmed":false}"#)))
        XCTAssertFalse(PreviewOwnership.settlementAccepted(status:409,data:data(#"{"accepted":true,"physicalPlaybackConfirmed":false}"#)))
        XCTAssertFalse(PreviewOwnership.settlementAccepted(status:200,data:data(#"{"accepted":true}"#)))
        XCTAssertFalse(PreviewOwnership.settlementAccepted(status:200,data:data(#"{"accepted":false,"physicalPlaybackConfirmed":false}"#)))
        XCTAssertFalse(PreviewOwnership.settlementAccepted(status:200,data:data(#"{"accepted":1,"physicalPlaybackConfirmed":0}"#)))
        XCTAssertFalse(PreviewOwnership.settlementAccepted(status:200,data:data("broken")))
    }
}
