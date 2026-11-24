import Foundation
import XCTest
@testable import AssistantCore
final class MobileHealthControlTests:XCTestCase {
 let id=UUID(uuidString:"00000000-0000-4000-8000-000000000001")!,source=UUID(uuidString:"00000000-0000-4000-8000-000000000002")!
 func object(_ bytes:Data)throws->[String:Any]{try XCTUnwrap(JSONSerialization.jsonObject(with:bytes) as? [String:Any])}
 func testExplicitBindingAndRevision()throws{
  let r=try object(MobileHealthControl.bind(enrollment:id,revision:4,binding:.existing(source)));XCTAssertEqual(r["operation"] as? String,"bindSource");let p=try XCTUnwrap(r["payload"] as? [String:Any]);XCTAssertEqual(p["expectedRevision"] as? Int,4);XCTAssertEqual((p["binding"] as? [String:String])?["sourceNamespace"],source.uuidString.lowercased());XCTAssertEqual((r["producerPin"] as? [String:String])?["digest"],MobileHealthEncoder.schemaSHA256);XCTAssertThrowsError(try MobileHealthControl.bind(enrollment:id,revision:0,binding:.createNew))
 }
 func testConfigurationKeepsCollectionAndUseIndependent()throws{
  let c=MobileHealthControl.Configuration(categories:["SleepSegment"],uses:["answers"],assistants:[id],collectionPaused:true,usePaused:false,preferredSource:"synthetic"),r=try object(MobileHealthControl.configure(enrollment:id,revision:8,state:.disconnected,configuration:c)),p=try XCTUnwrap(r["payload"] as? [String:Any]),o=try XCTUnwrap(p["configuration"] as? [String:Any]);XCTAssertEqual(p["state"] as? String,"disconnected");XCTAssertEqual(o["collectionPaused"] as? Bool,true);XCTAssertEqual(o["usePaused"] as? Bool,false);XCTAssertEqual(o["preferredSource"] as? String,"synthetic")
 }
 func testInvalidScopesRejectedAndRemovalIsWholeSource()throws{
  let c=MobileHealthControl.Configuration(categories:["other"],uses:[],assistants:[],collectionPaused:true,usePaused:true);XCTAssertThrowsError(try MobileHealthControl.configure(enrollment:id,revision:1,state:.active,configuration:c));let r=try object(MobileHealthControl.removeAllImported(enrollment:id,revision:2));XCTAssertEqual(r["operation"] as? String,"remove");XCTAssertEqual(Set((r["payload"] as! [String:Any]).keys),["enrollmentId","expectedRevision"])
 }
}
