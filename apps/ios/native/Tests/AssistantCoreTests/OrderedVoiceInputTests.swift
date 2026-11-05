import XCTest
@testable import AssistantCore
final class OrderedVoiceInputTests: XCTestCase {
 func testContinuationAndFinalsRemainOrderedAcrossSupersededTurns() {
  var state = OrderedVoiceInput()
  XCTAssertNil(state.continuation())
  XCTAssertEqual(state.commit(),1); XCTAssertEqual(state.continuation(),1)
  XCTAssertNil(state.continuation()); XCTAssertTrue(state.isSuperseded(1))
  XCTAssertEqual(state.commit(),2); XCTAssertFalse(state.isSuperseded(2))
  XCTAssertFalse(state.acceptFinal(sequence:2,revision:1))
  XCTAssertTrue(state.acceptFinal(sequence:1,revision:1))
  XCTAssertFalse(state.acceptFinal(sequence:1,revision:1))
  XCTAssertFalse(state.acceptFinal(sequence:2,revision:2))
  XCTAssertTrue(state.acceptFinal(sequence:2,revision:1))
 }
 func testNaturalPauseCreatesContinuationWithoutDiscardingAcceptedPrefix() {
  var gate=SpeechGate(), ordered=OrderedVoiceInput(), actions=[String]()
  func collect(_ events:[SpeechGate.Event]) {
   for event in events { switch event {
    case .began: if let previous=ordered.continuation(){actions.append("continue:\(previous)")} ; actions.append("begin")
    case .commit: actions.append("commit:\(ordered.commit())")
    case .frame: break
    case .overflow: actions.append("overflow")
   }}
  }
  for _ in 0..<100 { collect(gate.push(Array(repeating:0.08,count:320))) }
  for _ in 0..<30 { collect(gate.push(Array(repeating:0,count:320))) }
  for _ in 0..<100 { collect(gate.push(Array(repeating:0.08,count:320))) }
  for _ in 0..<30 { collect(gate.push(Array(repeating:0,count:320))) }
  XCTAssertEqual(actions,["begin","commit:1","continue:1","begin","commit:2"])
  XCTAssertTrue(ordered.acceptFinal(sequence:1,revision:1))
  XCTAssertTrue(ordered.acceptFinal(sequence:2,revision:1))
 }
 func testBoundedSegmentQueuePreservesEarlierAdmittedDataOnOverflow() {
  var queue=PendingVoiceSegments();let frame=Data(repeating:1,count:3200)
  XCTAssertTrue(queue.append(frame));XCTAssertTrue(queue.finish())
  XCTAssertFalse(queue.append(Data(repeating:2,count:PendingVoiceSegments.maximumSamples*2)))
  let first=queue.pop();XCTAssertEqual(first?.frames,[frame]);XCTAssertEqual(first?.samples,1600)
  XCTAssertEqual(queue.bufferedSamples,0);XCTAssertNil(queue.pop())
  XCTAssertTrue(queue.append(frame));queue.clear();XCTAssertEqual(queue.bufferedSamples,0)
 }
 func testSegmentLimitLeavesAlreadyCompletedSegmentsInOrder() {
  var queue=PendingVoiceSegments()
  for byte in UInt8(1)...UInt8(3) { XCTAssertTrue(queue.append(Data(repeating:byte,count:320)));XCTAssertTrue(queue.finish()) }
  XCTAssertTrue(queue.append(Data(repeating:4,count:320)));XCTAssertFalse(queue.finish())
  queue.discardCurrent()
  for byte in UInt8(1)...UInt8(3) { XCTAssertEqual(queue.pop()?.frames.first,Data(repeating:byte,count:320)) }
  XCTAssertEqual(queue.bufferedSamples,0)
 }
 func testFailedSegmentAllowsNextFinalWithoutInventingTranscript() {
  var state=OrderedVoiceInput();_ = state.commit();_ = state.commit()
  XCTAssertTrue(state.settleWithoutFinal(sequence:1));XCTAssertTrue(state.acceptFinal(sequence:2,revision:1))
  XCTAssertFalse(state.settleWithoutFinal(sequence:2))
 }
 func testBackpressureSettlementOrderGivesOneRetryWithoutBusyLoop() {
  var fence=InputRetryFence();fence.attempted();XCTAssertFalse(fence.mayRetry)
  fence.settled();XCTAssertTrue(fence.mayRetry);fence.attempted();XCTAssertFalse(fence.mayRetry)
  fence.settled();XCTAssertTrue(fence.mayRetry);fence.attempted();XCTAssertFalse(fence.mayRetry)
 }
 func testPausedCaptureDoesNotPretendToListenAndRecoversOnlyAfterDrain() {
  func phase(_ flight:Int,_ pending:Bool,_ halted:Bool)->String { VoiceCaptureRecovery.phase(paused:true,halted:halted,inFlight:flight,pending:pending,sending:false,blocked:false,normal:"Listening") }
  XCTAssertTrue(phase(1,false,false).contains("still processing"))
  XCTAssertTrue(phase(0,true,false).contains("still processing"))
  XCTAssertTrue(phase(0,false,false).contains("tap Stop, then Start"))
  XCTAssertTrue(phase(0,true,true).contains("could not be submitted"))
  XCTAssertEqual(VoiceCaptureRecovery.phase(paused:false,halted:false,inFlight:0,pending:false,sending:false,blocked:false,normal:"Listening"),"Listening")
 }
 func testGateExposesUnframedSamplesForInclusiveMemoryAccounting() {
  var gate=SpeechGate();_ = gate.push(Array(repeating:0,count:123));XCTAssertEqual(gate.bufferedUnframedSamples,123)
  _ = gate.push(Array(repeating:0,count:197));XCTAssertEqual(gate.bufferedUnframedSamples,320)
  gate.reset();XCTAssertEqual(gate.bufferedUnframedSamples,0)
 }
}
