import Foundation
import AssistantCore
final class ProbeStore:ConnectionStore{var value:SavedConnection?;func load()throws->SavedConnection?{value};func save(_ value:SavedConnection)throws{self.value=value}}
let input=Data(readLine()!.utf8),config=(try! JSONSerialization.jsonObject(with:input)) as! [String:Any]
var clock=Date(timeIntervalSince1970:config["oldNow"] as! Double)
let audit=BoundedVoiceAudit(now:{clock},monotonic:{100}),transport=NativeTransport(store:ProbeStore(),audit:audit);try! transport.configure(config["endpoint"] as! String)
func done(_ result:[String:Any]){print(String(data:try! JSONSerialization.data(withJSONObject:result),encoding:.utf8)!);exit(0)}
transport.request("/api/runtime/v1/audience"){first in
 guard case .success=first,!audit.active,audit.observation == .absent,!audit.beginAttempt() else{exit(2)}
 clock=Date(timeIntervalSince1970:config["newNow"] as! Double)
 transport.request("/api/runtime/v1/audience"){second in
  guard case .success=second,audit.active,audit.observation == .available,audit.beginAttempt(),let labels=audit.correlation() else{exit(3)}
  let ws=try! transport.webSocket();transport.socketOpened={_ in done(["oldAbsent":true,"repairedAvailable":true,"session":labels.session,"attempt":labels.attempt])};ws.resume()
 }
}
DispatchQueue.main.asyncAfter(deadline:.now()+10){exit(4)};RunLoop.main.run()
