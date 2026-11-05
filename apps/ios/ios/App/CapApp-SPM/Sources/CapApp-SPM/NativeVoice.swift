// SPDX-License-Identifier: Apache-2.0
import AVFoundation
import UIKit
import MediaPlayer
import AssistantCore

/// All turn/audio/network lifecycle runs natively; JavaScript is only a foreground view.
final class NativeVoice {
    let transport:NativeTransport
    var emit:([String:Any])->Void = {_ in}
    var diagnostic:((DiagnosticEvent,Int?)->Void)?
    var diagnosticTurn:((DiagnosticEvent,DiagnosticCode?,Int?)->Void)?
    var nextDiagnosticTurn:()->Int? = {nil}
    private var currentDiagnosticTurn:Int?
    var diagnosticsEnabled:()->Bool = {false}
    var expectedAudienceLease:()->String? = {nil}
    private let audio=AVAudioSession.sharedInstance()
    private struct Graph {let engine:AVAudioEngine,player:AVAudioPlayerNode}
    private let graphOwner=CaptureGraphOwner<Graph>()
    private var engine:AVAudioEngine?{graphOwner.current?.engine}
    private var player:AVAudioPlayerNode?{graphOwner.current?.player}
    private var socket:URLSessionWebSocketTask?
    private var diagnostics=CaptureDiagnostics()
    private var playback=PlaybackBuffer()
    private var playbackTimer:Timer?
    private var lastAudioArrival:TimeInterval?,maximumAudioGap:TimeInterval=0
    private var maximumCallbackDispatch:TimeInterval=0,maximumReadDispatch:TimeInterval=0
    private var speechInterruptions=0,queueDrains=0
    private var playbackLevel:Float=0
    private var lastPlaybackDiagnostics=[String]()
    private(set) var selectedInput="system"
    private var observers=[NSObjectProtocol](),remoteTargets=[(MPRemoteCommand,Any)]()
    private var gate=SpeechGate(),reply=ReplyStream(),activity=VoiceActivity(),request=[String:Any]()
    private var generation=0,outputGeneration=0,sequence=0,samples=0,sentMessages=0
    private var queued:Int{playback.queuedSamples}
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
        observe(UIApplication.willEnterForegroundNotification){[weak self] _ in self?.publish()}
        let center=MPRemoteCommandCenter.shared()
        for command in [center.stopCommand,center.pauseCommand,center.togglePlayPauseCommand] { let target=command.addTarget{[weak self] _ in DispatchQueue.main.async{self?.stop("Stopped from lock screen or headset.")};return .success};remoteTargets.append((command,target));command.isEnabled=false }
        center.playCommand.isEnabled=false
    }
    deinit{observers.forEach{NotificationCenter.default.removeObserver($0)};remoteTargets.forEach{$0.0.removeTarget($0.1)}}
    private func observe(_ name:Notification.Name,_ handler:@escaping(Notification)->Void){observers.append(NotificationCenter.default.addObserver(forName:name,object:nil,queue:.main,using:handler))}
    func snapshot()->[String:Any]{
        let stats=capture?.snapshot() ?? lastCaptureStats
        return activity.snapshot.merging(["active":active,"phase":phase,"backgroundEnabled":background,"route":routeSummary(),"selectedInputLabel":inputSelectionSummary(),"captureDiagnostics":diagnostics.lines,"playbackDiagnostics":playbackDiagnostics(),"playing":playback.isPlaying,"amplitude":amplitude,"sampleOffset":played,"trace":reply.trace ?? "","clock":"dataPlayedBack callbacks","queuedSamples":queued,"rawInputBuffers":stats?.rawBuffers ?? 0,"convertedInputBuffers":stats?.convertedBuffers ?? 0,"captureSampleRate":stats?.sampleRate ?? 0,"captureChannels":stats?.channels ?? 0,"captureEngineRunning":engine?.isRunning == true]){_,new in new}
    }
    private func publish(){emit(["type":"state","state":snapshot()])}
    func start(_ input:[String:Any],background:Bool,resumingRoute:Bool=false,done:@escaping(Error?)->Void){
        guard UIApplication.shared.applicationState == .active || (resumingRoute && active && self.background) else{done(VoiceError.staleTurn);return}
        let previousPrivacy=resumingRoute ? privacyKey:nil
        stop("Preparing audio",preservingGraph:resumingRoute)
        if !resumingRoute{diagnostics.clear();lastCaptureStats=nil;lastPlaybackDiagnostics=[];speechInterruptions=0;queueDrains=0;maximumAudioGap=0;maximumCallbackDispatch=0;maximumReadDispatch=0};diagnose(resumingRoute ? "recover-transport":"user-start")
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
                    self.transport.socketOpened={[weak self,weak ws] opened in guard let self,self.generation==ticket,opened===ws,self.socket===ws else{return};self.diagnose("socket-open");self.send(["type":"start","request":self.request])}
                    self.transport.socketClosed={[weak self,weak ws] closed in guard let self,closed===ws,self.socket===ws else{return};self.diagnose(self.accepted ? "socket-close-after-accept":"socket-close-before-accept");self.fail("Speech connection closed. Check the private server and VPN, then start again.",stage:"backend")}
                    ws.resume();self.receive(ws,ticket:ticket)
                    self.deadline=Timer.scheduledTimer(withTimeInterval:10,repeats:false){[weak self] _ in guard let self,self.generation==ticket,!self.accepted else{return};self.fail("The speech connection did not become ready within 10 seconds. Check the private server and VPN.",stage:"backend")}
                    let privacy=Timer(timeInterval:0.5,repeats:true){[weak self] _ in self?.privacyTick()};self.poll=privacy;RunLoop.main.add(privacy,forMode:.common)
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
            // Preference only: route/client/hardware rates are reported separately.
            try audio.setPreferredSampleRate(48000)
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
        // Keep capture/AEC running, but start the player only after prebuffering.
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
        case .began:interruptReply("New speech");currentDiagnosticTurn=nextDiagnosticTurn();diagnosticTurn?(.voiceSpeech,nil,currentDiagnosticTurn);sequence=0;samples=0;phase="Hearing speech · pause to send"
        case .frame(let bytes):send(["type":"frame","audioInputId":request["audioInputId"]!,"frame":["frameId":UUID().uuidString.lowercased(),"sequence":sequence,"format":["encoding":"pcm_s16le","sampleRateHz":16000,"channels":1],"sampleOffset":samples,"sampleCount":bytes.count/2,"dataBase64":bytes.base64EncodedString()]]);sequence += 1;samples += bytes.count/2;activity.sentFrame()
        case .commit(let next,let count):send(["type":"commitTurn","audioInputId":request["audioInputId"]!,"nextSequence":next,"sampleCount":count]);turnPending=true;diagnosticTurn?(.voiceCommitted,nil,currentDiagnosticTurn);activity.committed();phase="Transcribing your speech";armResponseDeadline()
        }}
    }
    private func send(_ message:[String:Any]){
        guard let socket,let data=try? JSONSerialization.data(withJSONObject:message),let text=String(data:data,encoding:.utf8),sentMessages<128 else{if active{fail("Speech transport queue exceeded its bound. Start listening again.",stage:"backend")};return}
        sentMessages += 1;let ticket=generation
        socket.send(.string(text)){[weak self] error in DispatchQueue.main.async{guard let self,self.generation==ticket else{return};self.sentMessages -= 1;if error != nil{self.fail("Speech connection lost. Check the private server and VPN.",stage:"backend")}}}
    }
    private func receive(_ ws:URLSessionWebSocketTask,ticket:Int){ws.receive{[weak self,weak ws] result in
        let deliveredAt=ProcessInfo.processInfo.systemUptime
        DispatchQueue.main.async{
        guard let self,let ws,self.generation==ticket,self.socket===ws else{return}
        self.maximumReadDispatch=max(self.maximumReadDispatch,ProcessInfo.processInfo.systemUptime-deliveredAt)
        do{let data:Data;switch try result.get(){case .string(let s):data=Data(s.utf8);case .data(let d):data=d;@unknown default:throw VoiceError.invalidMessage}
            guard let m=try JSONSerialization.jsonObject(with:data) as? [String:Any] else{throw VoiceError.invalidMessage}
            try self.message(m);if self.active{if self.queued >= 96000{self.lastAudioArrival=nil;self.resumeRead={[weak self,weak ws] in guard let self,let ws,self.generation==ticket else{return};self.receive(ws,ticket:ticket)}}else{self.receive(ws,ticket:ticket)}}
        }catch{self.diagnose(self.accepted ? "receive-error-after-accept":"receive-error-before-accept");self.fail("Speech processing stopped: the connection or audio response was invalid. Reconnect to retry.",stage:"backend")}
    }}}
    private func message(_ m:[String:Any]) throws {
        guard let type=m["type"] as? String else{throw VoiceError.invalidMessage}
        if type=="accepted"{guard !accepted,m["audioInputId"] as? String == request["audioInputId"] as? String else{throw VoiceError.invalidMessage};accepted=true;diagnose("socket-accepted");deadline?.invalidate();let ticket=generation;do{try prepareEngine()}catch{if generation==ticket,active,accepted{engineFailure(error)}};return}
        if type=="error"{diagnostic?(.socketFailed,nil);let problem=m["problem"] as? [String:Any],message=problem?["message"] as? String;fail("Server: "+(message.map{String($0.filter{!$0.isNewline && !$0.unicodeScalars.contains(where:{$0.value<32})}.prefix(350))} ?? "Speech processing was rejected."),stage:"backend");return}
        let event=m["event"] as? [String:Any],trace=(m["interactionTraceId"] as? String) ?? (event?["interactionTraceId"] as? String)
        guard let trace else{return};if reply.retired.contains(trace){return}
        if type=="turnStarted"{diagnosticTurn?(.voiceTurnStarted,nil,currentDiagnosticTurn);try reply.begin(trace);outputGeneration += 1;playback.begin(generation:outputGeneration);lastAudioArrival=nil;played=0;armResponseDeadline();activity.committed();phase="Transcribing your speech";publish();return}
        guard trace==reply.trace else{throw VoiceError.staleTurn}
        if type=="stopPlayback"{interruptReply("Stopped by runtime");return}
        if type=="transcript"{if let text=m["text"] as? String,text.count<=16000{let event=VoiceDiagnostic.transcript(text);diagnosticTurn?(event,nil,currentDiagnosticTurn);if event == .voiceTranscribed{activity.transcribed();phase="Assistant is processing";publish();emit(["type":"transcript","role":"user","text":text,"trace":trace])}};return}
        if type=="response",let payload=event?["payload"] as? [String:Any]{
            if payload["type"] as? String == "textDelta",let text=payload["text"] as? String,text.count<=16000{activity.receivedText();emit(["type":"textDelta","text":text,"trace":trace])}
            if payload["type"] as? String == "terminal"{let problem=payload["error"] as? [String:Any];if let failure=VoiceDiagnostic.terminal(state:payload["state"] as? String,code:problem?["code"] as? String){diagnosticTurn?(failure.0,failure.1,currentDiagnosticTurn);fail("The backend could not complete the response. Please retry.",stage:"backend");return};try reply.finish(trace);diagnosticTurn?(.voiceGenerationDone,nil,currentDiagnosticTurn);activity.generationFinished();applyPlayback(playback.finish(generation:outputGeneration,at:ProcessInfo.processInfo.systemUptime));completeIfReady()}
        }
        if type=="audio"{
            guard let chunk=m["chunk"] as? [String:Any],let segment=chunk["segmentId"] as? String,let frame=chunk["frame"] as? [String:Any],let format=frame["format"] as? [String:Any],format["encoding"] as? String == "pcm_s16le",format["sampleRateHz"] as? Int == 48000,format["channels"] as? Int == 1,let n=frame["sampleCount"] as? Int,let seq=frame["sequence"] as? Int,let offset=frame["sampleOffset"] as? Int,let encoded=frame["dataBase64"] as? String,let bytes=Data(base64Encoded:encoded) else{throw VoiceError.invalidFrame}
            try reply.accept(trace:trace,segment:segment,sequence:seq,offset:offset,count:n,bytes:bytes,queuedSamples:queued)
            guard let player,let buffer=AVAudioPCMBuffer(pcmFormat:AVAudioFormat(standardFormatWithSampleRate:48000,channels:1)!,frameCapacity:AVAudioFrameCount(n)) else{throw VoiceError.invalidFrame}
            buffer.frameLength=AVAudioFrameCount(n);var energy:Float=0
            for (i,value) in try PlaybackPCM.decode(bytes,samples:n).enumerated(){buffer.floatChannelData![0][i]=value;energy += value*value}
            let now=ProcessInfo.processInfo.systemUptime
            // Delivery gaps include provider, network and client scheduling;
            // intentionally paused reads are excluded by clearing the baseline.
            if let previous=lastAudioArrival{let gap=now-previous;maximumAudioGap=max(maximumAudioGap,gap);if gap>=0.25{diagnose("delivery-gap-\(Int(min(999999,gap*1000)))ms")}};lastAudioArrival=now
            let completion=try playback.enqueue(samples:n,generation:outputGeneration,at:now)
            let ticket=outputGeneration,level=sqrt(energy/Float(n));playbackLevel=level
            player.scheduleBuffer(buffer,completionCallbackType:.dataPlayedBack){[weak self] _ in
                let callbackAt=ProcessInfo.processInfo.systemUptime
                DispatchQueue.main.async{
                guard let self,self.outputGeneration==ticket,self.active,self.accepted,self.engine?.isRunning==true else{return}
                self.maximumCallbackDispatch=max(self.maximumCallbackDispatch,ProcessInfo.processInfo.systemUptime-callbackAt)
                let before=self.queued,action=self.playback.completed(completion)
                self.played += before-self.queued;self.amplitude=self.playback.isPlaying ? level:0
                self.applyPlayback(action);self.completeIfReady()
                if self.queued<96000,let resume=self.resumeRead{self.resumeRead=nil;self.lastAudioArrival=ProcessInfo.processInfo.systemUptime;resume()}
            }}
            applyPlayback(playback.playbackAction(generation:outputGeneration,at:now));armPlaybackDeadline();publish()
        }
    }
    private func completeIfReady(){if reply.terminal && queued==0{send(["type":"playbackSettled","interactionTraceId":reply.trace!,"outcome":"completed","receivedSamples":reply.totalSamples]);reply.retire();turnPending=false;diagnosticTurn?(.voiceTurnCompleted,nil,currentDiagnosticTurn);currentDiagnosticTurn=nil;activity.completed();phase="Listening · speak, then pause to send";deadline?.invalidate();publish()}}
    private func applyPlayback(_ action:PlaybackBuffer.Action){
        switch action {
        case .none:
            if queued>0,!playback.isPlaying{activity.playbackDrained();phase="Preparing speech"}
        case .start:
            playbackTimer?.invalidate();playbackTimer=nil
            guard active,accepted,engine?.isRunning==true else{return}
            player?.play();amplitude=playbackLevel;activity.playing();phase="Speaking"
            diagnose("start-\(playback.lastStartReason?.rawValue ?? "unknown")-\(playback.lastStartQueuedSamples/48)ms")
        case .pause:
            player?.pause();queueDrains += 1;amplitude=0;activity.playbackDrained();phase="Waiting for more speech";diagnose("queue-drained")
        case .finished:
            player?.pause();playbackTimer?.invalidate();playbackTimer=nil;amplitude=0;activity.playbackDrained();diagnose("playback-finished")
        }
    }
    private func armPlaybackDeadline(){
        guard playbackTimer==nil,let until=playback.startupDeadline else{return}
        let ticket=outputGeneration
        let timer=Timer(timeInterval:max(0.001,until-ProcessInfo.processInfo.systemUptime),repeats:false){[weak self] _ in
            guard let self,self.outputGeneration==ticket,self.active,self.accepted,self.engine?.isRunning==true else{return}
            self.playbackTimer=nil
            self.applyPlayback(self.playback.playbackAction(generation:ticket,at:ProcessInfo.processInfo.systemUptime))
            self.armPlaybackDeadline();self.publish()
        }
        playbackTimer=timer;RunLoop.main.add(timer,forMode:.common)
    }
    private func interruptReply(_ reason:String){
        if reply.trace != nil{if reason=="New speech"{speechInterruptions += 1;diagnose("speech-interrupt")}else{diagnose("reply-cancel")}}
        outputGeneration += 1;playback.stop(generation:outputGeneration);playbackTimer?.invalidate();playbackTimer=nil
        player?.stop();amplitude=0;played=0;activity.completed()
        if let trace=reply.trace{send(["type":"interrupt","interactionTraceId":trace,"reason":reason]);send(["type":"playbackSettled","interactionTraceId":trace,"outcome":"stopped","receivedSamples":reply.totalSamples]);reply.retire()};turnPending=false;deadline?.invalidate();if let resume=resumeRead{resumeRead=nil;resume()}
    }
    func stop(_ reason:String="Stopped",preservingGraph:Bool=false){
        if active || engine != nil{diagnose(preservingGraph ? "pause-graph":"stop")}
        if engine != nil{lastPlaybackDiagnostics=playbackDiagnostics()}
        interruptReply(reason)
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
            guard let expected=self.expectedAudienceLease(),value["leaseId"] as? String==expected else{done(false);return}
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
        if let diagnostic,diagnosticsEnabled() {
            switch event {
            case "socket-open":diagnostic(.socketOpen,nil)
            case "socket-accepted":diagnostic(.socketAccepted,nil)
            case "socket-close-before-accept","socket-close-after-accept":diagnostic(.socketClosed,nil)
            case "first-converted":diagnostic(.captureReady,nil)
            case "recover-graph","recover-transport":diagnostic(.captureRecovery,nil)
            case "queue-drained":diagnostic(.playbackDrained,nil)
            case "playback-finished":diagnostic(.playbackFinished,nil)
            case "speech-interrupt":diagnostic(.voiceInterrupted,nil)
            case "reply-cancel":diagnostic(.playbackCancelled,nil)
            case "session-active":
                let rate=audio.sampleRate;diagnostic(.sampleRate,rate.isFinite && rate>=0 && rate<=384000 ? Int(rate):nil)
                let ports=audio.currentRoute.outputs.map(\.portType)
                if ports.contains(.bluetoothHFP)||ports.contains(.bluetoothA2DP)||ports.contains(.bluetoothLE){diagnostic(.routeBluetooth,nil)}
                else if ports.contains(.builtInSpeaker)||ports.contains(.builtInReceiver){diagnostic(.routeSpeaker,nil)}
                else if ports.contains(.headphones)||ports.contains(.usbAudio){diagnostic(.routeWired,nil)}else{diagnostic(.routeOther,nil)}
            default:if event.hasPrefix("delivery-gap-"),event.hasSuffix("ms"),let value=Int(event.dropFirst("delivery-gap-".count).dropLast(2)){diagnostic(.deliveryGap,value)}else if event.hasPrefix("receive-error-"){diagnostic(.socketFailed,nil)}else if event.hasPrefix("route-"){diagnostic(.routeChanged,nil)}else if event.hasPrefix("start-")||event=="playback-start"{diagnostic(.playbackStart,nil)}
            }
        }
        let stats=capture?.snapshot() ?? lastCaptureStats
        diagnostics.record(event,generation:generation,at:ProcessInfo.processInfo.systemUptime,engineRunning:engine?.isRunning == true,inputPorts:audio.currentRoute.inputs.map{$0.portType.rawValue},outputPorts:audio.currentRoute.outputs.map{$0.portType.rawValue},inputRate:engine?.inputNode.outputFormat(forBus:0).sampleRate ?? 0,outputRate:engine?.outputNode.inputFormat(forBus:0).sampleRate ?? 0,inputChannels:Int(engine?.inputNode.outputFormat(forBus:0).channelCount ?? 0),outputChannels:Int(engine?.outputNode.inputFormat(forBus:0).channelCount ?? 0),raw:stats?.rawBuffers ?? 0,converted:stats?.convertedBuffers ?? 0)
    }
    private func playbackDiagnostics()->[String]{
        if engine == nil,!lastPlaybackDiagnostics.isEmpty{return ["Last active graph (stopped): "+lastPlaybackDiagnostics[0]]+lastPlaybackDiagnostics.dropFirst()}
        func rate(_ value:Double)->Int{value.isFinite && value>=0 && value<=384000 ? Int(value):0}
        func ms(_ value:Double)->Int{value.isFinite && value>=0 ? Int(min(value*1000,999999)):0}
        let input=engine?.inputNode,output=engine?.outputNode
        let category=audio.category == .playAndRecord ? "playAndRecord":audio.category == .playback ? "playback":"other"
        let mode=audio.mode == .voiceChat ? "voiceChat":audio.mode == .default ? "default":"other"
        return [
            "Session: \(category)/\(mode) negotiated=\(rate(audio.sampleRate))Hz preferred=\(rate(audio.preferredSampleRate))Hz IO=\(ms(audio.ioBufferDuration))ms",
            "Hardware: in=\(rate(input?.inputFormat(forBus:0).sampleRate ?? 0))Hz out=\(rate(output?.outputFormat(forBus:0).sampleRate ?? 0))Hz latency in=\(ms(audio.inputLatency))ms out=\(ms(audio.outputLatency))ms",
            "PCM: 48000Hz mono PCM16 -> Float32; client in=\(rate(input?.outputFormat(forBus:0).sampleRate ?? 0))Hz out=\(rate(output?.inputFormat(forBus:0).sampleRate ?? 0))Hz VP=\(input?.isVoiceProcessingEnabled == true ? "on":"off") bypass=\(input?.isVoiceProcessingBypassed == true ? "on":"off")",
            "Playback: queued=\(queued) samples (~\(queued/48)ms, callback based) playing=\(playback.isPlaying) drains=\(queueDrains) speechInterrupts=\(speechInterruptions) maxArrivalGap=\(ms(maximumAudioGap))ms",
            "Buffer: startup=400ms recovery=600ms maxWait=1000ms; lastStart=\(playback.lastStartReason?.rawValue ?? "none")/\(playback.lastStartQueuedSamples/48)ms. Dispatch max callback=\(ms(maximumCallbackDispatch))ms read=\(ms(maximumReadDispatch))ms. Drains are not hardware underruns."
        ]
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
            // Engine configuration changes can stop rendering before recovery's
            // delayed restart. Fence the old output now, not after that delay.
            interruptReply("Audio route changed")
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
