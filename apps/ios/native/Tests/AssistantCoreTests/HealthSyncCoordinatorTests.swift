import Foundation
import XCTest
@testable import AssistantCore
private final class SyncDisk: HealthSnapshotStorage { var data:Data?;func read()throws->Data?{data};func replace(_ bytes:Data)throws{data=bytes} }
final class HealthSyncCoordinatorTests:XCTestCase {
 let owner=UUID(),enrollment=UUID(),start=Date(timeIntervalSince1970:1790000000)
 func setup(_ count:Int=1)throws->(HealthOutbox,HealthCollectionTicket,[HealthChange]){
  let store=HealthOutbox(storage:SyncDisk());try store.setHuman(owner);try store.enroll(enrollment,human:owner,enabledTypes:["sleep"],confirmedPolicyRevision:7,confirmedSourceNamespace:"server-issued-source")
  let ticket=try store.ticket(enrollment:enrollment,type:"sleep"),items=try (0..<count).map{i in let id="synthetic-\(i)",o=NativeHealthObservation(upstreamId:id,category:"sleep",start:start,end:start.addingTimeInterval(3600),nativeSleep:HealthSleepValue(nativeValue:4),quantity:nil,unit:nil,sourceBundle:"example.fixture",sourceVersion:nil,deviceName:nil,deviceModel:nil,sourceTimeZone:nil);return HealthChange(upstreamId:id,operation:.upsert,body:try JSONEncoder().encode(o),collectedAt:start,expectedPolicyRevision:7,mappingVersion:"healthkit-v1")}
  try store.commit(scope:"p",expectedAnchor:nil,nextAnchor:Data([1]),changes:items,ticket:ticket);return(store,ticket,items)
 }
 func testRetriesPreserveBodyAndPolicyThenOnlyDurableResultsSettle()throws{
  let (store,ticket,items)=try setup(3),sync=HealthSyncCoordinator(outbox:store);var sent=[Data](),done:HealthSyncCoordinator.Completion?
  sync.sync(ticket:ticket,send:{body,finish in sent.append(body);finish(.failure(NSError(domain:"offline",code:1)))},completion:{done=$0});XCTAssertEqual(done,.retry);XCTAssertEqual(try store.pending(ticket:ticket),items)
  sync.sync(ticket:ticket,send:{body,finish in sent.append(body);finish(.success([.init(eventId:items[0].eventId,outcome:.accepted,code:.applied),.init(eventId:items[1].eventId,outcome:.duplicate,code:.applied),.init(eventId:items[2].eventId,outcome:.retryable,code:.unavailable)]))},completion:{done=$0});XCTAssertEqual(sent[0],sent[1]);XCTAssertEqual(done,.retry);XCTAssertEqual(try store.pending(ticket:ticket),[items[2]])
  sync.sync(ticket:ticket,send:{_,finish in finish(.success([.init(eventId:items[2].eventId,outcome:.rejected,code:.settingsChanged)]))},completion:{done=$0});XCTAssertEqual(done,.needsAttention);XCTAssertEqual(try store.pending(ticket:ticket),[]);XCTAssertEqual(try store.quarantinedCount(ticket:ticket),1);XCTAssertEqual(try store.quarantineCounts(ticket:ticket)[.settingsChanged],1)
 }
 func testIncompleteDuplicateOrForeignReceiptNeverAcknowledges()throws{
  let (store,ticket,items)=try setup(2),sync=HealthSyncCoordinator(outbox:store);for results in [[HealthDeliveryResult(eventId:items[0].eventId,outcome:.accepted,code:.applied)], [.init(eventId:items[0].eventId,outcome:.accepted,code:.applied),.init(eventId:items[0].eventId,outcome:.duplicate,code:.applied)],[.init(eventId:items[0].eventId,outcome:.accepted,code:.applied),.init(eventId:UUID(),outcome:.accepted,code:.applied)]] {var outcome:HealthSyncCoordinator.Completion?;sync.sync(ticket:ticket,send:{_,finish in finish(.success(results))},completion:{outcome=$0});XCTAssertEqual(outcome,.invalidReceipt);XCTAssertEqual(try store.pending(ticket:ticket),items)}
 }
 func testStaleAcknowledgementAfterSwitchNeverRemovesOriginalQueue()throws{
  let (store,ticket,items)=try setup(),sync=HealthSyncCoordinator(outbox:store);var reply:((Result<[HealthDeliveryResult],Error>)->Void)?,outcome:HealthSyncCoordinator.Completion?
  sync.sync(ticket:ticket,send:{_,finish in reply=finish},completion:{outcome=$0});try store.setHuman(UUID());reply?(.success([.init(eventId:items[0].eventId,outcome:.accepted,code:.applied)]));XCTAssertEqual(outcome,.deferred)
  try store.setHuman(owner);try store.confirmSourceOwner(enrollment:enrollment,bindingOwner:owner,sourceNamespace:"server-issued-source",serverRevision:7,sourceBound:true);try store.confirmEffectivePolicy(enrollment:enrollment,revision:7,enabledTypes:["sleep"],sourceNamespace:"server-issued-source",serverActive:true);let current=try store.ticket(enrollment:enrollment,type:"sleep");XCTAssertEqual(try store.pending(ticket:current),items)
 }
 func testPauseOrNarrowBeforeReceiptRejectsStaleAck()throws{
  for action in [0,1] {let (store,ticket,items)=try setup(),sync=HealthSyncCoordinator(outbox:store);var reply:((Result<[HealthDeliveryResult],Error>)->Void)?,outcome:HealthSyncCoordinator.Completion?;sync.sync(ticket:ticket,send:{_,finish in reply=finish},completion:{outcome=$0});if action==0 {try store.pause(enrollment:enrollment)} else {try store.narrow(enrollment:enrollment,types:[])};reply?(.success([.init(eventId:items[0].eventId,outcome:.accepted,code:.applied)]));XCTAssertEqual(outcome,.deferred)}
 }
 func testDuplicateTransportCallbackFinishesOnlyOnce()throws{
  let (store,ticket,items)=try setup(),sync=HealthSyncCoordinator(outbox:store);var calls=0;sync.sync(ticket:ticket,send:{_,finish in let receipt:[HealthDeliveryResult]=[.init(eventId:items[0].eventId,outcome:.accepted,code:.applied)];finish(.success(receipt));finish(.success(receipt))},completion:{_ in calls += 1});XCTAssertEqual(calls,1)
 }
 func testContradictoryReceiptCannotAcknowledge()throws{
  let (store,ticket,items)=try setup(),sync=HealthSyncCoordinator(outbox:store);var outcome:HealthSyncCoordinator.Completion?
  sync.sync(ticket:ticket,send:{_,finish in finish(.success([.init(eventId:items[0].eventId,outcome:.accepted,code:.unavailable)]))},completion:{outcome=$0})
  XCTAssertEqual(outcome,.invalidReceipt);XCTAssertEqual(try store.pending(ticket:ticket),items)
 }

 func testMalformedLocalRecordIsQuarantinedWithoutBlockingValidPeer()throws{
  let (store,ticket,items)=try setup(),bad=HealthChange(upstreamId:"bad",operation:.upsert,body:Data("not-json".utf8),collectedAt:start,expectedPolicyRevision:7,mappingVersion:"healthkit-v1")
  try store.commit(scope:"p",expectedAnchor:Data([1]),nextAnchor:Data([2]),changes:[bad],ticket:ticket)
  let sync=HealthSyncCoordinator(outbox:store);var result:HealthSyncCoordinator.Completion?
  sync.sync(ticket:ticket,send:{data,finish in let body=try! JSONSerialization.jsonObject(with:data) as! [String:Any],changes=body["changes"] as! [[String:Any]];XCTAssertEqual(changes.count,1);finish(.success([.init(eventId:items[0].eventId,outcome:.accepted,code:.applied)]))},completion:{result=$0})
  XCTAssertEqual(result,.needsAttention);XCTAssertEqual(try store.pending(ticket:ticket),[]);XCTAssertEqual(try store.quarantineCounts(ticket:ticket)[.invalid],1)
 }

 func testOfflinePolicyRevisionPreservesImmutableEventAndDoesNotAckRejection()throws{
  let (store,old,items)=try setup(),before=try MobileHealthEncoder.batch(items,enrollment:old.enrollmentId,sourceNamespace:old.sourceNamespace,category:old.category).data
  try store.setHuman(owner);try store.confirmEffectivePolicy(enrollment:enrollment,revision:8,enabledTypes:["sleep"],sourceNamespace:"server-issued-source",serverActive:true)
  let current=try store.ticket(enrollment:enrollment,type:"sleep"),sync=HealthSyncCoordinator(outbox:store);XCTAssertEqual(current.expectedPolicyRevision,8);var result:HealthSyncCoordinator.Completion?
  sync.sync(ticket:current,send:{body,finish in XCTAssertEqual(body,before,"new revision must not mutate old event");finish(.success([.init(eventId:items[0].eventId,outcome:.rejected,code:.settingsChanged)]))},completion:{result=$0})
  XCTAssertEqual(result,.needsAttention);XCTAssertEqual(try store.quarantineCounts(ticket:current)[.settingsChanged],1)
 }

 func testInvalidMappingCannotEnterQueue()throws{
  let (store,ticket,items)=try setup(),bad=HealthChange(upstreamId:"synthetic-bad",operation:.delete,body:nil,collectedAt:start,expectedPolicyRevision:7,mappingVersion:"")
  XCTAssertThrowsError(try store.commit(scope:"p",expectedAnchor:Data([1]),nextAnchor:Data([2]),changes:[bad],ticket:ticket));XCTAssertEqual(try store.pending(ticket:ticket),items)
 }

 func testFreshProofRequeuesOnlyRecoverablePolicyFailuresWithoutMutatingEvents()throws{
  let (store,old,items)=try setup(5),codes:[HealthDeliveryCode]=[.settingsChanged,.scope,.invalid,.conflict,.suppressed],sync=HealthSyncCoordinator(outbox:store);let before=try items.map { try MobileHealthEncoder.batch([$0],enrollment:old.enrollmentId,sourceNamespace:old.sourceNamespace,category:old.category).data }
  var result:HealthSyncCoordinator.Completion?;sync.sync(ticket:old,send:{_,finish in finish(.success(zip(items,codes).map{.init(eventId:$0.0.eventId,outcome:.rejected,code:$0.1)}))},completion:{result=$0});XCTAssertEqual(result,.needsAttention);XCTAssertEqual(try store.releaseRecoverable(ticket:old),0,"the same proof cannot start a tight retry loop")
  try store.confirmEffectivePolicy(enrollment:enrollment,revision:8,enabledTypes:["sleep"],sourceNamespace:"server-issued-source",serverActive:true)
  let current=try store.ticket(enrollment:enrollment,type:"sleep");XCTAssertEqual(try store.releaseRecoverable(ticket:current),2)
  let pending=try store.pending(ticket:current);XCTAssertEqual(pending,Array(items.prefix(2)));XCTAssertEqual(try store.quarantinedCount(ticket:current),3)
  for (i,item) in pending.enumerated(){XCTAssertEqual(try MobileHealthEncoder.batch([item],enrollment:current.enrollmentId,sourceNamespace:current.sourceNamespace,category:current.category).data,before[i])}
  sync.sync(ticket:current,send:{_,finish in finish(.success(pending.map{.init(eventId:$0.eventId,outcome:.rejected,code:.scope)}))},completion:{result=$0});XCTAssertEqual(try store.releaseRecoverable(ticket:current),0)
 }

 func testFreshEligibleProofRetriesTemporaryFailureWithOriginalBodyThenAccepts()throws{
  let (store,old,items)=try setup(),sync=HealthSyncCoordinator(outbox:store);var first=Data(),second=Data(),result:HealthSyncCoordinator.Completion?
  sync.sync(ticket:old,send:{body,finish in first=body;finish(.success([.init(eventId:items[0].eventId,outcome:.rejected,code:.settingsChanged)]))},completion:{result=$0});XCTAssertEqual(result,.needsAttention)
  try store.confirmEffectivePolicy(enrollment:enrollment,revision:8,enabledTypes:["sleep"],sourceNamespace:"server-issued-source",serverActive:true);let fresh=try store.ticket(enrollment:enrollment,type:"sleep");XCTAssertEqual(try store.releaseRecoverable(ticket:fresh),1)
  sync.sync(ticket:fresh,send:{body,finish in second=body;finish(.success([.init(eventId:items[0].eventId,outcome:.accepted,code:.applied)]))},completion:{result=$0});XCTAssertEqual(first,second);XCTAssertEqual(result,.applied);XCTAssertEqual(try store.pending(ticket:fresh),[])
 }

}
