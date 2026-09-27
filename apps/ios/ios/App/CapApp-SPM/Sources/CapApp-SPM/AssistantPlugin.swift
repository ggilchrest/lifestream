// SPDX-License-Identifier: Apache-2.0
import Capacitor
import UIKit
import AVKit

@objc(AssistantPlugin)
public final class AssistantPlugin: CAPPlugin,CAPBridgedPlugin {
    public let identifier="AssistantPlugin",jsName="Assistant"
    public let pluginMethods=["configure","restoreConnection","forgetSession","saveSettings","request","sendText","cancelText","start","stop","snapshot","routePicker"].compactMap{CAPPluginMethod(name:$0,returnType:CAPPluginReturnPromise)}
    private let transport=NativeTransport()
    private lazy var text=NativeText(transport:transport)
    private var textBackgroundObserver:NSObjectProtocol?
    public override func load(){textBackgroundObserver=NotificationCenter.default.addObserver(forName:UIApplication.didEnterBackgroundNotification,object:nil,queue:.main){[weak self] _ in self?.text.stop()}}
    deinit{if let token=textBackgroundObserver{NotificationCenter.default.removeObserver(token)}}
    private lazy var voice:NativeVoice={let value=NativeVoice(transport:transport);value.emit={[weak self] message in guard UIApplication.shared.applicationState == .active else{return};self?.notifyListeners("event",data:message)};return value}()
    private func perform(_ call:CAPPluginCall,_ work:@escaping()->Void){DispatchQueue.main.async{[weak self] in guard let self,let url=self.bridge?.webView?.url,url.scheme=="capacitor",url.host=="localhost" else{call.reject("Only the bundled app may use native audio.");return};work()}}
    @objc public func configure(_ call:CAPPluginCall){perform(call){[self] in
        guard let endpoint=call.getString("endpoint") else{call.reject("Enter an HTTPS server address.");return}
        text.stop();voice.stop("Server changed")
        do{try transport.configure(endpoint,username:call.getString("username") ?? "");call.resolve(["configured":true])}catch{call.reject("Use an HTTPS server origin without a path, credentials or query.")}
    }}
    @objc public func restoreConnection(_ call:CAPPluginCall){perform(call){[self] in
        text.stop();voice.stop("Restoring connection")
        transport.restoreSession{result in
            switch result{case .success(let restored):call.resolve(restored.payload);case .failure:call.reject("Saved connection is unavailable. Unlock this device and try again.")}
        }
    }}
    @objc public func forgetSession(_ call:CAPPluginCall){perform(call){[self] in
        text.stop();voice.stop("Signed out")
        do{try transport.forgetSession();call.resolve()}catch{call.reject("Could not clear the saved session. Unlock the device and try signing out again.")}
    }}
    @objc public func saveSettings(_ call:CAPPluginCall){perform(call){[self] in
        do{try transport.saveSettings(call.getString("settings") ?? "{}");call.resolve()}catch{call.reject("Could not save settings on this device.")}
    }}
    @objc public func request(_ call:CAPPluginCall){perform(call){[self] in
        guard let path=call.getString("path") else{call.reject("Missing request path.");return}
        let method=call.getString("method") ?? "GET"
        if method != "GET",!path.hasSuffix("/messages"){text.stop();voice.stop("Session settings changed")}
        transport.request(path,method:method,body:call.getString("body")){[weak self] result in
            switch result{case .failure:call.reject("The server could not be reached securely.")
            case .success(let (data,response)):
                if response.statusCode==401 || response.statusCode==403 {self?.text.stop();self?.voice.stop("Sign-in or audience permission changed.")}
                let binary=path.hasPrefix("/api/runtime/v1/presentation/resources/")
                call.resolve(["status":response.statusCode,"body":binary ? data.base64EncodedString():String(data:data,encoding:.utf8) ?? "","encoding":binary ? "base64":"utf8"])
            }
        }
    }}
    @objc public func sendText(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active,
              let assistant=call.getString("assistantId"),let prompt=call.getString("userInput"),let trace=call.getString("trace") else{call.reject("Open the app and enter a message for the selected Assistant.");return}
        voice.stop("Sending text; microphone is off.")
        text.send(["assistantId":assistant,"userInput":prompt,"trace":trace]){result in
            guard UIApplication.shared.applicationState == .active else{call.reject("Text response stopped because the display is locked.");return}
            switch result{case .success(let reply):call.resolve(reply);case .failure(let error):call.reject(error.localizedDescription)}
        }
    }}
    @objc public func cancelText(_ call:CAPPluginCall){perform(call){[self] in text.stop();call.resolve()}}
    @objc public func start(_ call:CAPPluginCall){perform(call){[self] in
        guard let request=call.getObject("request") else{call.reject("Select a current session first.");return}
        text.stop();voice.start(request,background:call.getBool("background") ?? false){error in if error != nil{let detail=self.voice.snapshot()["lastError"] as? String;call.reject(detail?.isEmpty==false ? detail!:"Audio could not start. Check microphone permission, sign-in and audience.")}else{call.resolve(self.voice.snapshot())}}
    }}
    @objc public func stop(_ call:CAPPluginCall){perform(call){[self] in text.stop();voice.stop();call.resolve(voice.snapshot())}}
    @objc public func snapshot(_ call:CAPPluginCall){perform(call){[self] in call.resolve(voice.snapshot())}}
    @objc public func routePicker(_ call:CAPPluginCall){perform(call){[self] in
        guard let controller=bridge?.viewController else{call.reject("Audio route picker unavailable.");return}
        let panel=UIViewController();panel.view.backgroundColor = .systemBackground
        let picker=AVRoutePickerView(frame:CGRect(x:0,y:40,width:300,height:80));picker.activeTintColor = .systemTeal;panel.view.addSubview(picker)
        let label=UILabel(frame:CGRect(x:20,y:120,width:300,height:100));label.numberOfLines=0;label.text="Choose a connected audio device. Bluetooth microphones use the system call-audio route.";panel.view.addSubview(label)
        panel.modalPresentationStyle = .pageSheet;if let sheet=panel.sheetPresentationController{sheet.detents=[.medium()];sheet.prefersGrabberVisible=true}
        controller.present(panel,animated:true);call.resolve()
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
