import Foundation
import CoreFoundation
import XCTest
@testable import AssistantCore
final class MobileLocationObservationTests:XCTestCase {
    private func fixture()throws->[String:Any] {let ios=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent();return try XCTUnwrap(JSONSerialization.jsonObject(with:Data(contentsOf:ios.appendingPathComponent("test/mobile-location-fixtures/location-observation-pairs.json"))) as? [String:Any])}
    private func data(_ value:Any)throws->Data {try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes])}
    private func assess(_ value:MobileLocationObservation.Value,_ context:[String:Any])->[String:Any]? {guard Set(context.keys)==Set(["referenceAt","maximumAgeMs"]),let ref=context["referenceAt"] as? String,let n=context["maximumAgeMs"] as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue.rounded()==n.doubleValue,n.doubleValue>=0,n.doubleValue<=9007199254740991 else{return nil};return MobileLocationObservation.assess(value,referenceAt:ref,maximumAgeMs:n.int64Value)}
    private func equal(_ a:[String:Any]?,_ b:Any,file:StaticString=#filePath,line:UInt=#line) {if b is NSNull {XCTAssertNil(a,file:file,line:line)} else {XCTAssertNotNil(a,file:file,line:line);XCTAssertTrue(NSDictionary(dictionary:a ?? [:]).isEqual(to:b as? [AnyHashable:Any] ?? [:]),"assessment differs",file:file,line:line)}}
    func testAllProducerPairedAndAdversarialVectors()throws {
        let f=try fixture(),pairs=try XCTUnwrap(f["pairs"] as? [[String:Any]]),adversarial=try XCTUnwrap(f["adversarial"] as? [[String:Any]]);XCTAssertEqual(pairs.count,7);XCTAssertEqual(adversarial.count,40)
        for pair in pairs {let context=try XCTUnwrap(pair["ageContext"] as? [String:Any]),expected=try XCTUnwrap(pair["expectedAge"]);for platform in ["ios","android"] {let input=try XCTUnwrap(pair[platform]),value=try MobileLocationObservation.decode(data(input));XCTAssertTrue(NSDictionary(dictionary:try XCTUnwrap(JSONSerialization.jsonObject(with:value.data) as? [String:Any])).isEqual(to:try XCTUnwrap(input as? [AnyHashable:Any])));equal(assess(value,context),expected)}}
        for vector in adversarial {let input=try XCTUnwrap(vector["observation"]),valid=try XCTUnwrap(vector["validObservation"] as? Bool),value=try? MobileLocationObservation.decode(data(input));XCTAssertEqual(value != nil,valid,"\(vector["case"] ?? "case")");if let value {let context=try XCTUnwrap(vector["ageContext"] as? [String:Any]);equal(assess(value,context),try XCTUnwrap(vector["expectedAge"]))}}
    }
    func testExtremeSpanExactAgeAndFuturePrecedence()throws {
        let f=try fixture(),pairs=try XCTUnwrap(f["pairs"] as? [[String:Any]]);var observation=try XCTUnwrap(pairs[0]["ios"] as? [String:Any]);observation["observedAt"]="0001-01-01T00:00:00.000000001Z";observation["collectedAt"]="9999-12-31T23:59:59.999999999Z";let value=try MobileLocationObservation.decode(data(observation)),age=try XCTUnwrap(MobileLocationObservation.assess(value,referenceAt:"9999-12-31T23:59:59.999999999Z",maximumAgeMs:9007199254740991));XCTAssertEqual(age["ageNanoseconds"] as? String,"315537897599999999998");XCTAssertEqual(age["state"] as? String,"fresh")
        XCTAssertNil(MobileLocationObservation.assess(value,referenceAt:"2026-01-01T00:00:00Z",maximumAgeMs:-1));XCTAssertNil(MobileLocationObservation.Instant.parse("2026-02-29T00:00:00Z"));XCTAssertNil(MobileLocationObservation.Instant.parse("2024-01-01T00:00:60Z"))
    }
    func testTypedPositionRetainsReportedUncertaintyAndSource()throws {
        let f=try fixture(),pairs=try XCTUnwrap(f["pairs"] as? [[String:Any]]),value=try MobileLocationObservation.decode(data(XCTUnwrap(pairs[0]["ios"])))
        XCTAssertEqual(value.source.collector,"coreLocation");XCTAssertEqual(value.observedAt,"2026-10-30T00:00:00Z");XCTAssertEqual(value.collectedAt,"2026-10-30T00:00:00.100000000Z")
        if case .position(let latitude,let longitude,.reported(let meters,.unspecified)) = value.observation {XCTAssertEqual(latitude,47.6205123456789);XCTAssertEqual(longitude,-122.3493123456789);XCTAssertEqual(meters,8.25)} else {XCTFail("expected reported position with unspecified confidence")}
    }
}
