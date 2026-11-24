import Foundation
import CryptoKit
import XCTest
@testable import AssistantCore

private final class AdmissionDisk:HealthSnapshotStorage {
    var data:Data?,reads=0,writes=0,locked=false,fail=false,writeThenThrow=false
    func read()throws->Data?{reads+=1;if locked{throw CocoaError(.fileReadNoPermission)};return data}
    func replace(_ bytes:Data)throws{writes+=1;if fail{throw CocoaError(.fileWriteNoPermission)};data=bytes;if writeThenThrow{throw CocoaError(.fileWriteUnknown)}}
}
final class MobileCalendarAdmissionTests:XCTestCase {
    private var ios:URL{URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()}
    private func data(_ value:Any)throws->Data{try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes])}
    private func object(_ data:Data?)throws->[String:Any]{try XCTUnwrap(JSONSerialization.jsonObject(with:XCTUnwrap(data)) as? [String:Any])}
    private func proof(_ enrollment:UUID?=nil)throws->MobileCalendarPolicyProof {
        var f=try object(Data(contentsOf:ios.appendingPathComponent("test/mobile-calendar-fixtures/delivery-receipts.json")))["policy"] as! [String:Any]
        var result=f["result"] as! [String:Any],row=result["enrollment"] as! [String:Any]
        let id=enrollment ?? UUID(uuidString:row["enrollmentId"] as! String)!
        row["enrollmentId"]=id.uuidString.lowercased();result["enrollment"]=row;f["result"]=result
        return try MobileCalendarPolicyParser.parse(data(f),expectedPrincipal:UUID(uuidString:row["principalId"] as! String)!,expectedEndpoint:UUID(uuidString:row["endpointId"] as! String)!,expectedEnrollment:id)
    }
    private func admit(_ o:HealthOutbox,_ p:MobileCalendarPolicyProof)throws{try o.admitCalendarExistingRemote(proof:p,selectedCategories:["CalendarEvent"])}
    private func addHealth(_ o:HealthOutbox,_ p:MobileCalendarPolicyProof,id:UUID=UUID())throws->HealthCollectionTicket {
        try o.setHuman(p.principal);try o.enroll(id,human:p.principal,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:"synthetic-health")
        let t=try o.ticket(enrollment:id,type:"sleep")
        try o.commit(scope:"scope",expectedAnchor:nil,nextAnchor:Data([1]),changes:[HealthChange(upstreamId:"synthetic",operation:.delete,body:nil,expectedPolicyRevision:1,mappingVersion:"v1")],ticket:t)
        return t
    }
    func testFirstEmptySnapshotOneWrite()throws{
        let d=AdmissionDisk(),o=HealthOutbox(storage:d),p=try proof();try admit(o,p)
        XCTAssertEqual(d.reads,1);XCTAssertEqual(d.writes,1);XCTAssertEqual(try object(d.data)["lastHuman"] as? String,p.principal.uuidString)
        XCTAssertNoThrow(try o.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"))
    }
    func testExistingV1HealthPreserved()throws{
        let d=AdmissionDisk(),o=HealthOutbox(storage:d),p=try proof(),t=try addHealth(o,p),before=try o.pending(ticket:t),w=d.writes
        try admit(o,p);XCTAssertEqual(d.writes,w+1);XCTAssertEqual(try o.pending(ticket:t),before);XCTAssertEqual(try o.anchor(for:"scope",ticket:t),Data([1]));XCTAssertEqual(try object(d.data)["version"] as? Int,2)
    }
    func testExistingV2CalendarPreserved()throws{
        let d=AdmissionDisk(),o=HealthOutbox(storage:d),p=try proof(),first=try proof(UUID());try o.setHuman(p.principal);try o.admitCalendar(proof:first)
        let old=try o.calendarTicket(enrollment:first.enrollment,category:"Task"),before=try object(d.data),w=d.writes
        try admit(o,p);XCTAssertEqual(d.writes,w+1);XCTAssertEqual(try o.pendingCalendar(ticket:old),[])
        let after=try object(d.data);XCTAssertEqual((before["calendarEnrollments"] as! [Any]).count+2,(after["calendarEnrollments"] as! [Any]).count)
    }
    func testExistingV3SharePreserved()throws{
        let d=AdmissionDisk(),p=try proof();let seed=HealthOutbox(storage:d);try seed.setHuman(p.principal)
        let raw=try String(contentsOf:ios.appendingPathComponent("test/mobile-shared-item-fixtures/shared-item-pairs.json"),encoding:.utf8).replacingOccurrences(of:"\\ud800",with:"__UNPAIRED__")
        let pairs=try object(Data(raw.utf8))["pairs"] as! [[String:Any]]
        var item=pairs.first{$0["case"] as? String=="file-reference"}!["ios"] as! [String:Any],content=item["content"] as! [String:Any],artifact=content["artifact"] as! [String:Any]
        let payload=Data([1,2,3]);func hash(_ b:Data)->String{SHA256.hash(data:b).map{String(format:"%02x",$0)}.joined()}
        artifact["byteLength"]=payload.count;artifact["sha256"]=hash(payload);content["artifact"]=artifact;item["content"]=content
        let value=try MobileSharedItem.decode(data(item)),attempt=UUID(),receipt=UUID()
        let key=hash(try JSONEncoder().encode([p.principal.uuidString.lowercased(),p.endpoint.uuidString.lowercased(),value.source.namespace.uuidString.lowercased(),value.source.collector,attempt.uuidString.lowercased()]))
        var state=try object(d.data);state["version"]=3;state["calendarEnrollments"]=[]
        let shares=[key:["human":p.principal.uuidString,"endpoint":p.endpoint.uuidString,"namespace":value.source.namespace.uuidString,"collector":value.source.collector,"epoch":1,"attempt":attempt.uuidString,"receipt":receipt.uuidString,"item":value.data.base64EncodedString(),"digest":hash(value.data),"bytes":payload.base64EncodedString(),"contentDigest":hash(payload),"length":payload.count] as [String:Any]]
        state["shareAssociations"]=shares;d.data=try data(state);let o=HealthOutbox(storage:d),w=d.writes
        try admit(o,p);XCTAssertEqual(d.writes,w+1);XCTAssertEqual(try data(object(d.data)["shareAssociations"]!),try data(shares));XCTAssertEqual(try object(d.data)["version"] as? Int,3)
    }
    func testSelectedSubsetExact()throws{let d=AdmissionDisk(),o=HealthOutbox(storage:d),p=try proof();try admit(o,p);XCTAssertNoThrow(try o.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"));XCTAssertThrowsError(try o.calendarTicket(enrollment:p.enrollment,category:"Task"));try o.confirmCalendarPolicy(proof:p);XCTAssertThrowsError(try o.calendarTicket(enrollment:p.enrollment,category:"Task"))}
    func testEmptySubsetDenied()throws{let d=AdmissionDisk(),o=HealthOutbox(storage:d);XCTAssertThrowsError(try o.admitCalendarExistingRemote(proof:proof(),selectedCategories:[]));XCTAssertEqual(d.writes,0);XCTAssertNil(d.data)}
    func testOutOfProofDenied()throws{let d=AdmissionDisk(),o=HealthOutbox(storage:d);XCTAssertThrowsError(try o.admitCalendarExistingRemote(proof:proof(),selectedCategories:["sleep"]));XCTAssertEqual(d.writes,0)}
    func testExistingHealthIdRefused()throws{let d=AdmissionDisk(),o=HealthOutbox(storage:d),p=try proof();_ = try addHealth(o,p,id:p.enrollment);let before=d.data,w=d.writes;XCTAssertThrowsError(try admit(o,p));XCTAssertEqual(d.data,before);XCTAssertEqual(d.writes,w)}
    func testExistingCalendarIdRefused()throws{let d=AdmissionDisk(),o=HealthOutbox(storage:d),p=try proof();try o.setHuman(p.principal);try o.admitCalendar(proof:p);let before=d.data,w=d.writes;XCTAssertThrowsError(try admit(o,p));XCTAssertEqual(d.data,before);XCTAssertEqual(d.writes,w);XCTAssertNoThrow(try o.calendarTicket(enrollment:p.enrollment,category:"Task"))}
    func testSavedOtherHumanRefused()throws{let d=AdmissionDisk(),seed=HealthOutbox(storage:d);try seed.setHuman(UUID());let before=d.data,w=d.writes;XCTAssertThrowsError(try admit(HealthOutbox(storage:d),proof()));XCTAssertEqual(d.data,before);XCTAssertEqual(d.writes,w)}
    func testInMemoryOtherHumanRefused()throws{let d=AdmissionDisk(),o=HealthOutbox(storage:d);try o.setHuman(UUID());let before=d.data,w=d.writes;XCTAssertThrowsError(try admit(o,proof()));XCTAssertEqual(d.data,before);XCTAssertEqual(d.writes,w)}
    func testCapacityNoPartialWrite()throws{let d=AdmissionDisk(),o=HealthOutbox(storage:d,maxBytes:10);XCTAssertThrowsError(try admit(o,proof()));XCTAssertEqual(d.writes,0);XCTAssertNil(d.data)}
    func testWriteThrowNoGrant()throws{for writesThenThrows in [false,true]{let d=AdmissionDisk(),o=HealthOutbox(storage:d),p=try proof();d.fail = !writesThenThrows;d.writeThenThrow=writesThenThrows;XCTAssertThrowsError(try admit(o,p));XCTAssertEqual(d.writes,1);XCTAssertThrowsError(try o.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"))}}
    func testSameHumanHealthTicketsPreserved()throws{let d=AdmissionDisk(),o=HealthOutbox(storage:d),p=try proof(),t=try addHealth(o,p);try admit(o,p);XCTAssertNoThrow(try o.verify(ticket:t));XCTAssertEqual(try o.pending(ticket:t).count,1)}
    func testWithdrawnContextRefused()throws{let d=AdmissionDisk(),o=HealthOutbox(storage:d);try o.setHuman(nil);XCTAssertThrowsError(try admit(o,proof()));XCTAssertEqual(d.reads,0);XCTAssertEqual(d.writes,0)}
    func testSameHumanUnavailableRefused()throws{let d=AdmissionDisk(),o=HealthOutbox(storage:d),p=try proof();d.locked=true;XCTAssertThrowsError(try o.setHuman(p.principal));d.locked=false;XCTAssertThrowsError(try admit(o,p));XCTAssertEqual(d.writes,0)}
}
