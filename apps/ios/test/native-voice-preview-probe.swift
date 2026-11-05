import Foundation
import AssistantCore
let config=(try! JSONSerialization.jsonObject(with:Data(readLine()!.utf8))) as! [String:Any]
final class ProbeStore:ConnectionStore{var value:SavedConnection?;func load()throws->SavedConnection?{value};func save(_ value:SavedConnection)throws{self.value=value}}
let transport=NativeTransport(store:ProbeStore()),audience=NativeAudience(transport:transport),preview=NativeVoicePreview(transport:transport)
func call(_ path:String,_ body:[String:Any]?=nil) async throws->(Int,[String:Any]){let encoded=try body.map{String(data:try JSONSerialization.data(withJSONObject:$0),encoding:.utf8)!};let (data,response)=try await withCheckedThrowingContinuation{(c:CheckedContinuation<(Data,HTTPURLResponse),Error>) in transport.request(path,method:body == nil ? "GET":"POST",body:encoded){c.resume(with:$0)}};return (response.statusCode,(try? JSONSerialization.jsonObject(with:data) as? [String:Any]) ?? [:])}
func output(_ x:[String:Any]){print(String(data:try! JSONSerialization.data(withJSONObject:x),encoding:.utf8)!);exit(0)}
func audition(_ x:[String:Any]) async throws->[String:Any]{try await withCheckedThrowingContinuation{c in preview.start(x){c.resume(with:$0)}}}
var step="start"
Task{@MainActor in do{
 try transport.configure(config["endpoint"] as! String,username:"owner")
 step="sign-in";guard try await call("/api/auth/v1/sign-in",["username":"owner","password":config["password"]!]).0==200 else{throw VoiceError.invalidMessage}
 step="session";let state=try await call("/api/runtime/v1/session-context");guard let rev=state.1["revision"] as? Int else{throw VoiceError.invalidMessage};let bound=try await call("/api/runtime/v1/session-context",["expectedRevision":rev,"mode":"text","audienceScope":"authenticatedSession"]);guard bound.0==200 else{output(["ok":false,"step":"session-bind","status":bound.0,"code":bound.1["code"] as? String ?? "none"]);return}
 step="audience";guard try await call("/api/runtime/v1/audience",["mode":"solo","seconds":300]).0==200 else{throw VoiceError.invalidMessage}
 let assistant=config["assistantId"] as! String,draft=config["draft"] as! [String:Any],voice=config["voice"] as! [String:Any]
 preview.hostPlayback={completion in completion()}
 step="draft-preview";let d=try await audition(["assistantId":assistant,"text":"Edited synthetic preview.","expectedActiveRevision":2,"voiceDraft":draft]);guard d["physicalPlaybackConfirmed"] as? Bool==false else{throw VoiceError.invalidMessage}
 step="saved-preview";let v=try await audition(["assistantId":assistant,"text":"Saved synthetic preview.","voiceRef":voice["voiceRef"]!,"voiceRevision":voice["revision"]!]);guard v["previewId"] is String else{throw VoiceError.invalidMessage}
 step="cancel";var late:(()->Void)?;preview.hostPlayback={completion in late=completion;DispatchQueue.main.async{preview.stop();completion()}}
 var stopped=false;do{_=try await audition(["assistantId":assistant,"text":"Cancelled synthetic preview.","expectedActiveRevision":2,"voiceDraft":draft])}catch{stopped=true};guard stopped else{throw VoiceError.invalidMessage}
 late?();try await Task.sleep(nanoseconds:300_000_000)
 output(["ok":true,"draft":true,"saved":true,"cancelled":true,"lateCallbackFenced":!preview.busy,"physicalPlayback":false])
}catch{output(["ok":false,"step":step])}}
DispatchQueue.main.asyncAfter(deadline:.now()+30){exit(2)};RunLoop.main.run()
