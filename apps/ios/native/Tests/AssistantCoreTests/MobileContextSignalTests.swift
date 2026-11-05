import Foundation
import CoreFoundation
import XCTest
@testable import AssistantCore
final class MobileContextSignalTests:XCTestCase {
    private let sentinel="__NATIVE_UNPAIRED_SURROGATE__"
    private func fixture()throws->[String:Any] {let ios=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent(),raw=try String(contentsOf:ios.appendingPathComponent("test/mobile-signal-fixtures/context-signal-pairs.json"),encoding:.utf8),safe=raw.replacingOccurrences(of:"\\ud800",with:sentinel);return try XCTUnwrap(JSONSerialization.jsonObject(with:Data(safe.utf8)) as? [String:Any])}
    private func data(_ value:Any)throws->Data {let encoded=try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes]),string=try XCTUnwrap(String(data:encoded,encoding:.utf8));return Data(string.replacingOccurrences(of:sentinel,with:"\\ud800").utf8)}
    private func assess(_ value:MobileContextSignal.Value,_ context:[String:Any])->[String:Any]? {guard Set(context.keys)==Set(["referenceAt","maximumAgeMs"]),let ref=context["referenceAt"] as? String,let n=context["maximumAgeMs"] as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue.rounded()==n.doubleValue,n.doubleValue>=0,n.doubleValue<=9007199254740991 else{return nil};return MobileContextSignal.assess(value,referenceAt:ref,maximumAgeMs:n.int64Value)}
    private func equal(_ a:[String:Any]?,_ b:Any,_ label:String,file:StaticString=#filePath,line:UInt=#line) {if b is NSNull {XCTAssertNil(a,label,file:file,line:line)} else {XCTAssertNotNil(a,label,file:file,line:line);XCTAssertTrue(NSDictionary(dictionary:a ?? [:]).isEqual(to:b as? [AnyHashable:Any] ?? [:]),label,file:file,line:line)}}
    func testProducerPairsAndAdversarialVectors()throws {
        let f=try fixture(),pairs=try XCTUnwrap(f["pairs"] as? [[String:Any]]),adversarial=try XCTUnwrap(f["adversarial"] as? [[String:Any]]);XCTAssertEqual(pairs.count,7);XCTAssertEqual(adversarial.count,35)
        for pair in pairs {let name=try XCTUnwrap(pair["case"] as? String),context=try XCTUnwrap(pair["ageContext"] as? [String:Any]);for platform in ["ios","android"] {let input=try XCTUnwrap(pair[platform]),value=try MobileContextSignal.decode(data(input));XCTAssertTrue(NSDictionary(dictionary:try XCTUnwrap(JSONSerialization.jsonObject(with:value.data) as? [String:Any])).isEqual(to:try XCTUnwrap(input as? [AnyHashable:Any])),name);equal(MobileContextSignal.view(value),try XCTUnwrap(pair["expectedView"]),name);equal(assess(value,context),try XCTUnwrap(pair["expectedAge"]),name)}}
        for vector in adversarial {let name=try XCTUnwrap(vector["case"] as? String),input=try XCTUnwrap(vector["observation"]),valid=try XCTUnwrap(vector["validObservation"] as? Bool),value=try? MobileContextSignal.decode(data(input));XCTAssertEqual(value != nil,valid,name);if let value {equal(MobileContextSignal.view(value),try XCTUnwrap(vector["expectedView"]),name);equal(assess(value,try XCTUnwrap(vector["ageContext"] as? [String:Any])),try XCTUnwrap(vector["expectedAge"]),name)}}
    }
    func testTypedDeclarationIsNotExecutionEvidence()throws {
        let f=try fixture(),pairs=try XCTUnwrap(f["pairs"] as? [[String:Any]]),ios=try MobileContextSignal.decode(data(XCTUnwrap(pairs[0]["ios"]))),android=try MobileContextSignal.decode(data(XCTUnwrap(pairs[0]["android"])))
        if case .reported(let origin)=ios.declaration {XCTAssertEqual(origin,"userConfiguredAutomation")} else {XCTFail("expected reported origin")}
        if case .unknown(let reason)=android.declaration {XCTAssertEqual(reason,"notProvided")} else {XCTFail("expected unknown origin")}
        if case .focus(let id,let state)=ios.signal {XCTAssertEqual(id,"opaque-work-focus");XCTAssertEqual(state,"enabled")} else {XCTFail("expected focus data")}
        XCTAssertEqual(MobileContextSignal.view(ios)["qualification"] as? String,"declaredSignalOnly");XCTAssertEqual(ios.observedAt,"2026-10-30T00:00:00.000000001Z")
    }
}
