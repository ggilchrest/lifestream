// Real native audience transport, no microphone or audio session construction.
import Foundation
import AssistantCore
let config=(try! JSONSerialization.jsonObject(with:Data(readLine()!.utf8))) as! [String:String]
final class ProbeStore:ConnectionStore{var value:SavedConnection?;func load() throws->SavedConnection?{value};func save(_ value:SavedConnection) throws{self.value=value}}
let transport=NativeTransport(store:ProbeStore()),audience=NativeAudience(transport:transport)
var ended=[String]()
audience.onEnded={ended.append($0)}
func request(_ path:String,_ body:[String:Any]?=nil) async throws->[String:Any]{
 let encoded=try body.map{String(data:try JSONSerialization.data(withJSONObject:$0),encoding:.utf8)!}
 let (data,response)=try await withCheckedThrowingContinuation{(c:CheckedContinuation<(Data,HTTPURLResponse),Error>) in transport.request(path,method:body==nil ? "GET":"POST",body:encoded){c.resume(with:$0)}}
 guard response.statusCode==200,let value=try JSONSerialization.jsonObject(with:data) as? [String:Any] else{throw VoiceError.invalidMessage};return value
}
func begin() async throws->[String:Any]{try await withCheckedThrowingContinuation{c in audience.begin{c.resume(with:$0)}}}
func heartbeat() async throws->[String:Any]{try await withCheckedThrowingContinuation{c in audience.heartbeat{c.resume(with:$0)}}}
func output(_ value:[String:Any]){print(String(data:try! JSONSerialization.data(withJSONObject:value),encoding:.utf8)!);exit(0)}
Task{@MainActor in
 do{
  try transport.configure(config["endpoint"]!,username:"ios-audience")
  _=try await request("/api/auth/v1/sign-in",["username":"ios-audience","password":config["password"] ?? "synthetic"])
  if config["context"]=="true"{let current=try await request("/api/runtime/v1/session-context");_=try await request("/api/runtime/v1/session-context",["expectedRevision":current["revision"]!,"mode":"text","audienceScope":"authenticatedSession","endpointClass":"personalCompanion","bindingKey":UUID().uuidString.lowercased()])}
  let first=try await begin();let firstId=first["leaseId"] as! String
  if config["scenario"]=="clearThenStart"{_=try await request("/api/runtime/v1/audience",["mode":"clear"]);let next=try await begin();audience.end("Finished");try? await Task.sleep(nanoseconds:200_000_000);output(["ok":true,"reacquired":next["leaseId"] as? String != firstId,"leaseActive":audience.leaseId != nil,"ended":ended]);}
  if config["scenario"]=="cancel"{audience.end("Cancelled");try? await Task.sleep(nanoseconds:200_000_000);output(["ok":true,"leaseActive":audience.leaseId != nil,"ended":ended]);}
  if config["scenario"]=="lock"{audience.resignActive();audience.protectedDataUnavailable();audience.enterBackground(continueWhenLocked:true,protectedDataAvailable:true);let locked=try await heartbeat();output(["ok":true,"sameId":locked["leaseId"] as? String == firstId,"leaseActive":audience.leaseId != nil,"ended":ended]);}
  if config["scenario"]=="minimize"{audience.resignActive();audience.enterBackground(continueWhenLocked:true,protectedDataAvailable:true);audience.protectedDataUnavailable();try? await Task.sleep(nanoseconds:200_000_000);output(["ok":true,"leaseActive":audience.leaseId != nil,"ended":ended]);}
  if config["scenario"]=="originChange"{try transport.configure("http://127.0.0.1:1",username:"other")}
  let next=try await heartbeat();audience.end("Finished");try? await Task.sleep(nanoseconds:200_000_000);output(["ok":true,"sameId":next["leaseId"] as? String == firstId,"leaseActive":audience.leaseId != nil,"ended":ended])
 }catch{try? await Task.sleep(nanoseconds:200_000_000);output(["ok":false,"message":error.localizedDescription,"leaseActive":audience.leaseId != nil,"ended":ended])}
}
DispatchQueue.main.asyncAfter(deadline:.now()+30){fputs("Audience probe timed out\n",stderr);exit(2)}
RunLoop.main.run()
