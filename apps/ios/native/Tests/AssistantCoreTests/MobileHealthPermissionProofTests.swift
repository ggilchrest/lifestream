import Foundation
import CryptoKit
import XCTest
@testable import AssistantCore

private final class PermissionProofDisk:HealthSnapshotStorage {
    var data:Data?,reads=0,writes=0,locked=false,failWrite=false
    func read()throws->Data?{reads+=1;if locked{throw CocoaError(.fileReadNoPermission)};return data}
    func replace(_ bytes:Data)throws{writes+=1;if failWrite{throw CocoaError(.fileWriteUnknown)};data=bytes}
}
private final class PermissionShareAuthority:OutboxShareAuthority {
    func withFence<T>(_ body:()throws->T)rethrows->T{try body()}
    func permits(_ context:OutboxShareContext,reading:Bool)->Bool{context.epoch==1}
}
final class MobileHealthPermissionProofTests:XCTestCase {
    private let human=UUID(uuidString:"50000000-0000-4000-8000-000000000001")!,endpoint=UUID(uuidString:"60000000-0000-4000-8000-000000000001")!,enrollment=UUID(uuidString:"00000000-0000-4000-8000-000000000002")!
    private let namespace="00000000-0000-4000-8000-000000000004"
    private var ios:URL{URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()}
    private func bytes(_ value:Any)throws->Data{try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes])}
    private func object(_ data:Data)throws->[String:Any]{try XCTUnwrap(JSONSerialization.jsonObject(with:data) as? [String:Any])}
    private func proof(revision:Int=1,owner:UUID?=nil,id:UUID?=nil,source:String?=nil,allowed:Bool=true,categories:[String]=["SleepSegment","heartRate"])throws->MobileHealthPolicyProof {
        let h=owner ?? human,e=id ?? enrollment,ns=source ?? namespace
        let config:[String:Any]=["categories":["SleepSegment","heartRate"],"uses":["answers"],"assistantIds":[],"collectionPaused":false,"usePaused":false]
        let value:[String:Any]=["schemaVersion":"1.0.0","producerPin":["schemaId":MobileHealthEncoder.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthEncoder.schemaSHA256],"result":["enrollment":["enrollmentId":e.uuidString.lowercased(),"principalId":h.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":ns,"revision":revision,"state":"active","configuration":config],"effective":["policyRevision":revision,"sourceBound":true,"collectionAllowed":allowed,"categories":categories,"uses":["answers"],"assistantIds":[],"sourceNamespace":ns]]]
        return try MobileHealthPolicyParser.parse(bytes(value),expectedPrincipal:h,expectedEndpoint:endpoint,expectedEnrollment:e)
    }
    @discardableResult private func seed(_ disk:PermissionProofDisk,revision:Int=1,owner:HealthOutbox?=nil)throws->HealthOutbox {
        let box=owner ?? HealthOutbox(storage:disk);try box.setHuman(human);try box.enroll(proof:proof(revision:revision),selectedTypes:["sleep"])
        let t=try box.ticket(enrollment:enrollment,type:"sleep")
        try box.commit(scope:"original-plan",expectedAnchor:nil,nextAnchor:Data([1]),changes:[HealthChange(upstreamId:"synthetic",operation:.upsert,body:Data("synthetic".utf8),expectedPolicyRevision:revision,mappingVersion:"synthetic/1")],ticket:t)
        return box
    }
    private func refuse(_ disk:PermissionProofDisk,_ box:HealthOutbox,_ proof:MobileHealthPolicyProof?=nil,types:Set<String>=["sleep"])throws{
        let before=disk.data,writes=disk.writes
        XCTAssertThrowsError(try box.confirmUnchangedEffectivePolicy(proof:proof ?? self.proof(),expectedTypes:types))
        XCTAssertEqual(disk.data,before);XCTAssertEqual(disk.writes,writes)
    }
    func testExactProofFreshTicketsNoWrites()throws{
        let d=PermissionProofDisk(),o=try seed(d),old=try o.ticket(enrollment:enrollment,type:"sleep"),before=d.data,w=d.writes
        o.invalidatePolicy(enrollment:enrollment);d.failWrite=true;let reads=d.reads
        try o.confirmUnchangedEffectivePolicy(proof:proof(),expectedTypes:["sleep"])
        XCTAssertEqual(d.reads,reads+1);XCTAssertEqual(d.data,before);XCTAssertEqual(d.writes,w)
        XCTAssertThrowsError(try o.verify(ticket:old));let current=try o.ticket(enrollment:enrollment,type:"sleep")
        XCTAssertEqual(try o.pending(ticket:current).count,1);XCTAssertEqual(try o.anchor(for:"original-plan",ticket:current),Data([1]))
    }
    func testNoCurrentContextCannotAdoptSavedHuman()throws{let d=PermissionProofDisk();try seed(d);try refuse(d,HealthOutbox(storage:d))}
    func testWithdrawnContext()throws{let d=PermissionProofDisk(),o=try seed(d);try o.setHuman(nil);try refuse(d,o)}
    func testFailedContext()throws{let d=PermissionProofDisk();try seed(d);let o=HealthOutbox(storage:d);d.locked=true;XCTAssertThrowsError(try o.setHuman(human));d.locked=false;try refuse(d,o)}
    func testWrongHuman()throws{let d=PermissionProofDisk(),o=try seed(d);try refuse(d,o,proof(owner:UUID()))}
    func testMissingRow()throws{let d=PermissionProofDisk(),o=HealthOutbox(storage:d);try o.setHuman(human);try refuse(d,o)}
    func testWrongEnrollmentAndSource()throws{for other in [false,true]{let d=PermissionProofDisk(),o=try seed(d);try refuse(d,o,other ? proof(source:UUID().uuidString.lowercased()):proof(id:UUID()))}}
    func testCollectionDenied()throws{let d=PermissionProofDisk(),o=try seed(d);try refuse(d,o,proof(allowed:false))}
    func testRevisionAdvance()throws{let d=PermissionProofDisk(),o=try seed(d);try refuse(d,o,proof(revision:2))}
    func testRevisionRegress()throws{let d=PermissionProofDisk(),o=try seed(d,revision:2);try refuse(d,o,proof(revision:1))}
    func testSavedPause()throws{let d=PermissionProofDisk(),o=try seed(d);try o.pause(enrollment:enrollment);try refuse(d,o)}
    func testRebindRequired()throws{let d=PermissionProofDisk(),o=try seed(d);try o.setHuman(UUID());try o.setHuman(human);try refuse(d,o)}
    func testPendingPauseCannotBeRearmed()throws{let d=PermissionProofDisk(),o=try seed(d);d.failWrite=true;XCTAssertThrowsError(try o.pause(enrollment:enrollment));d.failWrite=false;try refuse(d,o);XCTAssertThrowsError(try o.ticket(enrollment:enrollment,type:"sleep"))}
    func testPendingNarrowingCannotBeRearmed()throws{let d=PermissionProofDisk(),o=try seed(d);d.failWrite=true;XCTAssertThrowsError(try o.narrow(enrollment:enrollment,types:[]));d.failWrite=false;try refuse(d,o);XCTAssertThrowsError(try o.ticket(enrollment:enrollment,type:"sleep"))}
    func testEmptyAndUnsupportedExpectedTypes()throws{for types:Set<String> in [[],["hrvRMSSD"]]{let d=PermissionProofDisk(),o=try seed(d);try refuse(d,o,types:types)}}
    func testExpectedTypesMustEqualSavedSelection()throws{for types:Set<String> in [["heartRate"],["sleep","heartRate"]]{let d=PermissionProofDisk(),o=try seed(d);try refuse(d,o,types:types)}}
    func testNarrowerFreshProof()throws{let d=PermissionProofDisk(),o=try seed(d);try refuse(d,o,proof(categories:["heartRate"]))}
    func testUnavailableOriginalSnapshot()throws{for kind in ["locked","corrupt","oversized"]{let d=PermissionProofDisk(),o=try seed(d);if kind=="locked"{d.locked=true}else{d.data=kind=="corrupt" ? Data([0]):Data(repeating:0,count:8*1024*1024+1)};try refuse(d,o)}}
    func testHealthGenerationFenceIsGlobal()throws{let d=PermissionProofDisk(),o=try seed(d),other=UUID();try o.enroll(other,human:human,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:"another-source");let old=try o.ticket(enrollment:other,type:"sleep");try o.confirmUnchangedEffectivePolicy(proof:proof(),expectedTypes:["sleep"]);XCTAssertThrowsError(try o.verify(ticket:old));XCTAssertNoThrow(try o.ticket(enrollment:other,type:"sleep"))}
    func testCalendarShareAndPersistentBytesPreserved()throws{
        let d=PermissionProofDisk(),o=HealthOutbox(storage:d,shareAuthority:PermissionShareAuthority());try seed(d,owner:o)
        let calendar=try object(Data(contentsOf:ios.appendingPathComponent("test/mobile-calendar-fixtures/delivery-receipts.json")))["policy"] as! [String:Any]
        let row=(calendar["result"] as! [String:Any])["enrollment"] as! [String:Any]
        let p=try MobileCalendarPolicyParser.parse(bytes(calendar),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:UUID(uuidString:row["enrollmentId"] as! String)!)
        try o.admitCalendar(proof:p);let ticket=try o.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent")
        let raw=try String(contentsOf:ios.appendingPathComponent("test/mobile-shared-item-fixtures/shared-item-pairs.json"),encoding:.utf8).replacingOccurrences(of:"\\ud800",with:"__UNPAIRED__")
        let pairs=try object(Data(raw.utf8))["pairs"] as! [[String:Any]],item=pairs.first{$0["case"] as? String=="file-reference"}!["ios"] as! [String:Any]
        let shared=try MobileSharedItem.decode(bytes(item)),context=OutboxShareContext(owner:o,human:human,endpoint:endpoint,namespace:shared.source.namespace,collector:shared.source.collector,epoch:1,recoveryOnly:false),attempt=OutboxShareAttempt(UUID(),context:context)
        let digest=SHA256.hash(data:shared.data).map{String(format:"%02x",$0)}.joined()
        guard case .reserved(let reservation,_)=try o.reserve(attempt:attempt,payloadDigest:digest,item:shared,context:context) else{return XCTFail("actual original Share reservation")}
        let before=d.data,w=d.writes;try o.confirmUnchangedEffectivePolicy(proof:proof(),expectedTypes:["sleep"])
        XCTAssertEqual(d.data,before);XCTAssertEqual(d.writes,w);XCTAssertNoThrow(try o.pendingCalendar(ticket:ticket));XCTAssertNoThrow(try o.check(reservation))
    }
}
