import Foundation
import AssistantCore
let config=(try! JSONSerialization.jsonObject(with:Data(readLine()!.utf8))) as! [String:Any]
final class ProbeStore:ConnectionStore{var value:SavedConnection?;func load()throws->SavedConnection?{value};func save(_ value:SavedConnection)throws{self.value=value}}
let store=ProbeStore();var transport=NativeTransport(store:store),audience=NativeAudience(transport:transport)
func call(_ path:String,_ body:[String:Any]?=nil,legacy:Bool=false) async throws->(Int,[String:Any]){
 let method=body == nil ? "GET":"POST"
 // Same narrow preflight used by AssistantPlugin.request; legacy reproduces build 12.
 if method != "GET" && !path.hasSuffix("/messages") && (legacy || !EndpointPolicy.preservesAudience(path,method:method)){audience.end("Session settings changed",notify:false)}
 let encoded=try body.map{String(data:try JSONSerialization.data(withJSONObject:$0),encoding:.utf8)!}
 let (data,response)=try await withCheckedThrowingContinuation{(c:CheckedContinuation<(Data,HTTPURLResponse),Error>) in transport.request(path,method:method,body:encoded){c.resume(with:$0)}}
 return (response.statusCode,(try? JSONSerialization.jsonObject(with:data) as? [String:Any]) ?? [:])
}
func begin() async throws->[String:Any]{try await withCheckedThrowingContinuation{c in audience.begin{c.resume(with:$0)}}}
func restore() async throws->NativeTransport.RestoredConnection{try await withCheckedThrowingContinuation{c in transport.restoreSession{c.resume(with:$0)}}}
func envelope(_ op:String,_ payload:[String:Any])->[String:Any]{var request:[String:Any]=["schemaVersion":"1.0.0","operation":op,"operationId":UUID().uuidString.lowercased(),"payload":payload];if op=="create"{request["idempotencyKey"]=UUID().uuidString.lowercased()};return ["producerPin":config["pin"]!,"request":request]}
func output(_ value:[String:Any]){print(String(data:try! JSONSerialization.data(withJSONObject:value),encoding:.utf8)!);exit(0)}
var step="initial"
Task{@MainActor in do{
 try transport.configure(config["endpoint"] as! String,username:"ios-history-fixture")
 step="login";let login=try await call("/api/auth/v1/sign-in",["username":"ios-history-fixture","password":config["password"]!]);guard login.0==200 else{throw VoiceError.invalidMessage}
 step="session-get";let initial=try await call("/api/runtime/v1/session-context");guard let revision=initial.1["revision"] as? Int else{throw VoiceError.invalidMessage}
 step="session-bind";let setup=try await call("/api/runtime/v1/session-context",["expectedRevision":revision,"mode":"audio","audienceScope":"authenticatedSession","endpointClass":"personalCompanion","bindingKey":UUID().uuidString.lowercased()]);guard setup.0==200 else{output(["ok":false,"step":"session-bind","status":setup.0,"code":setup.1["code"] as? String ?? "none","message":setup.1["message"] as? String ?? "none"]);return}
 step="audience-begin";_=try await begin();let assistant=config["assistantId"] as! String
 step="first-create";let first=try await call("/api/runtime/v1/conversations",envelope("create",["assistantId":assistant,"title":"Synthetic existing thread"]));guard first.0==200,let result=first.1["result"] as? [String:Any],let id=result["conversationId"] as? String else{throw VoiceError.invalidMessage}
 var ctx=try await call("/api/runtime/v1/session-context");let rev=ctx.1["revision"] as! Int
 step="first-select";let selected=try await call("/api/runtime/v1/conversations/select",["producerPin":config["pin"]!,"conversationId":id,"assistantId":assistant,"expectedSessionRevision":rev]);guard selected.0==200 else{throw VoiceError.invalidMessage};_=try await begin()
 // Simulate relaunch with the original saved cookie and authenticated session.
 let original=(login.1["session"] as? [String:Any])?["sessionId"] as? String;audience.end("Background",notify:false);try await Task.sleep(nanoseconds:200_000_000)
 transport=NativeTransport(store:store);audience=NativeAudience(transport:transport);let saved=try await restore();guard saved.authState=="authenticated",saved.account?["sessionId"] as? String==original else{throw VoiceError.invalidMessage};_=try await begin()
 step="existing-list";let prior=try await call("/api/runtime/v1/conversations",envelope("list",["assistantId":assistant,"filter":"recent","pageSize":50]));guard prior.0==200 else{throw VoiceError.invalidMessage}
 if config["legacy"] as? Bool==true{
  let broken=try await call("/api/runtime/v1/conversations",envelope("list",["assistantId":assistant,"filter":"recent","pageSize":50]),legacy:true)
  let locallyRetired=audience.leaseId==nil;var withheld=false
  for _ in 0..<20 {let state=try await call("/api/runtime/v1/audience");if state.1["privateAllowed"] as? Bool == false {withheld=true;break};try await Task.sleep(nanoseconds:100_000_000)}
  guard withheld else{output(["ok":false,"step":"release-not-observed","afterLegacy":broken.0,"leaseRetired":locallyRetired]);return}
  let after=try await call("/api/runtime/v1/conversations",envelope("list",["assistantId":assistant,"filter":"recent","pageSize":50]));output(["ok":true,"prior":prior.0,"afterLegacy":broken.0,"afterRetirement":after.0,"leaseRetired":locallyRetired])
 }
 let listed=try await call("/api/runtime/v1/conversations",envelope("list",["assistantId":assistant,"filter":"recent","pageSize":50]));let created=try await call("/api/runtime/v1/conversations",envelope("create",["assistantId":assistant,"title":"Synthetic second thread"]));guard let next=(created.1["result"] as? [String:Any])?["conversationId"] as? String else{output(["ok":false,"list":listed.0,"create":created.0]);return}
 ctx=try await call("/api/runtime/v1/session-context");let switched=try await call("/api/runtime/v1/conversations/select",["producerPin":config["pin"]!,"conversationId":next,"assistantId":assistant,"expectedSessionRevision":ctx.1["revision"]!]);_=try await begin();let confirmed=try await call("/api/runtime/v1/session-context");let seen=(confirmed.1["selectedConversation"] as? [String:Any])?["conversationId"] as? String == next
 step="restored-text";let text=NativeText(transport:transport);_=try await withCheckedThrowingContinuation{(c:CheckedContinuation<[String:Any],Error>) in text.send(["assistantId":assistant,"userInput":"Synthetic restored-session question.","trace":UUID().uuidString]){c.resume(with:$0)}}
 output(["ok":true,"prior":prior.0,"list":listed.0,"create":created.0,"select":switched.0,"confirmed":seen,"leaseActive":audience.leaseId != nil,"textSucceeded":true])
}catch{output(["ok":false,"error":"synthetic_probe_failed","step":step])} }
DispatchQueue.main.asyncAfter(deadline:.now()+30){exit(2)};RunLoop.main.run()
