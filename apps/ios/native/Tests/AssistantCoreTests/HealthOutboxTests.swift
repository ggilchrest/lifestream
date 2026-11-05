import Foundation
import XCTest
@testable import AssistantCore

private final class MemoryHealthStorage: HealthSnapshotStorage {
    var data: Data?; var failRead = false; var failWrite = false
    func read() throws -> Data? { if failRead { throw NSError(domain:"locked",code:1) }; return data }
    func replace(_ bytes: Data) throws { if failWrite { throw NSError(domain:"locked",code:1) }; data = bytes }
}
final class HealthOutboxTests: XCTestCase {
    private let owner = UUID(), other = UUID(), enrollment = UUID()
    private func change(_ id: String = "source-1") -> HealthChange { HealthChange(upstreamId:id,operation:.upsert,body:Data("synthetic".utf8),expectedPolicyRevision:1,mappingVersion:"healthkit-v1") }
    private func make(_ storage: MemoryHealthStorage) throws -> HealthOutbox {
        let store = HealthOutbox(storage:storage); try store.setHuman(owner); try store.enroll(enrollment,human:owner,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:"synthetic-source"); return store
    }
    func testDurableAnchorAndOutboxRestartAndSeparateAcknowledgement() throws {
        let disk=MemoryHealthStorage(),first=try make(disk),ticket=try first.ticket(enrollment:enrollment,type:"sleep"),item=change()
        try first.commit(scope:"predicate:v1",expectedAnchor:nil,nextAnchor:Data([1]),changes:[item],ticket:ticket)
        let restored=HealthOutbox(storage:disk);try restored.setHuman(owner);XCTAssertThrowsError(try restored.ticket(enrollment:enrollment,type:"sleep"));try restored.confirmEffectivePolicy(enrollment:enrollment,revision:1,enabledTypes:["sleep"],sourceNamespace:"synthetic-source",serverActive:true);let again=try restored.ticket(enrollment:enrollment,type:"sleep")
        XCTAssertEqual(try restored.anchor(for:"predicate:v1",ticket:again),Data([1]));XCTAssertEqual(try restored.pending(ticket:again),[item])
        try restored.acknowledge(ticket:again,eventIds:[item.eventId]);XCTAssertEqual(try restored.pending(ticket:again),[]);XCTAssertEqual(try restored.anchor(for:"predicate:v1",ticket:again),Data([1]))
    }
    func testFailureAndLockedStorageNeverAdvanceAnchorOrQueue() throws {
        let disk=MemoryHealthStorage(),store=try make(disk),ticket=try store.ticket(enrollment:enrollment,type:"sleep"),before=disk.data
        disk.failWrite=true;XCTAssertThrowsError(try store.commit(scope:"p",expectedAnchor:nil,nextAnchor:Data([7]),changes:[change()],ticket:ticket)){XCTAssertEqual($0 as? HealthOutboxError,.lockedOrUnavailable)};XCTAssertEqual(disk.data,before)
        disk.failWrite=false;disk.failRead=true;XCTAssertThrowsError(try store.anchor(for:"p",ticket:ticket)){XCTAssertEqual($0 as? HealthOutboxError,.lockedOrUnavailable)}
        disk.failRead=false;XCTAssertNil(try store.anchor(for:"p",ticket:ticket));XCTAssertEqual(try store.pending(ticket:ticket),[])
    }
    func testAccountSwitchQuarantinesQueueAndInvalidatesInFlightTicket() throws {
        let disk=MemoryHealthStorage(),store=try make(disk),ticket=try store.ticket(enrollment:enrollment,type:"sleep"),item=change()
        try store.commit(scope:"p",expectedAnchor:nil,nextAnchor:Data([1]),changes:[item],ticket:ticket);try store.setHuman(other)
        XCTAssertThrowsError(try store.pending(ticket:ticket)){XCTAssertEqual($0 as? HealthOutboxError,.ownerChanged)}
        XCTAssertThrowsError(try store.ticket(enrollment:enrollment,type:"sleep")){XCTAssertEqual($0 as? HealthOutboxError,.ownerChanged)}
        XCTAssertThrowsError(try store.commit(scope:"p",expectedAnchor:Data([1]),nextAnchor:Data([2]),changes:[change("stale")],ticket:ticket)){XCTAssertEqual($0 as? HealthOutboxError,.ownerChanged)}
        try store.setHuman(owner);XCTAssertThrowsError(try store.anchor(for:"p",ticket:ticket)){XCTAssertEqual($0 as? HealthOutboxError,.ownerChanged)};XCTAssertThrowsError(try store.pending(ticket:ticket));try store.confirmSourceOwner(enrollment:enrollment,bindingOwner:owner,sourceNamespace:"synthetic-source",serverRevision:1,sourceBound:true);try store.confirmEffectivePolicy(enrollment:enrollment,revision:1,enabledTypes:["sleep"],sourceNamespace:"synthetic-source",serverActive:true);XCTAssertThrowsError(try store.acknowledge(ticket:ticket,eventIds:[item.eventId]));let rebound=try store.ticket(enrollment:enrollment,type:"sleep");XCTAssertEqual(try store.pending(ticket:rebound),[item])
    }
    func testAtomicCompareAndCapacityAndEventIdentity() throws {
        let disk=MemoryHealthStorage(),store=HealthOutbox(storage:disk,maxEvents:1);try store.setHuman(owner);try store.enroll(enrollment,human:owner,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:"synthetic-source");let t=try store.ticket(enrollment:enrollment,type:"sleep"),x=change()
        try store.commit(scope:"p",expectedAnchor:nil,nextAnchor:Data([1]),changes:[x],ticket:t)
        XCTAssertThrowsError(try store.commit(scope:"p",expectedAnchor:nil,nextAnchor:Data([2]),changes:[],ticket:t)){XCTAssertEqual($0 as? HealthOutboxError,.staleAnchor)}
        XCTAssertThrowsError(try store.commit(scope:"p",expectedAnchor:Data([1]),nextAnchor:Data([2]),changes:[change()],ticket:t)){XCTAssertEqual($0 as? HealthOutboxError,.capacity)}
        XCTAssertEqual(try store.anchor(for:"p",ticket:t),Data([1]));XCTAssertEqual(try store.pending(ticket:t),[x]);XCTAssertNotEqual(x.eventId.uuidString,x.upstreamId)
    }
    func testExplicitEnrollmentAndPauseAreRequired() throws {
        let disk=MemoryHealthStorage(),store=HealthOutbox(storage:disk);try store.setHuman(owner)
        XCTAssertThrowsError(try store.ticket(enrollment:enrollment,type:"sleep")){XCTAssertEqual($0 as? HealthOutboxError,.notEnrolled)}
        try store.enroll(enrollment,human:owner,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:"synthetic-source");let t=try store.ticket(enrollment:enrollment,type:"sleep")
        XCTAssertThrowsError(try store.ticket(enrollment:enrollment,type:"heart")){XCTAssertEqual($0 as? HealthOutboxError,.disabled)}
        try store.pause(enrollment:enrollment);XCTAssertThrowsError(try store.commit(scope:"p",expectedAnchor:nil,nextAnchor:Data([1]),changes:[],ticket:t))
    }
    func testDeleteAndEmptyReadNeverImplyDenialOrZero() throws {
        let disk=MemoryHealthStorage(),store=try make(disk),t=try store.ticket(enrollment:enrollment,type:"sleep")
        try store.commit(scope:"p",expectedAnchor:nil,nextAnchor:Data([1]),changes:[],ticket:t);XCTAssertEqual(try store.pending(ticket:t),[])
        let deleted=HealthChange(upstreamId:"deleted",operation:.delete,body:nil,expectedPolicyRevision:1,mappingVersion:"healthkit-v1");try store.commit(scope:"p",expectedAnchor:Data([1]),nextAnchor:Data([2]),changes:[deleted],ticket:t);XCTAssertEqual(try store.pending(ticket:t),[deleted])
    }
    func testAccountSwitchQuarantineSurvivesRestartAndCannotRebindOtherHuman() throws {
        let disk=MemoryHealthStorage(),store=try make(disk);let t=try store.ticket(enrollment:enrollment,type:"sleep")
        try store.commit(scope:"p",expectedAnchor:nil,nextAnchor:Data([1]),changes:[change()],ticket:t)
        try store.setHuman(other);let restarted=HealthOutbox(storage:disk);try restarted.setHuman(other)
        XCTAssertThrowsError(try restarted.confirmSourceOwner(enrollment:enrollment,bindingOwner:owner,sourceNamespace:"synthetic-source",serverRevision:1,sourceBound:true)){XCTAssertEqual($0 as? HealthOutboxError,.ownerChanged)}
        try restarted.setHuman(owner);XCTAssertThrowsError(try restarted.ticket(enrollment:enrollment,type:"sleep")){XCTAssertEqual($0 as? HealthOutboxError,.disabled)}
        XCTAssertThrowsError(try restarted.confirmSourceOwner(enrollment:enrollment,bindingOwner:owner,sourceNamespace:"synthetic-source",serverRevision:1,sourceBound:false));XCTAssertThrowsError(try restarted.confirmSourceOwner(enrollment:enrollment,bindingOwner:owner,sourceNamespace:"other-source",serverRevision:1,sourceBound:true));try restarted.confirmSourceOwner(enrollment:enrollment,bindingOwner:owner,sourceNamespace:"synthetic-source",serverRevision:1,sourceBound:true);try restarted.confirmEffectivePolicy(enrollment:enrollment,revision:1,enabledTypes:["sleep"],sourceNamespace:"synthetic-source",serverActive:true);let next=try restarted.ticket(enrollment:enrollment,type:"sleep");XCTAssertEqual(try restarted.pending(ticket:next).count,1)
    }
    func testFailureToPersistAccountChangeFailsClosed() throws {
        let disk=MemoryHealthStorage(),store=try make(disk),ticket=try store.ticket(enrollment:enrollment,type:"sleep");disk.failWrite=true
        XCTAssertThrowsError(try store.setHuman(other));disk.failWrite=false
        XCTAssertThrowsError(try store.anchor(for:"p",ticket:ticket)){XCTAssertEqual($0 as? HealthOutboxError,.ownerChanged)}
        XCTAssertThrowsError(try store.ticket(enrollment:enrollment,type:"sleep")){XCTAssertEqual($0 as? HealthOutboxError,.ownerChanged)}
    }
    func testSameHumanNewContextInvalidatesOldDeliveryCallback() throws {
        let disk=MemoryHealthStorage(),store=try make(disk),ticket=try store.ticket(enrollment:enrollment,type:"sleep"),item=change()
        try store.commit(scope:"p",expectedAnchor:nil,nextAnchor:Data([1]),changes:[item],ticket:ticket);try store.setHuman(owner)
        XCTAssertThrowsError(try store.acknowledge(ticket:ticket,eventIds:[item.eventId]))
        try store.confirmEffectivePolicy(enrollment:enrollment,revision:1,enabledTypes:["sleep"],sourceNamespace:"synthetic-source",serverActive:true)
        let current=try store.ticket(enrollment:enrollment,type:"sleep");XCTAssertEqual(try store.pending(ticket:current),[item])
    }

    func testNarrowingStopsDisallowedQueuedDeliveryAndCannotWiden() throws {
        let disk=MemoryHealthStorage(),store=HealthOutbox(storage:disk);try store.setHuman(owner);try store.enroll(enrollment,human:owner,enabledTypes:["sleep","heartRate"],confirmedPolicyRevision:1,confirmedSourceNamespace:"synthetic-source")
        let sleep=try store.ticket(enrollment:enrollment,type:"sleep"),heart=try store.ticket(enrollment:enrollment,type:"heartRate")
        try store.commit(scope:"p",expectedAnchor:nil,nextAnchor:Data([1]),changes:[change()],ticket:sleep)
        try store.commit(scope:"p",expectedAnchor:nil,nextAnchor:Data([1]),changes:[change("heart")],ticket:heart)
        try store.narrow(enrollment:enrollment,types:["sleep"])
        XCTAssertThrowsError(try store.pending(ticket:heart));XCTAssertThrowsError(try store.ticket(enrollment:enrollment,type:"heartRate"))
        XCTAssertThrowsError(try store.narrow(enrollment:enrollment,types:["sleep","heartRate"]))
        try store.setHuman(owner);try store.confirmEffectivePolicy(enrollment:enrollment,revision:1,enabledTypes:["sleep"],sourceNamespace:"synthetic-source",serverActive:true)
        let fresh=try store.ticket(enrollment:enrollment,type:"sleep");XCTAssertEqual(try store.pending(ticket:fresh).count,1)
    }

    func testActualFileRoundTripAndCorruptionNeverResetState() throws {
        let dir=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString,isDirectory:true);try FileManager.default.createDirectory(at:dir,withIntermediateDirectories:true);defer { try? FileManager.default.removeItem(at:dir) }
        let url=dir.appendingPathComponent("health-queue"),storage=ProtectedHealthFileStorage(file:url),store=HealthOutbox(storage:storage)
        try store.setHuman(owner);try store.enroll(enrollment,human:owner,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:"synthetic-source");let ticket=try store.ticket(enrollment:enrollment,type:"sleep"),item=change()
        try store.commit(scope:"p",expectedAnchor:nil,nextAnchor:Data([7]),changes:[item],ticket:ticket)
        let restarted=HealthOutbox(storage:storage);try restarted.setHuman(owner);try restarted.confirmEffectivePolicy(enrollment:enrollment,revision:1,enabledTypes:["sleep"],sourceNamespace:"synthetic-source",serverActive:true);let restored=try restarted.ticket(enrollment:enrollment,type:"sleep");XCTAssertEqual(try restarted.pending(ticket:restored),[item]);XCTAssertEqual(try restarted.anchor(for:"p",ticket:restored),Data([7]))
        let malformed=Data("bad".utf8);try malformed.write(to:url,options:.atomic)
        XCTAssertThrowsError(try restarted.ticket(enrollment:enrollment,type:"sleep")){XCTAssertEqual($0 as? HealthOutboxError,.corrupt)};XCTAssertEqual(try Data(contentsOf:url),malformed)
    }

    func testFailedNarrowingRevokesCurrentTicketsUntilContextRevalidated() throws {
        let disk=MemoryHealthStorage(),store=try make(disk),ticket=try store.ticket(enrollment:enrollment,type:"sleep");disk.failWrite=true
        XCTAssertThrowsError(try store.narrow(enrollment:enrollment,types:[]));disk.failWrite=false
        XCTAssertThrowsError(try store.pending(ticket:ticket));XCTAssertThrowsError(try store.ticket(enrollment:enrollment,type:"sleep"))
    }

    func testFailedPauseFencesInFlightAndNewTicketsUntilContextRevalidation() throws {
        let disk=MemoryHealthStorage(),store=try make(disk),ticket=try store.ticket(enrollment:enrollment,type:"sleep"),before=disk.data
        disk.failWrite=true;XCTAssertThrowsError(try store.pause(enrollment:enrollment)){XCTAssertEqual($0 as? HealthOutboxError,.lockedOrUnavailable)};disk.failWrite=false
        XCTAssertEqual(disk.data,before,"failed pause is not a durable receipt")
        XCTAssertThrowsError(try store.commit(scope:"p",expectedAnchor:nil,nextAnchor:Data([1]),changes:[change()],ticket:ticket))
        XCTAssertThrowsError(try store.pending(ticket:ticket));XCTAssertThrowsError(try store.ticket(enrollment:enrollment,type:"sleep"))
        try store.setHuman(owner);XCTAssertTrue(try store.status(enrollment:enrollment).localChangePending);XCTAssertThrowsError(try store.ticket(enrollment:enrollment,type:"sleep"),"failed pause stays restrictive in memory after context refresh")
        let restarted=HealthOutbox(storage:disk);try restarted.setHuman(owner)
        XCTAssertThrowsError(try restarted.ticket(enrollment:enrollment,type:"sleep"),"restart must reconcile effective policy before collection")
        try restarted.confirmEffectivePolicy(enrollment:enrollment,revision:1,enabledTypes:["sleep"],sourceNamespace:"synthetic-source",serverActive:true)
        XCTAssertNoThrow(try restarted.ticket(enrollment:enrollment,type:"sleep"),"server still reports the old policy; a failed pause was never durable")
    }

    func testConcurrentCallbacksCannotAdvanceSameAnchorTwice() throws {
        let disk=MemoryHealthStorage(),store=try make(disk),ticket=try store.ticket(enrollment:enrollment,type:"sleep"),guardLock=NSLock();var committed=0,stale=0
        DispatchQueue.concurrentPerform(iterations:16){i in
            do { try store.commit(scope:"same",expectedAnchor:nil,nextAnchor:Data([UInt8(i+1)]),changes:[change("sample-\(i)")],ticket:ticket);guardLock.lock();committed+=1;guardLock.unlock() }
            catch HealthOutboxError.staleAnchor { guardLock.lock();stale+=1;guardLock.unlock() }
            catch { XCTFail("unexpected callback error") }
        }
        XCTAssertEqual(committed,1);XCTAssertEqual(stale,15);XCTAssertEqual(try store.pending(ticket:ticket).count,1)
    }

    func testFailedNarrowingRemainsRestrictiveAfterContextRefresh() throws {
        let disk=MemoryHealthStorage(),store=HealthOutbox(storage:disk);try store.setHuman(owner);try store.enroll(enrollment,human:owner,enabledTypes:["sleep","heartRate"],confirmedPolicyRevision:1,confirmedSourceNamespace:"synthetic-source")
        let old=try store.ticket(enrollment:enrollment,type:"heartRate");disk.failWrite=true
        XCTAssertThrowsError(try store.narrow(enrollment:enrollment,types:["sleep"]));disk.failWrite=false
        try store.setHuman(owner);try store.confirmEffectivePolicy(enrollment:enrollment,revision:1,enabledTypes:["sleep","heartRate"],sourceNamespace:"synthetic-source",serverActive:true);XCTAssertThrowsError(try store.pending(ticket:old));XCTAssertThrowsError(try store.ticket(enrollment:enrollment,type:"heartRate"))
        XCTAssertNoThrow(try store.ticket(enrollment:enrollment,type:"sleep"))
        XCTAssertThrowsError(try store.narrow(enrollment:enrollment,types:["sleep","heartRate"]))
        try store.setHuman(owner);try store.confirmEffectivePolicy(enrollment:enrollment,revision:1,enabledTypes:["sleep","heartRate"],sourceNamespace:"synthetic-source",serverActive:true);XCTAssertThrowsError(try store.ticket(enrollment:enrollment,type:"heartRate"))
        try store.narrow(enrollment:enrollment,types:["sleep"]);XCTAssertThrowsError(try store.ticket(enrollment:enrollment,type:"heartRate"))
    }

    func testRestartRequiresMatchingActiveEffectiveServerPolicy() throws {
        let disk=MemoryHealthStorage();_ = try make(disk);let restored=HealthOutbox(storage:disk);try restored.setHuman(owner)
        XCTAssertThrowsError(try restored.ticket(enrollment:enrollment,type:"sleep"))
        XCTAssertThrowsError(try restored.confirmEffectivePolicy(enrollment:enrollment,revision:1,enabledTypes:["sleep"],sourceNamespace:"synthetic-source",serverActive:false))
        XCTAssertThrowsError(try restored.confirmEffectivePolicy(enrollment:enrollment,revision:0,enabledTypes:["sleep"],sourceNamespace:"synthetic-source",serverActive:true))
        XCTAssertThrowsError(try restored.confirmEffectivePolicy(enrollment:enrollment,revision:1,enabledTypes:[],sourceNamespace:"synthetic-source",serverActive:true))
        XCTAssertThrowsError(try restored.confirmEffectivePolicy(enrollment:enrollment,revision:1,enabledTypes:["sleep"],sourceNamespace:"other-source",serverActive:true))
        XCTAssertThrowsError(try restored.ticket(enrollment:enrollment,type:"sleep"))
        try restored.confirmEffectivePolicy(enrollment:enrollment,revision:1,enabledTypes:["sleep"],sourceNamespace:"synthetic-source",serverActive:true);XCTAssertNoThrow(try restored.ticket(enrollment:enrollment,type:"sleep"))
    }

    func testNewPolicyRevisionPreservesOldQueuedEventAndRejectsNarrowedScope() throws {
        let disk=MemoryHealthStorage(),store=try make(disk),old=try store.ticket(enrollment:enrollment,type:"sleep"),item=change()
        try store.commit(scope:"p",expectedAnchor:nil,nextAnchor:Data([1]),changes:[item],ticket:old);try store.setHuman(owner)
        XCTAssertThrowsError(try store.confirmEffectivePolicy(enrollment:enrollment,revision:2,enabledTypes:[],sourceNamespace:"synthetic-source",serverActive:true))
        try store.confirmEffectivePolicy(enrollment:enrollment,revision:2,enabledTypes:["sleep"],sourceNamespace:"synthetic-source",serverActive:true)
        let new=try store.ticket(enrollment:enrollment,type:"sleep");XCTAssertEqual(new.expectedPolicyRevision,2);XCTAssertEqual(try store.pending(ticket:new),[item]);XCTAssertEqual(item.expectedPolicyRevision,1)
        XCTAssertThrowsError(try store.acknowledge(ticket:old,eventIds:[item.eventId]))
    }

    func testExplicitResumeNeedsServerProofAndRetainsOldEvents()throws{
        let disk=MemoryHealthStorage(),store=try make(disk),old=try store.ticket(enrollment:enrollment,type:"sleep"),item=change()
        try store.commit(scope:"p",expectedAnchor:nil,nextAnchor:Data([1]),changes:[item],ticket:old);try store.pause(enrollment:enrollment)
        XCTAssertThrowsError(try store.resume(enrollment:enrollment,revision:2,selectedTypes:["sleep"],serverTypes:["sleep"],sourceNamespace:"synthetic-source",serverActive:false))
        try store.setHuman(owner);XCTAssertThrowsError(try store.resume(enrollment:enrollment,revision:2,selectedTypes:["sleep","heartRate"],serverTypes:["sleep"],sourceNamespace:"synthetic-source",serverActive:true))
        try store.setHuman(owner);try store.resume(enrollment:enrollment,revision:2,selectedTypes:["sleep"],serverTypes:["sleep"],sourceNamespace:"synthetic-source",serverActive:true)
        let resumed=try store.ticket(enrollment:enrollment,type:"sleep");XCTAssertEqual(resumed.expectedPolicyRevision,2);XCTAssertEqual(try store.pending(ticket:resumed),[item]);XCTAssertEqual(item.expectedPolicyRevision,1)
    }

    func testOwnerCanSeeSanitizedQueueCountsWhilePausedButOtherHumanCannot()throws{
        let disk=MemoryHealthStorage(),store=try make(disk),ticket=try store.ticket(enrollment:enrollment,type:"sleep"),item=change()
        try store.commit(scope:"p",expectedAnchor:nil,nextAnchor:Data([1]),changes:[item],ticket:ticket);try store.settle(ticket:ticket,accepted:[],rejected:[item.eventId:.settingsChanged]);try store.pause(enrollment:enrollment)
        let status=try store.status(enrollment:enrollment);XCTAssertTrue(status.paused);XCTAssertEqual(status.pending,0);XCTAssertEqual(status.quarantined,1)
        try store.setHuman(other);XCTAssertThrowsError(try store.status(enrollment:enrollment)){XCTAssertEqual($0 as? HealthOutboxError,.ownerChanged)}
    }

}
