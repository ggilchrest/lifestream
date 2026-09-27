// SPDX-License-Identifier: Apache-2.0
import Foundation

enum NativeTextError:LocalizedError {
    case invalidInput,invalidStream,cancelled,http(Int),runtime(String)
    var errorDescription:String? {
        switch self {
        case .invalidInput:return "Select an Assistant and enter a message of up to 16,000 characters."
        case .invalidStream:return "The server reply was incomplete or did not match this conversation. Please retry."
        case .cancelled:return "Text response stopped."
        case .http(let status):return status==401 ? "Sign in again to send a message.":"The server could not accept this message (\(status))."
        case .runtime(let code):return "The server could not complete this response (\(code))."
        }
    }
}

/// A bounded text-only request. No microphone, audio session, or TTS is started.
/// The completed SSE envelope is validated before any reply text crosses the bridge.
final class NativeText {
    private let transport:NativeTransport
    private var task:URLSessionDataTask?
    private var completion:((Result<[String:Any],Error>)->Void)?
    private var epoch=0
    var active:Bool{completion != nil}
    init(transport:NativeTransport){self.transport=transport}

    func stop(){
        epoch += 1;task?.cancel();task=nil
        let done=completion;completion=nil;done?(.failure(NativeTextError.cancelled))
    }

    func send(_ input:[String:Any],done:@escaping(Result<[String:Any],Error>)->Void){
        stop()
        guard let assistant=input["assistantId"] as? String,UUID(uuidString:assistant) != nil,
              let trace=input["trace"] as? String,UUID(uuidString:trace) != nil,
              let raw=input["userInput"] as? String,raw.count<=16000 else{done(.failure(NativeTextError.invalidInput));return}
        let text=raw.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !text.isEmpty else{done(.failure(NativeTextError.invalidInput));return}
        var body:[String:Any]=["assistantId":assistant,"userInput":text]
        if let relationship=input["relationshipId"] {
            guard let id=relationship as? String,UUID(uuidString:id) != nil else{done(.failure(NativeTextError.invalidInput));return}
            body["relationshipId"]=id
        }
        guard let data=try? JSONSerialization.data(withJSONObject:body),data.count<=65536,
              let encoded=String(data:data,encoding:.utf8) else{done(.failure(NativeTextError.invalidInput));return}
        let ticket=epoch,transportEpoch=transport.epoch;completion=done
        // The runtime's inference deadline is 30 seconds; leave time for admission and transport.
        task=transport.request("/api/runtime/v1/messages",method:"POST",body:encoded,timeout:45){[weak self] result in
            guard let self,self.epoch==ticket else{return}
            let answer:Result<[String:Any],Error>
            if self.transport.epoch != transportEpoch {answer = .failure(NativeTextError.cancelled)}
            else {answer=result.flatMap{data,response in Result {
                guard response.statusCode==200 else{throw NativeTextError.http(response.statusCode)}
                guard response.mimeType=="text/event-stream" else{throw NativeTextError.invalidStream}
                let reply=try Self.parse(data,assistant:assistant)
                return ["trace":trace,"interactionTraceId":reply.trace,"text":reply.text]
            }}}
            self.task=nil;let callback=self.completion;self.completion=nil;callback?(answer)
        }
    }

    private static func parse(_ data:Data,assistant:String) throws -> (trace:String,text:String) {
        guard data.count<=262144,let raw=String(data:data,encoding:.utf8) else{throw NativeTextError.invalidStream}
        let source=raw.replacingOccurrences(of:"\r\n",with:"\n")
        guard source.hasSuffix("\n\n") else{throw NativeTextError.invalidStream}
        var trace:String?,text="",completed=false
        for block in source.components(separatedBy:"\n\n") where !block.isEmpty {
            var event="",parts=[String]()
            for line in block.components(separatedBy:"\n") {
                if line.hasPrefix("event:"){event=String(line.dropFirst(6)).trimmingCharacters(in:.whitespaces)}
                if line.hasPrefix("data:"){parts.append(String(line.dropFirst(5)).trimmingCharacters(in:.whitespaces))}
            }
            guard !parts.isEmpty else{continue}
            guard !completed,let payload=(try? JSONSerialization.jsonObject(with:Data(parts.joined(separator:"\n").utf8))) as? [String:Any] else{throw NativeTextError.invalidStream}
            switch event {
            case "interaction.started":
                guard trace==nil,let id=payload["interactionId"] as? String,UUID(uuidString:id) != nil,
                      payload["assistantId"] as? String==assistant else{throw NativeTextError.invalidStream}
                trace=id
            case "message.delta":
                guard let trace,payload["interactionId"] as? String==trace,let delta=payload["text"] as? String,
                      text.utf8.count+delta.utf8.count<=64000 else{throw NativeTextError.invalidStream}
                text += delta
            case "interaction.completed":
                guard let trace,payload["interactionId"] as? String==trace else{throw NativeTextError.invalidStream}
                completed=true
            case "interaction.error":
                let code=payload["code"] as? String ?? "response_failed"
                throw NativeTextError.runtime(code.range(of:"^[a-z_]{1,64}$",options:.regularExpression) != nil ? code:"response_failed")
            default:break // Manifest and provider metadata are not conversation text.
            }
        }
        guard let trace,completed else{throw NativeTextError.invalidStream}
        return (trace,text)
    }
}
