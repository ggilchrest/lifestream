import Foundation
import XCTest
@testable import AssistantCore

private final class CalendarDisk:HealthSnapshotStorage {
    var data:Data?,writes=0
    func read()throws->Data?{data}
    func replace(_ value:Data)throws{data=value;writes += 1}
}
final class CalendarSavedTests:XCTestCase {
    func testSavedSelectionColdReadAndScope() throws {
        let human=UUID(),endpoint=UUID(),enrollment=UUID(),namespace=UUID(),session=UUID(),origin="https://calendar.example"
        func id(_ value:UUID)->String{value.uuidString.lowercased()}
        let configuration:[String:Any]=["categories":["CalendarEvent"],"uses":[],"assistantIds":[],"collectionPaused":false,"usePaused":true]
        func remote(_ revision:Int)->[String:Any]{["enrollmentId":id(enrollment),"principalId":id(human),"endpointId":id(endpoint),"collector":"eventKit","sourceNamespace":id(namespace),"revision":revision,"state":"active","configuration":configuration]}
        func policy(_ revision:Int)throws->MobileCalendarPolicyProof {
            let effective:[String:Any]=["policyRevision":revision,"sourceBound":true,"policyAvailable":true,"policyBindingDigest":String(repeating:"a",count:64),"collectionAllowed":true,"categories":["CalendarEvent"],"uses":[],"assistantIds":[],"sourceNamespace":id(namespace)]
            let body:[String:Any]=["schemaVersion":"1.0.0","producerPin":["schemaId":MobileCalendarDelivery.schemaId,"schemaVersion":"1.0.0","digest":MobileCalendarDelivery.schemaDigest],"result":["kind":"policy","enrollment":remote(revision),"effective":effective]]
            return try MobileCalendarPolicyParser.parse(JSONSerialization.data(withJSONObject:body),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:enrollment)
        }
        let before=try policy(2),after=try policy(3),disk=CalendarDisk(),box=HealthOutbox(storage:disk)
        try box.admitCalendarExistingRemote(proof:before,selectedCategories:["CalendarEvent"])
        let window=MobileCalendarSyncWindow(lookBackDays:7,lookAheadDays:30,timeZone:"UTC")!
        let payload:[String:Any]=["schemaVersion":"1.0.0","operationId":id(UUID()),"target":["principalId":id(human),"endpointId":id(endpoint),"collector":"eventKit","enrollmentId":id(enrollment),"sourceNamespace":id(namespace),"expectedRevision":2],"action":["kind":"configure","state":"active","configuration":["sourceConfiguration":configuration,"syncWindow":window.json]]]
        let command=try MobileCalendarSettingsWire.envelope(payload:payload),binding=HealthOutbox.CalendarNativeBinding(origin:origin,principal:human,session:session,endpoint:endpoint)
        try box.stageCalendarNativeCommand(binding:binding,original:command.original);try box.markCalendarNativeCommandAttempted(binding:binding,original:command.original)
        let outcome:[String:Any]=["status":"applied","receipt":["operationId":id(command.operationID),"committedAt":"2026-11-01T18:00:00Z"],"enrollment":remote(3),"syncWindow":window.json]
        let chosen:[String:Any]=["syntheticOnly":true]
        let controlBinding:[String:Any]=["family":"calendarControl","reservationDigest":MobileCalendarSettingsWire.hash("lifestream/calendar-control/reservation/1",command.payload),"preparedDigest":MobileCalendarSettingsWire.hash("lifestream/calendar-control/prepared/1",try MobileCalendarDelivery.canonical(["request":payload,"selection":chosen])),"terminalDigest":MobileCalendarSettingsWire.hash("lifestream/calendar-control/terminal/1",try MobileCalendarDelivery.canonical(["request":payload,"selection":chosen,"outcome":outcome]))]
        let response:[String:Any]=["schemaVersion":"1.0.0","producerPin":MobileCalendarSettingsWire.pin,"result":["kind":"terminal","originalRequest":payload,"requestDigest":command.requestDigest,"outcome":outcome,"current":true,"binding":controlBinding]]
        let terminal=try MobileCalendarSettingsWire.terminal(JSONSerialization.data(withJSONObject:response),original:command)
        try box.settleCalendarNativeCommand(binding:binding,terminal:terminal,reconciliation:false)
        let calendar=MobileCalendarSettingsWire.Selection.CalendarIdentity(containerID:"calendar-a",accountID:"account-a")
        let selected=MobileCalendarSettingsWire.Selection(principal:human,endpoint:endpoint,enrollment:enrollment,namespace:namespace,revision:3,calendars:[calendar])!
        let plan=window.plan(anchor:Date(timeIntervalSince1970:1790000000),selectedCalendars:1,limits:.init(maxTotalDays:366,maxScans:8,maxSelectedCalendars:32)!)!
        let run=MobileCalendarSettingsWire.Run(selection:selected,snapshot:plan)
        let acquisition=MobileEventKitAcquisition.Plan(category:"CalendarEvent",selectedContainerIDs:[calendar.containerID],mappingVersion:"test/1",coverageStart:plan.windows[0].start,coverageEnd:plan.windows[0].end,capturedSDKDefaultTimeZone:TimeZone(secondsFromGMT:0)!)
        try box.applyCalendarConfiguredExistingLocal(terminal:terminal,proof:after,selection:MobileCalendarSettingsWire.phoneSelection(run:run,plan:acquisition))
        let writes=disk.writes,bytes=disk.data,reopened=HealthOutbox(storage:disk)
        let candidate=try XCTUnwrap(reopened.savedCalendarCandidate(origin:origin,principal:human,endpoint:endpoint))
        let actual=try XCTUnwrap(reopened.savedCalendarSelection(origin:origin,principal:human,endpoint:endpoint,terminal:candidate,proof:after))
        XCTAssertEqual(candidate.window,window);XCTAssertEqual(actual,selected)
        XCTAssertFalse(actual.calendars.contains(.init(containerID:"calendar-a",accountID:"account-b")))
        XCTAssertFalse(actual.calendars.contains(.init(containerID:"calendar-b",accountID:"account-a")))
        XCTAssertNil(try reopened.savedCalendarCandidate(origin:origin,principal:UUID(),endpoint:endpoint))
        XCTAssertNil(try reopened.savedCalendarCandidate(origin:origin,principal:human,endpoint:UUID()))
        XCTAssertNil(try reopened.savedCalendarCandidate(origin:"https://other.example",principal:human,endpoint:endpoint))
        XCTAssertNil(try reopened.savedCalendarSelection(origin:origin,principal:human,endpoint:endpoint,terminal:candidate,proof:before))
        XCTAssertEqual(disk.writes,writes);XCTAssertEqual(disk.data,bytes)
    }
}
