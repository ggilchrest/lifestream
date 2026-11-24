import Foundation
import AssistantCore
final class Store:ConnectionStore {var value:SavedConnection?;func load()throws->SavedConnection?{value};func save(_ value:SavedConnection)throws{self.value=value}}
final class Disk:HealthSnapshotStorage {var data:Data?;func read()throws->Data?{data};func replace(_ bytes:Data)throws{data=bytes}}
final class Suspend:NativeHealthPolicySuspending {let outbox:HealthOutbox;var calls=0;init(_ o:HealthOutbox){outbox=o};func suspendForPolicyRefresh(enrollment:UUID){calls += 1;outbox.invalidatePolicy(enrollment:enrollment)}}
let origin=readLine()!,seed=try! JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [String:Any],mode=CommandLine.arguments[2]
func id(_ key:String)->UUID { UUID(uuidString:seed[key] as! String)! }
let human=id("principalId"),endpoint=id("endpointId"),enrollment=id("enrollmentId"),data=try! JSONSerialization.data(withJSONObject:seed["policyResponse"]!),proof=try! MobileHealthPolicyParser.parse(data,expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:enrollment)
let outbox=HealthOutbox(storage:Disk());try! outbox.setHuman(human);try! outbox.enroll(proof:proof,selectedTypes:["sleep"]);let prior=try! outbox.ticket(enrollment:enrollment,type:"sleep"),suspend=Suspend(outbox),transport=NativeTransport(store:Store());try! transport.configure(origin,username:"synthetic")
transport.request("/api/auth/v1/session"){_ in transport.request("/api/auth/v1/user-context"){_ in
 let service=NativeHealthPolicy(transport:transport,outbox:outbox,collector:suspend)
 service.reconcile(enrollment:enrollment,expectedEndpoint:endpoint){result in
  guard suspend.calls==1 else {exit(2)}
  if mode == "allowed" {guard case .success(let p)=result,p.permitsCollection,(try? outbox.ticket(enrollment:enrollment,type:"sleep")) != nil else{exit(3)};print("typed current policy admitted")}
  else {guard case .failure = result,(try? outbox.verify(ticket:prior)) == nil,(try? outbox.ticket(enrollment:enrollment,type:"sleep")) == nil else{exit(4)};print("stale or nonself policy denied")}
  exit(0)
 }
}}
DispatchQueue.main.asyncAfter(deadline:.now()+8){exit(5)};RunLoop.main.run()
