import XCTest
@testable import AssistantCore
final class VoiceProtocolTests: XCTestCase {
    func testEndpointDoesNotAllowCredentialOrTransportDowngrade() throws {
        for value in ["http://host.local", "https://user:secret@host.local", "https://host.local/path", "https://host.local?token=a", "file:///tmp/app"] { XCTAssertThrowsError(try EndpointPolicy.validate(value)) }
        XCTAssertEqual(try EndpointPolicy.validate("https://host.local:443").host, "host.local")
        XCTAssertThrowsError(try EndpointPolicy.validate("http://127.0.0.1:43182"))
        XCTAssertNoThrow(try EndpointPolicy.validate("http://127.0.0.1:43182", allowLoopback: true))
        XCTAssertFalse(EndpointPolicy.permits("/api/runtime/v1/presentation/resources/a/../secret", method: "GET"))
        XCTAssertFalse(EndpointPolicy.permits("/api/admin/v1/assistants", method: "POST"))
        XCTAssertFalse(EndpointPolicy.permits("/api/runtime/v1/presentation/resources/sample/model.glb", method: "GET"))
        XCTAssertFalse(EndpointPolicy.permits("/api/runtime/v1/presentation", method: "POST"))
    }
    func testPlaybackAccountingAndLateFrameFence() throws {
        let trace = UUID().uuidString; var stream = ReplyStream(); try stream.begin(trace)
        try stream.accept(trace: trace, segment: "a", sequence: 0, offset: 0, count: 4800, bytes: Data(count: 9600), queuedSamples: 0)
        XCTAssertThrowsError(try stream.accept(trace: trace, segment: "a", sequence: 0, offset: 0, count: 4800, bytes: Data(count: 9600), queuedSamples: 4800))
        try stream.finish(trace); XCTAssertThrowsError(try stream.accept(trace: trace, segment: "a", sequence: 1, offset: 4800, count: 1, bytes: Data(count: 2), queuedSamples: 0))
        stream.retire(); XCTAssertThrowsError(try stream.begin(trace)); XCTAssertNil(stream.trace)
    }
    func testPlaybackIsBoundedAndSegmentsCannotReplay() throws {
        var s=ReplyStream(); let t=UUID().uuidString; try s.begin(t)
        XCTAssertThrowsError(try s.accept(trace:t,segment:"a",sequence:0,offset:0,count:4800,bytes:Data(count:9600),queuedSamples:144000))
        try s.accept(trace:t,segment:"a",sequence:0,offset:0,count:1,bytes:Data(count:2),queuedSamples:0)
        try s.accept(trace:t,segment:"b",sequence:0,offset:0,count:1,bytes:Data(count:2),queuedSamples:0)
        XCTAssertThrowsError(try s.accept(trace:t,segment:"a",sequence:0,offset:0,count:1,bytes:Data(count:2),queuedSamples:0))
    }
    func testSpeechGateCommitsExactPCMAndResets() {
        var gate=SpeechGate(), frames=[Data](), began=0, committed:Int?
        for chunk in Array(repeating:Array(repeating:Float(0.1),count:1600),count:5)+Array(repeating:Array(repeating:Float(0),count:1600),count:7) {
            for event in gate.push(chunk) { switch event { case .began:began += 1;case .frame(let bytes):frames.append(bytes);case .commit(let sequence,let samples):XCTAssertEqual(sequence,frames.count);committed=samples } }
        }
        XCTAssertEqual(began,1);XCTAssertEqual(committed,frames.reduce(0){$0+$1.count/2});XCTAssertFalse(gate.speaking)
        XCTAssertTrue(gate.push(Array(repeating:0,count:1600)).isEmpty)
    }
    func testSpeechGateAcceptsLargeVariableTapBuffersWithoutLosingSpeech() {
        // AVAudioEngine's requested tap size is advisory. A valid callback can
        // contain more than the transport's 4,800-sample per-frame limit.
        let samples=Array(repeating:Float(0.1),count:16000)+Array(repeating:Float(0),count:16000)
        func collect(_ size:Int)->(Int,[Data],Int?) {
            var gate=SpeechGate(),began=0,frames=[Data](),committed:Int?
            for offset in stride(from:0,to:samples.count,by:size) {
                for event in gate.push(Array(samples[offset..<min(offset+size,samples.count)])) {
                    switch event {case .began:began += 1;case .frame(let bytes):frames.append(bytes);case .commit(let sequence,let count):XCTAssertEqual(sequence,frames.count);committed=count}
                }
            }
            return (began,frames,committed)
        }
        let small=collect(320),large=collect(8192),uneven=collect(1379)
        XCTAssertEqual(large.0,1);XCTAssertEqual(large.1,small.1);XCTAssertEqual(large.2,small.2)
        XCTAssertEqual(uneven.1,small.1);XCTAssertEqual(uneven.2,small.2)
        XCTAssertEqual(large.2,large.1.reduce(0){$0+$1.count/2})
        XCTAssertTrue(large.1.allSatisfy{!$0.isEmpty&&$0.count<=9600})
    }
    func testVoiceActivitySeparatesCaptureTranscriptionGenerationAndPlayback() {
        var activity=VoiceActivity();activity.start();XCTAssertEqual(activity.backendStage,"connecting")
        activity.captureReady();XCTAssertEqual(activity.inputStage,"starting");XCTAssertEqual(activity.inputFrames,0)
        activity.captured([0.1,-0.1],speaking:true,waiting:false)
        XCTAssertEqual(activity.inputFrames,1);XCTAssertEqual(activity.inputStage,"capturing");XCTAssertEqual(activity.inputLevel,0.1,accuracy:0.001)
        activity.sentFrame();activity.committed();XCTAssertEqual(activity.backendStage,"transcribing");XCTAssertEqual(activity.sentFrames,1)
        activity.transcribed();XCTAssertEqual(activity.backendStage,"generating");XCTAssertEqual(activity.outputStage,"idle")
        activity.receivedText();XCTAssertEqual(activity.outputStage,"buffering")
        activity.playing();XCTAssertEqual(activity.outputStage,"playing")
        activity.receivedText();XCTAssertEqual(activity.outputStage,"playing")
        activity.playbackDrained();XCTAssertEqual(activity.outputStage,"buffering")
        activity.playing();activity.generationFinished();XCTAssertEqual(activity.backendStage,"idle");XCTAssertEqual(activity.outputStage,"playing")
        activity.playbackDrained();XCTAssertEqual(activity.outputStage,"idle")
        activity.completed();XCTAssertEqual(activity.backendStage,"idle");XCTAssertEqual(activity.outputStage,"idle")
        activity.fail("No microphone buffers arrived.",stage:"input");XCTAssertEqual(activity.inputStage,"error");XCTAssertEqual(activity.lastError,"No microphone buffers arrived.")
        activity.stop();XCTAssertEqual(activity.inputStage,"off");XCTAssertEqual(activity.lastError,"")
    }
    func testCaptureReadyWaitsForValidConvertedAudioAndSilenceIsNotSpeech() {
        var activity=VoiceActivity();activity.start();activity.captureReady()
        XCTAssertEqual(activity.inputStage,"starting");XCTAssertEqual(activity.backendStage,"idle")
        activity.captured([],speaking:false,waiting:false)
        activity.captured([.nan],speaking:false,waiting:false)
        XCTAssertEqual(activity.inputStage,"starting");XCTAssertEqual(activity.inputFrames,0)
        activity.captured([0,0,0],speaking:false,waiting:false)
        XCTAssertEqual(activity.inputStage,"listening");XCTAssertEqual(activity.inputFrames,1);XCTAssertEqual(activity.inputLevel,0)
        activity.stop();XCTAssertEqual(activity.inputStage,"off");XCTAssertEqual(activity.inputFrames,1)
        activity.start();XCTAssertEqual(activity.inputStage,"starting");XCTAssertEqual(activity.inputFrames,0)
    }
}

extension VoiceProtocolTests {
 func testAudienceExpiryAndMalformedClaimsFailClosed() throws {
  let now=Date(timeIntervalSince1970:1800000000),future="2027-01-15T08:01:00.000Z"
  XCTAssertNoThrow(try AudienceLease(["privateAllowed":false,"classification":"unknown","expiresAt":NSNull()],now:now))
  XCTAssertNoThrow(try AudienceLease(["privateAllowed":true,"classification":"solo-supported","expiresAt":future],now:now))
  for fields:[String:Any] in [
   ["privateAllowed":true,"classification":"solo-supported","expiresAt":NSNull()],
   ["privateAllowed":true,"classification":"solo-supported","expiresAt":"bad"],
   ["privateAllowed":true,"classification":"solo-supported","expiresAt":"2020-01-01T00:00:00.000Z"],
   ["privateAllowed":true,"classification":"shared","expiresAt":future],
   ["privateAllowed":true,"classification":"unknown","expiresAt":future]
  ] {XCTAssertThrowsError(try AudienceLease(fields,now:now))}
 }
 func testRetiredTraceWindowIsBoundedAndSilenceNeverCommits() throws {
  var stream=ReplyStream(),gate=SpeechGate()
  for _ in 0..<200 {let trace=UUID().uuidString;try stream.begin(trace);stream.retire()}
  XCTAssertEqual(stream.retired.count,64)
  for _ in 0..<1000 {XCTAssertTrue(gate.push(Array(repeating:0,count:1024)).isEmpty)}
  XCTAssertTrue(gate.push([.nan]).isEmpty);XCTAssertFalse(gate.speaking)
 }
}
