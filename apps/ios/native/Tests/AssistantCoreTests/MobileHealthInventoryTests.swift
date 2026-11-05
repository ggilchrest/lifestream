import Foundation
import XCTest
@testable import AssistantCore

final class MobileHealthInventoryTests: XCTestCase {
 let principal=UUID(uuidString:"00000000-0000-4000-8000-000000000001")!, endpoint=UUID(uuidString:"00000000-0000-4000-8000-000000000002")!, namespace=UUID(uuidString:"00000000-0000-4000-8000-000000000003")!, enrollment=UUID(uuidString:"00000000-0000-4000-8000-000000000004")!
 func response(_ edit:(inout [String:Any],inout [String:Any],inout [String:Any])->Void = {_,_,_ in}) throws -> Data {
  let config:[String:Any]=["categories":["SleepSegment"],"uses":["answers"],"assistantIds":[],"collectionPaused":false,"usePaused":false]
  let current:[String:Any]=["enrollmentId":enrollment.uuidString.lowercased(),"principalId":principal.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":namespace.uuidString.lowercased(),"revision":3,"state":"active","configuration":config]
  var source:[String:Any]=["sourceNamespace":namespace.uuidString.lowercased(),"collector":"healthKit","policyRevision":3,"configuration":config,"enrollmentCount":2,"currentEndpointEnrollment":current,"coverage":["state":"unknown"]]
  var result:[String:Any]=["principalId":principal.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"unboundEnrollments":[],"nextCursor":NSNull()]
  var root:[String:Any]=["schemaVersion":"1.0.0","producerPin":["schemaId":MobileHealthInventory.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthInventory.schemaSHA256]]
  edit(&root,&result,&source); if result["sources"] == nil {result["sources"]=[source]}; root["result"]=result
  return try JSONSerialization.data(withJSONObject:root)
 }
 func parse(_ data:Data)throws->MobileHealthInventoryPage {try MobileHealthInventory.parse(data,expectedPrincipal:principal,expectedEndpoint:endpoint)}
 func testOwnerInventoryAndCrossDeviceSource()throws {
  let p=try parse(response());XCTAssertEqual(p.sources.count,1);XCTAssertEqual(p.sources[0].namespace,namespace);XCTAssertEqual(p.sources[0].enrollmentCount,2);XCTAssertEqual(p.sources[0].currentEnrollment,enrollment);XCTAssertEqual(p.sources[0].categories,["SleepSegment"]);XCTAssertNil(p.nextCursor)
  XCTAssertNil(try parse(response{_,_,s in s["currentEndpointEnrollment"]=NSNull()}).sources[0].currentEnrollment)
 }
 func testUnboundEnrollmentRetainsCollectorAndRevision()throws {
  let page=try parse(response {_,r,_ in
   let c:[String:Any]=["categories":[],"uses":[],"assistantIds":[],"collectionPaused":true,"usePaused":true]
   r["unboundEnrollments"]=[["enrollmentId":enrollment.uuidString.lowercased(),"principalId":principal.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":NSNull(),"revision":11,"state":"unbound","configuration":c]]
  })
  XCTAssertEqual(page.unboundEnrollments.count,1);XCTAssertEqual(page.unboundEnrollments[0].id,enrollment);XCTAssertEqual(page.unboundEnrollments[0].collector,"healthKit");XCTAssertEqual(page.unboundEnrollments[0].revision,11)
 }
 func testAssistantIdentifierStringsArePreserved()throws {
  let urn="urn:uuid:ABCDEF00-1234-4ABC-8DEF-123456ABCDEF"
  let page=try parse(response {_,_,s in var c=s["configuration"] as! [String:Any];c["assistantIds"]=[urn];s["configuration"]=c})
  XCTAssertEqual(page.sources[0].assistants,[urn])
 }
 func testPreferredSourceIsPreservedWhenAvailable()throws {
  let page=try parse(response {_,_,s in var c=s["configuration"] as! [String:Any];c["preferredSource"]="synthetic-source";s["configuration"]=c})
  XCTAssertEqual(page.sources[0].preferredSource,"synthetic-source")
 }
 func testBoundButDisconnectedDoesNotBecomeUnbound()throws {
  let page=try parse(response {_,_,s in var e=s["currentEndpointEnrollment"] as! [String:Any];e["state"]="disconnected";s["currentEndpointEnrollment"]=e})
  XCTAssertEqual(page.sources[0].currentEnrollment,enrollment)
  XCTAssertEqual(page.sources[0].currentState,"disconnected")
  XCTAssertEqual(page.sources[0].uses,["answers"])
  XCTAssertTrue(page.unboundEnrollments.isEmpty)
 }
 func testBoundEnrollmentMustMatchSourceRevisionAndOwner()throws {
  for mutation: (inout [String:Any])->Void in [
   { $0["revision"]=4 },
   { $0["sourceNamespace"]="00000000-0000-4000-8000-000000000099" },
   { $0["state"]="unbound" },
   { $0["principalId"]="00000000-0000-4000-8000-000000000099" },
   { $0["endpointId"]="00000000-0000-4000-8000-000000000099" }
  ] { XCTAssertThrowsError(try parse(response {_,_,s in var e=s["currentEndpointEnrollment"] as! [String:Any];mutation(&e);s["currentEndpointEnrollment"]=e})) }
 }
 func testRequestUsesIndependentPinAndValidatesCursor()throws {
  let r=try XCTUnwrap(JSONSerialization.jsonObject(with:MobileHealthInventory.request(cursor:"next")) as? [String:Any]);XCTAssertEqual(r["operation"] as? String,"inventory");XCTAssertEqual((r["producerPin"] as? [String:String])?["digest"],MobileHealthInventory.schemaSHA256);XCTAssertThrowsError(try MobileHealthInventory.request(cursor:"\n"))
 }
 func testRejectsForeignOwnerUnexpectedDataAndUnknownPin()throws {
  XCTAssertThrowsError(try MobileHealthInventory.parse(response(),expectedPrincipal:UUID(),expectedEndpoint:endpoint));XCTAssertThrowsError(try MobileHealthInventory.parse(response(),expectedPrincipal:principal,expectedEndpoint:UUID()))
  for edit:(inout [String:Any],inout [String:Any],inout [String:Any])->Void in [{r,_,_ in r["producerPin"]=[:]},{_,r,_ in r["healthValues"]=[]},{_,_,s in s["coverage"]=["state":"complete"]},{_,_,s in s["coverage"]=["state":"unknown","samples":4]},{_,_,s in s["enrollmentCount"]=true},{_,r,s in r["sources"]=[s,s]},{_,_,s in s["currentEndpointEnrollment"]=[:] }] {XCTAssertThrowsError(try parse(response(edit)))}
 }
}
