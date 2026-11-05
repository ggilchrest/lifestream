import Foundation
import XCTest
import CryptoKit
@testable import AssistantCore

private final class BackgroundHealthDisk:HealthSnapshotStorage {
    var data:Data?,writes=0,failBefore=false,failAfter=false
    func read()throws->Data?{data}
    func replace(_ bytes:Data)throws{if failBefore{throw CocoaError(.fileWriteUnknown)};data=bytes;writes+=1;if failAfter{throw CocoaError(.fileWriteUnknown)}}
}
private final class BackgroundShareAuthority:OutboxShareAuthority{
    func withFence<T>(_ body:()throws->T)rethrows->T{try body()}
    func permits(_ context:OutboxShareContext,reading:Bool)->Bool{true}
}
private final class BackgroundShareLease:SharedCaptureReadLease{
    let originalSelectionContext:any SharedCaptureBinding;var chunks:[Data?]
    init(_ context:OutboxShareContext,_ bytes:Data){originalSelectionContext=context;chunks=[bytes,nil]}
    func check()throws{}
    func read(maxBytes:Int)throws->Data?{chunks.removeFirst()}
    func close(){}
}
final class HealthBackgroundChoiceTests:XCTestCase {
    private let human=UUID(),endpoint=UUID(),enrollment=UUID(),namespace=UUID(),origin="https://offline.invalid"
    private func bytes(_ value:Any)throws->Data{try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys])}
    private func raw(_ disk:BackgroundHealthDisk)throws->[String:Any]{try XCTUnwrap(JSONSerialization.jsonObject(with:XCTUnwrap(disk.data)) as? [String:Any])}
    private func proof(revision:Int=1,allowed:Bool=true)throws->MobileHealthPolicyProof{
        let value:[String:Any]=["schemaVersion":"1.0.0","producerPin":["schemaId":MobileHealthEncoder.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthEncoder.schemaSHA256],"result":["enrollment":["enrollmentId":enrollment.uuidString.lowercased(),"principalId":human.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":namespace.uuidString.lowercased(),"revision":revision,"state":"active","configuration":["categories":["SleepSegment"],"uses":[],"assistantIds":[],"collectionPaused":false,"usePaused":true]],"effective":["policyRevision":revision,"sourceBound":true,"collectionAllowed":allowed,"categories":["SleepSegment"],"uses":[],"assistantIds":[],"sourceNamespace":namespace.uuidString.lowercased()]]]
        return try MobileHealthPolicyParser.parse(bytes(value),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:enrollment)
    }
    private func selection(enabled:Bool=true)throws->HealthOutbox.SavedHealthSelection{
        let plan=try HealthOutbox.SavedHealthPlan(category:"sleep",scope:"exact original scope",mappingVersion:"healthkit/1",start:Date(timeIntervalSince1970:0.125),end:Date(timeIntervalSince1970:3600.125))
        return try .init(origin:origin,human:human,endpoint:endpoint,enrollment:enrollment,namespace:namespace,policyRevision:1,plans:[plan],updatesEnabled:enabled)
    }
    private func seed(_ disk:BackgroundHealthDisk)throws->HealthOutbox{
        let box=HealthOutbox(storage:disk);try box.setHuman(human);try box.enroll(proof:proof(),selectedTypes:["sleep"])
        let ticket=try box.ticket(enrollment:enrollment,type:"sleep")
        try box.commit(scope:"existing-anchor",expectedAnchor:nil,nextAnchor:Data([1]),changes:[.init(upstreamId:"opaque-existing",operation:.upsert,body:Data("synthetic".utf8),expectedPolicyRevision:1,mappingVersion:"healthkit/1")],ticket:ticket)
        return box
    }
    private func remembered(_ disk:BackgroundHealthDisk)throws->(HealthOutbox,HealthOutbox.SavedHealthSelection){let box=try seed(disk),choice=try selection();try box.saveHealthSelection(choice,expected:nil,proof:proof());return(box,choice)}
    func testOriginalForegroundChoiceStaysUntaggedAndReadOnlyAcrossRestart()throws{
        let disk=BackgroundHealthDisk(),(box,choice)=try remembered(disk),before=disk.data,count=disk.writes
        XCTAssertNil(choice.backgroundChoice);XCTAssertFalse(String(data:try XCTUnwrap(disk.data),encoding:.utf8)!.contains("backgroundChoice"))
        let fresh=HealthOutbox(storage:disk);XCTAssertEqual(try fresh.savedHealthSelections(origin:origin,human:human,endpoint:endpoint),[choice]);XCTAssertEqual(disk.data,before);XCTAssertEqual(disk.writes,count);_ = box
    }
    func testDeliberateTaggedChoiceRetainsOriginalQueueAnchorAndVersion()throws{
        let disk=BackgroundHealthDisk(),(box,choice)=try remembered(disk),ticket=try box.ticket(enrollment:enrollment,type:"sleep"),before=try raw(disk)
        let tagged=try box.setHealthBackgroundChoice(expected:choice,enabled:true,proof:proof())
        XCTAssertEqual(tagged.backgroundChoice?.format,"native-health-background-choice/1");XCTAssertEqual(tagged.backgroundChoice?.enabled,true)
        XCTAssertEqual(try raw(disk)["version"] as? Int,5);XCTAssertEqual(try bytes(raw(disk)["enrollments"]!),try bytes(before["enrollments"]!));XCTAssertEqual(try box.pending(ticket:ticket).count,1);XCTAssertEqual(try box.anchor(for:"existing-anchor",ticket:ticket),Data([1]))
    }
    func testNoBackgroundWideningWithoutFreshPolicyAndCAS()throws{
        for mode in ["missing","denied","revision","paused","stale"]{
            let disk=BackgroundHealthDisk(),(box,choice)=try remembered(disk)
            if mode=="paused"{try box.pause(enrollment:enrollment)}
            if mode=="stale"{_ = try box.setHealthBackgroundChoice(expected:choice,enabled:false)}
            let before=disk.data,writes=disk.writes
            XCTAssertThrowsError(try box.setHealthBackgroundChoice(expected:choice,enabled:true,proof:mode=="missing" ? nil:proof(revision:mode=="revision" ? 2:1,allowed:mode != "denied")),mode)
            XCTAssertEqual(disk.data,before);XCTAssertEqual(disk.writes,writes)
        }
    }
    func testBackgroundOffRetainsForegroundChoiceAndIndependentManualTicket()throws{
        let disk=BackgroundHealthDisk(),(box,choice)=try remembered(disk),tagged=try box.setHealthBackgroundChoice(expected:choice,enabled:true,proof:proof()),ticket=try box.ticket(enrollment:enrollment,type:"sleep")
        let off=try box.setHealthBackgroundChoice(expected:tagged,enabled:false)
        XCTAssertEqual(off.backgroundChoice?.enabled,false);XCTAssertTrue(off.updatesEnabled);XCTAssertEqual(try box.pending(ticket:ticket).count,1)
        XCTAssertNoThrow(try box.checkHealthSavedRecovery(off))
    }
    func testStopMasterAndActualHumanRebindRetainDisabledTag()throws{
        for rebind in [false,true]{
            let disk=BackgroundHealthDisk(),(box,choice)=try remembered(disk),tagged=try box.setHealthBackgroundChoice(expected:choice,enabled:true,proof:proof())
            let stopped=try box.protectHealthSelection(expected:tagged,disable:!rebind,requireRebind:rebind)
            XCTAssertEqual(stopped.backgroundChoice?.enabled,false);XCTAssertEqual(stopped.requiresRebind,rebind);XCTAssertEqual(stopped.updatesEnabled,rebind)
            let fresh=HealthOutbox(storage:disk);XCTAssertEqual(try fresh.savedHealthSelections(origin:origin,human:human,endpoint:endpoint),[stopped])
        }
    }
    func testSubjectAdoptionCannotInheritTaggedEnableEvenOnReturn()throws{
        let disk=BackgroundHealthDisk(),(box,choice)=try remembered(disk);_ = try box.setHealthBackgroundChoice(expected:choice,enabled:true,proof:proof());try box.setHuman(UUID());try box.setHuman(human)
        let value=try XCTUnwrap(box.savedHealthSelections(origin:origin,human:human,endpoint:endpoint).first);XCTAssertTrue(value.requiresRebind);XCTAssertEqual(value.backgroundChoice?.enabled,false)
    }
    func testForegroundWriterCannotDropOrSilentlyAddBackgroundTag()throws{
        let disk=BackgroundHealthDisk(),(box,choice)=try remembered(disk),tagged=try box.setHealthBackgroundChoice(expected:choice,enabled:true,proof:proof()),before=disk.data
        XCTAssertThrowsError(try box.saveHealthSelection(choice,expected:tagged,proof:proof()));XCTAssertEqual(disk.data,before)
        let other=BackgroundHealthDisk(),(newBox,plain)=try remembered(other);var forged=plain;forged.backgroundChoice = .init(enabled:true)
        XCTAssertThrowsError(try newBox.saveHealthSelection(forged,expected:plain,proof:proof()))
    }
    func testClosedTagRejectsUnknownFieldsFormatsNullAndInvalidEnable()throws{
        for mutation in ["field","format","null","bool","master"]{
            let disk=BackgroundHealthDisk(),(box,choice)=try remembered(disk);_ = try box.setHealthBackgroundChoice(expected:choice,enabled:true,proof:proof());var root=try raw(disk),list=root["healthSelections"] as! [Any],row=list[1] as! [String:Any],tag=row["backgroundChoice"] as! [String:Any]
            if mutation=="field"{tag["readGranted"]=true};if mutation=="format"{tag["format"]="future/2"};if mutation=="bool"{tag["enabled"]=1};row["backgroundChoice"]=mutation=="null" ? NSNull():tag;if mutation=="master"{row["updatesEnabled"]=false};list[1]=row;root["healthSelections"]=list;disk.data=try bytes(root);let before=disk.data,count=disk.writes
            XCTAssertThrowsError(try box.savedHealthSelections(origin:origin,human:human,endpoint:endpoint),mutation);XCTAssertEqual(disk.data,before);XCTAssertEqual(disk.writes,count)
        }
    }
    func testAmbiguousOptOutDoesNotResetOrEraseTag()throws{
        for after in [false,true]{let disk=BackgroundHealthDisk(),(box,choice)=try remembered(disk),tagged=try box.setHealthBackgroundChoice(expected:choice,enabled:true,proof:proof()),before=disk.data;disk.failBefore = !after;disk.failAfter=after
            XCTAssertThrowsError(try box.setHealthBackgroundChoice(expected:tagged,enabled:false));XCTAssertEqual(disk.data==before,!after);XCTAssertTrue(String(data:try XCTUnwrap(disk.data),encoding:.utf8)!.contains("backgroundChoice"))
        }
    }
    func testTaggedChoiceSurvivesOriginalCalendarShareAndHealthWriters()throws{
        let disk=BackgroundHealthDisk(),box=try seed(disk),choice=try selection();try box.saveHealthSelection(choice,expected:nil,proof:proof());_ = try box.setHealthBackgroundChoice(expected:choice,enabled:true,proof:proof());let saved=try bytes(raw(disk)["healthSelections"]!),initialHealth=try bytes(raw(disk)["enrollments"]!)
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
        let shareAuthority=BackgroundShareAuthority(),share=HealthOutbox(storage:disk,shareAuthority:shareAuthority);try share.setHuman(human)
        let sharedRaw=try String(contentsOf:ios.appendingPathComponent("test/mobile-shared-item-fixtures/shared-item-pairs.json"),encoding:.utf8).replacingOccurrences(of:"\\ud800",with:"__UNPAIRED__")
        let pairs=(try JSONSerialization.jsonObject(with:Data(sharedRaw.utf8)) as! [String:Any])["pairs"] as! [[String:Any]]
        var item=pairs.first{$0["case"] as? String=="file-reference"}!["ios"] as! [String:Any],content=item["content"] as! [String:Any],artifact=content["artifact"] as! [String:Any]
        let payload=Data([0,2,255]);artifact["byteLength"]=payload.count;artifact["sha256"]=SHA256.hash(data:payload).map{String(format:"%02x",$0)}.joined();content["artifact"]=artifact;item["content"]=content
        let itemBytes=try bytes(item),decoded=try MobileSharedItem.decode(itemBytes),context=OutboxShareContext(owner:share,human:human,endpoint:endpoint,namespace:decoded.source.namespace,collector:decoded.source.collector,epoch:1,recoveryOnly:false)
        guard case .portAcknowledged=MobileSharedCapture.capture(itemJSON:itemBytes,attempt:OutboxShareAttempt(UUID(),context:context),lease:BackgroundShareLease(context,payload),owner:share) else{return XCTFail("version5 Share commit")}
        XCTAssertEqual(try raw(disk)["version"] as? Int,5);XCTAssertEqual(try bytes(raw(disk)["healthSelections"]!),saved);XCTAssertEqual(try bytes(raw(disk)["calendarEnrollments"]!),calendarBytes);XCTAssertEqual(try bytes(raw(disk)["enrollments"]!),initialHealth)
        let shares=try bytes(raw(disk)["shareAssociations"]!),fresh=HealthOutbox(storage:disk);try fresh.setHuman(human);try fresh.confirmUnchangedEffectivePolicy(proof:proof(),expectedTypes:["sleep"]);try fresh.pause(enrollment:enrollment)
        XCTAssertEqual(try raw(disk)["version"] as? Int,5);XCTAssertEqual(try bytes(raw(disk)["healthSelections"]!),saved);XCTAssertEqual(try bytes(raw(disk)["calendarEnrollments"]!),calendarBytes);XCTAssertEqual(try bytes(raw(disk)["shareAssociations"]!),shares)
    }
    func testTaggedChoicePreservesAllFourOriginalPendingInnerFormats()throws{
        for format in 1...4{
            let disk=BackgroundHealthDisk(),box=try seed(disk),choice=try selection(),binding=HealthOutbox.CalendarNativeBinding(origin:origin,principal:human,session:UUID(),endpoint:endpoint)
            try box.saveHealthSelection(choice,expected:nil,proof:proof());let tagged=try box.setHealthBackgroundChoice(expected:choice,enabled:true,proof:proof())
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
            XCTAssertThrowsError(try box.setHealthBackgroundChoice(expected:tagged,enabled:true,proof:proof()))
            let after=try raw(disk);XCTAssertEqual(after["version"] as? Int,5);XCTAssertEqual(try bytes(after["calendarNative"]!),inner);XCTAssertEqual(try bytes(after["enrollments"]!),health)
            XCTAssertThrowsError(try box.checkHealthSavedRecovery(tagged))
            let disabled=try box.protectHealthSelection(expected:tagged,disable:true,requireRebind:false)
            XCTAssertEqual(try bytes(raw(disk)["calendarNative"]!),inner);XCTAssertFalse(disabled.updatesEnabled)
            let fresh=HealthOutbox(storage:disk);XCTAssertEqual(try fresh.savedHealthSelections(origin:origin,human:human,endpoint:endpoint),[disabled])
        }
    }
}
