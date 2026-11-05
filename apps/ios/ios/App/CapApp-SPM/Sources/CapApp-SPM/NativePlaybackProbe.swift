// SPDX-License-Identifier: Apache-2.0
import AVFoundation
import UIKit

/// Foreground, offline A/B playback. The conversation graph opens the microphone
/// for voice processing, but never taps, reads, records or transmits its samples.
final class NativePlaybackProbe {
    enum Mode:String {case media,conversation}
    var emit:([String:Any])->Void = {_ in}
    private let audio=AVAudioSession.sharedInstance()
    private var engine:AVAudioEngine?,player:AVAudioPlayerNode?,buffer:AVAudioPCMBuffer?
    private var observers=[NSObjectProtocol](),deadline:Timer?
    private var generation=0,ownsSession=false,route="",mode:Mode = .media
    private var pending:((String?)->Void)?
    private var detail=""
    init(){
        observe(AVAudioSession.interruptionNotification){[weak self] n in
            guard let raw=n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,raw==AVAudioSession.InterruptionType.began.rawValue else{return}
            self?.stop("Local test interrupted. Tap a test to try again.")
        }
        observe(AVAudioSession.routeChangeNotification){[weak self] n in
            guard let self,self.engine != nil else{return}
            let raw=n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            if raw==AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue || self.route != self.routeIdentity(){self.stop("Audio route changed. Review the destination, then tap a test again.")}
        }
        observe(AVAudioSession.mediaServicesWereResetNotification){[weak self] _ in self?.stop("Audio services reset. Tap a test to try again.")}
        for name in [UIApplication.willResignActiveNotification,UIApplication.didEnterBackgroundNotification,UIApplication.willTerminateNotification]{observe(name){[weak self] _ in self?.stop("Local test stopped because the app is inactive.")}}
    }
    deinit{observers.forEach{NotificationCenter.default.removeObserver($0)};deadline?.invalidate()}
    private func observe(_ name:Notification.Name,_ action:@escaping(Notification)->Void){observers.append(NotificationCenter.default.addObserver(forName:name,object:nil,queue:.main,using:action))}
    func diagnosticsText()->String{String(detail.prefix(2000))}
    private func publish(_ status:String,active:Bool){emit(["type":"audioProbe","active":active,"mode":mode.rawValue,"status":status,"diagnostics":detail])}
    func start(_ mode:Mode,done:@escaping(String?)->Void){
        stop("Local test replaced.")
        guard UIApplication.shared.applicationState == .active else{done("Open the app before starting a local audio test.");return}
        self.mode=mode;detail="";pending=done;let ticket=generation
        publish(mode == .conversation ? "Preparing local conversation test. Microphone opens for echo processing only; no samples are read or saved.":"Preparing local media test. Microphone is off.",active:true)
        let begin={ [weak self] in
            guard let self,self.generation==ticket,UIApplication.shared.applicationState == .active else{return}
            do{try self.play(ticket:ticket);let callback=self.pending;self.pending=nil;callback?(nil)}
            catch{self.stop("Local test could not start. Check microphone permission and the audio route; the build must include its generated test clip.")}
        }
        if mode == .conversation {
            audio.requestRecordPermission{[weak self] granted in DispatchQueue.main.async{
                guard let self,self.generation==ticket else{return}
                guard granted else{self.stop("Microphone permission is off. Enable it in iOS Settings, then tap the conversation test again.");return}
                guard UIApplication.shared.applicationState == .active else{self.stop("Open the app, then tap the conversation test again.");return}
                begin()
            }}
        }else{begin()}
    }
    private func play(ticket:Int) throws {
        guard let url=Bundle.main.url(forResource:"audio-probe",withExtension:"wav",subdirectory:"public"),
              let size=try url.resourceValues(forKeys:[.fileSizeKey]).fileSize,size>0,size<=2*1024*1024 else{throw ProbeError.invalidClip}
        let file=try AVAudioFile(forReading:url)
        guard file.fileFormat.sampleRate==48000,file.fileFormat.channelCount==1,
              file.fileFormat.streamDescription.pointee.mBitsPerChannel==16,
              file.fileFormat.streamDescription.pointee.mFormatID==kAudioFormatLinearPCM,
              file.length>0,file.length<=48000*15,
              let buffer=AVAudioPCMBuffer(pcmFormat:file.processingFormat,frameCapacity:AVAudioFrameCount(file.length)) else{throw ProbeError.invalidClip}
        try file.read(into:buffer)
        guard buffer.frameLength==AVAudioFrameCount(file.length) else{throw ProbeError.invalidClip}
        if mode == .media {try audio.setCategory(.playback,mode:.default,options:[])}
        else {
            var options:AVAudioSession.CategoryOptions=[.defaultToSpeaker]
            if #available(iOS 26.0,*){options.insert(.allowBluetoothHFP)}else{options.insert(.allowBluetooth)}
            try audio.setCategory(.playAndRecord,mode:.voiceChat,options:options)
        }
        ownsSession=true
        try audio.setPreferredSampleRate(48000);try audio.setPreferredIOBufferDuration(0.02);try audio.setActive(true)
        // This independent test follows the system route, not a saved conversation
        // input preference; its UI makes that distinction explicit.
        if mode == .conversation{try audio.setPreferredInput(nil)}
        let engine=AVAudioEngine(),player=AVAudioPlayerNode();self.engine=engine;self.player=player;self.buffer=buffer
        if mode == .conversation{try engine.inputNode.setVoiceProcessingEnabled(true)}
        engine.attach(player)
        engine.connect(player,to:engine.mainMixerNode,format:buffer.format)
        if mode == .conversation{engine.connect(engine.mainMixerNode,to:engine.outputNode,format:engine.inputNode.outputFormat(forBus:0))}
        engine.prepare();try engine.start();route=routeIdentity()
        let input=mode == .conversation ? engine.inputNode.outputFormat(forBus:0):nil
        let outputClient=engine.outputNode.inputFormat(forBus:0),outputHardware=engine.outputNode.outputFormat(forBus:0)
        func format(_ value:AVAudioFormat?)->String{guard let value else{return "off"};return "\(Int(value.sampleRate))Hz/\(value.channelCount)ch"}
        let inputPorts=mode == .conversation ? audio.currentRoute.inputs.map{$0.portType.rawValue}.joined(separator:","):"off"
        let outputPorts=audio.currentRoute.outputs.map{$0.portType.rawValue}.joined(separator:",")
        detail="mode=\(mode == .media ? "playback/default":"playAndRecord/voiceChat") · VPIO=\(mode == .conversation && engine.inputNode.isVoiceProcessingEnabled) · session=\(Int(audio.sampleRate))Hz · input=\(inputPorts) · output=\(outputPorts)\nclip=48000Hz/1ch/PCM16 · preloaded=\(buffer.frameLength) samples · inputClient=\(format(input)) · outputClient=\(format(outputClient)) · outputHardware=\(format(outputHardware))"
        player.scheduleBuffer(buffer,completionCallbackType:.dataPlayedBack){[weak self] _ in DispatchQueue.main.async{
            guard let self,self.generation==ticket else{return};self.stop("Local test finished. Microphone and playback are off.")
        }}
        deadline=Timer.scheduledTimer(withTimeInterval:16,repeats:false){[weak self] _ in guard let self,self.generation==ticket else{return};self.stop("Local test timed out. Microphone and playback are off.")}
        player.play()
        publish(mode == .media ? "Playing the preloaded local clip. Microphone is off.":"Playing the same preloaded clip with microphone and echo processing on. No microphone samples are read, saved or sent.",active:true)
    }
    func stop(_ reason:String="Local test stopped. Microphone and playback are off."){
        let wasActive=engine != nil || pending != nil || ownsSession
        generation += 1;deadline?.invalidate();deadline=nil;player?.stop();engine?.stop();player=nil;engine=nil;buffer=nil;route=""
        if ownsSession{try? audio.setActive(false,options:.notifyOthersOnDeactivation)};ownsSession=false
        let callback=pending;pending=nil;callback?(reason)
        if wasActive{publish(reason,active:false)}
    }
    private func routeIdentity()->String{(audio.currentRoute.inputs+audio.currentRoute.outputs).map{$0.uid}.joined(separator:"|")+"/\(audio.sampleRate)"}
    private enum ProbeError:Error{case invalidClip}
}
