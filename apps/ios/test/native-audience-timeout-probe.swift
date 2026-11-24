import Foundation
import AssistantCore
let endpoint=readLine()!
final class ProbeStore:ConnectionStore{var value:SavedConnection?;func load()throws->SavedConnection?{value};func save(_ value:SavedConnection)throws{self.value=value}}
let transport=NativeTransport(store:ProbeStore()),audience=NativeAudience(transport:transport);var reasons=[String](),diagnostics=[String]()
audience.onEnded={reasons.append($0)}
audience.diagnostic={event,code in diagnostics.append(event.rawValue+":"+code.rawValue)}
func output(_ value:[String:Any]){print(String(data:try! JSONSerialization.data(withJSONObject:value),encoding:.utf8)!);exit(0)}
Task{@MainActor in do{try transport.configure(endpoint);_=try await withCheckedThrowingContinuation{(c:CheckedContinuation<[String:Any],Error>) in audience.begin{c.resume(with:$0)}};do{_=try await withCheckedThrowingContinuation{(c:CheckedContinuation<[String:Any],Error>) in audience.heartbeat{c.resume(with:$0)}};output(["ok":false,"reason":"renew unexpectedly succeeded"])}catch{output(["ok":true,"ended":audience.leaseId==nil,"failure":reasons.last ?? "none","diagnostics":diagnostics])} }catch{output(["ok":false,"reason":"begin failed"])} }
DispatchQueue.main.asyncAfter(deadline:.now()+10){exit(2)};RunLoop.main.run()
