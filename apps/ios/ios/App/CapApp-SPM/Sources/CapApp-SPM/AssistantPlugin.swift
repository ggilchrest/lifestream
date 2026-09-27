// SPDX-License-Identifier: Apache-2.0
import Capacitor
import UIKit
import AVKit

@objc(AssistantPlugin)
public final class AssistantPlugin: CAPPlugin,CAPBridgedPlugin {
    public let identifier="AssistantPlugin",jsName="Assistant"
    public let pluginMethods=["configure","restoreConnection","forgetSession","saveSettings","request","start","stop","snapshot","routePicker"].compactMap{CAPPluginMethod(name:$0,returnType:CAPPluginReturnPromise)}
    private let transport=NativeTransport()
    private lazy var voice:NativeVoice={let value=NativeVoice(transport:transport);value.emit={[weak self] message in guard UIApplication.shared.applicationState == .active else{return};self?.notifyListeners("event",data:message)};return value}()
    private func perform(_ call:CAPPluginCall,_ work:@escaping()->Void){DispatchQueue.main.async{[weak self] in guard let self,let url=self.bridge?.webView?.url,url.scheme=="capacitor",url.host=="localhost" else{call.reject("Only the bundled app may use native audio.");return};work()}}
    @objc public func configure(_ call:CAPPluginCall){perform(call){[self] in
        guard let endpoint=call.getString("endpoint") else{call.reject("Enter an HTTPS server address.");return}
        voice.stop("Server changed")
        do{try transport.configure(endpoint,username:call.getString("username") ?? "");call.resolve(["configured":true])}catch{call.reject("Use an HTTPS server origin without a path, credentials or query.")}
    }}
    @objc public func restoreConnection(_ call:CAPPluginCall){perform(call){[self] in
        voice.stop("Restoring connection")
        do{guard let saved=try transport.restoreConnection() else{call.resolve(["hasSession":false]);return};call.resolve(["endpoint":saved.endpoint,"username":saved.username,"hasSession":saved.hasSession,"settings":saved.settings ?? "{}"])}catch{call.reject("Saved connection is unavailable. Unlock this device and try again.")}
    }}
    @objc public func forgetSession(_ call:CAPPluginCall){perform(call){[self] in
        voice.stop("Signed out")
        do{try transport.forgetSession();call.resolve()}catch{call.reject("Could not clear the saved session. Unlock the device and try signing out again.")}
    }}
    @objc public func saveSettings(_ call:CAPPluginCall){perform(call){[self] in
        do{try transport.saveSettings(call.getString("settings") ?? "{}");call.resolve()}catch{call.reject("Could not save settings on this device.")}
    }}
    @objc public func request(_ call:CAPPluginCall){perform(call){[self] in
        guard let path=call.getString("path") else{call.reject("Missing request path.");return}
        let method=call.getString("method") ?? "GET"
        if method != "GET",!path.hasSuffix("/messages"){voice.stop("Session settings changed")}
        transport.request(path,method:method,body:call.getString("body")){[weak self] result in
            switch result{case .failure:call.reject("The server could not be reached securely.")
            case .success(let (data,response)):
                if response.statusCode==401 || response.statusCode==403 {self?.voice.stop("Sign-in or audience permission changed.")}
                let binary=path.hasPrefix("/api/runtime/v1/presentation/resources/")
                call.resolve(["status":response.statusCode,"body":binary ? data.base64EncodedString():String(data:data,encoding:.utf8) ?? "","encoding":binary ? "base64":"utf8"])
            }
        }
    }}
    @objc public func start(_ call:CAPPluginCall){perform(call){[self] in
        guard let request=call.getObject("request") else{call.reject("Select a current session first.");return}
        voice.start(request,background:call.getBool("background") ?? false){error in if error != nil{call.reject("Audio could not start. Check microphone permission, sign-in and audience.")}else{call.resolve(self.voice.snapshot())}}
    }}
    @objc public func stop(_ call:CAPPluginCall){perform(call){[self] in voice.stop();call.resolve(voice.snapshot())}}
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
