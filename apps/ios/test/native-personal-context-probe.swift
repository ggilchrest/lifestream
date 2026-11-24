import Foundation
import AssistantCore
final class ProbeStore:ConnectionStore{var value:SavedConnection?;func load()throws->SavedConnection?{value};func save(_ value:SavedConnection)throws{self.value=value}}
let t=NativeTransport(store:ProbeStore());try! t.configure(readLine()!)
t.request("/api/auth/v1/user-context"){result in
 guard case .success = result else{exit(2)}
 t.request("/api/runtime/v1/audience/personal-session"){result in
  guard case .success = result else{exit(3)}
  let ws=try! t.webSocket();t.socketOpened={_ in print("ok");exit(0)};ws.resume()
 }
}
DispatchQueue.main.asyncAfter(deadline:.now()+8){exit(4)};RunLoop.main.run()
