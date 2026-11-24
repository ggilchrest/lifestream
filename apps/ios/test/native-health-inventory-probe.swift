import Foundation
import AssistantCore
final class Store:ConnectionStore {var value:SavedConnection?;func load()throws->SavedConnection?{value};func save(_ value:SavedConnection)throws{self.value=value}}
let origin=readLine()!, endpoint=UUID(uuidString:"00000000-0000-4000-8000-000000000002")!, mode=CommandLine.arguments[1]
let transport=NativeTransport(store:Store());try! transport.configure(origin,username:"synthetic")
transport.request("/api/auth/v1/session"){_ in transport.request("/api/auth/v1/user-context"){_ in
 NativeHealthHost(transport:transport).loadInventory{result in
  if mode == "allowed" {guard case .success(let snapshot)=result,let sources=snapshot["sources"] as? [[String:Any]],sources.count==2,let unbound=snapshot["unboundEnrollments"] as? [[String:Any]],unbound.count==1,unbound[0]["collector"] as? String == "healthKit",unbound[0]["revision"] as? Int == 7 else{exit(2)};print("inventory admitted")}
  else {guard case .failure=result else{exit(3)};print("inventory denied")};exit(0)
 }
}}
DispatchQueue.main.asyncAfter(deadline:.now()+8){exit(4)};RunLoop.main.run()
