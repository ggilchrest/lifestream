// SPDX-License-Identifier: Apache-2.0
import Foundation

public enum VoiceError: Error { case invalidEndpoint, invalidFrame, staleTurn, overflow, invalidMessage }
public enum EndpointPolicy {
    public static func validate(_ input: String, allowLoopback: Bool = false) throws -> URL {
        guard let url = URL(string: input), let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/",
              url.scheme == "https" || (allowLoopback && url.scheme == "http" && ["localhost", "127.0.0.1", "[::1]"].contains(host)) else { throw VoiceError.invalidEndpoint }
        return url
    }
    public static func permits(_ path: String, method: String) -> Bool {
        guard !path.contains(".."), !path.contains("%"), !path.contains("?"), !path.contains("#"), !path.contains("\\"), !path.contains("//") else { return false }
        if method == "GET" {
            if ["/api/auth/v1/status", "/api/auth/v1/session", "/api/runtime/v1/session-context", "/api/runtime/v1/audience", "/api/runtime/v1/presentation", "/api/admin/v1/assistants"].contains(path) { return true }
            if path.range(of: "^/api/admin/v1/assistants/[a-fA-F0-9-]{36}/relationships$", options: .regularExpression) != nil { return true }
            return path.range(of: "^/api/runtime/v1/presentation/resources/[a-zA-Z0-9._-]+/[a-zA-Z0-9/._-]+$", options: .regularExpression) != nil
        }
        return method == "POST" && ["/api/auth/v1/sign-in", "/api/auth/v1/sign-out", "/api/runtime/v1/session-context", "/api/runtime/v1/audience", "/api/runtime/v1/presentation", "/api/runtime/v1/messages"].contains(path)
    }
}

/// Native PCM acceptance is independent of JavaScript and survives WebView suspension.
public struct ReplyStream {
    public private(set) var trace: String?
    public private(set) var totalSamples = 0
    public private(set) var terminal = false
    public private(set) var retired: [String] = []
    private var segment: String?
    private var segments = Set<String>()
    private var sequence = 0
    private var segmentSamples = 0
    public init() {}
    public mutating func begin(_ id: String) throws {
        guard UUID(uuidString: id) != nil, !retired.contains(id), trace == nil else { throw VoiceError.staleTurn }
        trace = id; totalSamples = 0; terminal = false; segment = nil; segments = []; sequence = 0; segmentSamples = 0
    }
    public mutating func accept(trace id: String, segment next: String, sequence index: Int, offset: Int, count: Int, bytes: Data, queuedSamples: Int) throws {
        guard id == trace, !terminal, !retired.contains(id) else { throw VoiceError.staleTurn }
        guard !next.isEmpty, next.count <= 200 else { throw VoiceError.invalidFrame }
        if next != segment {
            guard !segments.contains(next), segments.count < 128 else { throw VoiceError.invalidFrame }
            segments.insert(next); segment = next; sequence = 0; segmentSamples = 0
        }
        guard index == sequence, offset == segmentSamples, count > 0, count <= 4800, bytes.count == count * 2 else { throw VoiceError.invalidFrame }
        guard totalSamples + count <= 48000 * 180, queuedSamples + count <= 48000 * 3 else { throw VoiceError.overflow }
        totalSamples += count; segmentSamples += count; sequence += 1
    }
    public mutating func finish(_ id: String) throws {
        guard trace == id, !terminal, totalSamples > 0 else { throw VoiceError.invalidMessage }
        terminal = true
    }
    public mutating func retire() {
        if let id = trace { retired.append(id); if retired.count > 64 { retired.removeFirst() } }
        trace = nil; totalSamples = 0; segmentSamples = 0; sequence = 0; terminal = false; segments = []; segment = nil
    }
}

/// Bounded local speech gate after Apple's voice processing, not a speaker-identity detector.
public struct SpeechGate {
    public enum Event { case began, frame(Data), commit(Int, Int) }
    private var pre = [Float](), pending = [Float]()
    private var voiced = 0, silence = 0, sequence = 0, sent = 0
    public private(set) var speaking = false
    public var threshold: Float = 0.018
    public init() {}
    public mutating func reset() { pre.removeAll(); pending.removeAll(); voiced = 0; silence = 0; sequence = 0; sent = 0; speaking = false }
    public mutating func push(_ samples: [Float]) -> [Event] {
        guard !samples.isEmpty, samples.count <= 4800, samples.allSatisfy({ $0.isFinite }) else { reset(); return [] }
        let rms = sqrt(samples.reduce(Float(0)) { $0 + $1 * $1 } / Float(samples.count))
        var events = [Event]()
        if !speaking {
            pre.append(contentsOf: samples); if pre.count > 4800 { pre.removeFirst(pre.count - 4800) }
            voiced = rms >= threshold ? voiced + samples.count : 0
            guard voiced >= 2560 else { return [] }
            speaking = true; pending = pre; pre.removeAll(); events.append(.began)
        } else { pending.append(contentsOf: samples) }
        silence = rms < threshold * 0.65 ? silence + samples.count : 0
        while pending.count >= 1600 { events.append(.frame(Self.pcm(Array(pending.prefix(1600))))); pending.removeFirst(1600); sequence += 1; sent += 1600 }
        if silence >= 9600 || sent + pending.count >= 320000 {
            if !pending.isEmpty { events.append(.frame(Self.pcm(pending))); sequence += 1; sent += pending.count }
            events.append(.commit(sequence, sent)); reset()
        }
        return events
    }
    private static func pcm(_ samples: [Float]) -> Data {
        var result = Data(capacity: samples.count * 2)
        for sample in samples { var value = Int16(max(-32768, min(32767, Int((sample * 32767).rounded())))).littleEndian; withUnsafeBytes(of: &value) { result.append(contentsOf: $0) } }
        return result
    }
}

/// A malformed or expired private claim never becomes an unlimited background lease.
public struct AudienceLease {
    public let expiresAt: Date?
    public init(_ value:[String:Any],now:Date) throws {
        guard let allowed=value["privateAllowed"] as? Bool,let classification=value["classification"] as? String,
              ["solo-supported","shared","unknown"].contains(classification),
              !allowed || classification=="solo-supported" else{throw VoiceError.invalidMessage}
        if let raw=value["expiresAt"] as? String {
            let parser=ISO8601DateFormatter();parser.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
            guard let date=parser.date(from:raw),date>now else{throw VoiceError.staleTurn};expiresAt=date
        } else {
            guard !allowed,value["expiresAt"] == nil || value["expiresAt"] is NSNull else{throw VoiceError.invalidMessage}
            expiresAt=nil
        }
    }
}
