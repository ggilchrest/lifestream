import Foundation
import AssistantCore

// Closed fixture phases/counters only; never emit requests, credentials or data.
enum ProbePhase:String {
    case initial, configure, configuredSessionBound="configured_session_bound"
    case signInPeer="sign_in_peer", signInComplete="sign_in_complete", loss, retryPeer="retry_peer", retryComplete="retry_complete", freshness
    case authSessionForbidden="auth_session_forbidden", authSignInForbidden="auth_sign_in_forbidden", invalidSession="invalid_session", unprovenSuccess="unproven_success"
    case reverify, privacyDenied="privacy_denied", sessionExpired="session_expired", unauthenticatedReachable="unauthenticated_reachable", signInDenied="sign_in_denied", reauthenticate
    case socketTraffic="socket_traffic", socketNormal="socket_normal", socketAbnormal="socket_abnormal"
    case oldPeer="old_peer", switchOrigin="switch_origin", replacementSessionBound="replacement_session_bound", oldComplete="old_complete", replacementSignIn="replacement_sign_in"
    case restoreStarting="restore_starting", restoreSessionBound="restore_session_bound", restorePeer="restore_peer", restoreComplete="restore_complete"
    case signOut="sign_out", forget, forgottenSessionBound="forgotten_session_bound", done
}
var currentPhase=ProbePhase.initial,peerRequests=0,rejectedRequests=0,sessionBindings=0
func record(_ event:String,phase:ProbePhase?=nil){
    let value:[String:Any]=["event":event,"phase":(phase ?? currentPhase).rawValue,"peerRequests":peerRequests,"rejectedRequests":rejectedRequests,"sessionBindings":sessionBindings]
    let bytes=try! JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]);FileHandle.standardOutput.write(bytes);FileHandle.standardOutput.write(Data([10]))
}
func phase(_ value:ProbePhase){currentPhase=value;record("phase_entered")}
func check(_ ok:@autoclosure()->Bool,_ name:String){if !ok(){record("assertion_failed");fatalError(name)}}
func awaitValue(_ value:ProbePhase,_ done:()->Bool){
    phase(value);let end=Date().addingTimeInterval(4)
    while !done() && Date()<end{_ = RunLoop.main.run(mode:.default,before:Date().addingTimeInterval(0.01))}
    check(done(),"bounded_synthetic_callback:"+value.rawValue);record("await_completed")
}
final class MemoryConnectionStore:ConnectionStore {
    var value:SavedConnection?
    // Test-only: restoreConnection calls load AFTER reset, BEFORE cookie replay
    // or restoreSession's first request. This synchronous port replaces that
    // fresh unresumed session before returning the saved synthetic record.
    var afterLoad:(()->Void)?
    func load()throws->SavedConnection?{afterLoad?();return value}
    func save(_ value:SavedConnection)throws{self.value=value}
}
final class ConnectionPeer:URLProtocol {
    static var action:((ConnectionPeer)->Void)?
    // Intercept every request, including mistakes. Never fall through to HTTP.
    override class func canInit(with request:URLRequest)->Bool{true}
    override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
    override func startLoading(){DispatchQueue.main.async{
        peerRequests+=1;record("peer_entered")
        guard let url=self.request.url,url.scheme=="https",["connection.invalid","replacement.invalid"].contains(url.host ?? ""),url.port==8443,url.user==nil,url.password==nil,url.query==nil,url.path.hasPrefix("/api/"),let action=Self.action else{
            rejectedRequests+=1;record("peer_rejected");self.client?.urlProtocol(self,didFailWithError:URLError(.unsupportedURL));return
        }
        action(self)
    }}
    override func stopLoading(){}
    func reply(_ status:Int,_ object:[String:Any]=[:],cookie:Bool=false){
        let headers=cookie ? ["Set-Cookie":"lifestream_8443=synthetic; Path=/; Secure"]:[:]
        client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:headers)!,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:try! JSONSerialization.data(withJSONObject:object));client?.urlProtocolDidFinishLoading(self)
    }
    func fail(){client?.urlProtocol(self,didFailWithError:URLError(.networkConnectionLost))}
}
var now:TimeInterval=100;let store=MemoryConnectionStore(),audit=BoundedVoiceAudit(),transport=NativeTransport(store:store,audit:audit,connectionClock:{now});var observations=[[String:Any]]();transport.connectionChanged={observations.append($0)}
var boundSession:ObjectIdentifier?,boundEpoch:Int?
func bindSyntheticSession(_ value:ProbePhase){
    let configuration=URLSessionConfiguration.ephemeral
    configuration.protocolClasses=[ConnectionPeer.self]
    configuration.timeoutIntervalForRequest=15;configuration.timeoutIntervalForResource=45
    configuration.httpCookieAcceptPolicy = .always;configuration.httpShouldSetCookies=true
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    transport.session.invalidateAndCancel()
    transport.session=URLSession(configuration:configuration,delegate:transport,delegateQueue:.main)
    boundSession=ObjectIdentifier(transport.session);boundEpoch=transport.epoch;sessionBindings+=1;record("session_bound",phase:value)
}
func requireSyntheticSession(){
    let types=transport.session.configuration.protocolClasses ?? []
    check(boundSession==ObjectIdentifier(transport.session) && boundEpoch==transport.epoch,"current_session_explicitly_bound_before_request")
    check(types.count==1 && ObjectIdentifier(types[0])==ObjectIdentifier(ConnectionPeer.self),"single_interceptor_without_default_network_fallback")
}
func reason()->String{transport.connectionSnapshot()["reason"] as! String}
func send(_ value:ProbePhase,_ path:String,method:String="GET",body:String?=nil,peer:@escaping(ConnectionPeer)->Void)->Result<(Data,HTTPURLResponse),Error>{
    phase(value);requireSyntheticSession();ConnectionPeer.action=peer;var result:Result<(Data,HTTPURLResponse),Error>?
    transport.request(path,method:method,body:body){result=$0};awaitValue(value){result != nil};return result!
}
func suspendedSocket()->URLSessionWebSocketTask{
    requireSyntheticSession();let task=try! transport.webSocket()
    check(task.state == .suspended,"socket_fixture_never_resumed");return task
}
let account:[String:Any]=["session":["sessionId":"00000000-0000-4000-8000-000000000001","csrfToken":"SENTINEL_TOKEN"]]
let retainedLock=PendingPersonalLock(endpoint:"https://connection.invalid:8443",username:"synthetic",principalId:"00000000-0000-4000-8000-000000000002",sessionId:"00000000-0000-4000-8000-000000000003",body:"{\"operation\":\"lock\"}")
store.value=SavedConnection(endpoint:"https://connection.invalid:8443",username:"synthetic",pendingPersonalLocks:[retainedLock])
phase(.initial);check(reason()=="unconfigured","initial unconfigured")
check(!audit.active && !audit.recordsContent && audit.snapshot().isEmpty,"original_optional_capture_inactive")
phase(.configure);try transport.configure("https://connection.invalid:8443",username:"synthetic");bindSyntheticSession(.configuredSessionBound)
check(reason()=="signed_out","URL and account settings are not connected")
var held:ConnectionPeer?,finished=false
phase(.signInPeer);requireSyntheticSession();ConnectionPeer.action={held=$0};transport.request("/api/auth/v1/sign-in",method:"POST",body:"{\"username\":\"synthetic\",\"password\":\"SENTINEL_PASSWORD\"}"){_ in finished=true}
check(reason()=="connecting","pending sign-in is amber");awaitValue(.signInPeer){held != nil};held!.reply(200,account,cookie:true);awaitValue(.signInComplete){finished};check(reason()=="verified","genuine current sign-in response")
_ = send(.authSessionForbidden,"/api/auth/v1/session",peer:{$0.reply(403)});check(reason()=="unverified","forbidden administrative session verification is amber, not revocation")
_ = send(.reverify,"/api/runtime/v1/session-context",peer:{$0.reply(200)});check(reason()=="verified","earlier conversation authentication survives forbidden verification")
_ = send(.authSignInForbidden,"/api/auth/v1/sign-in",method:"POST",peer:{$0.reply(403)});check(reason()=="unverified","forbidden sign-in response alone is not a revocation event")
_ = send(.reverify,"/api/runtime/v1/session-context",peer:{$0.reply(200)});check(reason()=="verified","later existing success can refresh already proved authentication")
_ = send(.invalidSession,"/api/auth/v1/session",peer:{$0.reply(200)});check(reason()=="unavailable","invalid successful session body clears indicator authentication knowledge")
_ = send(.unprovenSuccess,"/api/runtime/v1/session-context",peer:{$0.reply(200)});check(reason()=="unavailable","ordinary success cannot authenticate after invalid session evidence")
_ = send(.reauthenticate,"/api/auth/v1/sign-in",method:"POST",peer:{$0.reply(200,account,cookie:true)});check(reason()=="verified","only a validated authenticated response reestablishes proof")
_ = send(.loss,"/api/runtime/v1/session-context",peer:{$0.fail()});check(reason()=="network_unavailable","loss observed by transport")
phase(.retryPeer);requireSyntheticSession();ConnectionPeer.action={held=$0};held=nil;finished=false;transport.request("/api/runtime/v1/session-context"){_ in finished=true};check(reason()=="connecting","retry is amber");awaitValue(.retryPeer){held != nil};held!.reply(200);awaitValue(.retryComplete){finished};check(reason()=="verified","successful authenticated retry")
phase(.freshness);now=131;check(reason()=="verification_expired","idle connection does not stay green forever")
_ = send(.reverify,"/api/runtime/v1/session-context",peer:{$0.reply(200)});check(reason()=="verified","existing successful request re-verifies")
_ = send(.privacyDenied,"/api/runtime/v1/session-context",peer:{$0.reply(403)});check(reason()=="verified","permission/privacy failure is not authentication failure")
_ = send(.sessionExpired,"/api/runtime/v1/session-context",peer:{$0.reply(401)});check(reason()=="authentication_required","runtime authentication failure")
_ = send(.unauthenticatedReachable,"/api/runtime/v1/session-context",peer:{$0.reply(200)});check(reason()=="authentication_required","reachability cannot manufacture authentication")
_ = send(.signInDenied,"/api/auth/v1/sign-in",method:"POST",peer:{$0.reply(403)});check(reason()=="unverified","forbidden verification does not grant new authentication")
_ = send(.unprovenSuccess,"/api/runtime/v1/session-context",peer:{$0.reply(200)});check(reason()=="unverified","403 and ordinary success cannot authenticate after401")
_ = send(.reauthenticate,"/api/auth/v1/sign-in",method:"POST",peer:{$0.reply(200,account,cookie:true)});check(reason()=="verified","authentication restored")
phase(.socketTraffic);let traffic=suspendedSocket();now+=20;transport.receivedSocketMessage(traffic);now+=20;check(reason()=="verified","genuine current socket traffic keeps a long stream fresh")
transport.urlSession(transport.session,webSocketTask:traffic,didCloseWith:.normalClosure,reason:nil);now+=11;transport.receivedSocketMessage(traffic);check(reason()=="verification_expired","a closed socket cannot refresh connection evidence")
_ = send(.reverify,"/api/runtime/v1/session-context",peer:{$0.reply(200)})
phase(.socketNormal);let socket=suspendedSocket();transport.urlSession(transport.session,webSocketTask:socket,didCloseWith:.normalClosure,reason:nil);check(reason()=="verified","stopping microphone socket does not imply loss")
phase(.socketAbnormal);let broken=suspendedSocket();transport.urlSession(transport.session,webSocketTask:broken,didCloseWith:.abnormalClosure,reason:nil);check(reason()=="network_unavailable","abnormal current socket close")
phase(.oldPeer);requireSyntheticSession();ConnectionPeer.action={held=$0};held=nil;finished=false;transport.request("/api/auth/v1/session"){_ in finished=true};awaitValue(.oldPeer){held != nil};let old=held!
phase(.switchOrigin);try transport.configure("https://replacement.invalid:8443",username:"synthetic");bindSyntheticSession(.replacementSessionBound);old.reply(200,account);awaitValue(.oldComplete){finished};check(reason()=="signed_out","late old-origin reply cannot restore green")
_ = send(.replacementSignIn,"/api/auth/v1/sign-in",method:"POST",peer:{$0.reply(200,account,cookie:true)})
var restoreBindingArmed=false,restoreBindings=0
store.afterLoad={
    guard restoreBindingArmed else{return};restoreBindingArmed=false
    bindSyntheticSession(.restoreSessionBound);restoreBindings+=1;requireSyntheticSession()
}
phase(.restoreStarting);ConnectionPeer.action={held=$0};held=nil;finished=false;restoreBindingArmed=true
transport.restoreSession{_ in finished=true}
check(!restoreBindingArmed && restoreBindings==1,"restore_reset_bound_synchronously_before_request")
check(reason()=="restoring","saved cookie restore is amber until actual response");awaitValue(.restorePeer){held != nil};held!.reply(200,account);awaitValue(.restoreComplete){finished};check(reason()=="verified","genuine saved session response")
store.afterLoad=nil
_ = send(.signOut,"/api/auth/v1/sign-out",method:"POST",peer:{$0.reply(200)});phase(.forget);try transport.forgetSession();bindSyntheticSession(.forgottenSessionBound);check(reason()=="signed_out","sign-out")
for value in observations {check(Set(value.keys)==["schemaVersion","state","reason","revision"],"closed data-only bridge shape");let text=String(data:try! JSONSerialization.data(withJSONObject:value),encoding:.utf8)!;check(!text.contains("SENTINEL") && !text.contains("connection.invalid") && !text.contains("synthetic"),"no credential or private content in state")}
check(rejectedRequests==0 && peerRequests>0 && sessionBindings==4,"all_expected_requests_and_session_generations_intercepted")
check(store.value?.pendingPersonalLocks?.count==1 && store.value?.pendingPersonalLocks?.first?.body==retainedLock.body,"original_pending_personal_lock_preserved_through_configure_restore_forget")
check(!audit.active && !audit.recordsContent && audit.snapshot().isEmpty,"connection_observations_never_enable_original_optional_capture")
transport.session.invalidateAndCancel();phase(.done);record("completed")
print("native connection lifecycle passed; intercepted HTTP only; socket tasks never resumed; no device/audio/backend")
