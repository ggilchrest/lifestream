// SPDX-License-Identifier: Apache-2.0
import Foundation
import AssistantCore

final class NativeTransport: NSObject, URLSessionDataDelegate, URLSessionWebSocketDelegate {
    struct Pending { var data=Data(); var response:HTTPURLResponse?; var limit=64*1024*1024; var onResponse:((HTTPURLResponse)->Void)?; let done:(Result<(Data,HTTPURLResponse),Error>)->Void }
    struct RestoredConnection {
        let connection:SavedConnection?
        let authState:String
        var account:[String:Any]?
        /// Only non-secret metadata crosses the Capacitor bridge.
        var payload:[String:Any] {
            var result:[String:Any]=["authState":authState,"hasSession":authState=="authenticated","hasSavedCredentials":connection?.hasSavedCredentials ?? false]
            if let connection {result["endpoint"]=connection.endpoint;result["username"]=connection.username;result["settings"]=connection.settings ?? "{}"}
            if let account {result["account"]=account}
            return result
        }
    }
    let audit:BoundedVoiceAudit
    // False fences Health only; true is an actual origin/account/session/auth-loss transition.
    var healthContextWillChange:((_ authorityChanged:Bool)->Void)?
    final class HealthContextTransition {
        enum Kind{case authResponse,authUnavailable,connectionReset}
        let kind:Kind,oldPrincipal:String?,oldSession:String?,proposedPrincipal:String?,proposedSession:String?,authData:Data?
        init(kind:Kind,oldPrincipal:String?,oldSession:String?,proposedPrincipal:String?,proposedSession:String?,authData:Data?){self.kind=kind;self.oldPrincipal=oldPrincipal;self.oldSession=oldSession;self.proposedPrincipal=proposedPrincipal;self.proposedSession=proposedSession;self.authData=authData}
    }
    /// Ephemeral invalidation observation only. SourceOwner performs the existing
    /// strict Auth parsing; no record/credential content is persisted or logged.
    var healthContextTransition:((HealthContextTransition)->Void)?
    /// Exact synchronous pairing with the typed notification. Legacy consumers
    /// retain their original Bool callback; no inferred ignore-next authority.
    var healthContextPairedWillChange:((Bool,HealthContextTransition?)->Void)?
    private func notifyHealthContextWillChange(_ changed:Bool,notification:HealthContextTransition?=nil){
        healthContextPairedWillChange?(changed,notification);healthContextWillChange?(changed)
    }

    var auditChanged:(()->Void)?
    var auditStopConfirmed:(()->Void)?
    var endpoint:URL?; var csrf=""; var epoch=0
    private var effectiveContextRef:String?
    private var effectiveOwner:(principal:String,session:String)?
    private(set) var effectiveIsSelf=false
    var hasEffectiveOwner:Bool{effectiveOwner != nil}
    var currentEffectiveOwner:(principal:String,session:String)?{effectiveOwner}
    var socketOpened:((URLSessionWebSocketTask)->Void)?; var socketClosed:((URLSessionWebSocketTask)->Void)?
    private let store:ConnectionStore
    private var connection:SavedConnection?
    init(store:ConnectionStore=KeychainConnectionStore(),audit:BoundedVoiceAudit=BoundedVoiceAudit()){self.store=store;self.audit=audit;super.init()}
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
        healthContextTransition?(.init(kind:.connectionReset,oldPrincipal:effectiveOwner?.principal,oldSession:effectiveOwner?.session,proposedPrincipal:nil,proposedSession:nil,authData:nil))
        notifyHealthContextWillChange(true)
        audit.invalidatePendingStatus();auditChanged?();endpoint=nil;epoch += 1;csrf="";effectiveContextRef=nil;effectiveOwner=nil;effectiveIsSelf=false;session.invalidateAndCancel();session=makeSession()
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
        connection=SavedConnection(endpoint:origin,username:username,settings:settings,pendingPersonalLocks:previous?.pendingPersonalLocks)
        try store.save(connection!)
    }
    func restoreConnection() throws -> SavedConnection? {
        reset();connection=try store.load();guard let saved=connection else{return nil}
        endpoint=try validated(saved.endpoint)
        guard saved.cookies.count<=8,saved.password?.utf8.count ?? 0 <= 1024,saved.username.count<=64 else{throw ConnectionStorageError.invalidRecord}
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
    /// Restore one existing session, or make at most one password sign-in attempt.
    /// An enrolled authenticator always requires a fresh code after session expiry.
    func restoreSession(done:@escaping(Result<RestoredConnection,Error>)->Void) {
        do {
            guard let saved=try restoreConnection() else {done(.success(RestoredConnection(connection:nil,authState:"needsSignIn")));return}
            if !saved.hasSession {restoreWithPassword(done:done);return}
            request("/api/auth/v1/session") {[weak self] result in
                guard let self else{return}
                switch result {
                case .failure(let error):
                    if case VoiceError.staleTurn=error {done(.failure(error))}
                    else {done(.success(RestoredConnection(connection:self.connection,authState:"offline")))}
                case .success(let (data,response)):
                    if response.statusCode==200 {self.finishRestore(data,done:done)}
                    else if response.statusCode==401 {self.restoreWithPassword(done:done)}
                    else {done(.success(RestoredConnection(connection:self.connection,authState:"offline")))}
                }
            }
        }catch{done(.failure(error))}
    }
    private func finishRestore(_ data:Data,done:@escaping(Result<RestoredConnection,Error>)->Void) {
        guard let json=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else{done(.failure(VoiceError.invalidMessage));return}
        let value=(json["session"] as? [String:Any]) ?? json
        guard value["sessionId"] is String else{done(.failure(VoiceError.invalidMessage));return}
        let account=value.filter{["principalId","owner","sessionId","adminExpiresAt"].contains($0.key)}
        done(.success(RestoredConnection(connection:connection,authState:"authenticated",account:account)))
    }
    private func restoreWithPassword(done:@escaping(Result<RestoredConnection,Error>)->Void) {
        guard let saved=connection,saved.hasSavedCredentials else{done(.success(RestoredConnection(connection:connection,authState:"needsSignIn")));return}
        if saved.requiresOneTimeCode==true {done(.success(RestoredConnection(connection:saved,authState:"needsOneTimeCode")));return}
        do {
            let body=String(data:try JSONSerialization.data(withJSONObject:["username":saved.username,"password":saved.password!]),encoding:.utf8)!
            request("/api/auth/v1/sign-in",method:"POST",body:body) {[weak self] result in
                guard let self else{return}
                switch result {
                case .failure(let error):
                    if case VoiceError.staleTurn=error {done(.failure(error))}
                    else {done(.success(RestoredConnection(connection:self.connection,authState:"offline")))}
                case .success(let (data,response)):
                    if response.statusCode==200 {self.finishRestore(data,done:done)}
                    else if response.statusCode==401 || response.statusCode==403 {
                        do {try self.forgetSession();done(.success(RestoredConnection(connection:self.connection,authState:"needsSignIn")))}catch{done(.failure(error))}
                    }else{done(.success(RestoredConnection(connection:self.connection,authState:"offline")))}
                }
            }
        }catch{done(.failure(error))}
    }
    func pendingLockState()->(state:String,body:String?,unresolvedElsewhere:Bool){
        guard let saved=connection else{return ("none",nil,false)}
        let all=saved.pendingPersonalLocks ?? [],onServer=all.filter{$0.endpoint==saved.endpoint}
        guard let owner=effectiveOwner else{return (onServer.isEmpty ? "none":"mismatch",nil,!all.isEmpty)}
        guard let pending=onServer.first(where:{$0.principalId==owner.principal}) else{return ("none",nil,!all.isEmpty)}
        let elsewhere=all.contains{$0.endpoint != pending.endpoint || $0.principalId != pending.principalId}
        guard owner.session==pending.sessionId else{return ("mismatch",nil,elsewhere)}
        return ("matching",pending.body,elsewhere)
    }
    /// Only an exact current-session record can restrict an authenticated
    /// successor. All other scoped records remain in custody and visible.
    func personalAppPendingState()->(state:String,body:String?,unresolvedElsewhere:Bool){
        guard let saved=connection,let owner=effectiveOwner else{return ("mismatch",nil,false)}
        let all=saved.pendingPersonalLocks ?? []
        if let current=all.first(where:{$0.endpoint==saved.endpoint && $0.principalId==owner.principal && $0.sessionId==owner.session}){
            return ("matching",current.body,all.contains{$0.endpoint != current.endpoint || $0.principalId != current.principalId || $0.sessionId != current.sessionId})
        }
        return ("none",nil,!all.isEmpty)
    }
    func persistPendingLock(_ body:String) throws {
        guard body.utf8.count<=4096,let owner=effectiveOwner,var saved=connection else{throw ConnectionStorageError.invalidRecord}
        var pending=saved.pendingPersonalLocks ?? []
        if let old=pending.first(where:{$0.endpoint==saved.endpoint && $0.principalId==owner.principal}) {
            guard old.sessionId==owner.session,old.body==body else{throw ConnectionStorageError.invalidRecord}
        }else{
            guard pending.count<8 else{throw ConnectionStorageError.invalidRecord}
            pending.append(PendingPersonalLock(endpoint:saved.endpoint,username:saved.username,principalId:owner.principal,sessionId:owner.session,body:body))
        }
        saved.pendingPersonalLocks=pending;try store.save(saved);connection=saved
    }
    func confirmPendingLock(_ body:String) throws {
        guard var saved=connection,let owner=effectiveOwner,var pending=saved.pendingPersonalLocks,let index=pending.firstIndex(where:{$0.endpoint==saved.endpoint && $0.principalId==owner.principal && $0.sessionId==owner.session && $0.body==body}) else{throw ConnectionStorageError.invalidRecord}
        pending.remove(at:index);saved.pendingPersonalLocks=pending;try store.save(saved);connection=saved
    }
    func saveSettings(_ value:String) throws {
        guard value.utf8.count<=16384,(try JSONSerialization.jsonObject(with:Data(value.utf8))) is [String:Any] else{throw VoiceError.invalidMessage}
        guard var saved=connection else{throw VoiceError.invalidEndpoint};saved.settings=value;try store.save(saved);connection=saved
    }
    func forgetSession() throws {
        let origin=endpoint;reset();endpoint=origin
        if var saved=try connection ?? store.load() {saved.cookies=[];saved.password=nil;saved.requiresOneTimeCode=nil;try store.save(saved);connection=saved}
    }
    private func expireSession() throws {
        csrf="";session.configuration.httpCookieStorage?.removeCookies(since:.distantPast)
        if var saved=connection {saved.cookies=[];try store.save(saved);connection=saved}
    }
    private func rememberSession(_ response:HTTPURLResponse,body:String?) throws {
        guard let endpoint,var saved=connection else{throw VoiceError.invalidEndpoint}
        let headers=response.allHeaderFields.reduce(into:[String:String]()){if let key=$1.key as? String,let value=$1.value as? String{$0[key]=value}}
        let cookies=HTTPCookie.cookies(withResponseHeaderFields:headers,for:endpoint)
        for cookie in cookies{session.configuration.httpCookieStorage?.setCookie(cookie)}
        saved.cookies=(session.configuration.httpCookieStorage?.cookies(for:endpoint) ?? []).filter{$0.name.hasPrefix("lifestream_") && !$0.value.isEmpty}.map{SavedCookie(name:$0.name,value:$0.value)}
        guard saved.hasSession else{throw VoiceError.invalidMessage}
        if let body,let input=(try? JSONSerialization.jsonObject(with:Data(body.utf8))) as? [String:Any],let password=input["password"] as? String,let username=input["username"] as? String,!password.isEmpty,password.utf8.count<=1024,username.count<=64 {
            // The successful response proves these credentials before retaining them.
            saved=SavedConnection(endpoint:saved.endpoint,username:username,cookies:saved.cookies,settings:saved.username==username ? saved.settings:nil,password:password,requiresOneTimeCode:!((input["totp"] as? String) ?? "").isEmpty,pendingPersonalLocks:saved.pendingPersonalLocks)
        }
        try store.save(saved);connection=saved
    }
    @discardableResult
    func request(_ path:String,method:String="GET",body:String?=nil,timeout:Double=15,internalPreview:Bool=false,internalHealth:Bool=false,internalCalendarConsent:Bool=false,internalHealthConsent:Bool=false,internalHealthControl:Bool=false,maxBytes:Int=64*1024*1024,onResponse:((HTTPURLResponse)->Void)?=nil,done:@escaping(Result<(Data,HTTPURLResponse),Error>)->Void) -> URLSessionDataTask? {
        let previewAllowed=internalPreview && method=="POST" && ["/api/runtime/v1/tts","/api/runtime/v1/tts/playback","/api/runtime/v1/voice-reference-preview"].contains(path)
        let healthAllowed=internalHealth && method=="POST" && path=="/api/runtime/v1/mobile-context"
        let healthControlObject=body.flatMap{(try? JSONSerialization.jsonObject(with:Data($0.utf8))) as? [String:Any]}
        let healthControlAllowed=internalHealthControl && method=="POST" && path=="/api/runtime/v1/mobile-context" &&
            healthControlObject?["producerPin"] as? [String:String]==["schemaId":MobileOrdinaryControl.schemaId,"schemaVersion":"1.0.0","digest":MobileOrdinaryControl.schemaDigest] && ["control","reconcile"].contains(healthControlObject?["operation"] as? String ?? "")
        let healthConsentAllowed=internalHealthConsent && method=="POST" && path=="/api/runtime/v1/mobile-context-policy" && body.flatMap{(try? JSONSerialization.jsonObject(with:Data($0.utf8))) as? [String:Any]}?["producerPin"] as? [String:String]==MobileHealthSourceConsent.pin
        guard let endpoint,(EndpointPolicy.permits(path,method:method)||previewAllowed||healthAllowed||healthConsentAllowed||healthControlAllowed||(internalCalendarConsent && method=="POST" && path=="/api/runtime/v1/mobile-context-policy")),body?.utf8.count ?? 0 <= ((healthConsentAllowed || healthControlAllowed) ? 131072:65536),maxBytes>0,maxBytes<=64*1024*1024 else {done(.failure(VoiceError.invalidEndpoint));return nil}
        var req=URLRequest(url:endpoint.appendingPathComponent(String(path.dropFirst())))
        req.httpMethod=method;req.timeoutInterval=timeout;req.httpBody=body?.data(using:.utf8)
        req.setValue(endpoint.absoluteString.trimmingCharacters(in:CharacterSet(charactersIn:"/")),forHTTPHeaderField:"Origin")
        req.setValue("application/json",forHTTPHeaderField:"Content-Type")
        if method != "GET" {req.setValue(csrf,forHTTPHeaderField:"x-lifestream-csrf")}
        if path != "/api/auth/v1/user-context",let ref=effectiveContextRef {req.setValue(ref,forHTTPHeaderField:"x-lifestream-user-context")}
        let audienceRead=(path=="/api/runtime/v1/audience" || path=="/api/runtime/v1/audience/personal-session") && method=="GET"
        let auditTicket=audienceRead ? audit.beginStatusRequest():nil
        if (audienceRead || path=="/api/runtime/v1/audience/lease"),let labels=audit.correlation(){
            req.setValue(labels.session,forHTTPHeaderField:"x-lfs-audit-session");req.setValue(labels.attempt,forHTTPHeaderField:"x-lfs-audit-attempt")
            _=audit.record(.privacyRequestStart,session:labels.session,attempt:labels.attempt,turn:nil)
        }
        let auditLabels=(audienceRead || path=="/api/runtime/v1/audience/lease") ? audit.correlation():nil
        let ticket=epoch,task=session.dataTask(with:req)
        pending[ObjectIdentifier(task)]=Pending(limit:maxBytes,onResponse:onResponse,done:{[weak self] result in
            guard let self,self.epoch==ticket else {done(.failure(VoiceError.staleTurn));return}
            if let labels=auditLabels {
                let code:Int,requestId:Int?;if case .success((_,let response))=result {code=response.statusCode;let session=response.value(forHTTPHeaderField:"x-lfs-audit-session");let raw=response.value(forHTTPHeaderField:"x-lfs-audit-request");requestId=session==labels.session ? raw.flatMap{Int($0)}:nil}else{code=0;requestId=nil}
                _=self.audit.record(.privacyRequestFinish,session:labels.session,attempt:labels.attempt,turn:nil,value:code,request:requestId)
            }
            if let auditTicket {
                if case .success((let data,let response))=result {let accepted=self.audit.completeStatusRequest(auditTicket,statusCode:response.statusCode,data:data);if accepted,response.statusCode==200,let body=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],body["diagnostics"]==nil{self.auditStopConfirmed?()}}
                else {self.audit.completeStatusRequest(auditTicket,statusCode:0,data:Data())}
                self.auditChanged?()
            }
            if case .success(let (_,response))=result,response.statusCode==401 {self.notifyHealthContextWillChange(true)}
            if path=="/api/auth/v1/user-context" {
                // Notify before publishing a changed effective subject. The
                // original Source can fence collection immediately and retain
                // its narrow protective persistence obligation across reset.
                let notification:HealthContextTransition
                if case .success(let(data,http))=result,http.statusCode==200,data.count<=65536,
                   let value=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let context=value["context"] as? [String:Any]{
                    notification = .init(kind:.authResponse,oldPrincipal:self.effectiveOwner?.principal,oldSession:self.effectiveOwner?.session,proposedPrincipal:context["actorId"] as? String,proposedSession:context["authenticatedSessionId"] as? String,authData:data)
                }else{
                    notification = .init(kind:.authUnavailable,oldPrincipal:self.effectiveOwner?.principal,oldSession:self.effectiveOwner?.session,proposedPrincipal:nil,proposedSession:nil,authData:nil)
                }
                self.healthContextTransition?(notification)
                guard self.epoch==ticket else{done(.failure(VoiceError.staleTurn));return}
                if case .success(let (data,response))=result,response.statusCode==200,let json=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let ref=json["contextRef"] as? String,!ref.isEmpty,ref.utf8.count<=512 {
                    if let c=json["context"] as? [String:Any],let principal=c["actorId"] as? String,let session=c["authenticatedSessionId"] as? String,UUID(uuidString:principal) != nil,UUID(uuidString:session) != nil {
                        let isSelf=c["effectiveUserId"] as? String == principal
                        if let old=self.effectiveOwner {
                            let authorityChanged = old.principal != principal || old.session != session || self.effectiveIsSelf != isSelf
                            if authorityChanged || self.effectiveContextRef != ref {self.notifyHealthContextWillChange(authorityChanged,notification:notification)}
                        }
                        guard self.epoch==ticket else{done(.failure(VoiceError.staleTurn));return}
                        self.effectiveContextRef=ref;self.effectiveOwner=(principal,session);self.effectiveIsSelf=isSelf
                    }else{self.notifyHealthContextWillChange(false,notification:notification);guard self.epoch==ticket else{done(.failure(VoiceError.staleTurn));return};self.effectiveContextRef=ref;self.effectiveOwner=nil;self.effectiveIsSelf=false}
                }else{self.notifyHealthContextWillChange(false,notification:notification)}
            }
            if case .success(let (data,response))=result, response.statusCode==200,
               ["/api/auth/v1/sign-in","/api/auth/v1/session"].contains(path),let json=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let token=(json["csrfToken"] as? String) ?? ((json["session"] as? [String:Any])?["csrfToken"] as? String) {self.csrf=token}
            do {
                if case .success(let (_,response))=result {
                    if path=="/api/auth/v1/sign-in",response.statusCode==200 {try self.rememberSession(response,body:body)}
                    if path=="/api/auth/v1/session",response.statusCode==401 {try self.expireSession()}
                }
                done(result)
            }catch{done(.failure(error))}
        });task.resume();return task
    }
    func webSocket() throws -> URLSessionWebSocketTask {
        guard let endpoint else {throw VoiceError.invalidEndpoint}
        var c=URLComponents(url:endpoint,resolvingAgainstBaseURL:false)!;c.scheme=endpoint.scheme=="https" ? "wss":"ws";c.path="/api/runtime/v1/audio"
        var r=URLRequest(url:c.url!);r.setValue(endpoint.absoluteString.trimmingCharacters(in:CharacterSet(charactersIn:"/")),forHTTPHeaderField:"Origin")
        r.setValue(csrf,forHTTPHeaderField:"x-lifestream-csrf")
        if let ref=effectiveContextRef{r.setValue(ref,forHTTPHeaderField:"x-lifestream-user-context")}
        if let labels=audit.correlation(){r.setValue(labels.session,forHTTPHeaderField:"x-lfs-audit-session");r.setValue(labels.attempt,forHTTPHeaderField:"x-lfs-audit-attempt");if audit.recordsContent{r.setValue("speech-v1",forHTTPHeaderField:"x-lfs-audit-content")}}
        let cookies=session.configuration.httpCookieStorage?.cookies(for:endpoint) ?? []
        for (k,v) in HTTPCookie.requestHeaderFields(with:cookies){r.setValue(v,forHTTPHeaderField:k)}
        let task=session.webSocketTask(with:r);task.maximumMessageSize=131072;return task
    }
    func urlSession(_ session:URLSession,dataTask:URLSessionDataTask,didReceive response:URLResponse,completionHandler:@escaping(URLSession.ResponseDisposition)->Void){
        guard let response=response as? HTTPURLResponse,let item=pending[ObjectIdentifier(dataTask)],response.expectedContentLength <= item.limit else {completionHandler(.cancel);return}
        pending[ObjectIdentifier(dataTask)]?.response=response;item.onResponse?(response);completionHandler(.allow)
    }
    func urlSession(_ session:URLSession,dataTask:URLSessionDataTask,didReceive data:Data){
        guard let p=pending[ObjectIdentifier(dataTask)],p.data.count+data.count <= p.limit else {dataTask.cancel();return}
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
