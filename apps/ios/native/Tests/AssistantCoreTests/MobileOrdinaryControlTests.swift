import Foundation
import CryptoKit
import XCTest
@testable import AssistantCore

final class MobileOrdinaryControlTests: XCTestCase {
    func testCollectorEnumRequiresExactUTF8() throws {
        let ios=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let root=try XCTUnwrap(JSONSerialization.jsonObject(with:Data(contentsOf:ios.appendingPathComponent("test/mobile-ordinary-control-vectors.json"))) as? [String:Any])
        let vector=try XCTUnwrap((root["vectors"] as? [[String:Any]])?.first)
        func bytes(_ x:Any)throws->Data{try JSONSerialization.data(withJSONObject:x,options:[.sortedKeys,.withoutEscapingSlashes])}
        func hash(_ x:Data)->String{SHA256.hash(data:x).map{String(format:"%02x",$0)}.joined()}
        var request=try XCTUnwrap(vector["request"] as? [String:Any]),target=try XCTUnwrap(request["target"] as? [String:Any]);target["collector"]="health\u{212A}it";request["target"]=target
        let original=try bytes(request),parsed=try MobileControlOriginal.parse(original)
        XCTAssertThrowsError(try MobileOrdinaryControl.envelope(original:original,operation:.control))
        var response=try XCTUnwrap(vector["response"] as? [String:Any]),result=try XCTUnwrap(response["result"] as? [String:Any]),binding=try XCTUnwrap(result["binding"] as? [String:Any]),control=try XCTUnwrap(result["control"] as? [String:Any]),outcome=try XCTUnwrap(control["result"] as? [String:Any]),receipt=try XCTUnwrap(outcome["receipt"] as? [String:Any]),applied=try XCTUnwrap(receipt["result"] as? [String:Any]),enrollment=try XCTUnwrap(applied["enrollment"] as? [String:Any])
        enrollment["collector"]="health\u{212A}it";applied["enrollment"]=enrollment;receipt["result"]=applied;outcome["receipt"]=receipt;outcome["originalRequest"]=request;outcome["requestDigest"]=parsed.digest;control["result"]=outcome;result["control"]=control
        binding["reservationDigest"]=hash(try bytes(["requestDigest":parsed.digest,"state":"pending","attemptStarted":0,"selection":NSNull(),"outcome":NSNull()]));result["binding"]=binding;response["result"]=result
        XCTAssertEqual(MobileOrdinaryControl.assessTerminal(response:try bytes(response),original:original),.held)
        var receiptOnly=try XCTUnwrap(vector["response"] as? [String:Any]),receiptResult=try XCTUnwrap(receiptOnly["result"] as? [String:Any]),receiptControl=try XCTUnwrap(receiptResult["control"] as? [String:Any]),receiptOutcome=try XCTUnwrap(receiptControl["result"] as? [String:Any]),onlyReceipt=try XCTUnwrap(receiptOutcome["receipt"] as? [String:Any]),onlyApplied=try XCTUnwrap(onlyReceipt["result"] as? [String:Any]),onlyEnrollment=try XCTUnwrap(onlyApplied["enrollment"] as? [String:Any])
        onlyEnrollment["collector"]="health\u{212A}it";onlyApplied["enrollment"]=onlyEnrollment;onlyReceipt["result"]=onlyApplied;receiptOutcome["receipt"]=onlyReceipt;receiptControl["result"]=receiptOutcome;receiptResult["control"]=receiptControl;receiptOnly["result"]=receiptResult
        XCTAssertEqual(MobileOrdinaryControl.assessTerminal(response:try bytes(receiptOnly),original:try bytes(XCTUnwrap(vector["request"]))),.held)
    }
    func testProducerAcceptsExactHealthConnectAndValidNonBMPSource() throws {
        let ios=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let root=try XCTUnwrap(JSONSerialization.jsonObject(with:Data(contentsOf:ios.appendingPathComponent("test/mobile-ordinary-control-vectors.json"))) as? [String:Any])
        let vectors=try XCTUnwrap(root["vectors"] as? [[String:Any]])
        func bytes(_ x:Any)throws->Data{try JSONSerialization.data(withJSONObject:x,options:[.sortedKeys,.withoutEscapingSlashes])}
        func hash(_ x:Data)->String{SHA256.hash(data:x).map{String(format:"%02x",$0)}.joined()}
        for index in [0,4] {
            let vector=vectors[index]
            var request=try XCTUnwrap(vector["request"] as? [String:Any])
            var response=try XCTUnwrap(vector["response"] as? [String:Any]), result=try XCTUnwrap(response["result"] as? [String:Any]), binding=try XCTUnwrap(result["binding"] as? [String:Any]), control=try XCTUnwrap(result["control"] as? [String:Any]), outcome=try XCTUnwrap(control["result"] as? [String:Any]), receipt=try XCTUnwrap(outcome["receipt"] as? [String:Any]), applied=try XCTUnwrap(receipt["result"] as? [String:Any]), enrollment=try XCTUnwrap(applied["enrollment"] as? [String:Any])
            if index == 0 {
                var target=try XCTUnwrap(request["target"] as? [String:Any]);target["collector"]="healthConnect";request["target"]=target;enrollment["collector"]="healthConnect"
            } else {
                var action=try XCTUnwrap(request["action"] as? [String:Any]), configuration=try XCTUnwrap(action["configuration"] as? [String:Any]);configuration["preferredSource"]="😀";action["configuration"]=configuration;request["action"]=action
                var current=try XCTUnwrap(enrollment["configuration"] as? [String:Any]);current["preferredSource"]="😀";enrollment["configuration"]=current
            }
            let original=try bytes(request), parsed=try MobileControlOriginal.parse(original)
            applied["enrollment"]=enrollment;receipt["result"]=applied;outcome["receipt"]=receipt;outcome["originalRequest"]=request;outcome["requestDigest"]=parsed.digest;control["result"]=outcome;result["control"]=control
            binding["reservationDigest"]=hash(try bytes(["requestDigest":parsed.digest,"state":"pending","attemptStarted":0,"selection":NSNull(),"outcome":NSNull()]));result["binding"]=binding;response["result"]=result
            XCTAssertNoThrow(try MobileOrdinaryControl.envelope(original:original,operation:.control))
            XCTAssertEqual(MobileOrdinaryControl.assessTerminal(response:try bytes(response),original:original),.applied)
        }
    }
    func testFrozenProducerVectors() throws {
        let ios = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: ios.appendingPathComponent("test/mobile-ordinary-control-vectors.json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let positives = try XCTUnwrap(root["vectors"] as? [[String: Any]])
        let negatives = try XCTUnwrap(root["negative"] as? [[String: Any]])
        XCTAssertEqual(positives.count, 6); XCTAssertEqual(negatives.count, 8)
        func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) }
        for vector in positives {
            let original = try bytes(XCTUnwrap(vector["request"])), response = try bytes(XCTUnwrap(vector["response"]))
            XCTAssertNoThrow(try MobileControlOriginal.parse(original), "original parse")
            let status: MobileOrdinaryControl.Settlement = (vector["case"] as? String)?.hasSuffix("-applied") == true ? .applied : .rejected
            XCTAssertEqual(MobileOrdinaryControl.assessTerminal(response: response, original: original), status, "\(vector["case"] ?? "")")
            XCTAssertEqual(try MobileOrdinaryControl.terminalIdentity(response: response, original: original), vector["terminalIdentity"] as? String)
            XCTAssertNoThrow(try MobileOrdinaryControl.envelope(original: original, operation: .reconcile))
            var changed = try XCTUnwrap(vector["response"] as? [String: Any]); var result = try XCTUnwrap(changed["result"] as? [String: Any]); var control = try XCTUnwrap(result["control"] as? [String: Any]); var outcome = try XCTUnwrap(control["result"] as? [String: Any])
            outcome["current"] = vector["changedCurrent"]; control["result"] = outcome; result["control"] = control; changed["result"] = result
            XCTAssertEqual(try MobileOrdinaryControl.terminalIdentity(response: bytes(changed), original: original), vector["terminalIdentity"] as? String)
        }
        for vector in negatives {
            XCTAssertEqual(MobileOrdinaryControl.assessTerminal(response: try bytes(XCTUnwrap(vector["response"])), original: try bytes(XCTUnwrap(vector["request"]))), .held, "\(vector["case"] ?? "")")
        }
    }
}
