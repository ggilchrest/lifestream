import Foundation
import XCTest
import CryptoKit
@testable import AssistantCore

private final class SavedHealthDisk:HealthSnapshotStorage {
    var data:Data?,writes=0,failBefore=false,failAfter=false
    func read()throws->Data?{data}
    func replace(_ bytes:Data)throws{if failBefore{throw CocoaError(.fileWriteUnknown)};data=bytes;writes+=1;if failAfter{throw CocoaError(.fileWriteUnknown)}}
}
private final class SavedShareAuthority:OutboxShareAuthority{
    func withFence<T>(_ body:()throws->T)rethrows->T{try body()}
    func permits(_ context:OutboxShareContext,reading:Bool)->Bool{true}
}
private final class SavedShareLease:SharedCaptureReadLease{
    let originalSelectionContext:any SharedCaptureBinding;var chunks:[Data?]
    init(_ context:OutboxShareContext,_ bytes:Data){originalSelectionContext=context;chunks=[bytes,nil]}
    func check()throws{}
    func read(maxBytes:Int)throws->Data?{chunks.removeFirst()}
    func close(){}
}
final class HealthSavedSelectionTests:XCTestCase {
    private let human=UUID(),endpoint=UUID(),enrollment=UUID(),namespace=UUID(),origin="https://offline.invalid"
    private func bytes(_ value:Any)throws->Data{try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys])}
    private func raw(_ disk:SavedHealthDisk)throws->[String:Any]{try XCTUnwrap(JSONSerialization.jsonObject(with:XCTUnwrap(disk.data)) as? [String:Any])}
    private func proof(revision:Int=1,allowed:Bool=true)throws->MobileHealthPolicyProof{
        let value:[String:Any]=["schemaVersion":"1.0.0","producerPin":["schemaId":MobileHealthEncoder.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthEncoder.schemaSHA256],"result":["enrollment":["enrollmentId":enrollment.uuidString.lowercased(),"principalId":human.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":namespace.uuidString.lowercased(),"revision":revision,"state":"active","configuration":["categories":["SleepSegment"],"uses":[],"assistantIds":[],"collectionPaused":false,"usePaused":true]],"effective":["policyRevision":revision,"sourceBound":true,"collectionAllowed":allowed,"categories":["SleepSegment"],"uses":[],"assistantIds":[],"sourceNamespace":namespace.uuidString.lowercased()]]]
        return try MobileHealthPolicyParser.parse(bytes(value),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:enrollment)
    }
    private func selection(enabled:Bool=true)throws->HealthOutbox.SavedHealthSelection{
        let plan=try HealthOutbox.SavedHealthPlan(category:"sleep",scope:"exact original scope",mappingVersion:"healthkit/1",start:Date(timeIntervalSince1970:0.125),end:Date(timeIntervalSince1970:3600.125))
        return try .init(origin:origin,human:human,endpoint:endpoint,enrollment:enrollment,namespace:namespace,policyRevision:1,plans:[plan],updatesEnabled:enabled)
    }
    private func seed(_ disk:SavedHealthDisk)throws->HealthOutbox{
        let box=HealthOutbox(storage:disk);try box.setHuman(human);try box.enroll(proof:proof(),selectedTypes:["sleep"])
        let ticket=try box.ticket(enrollment:enrollment,type:"sleep")
        try box.commit(scope:"existing-anchor",expectedAnchor:nil,nextAnchor:Data([1]),changes:[.init(upstreamId:"opaque-existing",operation:.upsert,body:Data("synthetic".utf8),expectedPolicyRevision:1,mappingVersion:"healthkit/1")],ticket:ticket)
        return box
    }
    func testAbsentLegacyLookupDoesNotMigrateAdoptOrWrite()throws{
        let disk=SavedHealthDisk(),box=try seed(disk),before=disk.data,count=disk.writes
        XCTAssertEqual(try box.savedHealthSelections(origin:origin,human:human,endpoint:endpoint),[])
        XCTAssertEqual(disk.data,before);XCTAssertEqual(disk.writes,count);XCTAssertEqual(try raw(disk)["version"] as? Int,1)
    }
    func testExplicitSaveMovesOnlyEnvelopeAndChoicePreservingQueueAnchorAndTicket()throws{
        let disk=SavedHealthDisk(),box=try seed(disk),ticket=try box.ticket(enrollment:enrollment,type:"sleep"),queue=try box.pending(ticket:ticket),choice=try selection(),before=try raw(disk)
        try box.saveHealthSelection(choice,expected:nil,proof:proof())
        let after=try raw(disk);XCTAssertEqual(after["version"] as? Int,5)
        XCTAssertEqual(try bytes(before["enrollments"]!),try bytes(after["enrollments"]!))
        XCTAssertEqual(try box.pending(ticket:ticket),queue);XCTAssertEqual(try box.anchor(for:"existing-anchor",ticket:ticket),Data([1]))
        XCTAssertEqual(try box.savedHealthSelections(origin:origin,human:human,endpoint:endpoint),[choice]);XCTAssertNoThrow(try box.checkHealthSavedRecovery(choice))
        let restored=HealthOutbox(storage:disk),saved=disk.data,writes=disk.writes
        XCTAssertThrowsError(try restored.checkHealthSavedRecovery(choice))
        try restored.setHuman(human);XCTAssertThrowsError(try restored.checkHealthSavedRecovery(choice));try restored.confirmUnchangedEffectivePolicy(proof:proof(),expectedTypes:["sleep"])
        XCTAssertNoThrow(try restored.checkHealthSavedRecovery(choice));XCTAssertEqual(disk.data,saved);XCTAssertEqual(disk.writes,writes)
    }
    func testDurableDisablePreservesIndependentManualTicketAndNeverDowngrades()throws{
        let disk=SavedHealthDisk(),box=try seed(disk),choice=try selection();try box.saveHealthSelection(choice,expected:nil,proof:proof());let ticket=try box.ticket(enrollment:enrollment,type:"sleep")
        let disabled=try box.protectHealthSelection(expected:choice,disable:true,requireRebind:false)
        XCTAssertFalse(disabled.updatesEnabled);XCTAssertEqual(try raw(disk)["version"] as? Int,5);XCTAssertEqual(try box.pending(ticket:ticket).count,1)
        XCTAssertThrowsError(try box.checkHealthSavedRecovery(disabled));XCTAssertThrowsError(try box.protectHealthSelection(expected:choice,disable:true,requireRebind:false))
        let restored=HealthOutbox(storage:disk);XCTAssertEqual(try restored.savedHealthSelections(origin:origin,human:human,endpoint:endpoint),[disabled])
    }
    func testDurableActualHumanMarkerFencesRowsAndReturnToOriginalHuman()throws{
        let disk=SavedHealthDisk(),box=try seed(disk),choice=try selection();try box.saveHealthSelection(choice,expected:nil,proof:proof());let old=try box.ticket(enrollment:enrollment,type:"sleep")
        let marked=try box.protectHealthSelection(expected:choice,disable:false,requireRebind:true)
        XCTAssertTrue(marked.requiresRebind);XCTAssertThrowsError(try box.verify(ticket:old));XCTAssertThrowsError(try box.checkHealthSavedRecovery(marked))
        let restarted=HealthOutbox(storage:disk);try restarted.setHuman(human)
        XCTAssertThrowsError(try restarted.confirmUnchangedEffectivePolicy(proof:proof(),expectedTypes:["sleep"]))
        XCTAssertEqual(try restarted.savedHealthSelections(origin:origin,human:human,endpoint:endpoint),[marked])
    }
    func testActualSubjectAdoptionMarksRememberedChoiceAndPreservesOtherSubjectLookupPrivacy()throws{
        let disk=SavedHealthDisk(),box=try seed(disk),choice=try selection();try box.saveHealthSelection(choice,expected:nil,proof:proof());let other=UUID()
        try box.setHuman(other);XCTAssertEqual(try box.savedHealthSelections(origin:origin,human:other,endpoint:endpoint),[])
        try box.setHuman(human);XCTAssertTrue(try XCTUnwrap(box.savedHealthSelections(origin:origin,human:human,endpoint:endpoint).first).requiresRebind)
        XCTAssertThrowsError(try box.confirmUnchangedEffectivePolicy(proof:proof(),expectedTypes:["sleep"]))
    }
    func testSavedLookupNoAbsentWriteAndKnownTransientSubjectChangePersistsBarrier()throws{
        let empty=SavedHealthDisk(),inert=HealthOutbox(storage:empty)
        try inert.adoptSavedHealthLookup(human:human,requireSourceRebind:true)
        XCTAssertNil(empty.data);XCTAssertEqual(empty.writes,0)
        let disk=SavedHealthDisk(),box=try seed(disk),choice=try selection();try box.saveHealthSelection(choice,expected:nil,proof:proof())
        let count=disk.writes,before=disk.data
        let fresh=HealthOutbox(storage:disk);try fresh.adoptSavedHealthLookup(human:human,requireSourceRebind:false)
        XCTAssertEqual(disk.writes,count);XCTAssertEqual(disk.data,before)
        try fresh.confirmUnchangedEffectivePolicy(proof:proof(),expectedTypes:["sleep"]);XCTAssertNoThrow(try fresh.checkHealthSavedRecovery(choice))
        // The Source observed A→B→A in this process. The final Human alone does
        // not erase that known transition, even though the disk still says A.
        try fresh.adoptSavedHealthLookup(human:human,requireSourceRebind:true)
        XCTAssertEqual(disk.writes,count+1);XCTAssertTrue(try XCTUnwrap(fresh.savedHealthSelections(origin:origin,human:human,endpoint:endpoint).first).requiresRebind)
        XCTAssertThrowsError(try fresh.confirmUnchangedEffectivePolicy(proof:proof(),expectedTypes:["sleep"]))
    }
    func testDisabledChoiceAllowsOnlyExplicitManualRecoveryAfterFreshPolicy()throws{
        let disk=SavedHealthDisk(),box=try seed(disk),choice=try selection();try box.saveHealthSelection(choice,expected:nil,proof:proof())
        let disabled=try box.protectHealthSelection(expected:choice,disable:true,requireRebind:false),fresh=HealthOutbox(storage:disk)
        try fresh.adoptSavedHealthLookup(human:human,requireSourceRebind:false)
        XCTAssertThrowsError(try fresh.checkHealthSavedRecovery(disabled,requireUpdatesEnabled:false))
        try fresh.confirmUnchangedEffectivePolicy(proof:proof(),expectedTypes:["sleep"])
        XCTAssertNoThrow(try fresh.checkHealthSavedRecovery(disabled,requireUpdatesEnabled:false));XCTAssertThrowsError(try fresh.checkHealthSavedRecovery(disabled))
    }
    func testNoUncheckedSameVersionFieldAndNoUnknownSelectionGrantField()throws{
        for kind in ["old-envelope","unknown-record","unknown-plan","unknown-root"]{
            let disk=SavedHealthDisk(),box=try seed(disk),choice=try selection();try box.saveHealthSelection(choice,expected:nil,proof:proof());var state=try raw(disk)
            if kind=="old-envelope"{state["version"]=4}
            if kind=="unknown-root"{state["inventedGrant"]=true}
            if kind=="unknown-record" || kind=="unknown-plan"{var list=state["healthSelections"] as! [Any],record=list[1] as! [String:Any]
                if kind=="unknown-record"{record["readGranted"]=true}else{var plans=record["plans"] as! [[String:Any]];plans[0]["rollingWindow"]=true;record["plans"]=plans};list[1]=record;state["healthSelections"]=list}
            disk.data=try bytes(state);let before=disk.data,count=disk.writes
            XCTAssertThrowsError(try box.savedHealthSelections(origin:origin,human:human,endpoint:endpoint),kind)
            XCTAssertEqual(disk.data,before);XCTAssertEqual(disk.writes,count)
        }
    }
    func testExactBitPatternPlansAndBounds()throws{
        let choice=try selection(),decoded=try JSONDecoder().decode(HealthOutbox.SavedHealthSelection.self,from:JSONEncoder().encode(choice))
        XCTAssertEqual(decoded,choice);XCTAssertEqual(decoded.plans[0].start.timeIntervalSince1970.bitPattern,Date(timeIntervalSince1970:0.125).timeIntervalSince1970.bitPattern)
        for category in ["hrvRMSSD","unknown"]{XCTAssertThrowsError(try HealthOutbox.SavedHealthPlan(category:category,scope:"s",mappingVersion:"v",start:Date(),end:Date().addingTimeInterval(1)))}
        XCTAssertThrowsError(try HealthOutbox.SavedHealthPlan(category:"sleep",scope:"s",mappingVersion:"v",start:Date(timeIntervalSince1970:0),end:Date(timeIntervalSince1970:32*86400)))
    }
    func testVersionFiveEnvelopePreservesEachOriginalNativeInnerFormatAndPendingHold()throws{
        for format in 1...4{
            let disk=SavedHealthDisk(),box=try seed(disk),choice=try selection(),binding=HealthOutbox.CalendarNativeBinding(origin:origin,principal:human,session:UUID(),endpoint:endpoint)
            let payload:[String:Any]=["schemaVersion":"1.0.0","operationId":UUID().uuidString.lowercased(),"target":["principalId":human.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":format==1 ? "eventKit":"healthKit","enrollmentId":NSNull(),"sourceNamespace":NSNull(),"expectedRevision":0],"action":["kind":"enroll"]]
            switch format{
            case 1:let original=try MobileCalendarSettingsWire.envelope(payload:payload);try box.stageCalendarNativeCommand(binding:binding,original:original.original)
            case 2,3:
                let scope:[String:Any]=["kind":"sourceConsent","principalId":human.uuidString.lowercased(),"collector":format==2 ? "eventKit":"healthKit","sourceNamespace":UUID().uuidString.lowercased(),"category":format==2 ? "CalendarEvent":"SleepSegment","installationId":UUID().uuidString.lowercased(),"environmentId":"synthetic-codec","destinationId":"synthetic-codec","purpose":"collection","recipient":NSNull()]
                if format==2{let original=try MobileCalendarSourceConsent.request(operationID:UUID(),scope:MobileCalendarSourceConsent.scope(scope),revision:0,validity:.untilRevoked,reviewDeadline:"2026-11-04T20:00:00.000Z");try box.stageCalendarSourceConsent(binding:binding,original:original.original)}
                else{let original=try MobileHealthSourceConsent.request(operationID:UUID(),scope:MobileHealthSourceConsent.scope(scope),revision:0,validity:.untilRevoked,reviewDeadline:"2026-11-04T20:00:00.000Z");try box.stageHealthSourceConsent(binding:binding,original:original.original)}
            default:try box.stageHealthControl(binding:binding,original:bytes(payload))
            }
            // Pure Core serialization fixture only. This is not a Native
            // admission/grant: the retained pending command MUST still block it.
            let before=try raw(disk),inner=try bytes(before["calendarNative"]!),health=try bytes(before["enrollments"]!)
            XCTAssertEqual((before["calendarNative"] as? [String:Any])?["format"] as? String,"CalendarNative/\(format)")
            try box.saveHealthSelection(choice,expected:nil,proof:proof())
            let after=try raw(disk);XCTAssertEqual(after["version"] as? Int,5);XCTAssertEqual(try bytes(after["calendarNative"]!),inner);XCTAssertEqual(try bytes(after["enrollments"]!),health)
            XCTAssertThrowsError(try box.checkHealthSavedRecovery(choice))
            let disabled=try box.protectHealthSelection(expected:choice,disable:true,requireRebind:false)
            XCTAssertEqual(try bytes(raw(disk)["calendarNative"]!),inner);XCTAssertFalse(disabled.updatesEnabled)
            let fresh=HealthOutbox(storage:disk);XCTAssertEqual(try fresh.savedHealthSelections(origin:origin,human:human,endpoint:endpoint),[disabled])
        }
    }
    func testVersionFiveCalendarHealthAndShareWritersPreserveChoiceAndExistingDomains()throws{
        let disk=SavedHealthDisk(),box=try seed(disk),choice=try selection();try box.saveHealthSelection(choice,expected:nil,proof:proof());let saved=try bytes(raw(disk)["healthSelections"]!),initialHealth=try bytes(raw(disk)["enrollments"]!)
        let ios=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fixture=try XCTUnwrap(JSONSerialization.jsonObject(with:Data(contentsOf:ios.appendingPathComponent("test/mobile-calendar-fixtures/delivery-receipts.json"))) as? [String:Any])
        var policy=fixture["policy"] as! [String:Any],result=policy["result"] as! [String:Any],row=result["enrollment"] as! [String:Any]
        row["principalId"]=human.uuidString.lowercased();row["endpointId"]=endpoint.uuidString.lowercased();result["enrollment"]=row;policy["result"]=result
        let calendar=try MobileCalendarPolicyParser.parse(bytes(policy),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:UUID(uuidString:row["enrollmentId"] as! String)!)
        try box.admitCalendarExistingRemote(proof:calendar,selectedCategories:["CalendarEvent"])
        let ct=try box.calendarTicket(enrollment:calendar.enrollment,category:"CalendarEvent"),scope=try MobileCalendarDelivery.CheckpointScope(collector:calendar.collector,namespace:calendar.namespace,mappingVersion:"synthetic-calendar-mapping/1",coverage:.partial,start:"2026-10-01T00:00:00Z",end:"2026-11-01T00:00:00Z")
        try box.commitCalendar(scope:scope,expectedCheckpoint:nil,nextCheckpoint:Data([8]),items:[],ticket:ct)
        XCTAssertEqual(try bytes(raw(disk)["healthSelections"]!),saved);XCTAssertEqual(try bytes(raw(disk)["enrollments"]!),initialHealth)
        let calendarBytes=try bytes(raw(disk)["calendarEnrollments"]!)
        let shareAuthority=SavedShareAuthority(),share=HealthOutbox(storage:disk,shareAuthority:shareAuthority);try share.setHuman(human)
        let sharedRaw=try String(contentsOf:ios.appendingPathComponent("test/mobile-shared-item-fixtures/shared-item-pairs.json"),encoding:.utf8).replacingOccurrences(of:"\\ud800",with:"__UNPAIRED__")
        let pairs=(try JSONSerialization.jsonObject(with:Data(sharedRaw.utf8)) as! [String:Any])["pairs"] as! [[String:Any]]
        var item=pairs.first{$0["case"] as? String=="file-reference"}!["ios"] as! [String:Any],content=item["content"] as! [String:Any],artifact=content["artifact"] as! [String:Any]
        let payload=Data([0,2,255]);artifact["byteLength"]=payload.count;artifact["sha256"]=SHA256.hash(data:payload).map{String(format:"%02x",$0)}.joined();content["artifact"]=artifact;item["content"]=content
        let itemBytes=try bytes(item),decoded=try MobileSharedItem.decode(itemBytes),context=OutboxShareContext(owner:share,human:human,endpoint:endpoint,namespace:decoded.source.namespace,collector:decoded.source.collector,epoch:1,recoveryOnly:false)
        guard case .portAcknowledged=MobileSharedCapture.capture(itemJSON:itemBytes,attempt:OutboxShareAttempt(UUID(),context:context),lease:SavedShareLease(context,payload),owner:share) else{return XCTFail("version5 Share commit")}
        XCTAssertEqual(try raw(disk)["version"] as? Int,5);XCTAssertEqual(try bytes(raw(disk)["healthSelections"]!),saved);XCTAssertEqual(try bytes(raw(disk)["calendarEnrollments"]!),calendarBytes);XCTAssertEqual(try bytes(raw(disk)["enrollments"]!),initialHealth)
        let shares=try bytes(raw(disk)["shareAssociations"]!),fresh=HealthOutbox(storage:disk);try fresh.setHuman(human);try fresh.confirmUnchangedEffectivePolicy(proof:proof(),expectedTypes:["sleep"]);try fresh.pause(enrollment:enrollment)
        XCTAssertEqual(try raw(disk)["version"] as? Int,5);XCTAssertEqual(try bytes(raw(disk)["healthSelections"]!),saved);XCTAssertEqual(try bytes(raw(disk)["calendarEnrollments"]!),calendarBytes);XCTAssertEqual(try bytes(raw(disk)["shareAssociations"]!),shares)
    }
    func testPauseAndStalePolicyOrCASNeverEnableRememberedChoice()throws{
        for mode in ["paused","revision","denied","stale-cas"]{
            let disk=SavedHealthDisk(),box=try seed(disk),choice=try selection();if mode=="paused"{try box.pause(enrollment:enrollment)}
            if mode=="stale-cas"{try box.saveHealthSelection(choice,expected:nil,proof:proof())}
            let before=disk.data,writes=disk.writes
            XCTAssertThrowsError(try box.saveHealthSelection(choice,expected:nil,proof:proof(revision:mode=="revision" ? 2:1,allowed:mode != "denied")),mode)
            XCTAssertEqual(disk.data,before);XCTAssertEqual(disk.writes,writes)
        }
    }
    func testOriginalWriteBeforeAndAfterFailureRemainDistinctNoReset()throws{
        for after in [false,true]{let disk=SavedHealthDisk(),box=try seed(disk),choice=try selection();try box.saveHealthSelection(choice,expected:nil,proof:proof());let before=disk.data,writes=disk.writes;disk.failBefore = !after;disk.failAfter=after
            XCTAssertThrowsError(try box.protectHealthSelection(expected:choice,disable:true,requireRebind:false))
            XCTAssertEqual(disk.writes,writes+(after ? 1:0));XCTAssertEqual(disk.data==before,!after)
            // Native Root/storage—not this lowest Core memory port—own the
            // ambiguity latch and lifetime. No cold continuity claim is inferred.
        }
    }
}
