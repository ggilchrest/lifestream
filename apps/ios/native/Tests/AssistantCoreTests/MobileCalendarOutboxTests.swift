import Foundation
import XCTest
@testable import AssistantCore
private final class CalendarMemory:HealthSnapshotStorage {var bytes:Data?;var fail=false;func read()throws->Data?{bytes};func replace(_ data:Data)throws{if fail{throw CocoaError(.fileWriteNoPermission)};bytes=data}}
final class MobileCalendarOutboxTests:XCTestCase {
    private func fixture(_ name:String="delivery-receipts.json")throws->[String:Any] {
        let ios=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try XCTUnwrap(JSONSerialization.jsonObject(with:Data(contentsOf:ios.appendingPathComponent("test/mobile-calendar-fixtures/"+name))) as? [String:Any])
    }
    private func bytes(_ x:Any)throws->Data {try JSONSerialization.data(withJSONObject:x,options:[.sortedKeys,.withoutEscapingSlashes])}
    private func proof(_ f:[String:Any])throws->MobileCalendarPolicyProof {
        try MobileCalendarPolicyParser.parse(bytes(XCTUnwrap(f["policy"])),expectedPrincipal:UUID(uuidString:"50000000-0000-4000-8000-000000000001")!,expectedEndpoint:UUID(uuidString:"60000000-0000-4000-8000-000000000001")!,expectedEnrollment:UUID(uuidString:"30000000-0000-4000-8000-000000000001")!)
    }
    private func scope(_ p:MobileCalendarPolicyProof,coverage:MobileCalendarDelivery.CheckpointScope.Coverage = .partial)throws->MobileCalendarDelivery.CheckpointScope {
        try .init(collector:p.collector,namespace:p.namespace,mappingVersion:"synthetic-calendar-mapping/1",coverage:coverage,start:"2026-10-01T00:00:00Z",end:"2026-11-01T00:00:00Z")
    }
    private func input(_ vector:[String:Any],revision:Int=2)throws->Data {
        var item=try XCTUnwrap(vector["item"] as? [String:Any]),change=try XCTUnwrap(item["change"] as? [String:Any]);change["expectedPolicyRevision"]=revision;item["change"]=change;return try bytes(item)
    }
    private func receipt(_ items:[MobileCalendarDelivery.Item],outcome:String="accepted",code:String="applied",durability:Any="sqlCommit")throws->Data {
        let receipts=items.map{["eventId":$0.eventId.uuidString.lowercased(),"requestDigest":$0.digest,"outcome":outcome,"code":code,"durability":durability] as [String:Any]}
        return try bytes(["schemaVersion":"1.0.0","producerPin":["schemaId":MobileCalendarDelivery.schemaId,"schemaVersion":"1.0.0","digest":MobileCalendarDelivery.schemaDigest],"result":["kind":"sync","receipts":receipts]])
    }
    func testProducerCanonicalVectorsAndInvalidUnicode()throws {
        let f=try fixture(),vectors=try XCTUnwrap(f["vectors"] as? [[String:Any]]);XCTAssertEqual(vectors.count,6)
        for v in vectors {let item=try MobileCalendarDelivery.item(bytes(XCTUnwrap(v["item"])));XCTAssertEqual(item.data,Data(try XCTUnwrap(v["canonicalUtf8"] as? String).utf8));XCTAssertEqual(item.digest,v["sha256"] as? String)}
        let unpaired=Data("{\"x\":\"\\uD800\"}".utf8);XCTAssertThrowsError(try MobileCalendarDelivery.item(unpaired))
        XCTAssertNotEqual(try MobileCalendarDelivery.canonical(["x":"é"]),try MobileCalendarDelivery.canonical(["x":"e\u{301}"]))
        XCTAssertEqual(try MobileCalendarDelivery.canonical(["x":-0.0]),Data("{\"x\":0}".utf8))
        XCTAssertThrowsError(try MobileCalendarDelivery.canonical(["x":1.25]))
    }
    func testSeparatePolicyAndUnavailableFailClosed()throws {
        let f=try fixture(),valid=try proof(f);XCTAssertEqual(valid.categories,Set(["CalendarEvent","Task"]))
        var policy=try XCTUnwrap(f["policy"] as? [String:Any]),result=try XCTUnwrap(policy["result"] as? [String:Any]),effective=try XCTUnwrap(result["effective"] as? [String:Any]);effective["policyAvailable"]=false;effective["policyBindingDigest"]=NSNull();effective["collectionAllowed"]=false;effective["categories"]=[];result["effective"]=effective;policy["result"]=result
        XCTAssertThrowsError(try MobileCalendarPolicyParser.parse(bytes(policy),expectedPrincipal:valid.principal,expectedEndpoint:valid.endpoint,expectedEnrollment:valid.enrollment))
        XCTAssertThrowsError(try MobileCalendarPolicyParser.parse(bytes(XCTUnwrap(f["policy"])),expectedPrincipal:UUID(),expectedEndpoint:valid.endpoint,expectedEnrollment:valid.enrollment))
    }
    func testMigrationAtomicCheckpointRestartAndExactReceipts()throws {
        let f=try fixture(),p=try proof(f),vectors=try XCTUnwrap(f["vectors"] as? [[String:Any]]),disk=CalendarMemory(),store=HealthOutbox(storage:disk),health=UUID()
        try store.setHuman(p.principal);try store.enroll(health,human:p.principal,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:"health-source")
        let healthTicket=try store.ticket(enrollment:health,type:"sleep"),healthChange=HealthChange(upstreamId:"health",operation:.upsert,body:Data([1,2,3]),expectedPolicyRevision:1,mappingVersion:"v1")
        try store.commit(scope:"health",expectedAnchor:nil,nextAnchor:Data([7]),changes:[healthChange],ticket:healthTicket)
        let v1=try XCTUnwrap(disk.bytes),v1object=try XCTUnwrap(JSONSerialization.jsonObject(with:v1) as? [String:Any]);XCTAssertEqual(v1object["version"] as? Int,1)
        disk.fail=true;XCTAssertThrowsError(try store.admitCalendar(proof:p));XCTAssertEqual(disk.bytes,v1);disk.fail=false;try store.admitCalendar(proof:p)
        let beforeProof=try store.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent")
        try store.confirmCalendarPolicy(proof:p);XCTAssertEqual(try store.pending(ticket:healthTicket),[healthChange]);XCTAssertThrowsError(try store.pendingCalendar(ticket:beforeProof))
        let ticket=try store.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"),raw=try input(vectors[0]),item=try MobileCalendarDelivery.item(raw),scan=try scope(p)
        try store.confirmEffectivePolicy(enrollment:health,revision:1,enabledTypes:["sleep"],sourceNamespace:"health-source",serverActive:true)
        XCTAssertEqual(try store.pendingCalendar(ticket:ticket),[])
        let healthAfter=try store.ticket(enrollment:health,type:"sleep")
        try store.commitCalendar(scope:scan,expectedCheckpoint:nil,nextCheckpoint:Data([9]),items:[raw],ticket:ticket)
        let before=try XCTUnwrap(disk.bytes);XCTAssertThrowsError(try store.commitCalendar(scope:scan,expectedCheckpoint:Data([9]),nextCheckpoint:Data([10]),items:[raw],ticket:ticket));XCTAssertEqual(disk.bytes,before)
        var altered=try XCTUnwrap(JSONSerialization.jsonObject(with:raw) as? [String:Any]),alteredChange=try XCTUnwrap(altered["change"] as? [String:Any]),alteredRecord=try XCTUnwrap(alteredChange["record"] as? [String:Any]);alteredRecord["title"]="different";alteredChange["record"]=alteredRecord;altered["change"]=alteredChange
        XCTAssertThrowsError(try store.commitCalendar(scope:scan,expectedCheckpoint:Data([9]),nextCheckpoint:Data([10]),items:[bytes(altered)],ticket:ticket));XCTAssertEqual(disk.bytes,before)
        let wrongScope=try MobileCalendarDelivery.CheckpointScope(collector:p.collector,namespace:UUID(),mappingVersion:"synthetic-calendar-mapping/1",coverage:.partial,start:"2026-10-01T00:00:00Z",end:"2026-11-01T00:00:00Z")
        XCTAssertThrowsError(try store.commitCalendar(scope:wrongScope,expectedCheckpoint:nil,nextCheckpoint:Data([1]),items:[],ticket:ticket));XCTAssertEqual(disk.bytes,before)
        XCTAssertEqual(try store.pending(ticket:healthAfter),[healthChange]);XCTAssertEqual(try store.anchor(for:"health",ticket:healthAfter),Data([7]))
        let restart=HealthOutbox(storage:disk);try restart.setHuman(p.principal);XCTAssertThrowsError(try restart.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"));try restart.confirmCalendarPolicy(proof:p);let next=try restart.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent")
        XCTAssertEqual(try restart.pendingCalendar(ticket:next),[item.data]);XCTAssertEqual(try restart.calendarCheckpoint(scope:scan,ticket:next),Data([9]))
        var bad=try XCTUnwrap(JSONSerialization.jsonObject(with:receipt([item])) as? [String:Any]),result=try XCTUnwrap(bad["result"] as? [String:Any]),rs=try XCTUnwrap(result["receipts"] as? [[String:Any]]);rs[0]["requestDigest"]=String(repeating:"a",count:64);result["receipts"]=rs;bad["result"]=result
        XCTAssertThrowsError(try restart.settleCalendar(ticket:next,submitted:[item.data],response:bytes(bad)));XCTAssertEqual(try restart.pendingCalendar(ticket:next),[item.data])
        XCTAssertThrowsError(try restart.settleCalendar(ticket:next,submitted:[item.data],response:receipt([item],outcome:"accepted",code:"applied",durability:NSNull())));XCTAssertEqual(try restart.pendingCalendar(ticket:next),[item.data])
        try restart.settleCalendar(ticket:next,submitted:[item.data],response:receipt([item]));XCTAssertEqual(try restart.pendingCalendar(ticket:next),[])
    }
    func testEntireReceiptSetMustMatchBeforeAnyAcknowledgement()throws {
        let f=try fixture(),p=try proof(f),vectors=try XCTUnwrap(f["vectors"] as? [[String:Any]]),disk=CalendarMemory(),store=HealthOutbox(storage:disk);try store.setHuman(p.principal);try store.admitCalendar(proof:p);let ticket=try store.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"),scan=try scope(p)
        let first=try MobileCalendarDelivery.item(input(vectors[0])),second=try MobileCalendarDelivery.item(input(vectors[3]));try store.commitCalendar(scope:scan,expectedCheckpoint:nil,nextCheckpoint:Data([1]),items:[first.data,second.data],ticket:ticket)
        XCTAssertThrowsError(try store.settleCalendar(ticket:ticket,submitted:[first.data,second.data],response:receipt([first])));XCTAssertEqual(try store.pendingCalendar(ticket:ticket).count,2)
        var obj=try XCTUnwrap(JSONSerialization.jsonObject(with:receipt([first,second])) as? [String:Any]),r=try XCTUnwrap(obj["result"] as? [String:Any]),entries=try XCTUnwrap(r["receipts"] as? [[String:Any]]);entries[1]["outcome"]="duplicate";entries[1]["requestDigest"]=String(repeating:"0",count:64);r["receipts"]=entries;obj["result"]=r
        XCTAssertThrowsError(try store.settleCalendar(ticket:ticket,submitted:[first.data,second.data],response:bytes(obj)));XCTAssertEqual(try store.pendingCalendar(ticket:ticket).count,2)
        entries[1]["requestDigest"]=second.digest;r["receipts"]=entries;obj["result"]=r;try store.settleCalendar(ticket:ticket,submitted:[first.data,second.data],response:bytes(obj));XCTAssertEqual(try store.pendingCalendar(ticket:ticket),[])
    }
    func testUnavailableRefreshInvalidatesPriorCalendarProof()throws {
        let f=try fixture(),p=try proof(f),disk=CalendarMemory(),store=HealthOutbox(storage:disk);try store.setHuman(p.principal);try store.admitCalendar(proof:p);let old=try store.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent")
        store.invalidateCalendarPolicy(enrollment:p.enrollment)
        XCTAssertThrowsError(try store.pendingCalendar(ticket:old));XCTAssertThrowsError(try store.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"))
        try store.confirmCalendarPolicy(proof:p);XCTAssertNoThrow(try store.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"))
    }
    func testMixedAcceptedAndInvalidReceiptQuarantinesOriginalAtomically()throws {
        let f=try fixture(),p=try proof(f),vectors=try XCTUnwrap(f["vectors"] as? [[String:Any]]),disk=CalendarMemory(),store=HealthOutbox(storage:disk)
        try store.setHuman(p.principal);try store.admitCalendar(proof:p);let ticket=try store.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent")
        let good=try MobileCalendarDelivery.item(input(vectors[0]));var badObject=try XCTUnwrap(JSONSerialization.jsonObject(with:input(vectors[3])) as? [String:Any]),change=try XCTUnwrap(badObject["change"] as? [String:Any]);change["unexpectedField"]="invalid";badObject["change"]=change
        let bad=try MobileCalendarDelivery.item(bytes(badObject));try store.commitCalendar(scope:scope(p),expectedCheckpoint:nil,nextCheckpoint:Data([1]),items:[good.data,bad.data],ticket:ticket)
        var response=try XCTUnwrap(JSONSerialization.jsonObject(with:receipt([good,bad])) as? [String:Any]),result=try XCTUnwrap(response["result"] as? [String:Any]),entries=try XCTUnwrap(result["receipts"] as? [[String:Any]])
        entries[1]["outcome"]="rejected";entries[1]["code"]="invalid";entries[1]["durability"]=NSNull();result["receipts"]=entries;response["result"]=result
        let before=try XCTUnwrap(disk.bytes);disk.fail=true;XCTAssertThrowsError(try store.settleCalendar(ticket:ticket,submitted:[good.data,bad.data],response:bytes(response)));XCTAssertEqual(disk.bytes,before);disk.fail=false
        try store.settleCalendar(ticket:ticket,submitted:[good.data,bad.data],response:bytes(response));XCTAssertEqual(try store.pendingCalendar(ticket:ticket),[])
        let saved=String(decoding:try XCTUnwrap(disk.bytes),as:UTF8.self);XCTAssertTrue(saved.contains(bad.data.base64EncodedString()));XCTAssertFalse(saved.contains(good.data.base64EncodedString()))
    }
    func testCheckpointScopeDistinguishesExactMappingUTF8()throws {
        let f=try fixture(),p=try proof(f),vectors=try XCTUnwrap(f["vectors"] as? [[String:Any]]),disk=CalendarMemory(),store=HealthOutbox(storage:disk)
        try store.setHuman(p.principal);try store.admitCalendar(proof:p);let ticket=try store.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent")
        func scan(_ mapping:String)throws->MobileCalendarDelivery.CheckpointScope {try .init(collector:p.collector,namespace:p.namespace,mappingVersion:mapping,coverage:.partial,start:"2026-10-01T00:00:00Z",end:"2026-11-01T00:00:00Z")}
        let composed=try scan("é"),decomposed=try scan("e\u{301}")
        try store.commitCalendar(scope:composed,expectedCheckpoint:nil,nextCheckpoint:Data([1]),items:[],ticket:ticket)
        XCTAssertNil(try store.calendarCheckpoint(scope:decomposed,ticket:ticket))
        var item=try XCTUnwrap(JSONSerialization.jsonObject(with:input(vectors[0])) as? [String:Any]),change=try XCTUnwrap(item["change"] as? [String:Any]);change["mappingVersion"]="e\u{301}";item["change"]=change
        let before=try XCTUnwrap(disk.bytes)
        XCTAssertThrowsError(try store.commitCalendar(scope:composed,expectedCheckpoint:Data([1]),nextCheckpoint:Data([2]),items:[bytes(item)],ticket:ticket))
        XCTAssertEqual(disk.bytes,before)
        try store.commitCalendar(scope:decomposed,expectedCheckpoint:nil,nextCheckpoint:Data([3]),items:[bytes(item)],ticket:ticket)
        XCTAssertEqual(try store.calendarCheckpoint(scope:composed,ticket:ticket),Data([1]));XCTAssertEqual(try store.calendarCheckpoint(scope:decomposed,ticket:ticket),Data([3]))
    }
    func testPolicyRevisionChangeQuarantinesOldCalendarBytes()throws {
        let f=try fixture(),p=try proof(f),vectors=try XCTUnwrap(f["vectors"] as? [[String:Any]]),disk=CalendarMemory(),store=HealthOutbox(storage:disk);try store.setHuman(p.principal);try store.admitCalendar(proof:p);let old=try store.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"),raw=try input(vectors[0]),item=try MobileCalendarDelivery.item(raw),scan=try scope(p)
        try store.commitCalendar(scope:scan,expectedCheckpoint:nil,nextCheckpoint:Data([1]),items:[raw],ticket:old)
        var policy=try XCTUnwrap(f["policy"] as? [String:Any]),result=try XCTUnwrap(policy["result"] as? [String:Any]),enrollment=try XCTUnwrap(result["enrollment"] as? [String:Any]),effective=try XCTUnwrap(result["effective"] as? [String:Any]);enrollment["revision"]=3;effective["policyRevision"]=3;result["enrollment"]=enrollment;result["effective"]=effective;policy["result"]=result
        let newer=try MobileCalendarPolicyParser.parse(bytes(policy),expectedPrincipal:p.principal,expectedEndpoint:p.endpoint,expectedEnrollment:p.enrollment);try store.confirmCalendarPolicy(proof:newer)
        XCTAssertThrowsError(try store.pendingCalendar(ticket:old));let current=try store.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent");XCTAssertEqual(try store.pendingCalendar(ticket:current),[])
        XCTAssertTrue(String(decoding:try XCTUnwrap(disk.bytes),as:UTF8.self).contains(item.data.base64EncodedString()))
    }
    func testDeleteAcknowledgementRequiresCommittedDeletedCode()throws {
        let f=try fixture(),p=try proof(f),vectors=try XCTUnwrap(f["vectors"] as? [[String:Any]]),disk=CalendarMemory(),store=HealthOutbox(storage:disk);try store.setHuman(p.principal);try store.admitCalendar(proof:p);let ticket=try store.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"),raw=try input(vectors[4]),item=try MobileCalendarDelivery.item(raw)
        try store.commitCalendar(scope:scope(p),expectedCheckpoint:nil,nextCheckpoint:Data([1]),items:[raw],ticket:ticket)
        XCTAssertThrowsError(try store.settleCalendar(ticket:ticket,submitted:[item.data],response:receipt([item],outcome:"accepted",code:"applied")));XCTAssertEqual(try store.pendingCalendar(ticket:ticket),[item.data])
        try store.settleCalendar(ticket:ticket,submitted:[item.data],response:receipt([item],outcome:"duplicate",code:"deleted"));XCTAssertEqual(try store.pendingCalendar(ticket:ticket),[])
    }
    func testSharedCapacityCountsBothDomains()throws {
        let f=try fixture(),p=try proof(f),vectors=try XCTUnwrap(f["vectors"] as? [[String:Any]]),disk=CalendarMemory(),store=HealthOutbox(storage:disk,maxEvents:1),health=UUID()
        try store.setHuman(p.principal);try store.enroll(health,human:p.principal,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:"health-source");let ht=try store.ticket(enrollment:health,type:"sleep")
        try store.admitCalendar(proof:p);let ct=try store.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"),raw=try input(vectors[0]);try store.commitCalendar(scope:scope(p),expectedCheckpoint:nil,nextCheckpoint:Data([1]),items:[raw],ticket:ct)
        let healthItem=HealthChange(upstreamId:"health",operation:.upsert,body:Data([1]),expectedPolicyRevision:1,mappingVersion:"v1")
        XCTAssertThrowsError(try store.commit(scope:"health",expectedAnchor:nil,nextAnchor:Data([1]),changes:[healthItem],ticket:ht)){XCTAssertEqual($0 as? HealthOutboxError,.capacity)}
        XCTAssertEqual(try store.pendingCalendar(ticket:ct).count,1);XCTAssertEqual(try store.pending(ticket:ht),[])
    }
    func testDeletionRetainedRetryRejectedAndAccountSwitch()throws {
        let f=try fixture(),scenario=try fixture("outbox-restart-delete.json"),p=try proof(f),vectors=try XCTUnwrap(f["vectors"] as? [[String:Any]]),disk=CalendarMemory(),store=HealthOutbox(storage:disk)
        XCTAssertEqual(scenario["syntheticOnly"] as? Bool,true);let name=try XCTUnwrap(scenario["deletionVector"] as? String),vector=try XCTUnwrap(vectors.first{$0["name"] as? String==name}),scan=try scope(p);XCTAssertNotNil(scenario["checkpointScope"] as? String)
        try store.setHuman(p.principal);try store.admitCalendar(proof:p);let ticket=try store.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent")
        let raw=try input(vector),item=try MobileCalendarDelivery.item(raw);XCTAssertEqual(item.operation,"delete");try store.commitCalendar(scope:scan,expectedCheckpoint:nil,nextCheckpoint:Data([1]),items:[raw],ticket:ticket)
        try store.commitCalendar(scope:scan,expectedCheckpoint:Data([1]),nextCheckpoint:Data([2]),items:[],ticket:ticket);XCTAssertEqual(try store.pendingCalendar(ticket:ticket),[item.data])
        let restarted=HealthOutbox(storage:disk);try restarted.setHuman(p.principal);try restarted.confirmCalendarPolicy(proof:p);let current=try restarted.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent")
        XCTAssertEqual(try restarted.pendingCalendar(ticket:current),[item.data]);XCTAssertEqual(try restarted.calendarCheckpoint(scope:scan,ticket:current),Data([2]))
        try restarted.settleCalendar(ticket:current,submitted:[item.data],response:receipt([item],outcome:"retryable",code:"unavailable",durability:NSNull()));XCTAssertEqual(try restarted.pendingCalendar(ticket:current),[item.data])
        try restarted.settleCalendar(ticket:current,submitted:[item.data],response:receipt([item],outcome:"rejected",code:"scope",durability:NSNull()));XCTAssertEqual(try restarted.pendingCalendar(ticket:current),[])
        let saved=try XCTUnwrap(disk.bytes);XCTAssertTrue(String(decoding:saved,as:UTF8.self).contains(item.data.base64EncodedString()))
        try restarted.setHuman(UUID());XCTAssertThrowsError(try restarted.pendingCalendar(ticket:current));try restarted.setHuman(p.principal);XCTAssertThrowsError(try restarted.confirmCalendarPolicy(proof:p))
    }
}
