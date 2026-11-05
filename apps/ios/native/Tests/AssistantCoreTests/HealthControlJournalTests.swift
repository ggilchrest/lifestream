import Foundation
import XCTest
@testable import AssistantCore
private final class JournalMemory:HealthSnapshotStorage {var bytes:Data?;var failRead=false,failWrite=false;func read()throws->Data?{if failRead{throw CocoaError(.fileReadNoPermission)};return bytes};func replace(_ data:Data)throws{if failWrite{throw CocoaError(.fileWriteNoPermission)};bytes=data}}
final class HealthControlJournalTests:XCTestCase {
 let principal=UUID(),endpoint=UUID(),session=UUID(),enrollment=UUID(),digest=String(repeating:"a",count:64)
 var scope:HealthControlJournal.Scope{.init(serverDigest:digest,principal:principal,endpoint:endpoint)}
 func testUnconfirmedSurvivesRestartAndFencesOtherWrites()throws{
  let disk=JournalMemory(),first=HealthControlJournal(storage:disk);_ = try first.prepare(scope:scope,session:session,operation:.remove,enrollment:enrollment,revision:2)
  let restarted=HealthControlJournal(storage:disk);XCTAssertEqual(try restarted.status(scope:scope),.current(.remove));XCTAssertThrowsError(try restarted.prepare(scope:scope,session:UUID(),operation:.configure,enrollment:enrollment,revision:3))
  XCTAssertEqual(try restarted.status(scope:.init(serverDigest:digest,principal:UUID(),endpoint:endpoint)),.heldElsewhere)
 }
 func testStorageAndCorruptionFailClosed()throws{
  let disk=JournalMemory(),journal=HealthControlJournal(storage:disk);disk.failWrite=true;XCTAssertThrowsError(try journal.prepare(scope:scope,session:session,operation:.enroll,enrollment:nil,revision:nil));XCTAssertNil(disk.bytes)
  disk.failWrite=false;disk.failRead=true;XCTAssertThrowsError(try journal.prepare(scope:scope,session:session,operation:.enroll,enrollment:nil,revision:nil));disk.failRead=false;disk.bytes=Data("{}".utf8);XCTAssertThrowsError(try journal.status(scope:scope));XCTAssertThrowsError(try journal.prepare(scope:scope,session:session,operation:.enroll,enrollment:nil,revision:nil))
 }
 func testNoBodyAndStrictScope()throws{
  let disk=JournalMemory(),j=HealthControlJournal(storage:disk);XCTAssertThrowsError(try j.prepare(scope:.init(serverDigest:"bad",principal:principal,endpoint:endpoint),session:session,operation:.enroll,enrollment:nil,revision:nil));XCTAssertThrowsError(try j.prepare(scope:scope,session:session,operation:.configure,enrollment:enrollment,revision:nil));_ = try j.prepare(scope:scope,session:session,operation:.configure,enrollment:enrollment,revision:1)
  let json=try XCTUnwrap(JSONSerialization.jsonObject(with:disk.bytes!) as? [String:Any]);XCTAssertNil(json["payload"]);XCTAssertNil(json["healthValues"]);XCTAssertEqual(json["operation"] as? String,"configure")
 }
}
