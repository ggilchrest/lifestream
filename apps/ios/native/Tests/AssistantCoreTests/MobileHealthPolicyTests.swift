import Foundation
import XCTest
@testable import AssistantCore
private final class PolicyMemory: HealthSnapshotStorage {var bytes:Data?;func read()throws->Data?{bytes};func replace(_ data:Data)throws{bytes=data}}
final class MobileHealthPolicyTests:XCTestCase {
 let principal=UUID(uuidString:"00000000-0000-4000-8000-000000000001")!,endpoint=UUID(uuidString:"00000000-0000-4000-8000-000000000002")!,enrollment=UUID(uuidString:"00000000-0000-4000-8000-000000000003")!,source="00000000-0000-4000-8000-000000000004"
 func response(_ edit:(inout [String:Any],inout [String:Any])->Void = {_,_ in})throws->Data{
  let config:[String:Any]=["categories":["SleepSegment","heartRate","hrvRMSSD"],"uses":["answers"],"assistantIds":[],"collectionPaused":false,"usePaused":false]
  var e:[String:Any]=["enrollmentId":enrollment.uuidString.lowercased(),"principalId":principal.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":source,"revision":7,"state":"active","configuration":config]
  var f:[String:Any]=["policyRevision":7,"sourceBound":true,"collectionAllowed":true,"categories":["SleepSegment","heartRate","hrvRMSSD"],"uses":["answers"],"assistantIds":[],"sourceNamespace":source];edit(&e,&f)
  return try JSONSerialization.data(withJSONObject:["schemaVersion":"1.0.0","producerPin":["schemaId":MobileHealthEncoder.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthEncoder.schemaSHA256],"result":["enrollment":e,"effective":f]])
 }
 func parse(_ data:Data)throws->MobileHealthPolicyProof{try MobileHealthPolicyParser.parse(data,expectedPrincipal:principal,expectedEndpoint:endpoint,expectedEnrollment:enrollment)}
 func testLocalRestrictionIsBoundAndNeverWidens()throws {
  let p=try parse(response()),operation=UUID().uuidString.lowercased()
  func request(_ categories:[String],_ paused:Bool,_ kind:String="configure",_ revision:Int=7)throws->Data {
   let target:[String:Any]=["principalId":principal.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","enrollmentId":enrollment.uuidString.lowercased(),"sourceNamespace":source,"expectedRevision":revision]
   let config:[String:Any]=["categories":categories,"uses":["answers","memory"],"assistantIds":[],"collectionPaused":paused,"usePaused":false]
   let action:[String:Any]=kind=="remove" ? ["kind":"remove","scope":"wholeSource"]:["kind":"configure","state":"active","configuration":config]
   return try JSONSerialization.data(withJSONObject:["schemaVersion":"1.0.0","operationId":operation,"target":target,"action":action])
  }
  let narrowed=try MobileHealthLocalRestriction.plan(original:request(["heartRate","respiratoryRate"],false),proof:p)
  XCTAssertFalse(narrowed.stopCollection);XCTAssertEqual(narrowed.keepHealthKitTypes,["heartRate"]);XCTAssertEqual(narrowed.keepUses,["answers"])
  XCTAssertTrue(try MobileHealthLocalRestriction.plan(original:request(["SleepSegment"],true),proof:p).stopCollection)
  let removed=try MobileHealthLocalRestriction.plan(original:request([],false,"remove"),proof:p);XCTAssertTrue(removed.stopCollection);XCTAssertTrue(removed.keepUses.isEmpty)
  XCTAssertThrowsError(try MobileHealthLocalRestriction.plan(original:request(["SleepSegment"],false,"configure",8),proof:p))
  var wrong=try JSONSerialization.jsonObject(with:request(["SleepSegment"],false)) as! [String:Any],target=wrong["target"] as! [String:Any];target["collector"]="healthConnect";wrong["target"]=target
  XCTAssertThrowsError(try MobileHealthLocalRestriction.plan(original:JSONSerialization.data(withJSONObject:wrong),proof:p))
  let mixed=try MobileHealthLocalRestriction.plan(original:request(["SleepSegment","hrvRMSSD"],true),proof:p)
  XCTAssertEqual(mixed.keepCategories,["SleepSegment","hrvRMSSD"]);XCTAssertTrue(mixed.keepHealthKitTypes.isEmpty);XCTAssertEqual(mixed.keepUses,["answers"])
  let empty=try MobileHealthLocalRestriction.plan(original:request([],false),proof:p);XCTAssertTrue(empty.stopCollection);XCTAssertTrue(empty.keepCategories.isEmpty)
  XCTAssertTrue(removed.keepCategories.isEmpty)
 }
 func testLocalRestrictionDoesNotTreatAssistantAliasesAsEqual()throws {
  let urn="urn:uuid:ABCDEF00-1234-4ABC-8DEF-123456ABCDEF",p=try parse(response{e,f in var c=e["configuration"] as! [String:Any];c["assistantIds"]=[urn];e["configuration"]=c;f["assistantIds"]=[urn]})
  let target:[String:Any]=["principalId":principal.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","enrollmentId":enrollment.uuidString.lowercased(),"sourceNamespace":source,"expectedRevision":7]
  let config:[String:Any]=["categories":["SleepSegment"],"uses":["answers"],"assistantIds":[urn.lowercased()],"collectionPaused":false,"usePaused":false]
  let request=try JSONSerialization.data(withJSONObject:["schemaVersion":"1.0.0","operationId":UUID().uuidString.lowercased(),"target":target,"action":["kind":"configure","state":"active","configuration":config]])
  XCTAssertTrue(try MobileHealthLocalRestriction.plan(original:request,proof:p).keepAssistants.isEmpty)
 }
 func testPolicyPreferredSourceUsesScalarLimitAndBindingIsConsistent()throws {
  let long=String(repeating:"🦉",count:1024)
  XCTAssertNoThrow(try parse(response{e,_ in var c=e["configuration"] as! [String:Any];c["preferredSource"]=long;e["configuration"]=c}))
  XCTAssertThrowsError(try parse(response{e,_ in var c=e["configuration"] as! [String:Any];c["preferredSource"]=long+"🦉";e["configuration"]=c}))
  XCTAssertThrowsError(try parse(response{e,f in e["sourceNamespace"]=NSNull();f["sourceNamespace"]=NSNull();f["sourceBound"]=false;f["collectionAllowed"]=false}))
  XCTAssertThrowsError(try parse(response{_,f in f["sourceBound"]=false;f["collectionAllowed"]=false}))
 }
 func testSharedAssistantIdentifiersArePreservedAndScopeIsExact()throws {
  let urn="urn:uuid:ABCDEF00-1234-4ABC-8DEF-123456ABCDEF"
  let p=try parse(response{e,f in var c=e["configuration"] as! [String:Any];c["assistantIds"]=[urn];e["configuration"]=c;f["assistantIds"]=[urn]})
  XCTAssertEqual(p.assistants,[urn])
  XCTAssertThrowsError(try parse(response{e,f in var c=e["configuration"] as! [String:Any];c["assistantIds"]=[urn];e["configuration"]=c;f["assistantIds"]=[urn.lowercased()]}))
 }
 func testBoundCurrentPolicyAndUnsupportedMeasurement()throws{let p=try parse(response());XCTAssertTrue(p.permitsCollection);XCTAssertEqual(p.sourceNamespace,source);XCTAssertEqual(p.healthKitTypes,["sleep","heartRate"]);XCTAssertEqual(p.revision,7)}
 func testWrongIdentityScopeOrContradictionNeverGrantsCollection()throws{
  XCTAssertThrowsError(try MobileHealthPolicyParser.parse(response(),expectedPrincipal:UUID(),expectedEndpoint:endpoint,expectedEnrollment:enrollment))
  for edit:((inout [String:Any],inout [String:Any])->Void) in [{e,_ in e["collector"]="healthConnect"},{_,f in f["policyRevision"]=8},{_,f in f["sourceNamespace"]="00000000-0000-4000-8000-000000000005"},{_,f in f["categories"]=["respiratoryRate"]},{_,f in f["sourceBound"]=1},{_,f in f["collectionAllowed"]=true;f["sourceBound"]=false},{e,_ in e["extra"]="unexpected"}] {XCTAssertThrowsError(try parse(response(edit)))}
 }
 func testDisconnectedDoesNotClaimCollectionButRetainsIndependentUses()throws{
  let p=try parse(response{e,f in e["state"]="disconnected";f["collectionAllowed"]=false});XCTAssertFalse(p.permitsCollection);XCTAssertTrue(p.sourceBound);XCTAssertEqual(p.uses,["answers"])
 }
 func testUnboundNeverEnablesCollection()throws{let p=try parse(response{e,f in e["state"]="unbound";e["sourceNamespace"]=NSNull();f["sourceNamespace"]=NSNull();f["sourceBound"]=false;f["collectionAllowed"]=false});XCTAssertFalse(p.permitsCollection);XCTAssertNil(p.sourceNamespace)}
 func testTypedPolicyIsRequiredToAdmitAndLaterDenialWithdraws()throws{
  let store=HealthOutbox(storage:PolicyMemory());try store.setHuman(principal);let proof=try parse(response())
  try store.enroll(proof:proof,selectedTypes:["sleep"]);let ticket=try store.ticket(enrollment:enrollment,type:"sleep")
  let denied=try parse(response{_,f in f["collectionAllowed"]=false})
  XCTAssertThrowsError(try store.confirmEffectivePolicy(proof:denied));XCTAssertThrowsError(try store.verify(ticket:ticket));XCTAssertThrowsError(try store.ticket(enrollment:enrollment,type:"sleep"))
  try store.confirmEffectivePolicy(proof:proof);XCTAssertNoThrow(try store.ticket(enrollment:enrollment,type:"sleep"))
 }
 func testDisabledPolicyCannotEnrollOrGrantATypeNotInEffectiveProof()throws{
  let store=HealthOutbox(storage:PolicyMemory());try store.setHuman(principal);let disabled=try parse(response{_,f in f["collectionAllowed"]=false})
  XCTAssertThrowsError(try store.enroll(proof:disabled,selectedTypes:["sleep"]))
  let proof=try parse(response());XCTAssertThrowsError(try store.enroll(proof:proof,selectedTypes:["hrvRMSSD"]))
 }

}
