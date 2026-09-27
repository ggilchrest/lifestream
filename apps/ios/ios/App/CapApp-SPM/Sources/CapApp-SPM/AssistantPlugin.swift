// SPDX-License-Identifier: Apache-2.0
import Capacitor
import UIKit
import AssistantCore

@objc(AssistantPlugin)
public final class AssistantPlugin: CAPPlugin,CAPBridgedPlugin {
    public let identifier="AssistantPlugin",jsName="Assistant"
    public let pluginMethods=["configure","restoreConnection","forgetSession","saveSettings","request","beginAudience","endAudience","setBackgroundPolicy","sendText","cancelText","start","stop","snapshot","routePicker"].compactMap{CAPPluginMethod(name:$0,returnType:CAPPluginReturnPromise)}
    private let transport=NativeTransport()
    private lazy var text=NativeText(transport:transport)
    private var lifecycleObservers=[NSObjectProtocol](),continueWhenLocked=false
    private lazy var audience:NativeAudience={let value=NativeAudience(transport:transport);value.onEnded={[weak self] reason in
        guard let self else{return};self.text.stop();self.voice.stop(reason)
        self.notifyListeners("event",data:["type":"audience","active":false,"reason":reason])
    };return value}()
    public override func load(){
        _=audience
        func observe(_ name:Notification.Name,_ action:@escaping()->Void){lifecycleObservers.append(NotificationCenter.default.addObserver(forName:name,object:nil,queue:.main){_ in action()})}
        observe(UIApplication.willResignActiveNotification){[weak self] in self?.audience.resignActive()}
        observe(UIApplication.protectedDataWillBecomeUnavailableNotification){[weak self] in self?.audience.protectedDataUnavailable()}
        observe(UIApplication.protectedDataDidBecomeAvailableNotification){[weak self] in self?.audience.protectedDataAvailable()}
        observe(UIApplication.didBecomeActiveNotification){[weak self] in self?.audience.becomeActive()}
        observe(UIApplication.didEnterBackgroundNotification){[weak self] in guard let self else{return};self.text.stop();self.audience.enterBackground(continueWhenLocked:self.continueWhenLocked,protectedDataAvailable:UIApplication.shared.isProtectedDataAvailable)}
        observe(UIApplication.willTerminateNotification){[weak self] in self?.audience.end("App closed.")}
    }
    deinit{lifecycleObservers.forEach{NotificationCenter.default.removeObserver($0)}}
    private lazy var voice:NativeVoice={let value=NativeVoice(transport:transport);value.expectedAudienceLease={[weak self] in self?.audience.leaseId};value.emit={[weak self] message in guard UIApplication.shared.applicationState == .active else{return};self?.notifyListeners("event",data:message)};return value}()
    private func perform(_ call:CAPPluginCall,_ work:@escaping()->Void){DispatchQueue.main.async{[weak self] in guard let self,let url=self.bridge?.webView?.url,url.scheme=="capacitor",url.host=="localhost" else{call.reject("Only the bundled app may use native audio.");return};work()}}
    @objc public func configure(_ call:CAPPluginCall){perform(call){[self] in
        guard let endpoint=call.getString("endpoint") else{call.reject("Enter an HTTPS server address.");return}
        audience.end("Server changed",notify:false);text.stop();voice.stop("Server changed")
        do{try transport.configure(endpoint,username:call.getString("username") ?? "");call.resolve(["configured":true])}catch{call.reject("Use an HTTPS server origin without a path, credentials or query.")}
    }}
    @objc public func restoreConnection(_ call:CAPPluginCall){perform(call){[self] in
        audience.end("Restoring connection",notify:false);text.stop();voice.stop("Restoring connection")
        transport.restoreSession{result in
            switch result{case .success(let restored):call.resolve(restored.payload);case .failure:call.reject("Saved connection is unavailable. Unlock this device and try again.")}
        }
    }}
    @objc public func forgetSession(_ call:CAPPluginCall){perform(call){[self] in
        audience.end("Signed out",notify:false);text.stop();voice.stop("Signed out")
        do{try transport.forgetSession();call.resolve()}catch{call.reject("Could not clear the saved session. Unlock the device and try signing out again.")}
    }}
    @objc public func saveSettings(_ call:CAPPluginCall){perform(call){[self] in
        do{try transport.saveSettings(call.getString("settings") ?? "{}");call.resolve()}catch{call.reject("Could not save settings on this device.")}
    }}
    @objc public func request(_ call:CAPPluginCall){perform(call){[self] in
        guard let path=call.getString("path") else{call.reject("Missing request path.");return}
        let method=call.getString("method") ?? "GET"
        if method != "GET",!path.hasSuffix("/messages"){audience.end("Session settings changed",notify:false);text.stop();voice.stop("Session settings changed")}
        transport.request(path,method:method,body:call.getString("body")){[weak self] result in
            switch result{case .failure:call.reject("The server could not be reached securely.")
            case .success(let (data,response)):
                if response.statusCode==401 || response.statusCode==403 {self?.audience.end("Sign-in or audience permission changed.")}
                let binary=path.hasPrefix("/api/runtime/v1/presentation/resources/")
                call.resolve(["status":response.statusCode,"body":binary ? data.base64EncodedString():String(data:data,encoding:.utf8) ?? "","encoding":binary ? "base64":"utf8"])
            }
        }
    }}
    @objc public func beginAudience(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active else{call.reject("Open the app before activating its audience session.");return}
        audience.becomeActive()
        audience.begin{result in switch result{case .success(let value):call.resolve(value);case .failure(let error):call.reject(error.localizedDescription)}}
    }}
    @objc public func endAudience(_ call:CAPPluginCall){perform(call){[self] in audience.end("Audience session ended.",expectedLeaseId:call.getString("leaseId"));call.resolve()}}
    @objc public func setBackgroundPolicy(_ call:CAPPluginCall){perform(call){[self] in continueWhenLocked=call.getBool("enabled") ?? false;call.resolve()}}
    @objc public func sendText(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active,audience.leaseId != nil,
              let assistant=call.getString("assistantId"),let prompt=call.getString("userInput"),let trace=call.getString("trace") else{call.reject("Open the app and enter a message for the selected Assistant.");return}
        voice.stop("Sending text; microphone is off.")
        text.send(["assistantId":assistant,"userInput":prompt,"trace":trace]){result in
            guard UIApplication.shared.applicationState == .active else{call.reject("Text response stopped because the display is locked.");return}
            switch result{case .success(let reply):call.resolve(reply);case .failure(let error):call.reject(error.localizedDescription)}
        }
    }}
    @objc public func cancelText(_ call:CAPPluginCall){perform(call){[self] in text.stop();call.resolve()}}
    @objc public func start(_ call:CAPPluginCall){perform(call){[self] in
        guard audience.leaseId != nil,let request=call.getObject("request") else{call.reject("Select a current session first.");return}
        continueWhenLocked=call.getBool("background") ?? false;text.stop();voice.start(request,background:continueWhenLocked){error in if error != nil{let detail=self.voice.snapshot()["lastError"] as? String;call.reject(detail?.isEmpty==false ? detail!:"Audio could not start. Check microphone permission, sign-in and audience.")}else{call.resolve(self.voice.snapshot())}}
    }}
    @objc public func stop(_ call:CAPPluginCall){perform(call){[self] in audience.cancelActivation();text.stop();voice.stop();call.resolve(voice.snapshot())}}
    @objc public func snapshot(_ call:CAPPluginCall){perform(call){[self] in call.resolve(voice.snapshot())}}
    @objc public func routePicker(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active,let controller=bridge?.viewController,
              controller.viewIfLoaded?.window != nil else{call.reject("Open the app to choose a microphone.");return}
        guard controller.presentedViewController==nil,!controller.isBeingDismissed else{call.reject("Close the current panel, then open Microphone again.");return}
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
