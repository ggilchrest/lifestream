// SPDX-License-Identifier: Apache-2.0
import Foundation

/// Bounded scheduling policy for 48 kHz mono speech. The native host owns the
/// PCM buffers and calls this value on one serial executor, using monotonic time.
/// `queuedSamples` counts scheduled buffers awaiting dataPlayedBack callbacks;
/// it is not a sample-accurate measure of the audio hardware's remaining queue.
public struct PlaybackBuffer {
    public static let sampleRateHz = 48_000
    public static let startupSamples = 19_200 // 400 ms before the first start.
    public static let recoverySamples = 28_800 // 600 ms after an observed drain.
    public static let maximumQueuedSamples = 144_000 // Preserve the 3 s bound.
    public static let maximumWait: TimeInterval = 1

    public enum Action: Equatable { case none, start, pause, finished }
    public enum StartReason: String { case threshold, deadline, terminal }

    /// Keep the ticket in the matching scheduled buffer's completion closure.
    /// A ticket can settle exactly once, including across a reused generation.
    public struct Ticket: Equatable, Hashable {
        public let generation: Int
        fileprivate let sequence: UInt64
    }

    public private(set) var generation: Int?
    public private(set) var queuedSamples = 0
    public private(set) var isPlaying = false
    public private(set) var terminal = false
    /// Observed nonterminal queue drains, not proof of an audible underrun.
    public private(set) var starvationCount = 0
    public private(set) var lastStartReason: StartReason?
    public private(set) var lastStartQueuedSamples = 0
    private var active = false
    private var firstQueuedAt: TimeInterval?
    private var nextSequence: UInt64 = 0
    private var pending: [Ticket: Int] = [:]

    public init() {}

    public var targetSamples: Int {
        starvationCount > 0 ? Self.recoverySamples : Self.startupSamples
    }

    /// Schedule a timer for this deadline while buffering. Capture the current
    /// generation and pass it to playbackAction; stale timers cannot start audio.
    public var startupDeadline: TimeInterval? {
        guard active, !isPlaying, queuedSamples > 0, let firstQueuedAt else { return nil }
        return firstQueuedAt + Self.maximumWait
    }

    public mutating func begin(generation: Int) {
        guard self.generation.map({ generation >= $0 }) ?? true else { return }
        reset(generation: generation)
        active = true
    }

    /// Cancel, interrupt or replace a route before stopping the native player.
    /// Clearing tickets first makes synchronously delivered stop callbacks safe.
    public mutating func stop(generation: Int) {
        guard self.generation.map({ generation >= $0 }) ?? true else { return }
        reset(generation: generation)
    }

    private mutating func reset(generation: Int) {
        self.generation = generation
        active = false
        queuedSamples = 0
        isPlaying = false
        terminal = false
        starvationCount = 0
        lastStartReason = nil
        lastStartQueuedSamples = 0
        firstQueuedAt = nil
        pending.removeAll(keepingCapacity: true)
        // Never reset nextSequence: a stopped graph can deliver a late callback
        // even when the caller reuses its generation for a replacement turn.
    }

    /// Call after protocol validation and immediately before scheduling PCM.
    /// If native scheduling subsequently fails, stop this generation.
    public mutating func enqueue(samples: Int, generation: Int, at: TimeInterval) throws -> Ticket {
        guard active, self.generation == generation, !terminal else { throw VoiceError.staleTurn }
        guard samples > 0, at.isFinite, at >= 0 else { throw VoiceError.invalidFrame }
        guard samples <= Self.maximumQueuedSamples - queuedSamples else { throw VoiceError.overflow }
        let ticket = Ticket(generation: generation, sequence: nextSequence)
        nextSequence += 1
        if queuedSamples == 0 { firstQueuedAt = at }
        pending[ticket] = samples
        queuedSamples += samples
        return ticket
    }

    /// Call after scheduling a buffer and when the startup deadline fires.
    /// More packets cannot postpone the first packet's deadline indefinitely.
    public mutating func playbackAction(generation: Int, at: TimeInterval) -> Action {
        guard active, self.generation == generation, !isPlaying,
              queuedSamples > 0, at.isFinite, let firstQueuedAt, at >= firstQueuedAt else { return .none }
        guard terminal || queuedSamples >= targetSamples || at >= firstQueuedAt + Self.maximumWait else { return .none }
        lastStartReason = terminal ? .terminal : queuedSamples >= targetSamples ? .threshold : .deadline
        lastStartQueuedSamples = queuedSamples
        isPlaying = true
        return .start
    }

    /// A terminal tail is playable immediately, even below the startup target.
    /// An already drained response finishes without waiting for another packet.
    public mutating func finish(generation: Int, at: TimeInterval) -> Action {
        guard active, self.generation == generation, !terminal else { return .none }
        terminal = true
        if queuedSamples == 0 {
            active = false
            isPlaying = false
            firstQueuedAt = nil
            return .finished
        }
        return playbackAction(generation: generation, at: at)
    }

    /// Apply the returned pause before receiving/scheduling more PCM. Following
    /// a drain, the next packet opens a fresh bounded recovery-buffer window.
    public mutating func completed(_ ticket: Ticket) -> Action {
        guard active, ticket.generation == generation,
              let samples = pending.removeValue(forKey: ticket) else { return .none }
        queuedSamples -= samples
        guard queuedSamples == 0 else { return .none }
        let wasPlaying = isPlaying
        isPlaying = false
        firstQueuedAt = nil
        if terminal {
            active = false
            return .finished
        }
        if wasPlaying {
            starvationCount += 1
            return .pause
        }
        return .none
    }
}
