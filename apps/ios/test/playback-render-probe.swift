// Offline waveform only: no microphone, audio device, VPIO or audio session.
// Apple's AVAudioPlayerNode.h limits dataPlayedBack to device rendering. This
// probe deliberately does not exercise that callback or assert device timing.
import AVFoundation
import Foundation

func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fputs("Offline waveform probe failed: \(message)\n", stderr); exit(1) }
}

final class OfflineWaveform {
    let engine = AVAudioEngine(), player = AVAudioPlayerNode()
    let sourceFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
    let output: AVAudioPCMBuffer

    init(rate: Double = 48_000) throws {
        let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
        // Enable before accessing the mixer/input/output to avoid configuring
        // hardware. inputNode and the physical microphone are never accessed.
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 512)
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: sourceFormat)
        output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 512)!
        try engine.start()
        check(engine.isInManualRenderingMode, "must not render to hardware")
    }
    deinit { player.stop(); engine.stop() }

    @discardableResult
    func enqueue(_ values: [Int16]) throws -> [Float] {
        var bytes = Data(capacity: values.count * 2)
        for var value in values.map({ $0.littleEndian }) {
            withUnsafeBytes(of: &value) { bytes.append(contentsOf: $0) }
        }
        let decoded = try PlaybackPCM.decode(bytes, samples: values.count)
        let buffer = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: AVAudioFrameCount(decoded.count))!
        buffer.frameLength = AVAudioFrameCount(decoded.count)
        for (index, sample) in decoded.enumerated() { buffer.floatChannelData![0][index] = sample }
        // No completion callback is needed to inspect the rendered waveform.
        player.scheduleBuffer(buffer, completionHandler: nil)
        return decoded
    }

    func render(_ frames: Int) throws -> [Float] {
        var values = [Float](), attempts = 0
        while values.count < frames {
            attempts += 1
            check(attempts < frames + 100, "renderer made no progress")
            let requested = AVAudioFrameCount(min(512, frames - values.count))
            switch try engine.renderOffline(requested, to: output) {
            case .success:
                check(output.frameLength == requested, "render returned a short frame")
                values.append(contentsOf: UnsafeBufferPointer(start: output.floatChannelData![0], count: Int(output.frameLength)))
            case .cannotDoInCurrentContext: continue
            case .insufficientDataFromInputNode: check(false, "must never depend on microphone input")
            case .error: check(false, "render error")
            @unknown default: check(false, "unknown render status")
            }
        }
        return values
    }
}

func wave(_ count: Int, offset: Int = 0) -> [Int16] {
    (0..<count).map { Int16(8_000 + Int((sin(Double($0 + offset) * 0.047) * 3_000).rounded())) }
}
func silent(_ values: [Float], _ message: String) {
    check(values.allSatisfy { abs($0) < 0.000_01 }, message)
}
func same(_ actual: [Float], _ expected: [Float], _ message: String) {
    check(actual.count == expected.count, "\(message): frame count")
    let error = zip(actual, expected).map { abs($0 - $1) }.max() ?? 0
    check(error < 0.000_01, "\(message): sample continuity/amplitude error \(error)")
}

let stream = try OfflineWaveform()
stream.player.play(); stream.player.pause()
let first = try stream.enqueue(wave(4_800))
silent(try stream.render(1_024), "paused startup leaked audio")
let second = try stream.enqueue(wave(2_880, offset: 4_800))
stream.player.play()
same(try stream.render(7_680), first + second, "48k chunk boundary")
silent(try stream.render(1_024), "drained buffers leaked samples")

let short = try OfflineWaveform()
let tail = try short.enqueue(wave(173))
short.player.play()
same(try short.render(173), tail, "short buffer includes its final nonzero sample")
silent(try short.render(512), "short buffer leaked samples")

let cancelled = try OfflineWaveform()
_ = try cancelled.enqueue(wave(4_800))
cancelled.player.stop()
silent(try cancelled.render(1_024), "cancelled startup buffer played")
let replacement = try cancelled.enqueue(wave(4_800))
cancelled.player.play()
same(try cancelled.render(512), Array(replacement.prefix(512)), "replacement after cancel")
cancelled.player.stop()
silent(try cancelled.render(1_024), "cancellation did not flush unplayed PCM")

// Mixer conversion changes sample rate while preserving the 1 kHz tone and
// steady-state RMS. This does not emulate Bluetooth, HFP or voice processing.
let converted = try OfflineWaveform(rate: 16_000)
for frame in 0..<10 {
    let sine = (0..<4_800).map { Int16((sin(2 * Double.pi * 1_000 * Double(frame * 4_800 + $0) / 48_000) * 8_192).rounded()) }
    try converted.enqueue(sine)
}
converted.player.play()
let resampled = try converted.render(16_000)
let center = Array(resampled[1_600..<14_400])
let rms = sqrt(center.reduce(Double(0)) { $0 + Double($1 * $1) } / Double(center.count))
let crossings = zip(center, center.dropFirst()).filter { $0 <= 0 && $1 > 0 }.count
check(abs(rms - 0.25 / sqrt(2)) < 0.003, "48k to16k changed RMS: \(rms)")
check(abs(crossings - 800) <= 1, "48k to16k changed frequency: \(crossings)")

print("{\"nativePlayback\":\"pass\",\"scope\":\"offline waveform only; device dataPlayedBack completion not exercised\",\"physicalMicrophone\":false,\"physicalOutput\":false,\"sourceRate\":48000,\"renderRates\":[48000,16000],\"exactPCMFrames\":7853,\"resampledRMS\":\(rms),\"positiveCrossings\":\(crossings)}")
