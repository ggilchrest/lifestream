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
