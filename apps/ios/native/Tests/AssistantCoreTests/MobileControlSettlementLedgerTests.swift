import Foundation
import CryptoKit
import XCTest
@testable import AssistantCore
private final class LedgerMemory:HealthSnapshotStorage {var bytes:Data?;var writeFails=false;func read()throws->Data?{bytes};func replace(_ value:Data)throws{if writeFails{throw CocoaError(.fileWriteNoPermission)};bytes=value}}
private final class FixtureWitness:MobileControlSettlementWitness {
 var value:MobileControlSettlementLedger.WitnessValue?;var reject=false,throwAfterAdvance=false
 func current(serverDigest:String,principal:UUID)throws->MobileControlSettlementLedger.WitnessValue?{value}
 func compareAndAdvance(serverDigest:String,principal:UUID,expected:MobileControlSettlementLedger.WitnessValue,next:MobileControlSettlementLedger.WitnessValue)throws->Bool{guard !reject,value==expected else{return false};value=next;if throwAfterAdvance {throw CocoaError(.fileWriteUnknown)};return true}
}
private final class LedgerLease:MobileControlExclusiveLease {
 let lock=NSRecursiveLock();var current=true
 func withFence<T>(_ body:()throws->T)throws->T{lock.lock();defer{lock.unlock()};return try body()}
 func isCurrent(serverDigest:String,principal:UUID)->Bool{current}
 func release(){current=false}
}
final class MobileControlSettlementLedgerTests:XCTestCase {
 func id()->String{UUID().uuidString.lowercased()}
 func data(_ x:Any)throws->Data{try JSONSerialization.data(withJSONObject:x,options:[.sortedKeys,.withoutEscapingSlashes])}
 private func setup()throws->(LedgerMemory,FixtureWitness,MobileControlSettlementLedger,MobileControlSettlementLedger.Scope,Data,[String:Any],LedgerLease) {
  let disk=LedgerMemory(),w=FixtureWitness(),p=UUID(),e=UUID(),session=UUID(),enrollment=id(),namespace=id(),assistant=id(),operation=id()
  disk.bytes=try MobileControlSettlementLedger.genesisBytes();w.value=try MobileControlSettlementLedger.genesisWitness()
  let scope=MobileControlSettlementLedger.Scope(serverDigest:String(repeating:"a",count:64),principal:p,endpoint:e,session:session)
  let config:[String:Any]=["categories":["SleepSegment"],"uses":["answers"],"assistantIds":[assistant],"collectionPaused":false,"usePaused":false]
  let original:[String:Any]=["schemaVersion":"1.0.0","operationId":operation,"target":["principalId":p.uuidString.lowercased(),"endpointId":e.uuidString.lowercased(),"collector":"healthKit","enrollmentId":enrollment,"sourceNamespace":namespace,"expectedRevision":2],"action":["kind":"configure","state":"active","configuration":config]]
  return (disk,w,MobileControlSettlementLedger(storage:disk,witness:w),scope,try data(original),original,LedgerLease())
 }
 private func seedV1(_ disk:LedgerMemory,_ witness:FixtureWitness,_ scope:MobileControlSettlementLedger.Scope,_ original:Data)throws {
  var doc=try XCTUnwrap(JSONSerialization.jsonObject(with:MobileControlSettlementLedger.genesisBytes()) as? [String:Any]);let parsed=try MobileControlOriginal.parse(original)
  doc["entries"]=[["kind":"intent","serverDigest":scope.serverDigest,"principal":scope.principal.uuidString,"endpoint":scope.endpoint.uuidString,"session":scope.session.uuidString,"original":parsed.canonical.base64EncodedString(),"originalDigest":parsed.digest,"expectedRevision":1]]
  let bytes=try data(doc);disk.bytes=bytes;let digest=SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined();witness.value = .init(epoch:1,digest:digest)
 }
 func response(_ original:[String:Any],status:String,revision:Any)throws->Data {
  let request=try MobileControlOriginal.parse(data(original)),target=original["target"] as! [String:Any],action=original["action"] as! [String:Any]
  var result:[String:Any]=["originalRequest":original,"requestDigest":request.digest,"current":["state":"current","policyRevision":3],"status":status=="applied" ? "applied":"pending"]
  if status=="applied" {let enrollment:[String:Any]=["enrollmentId":target["enrollmentId"]!,"principalId":target["principalId"]!,"endpointId":target["endpointId"]!,"collector":"healthKit","sourceNamespace":target["sourceNamespace"]!,"revision":3,"state":"active","configuration":action["configuration"]!];result["receipt"]=["receiptId":id(),"committedAt":"2026-10-30T00:00:00Z","durability":"sqlCommit","result":["kind":"configure","enrollment":enrollment]]}
  let control:[String:Any]=["schemaVersion":"1.0.0","producerPin":["schemaId":MobileControlOriginal.schemaId,"schemaVersion":"1.0.0","digest":MobileControlOriginal.schemaSHA256],"result":result]
  return try data(["schemaVersion":"1.0.0","producerPin":["schemaId":MobileInterpretationSchema.schemaId,"schemaVersion":"1.0.0","digest":MobileInterpretationSchema.digest],"result":["state":"mutation","controlResponse":control,"interpretationStatus":status,"interpretationRevision":revision,"operationId":original["operationId"]!,"limitations":[]]])
 }
 func testV1PendingRequiresAuthenticatedInterpretationTerminalBeforeUpgrade()throws {
  let (disk,w,ledger,scope,original,obj,lease)=try setup();try seedV1(disk,w,scope,original);let before=try XCTUnwrap(disk.bytes)
  XCTAssertEqual(try ledger.pending(scope:scope)?.original,original)
  XCTAssertThrowsError(try ledger.stage(scope:scope,original:original,expectedRevision:1));XCTAssertThrowsError(try ledger.upgradeQualifiedV1(scope:scope,authenticatedInterpretationResponse:nil,lease:lease))
  XCTAssertThrowsError(try ledger.appendAuthenticatedInterpretationTerminal(scope:scope,response:response(obj,status:"pending",revision:NSNull()),lease:lease));XCTAssertEqual(disk.bytes,before)
  let terminal=try response(obj,status:"applied",revision:1);try ledger.appendAuthenticatedInterpretationTerminal(scope:scope,response:terminal,lease:lease)
  try ledger.upgradeQualifiedV1(scope:scope,authenticatedInterpretationResponse:terminal,lease:lease);XCTAssertEqual(w.value?.epoch,3)
  let restarted=MobileControlSettlementLedger(storage:disk,witness:w);XCTAssertThrowsError(try restarted.revalidateQualifiedUpgrade(scope:scope,authenticatedInterpretationResponse:nil,lease:lease));try restarted.revalidateQualifiedUpgrade(scope:scope,authenticatedInterpretationResponse:terminal,lease:lease)
 }
 func testMissingOrRolledBackWitnessFailsClosed()throws {
  let (disk,w,ledger,scope,original,_,_)=try setup();let genesis=try XCTUnwrap(disk.bytes);try seedV1(disk,w,scope,original);disk.bytes=genesis;XCTAssertThrowsError(try ledger.pending(scope:scope));w.value=nil;XCTAssertThrowsError(try ledger.pending(scope:scope));XCTAssertThrowsError(try MobileControlSettlementLedger(storage:disk).pending(scope:scope))
 }
 func testCasFailureAndWriteFailureHold()throws {
  let (disk,_,ledger,scope,_,_,lease)=try setup();disk.writeFails=true;XCTAssertThrowsError(try ledger.upgradeQualifiedV1(scope:scope,authenticatedInterpretationResponse:nil,lease:lease));disk.writeFails=false;XCTAssertThrowsError(try ledger.pending(scope:scope))
  let (disk2,w2,ledger2,scope2,_,_,lease2)=try setup();w2.reject=true;XCTAssertThrowsError(try ledger2.upgradeQualifiedV1(scope:scope2,authenticatedInterpretationResponse:nil,lease:lease2));w2.reject=false;XCTAssertThrowsError(try MobileControlSettlementLedger(storage:disk2,witness:w2).pending(scope:scope2))
 }
 func testAmbiguousWitnessAdvanceDoesNotAutoAdopt()throws {
  let (disk,w,ledger,scope,_,_,lease)=try setup();w.throwAfterAdvance=true;XCTAssertThrowsError(try ledger.upgradeQualifiedV1(scope:scope,authenticatedInterpretationResponse:nil,lease:lease));w.throwAfterAdvance=false;XCTAssertThrowsError(try MobileControlSettlementLedger(storage:disk,witness:w).pending(scope:scope))
 }
 func testForeignScopeAndCapacityFailClosed()throws {
  let (disk,w,ledger,scope,_,_,lease)=try setup();try ledger.upgradeQualifiedV1(scope:scope,authenticatedInterpretationResponse:nil,lease:lease)
  let foreign=MobileControlSettlementLedger.Scope(serverDigest:scope.serverDigest,principal:UUID(),endpoint:scope.endpoint,session:UUID());XCTAssertThrowsError(try ledger.pending(scope:foreign));XCTAssertThrowsError(try MobileControlSettlementLedger(storage:disk,witness:w,maxBytes:100,maxEntries:1).pending(scope:scope))
 }
}
