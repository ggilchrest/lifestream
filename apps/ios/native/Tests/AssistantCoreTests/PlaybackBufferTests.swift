import XCTest
@testable import AssistantCore

final class PlaybackBufferTests: XCTestCase {
    func testStartupWaitsFor400MillisecondsOfPCMAndStartsOnlyOnce() throws {
        var playback = PlaybackBuffer()
        playback.begin(generation: 1)
        XCTAssertEqual(playback.targetSamples, 19_200)
        for offset in 0..<3 {
            let at = 10 + Double(offset) * 0.01
            _ = try playback.enqueue(samples: 4_800, generation: 1, at: at)
            XCTAssertEqual(playback.playbackAction(generation: 1, at: at), .none)
        }
        XCTAssertEqual(playback.startupDeadline, 11)
        _ = try playback.enqueue(samples: 4_799, generation: 1, at: 10.05)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 10.05), .none)
        _ = try playback.enqueue(samples: 1, generation: 1, at: 10.1)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 10.1), .start)
        XCTAssertTrue(playback.isPlaying)
        XCTAssertEqual(playback.queuedSamples, 19_200)
        XCTAssertEqual(playback.lastStartReason, .threshold)
        XCTAssertEqual(playback.lastStartQueuedSamples, 19_200)
        XCTAssertNil(playback.startupDeadline)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 100), .none)
    }

    func testDeadlineStartsSparseSpeechAndIsNotExtendedByMorePackets() throws {
        var playback = PlaybackBuffer()
        playback.begin(generation: 1)
        _ = try playback.enqueue(samples: 480, generation: 1, at: 10)
        _ = try playback.enqueue(samples: 480, generation: 1, at: 10.2)
        XCTAssertEqual(playback.startupDeadline, 11)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 10.999), .none)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 11), .start)
        XCTAssertEqual(playback.lastStartReason, .deadline)
        XCTAssertEqual(playback.lastStartQueuedSamples, 960)
    }

    func testShortTerminalReplyPlaysImmediatelyAndSettlesExactlyOnce() throws {
        var playback = PlaybackBuffer()
        playback.begin(generation: 1)
        let ticket = try playback.enqueue(samples: 1, generation: 1, at: 0)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 0), .none)
        XCTAssertEqual(playback.finish(generation: 1, at: 0.001), .start)
        XCTAssertEqual(playback.lastStartReason, .terminal)
        XCTAssertEqual(playback.lastStartQueuedSamples, 1)
        XCTAssertNil(playback.startupDeadline)
        XCTAssertEqual(playback.finish(generation: 1, at: 0.002), .none)
        XCTAssertThrowsError(try playback.enqueue(samples: 1, generation: 1, at: 0.003))
        XCTAssertEqual(playback.completed(ticket), .finished)
        XCTAssertEqual(playback.completed(ticket), .none)
        XCTAssertEqual(playback.queuedSamples, 0)
        XCTAssertEqual(playback.starvationCount, 0)
        XCTAssertFalse(playback.isPlaying)
    }

    func testTerminalDuringPlaybackWaitsForAllScheduledBuffers() throws {
        var playback = PlaybackBuffer()
        playback.begin(generation: 1)
        let first = try playback.enqueue(samples: 4_800, generation: 1, at: 0)
        let second = try playback.enqueue(samples: 4_800, generation: 1, at: 0.1)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 1), .start)
        XCTAssertEqual(playback.finish(generation: 1, at: 1.05), .none)
        XCTAssertEqual(playback.completed(first), .none)
        XCTAssertTrue(playback.isPlaying)
        XCTAssertEqual(playback.queuedSamples, 4_800)
        XCTAssertEqual(playback.completed(second), .finished)
        XCTAssertEqual(playback.starvationCount, 0)
    }

    func testTerminalAfterDrainSettlesWithoutNewAudio() throws {
        var playback = PlaybackBuffer()
        playback.begin(generation: 1)
        let ticket = try playback.enqueue(samples: 4_800, generation: 1, at: 0)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 1), .start)
        XCTAssertEqual(playback.completed(ticket), .pause)
        XCTAssertEqual(playback.finish(generation: 1, at: 10), .finished)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 100), .none)
        XCTAssertNil(playback.startupDeadline)
    }

    func testRepeatedStarvationGetsFreshRecoveryThresholdAndDeadline() throws {
        var playback = PlaybackBuffer()
        playback.begin(generation: 1)
        for cycle in 0..<5 {
            let time = Double(cycle * 10)
            XCTAssertNil(playback.startupDeadline)
            let target = cycle == 0 ? 19_200 : 28_800
            XCTAssertEqual(playback.targetSamples, target)
            var tickets = [PlaybackBuffer.Ticket]()
            for offset in 0..<(target / 4_800) {
                let at = time + Double(offset) * 0.01
                tickets.append(try playback.enqueue(samples: 4_800, generation: 1, at: at))
                XCTAssertEqual(playback.startupDeadline, time + 1)
                XCTAssertEqual(playback.playbackAction(generation: 1, at: at), offset == target / 4_800 - 1 ? .start : .none)
            }
            XCTAssertEqual(playback.lastStartReason, .threshold)
            XCTAssertEqual(playback.lastStartQueuedSamples, target)
            for ticket in tickets.dropLast() { XCTAssertEqual(playback.completed(ticket), .none) }
            XCTAssertEqual(playback.completed(tickets.last!), .pause)
            XCTAssertFalse(playback.isPlaying)
            XCTAssertEqual(playback.queuedSamples, 0)
            XCTAssertEqual(playback.starvationCount, cycle + 1)
            XCTAssertEqual(playback.playbackAction(generation: 1, at: time + 5), .none)
        }
        let final = try playback.enqueue(samples: 480, generation: 1, at: 100)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 100.999), .none)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 101), .start)
        XCTAssertEqual(playback.lastStartReason, .deadline)
        XCTAssertEqual(playback.lastStartQueuedSamples, 480)
        XCTAssertEqual(playback.finish(generation: 1, at: 101.01), .none)
        XCTAssertEqual(playback.completed(final), .finished)
        XCTAssertEqual(playback.starvationCount, 5)
    }

    func testTerminalRecoveryTailCannotWaitForeverBelowThreshold() throws {
        var playback = PlaybackBuffer()
        playback.begin(generation: 1)
        let first = try playback.enqueue(samples: 4_800, generation: 1, at: 0)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 1), .start)
        XCTAssertEqual(playback.completed(first), .pause)
        let tail = try playback.enqueue(samples: 480, generation: 1, at: 20)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 20), .none)
        XCTAssertEqual(playback.finish(generation: 1, at: 20.01), .start)
        XCTAssertEqual(playback.lastStartReason, .terminal)
        XCTAssertEqual(playback.lastStartQueuedSamples, 480)
        XCTAssertEqual(playback.completed(tail), .finished)
    }

    func testCancellationBeforeStartupInvalidatesDeadlineAndBufferedCompletions() throws {
        var playback = PlaybackBuffer()
        playback.begin(generation: 1)
        let old = try playback.enqueue(samples: 4_800, generation: 1, at: 0)
        playback.stop(generation: 2)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 10), .none)
        XCTAssertEqual(playback.playbackAction(generation: 2, at: 10), .none)
        XCTAssertEqual(playback.finish(generation: 1, at: 10), .none)
        XCTAssertEqual(playback.completed(old), .none)
        XCTAssertEqual(playback.queuedSamples, 0)
        XCTAssertNil(playback.startupDeadline)
        XCTAssertFalse(playback.isPlaying)
        XCTAssertThrowsError(try playback.enqueue(samples: 480, generation: 1, at: 10))
        XCTAssertThrowsError(try playback.enqueue(samples: 480, generation: 2, at: 10))
    }

    func testInterruptionAndRouteReplacementFenceOldCallbacksAndTimers() throws {
        var playback = PlaybackBuffer()
        playback.begin(generation: 1)
        let old = try playback.enqueue(samples: 19_200, generation: 1, at: 0)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 0), .start)
        playback.stop(generation: 2) // Interruption or route graph replacement.
        playback.begin(generation: 2)
        let replacement = try playback.enqueue(samples: 480, generation: 2, at: 100)
        playback.stop(generation: 1)
        playback.begin(generation: 1)
        XCTAssertEqual(playback.generation, 2)
        XCTAssertEqual(playback.completed(old), .none)
        XCTAssertEqual(playback.finish(generation: 1, at: 101), .none)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 101), .none)
        XCTAssertEqual(playback.queuedSamples, 480)
        XCTAssertEqual(playback.starvationCount, 0)
        XCTAssertEqual(playback.playbackAction(generation: 2, at: 100.999), .none)
        XCTAssertEqual(playback.finish(generation: 2, at: 101), .start)
        XCTAssertEqual(playback.completed(replacement), .finished)
    }

    func testReusedGenerationStillCannotSettleReplacementWithOldTicket() throws {
        var playback = PlaybackBuffer()
        playback.begin(generation: 1)
        let old = try playback.enqueue(samples: 480, generation: 1, at: 0)
        playback.stop(generation: 1)
        playback.begin(generation: 1)
        let replacement = try playback.enqueue(samples: 480, generation: 1, at: 100)
        XCTAssertNotEqual(old, replacement)
        XCTAssertEqual(playback.completed(old), .none)
        XCTAssertEqual(playback.queuedSamples, 480)
        XCTAssertEqual(playback.finish(generation: 1, at: 100), .start)
        XCTAssertEqual(playback.completed(replacement), .finished)
    }

    func testRouteRecoveryFencesOutputDuringDelayBeforeReplacementExists() throws {
        var playback = PlaybackBuffer()
        playback.begin(generation: 1)
        let queued = try playback.enqueue(samples: 480, generation: 1, at: 0)
        // Invalidate when the route stops the engine, before delayed recreation.
        playback.stop(generation: 2)
        XCTAssertEqual(playback.completed(queued), .none)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 0.25), .none)
        XCTAssertEqual(playback.finish(generation: 1, at: 0.25), .none)
        XCTAssertNil(playback.startupDeadline)
        XCTAssertFalse(playback.isPlaying)
        XCTAssertEqual(playback.queuedSamples, 0)
        playback.begin(generation: 3)
        _ = try playback.enqueue(samples: 480, generation: 3, at: 0.3)
        XCTAssertEqual(playback.playbackAction(generation: 3, at: 1.299), .none)
        XCTAssertEqual(playback.playbackAction(generation: 3, at: 1.3), .start)
    }

    func testDuplicateAndOutOfOrderCallbacksCannotUnderflowOrPrematurelySettle() throws {
        var playback = PlaybackBuffer()
        playback.begin(generation: 1)
        let first = try playback.enqueue(samples: 4_800, generation: 1, at: 0)
        let second = try playback.enqueue(samples: 2_880, generation: 1, at: 0.1)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 1), .start)
        XCTAssertEqual(playback.finish(generation: 1, at: 1.1), .none)
        XCTAssertEqual(playback.completed(second), .none)
        XCTAssertEqual(playback.completed(second), .none)
        XCTAssertEqual(playback.queuedSamples, 4_800)
        XCTAssertTrue(playback.isPlaying)
        XCTAssertEqual(playback.completed(first), .finished)
        XCTAssertEqual(playback.completed(first), .none)
        XCTAssertEqual(playback.queuedSamples, 0)
    }

    func testThreeSecondBoundAndInvalidPacketsDoNotMutateAccounting() throws {
        var playback = PlaybackBuffer()
        playback.begin(generation: 1)
        for time in [Double.nan, Double.infinity, -1] {
            XCTAssertThrowsError(try playback.enqueue(samples: 480, generation: 1, at: time))
        }
        for count in [0, -1, Int.max] {
            XCTAssertThrowsError(try playback.enqueue(samples: count, generation: 1, at: 0))
        }
        XCTAssertEqual(playback.queuedSamples, 0)
        XCTAssertNil(playback.startupDeadline)
        let full = try playback.enqueue(samples: 144_000, generation: 1, at: 0)
        XCTAssertThrowsError(try playback.enqueue(samples: 1, generation: 1, at: 0.1))
        XCTAssertEqual(playback.queuedSamples, 144_000)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 0.1), .start)
        XCTAssertEqual(playback.completed(full), .pause)
        XCTAssertNoThrow(try playback.enqueue(samples: 480, generation: 1, at: 1))
    }

    func testInvalidOrEarlierClockCannotStartPlayback() throws {
        var playback = PlaybackBuffer()
        playback.begin(generation: 1)
        _ = try playback.enqueue(samples: 480, generation: 1, at: 100)
        for time in [Double.nan, Double.infinity, 99, -1] {
            XCTAssertEqual(playback.playbackAction(generation: 1, at: time), .none)
        }
        XCTAssertEqual(playback.startupDeadline, 101)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 101), .start)
    }

    func testStartMetadataAndRecoveryTargetResetOnStopAndNewTurn() throws {
        var playback = PlaybackBuffer()
        playback.begin(generation: 1)
        XCTAssertNil(playback.lastStartReason)
        XCTAssertEqual(playback.lastStartQueuedSamples, 0)
        let first = try playback.enqueue(samples: 480, generation: 1, at: 0)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 1), .start)
        XCTAssertEqual(playback.completed(first), .pause)
        XCTAssertEqual(playback.targetSamples, 28_800)
        XCTAssertEqual(playback.lastStartReason, .deadline)
        XCTAssertEqual(playback.lastStartQueuedSamples, 480)

        playback.stop(generation: 2)
        XCTAssertNil(playback.lastStartReason)
        XCTAssertEqual(playback.lastStartQueuedSamples, 0)
        XCTAssertEqual(playback.targetSamples, 19_200)
        playback.begin(generation: 2)
        _ = try playback.enqueue(samples: 480, generation: 2, at: 10)
        XCTAssertEqual(playback.finish(generation: 2, at: 10), .start)
        XCTAssertEqual(playback.lastStartReason, .terminal)
        playback.begin(generation: 3)
        XCTAssertNil(playback.lastStartReason)
        XCTAssertEqual(playback.lastStartQueuedSamples, 0)
        XCTAssertEqual(playback.targetSamples, 19_200)
        XCTAssertEqual(playback.starvationCount, 0)
    }

    func testSyntheticRepresentative362MillisecondGapFits400MillisecondReserve() throws {
        // Only the 362 ms maximum gap came from the device report. This regular
        // 100 ms chunk cadence is invented, not a replay of a measured trace.
        // An ideal 48 kHz renderer tests reserve coverage, not hardware latency,
        // AEC, future provider throughput or gaps beyond this bounded fixture.
        let arrivalsMS = [0, 100, 200, 300, 662]
        var playback = PlaybackBuffer(), currentStartMS: Int?, legacyStartMS: Int?
        var acceptedSamples = 0
        playback.begin(generation: 1)
        for arrival in arrivalsMS {
            let at = Double(arrival) / 1_000
            _ = try playback.enqueue(samples: 4_800, generation: 1, at: at)
            if playback.playbackAction(generation: 1, at: at) == .start { currentStartMS = arrival }
            acceptedSamples += 4_800
            // Historical 160 ms target/250 ms deadline, before any consumption.
            if legacyStartMS == nil && (acceptedSamples >= 7_680 || arrival >= 250) { legacyStartMS = arrival }
        }
        XCTAssertEqual(currentStartMS, 300)
        XCTAssertEqual(legacyStartMS, 100)
        XCTAssertEqual(playback.lastStartReason, .threshold)
        XCTAssertEqual(playback.lastStartQueuedSamples, 19_200)

        func renderCoverage(startMS: Int) -> (missingSamples: Int, remainingBeforeFinalArrival: Int) {
            var remaining = 0, previousMS = 0, missing = 0, beforeFinal = 0
            for arrival in arrivalsMS {
                let consumed = max(0, arrival - max(previousMS, startMS)) * 48
                missing += max(0, consumed - remaining)
                remaining = max(0, remaining - consumed)
                beforeFinal = remaining
                remaining += 4_800
                previousMS = arrival
            }
            return (missing, beforeFinal)
        }
        let current = renderCoverage(startMS: try XCTUnwrap(currentStartMS))
        let legacy = renderCoverage(startMS: try XCTUnwrap(legacyStartMS))
        XCTAssertEqual(current.missingSamples, 0)
        XCTAssertEqual(current.remainingBeforeFinalArrival, 38 * 48)
        XCTAssertEqual(legacy.missingSamples, 162 * 48)
    }

    func testNoAudioCannotTriggerPlayerAndEmptyCompletionIsSafe() {
        var playback = PlaybackBuffer()
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 0), .none)
        XCTAssertEqual(playback.finish(generation: 1, at: 0), .none)
        playback.begin(generation: 1)
        XCTAssertNil(playback.startupDeadline)
        XCTAssertEqual(playback.playbackAction(generation: 1, at: 100), .none)
        XCTAssertEqual(playback.finish(generation: 1, at: 100), .finished)
        XCTAssertFalse(playback.isPlaying)
        XCTAssertEqual(playback.queuedSamples, 0)
    }
}
