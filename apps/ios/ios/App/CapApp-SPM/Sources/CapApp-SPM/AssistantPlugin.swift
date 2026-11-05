// SPDX-License-Identifier: Apache-2.0
import Capacitor
import UIKit
import AVFoundation
import AssistantCore

@objc(AssistantPlugin)
public final class AssistantPlugin: CAPPlugin,CAPBridgedPlugin {
    public let identifier="AssistantPlugin",jsName="Assistant"
    public let pluginMethods=["configure","restoreConnection","forgetSession","saveSettings","request","beginAudience","endAudience","setBackgroundPolicy","sendText","cancelText","start","stop","snapshot","routePicker","startAudioProbe","stopAudioProbe","copyAudioDiagnostics","diagnosticsStatus","setDiagnosticsEnabled","logDiagnostic","clearDiagnostics","shareDiagnostics","startVoicePreview","stopVoicePreview","voicePreviewStatus"].compactMap{CAPPluginMethod(name:$0,returnType:CAPPluginReturnPromise)}
    private let transport=NativeTransport()
    private lazy var voicePreview=NativeVoicePreview(transport:transport)
    private let diagnosticLog=NativeDiagnostics()
    private var diagnosticSequence=0
    private lazy var text:NativeText={let value=NativeText(transport:transport);value.diagnostic={[weak self] name,status,turn in if let event=DiagnosticEvent(rawValue:name){self?.diagnosticLog.record(event,status:status,turn:turn)}};return value}()
    private lazy var audioProbe:NativePlaybackProbe={let value=NativePlaybackProbe();value.emit={[weak self] message in guard UIApplication.shared.applicationState == .active else{return};self?.notifyListeners("event",data:message)};return value}()
    private var lifecycleObservers=[NSObjectProtocol](),continueWhenLocked=false
    private lazy var audience:NativeAudience={let value=NativeAudience(transport:transport);value.onEnded={[weak self] reason in
        guard let self else{return};self.diagnosticLog.record(.audienceEnded);self.voicePreview.stop();self.audioProbe.stop();self.text.stop();self.voice.stop(reason)
        self.notifyListeners("event",data:["type":"audience","active":false,"reason":reason])
    };return value}()
    public override func load(){
        _=audience;diagnosticLog.record(.appStarted)
        func observe(_ name:Notification.Name,_ action:@escaping()->Void){lifecycleObservers.append(NotificationCenter.default.addObserver(forName:name,object:nil,queue:.main){_ in action()})}
        observe(UIApplication.willResignActiveNotification){[weak self] in self?.voicePreview.stop();self?.audience.resignActive()}
        observe(UIApplication.protectedDataWillBecomeUnavailableNotification){[weak self] in self?.audience.protectedDataUnavailable()}
        observe(UIApplication.protectedDataDidBecomeAvailableNotification){[weak self] in self?.audience.protectedDataAvailable()}
        observe(UIApplication.didBecomeActiveNotification){[weak self] in self?.diagnosticLog.record(.appForeground);self?.audience.becomeActive()}
        observe(UIApplication.didEnterBackgroundNotification){[weak self] in guard let self else{return};self.diagnosticLog.record(.appBackground);self.voicePreview.stop();self.text.stop();self.audience.enterBackground(continueWhenLocked:self.continueWhenLocked,protectedDataAvailable:UIApplication.shared.isProtectedDataAvailable)}
        observe(AVAudioSession.interruptionNotification){[weak self] in self?.voicePreview.stop()}
        lifecycleObservers.append(NotificationCenter.default.addObserver(forName:AVAudioSession.routeChangeNotification,object:nil,queue:.main){[weak self] note in
            guard let raw=note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,let reason=AVAudioSession.RouteChangeReason(rawValue:raw),reason != .categoryChange else{return};self?.voicePreview.stop()
        })
        observe(UIApplication.willTerminateNotification){[weak self] in self?.audience.end("App closed.")}
    }
    deinit{lifecycleObservers.forEach{NotificationCenter.default.removeObserver($0)}}
    private lazy var voice:NativeVoice={let value=NativeVoice(transport:transport);value.diagnosticsEnabled={[weak self] in self?.diagnosticLog.enabled ?? false};value.diagnostic={[weak self] event,number in self?.diagnosticLog.record(event,value:number)};value.nextDiagnosticTurn={[weak self] in self?.diagnosticLog.nextTurn()};value.diagnosticTurn={[weak self] event,code,turn in self?.diagnosticLog.record(event,code:code,turn:turn)};value.expectedAudienceLease={[weak self] in self?.audience.leaseId};value.emit={[weak self] message in guard UIApplication.shared.applicationState == .active else{return};self?.notifyListeners("event",data:message)};return value}()
    private func perform(_ call:CAPPluginCall,_ work:@escaping()->Void){DispatchQueue.main.async{[weak self] in guard let self,let url=self.bridge?.webView?.url,url.scheme=="capacitor",url.host=="localhost" else{call.reject("Only the bundled app may use native audio.");return};work()}}
    @objc public func configure(_ call:CAPPluginCall){perform(call){[self] in
        guard let endpoint=call.getString("endpoint") else{call.reject("Enter an HTTPS server address.");return}
        voicePreview.stop();audioProbe.stop();audience.end("Server changed",notify:false);text.stop();voice.stop("Server changed")
        do{try transport.configure(endpoint,username:call.getString("username") ?? "");call.resolve(["configured":true])}catch{call.reject("Use an HTTPS server origin without a path, credentials or query.")}
    }}
    @objc public func restoreConnection(_ call:CAPPluginCall){perform(call){[self] in
        diagnosticLog.record(.connectionRestoreStart);voicePreview.stop();audioProbe.stop();audience.end("Restoring connection",notify:false);text.stop();voice.stop("Restoring connection")
        transport.restoreSession{result in
            switch result{case .success(let restored):self.diagnosticLog.record(.connectionRestoreDone);call.resolve(restored.payload);case .failure:self.diagnosticLog.record(.connectionRestoreFailed);call.reject("Saved connection is unavailable. Unlock this device and try again.")}
        }
    }}
    @objc public func forgetSession(_ call:CAPPluginCall){perform(call){[self] in
        voicePreview.stop();audioProbe.stop();audience.end("Signed out",notify:false);text.stop();voice.stop("Signed out")
        do{try transport.forgetSession();call.resolve()}catch{call.reject("Could not clear the saved session. Unlock the device and try signing out again.")}
    }}
    @objc public func saveSettings(_ call:CAPPluginCall){perform(call){[self] in
        audioProbe.stop();do{try transport.saveSettings(call.getString("settings") ?? "{}");call.resolve()}catch{call.reject("Could not save settings on this device.")}
    }}
    @objc public func request(_ call:CAPPluginCall){perform(call){[self] in
        guard let path=call.getString("path") else{call.reject("Missing request path.");return}
        let method=call.getString("method") ?? "GET"
        if method=="POST",path.contains("/voices"),voicePreview.busy{call.reject("Wait for voice preview playback to finish or stop.");return}
        let kind:DiagnosticEvent = path.hasPrefix("/api/auth/") ? .httpAuth : path.hasPrefix("/api/runtime/v1/audience") ? .httpAudience : path=="/api/runtime/v1/session-context" ? .httpSession : path.hasPrefix("/api/runtime/v1/conversations") ? .httpHistory : .httpOther
        let logging=diagnosticLog.enabled,repetitive=method=="GET" && path=="/api/runtime/v1/audience",started=logging ? ProcessInfo.processInfo.systemUptime:0
        if logging && !repetitive{diagnosticSequence=diagnosticSequence%384_000+1;diagnosticLog.record(kind,value:diagnosticSequence)}
        let correlation=diagnosticSequence
        if method != "GET",!path.hasSuffix("/messages"){audioProbe.stop();if !EndpointPolicy.preservesAudience(path,method:method){audience.end("Session settings changed",notify:false)};text.stop();voice.stop("Session settings changed")}
        transport.request(path,method:method,body:call.getString("body")){[weak self] result in
            switch result{case .failure:if logging{self?.diagnosticLog.record(kind,durationMs:Int(min(3_600_000,max(0,(ProcessInfo.processInfo.systemUptime-started)*1000))),value:correlation,code:.networkUnavailable)};call.reject("The server could not be reached securely.")
            case .success(let (data,response)):
                if logging && (!repetitive || response.statusCode>=400){
                    var code:DiagnosticCode?;if response.statusCode>=400,data.count<=4096,let object=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any]{let raw=(object["code"] as? String) ?? ((object["error"] as? [String:Any])?["code"] as? String);if let raw{code=DiagnosticCode(rawValue:raw) ?? .unknown}}
                    self?.diagnosticLog.record(kind,status:response.statusCode,durationMs:Int(min(3_600_000,max(0,(ProcessInfo.processInfo.systemUptime-started)*1000))),value:correlation,code:code)
                }
                if response.statusCode==401 || response.statusCode==403 {self?.audience.end("Sign-in or audience permission changed.")}
                let binary=path.hasPrefix("/api/runtime/v1/presentation/resources/")
                call.resolve(["status":response.statusCode,"body":binary ? data.base64EncodedString():String(data:data,encoding:.utf8) ?? "","encoding":binary ? "base64":"utf8"])
            }
        }
    }}
    @objc public func beginAudience(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active else{call.reject("Open the app before activating its audience session.");return}
        diagnosticLog.record(.audienceBegin);audience.becomeActive()
        audience.begin{result in switch result{case .success(let value):self.diagnosticLog.record(.audienceReady);call.resolve(value);case .failure(let error):self.diagnosticLog.record(.audienceFailed);call.reject(error.localizedDescription)}}
    }}
    @objc public func endAudience(_ call:CAPPluginCall){perform(call){[self] in voicePreview.stop();audience.end("Audience session ended.",expectedLeaseId:call.getString("leaseId"));call.resolve()}}
    @objc public func setBackgroundPolicy(_ call:CAPPluginCall){perform(call){[self] in audioProbe.stop();continueWhenLocked=call.getBool("enabled") ?? false;call.resolve()}}
    @objc public func sendText(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active,audience.leaseId != nil,
              let assistant=call.getString("assistantId"),let prompt=call.getString("userInput"),let trace=call.getString("trace") else{call.reject("Open the app and enter a message for the selected Assistant.");return}
        let turn=diagnosticLog.nextTurn();diagnosticLog.record(.textStart,turn:turn);audioProbe.stop();voice.stop("Sending text; microphone is off.")
        text.send(["assistantId":assistant,"userInput":prompt,"trace":trace],diagnosticTurn:turn){result in
            guard UIApplication.shared.applicationState == .active else{call.reject("Text response stopped because the display is locked.");return}
            switch result{
            case .success(let reply):self.diagnosticLog.record(.textDone,turn:turn);call.resolve(reply)
            case .failure(let error):
                self.diagnosticLog.record(.textFailed,turn:turn)
                if let textError=error as? NativeTextError,case .contextChanged(let preparation)=textError {self.diagnosticLog.record(.textContextChanged,code:preparation ? .contextPreparation:.contextValidation,turn:turn);call.reject(error.localizedDescription,"runtime_context_changed")}
                else{call.reject(error.localizedDescription)}
            }
        }
    }}
    @objc public func cancelText(_ call:CAPPluginCall){perform(call){[self] in diagnosticLog.record(.textCancelled);text.stop();call.resolve()}}
    @objc public func start(_ call:CAPPluginCall){perform(call){[self] in
        guard !voicePreview.busy else{call.reject("Wait for voice preview playback to finish or stop.");return}
        guard audience.leaseId != nil,let request=call.getObject("request") else{call.reject("Select a current session first.");return}
        diagnosticLog.record(.voiceStart);audioProbe.stop();continueWhenLocked=call.getBool("background") ?? false;text.stop();voice.start(request,background:continueWhenLocked){error in if error != nil{self.diagnosticLog.record(.voiceFailed);let detail=self.voice.snapshot()["lastError"] as? String;call.reject(detail?.isEmpty==false ? detail!:"Audio could not start. Check microphone permission, sign-in and audience.")}else{self.diagnosticLog.record(.voiceReady);call.resolve(self.voice.snapshot())}}
    }}
    @objc public func stop(_ call:CAPPluginCall){perform(call){[self] in diagnosticLog.record(.voiceStop);audioProbe.stop();audience.cancelActivation();text.stop();voice.stop();call.resolve(voice.snapshot())}}
    @objc public func startVoicePreview(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active,audience.leaseId != nil,let request=call.getObject("request") else{call.reject("Open the app and establish a private session before previewing.");return}
        audioProbe.stop();text.stop();voice.stop("Preparing voice preview.")
        voicePreview.start(request){result in switch result{case .success(let value):call.resolve(value);case .failure:call.reject("The voice preview did not complete. Wait for output ownership to clear before trying again.")}}
    }}
    @objc public func voicePreviewStatus(_ call:CAPPluginCall){perform(call){[self] in call.resolve(voicePreview.status)}}
    @objc public func stopVoicePreview(_ call:CAPPluginCall){perform(call){[self] in voicePreview.stop();call.resolve()}}
    @objc public func startAudioProbe(_ call:CAPPluginCall){perform(call){[self] in
        guard !voicePreview.busy else{call.reject("Wait for voice preview playback to finish or stop.");return}
        guard UIApplication.shared.applicationState == .active,let raw=call.getString("mode"),let mode=NativePlaybackProbe.Mode(rawValue:raw) else{call.reject("Open the app and select a local audio test.");return}
        audience.cancelActivation();text.stop();voice.stop("Conversation stopped for the local audio test. Tap Start listening afterward to resume.")
        audioProbe.start(mode){error in if let error{call.reject(error)}else{call.resolve(["active":true])}}
    }}
    @objc public func stopAudioProbe(_ call:CAPPluginCall){perform(call){[self] in audioProbe.stop();call.resolve()}}
    @objc public func copyAudioDiagnostics(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active else{call.reject("Open the app before copying audio diagnostics.");return}
        // Copy only native diagnostic metadata. Never serialize the full snapshot:
        // it also contains route names, conversation identifiers and UI state.
        let snapshot=voice.snapshot()
        func lines(_ key:String)->String{(snapshot[key] as? [String] ?? []).suffix(24).map{String($0.prefix(512))}.joined(separator:"\n")}
        let playback=lines("playbackDiagnostics"),capture=lines("captureDiagnostics"),probe=audioProbe.diagnosticsText()
        let sections=[("Playback",playback),("Capture",capture),("Local test",probe)].filter{!$0.1.isEmpty}
        guard !sections.isEmpty else{call.reject("No audio diagnostics yet. Start listening or run a local test first.");return}
        let text="Lifestream audio diagnostics\n"+sections.map{"\($0.0)\n\($0.1)"}.joined(separator:"\n\n")
        UIPasteboard.general.setItems([["public.utf8-plain-text":text]],options:[.localOnly:true,.expirationDate:Date(timeIntervalSinceNow:300)])
        call.resolve(["copied":true])
    }}
    @objc public func diagnosticsStatus(_ call:CAPPluginCall){perform(call){[self] in call.resolve(["enabled":diagnosticLog.enabled,"count":diagnosticLog.count,"storageError":diagnosticLog.failed])}}
    @objc public func setDiagnosticsEnabled(_ call:CAPPluginCall){perform(call){[self] in
        guard let enabled=call.getBool("enabled") else{call.reject("Choose whether diagnostics are enabled.");return}
        diagnosticLog.setEnabled(enabled);call.resolve(["enabled":diagnosticLog.enabled,"count":diagnosticLog.count])
    }}
    @objc public func logDiagnostic(_ call:CAPPluginCall){perform(call){[self] in
        guard let name=call.getString("event"),let event=DiagnosticEvent(rawValue:name) else{call.reject("Unknown diagnostic event.");return}
        // The web view can report an enumerated stage only; numeric observations
        // and error codes originate from native owners, never from page data.
        diagnosticLog.record(event)
        call.resolve()
    }}
    @objc public func clearDiagnostics(_ call:CAPPluginCall){perform(call){[self] in diagnosticLog.clear();call.resolve(["count":0])}}
    @objc public func shareDiagnostics(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active,let controller=bridge?.viewController,controller.viewIfLoaded?.window != nil,controller.presentedViewController==nil,!controller.isBeingDismissed else{call.reject("Open the app and close other panels before sharing diagnostics.");return}
        guard diagnosticLog.count>0 else{call.reject("There are no diagnostic events to share yet.");return}
        let file:URL;do{file=try diagnosticLog.exportFile()}catch{call.reject("The diagnostic file could not be prepared on this device.");return}
        let sheet=UIActivityViewController(activityItems:[file],applicationActivities:nil)
        if let popover=sheet.popoverPresentationController{popover.sourceView=controller.view;popover.sourceRect=CGRect(x:controller.view.bounds.midX,y:controller.view.bounds.midY,width:1,height:1);popover.permittedArrowDirections=[]}
        sheet.completionWithItemsHandler={_,completed,_,_ in DiagnosticExportFile.finish(file);call.resolve(["shared":completed])}
        controller.present(sheet,animated:true)
    }}
    @objc public func snapshot(_ call:CAPPluginCall){perform(call){[self] in call.resolve(voice.snapshot())}}
    @objc public func routePicker(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active,let controller=bridge?.viewController,
              controller.viewIfLoaded?.window != nil else{call.reject("Open the app to choose a microphone.");return}
        guard controller.presentedViewController==nil,!controller.isBeingDismissed else{call.reject("Close the current panel, then open Microphone again.");return}
        audioProbe.stop()
        let choices=voice.inputChoices()
        let discovery=choices.count>2 ? "Connected inputs listed below are checked again at Start.":"iOS currently exposes no external microphone choices. System default follows the iOS input route, including a connected headset. Inputs are checked again at Start."
        let panel=UIAlertController(title:"Microphone",message:"Selected: \(voice.inputSelectionSummary()).\n\nChoosing stops the current conversation and applies on your next Start. It does not begin recording.\n\n"+discovery+"\n\nBluetooth microphone selection may also move playback to that headset. Use iOS Control Center for playback destinations.",preferredStyle:.actionSheet)
        for choice in choices {
            let title=choice.label+(choice.id==voice.selectedInput ? " (selected)":"")
            panel.addAction(UIAlertAction(title:title,style:.default){[weak self] _ in self?.voice.selectInput(choice.id)})
        }
        panel.addAction(UIAlertAction(title:"Cancel",style:.cancel))
        if let popover=panel.popoverPresentationController{popover.sourceView=controller.view;popover.sourceRect=CGRect(x:controller.view.bounds.midX,y:controller.view.bounds.midY,width:1,height:1);popover.permittedArrowDirections=[]}
        controller.present(panel,animated:true){if panel.presentingViewController != nil{call.resolve()}else{call.reject("The microphone panel could not open. Close other panels and try again.")}}
    }}
}
public final class AssistantViewController:CAPBridgeViewController {
    private var shields=[NSObjectProtocol]()
    private var shield:UIView?
    public override func capacitorDidLoad(){bridge?.registerPluginInstance(AssistantPlugin())}
    public override func viewDidLoad(){
        super.viewDidLoad()
        shields.append(NotificationCenter.default.addObserver(forName:UIApplication.willResignActiveNotification,object:nil,queue:.main){[weak self] _ in self?.protectDisplay()})
        shields.append(NotificationCenter.default.addObserver(forName:UIApplication.didBecomeActiveNotification,object:nil,queue:.main){[weak self] _ in self?.bridge?.webView?.evaluateJavaScript("document.dispatchEvent(new Event('lifestream-native-resume'))"){[weak self] _,error in if error==nil{self?.shield?.removeFromSuperview();self?.shield=nil}}})
    }
    private func protectDisplay(){
        guard shield==nil else{return}
        let cover=UIView(frame:view.bounds);cover.autoresizingMask=[.flexibleWidth,.flexibleHeight];cover.backgroundColor = .systemBackground
        let label=UILabel(frame:cover.bounds);label.autoresizingMask=[.flexibleWidth,.flexibleHeight];label.text="Lifestream";label.textAlignment = .center
        cover.addSubview(label);view.addSubview(cover);shield=cover
    }
    deinit{shields.forEach{NotificationCenter.default.removeObserver($0)}}
}
