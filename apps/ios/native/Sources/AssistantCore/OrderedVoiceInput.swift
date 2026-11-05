// SPDX-License-Identifier: Apache-2.0
import Foundation

/// Bookkeeping for negotiated ordered input; no audio or transcript is stored.
public struct OrderedVoiceInput {
    public static let mode = "ordered-v1"
    public private(set) var committed = 0
    public private(set) var superseded = 0
    private var lastFinal = 0
    public init() {}
    public mutating func commit() -> Int { committed += 1; return committed }
    public mutating func continuation(through accepted:Int? = nil) -> Int? {
        let target=min(committed,accepted ?? committed)
        guard target > superseded else { return nil }
        superseded = target
        return target
    }
    public func isSuperseded(_ sequence:Int) -> Bool { sequence > 0 && sequence <= superseded }
    /// Server processes inputs in order and emits exactly one revision-1 final.
    public mutating func acceptFinal(sequence:Int,revision:Int) -> Bool {
        guard revision == 1, sequence == lastFinal + 1, sequence <= committed else { return false }
        lastFinal = sequence
        return true
    }
    public func isResolved(_ sequence:Int) -> Bool { sequence > 0 && sequence <= lastFinal }
    public mutating func settleWithoutFinal(sequence:Int) -> Bool {
        guard sequence == lastFinal + 1, sequence <= committed else { return false }
        lastFinal = sequence;return true
    }
}

/// Volatile, bounded whole-segment queue. Caller must stop admitting capture
/// and report overflow; previously queued segments remain available to drain.
public struct PendingVoiceSegments {
    public struct Segment {
        public let frames:[Data]
        public let samples:Int
        public let diagnosticTurn:Int?
    }
    public static let maximumSamples=1_440_000
    public static let maximumSegments=3
    private var completed=[Segment]()
    private var current=[Data]()
    private var currentSamples=0
    public private(set) var bufferedSamples=0
    public init() {}
    public var hasCompleted:Bool { !completed.isEmpty }
    public var hasCurrent:Bool { currentSamples>0 }
    public mutating func append(_ frame:Data) -> Bool {
        guard !frame.isEmpty,frame.count % 2 == 0 else{return false}
        let samples=frame.count/2
        guard samples <= Self.maximumSamples-bufferedSamples else{return false}
        current.append(frame);currentSamples += samples;bufferedSamples += samples;return true
    }
    public mutating func finish(diagnosticTurn:Int? = nil) -> Bool {
        guard currentSamples>0,completed.count<Self.maximumSegments else{return false}
        completed.append(Segment(frames:current,samples:currentSamples,diagnosticTurn:diagnosticTurn));current=[];currentSamples=0;return true
    }
    public mutating func pop() -> Segment? {
        guard !completed.isEmpty else{return nil}
        let value=completed.removeFirst();bufferedSamples -= value.samples;return value
    }
    public mutating func discardCurrent(){bufferedSamples -= currentSamples;current.removeAll();currentSamples=0}
    public mutating func clear(){completed.removeAll();current.removeAll();currentSamples=0;bufferedSamples=0}
}

/// A rejected commit gets one retry for each observed settlement, regardless
/// of whether that settlement arrived before or after the rejection.
public struct InputRetryFence {
    private var settlements=0,attemptSettlements=0
    public init() {}
    public mutating func attempted(){attemptSettlements=settlements}
    public mutating func settled(){settlements += 1}
    public var mayRetry:Bool { settlements > attemptSettlements }
}

public enum VoiceCaptureRecovery {
    public static func phase(paused:Bool, halted:Bool, inFlight:Int, pending:Bool, sending:Bool, blocked:Bool, normal:String) -> String {
        guard paused else{return normal}
        let drained=inFlight==0 && !sending && !blocked && (!pending || halted)
        guard drained else{return "Speech is paused. Earlier speech is still processing; wait before tapping Stop."}
        return halted ? "Some speech could not be submitted. Earlier accepted speech finished; tap Stop, then Start to listen again." : "Speech is paused. Earlier speech finished; tap Stop, then Start to listen again."
    }
}

/// Decode only a server-admitted final. Partial hypotheses never become history.
public struct OrderedVoiceFinal {
    public let trace:String
    public let inputSequence:Int
    public let revision:Int
    public let text:String
    public init?(message:[String:Any]) {
        guard message["type"] as? String == "transcript",
              message["state"] as? String == "committed",
              let trace=message["interactionTraceId"] as? String,UUID(uuidString:trace) != nil,
              let sequence=message["inputSequence"] as? Int,sequence>0,
              let revision=message["transcriptRevision"] as? Int,revision == 1,
              let text=message["text"] as? String,text.count<=16_000 else{return nil}
        self.trace=trace;self.inputSequence=sequence;self.revision=revision;self.text=text
    }
}
