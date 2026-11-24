import XCTest
@testable import AssistantCore
final class FailureOriginTests:XCTestCase {
 func testClosedOriginAndFallback(){
  XCTAssertEqual(FailureOrigin.decode(["stage":"inference","code":"provider_timeout"]),FailureOrigin(stage:.inference,code:.providerTimeout))
  for invalid:Any? in [nil,["stage":"inference","code":"private message"],["stage":"secret","code":"failed"],["stage":"inference"]] {XCTAssertEqual(FailureOrigin.decode(invalid),FailureOrigin(stage:.unknown,code:.failed))}
 }
 func testExportKeepsClosedOriginAndNeverUntrustedText(){
  let b=DiagnosticBuffer();b.setEnabled(true);let origin=FailureOrigin.decode(["stage":"synthesis","code":"no_audio","message":"secret transcript"])
  XCTAssertTrue(b.record(.voiceTerminalFailed,code:.audioTurnFailed,turn:3,failureOrigin:origin))
  let bytes=b.encoded()!,value=String(decoding:bytes,as:UTF8.self);XCTAssertTrue(value.contains("synthesis"));XCTAssertTrue(value.contains("no_audio"));XCTAssertFalse(value.contains("secret transcript"))
  let restored=DiagnosticBuffer();restored.restore(bytes);XCTAssertEqual(restored.snapshot().first?.failureStage,.synthesis)
 }
 func testSpeechSynthesisFailureDoesNotClaimRecognitionFailureOrPendingWork(){
  let message=VoiceDiagnostic.userFailureMessage(.synthesis)
  XCTAssertTrue(message.contains("could not be spoken"));XCTAssertTrue(message.contains("was transcribed"));XCTAssertFalse(message.contains("still processing"))
  XCTAssertTrue(VoiceDiagnostic.userFailureMessage(.recognition).contains("transcribed"))
 }
}
