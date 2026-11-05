import Foundation
import XCTest
@testable import AssistantCore
final class MobileHealthWireTests:XCTestCase {
 let id=UUID(uuidString:"BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB")!
 var pin:[String:String]{["schemaId":MobileHealthEncoder.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthEncoder.schemaSHA256]}
 func response(_ item:[String:Any],pin:[String:String]?=nil)throws->Data{try JSONSerialization.data(withJSONObject:["schemaVersion":"1.0.0","producerPin":pin ?? self.pin,"result":[item]])}
 func testRequestIncludesExactProducerPinAndIsBounded()throws{let batch=Data(#"{"schemaVersion":"1.0.0","changes":[]}"#.utf8),v=try JSONSerialization.jsonObject(with:MobileHealthWire.request(batch:batch)) as! [String:Any];XCTAssertEqual(v["producerPin"] as? [String:String],pin);XCTAssertEqual(v["operation"] as? String,"ingest")}
 func testOnlyValidDurableReceiptsCanBecomeAcknowledgements()throws{
  for (outcome,code) in [("accepted","applied"),("duplicate","deleted"),("retryable","unavailable"),("rejected","settingsChanged")]{let bytes=try response(["eventId":id.uuidString.lowercased(),"outcome":outcome,"code":code]);XCTAssertEqual(try MobileHealthWire.receipt(bytes).count,1)}
  for item:[String:Any] in [["eventId":id.uuidString.lowercased(),"outcome":"accepted","code":"unavailable"],["eventId":NSNull(),"outcome":"rejected","code":"invalid"],["eventId":id.uuidString,"outcome":"accepted","code":"applied"]] {XCTAssertThrowsError(try MobileHealthWire.receipt(response(item)))}
  XCTAssertThrowsError(try MobileHealthWire.receipt(response(["eventId":id.uuidString.lowercased(),"outcome":"accepted","code":"applied"],pin:["schemaId":MobileHealthEncoder.schemaId,"schemaVersion":"1.0.0","digest":"wrong"])))
 }
}
