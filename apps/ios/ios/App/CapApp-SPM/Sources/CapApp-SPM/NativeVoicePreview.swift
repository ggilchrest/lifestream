// SPDX-License-Identifier: Apache-2.0
import Foundation
import AVFoundation
import AssistantCore

/// Native output-only preview. Reference samples and audio never enter the web view.
final class NativeVoicePreview {
    private let transport:NativeTransport
    private var task:URLSessionDataTask?,engine:AVAudioEngine?,player:AVAudioPlayerNode?,trace:String?,timer:Timer?
    private var samples=0,ownership=PreviewOwnership()
    private var finish:((Result<[String:Any],Error>)->Void)?
    #if os(macOS)
    // Host tests provide a simulated playback completion; iOS always uses the real engine.
    var hostPlayback:((@escaping ()->Void)->Void)?
    #endif
    init(transport:NativeTransport){self.transport=transport}
    var busy:Bool{finish != nil || ownership.busy(now:ProcessInfo.processInfo.systemUptime)}
    var status:[String:Any]{let wait=ownership.waitSeconds(now:ProcessInfo.processInfo.systemUptime);return ["state":finish != nil ? "playing" : ownership.isSettling ? "settling" : wait>0 ? "waiting" : "ready","retryAfterSeconds":wait]}
    func start(_ input:[String:Any],done:@escaping(Result<[String:Any],Error>)->Void){
        guard !busy,let assistant=input["assistantId"] as? String,UUID(uuidString:assistant) != nil else{done(.failure(VoiceError.invalidMessage));return}
        let isReference=input["referenceId"] != nil
        if isReference{guard Set(input.keys)==["assistantId","referenceId"],let id=input["referenceId"] as? String,UUID(uuidString:id) != nil else{done(.failure(VoiceError.invalidMessage));return}}
        else{guard let text=input["text"] as? String,!text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,text.count<=300 else{done(.failure(VoiceError.invalidMessage));return}}
        let keys=Set(input.keys);var request=input;request.removeValue(forKey:"voiceRevision")
        guard (isReference || keys.isSubset(of:["assistantId","text","expectedActiveRevision","voiceDraft","voiceRef","voiceRevision"])),!(input["voiceDraft"] != nil && input["voiceRef"] != nil),let data=try? JSONSerialization.data(withJSONObject:request),data.count<=4096,let body=String(data:data,encoding:.utf8) else{done(.failure(VoiceError.invalidMessage));return}
        finish=done;trace=nil;samples=0
        // If cancellation precedes receipt of the ownership header, the server
        // may own output until its deadline. Allow for delayed admission as well
        // as the server's 180-second lease before starting another preview.
        let ticket=ownership.begin(now:ProcessInfo.processInfo.systemUptime)
        task=transport.request(isReference ? "/api/runtime/v1/voice-reference-preview":"/api/runtime/v1/tts",method:"POST",body:body,timeout:45,internalPreview:true,maxBytes:8*1024*1024,onResponse:{[weak self] response in
            guard let self,self.ownership.isCurrent(ticket) else{return}
            let date=ISO8601DateFormatter();date.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
            if response.statusCode==200,let raw=response.value(forHTTPHeaderField:"x-lifestream-playback-trace"),UUID(uuidString:raw) != nil,let expiry=response.value(forHTTPHeaderField:"x-lifestream-playback-expires"),let expires=date.date(from:expiry),expires.timeIntervalSinceNow>0,expires.timeIntervalSinceNow<=181 {self.trace=raw;self.ownership.admitted(now:ProcessInfo.processInfo.systemUptime,remaining:expires.timeIntervalSinceNow)}
            else if response.statusCode != 200 {self.ownership.rejected()}
        }){[weak self] result in
            guard let self,self.ownership.isCurrent(ticket),self.finish != nil else{return};self.task=nil
            do{let (data,response)=try result.get();guard response.statusCode==200,response.mimeType=="application/x-ndjson",self.trace != nil else{throw VoiceError.invalidMessage}
                let rate=isReference ? 16000:48000;var parser=VoicePreviewStream(expectedVoiceRef:input["voiceRef"] as? String,expectedRevision:input["voiceRef"] == nil ? nil:input["voiceRevision"] as? Int,sampleRate:rate)
                for offset in stride(from:0,to:data.count,by:65536){try parser.append(data.subdata(in:offset..<min(offset+65536,data.count)))};let parsed=try parser.finish();self.samples=parsed.samples
                try self.play(parsed,sampleRate:rate,ticket:ticket)
            }catch{self.stop(error:error)}
        }
        timer=Timer.scheduledTimer(withTimeInterval:110,repeats:false){[weak self] _ in self?.stop(error:VoiceError.staleTurn)}
    }
    private func play(_ result:VoicePreviewStream.Result,sampleRate:Int,ticket:Int)throws{
        #if os(macOS)
        guard let hostPlayback else{throw VoiceError.invalidMessage}
        hostPlayback{[weak self] in DispatchQueue.main.async{guard let self,self.ownership.isCurrent(ticket),self.finish != nil else{return};self.complete(result)}}
        #else
        let audio=AVAudioSession.sharedInstance();try audio.setCategory(.playback,mode:.default);try audio.setActive(true)
        let engine=AVAudioEngine(),player=AVAudioPlayerNode(),format=AVAudioFormat(standardFormatWithSampleRate:Double(sampleRate),channels:1)!
        guard let buffer=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:AVAudioFrameCount(result.samples)) else{throw VoiceError.invalidFrame}
        buffer.frameLength=AVAudioFrameCount(result.samples)
        for offset in stride(from:0,to:result.samples,by:4800){let count=min(4800,result.samples-offset),bytes=result.pcm.subdata(in:(offset*2)..<((offset+count)*2)),values=try PlaybackPCM.decode(bytes,samples:count);for (index,value) in values.enumerated(){buffer.floatChannelData![0][offset+index]=value}}
        engine.attach(player);engine.connect(player,to:engine.mainMixerNode,format:format);engine.prepare();try engine.start();self.engine=engine;self.player=player
        player.scheduleBuffer(buffer,completionCallbackType:.dataPlayedBack){[weak self] _ in DispatchQueue.main.async{guard let self,self.ownership.isCurrent(ticket),self.finish != nil else{return};self.complete(result)}};player.play()
        #endif
    }
    private func cleanup(){timer?.invalidate();timer=nil;task?.cancel();task=nil;player?.stop();engine?.stop();player=nil;engine=nil;
        #if !os(macOS)
        try? AVAudioSession.sharedInstance().setActive(false,options:.notifyOthersOnDeactivation)
        #endif
    }
    private func complete(_ result:VoicePreviewStream.Result){let done=finish;finish=nil;ownership.retire();cleanup();settle("completed"){ok in if ok{var value:[String:Any]=["degraded":result.degraded,"physicalPlaybackConfirmed":false];if let id=result.previewId{value["previewId"]=id};done?(.success(value))}else{done?(.failure(VoiceError.staleTurn))}}}
    func stop(error:Error=VoiceError.staleTurn){guard finish != nil else{return};let done=finish;finish=nil;ownership.retire();cleanup();settle("stopped"){_ in done?(.failure(error))}}
    private func settle(_ outcome:String,done:@escaping(Bool)->Void){
        guard let trace else{done(false);return};self.trace=nil;ownership.beginSettlement()
        let body=try? JSONSerialization.data(withJSONObject:["type":"playbackSettled","interactionTraceId":trace,"outcome":outcome,"receivedSamples":samples]);guard let body,let text=String(data:body,encoding:.utf8) else{ownership.finishSettlement(accepted:false);done(false);return}
        transport.request("/api/runtime/v1/tts/playback",method:"POST",body:text,timeout:5,internalPreview:true,maxBytes:4096){[weak self] result in
            guard let self else{return};let okay:Bool;if case .success(let (data,response))=result{okay=PreviewOwnership.settlementAccepted(status:response.statusCode,data:data)}else{okay=false};self.ownership.finishSettlement(accepted:okay);done(okay)
        }
    }
}
