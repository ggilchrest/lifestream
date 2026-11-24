import XCTest
@testable import AssistantCore

final class LongUtteranceTests:XCTestCase {
 private func consume(_ events:[SpeechGate.Event],_ began:inout Int,_ sizes:inout [Int],_ commits:inout [(Int,Int)],_ overflows:inout Int){
  for event in events{switch event{case .began:began += 1;case .frame(let data):sizes.append(data.count/2);case .commit(let sequence,let count):commits.append((sequence,count));case .overflow:overflows += 1}}
 }
 func testLongNaturalUtterancesRemainOneTurn(){
  for seconds in [25,31,60] {
   var gate=SpeechGate(),began=0,sizes=[Int](),commits=[(Int,Int)](),overflows=0
   for _ in 0..<(seconds*50){consume(gate.push(Array(repeating:0.08,count:320)),&began,&sizes,&commits,&overflows)}
   XCTAssertEqual(began,1);XCTAssertTrue(commits.isEmpty);XCTAssertEqual(overflows,0)
   for _ in 0..<30{consume(gate.push(Array(repeating:0,count:320)),&began,&sizes,&commits,&overflows)}
   XCTAssertEqual(commits.count,1);XCTAssertEqual(commits[0].0,sizes.count);XCTAssertEqual(commits[0].1,sizes.reduce(0,+));XCTAssertEqual(commits[0].1,seconds*16000+9600);XCTAssertEqual(overflows,0)
  }
 }
 func testFinishFlushesSubWindowAndCannotDoubleCommit(){
  var gate=SpeechGate(),began=0,sizes=[Int](),commits=[(Int,Int)](),overflows=0
  for _ in 0..<1600 {consume(gate.push(Array(repeating:0.08,count:320)),&began,&sizes,&commits,&overflows)}
  consume(gate.push(Array(repeating:0.08,count:123)),&began,&sizes,&commits,&overflows)
  consume(gate.finish(),&began,&sizes,&commits,&overflows)
  XCTAssertEqual(began,1);XCTAssertEqual(commits.count,1);XCTAssertEqual(commits[0].1,512123);XCTAssertEqual(commits[0].1,sizes.reduce(0,+));XCTAssertTrue(gate.finish().isEmpty)
 }
 func testNaturalPauseExactlyAtMaximumStillCommits(){
  var gate=SpeechGate(),began=0,sizes=[Int](),commits=[(Int,Int)](),overflows=0
  for _ in 0..<4470 {consume(gate.push(Array(repeating:0.08,count:320)),&began,&sizes,&commits,&overflows)}
  for _ in 0..<30 {consume(gate.push(Array(repeating:0,count:320)),&began,&sizes,&commits,&overflows)}
  XCTAssertEqual(began,1);XCTAssertEqual(overflows,0);XCTAssertEqual(commits.count,1);XCTAssertEqual(commits[0].1,SpeechGate.maximumUtteranceSamples)
 }
 func testOverflowDiscardsUncommittedInputAndNeverRestarts(){
  var gate=SpeechGate(),began=0,sizes=[Int](),commits=[(Int,Int)](),overflows=0
  for _ in 0..<4501 {consume(gate.push(Array(repeating:0.08,count:320)),&began,&sizes,&commits,&overflows)}
  XCTAssertEqual(began,1);XCTAssertEqual(overflows,1);XCTAssertTrue(commits.isEmpty);XCTAssertEqual(sizes.reduce(0,+),SpeechGate.maximumUtteranceSamples)
  XCTAssertTrue(gate.push(Array(repeating:0.08,count:3200)).isEmpty);XCTAssertTrue(gate.finish().isEmpty)
  gate.reset();consume(gate.push(Array(repeating:0.08,count:3200)),&began,&sizes,&commits,&overflows);XCTAssertEqual(began,2)
 }
 func testCancelResetCannotCommitOldFrames(){
  var gate=SpeechGate();_ = gate.push(Array(repeating:0.08,count:3200));gate.reset();XCTAssertTrue(gate.finish().isEmpty)
 }
 func testNativeOnsetAndNaturalPauseTimingsRemainUnchanged(){
  var gate=SpeechGate(),began=0,sizes=[Int](),commits=[(Int,Int)](),overflows=0
  for _ in 0..<7{consume(gate.push(Array(repeating:0.08,count:320)),&began,&sizes,&commits,&overflows)};XCTAssertEqual(began,0)
  consume(gate.push(Array(repeating:0.08,count:320)),&began,&sizes,&commits,&overflows);XCTAssertEqual(began,1)
  for _ in 0..<29{consume(gate.push(Array(repeating:0,count:320)),&began,&sizes,&commits,&overflows)};XCTAssertTrue(commits.isEmpty)
  consume(gate.push(Array(repeating:0,count:320)),&began,&sizes,&commits,&overflows);XCTAssertEqual(commits.count,1)
 }

}
