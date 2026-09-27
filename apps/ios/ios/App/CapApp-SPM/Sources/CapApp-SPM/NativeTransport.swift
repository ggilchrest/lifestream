// SPDX-License-Identifier: Apache-2.0
import Foundation
import AssistantCore

final class NativeTransport: NSObject, URLSessionDataDelegate, URLSessionWebSocketDelegate {
    struct Pending { var data=Data(); var response:HTTPURLResponse?; let done:(Result<(Data,HTTPURLResponse),Error>)->Void }
    var endpoint:URL?; var csrf=""; var epoch=0
    var socketOpened:((URLSessionWebSocketTask)->Void)?; var socketClosed:((URLSessionWebSocketTask)->Void)?
    private let store:ConnectionStore
    private var connection:SavedConnection?
    init(store:ConnectionStore=KeychainConnectionStore()){self.store=store;super.init()}
    private var pending=[ObjectIdentifier:Pending]()
    lazy var session:URLSession = makeSession()
    private func makeSession()->URLSession {
        let config=URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest=15;config.timeoutIntervalForResource=45
        config.httpCookieAcceptPolicy = .always;config.httpShouldSetCookies=true
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration:config,delegate:self,delegateQueue:.main)
    }
    private func reset() {
        endpoint=nil;epoch += 1;csrf="";session.invalidateAndCancel();session=makeSession()
        session.configuration.httpCookieStorage?.removeCookies(since:.distantPast)
    }
    private func validated(_ value:String) throws -> URL {
        #if DEBUG
        return try EndpointPolicy.validate(value,allowLoopback:true)
        #else
        return try EndpointPolicy.validate(value)
        #endif
    }
    func configure(_ value:String,username:String="") throws {
        let url=try validated(value),origin=url.absoluteString.trimmingCharacters(in:CharacterSet(charactersIn:"/"))
        guard username.count<=64 else{throw VoiceError.invalidMessage}
        let previous=try store.load()
        reset();endpoint=URL(string:origin)
        let settings=previous?.endpoint==origin && previous?.username==username ? previous?.settings:nil
        connection=SavedConnection(endpoint:origin,username:username,settings:settings)
        try store.save(connection!)
    }
    func restoreConnection() throws -> SavedConnection? {
        reset();connection=try store.load();guard let saved=connection else{return nil}
        endpoint=try validated(saved.endpoint)
        guard saved.cookies.count<=8 else{throw ConnectionStorageError.invalidRecord}
        for item in saved.cookies {
            guard item.name.range(of:"^lifestream_[0-9]+$",options:.regularExpression) != nil,item.value.range(of:"^[A-Za-z0-9_-]{1,100}$",options:.regularExpression) != nil,
                  !item.value.isEmpty else{throw ConnectionStorageError.invalidRecord}
            var properties:[HTTPCookiePropertyKey:Any]=[.name:item.name,.value:item.value,.domain:endpoint!.host!,.path:"/"]
            if endpoint!.scheme=="https"{properties[.secure]="TRUE"}
            guard let cookie=HTTPCookie(properties:properties) else{throw ConnectionStorageError.invalidRecord}
            session.configuration.httpCookieStorage?.setCookie(cookie)
        }
        return saved
    }
    func saveSettings(_ value:String) throws {
        guard value.utf8.count<=16384,(try JSONSerialization.jsonObject(with:Data(value.utf8))) is [String:Any] else{throw VoiceError.invalidMessage}
        guard var saved=connection else{throw VoiceError.invalidEndpoint};saved.settings=value;try store.save(saved);connection=saved
    }
    func forgetSession() throws {
        let origin=endpoint;reset();endpoint=origin
        if var saved=try connection ?? store.load() {saved.cookies=[];try store.save(saved);connection=saved}
    }
    private func rememberSession(_ response:HTTPURLResponse) throws {
        guard let endpoint,var saved=connection else{throw VoiceError.invalidEndpoint}
        let headers=response.allHeaderFields.reduce(into:[String:String]()){if let key=$1.key as? String,let value=$1.value as? String{$0[key]=value}}
        let cookies=HTTPCookie.cookies(withResponseHeaderFields:headers,for:endpoint)
        for cookie in cookies{session.configuration.httpCookieStorage?.setCookie(cookie)}
        saved.cookies=(session.configuration.httpCookieStorage?.cookies(for:endpoint) ?? []).filter{$0.name.hasPrefix("lifestream_") && !$0.value.isEmpty}.map{SavedCookie(name:$0.name,value:$0.value)}
        guard saved.hasSession else{throw VoiceError.invalidMessage};try store.save(saved);connection=saved
    }
    func request(_ path:String,method:String="GET",body:String?=nil,timeout:Double=15,done:@escaping(Result<(Data,HTTPURLResponse),Error>)->Void) {
        guard let endpoint,EndpointPolicy.permits(path,method:method),body?.utf8.count ?? 0 <= 65536 else {done(.failure(VoiceError.invalidEndpoint));return}
        var req=URLRequest(url:endpoint.appendingPathComponent(String(path.dropFirst())))
        req.httpMethod=method;req.timeoutInterval=timeout;req.httpBody=body?.data(using:.utf8)
        req.setValue(endpoint.absoluteString.trimmingCharacters(in:CharacterSet(charactersIn:"/")),forHTTPHeaderField:"Origin")
        req.setValue("application/json",forHTTPHeaderField:"Content-Type")
        if method != "GET" {req.setValue(csrf,forHTTPHeaderField:"x-lifestream-csrf")}
        let ticket=epoch,task=session.dataTask(with:req)
        pending[ObjectIdentifier(task)]=Pending(done:{[weak self] result in
            guard let self,self.epoch==ticket else {done(.failure(VoiceError.staleTurn));return}
            if case .success(let (data,response))=result, response.statusCode==200,
               ["/api/auth/v1/sign-in","/api/auth/v1/session"].contains(path),let json=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let token=(json["csrfToken"] as? String) ?? ((json["session"] as? [String:Any])?["csrfToken"] as? String) {self.csrf=token}
            do {
                if case .success(let (_,response))=result {
                    if path=="/api/auth/v1/sign-in",response.statusCode==200 {try self.rememberSession(response)}
                    if path=="/api/auth/v1/session",response.statusCode==401 {try self.forgetSession()}
                }
                done(result)
            }catch{done(.failure(error))}
        });task.resume()
    }
    func webSocket() throws -> URLSessionWebSocketTask {
        guard let endpoint else {throw VoiceError.invalidEndpoint}
        var c=URLComponents(url:endpoint,resolvingAgainstBaseURL:false)!;c.scheme=endpoint.scheme=="https" ? "wss":"ws";c.path="/api/runtime/v1/audio"
        var r=URLRequest(url:c.url!);r.setValue(endpoint.absoluteString.trimmingCharacters(in:CharacterSet(charactersIn:"/")),forHTTPHeaderField:"Origin")
        r.setValue(csrf,forHTTPHeaderField:"x-lifestream-csrf")
        let cookies=session.configuration.httpCookieStorage?.cookies(for:endpoint) ?? []
        for (k,v) in HTTPCookie.requestHeaderFields(with:cookies){r.setValue(v,forHTTPHeaderField:k)}
        let task=session.webSocketTask(with:r);task.maximumMessageSize=131072;return task
    }
    func urlSession(_ session:URLSession,dataTask:URLSessionDataTask,didReceive response:URLResponse,completionHandler:@escaping(URLSession.ResponseDisposition)->Void){
        guard let response=response as? HTTPURLResponse,response.expectedContentLength <= 64*1024*1024,pending[ObjectIdentifier(dataTask)] != nil else {completionHandler(.cancel);return}
        pending[ObjectIdentifier(dataTask)]?.response=response;completionHandler(.allow)
    }
    func urlSession(_ session:URLSession,dataTask:URLSessionDataTask,didReceive data:Data){
        guard let p=pending[ObjectIdentifier(dataTask)],p.data.count+data.count <= 64*1024*1024 else {dataTask.cancel();return}
        pending[ObjectIdentifier(dataTask)]?.data.append(data)
    }
    func urlSession(_ session:URLSession,task:URLSessionTask,didCompleteWithError error:Error?){
        guard let p=pending.removeValue(forKey:ObjectIdentifier(task)) else{return}
        if let error{p.done(.failure(error))}else if let response=p.response{p.done(.success((p.data,response)))}else{p.done(.failure(VoiceError.invalidMessage))}
    }
    func urlSession(_ session:URLSession,task:URLSessionTask,willPerformHTTPRedirection response:HTTPURLResponse,newRequest request:URLRequest,completionHandler:@escaping(URLRequest?)->Void){completionHandler(nil)}
    func urlSession(_ session:URLSession,webSocketTask:URLSessionWebSocketTask,didOpenWithProtocol protocol:String?){socketOpened?(webSocketTask)}
    func urlSession(_ session:URLSession,webSocketTask:URLSessionWebSocketTask,didCloseWith closeCode:URLSessionWebSocketTask.CloseCode,reason:Data?){socketClosed?(webSocketTask)}
}
