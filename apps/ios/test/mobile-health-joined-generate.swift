import Foundation
let dir=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
let seed=try JSONSerialization.jsonObject(with:Data(contentsOf:dir.appendingPathComponent("seed.json"))) as! [String:Any]
func id(_ key:String)->UUID { UUID(uuidString:seed[key] as! String)! }
let principal=id("principalId"),endpoint=id("endpointId"),enrollment=id("enrollmentId")
let policy=try JSONSerialization.data(withJSONObject:seed["policyResponse"]!),proof=try MobileHealthPolicyParser.parse(policy,expectedPrincipal:principal,expectedEndpoint:endpoint,expectedEnrollment:enrollment)
let storage=ProtectedHealthFileStorage(file:dir.appendingPathComponent("outbox.json")),outbox=HealthOutbox(storage:storage);try outbox.setHuman(principal);try outbox.enroll(proof:proof,selectedTypes:["sleep"]);let ticket=try outbox.ticket(enrollment:enrollment,type:"sleep")
let fmt=ISO8601DateFormatter();fmt.formatOptions=[.withInternetDateTime,.withFractionalSeconds];let window=seed["recordWindow"] as! [String:String],start=fmt.date(from:window["startAt"]!)!,end=fmt.date(from:window["endAt"]!)!
let fixedIds=[UUID(uuidString:"10000000-0000-4000-8000-000000000001")!,UUID(uuidString:"10000000-0000-4000-8000-000000000002")!]
let changes=try ["synthetic-native-sleep-eligible","synthetic-native-sleep-narrowed"].enumerated().map{index,upstream -> HealthChange in
 let sample=NativeHealthObservation(upstreamId:upstream,category:"sleep",start:start,end:end,nativeSleep:HealthSleepValue(nativeValue:3),quantity:nil,unit:nil,sourceBundle:"synthetic.fixture",sourceVersion:"1",deviceName:"synthetic-device",deviceModel:"synthetic-model",sourceTimeZone:"UTC")
 return HealthChange(eventId:fixedIds[index],upstreamId:upstream,operation:.upsert,body:try JSONEncoder().encode(sample),collectedAt:end.addingTimeInterval(60),expectedPolicyRevision:proof.revision,mappingVersion:"healthkit-v1")
}
try outbox.commit(scope:"synthetic-joined",expectedAnchor:nil,nextAnchor:Data([1]),changes:changes,ticket:ticket)
let saved=try outbox.pending(ticket:ticket);precondition(saved==changes)
for (index,name) in ["eligible-request.json","narrowed-request.json"].enumerated(){let b=try MobileHealthEncoder.batch([saved[index]],enrollment:enrollment,sourceNamespace:ticket.sourceNamespace,category:ticket.category);try MobileHealthWire.request(batch:b.data).write(to:dir.appendingPathComponent(name),options:.atomic)}
print("generated 2 synthetic immutable requests from persisted outbox")
