import Foundation
import AssistantCore
final class Store:ConnectionStore {var value:SavedConnection?;func load()throws->SavedConnection?{value};func save(_ value:SavedConnection)throws{self.value=value}}
let fixture=try! JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [String:Any]
let user=fixture["userContext"] as! [String:Any],ctx=user["context"] as! [String:Any],personal=fixture["personalSession"] as! [String:Any]
let origin=readLine()!,principal=ctx["actorId"] as! String,current=ctx["authenticatedSessionId"] as! String,old="00000000-0000-4000-8000-000000000003"
let store=Store();store.value=SavedConnection(endpoint:origin,username:"fixture",pendingPersonalLocks:[PendingPersonalLock(endpoint:origin,username:"fixture",principalId:principal,sessionId:old,body:"old-opaque-lock")])
let transport=NativeTransport(store:store);try! transport.configure(origin,username:"fixture")
transport.request("/api/auth/v1/user-context"){result in
 guard case .success = result,transport.effectiveIsSelf,transport.currentEffectiveOwner?.session==current else{exit(2)}
 let legacy=transport.pendingLockState(),next=transport.personalAppPendingState()
 guard legacy.state=="mismatch",next.state=="none",next.unresolvedElsewhere,store.value?.pendingPersonalLocks?.first?.body=="old-opaque-lock" else{exit(3)}
 transport.request("/api/runtime/v1/audience/personal-session"){result in
  guard case .success(let (body,response))=result else{exit(6)}
  var access=PersonalSessionAccess();let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];let now=f.date(from:ctx["issuedAt"] as! String)!
  guard access.observe(status:response.statusCode,data:body,ticket:access.generation,expectedPrincipal:principal,expectedSession:current,now:now),personal["authenticatedSessionId"] as? String==current else{exit(7)}
  let currentStore=Store();currentStore.value=SavedConnection(endpoint:origin,username:"fixture",pendingPersonalLocks:[PendingPersonalLock(endpoint:origin,username:"fixture",principalId:principal,sessionId:current,body:"current-lock")])
  let second=NativeTransport(store:currentStore);try! second.configure(origin,username:"fixture")
  second.request("/api/auth/v1/user-context"){result in
   guard case .success = result,second.personalAppPendingState().state=="matching",currentStore.value?.pendingPersonalLocks?.first?.body=="current-lock" else{exit(5)}
   print("actual synthetic server response decoded; successor distinct; old lock retained; current lock restrictive");exit(0)
  }
 }
}
DispatchQueue.main.asyncAfter(deadline:.now()+8){exit(4)};RunLoop.main.run()
