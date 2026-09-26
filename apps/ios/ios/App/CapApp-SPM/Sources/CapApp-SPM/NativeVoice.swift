// SPDX-License-Identifier: Apache-2.0
import AVFoundation
import UIKit
import MediaPlayer
import AssistantCore

/// All turn/audio/network lifecycle runs natively; JavaScript is only a foreground view.
final class NativeVoice {
    let transport:NativeTransport
    var emit:([String:Any])->Void = {_ in}
    private let audio=AVAudioSession.sharedInstance()
    private var engine:AVAudioEngine?,player:AVAudioPlayerNode?,socket:URLSessionWebSocketTask?
    private var observers=[NSObjectProtocol](),remoteTargets=[(MPRemoteCommand,Any)]()
    private var gate=SpeechGate(),reply=ReplyStream(),request=[String:Any]()
    private var generation=0,outputGeneration=0,queued=0,sequence=0,samples=0,sentMessages=0
    private var poll:Timer?,meter:Timer?,deadline:Timer?,privacyPending=false,privacyKey:String?,privacyExpires:Date?
    private var resumeRead:(()->Void)?
    private var tapRate:Double=0,routeRestart=false
    private var captureChunks=0;private let captureLock=NSLock()
    private var background=false,active=false,accepted=false,turnPending=false,phase="Stopped",amplitude:Float=0,played=0
    init(transport:NativeTransport){
        self.transport=transport
        observe(AVAudioSession.interruptionNotification){[weak self] n in self?.interruption(n)}
        observe(AVAudioSession.routeChangeNotification){[weak self] n in self?.routeChanged(n)}
        observe(AVAudioSession.mediaServicesWereResetNotification){[weak self] _ in self?.stop("Audio services reset. Start listening again.")}
        observe(UIApplication.didEnterBackgroundNotification){[weak self] _ in guard let self else{return};if !self.background{self.stop("Background conversation is off.")}else{self.publish()}}
        observe(UIApplication.willEnterForegroundNotification){[weak self] _ in self?.publish()}
        let center=MPRemoteCommandCenter.shared()
        for command in [center.stopCommand,center.pauseCommand,center.togglePlayPauseCommand] { let target=command.addTarget{[weak self] _ in DispatchQueue.main.async{self?.stop("Stopped from lock screen or headset.")};return .success};remoteTargets.append((command,target));command.isEnabled=false }
        center.playCommand.isEnabled=false
    }
    deinit{observers.forEach{NotificationCenter.default.removeObserver($0)};remoteTargets.forEach{$0.0.removeTarget($0.1)}}
    private func observe(_ name:Notification.Name,_ handler:@escaping(Notification)->Void){observers.append(NotificationCenter.default.addObserver(forName:name,object:nil,queue:.main,using:handler))}
    func snapshot()->[String:Any]{["active":active,"phase":phase,"backgroundEnabled":background,"route":audio.currentRoute.outputs.map{$0.portName}.joined(separator:", ")+" · Mic: "+audio.currentRoute.inputs.map{$0.portName}.joined(separator:", "),"playing":queued>0,"amplitude":amplitude,"sampleOffset":played,"trace":reply.trace ?? "","clock":"dataPlayedBack callbacks","queuedSamples":queued]}
    private func publish(){emit(["type":"state","state":snapshot()])}
    func start(_ input:[String:Any],background:Bool,resumingRoute:Bool=false,done:@escaping(Error?)->Void){
        guard UIApplication.shared.applicationState == .active || (resumingRoute && active && self.background) else{done(VoiceError.staleTurn);return}
        let previousPrivacy=resumingRoute ? privacyKey:nil
        stop("Preparing audio");privacyKey=previousPrivacy
        for key in ["sessionId","endpointId","assistantId"]{guard let s=input[key] as? String,UUID(uuidString:s) != nil else{done(VoiceError.invalidMessage);return}}
        guard let revision=input["expectedSessionRevision"] as? Int,revision>=0 else{done(VoiceError.invalidMessage);return}
        request=input;request["schemaVersion"]="1.0.0";request["requestId"]=UUID().uuidString.lowercased();request["correlationId"]=UUID().uuidString.lowercased();request["audioInputId"]=UUID().uuidString.lowercased();request["format"]=["encoding":"pcm_s16le","sampleRateHz":16000,"channels":1]
        self.background=background;let ticket=generation
        audio.requestRecordPermission{[weak self] granted in DispatchQueue.main.async{
            guard let self,self.generation==ticket else{done(VoiceError.staleTurn);return}
            guard granted else{done(NSError(domain:"Microphone permission denied",code:1));return}
            self.checkPrivacy{[weak self] okay in guard let self,self.generation==ticket else{done(VoiceError.staleTurn);return};guard okay else{done(VoiceError.staleTurn);return}
                do{
                    self.active=true;self.phase="Connecting";let ws=try self.transport.webSocket();self.socket=ws
                    self.transport.socketOpened={[weak self,weak ws] opened in guard let self,self.generation==ticket,opened===ws,self.socket===ws else{return};self.send(["type":"start","request":self.request])}
                    self.transport.socketClosed={[weak self,weak ws] closed in guard let self,closed===ws,self.socket===ws else{return};self.stop("Connection closed. Start again when available.")}
                    ws.resume();self.receive(ws,ticket:ticket)
                    self.deadline=Timer.scheduledTimer(withTimeInterval:10,repeats:false){[weak self] _ in if self?.accepted != true{self?.stop("Connection did not become ready.")}}
                    self.poll=Timer.scheduledTimer(withTimeInterval:0.5,repeats:true){[weak self] _ in self?.privacyTick()}
                    self.meter=Timer.scheduledTimer(withTimeInterval:0.1,repeats:true){[weak self] _ in self?.publish()}
                    self.publish();done(nil)
                }catch{self.stop("Audio setup failed.");done(error)}
            }
        }}
    }
    private func startEngine() throws {
        var options:AVAudioSession.CategoryOptions=[.defaultToSpeaker]
        if #available(iOS 26.0,*){options.insert(.allowBluetoothHFP)}else{options.insert(.allowBluetooth)}
        try audio.setCategory(.playAndRecord,mode:.voiceChat,options:options)
        try audio.setPreferredIOBufferDuration(0.02);try audio.setActive(true)
        let engine=AVAudioEngine(),player=AVAudioPlayerNode();self.engine=engine;self.player=player
        try engine.inputNode.setVoiceProcessingEnabled(true)
        let inputFormat=engine.inputNode.outputFormat(forBus:0),target=AVAudioFormat(commonFormat:.pcmFormatFloat32,sampleRate:16000,channels:1,interleaved:false)!
        guard inputFormat.sampleRate>0,let converter=AVAudioConverter(from:inputFormat,to:target) else{throw VoiceError.invalidFrame}
        tapRate=inputFormat.sampleRate
        let ticket=generation
        engine.inputNode.installTap(onBus:0,bufferSize:1024,format:inputFormat){[weak self] buffer,_ in
            guard let self else{return}
            self.captureLock.lock();let admitted=self.captureChunks<8;if admitted{self.captureChunks += 1};self.captureLock.unlock()
            guard admitted else{DispatchQueue.main.async{if self.generation==ticket{self.stop("Microphone processing could not keep up. Start again.")}};return}
            let capacity=AVAudioFrameCount(ceil(Double(buffer.frameLength)*16000/inputFormat.sampleRate)+32)
            guard let converted=AVAudioPCMBuffer(pcmFormat:target,frameCapacity:capacity) else{self.releaseCapture();return}
            var supplied=false,error:NSError?
            converter.convert(to:converted,error:&error){_,status in if supplied{status.pointee = .noDataNow;return nil};supplied=true;status.pointee = .haveData;return buffer}
            guard error==nil,let channel=converted.floatChannelData?[0],converted.frameLength>0 else{self.releaseCapture();return}
            let values=Array(UnsafeBufferPointer(start:channel,count:Int(converted.frameLength)))
            DispatchQueue.main.async{self.releaseCapture();guard self.generation==ticket,self.active,self.accepted else{return};self.input(values)}
        }
        engine.attach(player);engine.connect(player,to:engine.mainMixerNode,format:AVAudioFormat(standardFormatWithSampleRate:48000,channels:1)!)
        engine.prepare();try engine.start();player.play();phase="Listening"
        MPNowPlayingInfoCenter.default().nowPlayingInfo=[MPMediaItemPropertyTitle:"Lifestream conversation",MPNowPlayingInfoPropertyIsLiveStream:true,MPNowPlayingInfoPropertyPlaybackRate:1]
        remoteTargets.forEach{$0.0.isEnabled=true};publish()
    }
    private func releaseCapture(){captureLock.lock();captureChunks -= 1;captureLock.unlock()}
    private func input(_ values:[Float]){
        guard !turnPending || reply.trace != nil else{return}
        for event in gate.push(values){switch event{
        case .began:interruptReply("New speech");sequence=0;samples=0;phase="Listening"
        case .frame(let bytes):send(["type":"frame","audioInputId":request["audioInputId"]!,"frame":["frameId":UUID().uuidString.lowercased(),"sequence":sequence,"format":["encoding":"pcm_s16le","sampleRateHz":16000,"channels":1],"sampleOffset":samples,"sampleCount":bytes.count/2,"dataBase64":bytes.base64EncodedString()]]);sequence += 1;samples += bytes.count/2
        case .commit(let next,let count):send(["type":"commitTurn","audioInputId":request["audioInputId"]!,"nextSequence":next,"sampleCount":count]);turnPending=true;phase="Thinking"
        }}
    }
    private func send(_ message:[String:Any]){
        guard let socket,let data=try? JSONSerialization.data(withJSONObject:message),let text=String(data:data,encoding:.utf8),sentMessages<128 else{if active{stop("Speech transport queue exceeded its bound.")};return}
        sentMessages += 1;let ticket=generation
        socket.send(.string(text)){[weak self] error in DispatchQueue.main.async{guard let self,self.generation==ticket else{return};self.sentMessages -= 1;if error != nil{self.stop("Speech connection lost.")}}}
    }
    private func receive(_ ws:URLSessionWebSocketTask,ticket:Int){ws.receive{[weak self,weak ws] result in DispatchQueue.main.async{
        guard let self,let ws,self.generation==ticket,self.socket===ws else{return}
        do{let data:Data;switch try result.get(){case .string(let s):data=Data(s.utf8);case .data(let d):data=d;@unknown default:throw VoiceError.invalidMessage}
            guard let m=try JSONSerialization.jsonObject(with:data) as? [String:Any] else{throw VoiceError.invalidMessage}
            try self.message(m);if self.active{if self.queued >= 96000{self.resumeRead={[weak self,weak ws] in guard let self,let ws,self.generation==ticket else{return};self.receive(ws,ticket:ticket)}}else{self.receive(ws,ticket:ticket)}}
        }catch{self.stop("Speech connection stopped. Reconnect to retry.")}
    }}}
    private func message(_ m:[String:Any]) throws {
        guard let type=m["type"] as? String else{throw VoiceError.invalidMessage}
        if type=="accepted"{guard !accepted,m["audioInputId"] as? String == request["audioInputId"] as? String else{throw VoiceError.invalidMessage};accepted=true;deadline?.invalidate();try startEngine();return}
        if type=="error"{throw VoiceError.invalidMessage}
        let event=m["event"] as? [String:Any],trace=(m["interactionTraceId"] as? String) ?? (event?["interactionTraceId"] as? String)
        guard let trace else{return};if reply.retired.contains(trace){return}
        if type=="turnStarted"{try reply.begin(trace);played=0;deadline?.invalidate();deadline=Timer.scheduledTimer(withTimeInterval:180,repeats:false){[weak self] _ in self?.stop("Response expired.")};phase="Thinking";return}
        guard trace==reply.trace else{throw VoiceError.staleTurn}
        if type=="stopPlayback"{interruptReply("Stopped by runtime");return}
        if type=="transcript"{if let text=m["text"] as? String,text.count<=16000{emit(["type":"transcript","role":"user","text":text,"trace":trace])};return}
        if type=="response",let payload=event?["payload"] as? [String:Any]{
            if payload["type"] as? String == "textDelta",let text=payload["text"] as? String,text.count<=16000{emit(["type":"textDelta","text":text,"trace":trace])}
            if payload["type"] as? String == "terminal"{guard payload["state"] as? String == "completed" else{throw VoiceError.invalidMessage};try reply.finish(trace);completeIfReady()}
        }
        if type=="audio"{
            guard let chunk=m["chunk"] as? [String:Any],let segment=chunk["segmentId"] as? String,let frame=chunk["frame"] as? [String:Any],let format=frame["format"] as? [String:Any],format["encoding"] as? String == "pcm_s16le",format["sampleRateHz"] as? Int == 48000,format["channels"] as? Int == 1,let n=frame["sampleCount"] as? Int,let seq=frame["sequence"] as? Int,let offset=frame["sampleOffset"] as? Int,let encoded=frame["dataBase64"] as? String,let bytes=Data(base64Encoded:encoded) else{throw VoiceError.invalidFrame}
            try reply.accept(trace:trace,segment:segment,sequence:seq,offset:offset,count:n,bytes:bytes,queuedSamples:queued)
            guard let player,let buffer=AVAudioPCMBuffer(pcmFormat:AVAudioFormat(standardFormatWithSampleRate:48000,channels:1)!,frameCapacity:AVAudioFrameCount(n)) else{throw VoiceError.invalidFrame}
            buffer.frameLength=AVAudioFrameCount(n);var energy:Float=0
            for i in 0..<n{let bits=UInt16(bytes[i*2]) | UInt16(bytes[i*2+1])<<8;let value=Float(Int16(bitPattern:bits))/32768;buffer.floatChannelData![0][i]=value;energy += value*value}
            queued += n;let ticket=outputGeneration,level=sqrt(energy/Float(n));phase="Speaking"
            player.scheduleBuffer(buffer,completionCallbackType:.dataPlayedBack){[weak self] _ in DispatchQueue.main.async{guard let self,self.outputGeneration==ticket else{return};self.queued -= n;self.played += n;self.amplitude=self.queued>0 ? level:0;self.completeIfReady();if self.queued<96000,let resume=self.resumeRead{self.resumeRead=nil;resume()}}}
            if queued==n{amplitude=level};publish()
        }
    }
    private func completeIfReady(){if reply.terminal && queued==0{send(["type":"playbackSettled","interactionTraceId":reply.trace!,"outcome":"completed","receivedSamples":reply.totalSamples]);reply.retire();turnPending=false;phase="Listening";deadline?.invalidate();publish()}}
    private func interruptReply(_ reason:String){
        outputGeneration += 1;player?.stop();player?.play();queued=0;amplitude=0;played=0
        if let trace=reply.trace{send(["type":"interrupt","interactionTraceId":trace,"reason":reason]);send(["type":"playbackSettled","interactionTraceId":trace,"outcome":"stopped","receivedSamples":reply.totalSamples]);reply.retire()};turnPending=false;deadline?.invalidate();if let resume=resumeRead{resumeRead=nil;resume()}
    }
    func stop(_ reason:String="Stopped"){
        if socket != nil{interruptReply(reason)}
        generation += 1;active=false;accepted=false;background=false;gate.reset();sentMessages=0;turnPending=false
        socket?.cancel(with:.normalClosure,reason:nil);socket=nil;transport.socketOpened=nil;transport.socketClosed=nil
        engine?.inputNode.removeTap(onBus:0);engine?.stop();engine=nil;player=nil
        poll?.invalidate();meter?.invalidate();deadline?.invalidate();poll=nil;meter=nil;deadline=nil;privacyPending=false;privacyKey=nil;privacyExpires=nil
        try? audio.setActive(false,options:.notifyOthersOnDeactivation);remoteTargets.forEach{$0.0.isEnabled=false};MPNowPlayingInfoCenter.default().nowPlayingInfo=nil
        resumeRead=nil;phase=reason;publish()
    }
    private func checkPrivacy(_ done:@escaping(Bool)->Void){
        guard !privacyPending else{done(false);return};privacyPending=true;let ticket=generation
        transport.request("/api/runtime/v1/audience",timeout:1.2){[weak self] result in
            guard let self,self.generation==ticket else{done(false);return};self.privacyPending=false
            guard case .success(let (bytes,response))=result,response.statusCode==200,let value=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any],let allowed=value["privateAllowed"] as? Bool,let classification=value["classification"] as? String else{done(false);return}
            let key="\(classification):\(allowed)";if let old=self.privacyKey,old != key{done(false);return};self.privacyKey=key
            do {let policy=try AudienceLease(value,now:Date());self.privacyExpires=policy.expiresAt;done(true)} catch {done(false)}
        }
    }
    private func privacyTick(){
        if let expires=privacyExpires,expires<=Date(){stop("Audience declaration expired.");return}
        guard !privacyPending else{return};checkPrivacy{[weak self] current in if !current{self?.stop("Audience or authorization changed. Review before restarting.")}}
    }
    private func interruption(_ notification:Notification){
        guard active,let raw=notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,AVAudioSession.InterruptionType(rawValue:raw) == .began else{return}
        stop("Interrupted by another app or call. Tap Start listening to resume.")
    }
    private func routeChanged(_ notification:Notification){
        guard active,accepted,let raw=notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,let reason=AVAudioSession.RouteChangeReason(rawValue:raw) else{publish();return}
        if reason == .oldDeviceUnavailable {stop("Headphones disconnected. Review the output route before restarting.");return}
        if reason == .newDeviceAvailable || reason == .routeConfigurationChange {
            // Replace the transport as well as the graph: partial PCM on the old route cannot
            // become a truncated utterance on the new route. Recheck the same audience policy.
            guard !routeRestart else{return}
            let changed = engine?.inputNode.outputFormat(forBus:0).sampleRate != tapRate
            if reason == .newDeviceAvailable || changed || engine?.isRunning != true {
                routeRestart=true;let ticket=generation
                DispatchQueue.main.asyncAfter(deadline:.now()+0.25){[weak self] in
                    guard let self else{return};self.routeRestart=false
                    guard self.generation==ticket,self.active else{return}
                    let input=self.request,keepBackground=self.background
                    self.start(input,background:keepBackground,resumingRoute:true){[weak self] error in
                        if error != nil {self?.stop("Audio route unavailable. Start again.")}
                    }
                }
            }
        };publish()
    }
}
