import Foundation
import CryptoKit
import XCTest
@testable import AssistantCore

private final class ShareMemory:HealthSnapshotStorage {
    var data:Data?,failure=0,reads=0,writes=0
    func read()throws->Data?{reads += 1;print("LS108_PORT storage.read \(data?.base64EncodedString() ?? "nil")");return data}
    func replace(_ bytes:Data)throws {writes += 1;print("LS108_PORT storage.replace failure=\(failure) bytes=\(bytes.base64EncodedString())");if failure==1{throw CocoaError(.fileWriteUnknown)};data=bytes;if failure==2{throw CocoaError(.fileWriteUnknown)}}
}
private final class ShareWitness:OutboxShareAuthority {
    let lock=NSRecursiveLock();var allowed=true,lease=true,epoch:UInt64=1;var fenceCalls=0,permitCalls=0;var expectedHuman:UUID?,expectedEndpoint:UUID?,expectedNamespace:UUID?,expectedLease:UUID?
    func withFence<T>(_ body:()throws->T) rethrows->T{lock.lock();fenceCalls += 1;defer{lock.unlock()};return try body()}
    func permits(_ context:OutboxShareContext,reading:Bool)->Bool {permitCalls += 1;let result=allowed && context.epoch==epoch && (!reading || lease) && (expectedHuman == nil || expectedHuman==context.human) && (expectedEndpoint == nil || expectedEndpoint==context.endpoint) && (expectedNamespace == nil || expectedNamespace==context.namespace) && (!reading || expectedLease == nil || expectedLease==context.leaseToken);print("LS108_PORT witness.check reading=\(reading) permitted=\(result)");return result}
}
private final class ShareLease:SharedCaptureReadLease {
    let originalSelectionContext:any SharedCaptureBinding;var chunks:[Data?];var reads=0,closes=0,change:(()->Void)?
    init(_ c:OutboxShareContext,_ chunks:[Data?]){originalSelectionContext=c;self.chunks=chunks}
    func check()throws{}
    func read(maxBytes:Int)throws->Data?{reads += 1;change?();guard !chunks.isEmpty else{throw CocoaError(.fileReadUnknown)};let result=chunks.removeFirst();print("LS108_PORT lease.read maximum=\(maxBytes) returned=\(result?.count.description ?? "eof")");return result}
    func close(){closes += 1;print("LS108_PORT lease.close")}
}
final class MobileSharedCaptureOutboxTests:XCTestCase {
    let human=UUID(uuidString:"10000000-0000-4000-8000-000000000001")!,endpoint=UUID(uuidString:"20000000-0000-4000-8000-000000000001")!
    let bytes=Data([0,1,2,3,255]),leaseID=UUID(uuidString:"90000000-0000-4000-8000-000000000001")!
    func item(_ bytes:Data)throws->Data {
        let ios=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let raw=try String(contentsOf:ios.appendingPathComponent("test/mobile-shared-item-fixtures/shared-item-pairs.json"),encoding:.utf8).replacingOccurrences(of:"\\ud800",with:"__UNPAIRED__")
        let root=try XCTUnwrap(JSONSerialization.jsonObject(with:Data(raw.utf8)) as? [String:Any]),pairs=try XCTUnwrap(root["pairs"] as? [[String:Any]])
        var value=try XCTUnwrap(pairs.first{($0["case"] as? String)=="file-reference"}?["ios"] as? [String:Any]),c=try XCTUnwrap(value["content"] as? [String:Any]),a=try XCTUnwrap(c["artifact"] as? [String:Any])
        a["byteLength"]=bytes.count;a["sha256"]=SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined();c["artifact"]=a;value["content"]=c
        return try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes])
    }
    func context(_ owner:HealthOutbox,_ data:Data,recovery:Bool=false,epoch:UInt64=1)throws->OutboxShareContext {let v=try MobileSharedItem.decode(data);return OutboxShareContext(owner:owner,human:human,endpoint:endpoint,namespace:v.source.namespace,collector:v.source.collector,epoch:epoch,leaseToken:leaseID,recoveryOnly:recovery)}
    func attempt(_ owner:HealthOutbox,_ raw:Data,_ id:UUID=UUID())throws->OutboxShareAttempt {OutboxShareAttempt(id,context:try context(owner,raw))}
    func attemptRecovery(_ owner:HealthOutbox,_ raw:Data,_ id:UUID)throws->OutboxShareAttempt {OutboxShareAttempt(id,context:try context(owner,raw,recovery:true))}
    func evidence(_ name:String,before:Data?,after:Data?,reload:Data?=nil,raw:Data,extra:[String:Any]=[:])throws {
        guard let dir=ProcessInfo.processInfo.environment["LS108_TRACE_DIR"] else{return};let item=try MobileSharedItem.decode(raw);var object:[String:Any]=["case":name,"snapshotBefore":before?.base64EncodedString() as Any? ?? NSNull(),"snapshotAfter":after?.base64EncodedString() as Any? ?? NSNull(),"snapshotReload":reload?.base64EncodedString() as Any? ?? NSNull(),"itemJSON":item.data.base64EncodedString(),"payloadDigest":SHA256.hash(data:item.data).map{String(format:"%02x",$0)}.joined(),"sourceBytes":bytes.base64EncodedString(),"sourceSHA256":SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined(),"sourceLength":bytes.count,"maxBytes":8388608];object.merge(extra){_,new in new};let data=try JSONSerialization.data(withJSONObject:object,options:[.prettyPrinted,.sortedKeys]);try data.write(to:URL(fileURLWithPath:dir,isDirectory:true).appendingPathComponent(name+".json"),options:.withoutOverwriting)
    }
    func ack(_ o:MobileSharedCapture.Outcome,file:StaticString=#filePath,line:UInt=#line){if case .portAcknowledged=o{}else{XCTFail("expected acknowledgement",file:file,line:line)}}
    func held(_ o:MobileSharedCapture.Outcome,file:StaticString=#filePath,line:UInt=#line){if case .held=o{}else{XCTFail("expected held",file:file,line:line)}}
    func testUnavailableAndAuthorityLossNeverPublish()throws {
        let d=ShareMemory(),raw=try item(bytes),no=HealthOutbox(storage:d);try no.setHuman(human);let a=try attempt(no,raw),l=ShareLease(try context(no,raw),[bytes,nil]);held(MobileSharedCapture.capture(itemJSON:raw,attempt:a,lease:l,owner:no));XCTAssertEqual(l.reads,0);XCTAssertEqual(l.closes,1)
        let witness=ShareWitness(),owner=HealthOutbox(storage:d,shareAuthority:witness);try owner.setHuman(human);let old=d.data,lost=ShareLease(try context(owner,raw),[bytes,nil]);lost.change={witness.allowed=false};held(MobileSharedCapture.capture(itemJSON:raw,attempt:try attempt(owner,raw),lease:lost,owner:owner));XCTAssertEqual(d.data,old);XCTAssertEqual(lost.closes,1)
    }
    func testCommitReloadRecoveryAndConflictingAttempt()throws {
        let d=ShareMemory(),w=ShareWitness(),o=HealthOutbox(storage:d,shareAuthority:w),raw=try item(bytes);try o.setHuman(human);let a=try attempt(o,raw)
        let source=ShareLease(try context(o,raw),[bytes,nil]);ack(MobileSharedCapture.capture(itemJSON:raw,attempt:a,lease:source,owner:o));XCTAssertEqual(source.reads,2);let stored=try XCTUnwrap(d.data),root=try XCTUnwrap(JSONSerialization.jsonObject(with:stored) as? [String:Any]);XCTAssertEqual(root["version"] as? Int,3)
        let restarted=HealthOutbox(storage:d,shareAuthority:w);try restarted.setHuman(human);let recovered=ShareLease(try context(restarted,raw,recovery:true),[]);ack(MobileSharedCapture.capture(itemJSON:raw,attempt:try attemptRecovery(restarted,raw,a.id),lease:recovered,owner:restarted));XCTAssertEqual(recovered.reads,0);XCTAssertEqual(d.data,stored)
        let different=try item(Data([9])),conflict=ShareLease(try context(restarted,different,recovery:true),[]);held(MobileSharedCapture.capture(itemJSON:different,attempt:try attemptRecovery(restarted,different,a.id),lease:conflict,owner:restarted));XCTAssertEqual(conflict.reads,0);XCTAssertEqual(d.data,stored)
    }
    func testUnknownWriteRecoversAndNoSecondCommit()throws {
        let d=ShareMemory(),w=ShareWitness(),o=HealthOutbox(storage:d,shareAuthority:w),raw=try item(bytes);try o.setHuman(human);let a=try attempt(o,raw);d.failure=2
        let l=ShareLease(try context(o,raw),[bytes,nil]);if case .commitUnknown=MobileSharedCapture.capture(itemJSON:raw,attempt:a,lease:l,owner:o){}else{XCTFail("unknown expected")};let saved=try XCTUnwrap(d.data);d.failure=0
        let restart=HealthOutbox(storage:d,shareAuthority:w);try restart.setHuman(human);let recovery=ShareLease(try context(restart,raw,recovery:true),[]);ack(MobileSharedCapture.capture(itemJSON:raw,attempt:try attemptRecovery(restart,raw,a.id),lease:recovery,owner:restart));XCTAssertEqual(recovery.reads,0);XCTAssertEqual(d.data,saved)
    }
    func testQuotaAndGlobalEventLimitPreservePreviousState()throws {
        let d=ShareMemory(),w=ShareWitness(),o=HealthOutbox(storage:d,maxEvents:1,shareAuthority:w),raw=try item(bytes);try o.setHuman(human);let a=try attempt(o,raw),l=ShareLease(try context(o,raw),[bytes,nil]);ack(MobileSharedCapture.capture(itemJSON:raw,attempt:a,lease:l,owner:o));let before=d.data
        let duplicate=ShareLease(try context(o,raw,recovery:true),[]);ack(MobileSharedCapture.capture(itemJSON:raw,attempt:try attemptRecovery(o,raw,a.id),lease:duplicate,owner:o));let blocked=ShareLease(try context(o,raw),[bytes,nil]);held(MobileSharedCapture.capture(itemJSON:raw,attempt:try attempt(o,raw),lease:blocked,owner:o));XCTAssertEqual(blocked.reads,0);XCTAssertEqual(d.data,before);try evidence("capacity-share-duplicate-recovery",before:before,after:d.data,raw:raw,extra:["expectedOutcome":"held","duplicateOutcome":"acknowledged","duplicateReads":duplicate.reads,"blockedReads":blocked.reads,"maxEvents":1])
        let tiny=ShareMemory(),tooSmall=HealthOutbox(storage:tiny,maxBytes:256,shareAuthority:w);try tooSmall.setHuman(human);let prior=tiny.data,unread=ShareLease(try context(tooSmall,raw),[bytes,nil]);held(MobileSharedCapture.capture(itemJSON:raw,attempt:try attempt(tooSmall,raw),lease:unread,owner:tooSmall));XCTAssertEqual(unread.reads,0);XCTAssertEqual(tiny.data,prior)
    }
    func testInterveningOwnerWriteAndRecoveryOnlyDeny()throws {
        let d=ShareMemory(),w=ShareWitness(),o=HealthOutbox(storage:d,shareAuthority:w),raw=try item(bytes);try o.setHuman(human);let recovery=ShareLease(try context(o,raw,recovery:true),[bytes,nil]);held(MobileSharedCapture.capture(itemJSON:raw,attempt:try attemptRecovery(o,raw,UUID()),lease:recovery,owner:o));XCTAssertEqual(recovery.reads,0)
        let l=ShareLease(try context(o,raw),[bytes,nil]);l.change={try? o.setHuman(self.human)};let before=d.data;held(MobileSharedCapture.capture(itemJSON:raw,attempt:try attempt(o,raw),lease:l,owner:o));XCTAssertEqual(d.data,before);XCTAssertEqual(l.closes,1)
    }
}

extension MobileSharedCaptureOutboxTests {
    func calendarFixture()throws->([String:Any],MobileCalendarPolicyProof){
        let ios=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent(),data=try Data(contentsOf:ios.appendingPathComponent("test/mobile-calendar-fixtures/delivery-receipts.json")),root=try XCTUnwrap(JSONSerialization.jsonObject(with:data) as? [String:Any]),policy=try JSONSerialization.data(withJSONObject:XCTUnwrap(root["policy"]),options:[.sortedKeys,.withoutEscapingSlashes])
        return (root,try MobileCalendarPolicyParser.parse(policy,expectedPrincipal:UUID(uuidString:"50000000-0000-4000-8000-000000000001")!,expectedEndpoint:UUID(uuidString:"60000000-0000-4000-8000-000000000001")!,expectedEnrollment:UUID(uuidString:"30000000-0000-4000-8000-000000000001")!))
    }
    func testBothMigrationsPreserveHealthAndShareFirstCalendar()throws {
        let (fixture,p)=try calendarFixture(),raw=try item(bytes),decoded=try MobileSharedItem.decode(raw)
        for calendarFirst in [false,true] {let d=ShareMemory(),w=ShareWitness(),o=HealthOutbox(storage:d,shareAuthority:w),health=UUID();try o.setHuman(p.principal);try o.enroll(health,human:p.principal,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:"synthetic-health");let ticket=try o.ticket(enrollment:health,type:"sleep"),change=HealthChange(upstreamId:"sample",operation:.upsert,body:Data([4]),expectedPolicyRevision:1,mappingVersion:"v1");try o.commit(scope:"scope",expectedAnchor:nil,nextAnchor:Data([7]),changes:[change],ticket:ticket)
            if calendarFirst {try o.admitCalendar(proof:p);let ct=try o.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"),vectors=try XCTUnwrap(fixture["vectors"] as? [[String:Any]]);var event=try XCTUnwrap(vectors[0]["item"] as? [String:Any]),change=try XCTUnwrap(event["change"] as? [String:Any]);change["expectedPolicyRevision"]=p.revision;event["change"]=change;let encoded=try JSONSerialization.data(withJSONObject:event,options:[.sortedKeys,.withoutEscapingSlashes]),scope=try MobileCalendarDelivery.CheckpointScope(collector:p.collector,namespace:p.namespace,mappingVersion:"synthetic-calendar-mapping/1",coverage:.partial,start:"2026-10-01T00:00:00Z",end:"2026-11-01T00:00:00Z");try o.commitCalendar(scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([9]),items:[encoded],ticket:ct)}
            let before=try XCTUnwrap(d.data),original=try XCTUnwrap(JSONSerialization.jsonObject(with:before) as? [String:Any]);XCTAssertEqual(original["version"] as? Int,calendarFirst ? 2:1)
            let c=OutboxShareContext(owner:o,human:p.principal,endpoint:p.endpoint,namespace:decoded.source.namespace,collector:decoded.source.collector,epoch:1,recoveryOnly:false),l=ShareLease(c,[bytes,nil]);ack(MobileSharedCapture.capture(itemJSON:raw,attempt:OutboxShareAttempt(UUID(),context:c),lease:l,owner:o));if !calendarFirst {try o.admitCalendar(proof:p)}
            let final=try XCTUnwrap(d.data),snapshot=try XCTUnwrap(JSONSerialization.jsonObject(with:final) as? [String:Any]);XCTAssertEqual(snapshot["version"] as? Int,3);XCTAssertNotNil(snapshot["calendarEnrollments"]);XCTAssertEqual(try o.pending(ticket:ticket),[change]);XCTAssertEqual(try o.anchor(for:"scope",ticket:ticket),Data([7]));let restart=HealthOutbox(storage:d,shareAuthority:w);try restart.setHuman(p.principal);try restart.confirmEffectivePolicy(enrollment:health,revision:1,enabledTypes:["sleep"],sourceNamespace:"synthetic-health",serverActive:true);let renewed=try restart.ticket(enrollment:health,type:"sleep");XCTAssertEqual(try restart.pending(ticket:renewed),[change]);XCTAssertEqual(try restart.anchor(for:"scope",ticket:renewed),Data([7]));try restart.confirmCalendarPolicy(proof:p);XCTAssertNotNil(try restart.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"));try evidence(calendarFirst ? "migration-v2-share":"migration-v1-share-calendar",before:before,after:final,reload:d.data,raw:raw,extra:["expectedOutcome":"acknowledged","healthCount":1,"shareCount":1,"calendarEnrollmentCount":1])
        }
    }
    func testShareCountsAgainstHealthAndCalendarAtCapacity()throws {
        let (fixture,p)=try calendarFixture(),raw=try item(bytes),decoded=try MobileSharedItem.decode(raw),d=ShareMemory(),w=ShareWitness(),o=HealthOutbox(storage:d,maxEvents:1,shareAuthority:w),health=UUID();try o.setHuman(p.principal);try o.enroll(health,human:p.principal,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:"health");try o.admitCalendar(proof:p)
        let ht=try o.ticket(enrollment:health,type:"sleep"),ct=try o.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"),c=OutboxShareContext(owner:o,human:p.principal,endpoint:p.endpoint,namespace:decoded.source.namespace,collector:decoded.source.collector,epoch:1,recoveryOnly:false),lease=ShareLease(c,[bytes,nil]);ack(MobileSharedCapture.capture(itemJSON:raw,attempt:OutboxShareAttempt(UUID(),context:c),lease:lease,owner:o));let before=d.data
        let change=HealthChange(upstreamId:"sample",operation:.upsert,body:Data([1]),expectedPolicyRevision:1,mappingVersion:"v1");XCTAssertThrowsError(try o.commit(scope:"x",expectedAnchor:nil,nextAnchor:Data([1]),changes:[change],ticket:ht)){XCTAssertEqual($0 as? HealthOutboxError,.capacity)};XCTAssertEqual(d.data,before)
        let vectors=try XCTUnwrap(fixture["vectors"] as? [[String:Any]]);var item=try XCTUnwrap(vectors[0]["item"] as? [String:Any]),changeItem=try XCTUnwrap(item["change"] as? [String:Any]);changeItem["expectedPolicyRevision"]=p.revision;item["change"]=changeItem;let encoded=try JSONSerialization.data(withJSONObject:item,options:[.sortedKeys,.withoutEscapingSlashes]),scope=try MobileCalendarDelivery.CheckpointScope(collector:p.collector,namespace:p.namespace,mappingVersion:"synthetic-calendar-mapping/1",coverage:.partial,start:"2026-10-01T00:00:00Z",end:"2026-11-01T00:00:00Z")
        XCTAssertThrowsError(try o.commitCalendar(scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([1]),items:[encoded],ticket:ct)){XCTAssertEqual($0 as? HealthOutboxError,.capacity)};XCTAssertEqual(d.data,before);try evidence("capacity-health-calendar",before:before,after:d.data,raw:raw,extra:["expectedHealthOutcome":"capacity","expectedCalendarOutcome":"capacity","maxEvents":1])
    }
}

extension MobileSharedCaptureOutboxTests {
    func testHealthCapacityBlocksShareAndFailedReplaceIsUnknown()throws {
        let d=ShareMemory(),w=ShareWitness(),o=HealthOutbox(storage:d,maxEvents:1,shareAuthority:w),raw=try item(bytes),health=UUID();try o.setHuman(human);try o.enroll(health,human:human,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:"health");let t=try o.ticket(enrollment:health,type:"sleep"),change=HealthChange(upstreamId:"sample",operation:.upsert,body:Data([1]),expectedPolicyRevision:1,mappingVersion:"v1");try o.commit(scope:"x",expectedAnchor:nil,nextAnchor:Data([1]),changes:[change],ticket:t)
        let before=d.data,l=ShareLease(try context(o,raw),[bytes,nil]);held(MobileSharedCapture.capture(itemJSON:raw,attempt:try attempt(o,raw),lease:l,owner:o));XCTAssertEqual(l.reads,0);XCTAssertEqual(d.data,before);try evidence("capacity-health-blocks-share",before:before,after:d.data,raw:raw,extra:["expectedOutcome":"held","readCount":l.reads,"maxEvents":1])
        let d2=ShareMemory(),o2=HealthOutbox(storage:d2,shareAuthority:w);try o2.setHuman(human);let old=d2.data;d2.failure=1;let l2=ShareLease(try context(o2,raw),[bytes,nil]);if case .commitUnknown=MobileSharedCapture.capture(itemJSON:raw,attempt:try attempt(o2,raw),lease:l2,owner:o2){}else{XCTFail("invoked replace failure must be ambiguous")};XCTAssertEqual(d2.data,old);try evidence("replace-before-write-unknown",before:old,after:d2.data,raw:raw,extra:["expectedOutcome":"unknown","readCount":l2.reads])
    }
    func testFreshAuthorizationAndCorruptV3FailClosed()throws {
        let d=ShareMemory(),w=ShareWitness(),o=HealthOutbox(storage:d,shareAuthority:w),raw=try item(bytes);try o.setHuman(human);let a=try attempt(o,raw);ack(MobileSharedCapture.capture(itemJSON:raw,attempt:a,lease:ShareLease(try context(o,raw),[bytes,nil]),owner:o));let snapshot=try XCTUnwrap(d.data)
        w.allowed=false;let restarted=HealthOutbox(storage:d,shareAuthority:w);try restarted.setHuman(human);let denied=ShareLease(try context(restarted,raw,recovery:true),[]);held(MobileSharedCapture.capture(itemJSON:raw,attempt:try attemptRecovery(restarted,raw,a.id),lease:denied,owner:restarted));XCTAssertEqual(denied.reads,0);XCTAssertEqual(d.data,snapshot)
        w.allowed=true;let fresh=ShareLease(try context(restarted,raw,recovery:true),[]);ack(MobileSharedCapture.capture(itemJSON:raw,attempt:try attemptRecovery(restarted,raw,a.id),lease:fresh,owner:restarted));XCTAssertEqual(fresh.reads,0);try evidence("fresh-policy-recovery",before:snapshot,after:d.data,reload:d.data,raw:raw,extra:["deniedOutcome":"held","recoveryOutcome":"acknowledged","deniedReads":denied.reads,"recoveryReads":fresh.reads])
        var bad=try XCTUnwrap(JSONSerialization.jsonObject(with:snapshot) as? [String:Any]);bad.removeValue(forKey:"shareAssociations");d.data=try JSONSerialization.data(withJSONObject:bad);let broken=HealthOutbox(storage:d,shareAuthority:w);XCTAssertThrowsError(try broken.setHuman(human)){XCTAssertEqual($0 as? HealthOutboxError,.corrupt)};try evidence("v3-missing-shape",before:snapshot,after:d.data,raw:raw,extra:["expectedOutcome":"corrupt"])
    }
}

extension MobileSharedCaptureOutboxTests {
    func testActualEncodedQuoteBoundsAndSnapshotTrace()throws {
        let d=ShareMemory(),w=ShareWitness(),o=HealthOutbox(storage:d,shareAuthority:w),sample=Data(repeating:255,count:7),raw=try item(sample),item=try MobileSharedItem.decode(raw);try o.setHuman(human);let a=try attempt(o,raw);let before=try XCTUnwrap(d.data),digest=SHA256.hash(data:item.data).map{String(format:"%02x",$0)}.joined(),c=try context(o,raw)
        guard case .reserved(let ticket,let budget)=try o.reserve(attempt:a,payloadDigest:digest,item:item,context:c) else{return XCTFail("expected quote")};let quote=try XCTUnwrap(Mirror(reflecting:ticket).children.first{$0.label=="quote"}?.value as? Int);XCTAssertEqual(budget,sample.count)
        guard case .acknowledged=try o.commit(ticket,itemJSON:item.data,capturedBytes:sample,integrity:try XCTUnwrap(MobileSharedItem.verify(item,bytes:sample))) else{return XCTFail("expected commit")};let after=try XCTUnwrap(d.data);XCTAssertLessThanOrEqual(after.count,quote);XCTAssertLessThanOrEqual(quote,8*1024*1024)
        let trace:[String:Any]=["case":"actual-encoded-quote","beforeBase64":before.base64EncodedString(),"afterBase64":after.base64EncodedString(),"itemBase64":item.data.base64EncodedString(),"capturedBase64":sample.base64EncodedString(),"quoteBytes":quote,"actualBytes":after.count,"cap":8*1024*1024];let encoded=try JSONSerialization.data(withJSONObject:trace,options:[.sortedKeys]);print("LS108_SYNTHETIC_TRACE "+String(decoding:encoded,as:UTF8.self))
    }
    func testUnexpectedV3FieldFailsClosed()throws {
        let d=ShareMemory(),w=ShareWitness(),o=HealthOutbox(storage:d,shareAuthority:w),raw=try item(bytes);try o.setHuman(human);ack(MobileSharedCapture.capture(itemJSON:raw,attempt:try attempt(o,raw),lease:ShareLease(try context(o,raw),[bytes,nil]),owner:o))
        var root=try XCTUnwrap(JSONSerialization.jsonObject(with:XCTUnwrap(d.data)) as? [String:Any]),rows=try XCTUnwrap(root["shareAssociations"] as? [String:[String:Any]]);let key=try XCTUnwrap(rows.keys.first);rows[key]?["unexpected"]=true;root["shareAssociations"]=rows;d.data=try JSONSerialization.data(withJSONObject:root);let reboot=HealthOutbox(storage:d,shareAuthority:w);XCTAssertThrowsError(try reboot.setHuman(human)){XCTAssertEqual($0 as? HealthOutboxError,.corrupt)}
    }
}

extension MobileSharedCaptureOutboxTests {
    func testWrongHostScopeOrExpiredWitnessDoesNotRead()throws {
        let d=ShareMemory(),w=ShareWitness(),o=HealthOutbox(storage:d,shareAuthority:w),raw=try item(bytes);try o.setHuman(human);w.expectedHuman=human;w.expectedEndpoint=endpoint;w.expectedNamespace=try MobileSharedItem.decode(raw).source.namespace
        for mode in 0..<3 {let c=OutboxShareContext(owner:o,human:mode==0 ? UUID():human,endpoint:mode==1 ? UUID():endpoint,namespace:try MobileSharedItem.decode(raw).source.namespace,collector:"iosShareDeclaration",epoch:mode==2 ? 2:1,recoveryOnly:false),l=ShareLease(c,[bytes,nil]),before=d.data;held(MobileSharedCapture.capture(itemJSON:raw,attempt:try attempt(o,raw),lease:l,owner:o));XCTAssertEqual(l.reads,0);XCTAssertEqual(l.closes,1);XCTAssertEqual(d.data,before)}
    }
}

private final class JoinTrace {var events=[[String:Any]]();func add(_ name:String,_ extra:[String:Any]=[:]){var e=extra;e["event"]=name;events.append(e)}}
private final class TracedStorage:HealthSnapshotStorage {
    let trace:JoinTrace;var data:Data?,failure=0,writes=0
    init(_ trace:JoinTrace){self.trace=trace}
    func read()throws->Data?{trace.add("storage.read",["snapshot":data?.base64EncodedString() as Any? ?? NSNull()]);return data}
    func replace(_ value:Data)throws{writes += 1;trace.add("storage.replace",["bytes":value.base64EncodedString(),"failure":failure]);if failure==1{throw CocoaError(.fileWriteUnknown)};data=value;if failure==2{throw CocoaError(.fileWriteUnknown)}}
}
private final class TracedWitness:OutboxShareAuthority {
    let trace:JoinTrace,lock=NSRecursiveLock();var allowed=true,validLease=true,epoch:UInt64=1
    init(_ trace:JoinTrace){self.trace=trace}
    func withFence<T>(_ body:()throws->T) rethrows->T {lock.lock();trace.add("fence.enter");defer{trace.add("fence.exit");lock.unlock()};return try body()}
    func permits(_ context:OutboxShareContext,reading:Bool)->Bool{let ok=allowed && context.epoch==epoch && (!reading || validLease);trace.add("witness.check",["reading":reading,"allowed":ok,"human":context.human.uuidString,"endpoint":context.endpoint.uuidString,"namespace":context.namespace.uuidString,"epoch":context.epoch,"recoveryOnly":context.recoveryOnly]);return ok}
}
private final class TracedLease:SharedCaptureReadLease {
    let trace:JoinTrace,originalSelectionContext:any SharedCaptureBinding;var chunks:[Data?],reads=0,closes=0,checks=0;var onRead:(()->Void)?
    init(_ trace:JoinTrace,_ c:OutboxShareContext,_ chunks:[Data?]){self.trace=trace;originalSelectionContext=c;self.chunks=chunks}
    func check()throws {checks += 1;trace.add("lease.check")}
    func read(maxBytes:Int)throws->Data?{reads += 1;guard !chunks.isEmpty else{throw CocoaError(.fileReadUnknown)};let x=chunks.removeFirst();trace.add("lease.read",["maximum":maxBytes,"returned":x?.base64EncodedString() as Any? ?? NSNull()]);onRead?();return x}
    func close(){closes += 1;trace.add("lease.close")}
}
private final class TracedOwner:SharedCaptureOwner {
    let actual:HealthOutbox,trace:JoinTrace;var reconciles=0,reserves=0,checks=0,commits=0,abandons=0,quote:Int?
    init(_ actual:HealthOutbox,_ trace:JoinTrace){self.actual=actual;self.trace=trace}
    func reconcile(attempt:any SharedCaptureAttempt,payloadDigest:String,item:MobileSharedItem.Value,context:any SharedCaptureBinding)throws->SharedCaptureReconciliation {reconciles += 1;trace.add("owner.reconcile.enter",["digest":payloadDigest]);let r=try actual.reconcile(attempt:attempt,payloadDigest:payloadDigest,item:item,context:context);trace.add("owner.reconcile.exit");return r}
    func reserve(attempt:any SharedCaptureAttempt,payloadDigest:String,item:MobileSharedItem.Value,context:any SharedCaptureBinding)throws->SharedCaptureReservationResult {reserves += 1;trace.add("owner.reserve.enter");let r=try actual.reserve(attempt:attempt,payloadDigest:payloadDigest,item:item,context:context);if case .reserved(let ticket,let budget)=r {quote=Mirror(reflecting:ticket).children.first{$0.label=="quote"}?.value as? Int;trace.add("owner.reserve.exit",["quote":quote as Any? ?? NSNull(),"budget":budget])}else{trace.add("owner.reserve.held")};return r}
    func check(_ r:any SharedCaptureReservation)throws{checks += 1;trace.add("owner.check.enter");try actual.check(r);trace.add("owner.check.exit")}
    func commit(_ r:any SharedCaptureReservation,itemJSON:Data,capturedBytes:Data,integrity:[String:Any])throws->SharedCaptureCommitResult {commits += 1;trace.add("owner.commit.enter",["item":itemJSON.base64EncodedString(),"captured":capturedBytes.base64EncodedString(),"integrity":integrity]);do{let result=try actual.commit(r,itemJSON:itemJSON,capturedBytes:capturedBytes,integrity:integrity);trace.add("owner.commit.exit");return result}catch{trace.add("owner.commit.throw");throw error}}
    func abandon(_ r:any SharedCaptureReservation){abandons += 1;trace.add("owner.abandon");actual.abandon(r)}
}

extension MobileSharedCaptureOutboxTests {
    func testActualOwnerPerScenarioTraces()throws {
        let raw=try item(bytes),decoded=try MobileSharedItem.decode(raw),hash=SHA256.hash(data:decoded.data).map{String(format:"%02x",$0)}.joined()
        for scenario in ["success","witness-denied","lost-after-read","capacity","replace-no-write-unknown","replace-write-unknown"] {
            let trace=JoinTrace(),disk=TracedStorage(trace),w=TracedWitness(trace),o=HealthOutbox(storage:disk,maxEvents:scenario=="capacity" ? 0:100_000,shareAuthority:w);try o.setHuman(human);let before=disk.data,owner=TracedOwner(o,trace),ctx=try context(o,raw),source=TracedLease(trace,ctx,[bytes,nil]),attempt=OutboxShareAttempt(UUID(),context:ctx)
            if scenario=="witness-denied"{w.allowed=false};if scenario=="lost-after-read"{source.onRead={w.allowed=false}};if scenario=="replace-no-write-unknown"{disk.failure=1};if scenario=="replace-write-unknown"{disk.failure=2}
            trace.events.removeAll();let result=MobileSharedCapture.capture(itemJSON:raw,attempt:attempt,lease:source,owner:owner),outcome:String;switch result{case .held:outcome="held";case .portAcknowledged:outcome="acknowledged";case .commitUnknown:outcome="unknown"}
            XCTAssertEqual(source.closes,1);if scenario=="success"{XCTAssertEqual(outcome,"acknowledged")}else if scenario.hasPrefix("replace-"){XCTAssertEqual(outcome,"unknown");XCTAssertEqual(owner.abandons,0)}else{XCTAssertEqual(outcome,"held")}
            let after=disk.data;var reload:Data?=nil,recoveryReads:Int?=nil,recoveryOutcome:String?=nil
            if scenario=="success" || scenario=="replace-write-unknown" {disk.failure=0;let restart=HealthOutbox(storage:disk,shareAuthority:w);try restart.setHuman(human);let r=TracedOwner(restart,trace),lease=TracedLease(trace,try context(restart,raw,recovery:true),[]);switch MobileSharedCapture.capture(itemJSON:raw,attempt:OutboxShareAttempt(attempt.id,context:try context(restart,raw,recovery:true)),lease:lease,owner:r){case .portAcknowledged:recoveryOutcome="acknowledged";default:recoveryOutcome="other"};recoveryReads=lease.reads;reload=disk.data;XCTAssertEqual(recoveryOutcome,"acknowledged");XCTAssertEqual(recoveryReads,0)}
            let report:[String:Any]=["case":scenario,"outcome":outcome,"snapshotBefore":before?.base64EncodedString() as Any? ?? NSNull(),"snapshotAfter":after?.base64EncodedString() as Any? ?? NSNull(),"snapshotReload":reload?.base64EncodedString() as Any? ?? NSNull(),"itemJSON":decoded.data.base64EncodedString(),"payloadDigest":hash,"sourceBytes":bytes.base64EncodedString(),"sourceSHA256":SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined(),"sourceLength":bytes.count,"quoteBytes":owner.quote as Any? ?? NSNull(),"maxBytes":8388608,"maxEvents":scenario=="capacity" ? 0:100000,"reads":source.reads,"closes":source.closes,"reconcileCalls":owner.reconciles,"reserveCalls":owner.reserves,"checkCalls":owner.checks,"commitCalls":owner.commits,"abandonCalls":owner.abandons,"writeCalls":disk.writes-1,"recoveryOutcome":recoveryOutcome as Any? ?? NSNull(),"recoveryReads":recoveryReads as Any? ?? NSNull(),"events":trace.events]
            let reportData=try JSONSerialization.data(withJSONObject:report,options:[.sortedKeys,.prettyPrinted]);if let dir=ProcessInfo.processInfo.environment["LS108_TRACE_DIR"] {try reportData.write(to:URL(fileURLWithPath:dir,isDirectory:true).appendingPathComponent(scenario+".json"),options:.withoutOverwriting)}else{print("LS108_JOIN_SCENARIO "+String(decoding:reportData,as:UTF8.self))}
        }
    }
}

extension MobileSharedCaptureOutboxTests {
    func testAttemptOwnerLineageTokenAndRecoveryEpoch()throws {
        let d=ShareMemory(),w=ShareWitness(),o=HealthOutbox(storage:d,shareAuthority:w),raw=try item(bytes);try o.setHuman(human);let original=try context(o,raw),id=UUID(),a=OutboxShareAttempt(id,context:original),before=d.data
        w.expectedLease=original.leaseToken;let substituted=OutboxShareContext(owner:o,human:human,endpoint:endpoint,namespace:original.namespace,collector:original.collector,epoch:original.epoch,leaseToken:UUID(),recoveryOnly:false),wrongLease=ShareLease(substituted,[bytes,nil]);held(MobileSharedCapture.capture(itemJSON:raw,attempt:a,lease:wrongLease,owner:o));XCTAssertEqual(wrongLease.reads,0);XCTAssertEqual(d.data,before)
        let forged=ShareLease(substituted,[bytes,nil]);held(MobileSharedCapture.capture(itemJSON:raw,attempt:OutboxShareAttempt(id,context:substituted),lease:forged,owner:o));XCTAssertEqual(forged.reads,0);XCTAssertEqual(d.data,before)
        let wrongScope=OutboxShareContext(owner:o,human:human,endpoint:UUID(),namespace:original.namespace,collector:original.collector,epoch:original.epoch,leaseToken:original.leaseToken,recoveryOnly:false),wrongLineage=ShareLease(wrongScope,[bytes,nil]);held(MobileSharedCapture.capture(itemJSON:raw,attempt:a,lease:wrongLineage,owner:o));XCTAssertEqual(wrongLineage.reads,0);XCTAssertEqual(d.data,before)
        let other=HealthOutbox(storage:d,shareAuthority:w);try other.setHuman(human);let foreign=ShareLease(try context(other,raw),[bytes,nil]);held(MobileSharedCapture.capture(itemJSON:raw,attempt:a,lease:foreign,owner:other));XCTAssertEqual(foreign.reads,0);XCTAssertEqual(d.data,before)
        ack(MobileSharedCapture.capture(itemJSON:raw,attempt:a,lease:ShareLease(original,[bytes,nil]),owner:o));let stored=try XCTUnwrap(d.data),obj=try XCTUnwrap(JSONSerialization.jsonObject(with:stored) as? [String:Any]),records=try XCTUnwrap(obj["shareAssociations"] as? [String:[String:Any]]);XCTAssertEqual(records.values.first?["epoch"] as? Int,1)
        w.epoch=2;let restart=HealthOutbox(storage:d,shareAuthority:w);try restart.setHuman(human);let fresh=try context(restart,raw,recovery:true,epoch:2),recovery=ShareLease(fresh,[]);ack(MobileSharedCapture.capture(itemJSON:raw,attempt:OutboxShareAttempt(id,context:fresh),lease:recovery,owner:restart));XCTAssertEqual(recovery.reads,0);XCTAssertEqual(d.data,stored);try evidence("foreign-owner-lease-epoch-recovery",before:before,after:stored,reload:d.data,raw:raw,extra:["substitutedLeaseOutcome":"held","substitutedLeaseReads":wrongLease.reads,"forgedWitnessOutcome":"held","forgedWitnessReads":forged.reads,"foreignOwnerOutcome":"held","foreignOwnerReads":foreign.reads,"foreignLineageOutcome":"held","foreignLineageReads":wrongLineage.reads,"recoveryOutcome":"acknowledged","recoveryReads":recovery.reads,"originalEpoch":1,"recoveryEpoch":2])
    }
}

private final class BarrierWitness:OutboxShareAuthority {
    let lock=NSRecursiveLock(),entered=DispatchSemaphore(value:0),release=DispatchSemaphore(value:0),revoked=DispatchSemaphore(value:0);var calls=0,allowed=true,events=[String]()
    func withFence<T>(_ body:()throws->T) rethrows->T {lock.lock();events.append("enter");defer{events.append("exit");lock.unlock()};return try body()}
    func permits(_ context:OutboxShareContext,reading:Bool)->Bool {calls += 1;if calls==2 {events.append("final-check");entered.signal();_ = release.wait(timeout:.now()+5)};return allowed}
    func revoke(){lock.lock();events.append("revoke");allowed=false;lock.unlock();revoked.signal()}
}
extension MobileSharedCaptureOutboxTests {
    func testSameOwnerSaveInvalidatesReservation()throws {
        let disk=ShareMemory(),w=ShareWitness(),o=HealthOutbox(storage:disk,shareAuthority:w),raw=try item(bytes),item=try MobileSharedItem.decode(raw);try o.setHuman(human);let c=try context(o,raw),id=OutboxShareAttempt(UUID(),context:c),digest=SHA256.hash(data:item.data).map{String(format:"%02x",$0)}.joined();guard case .reserved(let ticket,_)=try o.reserve(attempt:id,payloadDigest:digest,item:item,context:c) else{return XCTFail("reserve")};let before=disk.data;try o.enroll(UUID(),human:human,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:"health");let saved=disk.data;XCTAssertNotEqual(saved,before);XCTAssertThrowsError(try o.check(ticket));guard case .held=try o.commit(ticket,itemJSON:item.data,capturedBytes:bytes,integrity:try XCTUnwrap(MobileSharedItem.verify(item,bytes:bytes))) else{return XCTFail("stale reservation")};XCTAssertEqual(disk.data,saved);try evidence("intervening-owner-save",before:before,after:disk.data,raw:raw,extra:["expectedOutcome":"held","newHealthEnrollment":true])
    }
    func testFenceSerializesRevocationWithFinalReplace()throws {
        let disk=ShareMemory(),w=BarrierWitness(),o=HealthOutbox(storage:disk,shareAuthority:w),raw=try item(bytes),item=try MobileSharedItem.decode(raw);try o.setHuman(human);let c=try context(o,raw),a=OutboxShareAttempt(UUID(),context:c),digest=SHA256.hash(data:item.data).map{String(format:"%02x",$0)}.joined();guard case .reserved(let ticket,_)=try o.reserve(attempt:a,payloadDigest:digest,item:item,context:c) else{return XCTFail("reserve")};let before=disk.data,done=expectation(description:"commit and revocation"),revokerStarted=DispatchSemaphore(value:0)
        DispatchQueue.global().async { _ = try? o.commit(ticket,itemJSON:item.data,capturedBytes:self.bytes,integrity:MobileSharedItem.verify(item,bytes:self.bytes) ?? [:]);done.fulfill() }
        XCTAssertEqual(w.entered.wait(timeout:.now()+5),.success);DispatchQueue.global().async {revokerStarted.signal();w.revoke()};XCTAssertEqual(revokerStarted.wait(timeout:.now()+5),.success);XCTAssertEqual(w.revoked.wait(timeout:.now()+0.05),.timedOut);w.release.signal();wait(for:[done],timeout:5);XCTAssertEqual(w.revoked.wait(timeout:.now()+5),.success);XCTAssertEqual(Array(w.events.suffix(3)),["final-check","exit","revoke"]);try evidence("fence-final-commit-before-revoke",before:before,after:disk.data,raw:raw,extra:["events":w.events,"revocationBlockedWhileFinalCheck":true])
    }
}

extension MobileSharedCaptureOutboxTests {
    func testCalendarCapacityBlocksShare()throws {
        let (fixture,p)=try calendarFixture(),raw=try item(bytes),decoded=try MobileSharedItem.decode(raw),d=ShareMemory(),w=ShareWitness(),o=HealthOutbox(storage:d,maxEvents:1,shareAuthority:w);try o.setHuman(p.principal);try o.admitCalendar(proof:p);let ct=try o.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"),vectors=try XCTUnwrap(fixture["vectors"] as? [[String:Any]]);var event=try XCTUnwrap(vectors[0]["item"] as? [String:Any]),change=try XCTUnwrap(event["change"] as? [String:Any]);change["expectedPolicyRevision"]=p.revision;event["change"]=change;let encoded=try JSONSerialization.data(withJSONObject:event,options:[.sortedKeys,.withoutEscapingSlashes]),scope=try MobileCalendarDelivery.CheckpointScope(collector:p.collector,namespace:p.namespace,mappingVersion:"synthetic-calendar-mapping/1",coverage:.partial,start:"2026-10-01T00:00:00Z",end:"2026-11-01T00:00:00Z");try o.commitCalendar(scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([9]),items:[encoded],ticket:ct)
        let before=d.data,c=OutboxShareContext(owner:o,human:p.principal,endpoint:p.endpoint,namespace:decoded.source.namespace,collector:decoded.source.collector,epoch:1,recoveryOnly:false),lease=ShareLease(c,[bytes,nil]);held(MobileSharedCapture.capture(itemJSON:raw,attempt:OutboxShareAttempt(UUID(),context:c),lease:lease,owner:o));XCTAssertEqual(lease.reads,0);XCTAssertEqual(d.data,before);try evidence("capacity-calendar-blocks-share",before:before,after:d.data,raw:raw,extra:["expectedOutcome":"held","readCount":lease.reads,"maxEvents":1])
    }
}

extension MobileSharedCaptureOutboxTests {
    func foreignOwnerCheck(_ action:String)throws {
        let raw=try item(bytes),item=try MobileSharedItem.decode(raw),digest=SHA256.hash(data:item.data).map{String(format:"%02x",$0)}.joined()
        do {
            let diskA=ShareMemory(),diskB=ShareMemory(),authA=ShareWitness(),authB=ShareWitness(),a=HealthOutbox(storage:diskA,shareAuthority:authA),b=HealthOutbox(storage:diskB,shareAuthority:authB);try a.setHuman(human);try b.setHuman(human)
            let c=try context(a,raw),attempt=OutboxShareAttempt(UUID(),context:c);guard case .reserved(let ticket,_)=try a.reserve(attempt:attempt,payloadDigest:digest,item:item,context:c) else{return XCTFail("reserve")};let beforeA=diskA.data,beforeB=diskB.data,readsB=diskB.reads,writesB=diskB.writes,fenceB=authB.fenceCalls,permitsB=authB.permitCalls
            switch action {
            case "commit":guard case .held=try b.commit(ticket,itemJSON:item.data,capturedBytes:bytes,integrity:try XCTUnwrap(MobileSharedItem.verify(item,bytes:bytes))) else{return XCTFail("foreign commit")}
            case "abandon":b.abandon(ticket)
            default:XCTAssertThrowsError(try b.check(ticket))
            }
            let afterForeignA=diskA.data;XCTAssertEqual(afterForeignA,beforeA);XCTAssertEqual(diskB.data,beforeB);XCTAssertEqual(diskB.reads,readsB);XCTAssertEqual(diskB.writes,writesB);XCTAssertEqual(authB.fenceCalls,fenceB);XCTAssertEqual(authB.permitCalls,permitsB)
            try a.check(ticket);guard case .acknowledged=try a.commit(ticket,itemJSON:item.data,capturedBytes:bytes,integrity:try XCTUnwrap(MobileSharedItem.verify(item,bytes:bytes))) else{return XCTFail("original reservation must remain usable")}
            try evidence("foreign-reservation-"+action,before:beforeA,after:diskA.data,raw:raw,extra:["foreignOutcome":"held-or-denied","foreignStorageReads":diskB.reads-readsB,"foreignStorageWrites":diskB.writes-writesB,"foreignFenceCalls":authB.fenceCalls-fenceB,"foreignPermitCalls":authB.permitCalls-permitsB,"ownerOutcome":"acknowledged","ownerSnapshotAfterForeign":afterForeignA?.base64EncodedString() as Any? ?? NSNull(),"foreignSnapshotBefore":beforeB?.base64EncodedString() as Any? ?? NSNull(),"foreignSnapshotAfter":diskB.data?.base64EncodedString() as Any? ?? NSNull()])
        }
    }
    func testForeignCommitPreservesReservation()throws {try foreignOwnerCheck("commit")}
    func testForeignAbandonPreservesReservation()throws {try foreignOwnerCheck("abandon")}
    func testForeignCheckDoesNotEnterFence()throws {try foreignOwnerCheck("check")}
}
