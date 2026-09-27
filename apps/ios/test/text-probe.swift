// Actual Foundation text transport. It never constructs an audio engine or socket.
import Foundation
import AssistantCore

let config=(try! JSONSerialization.jsonObject(with:Data(readLine()!.utf8))) as! [String:String]
final class TextProbeStore:ConnectionStore {var value:SavedConnection?;func load() throws -> SavedConnection?{value};func save(_ value:SavedConnection) throws{self.value=value}}
let transport=NativeTransport(store:TextProbeStore()),text=NativeText(transport:transport)
func request(_ path:String,_ body:[String:Any]?=nil) async throws -> [String:Any] {
    let encoded=try body.map{String(data:try JSONSerialization.data(withJSONObject:$0),encoding:.utf8)!}
    let (data,response)=try await withCheckedThrowingContinuation {(c:CheckedContinuation<(Data,HTTPURLResponse),Error>) in
        transport.request(path,method:body==nil ? "GET":"POST",body:encoded){c.resume(with:$0)}
    }
    guard response.statusCode==200,let value=try JSONSerialization.jsonObject(with:data) as? [String:Any] else{throw VoiceError.invalidMessage};return value
}
func output(_ value:[String:Any]){print(String(data:try! JSONSerialization.data(withJSONObject:value),encoding:.utf8)!);exit(0)}
Task { @MainActor in
    do {
        try transport.configure(config["endpoint"]!,username:"ios-text")
        _=try await request("/api/auth/v1/sign-in",["username":"ios-text","password":config["password"]!])
        if config["context"]=="true" {
            let current=try await request("/api/runtime/v1/session-context")
            _=try await request("/api/runtime/v1/session-context",["expectedRevision":current["revision"]!,"mode":"text","audienceScope":"authenticatedSession","endpointClass":"personalCompanion","bindingKey":UUID().uuidString.lowercased()])
            _=try await request("/api/runtime/v1/audience",["mode":"solo","seconds":300])
        }
        let trace="b392061b-0300-46b9-ab89-aad7f611093c"
        let result=try await withCheckedThrowingContinuation {(c:CheckedContinuation<[String:Any],Error>) in
            text.send(["assistantId":config["assistantId"]!,"userInput":config["input"] ?? "Synthetic typed question.","trace":trace]){c.resume(with:$0)}
            if config["cancel"]=="true"{DispatchQueue.main.asyncAfter(deadline:.now()+0.15){text.stop()}}
            if config["changeOrigin"]=="true"{DispatchQueue.main.asyncAfter(deadline:.now()+0.15){try! transport.configure("http://127.0.0.1:1",username:"other")}}
        }
        output(["ok":true,"result":result,"active":text.active,"physicalAudio":false])
    }catch{
        // Keep the process alive after cancellation so the server can distinguish
        // task cancellation from an implicit socket close at process exit.
        if config["cancel"]=="true" || config["changeOrigin"]=="true"{try? await Task.sleep(nanoseconds:400_000_000)}
        output(["ok":false,"message":error.localizedDescription,"active":text.active,"physicalAudio":false])
    }
}
DispatchQueue.main.asyncAfter(deadline:.now()+50){fputs("Text transport timed out\n",stderr);exit(2)}
RunLoop.main.run()
