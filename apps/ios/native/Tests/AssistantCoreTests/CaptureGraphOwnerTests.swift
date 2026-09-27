import XCTest
@testable import AssistantCore

final class CaptureGraphOwnerTests:XCTestCase {
    final class Graph {}
    func testDelayedConfigurationChangeReusesVoiceGraphWithoutSessionToggle() throws {
        let owner=CaptureGraphOwner<Graph>();var creations=0,deactivations=0,stops=0,notices=0
        let make:()->Graph={creations += 1;notices += 1;return Graph()}
        let initial=try owner.acquire(make)
        var lifecycle=CaptureLifecycle();lifecycle.begin(generation:1);lifecycle.starting(generation:1);lifecycle.ready(generation:1,route:"old-format",at:0)
        // Creating VPIO caused a queued hardware configuration notification before raw input.
        XCTAssertEqual(notices,1)
        XCTAssertEqual(lifecycle.routeChange(generation:1,route:"headset",engineRunning:false),.recover)
        owner.stop(recovering:true,stop:{_ in stops += 1},deactivate:{deactivations += 1})
        lifecycle.stop(generation:2);lifecycle.begin(generation:2,recovering:true);lifecycle.starting(generation:2)
        let recovered=try owner.acquire(make)
        lifecycle.ready(generation:2,route:"headset",at:1)
        XCTAssertTrue(initial===recovered);XCTAssertEqual(creations,1);XCTAssertEqual(notices,1)
        XCTAssertEqual(deactivations,0);XCTAssertEqual(stops,1)
        XCTAssertEqual(lifecycle.routeChange(generation:2,route:"headset",engineRunning:true),.ignore)
        lifecycle.captured(generation:2)
        owner.stop(recovering:false,stop:{_ in stops += 1},deactivate:{deactivations += 1})
        XCTAssertNil(owner.current);XCTAssertEqual(deactivations,1);XCTAssertEqual(stops,2)
        XCTAssertFalse(initial === (try owner.acquire(make)));XCTAssertEqual(creations,2)
    }
    func testStopBeforeQueuedRecoveryCannotReuseRetiredGraph() throws {
        let owner=CaptureGraphOwner<Graph>();let first=try owner.acquire{Graph()};var deactivated=0
        owner.stop(recovering:true,stop:{_ in},deactivate:{deactivated += 1})
        owner.stop(recovering:false,stop:{_ in},deactivate:{deactivated += 1})
        XCTAssertNil(owner.current);XCTAssertEqual(deactivated,1)
        XCTAssertFalse(first === (try owner.acquire{Graph()}))
    }
    func testStopDuringGraphCreationCannotPublishTheCancelledGraph() {
        let owner=CaptureGraphOwner<Graph>();var deactivated=0
        XCTAssertThrowsError(try owner.acquire{
            owner.stop(recovering:false,stop:{_ in},deactivate:{deactivated += 1})
            return Graph()
        })
        XCTAssertNil(owner.current);XCTAssertEqual(deactivated,1)
    }
    func testFailedCreationStillAllowsFullSessionCleanup() {
        let owner=CaptureGraphOwner<Graph>();var deactivated=0
        XCTAssertThrowsError(try owner.acquire{throw VoiceError.invalidFrame})
        owner.stop(recovering:false,stop:{_ in XCTFail("No graph exists")},deactivate:{deactivated += 1})
        XCTAssertNil(owner.current);XCTAssertEqual(deactivated,1)
    }
}
