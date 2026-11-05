import Foundation
import XCTest
@testable import AssistantCore
final class MobileSharedItemTests:XCTestCase {
    private let sentinel="__NATIVE_UNPAIRED_SURROGATE__"
    private func fixture()throws->[String:Any] {let ios=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent(),raw=try String(contentsOf:ios.appendingPathComponent("test/mobile-shared-item-fixtures/shared-item-pairs.json"),encoding:.utf8),safe=raw.replacingOccurrences(of:"\\ud800",with:sentinel);return try XCTUnwrap(JSONSerialization.jsonObject(with:Data(safe.utf8)) as? [String:Any])}
    private func data(_ value:Any)throws->Data {let encoded=try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes]),string=try XCTUnwrap(String(data:encoded,encoding:.utf8));return Data(string.replacingOccurrences(of:sentinel,with:"\\ud800").utf8)}
    private func equal(_ a:[String:Any]?,_ b:Any,_ label:String,file:StaticString=#filePath,line:UInt=#line) {if b is NSNull {XCTAssertNil(a,label,file:file,line:line)} else {XCTAssertNotNil(a,label,file:file,line:line);XCTAssertTrue(NSDictionary(dictionary:a ?? [:]).isEqual(to:b as? [AnyHashable:Any] ?? [:]),label,file:file,line:line)}}
    func testProducerPairsAndAdversarialVectors()throws {
        let f=try fixture(),pairs=try XCTUnwrap(f["pairs"] as? [[String:Any]]),adversarial=try XCTUnwrap(f["adversarial"] as? [[String:Any]]);XCTAssertEqual(pairs.count,7);XCTAssertEqual(adversarial.count,38)
        for pair in pairs {let name=try XCTUnwrap(pair["case"] as? String),bytes=(pair["bytesBase64"] as? String).flatMap{Data(base64Encoded:$0)};for platform in ["ios","android"] {let input=try XCTUnwrap(pair[platform]),value=try MobileSharedItem.decode(data(input));XCTAssertTrue(NSDictionary(dictionary:try XCTUnwrap(JSONSerialization.jsonObject(with:value.data) as? [String:Any])).isEqual(to:try XCTUnwrap(input as? [AnyHashable:Any])),name);equal(MobileSharedItem.verify(value,bytes:bytes),try XCTUnwrap(pair["expectedIntegrity"]),name)}}
        for vector in adversarial {let name=try XCTUnwrap(vector["case"] as? String),input=try XCTUnwrap(vector["item"]),valid=try XCTUnwrap(vector["validItem"] as? Bool),value=try? MobileSharedItem.decode(data(input));XCTAssertEqual(value != nil,valid,name);if let value {let bytes=(vector["bytesBase64"] as? String).flatMap{Data(base64Encoded:$0)};equal(MobileSharedItem.verify(value,bytes:bytes),try XCTUnwrap(vector["expectedIntegrity"]),name)}}
    }
    func testEmptyDataIsDistinctFromMissingBytes()throws {
        let f=try fixture(),pairs=try XCTUnwrap(f["pairs"] as? [[String:Any]]),pair=try XCTUnwrap(pairs.first{($0["case"] as? String)=="empty-file-reference"}),item=try MobileSharedItem.decode(data(XCTUnwrap(pair["ios"])))
        XCTAssertNil(MobileSharedItem.verify(item,bytes:nil));XCTAssertEqual(MobileSharedItem.verify(item,bytes:Data())?["byteLength"] as? Int,0)
    }
    func testProducerURLCharacterAndEmptyUserInfoParity()throws {
        let f=try fixture(),pairs=try XCTUnwrap(f["pairs"] as? [[String:Any]]),base=try XCTUnwrap(pairs[0]["ios"] as? [String:Any])
        for url in ["http://example.com/<","http://example.com/>","http://example.com/\"","http://example.com/{x}","http://example.com/|","http://example.com/^","http://example.com/`","http://example.com/?x=[1]"] {var item=base;item["content"]=["kind":"url","mediaType":"text/uri-list","url":url,"title":NSNull()];XCTAssertThrowsError(try MobileSharedItem.decode(data(item)),url)}
        var item=base;item["content"]=["kind":"url","mediaType":"text/uri-list","url":"http://@example.com/","title":NSNull()];XCTAssertNoThrow(try MobileSharedItem.decode(data(item)))
    }
    func testProducerURLNumericAndIPv6HostParity()throws {
        let f=try fixture(),pairs=try XCTUnwrap(f["pairs"] as? [[String:Any]]),base=try XCTUnwrap(pairs[0]["ios"] as? [String:Any])
        let rejected=["http://999.999.999.999/","http://256.1.1.1/","http://4294967296/","http://0x100000000/","http://09/","http://1.2.3.4.5/","http://+1.2/","http://[fe80::1%25en0]/","http://[:::]/","http://example.123/","http://example.com/#a#b"]
        for url in rejected {var item=base;item["content"]=["kind":"url","mediaType":"text/uri-list","url":url,"title":NSNull()];XCTAssertThrowsError(try MobileSharedItem.decode(data(item)),url)}
        for url in ["http://[::1]/","http://127.1/","http://:@example.com/","http://%65xample.com/","http://%E2%98%83.net/"] {var item=base;item["content"]=["kind":"url","mediaType":"text/uri-list","url":url,"title":NSNull()];XCTAssertNoThrow(try MobileSharedItem.decode(data(item)),url)}
    }
    func testProducerExtraSlashURLPreservesOriginalText()throws {
        let f=try fixture(),pairs=try XCTUnwrap(f["pairs"] as? [[String:Any]]),base=try XCTUnwrap(pairs[0]["ios"] as? [String:Any])
        for url in ["http:///example.com/","https:////example.com/"] {var item=base;item["content"]=["kind":"url","mediaType":"text/uri-list","url":url,"title":NSNull()];let value=try MobileSharedItem.decode(data(item));let root=try XCTUnwrap(JSONSerialization.jsonObject(with:value.data) as? [String:Any]),content=try XCTUnwrap(root["content"] as? [String:Any]);XCTAssertEqual(content["url"] as? String,url)}
    }
}
