import Foundation
import XCTest
@testable import AssistantCore
final class MobileInterpretationTests:XCTestCase {
    func data(_ o:Any)throws->Data {try JSONSerialization.data(withJSONObject:o,options:[.sortedKeys,.withoutEscapingSlashes])}
    func uuid()->String {UUID().uuidString.lowercased()}
    func testPinnedPreviewAndReviewedOriginalBinding() throws {
        let principal=UUID(),endpoint=UUID(),enrollment=uuid(),assistant=uuid(),namespace=uuid(),op=uuid(),digest=String(repeating:"a",count:64)
        let query:[String:Any]=["enrollmentId":enrollment,"assistantId":assistant,"startAt":"2026-10-29T00:00:00Z","endAt":"2026-10-30T00:00:00Z"]
        let change:[String:Any]=["kind":"select","choiceDigest":digest]
        let expected:[String:Any]=["schemaVersion":"1.0.0","operation":"preview","operationId":op,"query":query,"expectedSourceRevision":2,"expectedInterpretationRevision":0,"change":change]
        let target:[String:Any]=["scope":["principalId":principal.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":namespace],"endpointId":endpoint.uuidString.lowercased(),"enrollmentId":enrollment,"assistantId":assistant]
        let config:[String:Any]=["categories":["SleepSegment"],"uses":["answers"],"assistantIds":[assistant],"collectionPaused":true,"usePaused":false]
        let original:[String:Any]=["schemaVersion":"1.0.0","operationId":op,"target":["principalId":principal.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","enrollmentId":enrollment,"sourceNamespace":namespace,"expectedRevision":2],"action":["kind":"configure","state":"active","configuration":config]]
        let summary:[String:Any]=["algorithmVersion":"sleep-union/1","timeBasis":"elapsedUTC","coverage":"unknown","totalAsleepMs":NSNull(),"sessions":[],"excludedNonSleepRecords":0,"excludedNonOverlappingSleepRecords":0,"deduplication":"same-source-interval-union","limitations":[]]
        let provenance:[String:Any]=["datasetDigest":digest,"policyBindingDigest":digest,"sourceSafetyEpoch":0,"records":[],"readState":"boundedComplete","timeBasis":"elapsedUTC","limitations":[]]
        var result:[String:Any]=["state":"ready","operationId":op,"query":query,"target":target,"sourceRevision":2,"interpretationRevision":0,"nextInterpretationRevision":1,"change":change,"beforeChoiceDigest":NSNull(),"afterChoiceDigest":digest,"before":summary,"after":summary,"provenance":provenance,"reviewDigest":digest,"controlOriginal":original,"limitations":[]]
        let pin:[String:String]=["schemaId":MobileInterpretationSchema.schemaId,"schemaVersion":"1.0.0","digest":MobileInterpretationSchema.digest]
        func response(_ result:[String:Any],_ pin:[String:String])throws->Data {try data(["schemaVersion":"1.0.0","producerPin":pin,"result":result])}
        let read=try MobileInterpretation.decodeRead(response(result,pin),expectedPayload:data(expected),principal:principal,endpoint:endpoint),preview=try XCTUnwrap(read.preview)
        let envelope=try MobileInterpretation.reviewedEnvelope(preview:preview,stagedOriginal:preview.original);let obj=try XCTUnwrap(JSONSerialization.jsonObject(with:envelope) as? [String:Any]);XCTAssertEqual(obj["operation"] as? String,"interpretation")
        XCTAssertThrowsError(try MobileInterpretation.reviewedEnvelope(preview:preview,stagedOriginal:Data("{}".utf8)))
        XCTAssertThrowsError(try MobileInterpretation.decodeRead(response(result,pin),expectedPayload:data(expected),principal:UUID(),endpoint:endpoint))
        result["nextInterpretationRevision"]=2;XCTAssertThrowsError(try MobileInterpretation.decodeRead(response(result,pin),expectedPayload:data(expected),principal:principal,endpoint:endpoint))
        result["nextInterpretationRevision"]=1
        for malformed:Any in [NSNull(), "unexpected", 42, false] {
            result["controlOriginal"]=malformed
            XCTAssertThrowsError(try MobileInterpretation.decodeRead(response(result,pin),expectedPayload:data(expected),principal:principal,endpoint:endpoint))
        }
        var mismatched=original
        var otherTarget=try XCTUnwrap(mismatched["target"] as? [String:Any]);otherTarget["collector"]="healthConnect";mismatched["target"]=otherTarget
        result["controlOriginal"]=mismatched
        XCTAssertThrowsError(try MobileInterpretation.decodeRead(response(result,pin),expectedPayload:data(expected),principal:principal,endpoint:endpoint))
        result["controlOriginal"]=original
        var wrong=pin;wrong["digest"]=String(repeating:"b",count:64);XCTAssertThrowsError(try MobileInterpretation.decodeRead(response(result,wrong),expectedPayload:data(expected),principal:principal,endpoint:endpoint))
        let request=try MobileControlOriginal.parse(preview.original)
        let control:[String:Any]=["schemaVersion":"1.0.0","producerPin":["schemaId":MobileControlOriginal.schemaId,"schemaVersion":"1.0.0","digest":MobileControlOriginal.schemaSHA256],"result":["originalRequest":original,"requestDigest":request.digest,"current":["state":"current","policyRevision":2],"status":"pending"]]
        let pending:[String:Any]=["state":"mutation","controlResponse":control,"interpretationStatus":"pending","interpretationRevision":NSNull(),"operationId":op,"limitations":[]]
        if case .held = MobileInterpretation.assessMutation(try response(pending,pin),original:preview.original) {} else {XCTFail("pending must stay held")}
        var forged=pending;forged["interpretationStatus"]="applied";forged["interpretationRevision"]=1
        if case .held = MobileInterpretation.assessMutation(try response(forged,pin),original:preview.original) {} else {XCTFail("pending control cannot prove applied interpretation")}
        let enrollmentResult:[String:Any] = ["enrollmentId":enrollment,"principalId":principal.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":namespace,"revision":3,"state":"active","configuration":config]
        let receipt:[String:Any] = ["receiptId":uuid(),"committedAt":"2026-10-30T00:00:00Z","durability":"sqlCommit","result":["kind":"configure","enrollment":enrollmentResult]]
        let appliedControl:[String:Any] = ["schemaVersion":"1.0.0","producerPin":["schemaId":MobileControlOriginal.schemaId,"schemaVersion":"1.0.0","digest":MobileControlOriginal.schemaSHA256],"result":["originalRequest":original,"requestDigest":request.digest,"current":["state":"current","policyRevision":3],"status":"applied","receipt":receipt]]
        var applied=pending;applied["controlResponse"]=appliedControl;applied["interpretationStatus"]="applied";applied["interpretationRevision"]=1
        if case .applied(let revision) = MobileInterpretation.assessMutation(try response(applied,pin),original:preview.original,expectedRevision:1) {XCTAssertEqual(revision,1)} else {XCTFail("matching applied receipts should settle interpretation")}
        if case .held = MobileInterpretation.assessMutation(try response(applied,pin),original:preview.original,expectedRevision:2) {} else {XCTFail("wrong interpretation revision must stay held")}
        applied["operationId"]=uuid();if case .held = MobileInterpretation.assessMutation(try response(applied,pin),original:preview.original) {} else {XCTFail("wrong operation must stay held")}

    }
    func testInspectRejectsDuplicateCandidatesAndUnknownFields() throws {
        let principal=UUID(),endpoint=UUID(),enrollment=uuid(),assistant=uuid(),namespace=uuid(),digest=String(repeating:"a",count:64)
        let query:[String:Any]=["enrollmentId":enrollment,"assistantId":assistant,"startAt":"2026-10-29T00:00:00Z","endAt":"2026-10-30T00:00:00Z"]
        let payload:[String:Any]=["schemaVersion":"1.0.0","operation":"inspect","query":query]
        let target:[String:Any]=["scope":["principalId":principal.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":namespace],"endpointId":endpoint.uuidString.lowercased(),"enrollmentId":enrollment,"assistantId":assistant]
        let summary:[String:Any]=["algorithmVersion":"sleep-union/1","timeBasis":"elapsedUTC","coverage":"unknown","totalAsleepMs":NSNull(),"sessions":[],"excludedNonSleepRecords":0,"excludedNonOverlappingSleepRecords":0,"deduplication":"same-source-interval-union","limitations":[]]
        let provenance:[String:Any]=["datasetDigest":digest,"policyBindingDigest":digest,"sourceSafetyEpoch":0,"records":[],"readState":"boundedComplete","timeBasis":"elapsedUTC","limitations":[]]
        let candidate:[String:Any]=["choiceDigest":digest,"originalApp":NSNull(),"originalDevice":NSNull(),"recordCount":1]
        var result:[String:Any]=["state":"inspected","query":query,"target":target,"sourceRevision":1,"interpretationRevision":0,"preferredChoiceDigest":NSNull(),"candidates":[candidate],"summary":summary,"provenance":provenance,"history":[],"historyCoverage":"complete","limitations":[]]
        let pin:[String:String]=["schemaId":MobileInterpretationSchema.schemaId,"schemaVersion":"1.0.0","digest":MobileInterpretationSchema.digest]
        func response()throws->Data {try data(["schemaVersion":"1.0.0","producerPin":pin,"result":result])}
        XCTAssertEqual(try MobileInterpretation.decodeRead(response(),expectedPayload:data(payload),principal:principal,endpoint:endpoint).state,"inspected")
        result["candidates"]=[candidate,candidate];XCTAssertThrowsError(try MobileInterpretation.decodeRead(response(),expectedPayload:data(payload),principal:principal,endpoint:endpoint))
        result["candidates"]=[candidate];result["unexpectedGrant"]=true;XCTAssertThrowsError(try MobileInterpretation.decodeRead(response(),expectedPayload:data(payload),principal:principal,endpoint:endpoint))
    }
    func testInvalidWindowAndUnavailableResponse() throws {
        let query:[String:Any]=["enrollmentId":uuid(),"assistantId":uuid(),"startAt":"2026-10-01T00:00:00Z","endAt":"2026-12-01T00:00:00Z"]
        let payload:[String:Any]=["schemaVersion":"1.0.0","operation":"inspect","query":query]
        XCTAssertThrowsError(try MobileInterpretation.readEnvelope(payload:data(payload)))
        var valid=query;valid["endAt"]="2026-10-02T00:00:00Z";var input=payload;input["query"]=valid
        let pin:[String:String]=["schemaId":MobileInterpretationSchema.schemaId,"schemaVersion":"1.0.0","digest":MobileInterpretationSchema.digest]
        let unavailable:[String:Any]=["schemaVersion":"1.0.0","producerPin":pin,"result":["state":"incomplete","reason":"boundedRecords","advice":"reduceWindow","limitations":[]]]
        let result=try MobileInterpretation.decodeRead(data(unavailable),expectedPayload:data(input),principal:UUID(),endpoint:UUID())
        XCTAssertEqual(result.state,"incomplete");XCTAssertNil(result.preview)
    }
}
