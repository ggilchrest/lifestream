import Foundation
import CryptoKit
import XCTest
@testable import AssistantCore

final class MobileLocationDeliveryTests:XCTestCase {
    private func sha(_ d:Data)->String {SHA256.hash(data:d).map{String(format:"%02x",$0)}.joined()}
    private func expand(_ raw:Any?)throws->Data {let pieces=try XCTUnwrap(raw as? [[String:Any]]);var out=Data();for p in pieces {if let s=p["base64"] as? String {let value=try XCTUnwrap(Data(base64Encoded:s));XCTAssertEqual(value.base64EncodedString(),s);out.append(value)}else{let byte=try XCTUnwrap(p["repeatByte"] as? Int),count=try XCTUnwrap(p["count"] as? Int);guard (0...255).contains(byte),(0...300000).contains(count) else{throw NSError(domain:"fixture",code:1)};out.append(Data(repeating:UInt8(byte),count:count))}};return out}
    func testFrozenCatalogActualByteConformance()throws {
        let ios=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent(),path=ios.appendingPathComponent("test/mobile-location-fixtures/location-delivery-vectors.json"),catalogData=try Data(contentsOf:path),catalogHash=sha(catalogData);XCTAssertEqual(catalogHash,"9480671ae5528f869b420874a02c99ec5029c874079f2492306f94278452fa79")
        let catalog=try XCTUnwrap(JSONSerialization.jsonObject(with:catalogData) as? [String:Any]),cases=try XCTUnwrap(catalog["cases"] as? [[String:Any]]);XCTAssertEqual(cases.count,98);let directory=ProcessInfo.processInfo.environment["LS108_TRACE_DIR"].map{URL(fileURLWithPath:$0,isDirectory:true)};var seen=Set<String>()
        for c in cases {
            let id=try XCTUnwrap(c["caseID"] as? String),mode=try XCTUnwrap(c["mode"] as? String),kind=c["kind"] as? String,input=try expand(c["inputSegments"]);XCTAssertTrue(seen.insert(id).inserted,id);XCTAssertEqual(input.count,c["expectedInputByteLength"] as? Int,id);XCTAssertEqual(sha(input),c["expectedInputSHA256"] as? String,id)
            var admitted=false,carrier:MobileLocationDelivery.Carrier?,attempts=0,match:String?
            switch mode {case "contract":let result=MobileLocationDelivery.parse(input,kind:kind ?? "");carrier=result.carrier;attempts=result.base64DecodeAttempts;admitted=carrier != nil
            case "lexicalWire":admitted=MobileLocationDelivery.lexical(input,wire:true)
            case "lexicalObservation":admitted=MobileLocationDelivery.lexical(input,wire:false)
            case "consumerPin":admitted=MobileLocationDelivery.consumerPin(input)
            default:XCTFail("unknown mode \(id)")}
            if input.count>262144 && mode=="contract" {XCTAssertEqual(attempts,0,id)}
            if let segments=c["originalItemSegments"],let receipt=carrier {let raw=try expand(segments),original=MobileLocationDelivery.parse(raw,kind:"LocationDeliveryItem");if let first=original.carrier?.items.first {match=MobileLocationDelivery.match(first,receipt)}}
            XCTAssertEqual(admitted,c["expectedAdmission"] as? Bool,id);if let expected=c["expectedMatchOutcomeDataOnly"] as? String {XCTAssertEqual(match,expected,id)}
            let items:[[String:Any]]=carrier?.items.map{["originalObservationBase64":$0.originalObservationData.base64EncodedString(),"originalObservationSHA256":sha($0.originalObservationData),"originalObservationByteLength":$0.originalObservationData.count,"requestPreimageHex":$0.requestPreimage.map{String(format:"%02x",$0)}.joined(),"requestSHA256":$0.requestSHA256]} ?? []
            let row:[String:Any]=["schemaVersion":"1.0.0","caseID":id,"mode":mode,"kind":kind as Any? ?? NSNull(),"producerPin":MobileLocationDelivery.pin,"rawPin":MobileLocationDelivery.rawPin,"catalogSha256":catalogHash,"inputDocumentBase64":input.base64EncodedString(),"inputSHA256":sha(input),"inputByteLength":input.count,"admitted":admitted,"originalWireBase64":carrier?.originalWireData.base64EncodedString() as Any? ?? NSNull(),"originalWireSHA256":carrier.map{sha($0.originalWireData)} as Any? ?? NSNull(),"originalWireByteLength":carrier?.originalWireData.count as Any? ?? NSNull(),"items":items,"receiptPreimageHex":carrier?.receiptPreimage.map{$0.map{String(format:"%02x",$0)}.joined()} as Any? ?? NSNull(),"receiptSHA256":carrier?.receiptSHA256 as Any? ?? NSNull(),"matchOutcomeDataOnly":match as Any? ?? NSNull(),"base64DecodeAttempts":attempts]
            if let directory {try JSONSerialization.data(withJSONObject:row,options:[.sortedKeys]).write(to:directory.appendingPathComponent(id+".json"),options:.withoutOverwriting)}
        }
    }
}
