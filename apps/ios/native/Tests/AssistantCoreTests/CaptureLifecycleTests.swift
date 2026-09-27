import XCTest
@testable import AssistantCore

final class CaptureLifecycleTests:XCTestCase {
    func testStartupRouteStormCannotRestartOrUseOldCaptureDeadline() {
        var capture=CaptureLifecycle()
        capture.begin(generation:1)
        for time in [1.0,20.0,100.0] {
            XCTAssertEqual(capture.routeChange(generation:1,route:"changing",engineRunning:false),.ignore)
            XCTAssertNil(capture.failure(generation:1,now:time,lastRaw:nil,lastConverted:nil))
        }
        capture.starting(generation:1)
        for time in [101.0,105.0,120.0] {
            XCTAssertEqual(capture.routeChange(generation:1,route:"built-in",engineRunning:false),.ignore)
            XCTAssertNil(capture.failure(generation:1,now:time,lastRaw:1,lastConverted:1))
        }
        capture.ready(generation:1,route:"built-in",at:120)
        XCTAssertEqual(capture.routeChange(generation:1,route:"built-in",engineRunning:true),.ignore)
        XCTAssertNil(capture.failure(generation:1,now:127.999,lastRaw:1,lastConverted:1))
        XCTAssertEqual(capture.failure(generation:1,now:128,lastRaw:1,lastConverted:1),.noRaw)
    }

    func testOneRecoveryDoesNotBecomeAnEndlessRouteRestartLoop() {
        var capture=CaptureLifecycle()
        capture.begin(generation:1);capture.starting(generation:1);capture.ready(generation:1,route:"speaker",at:10)
        XCTAssertEqual(capture.routeChange(generation:1,route:"airpods",engineRunning:true),.recover)
        for _ in 0..<20 {XCTAssertEqual(capture.routeChange(generation:1,route:"airpods",engineRunning:false),.ignore)}
        capture.stop(generation:2)
        capture.begin(generation:2,recovering:true);capture.starting(generation:2)
        XCTAssertEqual(capture.routeChange(generation:2,route:"airpods",engineRunning:false),.ignore)
        capture.ready(generation:2,route:"airpods",at:11)
        XCTAssertEqual(capture.routeChange(generation:2,route:"airpods",engineRunning:true),.ignore)
        XCTAssertEqual(capture.routeChange(generation:2,route:"airpods",engineRunning:false),.fail)
        XCTAssertEqual(capture.routeChange(generation:2,route:"airpods",engineRunning:false),.ignore)
    }

    func testOnlyCurrentConvertedCaptureReplenishesRecovery() {
        var capture=CaptureLifecycle()
        capture.begin(generation:1);capture.starting(generation:1);capture.ready(generation:1,route:"speaker",at:10)
        XCTAssertEqual(capture.routeChange(generation:1,route:"airpods",engineRunning:true),.recover)
        capture.stop(generation:2);capture.begin(generation:2,recovering:true)
        capture.captured(generation:2) // A late callback before the new graph is ready is not capture.
        capture.starting(generation:2);capture.ready(generation:2,route:"airpods",at:11)
        capture.captured(generation:1)
        XCTAssertEqual(capture.routeChange(generation:2,route:"speaker",engineRunning:true),.fail)

        capture.stop(generation:3);capture.begin(generation:3);capture.starting(generation:3);capture.ready(generation:3,route:"speaker",at:12)
        XCTAssertEqual(capture.routeChange(generation:3,route:"airpods",engineRunning:true),.recover)
        capture.stop(generation:4);capture.begin(generation:4,recovering:true);capture.starting(generation:4);capture.ready(generation:4,route:"airpods",at:13)
        capture.captured(generation:4)
        XCTAssertEqual(capture.routeChange(generation:4,route:"speaker",engineRunning:true),.recover)
    }

    func testStopAndStaleCallbacksCannotReactivateOrDamageReplacement() {
        var capture=CaptureLifecycle()
        capture.begin(generation:1);capture.starting(generation:1);capture.ready(generation:1,route:"speaker",at:10)
        XCTAssertEqual(capture.routeChange(generation:1,route:"airpods",engineRunning:true),.recover)
        capture.stop(generation:2)
        capture.ready(generation:1,route:"airpods",at:11);capture.captured(generation:1)
        XCTAssertEqual(capture.routeChange(generation:1,route:"airpods",engineRunning:false),.ignore)
        XCTAssertEqual(capture.routeChange(generation:2,route:"airpods",engineRunning:false),.ignore)
        XCTAssertNil(capture.failure(generation:2,now:100,lastRaw:nil,lastConverted:nil))
        capture.begin(generation:3);capture.starting(generation:3);capture.ready(generation:3,route:"speaker",at:100)
        capture.begin(generation:1);capture.starting(generation:1);capture.stop(generation:2)
        capture.ready(generation:1,route:"airpods",at:1)
        XCTAssertEqual(capture.routeChange(generation:3,route:"speaker",engineRunning:true),.ignore)
        XCTAssertNil(capture.failure(generation:1,now:110,lastRaw:nil,lastConverted:nil))
        XCTAssertEqual(capture.failure(generation:3,now:108,lastRaw:nil,lastConverted:nil),.noRaw)
    }

    func testWatchdogDistinguishesNoRawNoConversionAndStalledCapture() {
        var capture=CaptureLifecycle()
        capture.begin(generation:1);capture.starting(generation:1);capture.ready(generation:1,route:"speaker",at:100)
        XCTAssertNil(capture.failure(generation:1,now:107.999,lastRaw:nil,lastConverted:nil))
        XCTAssertEqual(capture.failure(generation:1,now:108,lastRaw:nil,lastConverted:nil),.noRaw)
        XCTAssertEqual(capture.failure(generation:1,now:108,lastRaw:107.9,lastConverted:nil),.noConversion)
        XCTAssertNil(capture.failure(generation:1,now:102.999,lastRaw:100,lastConverted:100))
        XCTAssertEqual(capture.failure(generation:1,now:103,lastRaw:102.9,lastConverted:100),.stalled)
        XCTAssertNil(capture.failure(generation:1,now:110,lastRaw:109.9,lastConverted:109.9))
    }

    func testRestartGetsItsOwnGraceAndInvalidClocksCannotSuppressWatchdog() {
        var capture=CaptureLifecycle()
        capture.begin(generation:1);capture.starting(generation:1);capture.ready(generation:1,route:"speaker",at:10)
        capture.stop(generation:2);capture.begin(generation:2);capture.starting(generation:2);capture.ready(generation:2,route:"speaker",at:100)
        XCTAssertNil(capture.failure(generation:2,now:107.999,lastRaw:11,lastConverted:11))
        XCTAssertEqual(capture.failure(generation:2,now:108,lastRaw:11,lastConverted:11),.noRaw)
        XCTAssertEqual(capture.failure(generation:2,now:108,lastRaw:.infinity,lastConverted:.nan),.noRaw)
        XCTAssertEqual(capture.failure(generation:2,now:108,lastRaw:200,lastConverted:200),.noRaw)
        XCTAssertNil(capture.failure(generation:2,now:99,lastRaw:nil,lastConverted:nil))
    }
}
