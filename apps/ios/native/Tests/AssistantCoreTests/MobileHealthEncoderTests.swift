import Foundation
import XCTest
@testable import AssistantCore
final class MobileHealthEncoderTests:XCTestCase {
 let enrollment=UUID(uuidString:"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")!, event=UUID(uuidString:"BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB")!
 let start=Date(timeIntervalSince1970:1_790_000_000)
 func sample(_ category:String="sleep",value:Int=4,end:TimeInterval=3600,quantity:Double?=nil,unit:String?=nil)->NativeHealthObservation {NativeHealthObservation(upstreamId:"synthetic-source",category:category,start:start,end:start.addingTimeInterval(end),nativeSleep:category == "sleep" ? HealthSleepValue(nativeValue:value):nil,quantity:quantity,unit:unit,sourceBundle:"example.fixture",sourceVersion:"3.2",deviceName:"Synthetic device",deviceModel:"fixture",sourceTimeZone:"America/Chicago")}
 func change(_ sample:NativeHealthObservation)throws->HealthChange{HealthChange(eventId:event,upstreamId:sample.upstreamId,operation:.upsert,body:try JSONEncoder().encode(sample),collectedAt:start,expectedPolicyRevision:7,mappingVersion:"healthkit-v1")}
 func json(_ b:MobileHealthEncoder.Batch)throws->[String:Any]{try XCTUnwrap(JSONSerialization.jsonObject(with:b.data) as? [String:Any])}
 func testSleepUnknownRetainsSourceAndRetryIdentity()throws{
  let c=try change(sample(value:901)),a=try MobileHealthEncoder.batch([c],enrollment:enrollment,sourceNamespace:"synthetic-source",category:"sleep"),b=try MobileHealthEncoder.batch([c],enrollment:enrollment,sourceNamespace:"synthetic-source",category:"sleep");XCTAssertEqual(a.data,b.data);let root=try json(a),changes=try XCTUnwrap(root["changes"] as? [[String:Any]]),v=changes[0],source=try XCTUnwrap(v["source"] as? [String:Any]),record=try XCTUnwrap(v["record"] as? [String:Any]);XCTAssertEqual(v["eventId"] as? String,event.uuidString.lowercased());XCTAssertEqual(source["namespace"] as? String,"synthetic-source");XCTAssertEqual(source["originalAppVersion"] as? String,"3.2");XCTAssertNil(source["upstreamRevision"]);XCTAssertEqual(record["stage"] as? String,"unknown");XCTAssertEqual(record["nativeValue"] as? String,"901");XCTAssertEqual(record["classification"] as? String,"unknown");XCTAssertEqual(record["timeZone"] as? String,"America/Chicago");XCTAssertEqual(v["expectedPolicyRevision"] as? Int,7)
 }
 func testMeasurementsPreserveMethodUnitsAndTimeSemantics()throws{
  for (category,unit,wire) in [("heartRate","bpm","beatsPerMinute"),("restingHeartRate","bpm","beatsPerMinute"),("respiratoryRate","breathsPerMinute","breathsPerMinute"),("hrvSDNN","ms","milliseconds")]{let item=try change(sample(category,end:0,quantity:40,unit:unit)),root=try json(MobileHealthEncoder.batch([item],enrollment:enrollment,sourceNamespace:"synthetic-source",category:category)),items=try XCTUnwrap(root["changes"] as? [[String:Any]]),v=try XCTUnwrap(items[0]["record"] as? [String:Any]);XCTAssertEqual(v["measure"] as? String,category);XCTAssertEqual(v["unit"] as? String,wire);XCTAssertEqual(v["origin"] as? String,"unknown");XCTAssertEqual(v["representation"] as? String,"point");XCTAssertNil(v["endAt"])}
  let item=try change(sample("respiratoryRate",end:1800,quantity:13,unit:"breathsPerMinute")),root=try json(MobileHealthEncoder.batch([item],enrollment:enrollment,sourceNamespace:"synthetic-source",category:"respiratoryRate")),items=try XCTUnwrap(root["changes"] as? [[String:Any]]),v=try XCTUnwrap(items[0]["record"] as? [String:Any]);XCTAssertEqual(v["representation"] as? String,"interval");XCTAssertNotNil(v["endAt"])
 }
 func testDeletionOmitsBodyAndUnknownMethodIsNotInvented()throws{
  let c=HealthChange(eventId:event,upstreamId:"synthetic-source",operation:.delete,body:nil,collectedAt:start,expectedPolicyRevision:7,mappingVersion:"healthkit-v1"),root=try json(MobileHealthEncoder.batch([c],enrollment:enrollment,sourceNamespace:"synthetic-source",category:"sleep")),items=try XCTUnwrap(root["changes"] as? [[String:Any]]);XCTAssertNil(items[0]["record"]);XCTAssertEqual(items[0]["operation"] as? String,"delete");XCTAssertThrowsError(try MobileHealthEncoder.batch([c],enrollment:enrollment,sourceNamespace:"synthetic-source",category:"hrvRMSSD"))
 }
 func testInvalidOrOversizedRecordDoesNotBecomeValidByTruncation()throws{
  let bad=try change(sample("heartRate",quantity:-1,unit:"bpm"));XCTAssertThrowsError(try MobileHealthEncoder.batch([bad],enrollment:enrollment,sourceNamespace:"synthetic-source",category:"heartRate"));XCTAssertThrowsError(try MobileHealthEncoder.batch([bad],enrollment:enrollment,sourceNamespace:"synthetic-source",category:"sleep"))
  let c=try change(sample());XCTAssertThrowsError(try MobileHealthEncoder.batch([c,c],enrollment:enrollment,sourceNamespace:"synthetic-source",category:"sleep"))
 }
 func testBatchCountIsBoundedAndOriginalEventIdentitiesRetained()throws{
  let items=(0..<70).map{HealthChange(upstreamId:"synthetic-\($0)",operation:.delete,body:nil,collectedAt:start,expectedPolicyRevision:7,mappingVersion:"healthkit-v1")}
  let batch=try MobileHealthEncoder.batch(items,enrollment:enrollment,sourceNamespace:"synthetic-source",category:"sleep"),root=try json(batch),changes=try XCTUnwrap(root["changes"] as? [[String:Any]])
  XCTAssertEqual(changes.count,64);XCTAssertEqual(batch.eventIds,Array(items.prefix(64).map(\.eventId)));XCTAssertLessThanOrEqual(batch.data.count,MobileHealthEncoder.transportBatchBytes)
 }

 func testEachQueuedEventPreservesItsOwnOriginalMappingVersion()throws{
  let a=HealthChange(upstreamId:"a",operation:.delete,body:nil,collectedAt:start,expectedPolicyRevision:7,mappingVersion:"old-v1"),b=HealthChange(upstreamId:"b",operation:.delete,body:nil,collectedAt:start,expectedPolicyRevision:7,mappingVersion:"new-v2")
  let batch=try MobileHealthEncoder.batch([a,b],enrollment:enrollment,sourceNamespace:"synthetic-source",category:"sleep"),root=try json(batch),rows=try XCTUnwrap(root["changes"] as? [[String:Any]])
  XCTAssertEqual(rows.map{$0["mappingVersion"] as? String},["old-v1","new-v2"])
 }

}
