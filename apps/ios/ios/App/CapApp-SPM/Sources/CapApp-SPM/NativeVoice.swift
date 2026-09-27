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
    private struct Graph {let engine:AVAudioEngine,player:AVAudioPlayerNode}
    private let graphOwner=CaptureGraphOwner<Graph>()
    private var engine:AVAudioEngine?{graphOwner.current?.engine}
    private var player:AVAudioPlayerNode?{graphOwner.current?.player}
    private var socket:URLSessionWebSocketTask?
    private var diagnostics=CaptureDiagnostics()
    private(set) var selectedInput="system"
    private var observers=[NSObjectProtocol](),remoteTargets=[(MPRemoteCommand,Any)]()
    private var gate=SpeechGate(),reply=ReplyStream(),activity=VoiceActivity(),request=[String:Any]()
    private var generation=0,outputGeneration=0,queued=0,sequence=0,samples=0,sentMessages=0
    private var poll:Timer?,meter:Timer?,deadline:Timer?,inputRouteTimer:Timer?,privacyPending=false,privacyKey:String?,privacyExpires:Date?
    private var resumeRead:(()->Void)?
    private var capture:NativeCapture?,captureLifecycle=CaptureLifecycle(),tapInstalled=false
    private var lastCaptureStats:NativeCapture.Stats?
    private var background=false,active=false,accepted=false,turnPending=false,phase="Stopped",amplitude:Float=0,played=0
    init(transport:NativeTransport){
        self.transport=transport
        observe(AVAudioSession.interruptionNotification){[weak self] n in self?.interruption(n)}
        observe(AVAudioSession.routeChangeNotification){[weak self] n in self?.routeChanged(n)}
        observe(.AVAudioEngineConfigurationChange){[weak self] n in self?.engineChanged(n)}
        observe(AVAudioSession.mediaServicesWereResetNotification){[weak self] _ in self?.stop("Audio services reset. Start listening again.")}
        observe(UIApplication.didEnterBackgroundNotification){[weak self] _ in guard let self else{return};if !self.background{self.stop("Background conversation is off.")}else{self.publish()}}
        observe(UIApplication.willEnterForegroundNotification){[weak self] _ in self?.publish()}
        let center=MPRemoteCommandCenter.shared()
        for command in [center.stopCommand,center.pauseCommand,center.togglePlayPauseCommand] { let target=command.addTarget{[weak self] _ in DispatchQueue.main.async{self?.stop("Stopped from lock screen or headset.")};return .success};remoteTargets.append((command,target));command.isEnabled=false }
        center.playCommand.isEnabled=false
    }
    deinit{observers.forEach{NotificationCenter.default.removeObserver($0)};remoteTargets.forEach{$0.0.removeTarget($0.1)}}
    private func observe(_ name:Notification.Name,_ handler:@escaping(Notification)->Void){observers.append(NotificationCenter.default.addObserver(forName:name,object:nil,queue:.main,using:handler))}
    func snapshot()->[String:Any]{
        let stats=capture?.snapshot() ?? lastCaptureStats
        return activity.snapshot.merging(["active":active,"phase":phase,"backgroundEnabled":background,"route":routeSummary(),"selectedInputLabel":inputSelectionSummary(),"captureDiagnostics":diagnostics.lines,"playing":queued>0,"amplitude":amplitude,"sampleOffset":played,"trace":reply.trace ?? "","clock":"dataPlayedBack callbacks","queuedSamples":queued,"rawInputBuffers":stats?.rawBuffers ?? 0,"convertedInputBuffers":stats?.convertedBuffers ?? 0,"captureSampleRate":stats?.sampleRate ?? 0,"captureChannels":stats?.channels ?? 0,"captureEngineRunning":engine?.isRunning == true]){_,new in new}
    }
    private func publish(){emit(["type":"state","state":snapshot()])}
    func start(_ input:[String:Any],background:Bool,resumingRoute:Bool=false,done:@escaping(Error?)->Void){
        guard UIApplication.shared.applicationState == .active || (resumingRoute && active && self.background) else{done(VoiceError.staleTurn);return}
        let previousPrivacy=resumingRoute ? privacyKey:nil
        stop("Preparing audio",preservingGraph:resumingRoute)
        if !resumingRoute{diagnostics.clear();lastCaptureStats=nil};diagnose(resumingRoute ? "recover-transport":"user-start")
        captureLifecycle.begin(generation:generation,recovering:resumingRoute);lastCaptureStats=nil;activity.start();phase="Starting microphone connection";privacyKey=previousPrivacy;publish()
        for key in ["sessionId","endpointId","assistantId"]{guard let s=input[key] as? String,UUID(uuidString:s) != nil else{fail("Select a current Assistant and reconnect before listening.",stage:"backend");done(VoiceError.invalidMessage);return}}
        guard let revision=input["expectedSessionRevision"] as? Int,revision>=0 else{fail("The conversation session is out of date. Reconnect before listening.",stage:"backend");done(VoiceError.invalidMessage);return}
        request=input;request["schemaVersion"]="1.0.0";request["requestId"]=UUID().uuidString.lowercased();request["correlationId"]=UUID().uuidString.lowercased();request["audioInputId"]=UUID().uuidString.lowercased();request["format"]=["encoding":"pcm_s16le","sampleRateHz":16000,"channels":1]
        self.background=background;let ticket=generation
        audio.requestRecordPermission{[weak self] granted in DispatchQueue.main.async{
            guard let self,self.generation==ticket else{done(VoiceError.staleTurn);return}
            guard granted else{self.fail("Microphone permission is off. Enable Microphone for Lifestream in Settings.",stage:"input");done(NSError(domain:"Microphone permission denied",code:1));return}
            self.checkPrivacy{[weak self] okay in guard let self,self.generation==ticket else{done(VoiceError.staleTurn);return};guard okay else{self.fail("Audio could not start: audience or sign-in could not be verified. Reconnect and review your audience.",stage:"backend");done(VoiceError.staleTurn);return}
                do{
                    self.active=true;self.phase="Connecting";let ws=try self.transport.webSocket();self.socket=ws
                    self.transport.socketOpened={[weak self,weak ws] opened in guard let self,self.generation==ticket,opened===ws,self.socket===ws else{return};self.send(["type":"start","request":self.request])}
                    self.transport.socketClosed={[weak self,weak ws] closed in guard let self,closed===ws,self.socket===ws else{return};self.fail("Speech connection closed. Check the private server and VPN, then start again.",stage:"backend")}
                    ws.resume();self.receive(ws,ticket:ticket)
                    self.deadline=Timer.scheduledTimer(withTimeInterval:10,repeats:false){[weak self] _ in guard let self,self.generation==ticket,!self.accepted else{return};self.fail("The speech connection did not become ready within 10 seconds. Check the private server and VPN.",stage:"backend")}
                    self.poll=Timer.scheduledTimer(withTimeInterval:0.5,repeats:true){[weak self] _ in self?.privacyTick()}
                    self.meter=Timer.scheduledTimer(withTimeInterval:0.1,repeats:true){[weak self] _ in self?.meterTick()}
                    self.publish();done(nil)
                }catch{self.fail("Audio setup failed. Check the microphone permission and selected audio device.",stage:"input");done(error)}
            }
        }}
    }
    private func prepareEngine() throws {
        let ticket=generation
        captureLifecycle.starting(generation:generation)
        let recovering=graphOwner.current != nil
        if !recovering {
            var options:AVAudioSession.CategoryOptions=[.defaultToSpeaker]
            if #available(iOS 26.0,*){options.insert(.allowBluetoothHFP)}else{options.insert(.allowBluetooth)}
            try audio.setCategory(.playAndRecord,mode:.voiceChat,options:options)
            try audio.setPreferredIOBufferDuration(0.02);try audio.setActive(true)
            diagnose("session-active")
        }
        guard generation==ticket,active,accepted else{return}
        let until=ProcessInfo.processInfo.systemUptime+4
        var preferenceApplied=recovering
        phase="Waiting for the selected microphone";diagnose("wait-input-route");publish()
        // setPreferredInput initiates routing. Wait for the actual route, without
        // installing a tap on a temporary fallback or assuming an arbitrary delay.
        func check(){
            guard generation==ticket,active,accepted else{return}
            do {
                if !preferenceApplied {
                    do{try applySelectedInput();preferenceApplied=true}
                    catch is AudioInputSelectionError{} // Discovery may still be updating.
                }
                guard generation==ticket,active,accepted else{return}
                if preferenceApplied,currentInputMatchesSelection(){
                    inputRouteTimer?.invalidate();inputRouteTimer=nil;diagnose("input-route-ready")
                    try startEngine();return
                }
                if ProcessInfo.processInfo.systemUptime>=until {
                    diagnose("input-route-timeout");fail("iOS did not route the selected microphone within 4 seconds. Open Microphone, choose an available input or System default, then tap Start.",stage:"input")
                }
            }catch{if generation==ticket,active,accepted{engineFailure(error)}}
        }
        inputRouteTimer=Timer.scheduledTimer(withTimeInterval:0.1,repeats:true){_ in check()}
        check()
    }
    private func engineFailure(_ error:Error){
        diagnose("engine-start-failed")
        let message=error is AudioInputSelectionError ? error.localizedDescription:"The microphone or audio device could not start. Open Microphone, choose an available input, then tap Start."
        fail(message,stage:"input")
    }
    private func startEngine() throws {
        let ticket=generation
        let recovering=graphOwner.current != nil
        let graph=try graphOwner.acquire{
            let engine=AVAudioEngine(),player=AVAudioPlayerNode()
            try engine.inputNode.setVoiceProcessingEnabled(true)
            engine.attach(player)
            return Graph(engine:engine,player:player)
        }
        guard generation==ticket,active,accepted else{return}
        let engine=graph.engine,player=graph.player
        diagnose(recovering ? "reuse-voice-graph":"create-voice-graph")
        let inputFormat=engine.inputNode.outputFormat(forBus:0)
        let capture=try NativeCapture(inputFormat:inputFormat);self.capture=capture
        // Each graph owns its converter and bounded queue. A late old tap cannot
        // consume the replacement graph's budget or update its observations.
        engine.inputNode.installTap(onBus:0,bufferSize:capture.bufferSize,format:inputFormat){[weak self] buffer,_ in
            capture.consume(buffer,deliver:{[weak self] values in
                guard let self,self.generation==ticket,self.active,self.accepted else{return}
                self.input(values)
            },failed:{[weak self] message in
                guard let self,self.generation==ticket else{return}
                self.fail(message,stage:"input")
            })
        }
        tapInstalled=true
        engine.connect(player,to:engine.mainMixerNode,format:AVAudioFormat(standardFormatWithSampleRate:48000,channels:1)!)
        // VPIO requires the capture output and playback input CLIENT formats to
        // match. The mixer converts server PCM; output hardware may differ.
        engine.connect(engine.mainMixerNode,to:engine.outputNode,format:inputFormat)
        guard generation==ticket,active,accepted else{engine.stop();return}
        engine.prepare();try engine.start()
        guard generation==ticket,active,accepted else{engine.stop();return}
        player.play()
        captureLifecycle.ready(generation:generation,route:routeFingerprint(),at:ProcessInfo.processInfo.systemUptime)
        diagnose("engine-started");activity.captureReady();phase="Microphone started · waiting for audio"
        MPNowPlayingInfoCenter.default().nowPlayingInfo=[MPMediaItemPropertyTitle:"Lifestream conversation",MPNowPlayingInfoPropertyIsLiveStream:true,MPNowPlayingInfoPropertyPlaybackRate:1]
        remoteTargets.forEach{$0.0.isEnabled=true};publish()
    }
    private func input(_ values:[Float]){
        guard selectedInput=="system" || currentInputMatchesSelection() else{diagnose("input-route-mismatch");engineFailure(AudioInputSelectionError.unavailable);return}
        guard !values.isEmpty,values.allSatisfy({$0.isFinite}) else{fail("Microphone produced invalid audio. Start listening again.",stage:"input");return}
        captureLifecycle.captured(generation:generation)
        if activity.inputFrames==0{diagnose("first-converted");phase="Listening · speak, then pause to send"}
        activity.captured(values,speaking:gate.speaking,waiting:turnPending && reply.trace == nil)
        guard !turnPending || reply.trace != nil else{return}
        for event in gate.push(values){switch event{
        case .began:interruptReply("New speech");sequence=0;samples=0;phase="Hearing speech · pause to send"
        case .frame(let bytes):send(["type":"frame","audioInputId":request["audioInputId"]!,"frame":["frameId":UUID().uuidString.lowercased(),"sequence":sequence,"format":["encoding":"pcm_s16le","sampleRateHz":16000,"channels":1],"sampleOffset":samples,"sampleCount":bytes.count/2,"dataBase64":bytes.base64EncodedString()]]);sequence += 1;samples += bytes.count/2;activity.sentFrame()
        case .commit(let next,let count):send(["type":"commitTurn","audioInputId":request["audioInputId"]!,"nextSequence":next,"sampleCount":count]);turnPending=true;activity.committed();phase="Transcribing your speech";armResponseDeadline()
        }}
    }
    private func send(_ message:[String:Any]){
        guard let socket,let data=try? JSONSerialization.data(withJSONObject:message),let text=String(data:data,encoding:.utf8),sentMessages<128 else{if active{fail("Speech transport queue exceeded its bound. Start listening again.",stage:"backend")};return}
        sentMessages += 1;let ticket=generation
        socket.send(.string(text)){[weak self] error in DispatchQueue.main.async{guard let self,self.generation==ticket else{return};self.sentMessages -= 1;if error != nil{self.fail("Speech connection lost. Check the private server and VPN.",stage:"backend")}}}
    }
    private func receive(_ ws:URLSessionWebSocketTask,ticket:Int){ws.receive{[weak self,weak ws] result in DispatchQueue.main.async{
        guard let self,let ws,self.generation==ticket,self.socket===ws else{return}
        do{let data:Data;switch try result.get(){case .string(let s):data=Data(s.utf8);case .data(let d):data=d;@unknown default:throw VoiceError.invalidMessage}
            guard let m=try JSONSerialization.jsonObject(with:data) as? [String:Any] else{throw VoiceError.invalidMessage}
            try self.message(m);if self.active{if self.queued >= 96000{self.resumeRead={[weak self,weak ws] in guard let self,let ws,self.generation==ticket else{return};self.receive(ws,ticket:ticket)}}else{self.receive(ws,ticket:ticket)}}
        }catch{self.fail("Speech processing stopped: the connection or audio response was invalid. Reconnect to retry.",stage:"backend")}
    }}}
    private func message(_ m:[String:Any]) throws {
        guard let type=m["type"] as? String else{throw VoiceError.invalidMessage}
        if type=="accepted"{guard !accepted,m["audioInputId"] as? String == request["audioInputId"] as? String else{throw VoiceError.invalidMessage};accepted=true;deadline?.invalidate();let ticket=generation;do{try prepareEngine()}catch{if generation==ticket,active,accepted{engineFailure(error)}};return}
        if type=="error"{let problem=m["problem"] as? [String:Any],message=problem?["message"] as? String;fail("Server: "+(message.map{String($0.filter{!$0.isNewline && !$0.unicodeScalars.contains(where:{$0.value<32})}.prefix(350))} ?? "Speech processing was rejected."),stage:"backend");return}
        let event=m["event"] as? [String:Any],trace=(m["interactionTraceId"] as? String) ?? (event?["interactionTraceId"] as? String)
        guard let trace else{return};if reply.retired.contains(trace){return}
        if type=="turnStarted"{try reply.begin(trace);played=0;armResponseDeadline();activity.committed();phase="Transcribing your speech";publish();return}
        guard trace==reply.trace else{throw VoiceError.staleTurn}
        if type=="stopPlayback"{interruptReply("Stopped by runtime");return}
        if type=="transcript"{activity.transcribed();phase="Assistant is processing";publish();if let text=m["text"] as? String,text.count<=16000{emit(["type":"transcript","role":"user","text":text,"trace":trace])};return}
        if type=="response",let payload=event?["payload"] as? [String:Any]{
            if payload["type"] as? String == "textDelta",let text=payload["text"] as? String,text.count<=16000{activity.receivedText();emit(["type":"textDelta","text":text,"trace":trace])}
            if payload["type"] as? String == "terminal"{guard payload["state"] as? String == "completed" else{fail("The backend could not complete the response. Please retry.",stage:"backend");return};try reply.finish(trace);activity.generationFinished();completeIfReady()}
        }
        if type=="audio"{
            guard let chunk=m["chunk"] as? [String:Any],let segment=chunk["segmentId"] as? String,let frame=chunk["frame"] as? [String:Any],let format=frame["format"] as? [String:Any],format["encoding"] as? String == "pcm_s16le",format["sampleRateHz"] as? Int == 48000,format["channels"] as? Int == 1,let n=frame["sampleCount"] as? Int,let seq=frame["sequence"] as? Int,let offset=frame["sampleOffset"] as? Int,let encoded=frame["dataBase64"] as? String,let bytes=Data(base64Encoded:encoded) else{throw VoiceError.invalidFrame}
            try reply.accept(trace:trace,segment:segment,sequence:seq,offset:offset,count:n,bytes:bytes,queuedSamples:queued)
            guard let player,let buffer=AVAudioPCMBuffer(pcmFormat:AVAudioFormat(standardFormatWithSampleRate:48000,channels:1)!,frameCapacity:AVAudioFrameCount(n)) else{throw VoiceError.invalidFrame}
            buffer.frameLength=AVAudioFrameCount(n);var energy:Float=0
            for i in 0..<n{let bits=UInt16(bytes[i*2]) | UInt16(bytes[i*2+1])<<8;let value=Float(Int16(bitPattern:bits))/32768;buffer.floatChannelData![0][i]=value;energy += value*value}
            queued += n;let ticket=outputGeneration,level=sqrt(energy/Float(n));phase="Speaking";activity.playing()
            player.scheduleBuffer(buffer,completionCallbackType:.dataPlayedBack){[weak self] _ in DispatchQueue.main.async{guard let self,self.outputGeneration==ticket else{return};self.queued -= n;self.played += n;self.amplitude=self.queued>0 ? level:0;if self.queued==0{self.activity.playbackDrained()};self.completeIfReady();if self.queued<96000,let resume=self.resumeRead{self.resumeRead=nil;resume()}}}
            if queued==n{amplitude=level};publish()
        }
    }
    private func completeIfReady(){if reply.terminal && queued==0{send(["type":"playbackSettled","interactionTraceId":reply.trace!,"outcome":"completed","receivedSamples":reply.totalSamples]);reply.retire();turnPending=false;activity.completed();phase="Listening · speak, then pause to send";deadline?.invalidate();publish()}}
    private func interruptReply(_ reason:String,resumePlayer:Bool=true){
        outputGeneration += 1;player?.stop();if resumePlayer,engine?.isRunning==true{player?.play()};queued=0;amplitude=0;played=0;activity.completed()
        if let trace=reply.trace{send(["type":"interrupt","interactionTraceId":trace,"reason":reason]);send(["type":"playbackSettled","interactionTraceId":trace,"outcome":"stopped","receivedSamples":reply.totalSamples]);reply.retire()};turnPending=false;deadline?.invalidate();if let resume=resumeRead{resumeRead=nil;resume()}
    }
    func stop(_ reason:String="Stopped",preservingGraph:Bool=false){
        if active || engine != nil{diagnose(preservingGraph ? "pause-graph":"stop")}
        if socket != nil{interruptReply(reason,resumePlayer:false)}
        generation += 1;captureLifecycle.stop(generation:generation);active=false;accepted=false;background=false;gate.reset();activity.stop();sentMessages=0;turnPending=false
        socket?.cancel(with:.normalClosure,reason:nil);socket=nil;transport.socketOpened=nil;transport.socketClosed=nil
        graphOwner.stop(recovering:preservingGraph,stop:{graph in
            if tapInstalled{graph.engine.inputNode.removeTap(onBus:0);tapInstalled=false}
            graph.player.stop();graph.engine.stop()
        },deactivate:{try? audio.setActive(false,options:.notifyOthersOnDeactivation)})
        lastCaptureStats=capture?.snapshot() ?? lastCaptureStats;capture=nil
        poll?.invalidate();meter?.invalidate();deadline?.invalidate();inputRouteTimer?.invalidate();poll=nil;meter=nil;deadline=nil;inputRouteTimer=nil;privacyPending=false;privacyKey=nil;privacyExpires=nil
        remoteTargets.forEach{$0.0.isEnabled=false};MPNowPlayingInfoCenter.default().nowPlayingInfo=nil
        resumeRead=nil;phase=reason;publish()
    }
    private func fail(_ message:String,stage:String){stop(message);activity.fail(message,stage:stage);publish()}
    private func armResponseDeadline(){deadline?.invalidate();let ticket=generation;deadline=Timer.scheduledTimer(withTimeInterval:180,repeats:false){[weak self] _ in guard let self,self.generation==ticket else{return};self.fail("The backend did not complete the response within 3 minutes. Please retry.",stage:"backend")}}
    private func meterTick(){
        let stats=capture?.snapshot()
        if let failure=captureLifecycle.failure(generation:generation,now:ProcessInfo.processInfo.systemUptime,lastRaw:stats?.lastRaw,lastConverted:stats?.lastConverted){
            let message:String
            switch failure {
            case .noRaw:message="The audio engine started, but iOS delivered no microphone buffers within 8 seconds. Check the input device, then tap Start to retry."
            case .noConversion:message="Microphone buffers arrived, but audio conversion produced no samples. Tap Start to retry."
            case .stalled:message="Microphone audio stopped arriving for 3 seconds. Check the input device, then tap Start to retry."
            }
            diagnose("watchdog");fail(message,stage:"input");return
        }
        publish()
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
        guard active,!privacyPending else{return};let ticket=generation
        checkPrivacy{[weak self] current in guard let self,self.generation==ticket,self.active else{return};if !current{self.stop("Audience or authorization changed. Review before restarting.")}}
    }
    private func interruption(_ notification:Notification){
        guard (active || engine != nil),let raw=notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,AVAudioSession.InterruptionType(rawValue:raw) == .began else{return}
        stop("Interrupted by another app or call. Tap Start listening to resume.")
    }
    private func availableInputPorts()->[AudioInputPort]{
        (audio.availableInputs ?? []).map{AudioInputPort(id:$0.uid,label:$0.portName,builtIn:$0.portType == .builtInMic)}
    }
    func inputChoices()->[AudioInputOption]{AudioInputSelection.options(availableInputPorts())}
    func inputSelectionSummary()->String{
        inputChoices().first{$0.id==selectedInput}?.label ?? "Selected microphone (not currently available)"
    }
    func selectInput(_ id:String){
        guard inputChoices().contains(where:{$0.id==id}) else{phase="That microphone is no longer available. Reopen Microphone to choose another input.";publish();return}
        stop("Microphone selection changed. Tap Start to use it.");selectedInput=id;publish()
    }
    private func currentInputMatchesSelection()->Bool{
        AudioInputSelection.isRouted(selectedInput,ports:availableInputPorts(),currentIds:audio.currentRoute.inputs.map{$0.uid})
    }
    private func applySelectedInput() throws {
        let uid=try AudioInputSelection.resolve(selectedInput,ports:availableInputPorts())
        let port=uid.flatMap{id in audio.availableInputs?.first{$0.uid==id}}
        if uid != nil && port == nil{throw AudioInputSelectionError.unavailable}
        try audio.setPreferredInput(port);diagnose("input-preference")
    }
    private func routeSummary()->String{
        let output=audio.currentRoute.outputs.map{$0.portName}.joined(separator:", ")
        let input=audio.currentRoute.inputs.map{$0.portName}.joined(separator:", ")
        return (output.isEmpty ? "System output":output)+" · "+(active ? "Mic: "+(input.isEmpty ? "not yet routed":input):"Mic off")+" · Selected: "+inputSelectionSummary()
    }
    private func diagnose(_ event:String){
        let stats=capture?.snapshot() ?? lastCaptureStats
        diagnostics.record(event,generation:generation,at:ProcessInfo.processInfo.systemUptime,engineRunning:engine?.isRunning == true,inputPorts:audio.currentRoute.inputs.map{$0.portType.rawValue},outputPorts:audio.currentRoute.outputs.map{$0.portType.rawValue},inputRate:engine?.inputNode.outputFormat(forBus:0).sampleRate ?? 0,outputRate:engine?.outputNode.inputFormat(forBus:0).sampleRate ?? 0,inputChannels:Int(engine?.inputNode.outputFormat(forBus:0).channelCount ?? 0),outputChannels:Int(engine?.outputNode.inputFormat(forBus:0).channelCount ?? 0),raw:stats?.rawBuffers ?? 0,converted:stats?.convertedBuffers ?? 0)
    }
    private func routeFingerprint()->String {
        let input=engine?.inputNode.inputFormat(forBus:0),output=engine?.outputNode.outputFormat(forBus:0)
        return (audio.currentRoute.inputs+audio.currentRoute.outputs).map{$0.uid}.joined(separator:"|")+"/\(input?.sampleRate ?? 0)/\(input?.channelCount ?? 0)/\(output?.sampleRate ?? 0)/\(output?.channelCount ?? 0)"
    }
    private func engineChanged(_ notification:Notification){
        guard let changed=notification.object as? AVAudioEngine,changed===engine else{return}
        let ticket=generation
        // Apple requires releasing/rebuilding the graph outside its notification callback.
        DispatchQueue.main.async{[weak self,weak changed] in
            guard let self,let changed,self.generation==ticket,changed===self.engine else{return}
            self.diagnose("engine-config");self.reconcileRoute()
        }
    }
    private func reconcileRoute(){
        guard active,accepted else{return}
        switch captureLifecycle.routeChange(generation:generation,route:routeFingerprint(),engineRunning:engine?.isRunning == true){
        case .ignore:return
        case .fail:diagnose("recovery-limit");fail("The audio route could not stabilize. Open Audio diagnostics to inspect the attempt. Choose a microphone, then tap Start to retry.",stage:"input")
        case .recover:
            if selectedInput != "system",!currentInputMatchesSelection(){diagnose("input-route-mismatch");engineFailure(AudioInputSelectionError.unavailable);return}
            diagnose("recover-graph");let ticket=generation;phase="Audio device changed · reconnecting once";publish()
            DispatchQueue.main.asyncAfter(deadline:.now()+0.25){[weak self] in
                guard let self,self.generation==ticket,self.active else{return}
                let input=self.request,keepBackground=self.background
                // start already reports current failures. An old completion must never
                // stop a newer manually started conversation.
                self.start(input,background:keepBackground,resumingRoute:true){_ in}
            }
        }
    }
    private func routeChanged(_ notification:Notification){
        guard active,accepted,let raw=notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,let reason=AVAudioSession.RouteChangeReason(rawValue:raw) else{publish();return}
        diagnose("route-\(raw)")
        if reason == .oldDeviceUnavailable {stop("Headphones disconnected. Review the output route before restarting.");return}
        reconcileRoute()
        publish()
    }
}
