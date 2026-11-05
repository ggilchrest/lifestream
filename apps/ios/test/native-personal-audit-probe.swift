import Foundation
import AssistantCore
final class ProbeStore:ConnectionStore{var value:SavedConnection?;func load()throws->SavedConnection?{value};func save(_ value:SavedConnection)throws{self.value=value}}
let endpoint=readLine()!,transport=NativeTransport(store:ProbeStore());var stopConfirmed=false;transport.auditStopConfirmed={stopConfirmed=true};try! transport.configure(endpoint)
func done(_ value:[String:Any]){print(String(data:try! JSONSerialization.data(withJSONObject:value),encoding:.utf8)!);exit(0)}
transport.request("/api/runtime/v1/audience/personal-session"){first in
 guard case .success=first,transport.audit.active,transport.audit.observation == .available,transport.audit.beginAttempt(),let labels=transport.audit.correlation() else{exit(2)}
 transport.request("/api/runtime/v1/audience/personal-session"){second in
  guard case .success=second,transport.audit.active else{exit(3)}
  let events=transport.audit.snapshot();let result=events.contains{$0.event == .privacyRequestFinish && $0.request == 7 && $0.value == 200}
  let socket=try! transport.webSocket()
  transport.socketOpened={_ in
   func transmit(_ value:[String:Any]){let data=try! JSONSerialization.data(withJSONObject:value);socket.send(.string(String(data:data,encoding:.utf8)!)){_ in}}
   for kind in [VoiceAuditConsent.heartbeat,.turn]{let c=transport.audit.nextConsent(kind)!;transmit(["type":"diagnosticsConsent","diagnostics":["version":1,"session":c.session,"attempt":c.attempt,"sequence":c.sequence,"kind":c.kind]])}
   transmit(["type":"commitTurn"]);transmit(["type":"diagnosticsStop","diagnostics":["version":1,"session":labels.session,"attempt":labels.attempt]])
   transport.request("/api/runtime/v1/audience/personal-session"){third in
    guard case .success=third else{exit(4)}
    let disabled = !transport.audit.active && transport.audit.observation == .absent
    transport.request("/api/runtime/v1/audience/personal-session"){fourth in
     guard case .success=fourth else{exit(6)}
     done(["enabledAfterFirst":true,"trackedHTTP":result,"disabledAfterOff":disabled,"stopConfirmed":stopConfirmed,"session":labels.session,"attempt":labels.attempt])
    }
   }
  };socket.resume()
 }
}
DispatchQueue.main.asyncAfter(deadline:.now()+10){exit(5)};RunLoop.main.run()
