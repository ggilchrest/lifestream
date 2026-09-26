// SPDX-License-Identifier: Apache-2.0
import Foundation
import AssistantCore

final class NativeTransport: NSObject, URLSessionDataDelegate, URLSessionWebSocketDelegate {
    struct Pending { var data=Data(); var response:HTTPURLResponse?; let done:(Result<(Data,HTTPURLResponse),Error>)->Void }
    var endpoint:URL?; var csrf=""; var epoch=0
    var socketOpened:((URLSessionWebSocketTask)->Void)?; var socketClosed:((URLSessionWebSocketTask)->Void)?
    private var pending=[ObjectIdentifier:Pending]()
    lazy var session:URLSession = makeSession()
    private func makeSession()->URLSession {
        let config=URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest=15;config.timeoutIntervalForResource=45
        config.httpCookieAcceptPolicy = .always;config.httpShouldSetCookies=true
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration:config,delegate:self,delegateQueue:.main)
    }
    func configure(_ value:String) throws {
        endpoint=nil;epoch += 1;csrf="";session.invalidateAndCancel();session=makeSession()
        #if DEBUG
        endpoint=try EndpointPolicy.validate(value,allowLoopback:true)
        #else
        endpoint=try EndpointPolicy.validate(value)
        #endif
        session.configuration.httpCookieStorage?.removeCookies(since:.distantPast)
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
            done(result)
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
