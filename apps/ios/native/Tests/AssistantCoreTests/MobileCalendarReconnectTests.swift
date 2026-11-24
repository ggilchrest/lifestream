import Foundation
import CryptoKit
import XCTest
@testable import AssistantCore

private final class ReconnectDisk:HealthSnapshotStorage {
    var data:Data?,reads=0,writes=0,locked=false,replaceTrap=false
    func read()throws->Data?{reads+=1;if locked{throw CocoaError(.fileReadNoPermission)};return data}
    func replace(_ bytes:Data)throws{writes+=1;if replaceTrap{throw CocoaError(.fileWriteUnknown)};data=bytes}
}
private final class ReconnectShareAuthority:OutboxShareAuthority {
    private let lock=NSRecursiveLock()
    func withFence<T>(_ body:()throws->T)rethrows->T{lock.lock();defer{lock.unlock()};return try body()}
    func permits(_ context:OutboxShareContext,reading:Bool)->Bool{context.epoch==1}
}
final class MobileCalendarReconnectTests:XCTestCase {
    private var ios:URL{URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()}
    private func bytes(_ value:Any)throws->Data{try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes])}
    private func object(_ data:Data?)throws->[String:Any]{try XCTUnwrap(JSONSerialization.jsonObject(with:XCTUnwrap(data)) as? [String:Any])}
    private func fixture()throws->[String:Any]{try object(Data(contentsOf:ios.appendingPathComponent("test/mobile-calendar-fixtures/delivery-receipts.json")))}
    private func proof(revision:Int=2,categories:[String]=["CalendarEvent","Task"])throws->MobileCalendarPolicyProof {
        var v=try fixture()["policy"] as! [String:Any],result=v["result"] as! [String:Any],row=result["enrollment"] as! [String:Any],effective=result["effective"] as! [String:Any]
        row["revision"]=revision;effective["policyRevision"]=revision;effective["categories"]=categories;result["enrollment"]=row;result["effective"]=effective;v["result"]=result
        return try MobileCalendarPolicyParser.parse(bytes(v),expectedPrincipal:UUID(uuidString:row["principalId"] as! String)!,expectedEndpoint:UUID(uuidString:row["endpointId"] as! String)!,expectedEnrollment:UUID(uuidString:row["enrollmentId"] as! String)!)
    }
    @discardableResult private func seed(_ d:ReconnectDisk,owner:HealthOutbox?=nil)throws->HealthOutbox {
        let o=owner ?? HealthOutbox(storage:d),p=try proof();try o.admitCalendarExistingRemote(proof:p,selectedCategories:["CalendarEvent"])
        let f=try fixture(),vector=(f["vectors"] as! [[String:Any]])[0];var item=vector["item"] as! [String:Any],change=item["change"] as! [String:Any];change["expectedPolicyRevision"]=2;item["change"]=change
        let t=try o.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"),scope=try MobileCalendarDelivery.CheckpointScope(collector:p.collector,namespace:p.namespace,mappingVersion:"synthetic-calendar-mapping/1",coverage:.partial,start:"2026-10-01T00:00:00Z",end:"2026-11-01T00:00:00Z")
        try o.commitCalendar(scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([7]),items:[bytes(item)],ticket:t);return o
    }
    private func reconnect(_ o:HealthOutbox,_ p:MobileCalendarPolicyProof?=nil,expected:Set<String>=["CalendarEvent"])throws{try o.reconnectCalendarExistingLocal(proof:p ?? proof(),expectedCategories:expected)}
    private func unchanged(_ d:ReconnectDisk,_ action:()throws->Void)throws{
        let data=d.data,w=d.writes,r=d.reads;try action();XCTAssertEqual(d.data,data);XCTAssertEqual(d.writes,w);XCTAssertEqual(d.reads,r+1)
    }
    private func refuse(_ d:ReconnectDisk,_ o:HealthOutbox?=nil,_ p:MobileCalendarPolicyProof?=nil,expected:Set<String>=["CalendarEvent"])throws{
        let data=d.data,w=d.writes;XCTAssertThrowsError(try reconnect(o ?? HealthOutbox(storage:d),p,expected:expected));XCTAssertEqual(d.data,data);XCTAssertEqual(d.writes,w)
    }
    private func patch(_ d:ReconnectDisk,_ change:(inout [String:Any])->Void)throws{
        var v=try object(d.data),rows=v["calendarEnrollments"] as! [Any],row=rows[1] as! [String:Any];change(&row);rows[1]=row;v["calendarEnrollments"]=rows;d.data=try bytes(v)
    }
    private func share(_ o:HealthOutbox,_ p:MobileCalendarPolicyProof)throws->(any SharedCaptureReservation,Data,Data){
        let raw=try String(contentsOf:ios.appendingPathComponent("test/mobile-shared-item-fixtures/shared-item-pairs.json"),encoding:.utf8).replacingOccurrences(of:"\\ud800",with:"__UNPAIRED__")
        let pairs=try object(Data(raw.utf8))["pairs"] as! [[String:Any]]
        var item=pairs.first{$0["case"] as? String=="file-reference"}!["ios"] as! [String:Any],content=item["content"] as! [String:Any],artifact=content["artifact"] as! [String:Any]
        let payload=Data([1,2,3,255]);func hash(_ b:Data)->String{SHA256.hash(data:b).map{String(format:"%02x",$0)}.joined()}
        artifact["byteLength"]=payload.count;artifact["sha256"]=hash(payload);content["artifact"]=artifact;item["content"]=content
        let v=try MobileSharedItem.decode(bytes(item)),context=OutboxShareContext(owner:o,human:p.principal,endpoint:p.endpoint,namespace:v.source.namespace,collector:v.source.collector,epoch:1,recoveryOnly:false),attempt=OutboxShareAttempt(UUID(),context:context)
        guard case .reserved(let reservation,_)=try o.reserve(attempt:attempt,payloadDigest:hash(v.data),item:v,context:context) else{throw HealthOutboxError.disabled}
        return(reservation,v.data,payload)
    }
    func testPristineSavedRowZeroWrite()throws{let d=ReconnectDisk();try seed(d);let o=HealthOutbox(storage:d);d.replaceTrap=true;try unchanged(d){try reconnect(o)};let t=try o.calendarTicket(enrollment:proof().enrollment,category:"CalendarEvent");XCTAssertEqual(try o.pendingCalendar(ticket:t).count,1)}
    func testSameHumanHealthAuthority()throws{let d=ReconnectDisk(),o=try seed(d),p=try proof(),id=UUID();try o.enroll(id,human:p.principal,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:"synthetic-health");let t=try o.ticket(enrollment:id,type:"sleep");try unchanged(d){try reconnect(o)};XCTAssertNoThrow(try o.verify(ticket:t))}
    func testSameHumanShareAuthority()throws{let d=ReconnectDisk(),authority=ReconnectShareAuthority(),o=HealthOutbox(storage:d,shareAuthority:authority),p=try proof();try seed(d,owner:o);let(reservation,item,payload)=try share(o,p);try unchanged(d){try reconnect(o)};XCTAssertNoThrow(try o.check(reservation));let w=d.writes;guard case .acknowledged=try o.commit(reservation,itemJSON:item,capturedBytes:payload,integrity:[:]) else{return XCTFail("actual original Share reservation must remain usable")};XCTAssertEqual(d.writes,w+1)}
    func testTargetProofRefresh()throws{let d=ReconnectDisk(),o=try seed(d),p=try proof(),old=try o.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent");try unchanged(d){try reconnect(o)};XCTAssertThrowsError(try o.pendingCalendar(ticket:old));XCTAssertEqual(try o.pendingCalendar(ticket:o.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent")).count,1)}
    func testMissingLastHuman()throws{let d=ReconnectDisk();try seed(d);var v=try object(d.data);v.removeValue(forKey:"lastHuman");d.data=try bytes(v);try refuse(d)}
    func testDifferentLastHuman()throws{let d=ReconnectDisk();try seed(d);var v=try object(d.data);v["lastHuman"]=UUID().uuidString;d.data=try bytes(v);try refuse(d)}
    func testMissingCalendarRow()throws{let d=ReconnectDisk();try seed(d);var v=try object(d.data);v["calendarEnrollments"]=[];d.data=try bytes(v);try refuse(d)}
    func testHealthIdConflict()throws{let d=ReconnectDisk(),o=try seed(d),p=try proof();try o.enroll(p.enrollment,human:p.principal,enabledTypes:["sleep"],confirmedPolicyRevision:1,confirmedSourceNamespace:"synthetic-health");try refuse(d)}
    func testSavedBindingMismatch()throws{for key in ["human","endpoint","namespace","collector"]{let d=ReconnectDisk();try seed(d);try patch(d){$0[key]=key=="collector" ? "event\u{212A}it":UUID().uuidString};try refuse(d)}}
    func testSavedSelectionMismatch()throws{for categories in [[],["Task"],["CalendarEvent","Task"],["CalendarEvent","Tas\u{212A}"]]{let d=ReconnectDisk();try seed(d);try patch(d){$0["categories"]=categories};try refuse(d)};let d=ReconnectDisk();try seed(d);try refuse(d,expected:[])}
    func testFreshProofNarrowing()throws{let d=ReconnectDisk();try seed(d);try refuse(d,nil,proof(categories:["Task"]))}
    func testPolicyRevisionAdvance()throws{let d=ReconnectDisk();try seed(d);try refuse(d,nil,proof(revision:3))}
    func testPolicyRevisionRegress()throws{let d=ReconnectDisk();try seed(d);try refuse(d,nil,proof(revision:1))}
    func testSavedPaused()throws{let d=ReconnectDisk();try seed(d);try patch(d){$0["paused"]=true};try refuse(d)}
    func testSavedRebind()throws{let d=ReconnectDisk();try seed(d);try patch(d){$0["requiresRebind"]=true};try refuse(d)}
    func testWithdrawnContext()throws{let d=ReconnectDisk(),o=try seed(d);try o.setHuman(nil);try refuse(d,o)}
    func testFailedContext()throws{let d=ReconnectDisk();try seed(d);let o=HealthOutbox(storage:d);d.locked=true;XCTAssertThrowsError(try o.setHuman(proof().principal));d.locked=false;try refuse(d,o)}
    func testLockedCorruptOversized()throws{for kind in ["locked","corrupt","oversized"]{let d=ReconnectDisk();try seed(d);if kind=="locked"{d.locked=true}else{d.data=kind=="corrupt" ? Data([0]):Data(repeating:0,count:8*1024*1024+1)};try refuse(d)}}
    func testV2V3BytePreservation()throws{for version in [2,3]{let d=ReconnectDisk(),authority=ReconnectShareAuthority(),o=HealthOutbox(storage:d,shareAuthority:authority);try seed(d,owner:o);if version==3{let(reservation,item,payload)=try share(o,proof());guard case .acknowledged=try o.commit(reservation,itemJSON:item,capturedBytes:payload,integrity:[:]) else{return XCTFail("seed actual v3 Share")}};let current=HealthOutbox(storage:d);try unchanged(d){try reconnect(current)};XCTAssertEqual(try object(d.data)["version"] as? Int,version)}}
    func testTargetFenceOnDenial()throws{let d=ReconnectDisk(),o=try seed(d),p=try proof(),t=try o.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent");o.invalidateCalendarPolicy(enrollment:p.enrollment);try refuse(d,o,proof(revision:3));XCTAssertThrowsError(try o.pendingCalendar(ticket:t));XCTAssertThrowsError(try o.calendarTicket(enrollment:p.enrollment,category:"CalendarEvent"))}
}
