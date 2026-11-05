import Foundation
import XCTest
@testable import AssistantCore

private final class FamilyDisk: HealthSnapshotStorage { var data: Data?; var fail=false; func read() throws -> Data? { data }; func replace(_ bytes: Data) throws { if fail { throw CocoaError(.fileWriteUnknown) }; data=bytes } }
private final class FamilyWitness: MobileControlSettlementWitness {
    var value: MobileControlSettlementLedger.WitnessValue?; var reject=false
    func current(serverDigest:String,principal:UUID)throws->MobileControlSettlementLedger.WitnessValue? { value }
    func compareAndAdvance(serverDigest:String,principal:UUID,expected:MobileControlSettlementLedger.WitnessValue,next:MobileControlSettlementLedger.WitnessValue)throws->Bool { guard !reject,value==expected else{return false};value=next;return true }
}
private final class FamilyLease: MobileControlExclusiveLease {
    let lock=NSRecursiveLock();var valid=true
    func withFence<T>(_ body:() throws -> T)throws->T {lock.lock();defer{lock.unlock()};return try body()}
    func isCurrent(serverDigest:String,principal:UUID)->Bool {valid}
    func release(){valid=false}
}
final class MobileControlSettlementFamilyTests: XCTestCase {
    func bytes(_ x:Any)throws->Data {try JSONSerialization.data(withJSONObject:x,options:[.sortedKeys,.withoutEscapingSlashes])}
    func vectors()throws->[[String:Any]] {let ios=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent();let root=try XCTUnwrap(JSONSerialization.jsonObject(with:Data(contentsOf:ios.appendingPathComponent("test/mobile-ordinary-control-vectors.json"))) as? [String:Any]);return try XCTUnwrap(root["vectors"] as? [[String:Any]])}
    func preview(principal:UUID,endpoint:UUID)throws->MobileInterpretation.Preview {
        let enrollment=UUID().uuidString.lowercased(),assistant=UUID().uuidString.lowercased(),namespace=UUID().uuidString.lowercased(),op=UUID().uuidString.lowercased(),digest=String(repeating:"a",count:64)
        let query:[String:Any]=["enrollmentId":enrollment,"assistantId":assistant,"startAt":"2026-10-29T00:00:00Z","endAt":"2026-10-30T00:00:00Z"],change:[String:Any]=["kind":"select","choiceDigest":digest]
        let expected:[String:Any]=["schemaVersion":"1.0.0","operation":"preview","operationId":op,"query":query,"expectedSourceRevision":2,"expectedInterpretationRevision":0,"change":change]
        let target:[String:Any]=["scope":["principalId":principal.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":namespace],"endpointId":endpoint.uuidString.lowercased(),"enrollmentId":enrollment,"assistantId":assistant]
        let config:[String:Any]=["categories":["SleepSegment"],"uses":["answers"],"assistantIds":[assistant],"collectionPaused":true,"usePaused":false]
        let original:[String:Any]=["schemaVersion":"1.0.0","operationId":op,"target":["principalId":principal.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","enrollmentId":enrollment,"sourceNamespace":namespace,"expectedRevision":2],"action":["kind":"configure","state":"active","configuration":config]]
        let summary:[String:Any]=["algorithmVersion":"sleep-union/1","timeBasis":"elapsedUTC","coverage":"unknown","totalAsleepMs":NSNull(),"sessions":[],"excludedNonSleepRecords":0,"excludedNonOverlappingSleepRecords":0,"deduplication":"same-source-interval-union","limitations":[]]
        let provenance:[String:Any]=["datasetDigest":digest,"policyBindingDigest":digest,"sourceSafetyEpoch":0,"records":[],"readState":"boundedComplete","timeBasis":"elapsedUTC","limitations":[]]
        let result:[String:Any]=["state":"ready","operationId":op,"query":query,"target":target,"sourceRevision":2,"interpretationRevision":0,"nextInterpretationRevision":1,"change":change,"beforeChoiceDigest":NSNull(),"afterChoiceDigest":digest,"before":summary,"after":summary,"provenance":provenance,"reviewDigest":digest,"controlOriginal":original,"limitations":[]]
        let response:[String:Any]=["schemaVersion":"1.0.0","producerPin":["schemaId":MobileInterpretationSchema.schemaId,"schemaVersion":"1.0.0","digest":MobileInterpretationSchema.digest],"result":result]
        return try XCTUnwrap(MobileInterpretation.decodeRead(bytes(response),expectedPayload:bytes(expected),principal:principal,endpoint:endpoint).preview)
    }
    func testPreviewBoundInterpretationExcludesOrdinaryFamily()throws {
        let disk=FamilyDisk(),witness=FamilyWitness(),lease=FamilyLease(),principal=UUID(),endpoint=UUID(),scope=MobileControlSettlementLedger.Scope(serverDigest:String(repeating:"c",count:64),principal:principal,endpoint:endpoint,session:UUID())
        disk.data=try MobileControlSettlementLedger.genesisBytes();witness.value=try MobileControlSettlementLedger.genesisWitness();let ledger=MobileControlSettlementLedger(storage:disk,witness:witness)
        try ledger.upgradeQualifiedV1(scope:scope,authenticatedInterpretationResponse:nil,lease:lease)
        let p=try preview(principal:principal,endpoint:endpoint);XCTAssertThrowsError(try ledger.stage(scope:scope,original:p.original,expectedRevision:p.nextRevision))
        XCTAssertEqual(try ledger.stageInterpretation(scope:scope,preview:p,lease:lease),p.original)
        XCTAssertThrowsError(try ledger.pendingOrdinary(scope:scope));XCTAssertEqual(try ledger.pending(scope:scope)?.original,p.original)
        let ordinary=try bytes(XCTUnwrap(try vectors()[0]["response"]));XCTAssertThrowsError(try ledger.appendAuthenticatedInterpretationTerminal(scope:scope,response:ordinary,lease:lease))
        XCTAssertThrowsError(try ledger.stageOrdinary(scope:scope,original:p.original,lease:lease))
        let object=try XCTUnwrap(JSONSerialization.jsonObject(with:p.original) as? [String:Any]),target=try XCTUnwrap(object["target"] as? [String:Any]),action=try XCTUnwrap(object["action"] as? [String:Any]),parsed=try MobileControlOriginal.parse(p.original)
        let enrollment:[String:Any]=["enrollmentId":target["enrollmentId"]!,"principalId":target["principalId"]!,"endpointId":target["endpointId"]!,"collector":"healthKit","sourceNamespace":target["sourceNamespace"]!,"revision":3,"state":"active","configuration":action["configuration"]!]
        let nested:[String:Any]=["schemaVersion":"1.0.0","producerPin":["schemaId":MobileControlOriginal.schemaId,"schemaVersion":"1.0.0","digest":MobileControlOriginal.schemaSHA256],"result":["originalRequest":object,"requestDigest":parsed.digest,"current":["state":"current","policyRevision":3],"status":"applied","receipt":["receiptId":UUID().uuidString.lowercased(),"committedAt":"2026-10-30T00:00:00Z","durability":"sqlCommit","result":["kind":"configure","enrollment":enrollment]]]]
        let terminal=try bytes(["schemaVersion":"1.0.0","producerPin":["schemaId":MobileInterpretationSchema.schemaId,"schemaVersion":"1.0.0","digest":MobileInterpretationSchema.digest],"result":["state":"mutation","controlResponse":nested,"interpretationStatus":"applied","interpretationRevision":1,"operationId":object["operationId"]!,"limitations":[]]])
        try ledger.appendAuthenticatedInterpretationTerminal(scope:scope,response:terminal,lease:lease)
        var ordinaryRequest=try XCTUnwrap(try vectors()[0]["request"] as? [String:Any]);var ordinaryTarget=try XCTUnwrap(ordinaryRequest["target"] as? [String:Any]);ordinaryTarget["principalId"]=principal.uuidString.lowercased();ordinaryTarget["endpointId"]=endpoint.uuidString.lowercased();ordinaryRequest["target"]=ordinaryTarget
        _ = try ledger.stageOrdinary(scope:scope,original:bytes(ordinaryRequest),lease:lease)
        XCTAssertThrowsError(try ledger.appendAuthenticatedOrdinaryTerminal(scope:scope,response:terminal,lease:lease))
    }
    func testSequentialOrdinaryIntentAndRestartRevalidation()throws {
        let disk=FamilyDisk(), witness=FamilyWitness(), lease=FamilyLease(), source=try vectors()
        disk.data=try MobileControlSettlementLedger.genesisBytes();witness.value=try MobileControlSettlementLedger.genesisWitness()
        let scope=MobileControlSettlementLedger.Scope(serverDigest:String(repeating:"a",count:64),principal:UUID(uuidString:"00000000-0000-4000-8000-000000000002")!,endpoint:UUID(uuidString:"00000000-0000-4000-8000-000000000003")!,session:UUID())
        let ledger=MobileControlSettlementLedger(storage:disk,witness:witness)
        try ledger.upgradeQualifiedV1(scope:scope,authenticatedInterpretationResponse:nil,lease:lease)
        for index in [0,2,4] {
            let vector=source[index], original=try bytes(XCTUnwrap(vector["request"])), response=try bytes(XCTUnwrap(vector["response"]))
            XCTAssertThrowsError(try ledger.stage(scope:scope,original:original,expectedRevision:1))
            _=try ledger.stageOrdinary(scope:scope,original:original,lease:lease)
            XCTAssertEqual(try ledger.pendingOrdinary(scope:scope),original)
            XCTAssertThrowsError(try ledger.pending(scope:scope))
            XCTAssertThrowsError(try ledger.stageOrdinary(scope:scope,original:original,lease:lease))
            try ledger.appendAuthenticatedOrdinaryTerminal(scope:scope,response:response,lease:lease)
            XCTAssertNil(try ledger.pendingOrdinary(scope:scope))
            XCTAssertEqual(try ledger.lastSettledControlOriginal(scope:scope),original)
        }
        let restarted=MobileControlSettlementLedger(storage:disk,witness:witness)
        let first=try bytes(XCTUnwrap(source[0]["request"]));XCTAssertThrowsError(try restarted.stageOrdinary(scope:scope,original:first,lease:lease))
        let response=try bytes(XCTUnwrap(source[4]["response"]));try restarted.revalidateAuthenticatedOrdinaryTerminal(scope:scope,response:response,lease:lease)
        XCTAssertThrowsError(try restarted.stageOrdinary(scope:scope,original:first,lease:lease),"duplicate operation cannot restage")
        let interpretation=try preview(principal:scope.principal,endpoint:scope.endpoint)
        XCTAssertEqual(try restarted.stageInterpretation(scope:scope,preview:interpretation,lease:lease),interpretation.original)
        XCTAssertThrowsError(try restarted.pendingOrdinary(scope:scope))
    }
    func testLeaseWitnessAndTamperFailClosed()throws {
        let disk=FamilyDisk(), witness=FamilyWitness(), lease=FamilyLease(), original=try bytes(XCTUnwrap(try vectors()[0]["request"]))
        disk.data=try MobileControlSettlementLedger.genesisBytes();witness.value=try MobileControlSettlementLedger.genesisWitness()
        let scope=MobileControlSettlementLedger.Scope(serverDigest:String(repeating:"b",count:64),principal:UUID(uuidString:"00000000-0000-4000-8000-000000000002")!,endpoint:UUID(uuidString:"00000000-0000-4000-8000-000000000003")!,session:UUID()), ledger=MobileControlSettlementLedger(storage:disk,witness:witness)
        XCTAssertNil(try UnavailableMobileControlExclusivity().acquire(serverDigest:scope.serverDigest,principal:scope.principal))
        lease.valid=false;XCTAssertThrowsError(try ledger.upgradeQualifiedV1(scope:scope,authenticatedInterpretationResponse:nil,lease:lease));lease.valid=true
        try ledger.upgradeQualifiedV1(scope:scope,authenticatedInterpretationResponse:nil,lease:lease)
        let before=try XCTUnwrap(disk.data);_ = try ledger.stageOrdinary(scope:scope,original:original,lease:lease)
        disk.data=before;XCTAssertThrowsError(try ledger.pendingOrdinary(scope:scope));XCTAssertThrowsError(try ledger.stageOrdinary(scope:scope,original:original,lease:lease))
    }
    func testRejectedTerminalIsRetainedAndRevalidated()throws {
        let disk=FamilyDisk(),witness=FamilyWitness(),lease=FamilyLease(),source=try vectors(),vector=source[1]
        disk.data=try MobileControlSettlementLedger.genesisBytes();witness.value=try MobileControlSettlementLedger.genesisWitness()
        let scope=MobileControlSettlementLedger.Scope(serverDigest:String(repeating:"d",count:64),principal:UUID(uuidString:"00000000-0000-4000-8000-000000000002")!,endpoint:UUID(uuidString:"00000000-0000-4000-8000-000000000003")!,session:UUID()),ledger=MobileControlSettlementLedger(storage:disk,witness:witness)
        try ledger.upgradeQualifiedV1(scope:scope,authenticatedInterpretationResponse:nil,lease:lease)
        let original=try bytes(XCTUnwrap(vector["request"])),response=try bytes(XCTUnwrap(vector["response"]))
        _=try ledger.stageOrdinary(scope:scope,original:original,lease:lease)
        try ledger.appendAuthenticatedOrdinaryTerminal(scope:scope,response:response,lease:lease)
        XCTAssertEqual(try ledger.lastSettledControlOriginal(scope:scope),original)
        let reopened=MobileControlSettlementLedger(storage:disk,witness:witness)
        try reopened.revalidateAuthenticatedOrdinaryTerminal(scope:scope,response:response,lease:lease)
        let next=try bytes(XCTUnwrap(source[2]["request"]));XCTAssertNoThrow(try reopened.stageOrdinary(scope:scope,original:next,lease:lease))
    }
}
