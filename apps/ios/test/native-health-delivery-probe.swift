import Foundation
import AssistantCore
final class Store:ConnectionStore {var value:SavedConnection?;func load()throws->SavedConnection?{value};func save(_ value:SavedConnection)throws{self.value=value}}
final class Disk:HealthSnapshotStorage {var data:Data?;func read()throws->Data?{data};func replace(_ bytes:Data)throws{data=bytes}}
let stale=CommandLine.arguments.dropFirst().first == "stale"
let origin=readLine()!,owner=UUID(uuidString:"00000000-0000-4000-8000-000000000001")!,enrollment=UUID(uuidString:"00000000-0000-4000-8000-000000000002")!
let endpoint=UUID(uuidString:"00000000-0000-4000-8000-000000000005")!,namespace="00000000-0000-4000-8000-000000000004"
let config:[String:Any]=["categories":["SleepSegment"],"uses":[],"assistantIds":[],"collectionPaused":false,"usePaused":false]
let e:[String:Any]=["enrollmentId":enrollment.uuidString.lowercased(),"principalId":owner.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":namespace,"revision":1,"state":"active","configuration":config]
let f:[String:Any]=["policyRevision":1,"sourceBound":true,"collectionAllowed":true,"categories":["SleepSegment"],"uses":[],"assistantIds":[],"sourceNamespace":namespace]
let data=try! JSONSerialization.data(withJSONObject:["schemaVersion":"1.0.0","producerPin":["schemaId":MobileHealthEncoder.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthEncoder.schemaSHA256],"result":["enrollment":e,"effective":f]])
let proof=try! MobileHealthPolicyParser.parse(data,expectedPrincipal:owner,expectedEndpoint:endpoint,expectedEnrollment:enrollment)
let store=HealthOutbox(storage:Disk());try! store.setHuman(owner);try! store.enroll(proof:proof,selectedTypes:["sleep"]);let ticket=try! store.ticket(enrollment:enrollment,type:"sleep"),item=HealthChange(upstreamId:"synthetic",operation:.delete,body:nil,expectedPolicyRevision:1,mappingVersion:"healthkit-v1");try! store.commit(scope:"p",expectedAnchor:nil,nextAnchor:Data([1]),changes:[item],ticket:ticket)
let batch=try! MobileHealthEncoder.batch([item],enrollment:enrollment,sourceNamespace:ticket.sourceNamespace,category:"sleep")
let transport=NativeTransport(store:Store());try! transport.configure(origin,username:"synthetic")
transport.request(MobileHealthWire.path,method:"POST",body:"{}"){result in
 guard case .failure = result else {exit(2)}
 transport.request("/api/auth/v1/session"){response in
  guard case .success = response else {exit(3)}
  transport.request("/api/auth/v1/user-context"){response in
   guard case .success = response,transport.effectiveIsSelf else {exit(4)}
   let adapter=NativeHealthDelivery(transport:transport,outbox:store)
   adapter.send(ticket:ticket,batch:batch.data){result in
    if stale { guard case .failure = result else { exit(7) };print("native stale owner response rejected");exit(0) }
    guard case .success(let entries)=result,entries.count==1,entries[0].eventId==item.eventId,entries[0].outcome == .accepted else {exit(5)}
    print("native authenticated health adapter passed synthetic transport");exit(0)
   }
   if stale { DispatchQueue.main.asyncAfter(deadline:.now()+0.05) { try? transport.configure(origin,username:"different-synthetic-account") } }
  }
 }
}
DispatchQueue.main.asyncAfter(deadline:.now()+8){exit(6)};RunLoop.main.run()
