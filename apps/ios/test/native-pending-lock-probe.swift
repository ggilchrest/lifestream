import Foundation
import AssistantCore
final class ProbeStore:ConnectionStore{var value:SavedConnection?;func load()throws->SavedConnection?{value};func save(_ value:SavedConnection)throws{self.value=value}}
let store=ProbeStore(),endpoint=readLine()!,first=NativeTransport(store:store);try! first.configure(endpoint,username:"owner")
first.request("/api/auth/v1/user-context"){_ in
 do{try first.persistPendingLock("lock-command")}catch{exit(2)}
 let second=NativeTransport(store:store);do{_=try second.restoreConnection()}catch{exit(3)}
 guard second.pendingLockState().state=="mismatch" else{exit(4)}
 second.request("/api/auth/v1/user-context"){_ in
  guard second.pendingLockState().state=="matching",second.pendingLockState().body=="lock-command" else{exit(5)}
  do{try second.persistPendingLock("different");exit(6)}catch{}
  let third=NativeTransport(store:store);do{_=try third.restoreConnection();try third.configure(endpoint,username:"renamed-alias")}catch{exit(7)}
  third.request("/api/auth/v1/user-context"){_ in
   guard third.pendingLockState().state=="mismatch",third.pendingLockState().body==nil else{exit(8)}
   do{try third.confirmPendingLock("lock-command");exit(9)}catch{}
   do{try third.forgetSession();try third.configure(endpoint,username:"other")}catch{exit(13)}
   guard store.value?.pendingPersonalLocks?.count==1,third.pendingLockState().state=="mismatch" else{exit(14)}
   third.request("/api/auth/v1/user-context"){_ in
    do{guard third.pendingLockState().state=="none",third.pendingLockState().unresolvedElsewhere else{exit(17)};try third.persistPendingLock("other-command");try third.configure(endpoint,username:"owner")}catch{exit(15)}
    third.request("/api/auth/v1/user-context"){_ in
     guard third.pendingLockState().body=="lock-command" else{exit(16)}
     do{try third.confirmPendingLock("lock-command")}catch{exit(10)}
     guard third.pendingLockState().state=="none",store.value?.pendingPersonalLocks?.count==1 else{exit(11)}
     print("ok");exit(0)
    }
   }
  }
 }
}
DispatchQueue.main.asyncAfter(deadline:.now()+8){exit(12)};RunLoop.main.run()
