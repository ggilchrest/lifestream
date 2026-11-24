import Foundation
import CoreFoundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Disposable loopback-only fixture adapter; never register in a production bridge.
/// An injected context is not authentication evidence. Credentials are never logged.
final class MobileControlFixtureLoopback {
 enum Failure:Error {case invalid,currentness,unavailable,oversized}
 private final class ResultBox: @unchecked Sendable {
  let lock=NSLock();var response:(Data,HTTPURLResponse)?;var error:Error?
  func set(_ data:Data?,_ response:URLResponse?,_ error:Error?){lock.lock();defer{lock.unlock()};if let data,let http=response as? HTTPURLResponse{self.response=(data,http)};self.error=error}
  func get()->((Data,HTTPURLResponse)?,Error?){lock.lock();defer{lock.unlock()};return (response,error)}
 }
 private final class NoRedirect:NSObject,URLSessionTaskDelegate,@unchecked Sendable {
  func urlSession(_ session:URLSession,task:URLSessionTask,willPerformHTTPRedirection response:HTTPURLResponse,newRequest request:URLRequest,completionHandler:@escaping(URLRequest?)->Void){completionHandler(nil)}
 }
 private struct VerifiedSnapshot:Equatable {let subject:Data,contextGeneration:Int,endpointRevision:Int}
 private let origin:URL,headers:[String:String],current:()->MobileControlFixtureHost.Context?
 init(origin:URL,headers:[String:String],current:@escaping()->MobileControlFixtureHost.Context?)throws {
  guard origin.scheme=="http",origin.host=="127.0.0.1",let port=origin.port,(1...65535).contains(port),origin.user==nil,origin.password==nil,origin.query==nil,origin.fragment==nil,["","/"].contains(origin.path) else{throw Failure.invalid}
  let allowed:Set<String>=["cookie","x-lifestream-csrf","x-lifestream-user-context"]
  guard Set(headers.keys).isSubset(of:allowed),headers.values.allSatisfy({!$0.isEmpty && $0.utf8.count<=4096 && !$0.contains("\r") && !$0.contains("\n")}) else{throw Failure.invalid}
  self.origin=origin;self.headers=headers;self.current=current
 }
 private func request(path:String,method:String,body:Data?,expected:MobileControlFixtureHost.Context,timeout:TimeInterval)throws->(status:Int,body:Data) {
  guard expected.ordinarySelf,current()==expected else{throw Failure.currentness}
  guard ["/api/auth/v1/user-context","/api/runtime/v1/session-context","/api/runtime/v1/mobile-context"].contains(path),timeout>0,timeout<=15 else{throw Failure.invalid}
  let target=origin.appendingPathComponent(String(path.dropFirst())),delegate=NoRedirect(),configuration=URLSessionConfiguration.ephemeral
  configuration.timeoutIntervalForRequest=timeout;configuration.timeoutIntervalForResource=timeout;configuration.httpShouldSetCookies=false;configuration.urlCache=nil;configuration.connectionProxyDictionary=[:]
  let queue=OperationQueue();queue.maxConcurrentOperationCount=1
  let session=URLSession(configuration:configuration,delegate:delegate,delegateQueue:queue),signal=DispatchSemaphore(value:0),box=ResultBox()
  var request=URLRequest(url:target);request.httpMethod=method;request.httpBody=body;request.setValue("application/json",forHTTPHeaderField:"Content-Type");request.setValue(origin.absoluteString.trimmingCharacters(in:CharacterSet(charactersIn:"/")),forHTTPHeaderField:"Origin")
  for (key,value) in headers where path != "/api/auth/v1/user-context" || key != "x-lifestream-user-context" {request.setValue(value,forHTTPHeaderField:key)}
  let task=session.dataTask(with:request){data,response,error in box.set(data,response,error);signal.signal()};task.resume()
  guard signal.wait(timeout:.now()+timeout+1) == .success else{task.cancel();session.invalidateAndCancel();throw Failure.unavailable}
  session.finishTasksAndInvalidate();guard current()==expected else{throw Failure.currentness}
  let (result,error)=box.get();guard error==nil,let (data,http)=result else{throw Failure.unavailable};guard data.count<=65536 else{throw Failure.oversized}
  return (http.statusCode,data)
 }
 func exchange(_ body:Data,expected:MobileControlFixtureHost.Context,timeout:TimeInterval=10)throws->(status:Int,body:Data) {
  guard !body.isEmpty,body.count<=65536,let obj=try? JSONSerialization.jsonObject(with:body) as? [String:Any],let op=obj["operation"] as? String,["control","reconcileControl"].contains(op) else{throw Failure.invalid}
  return try request(path:"/api/runtime/v1/mobile-context",method:"POST",body:body,expected:expected,timeout:timeout)
 }
 private func verify(expected:MobileControlFixtureHost.Context,timeout:TimeInterval)throws->VerifiedSnapshot {
  let auth=try request(path:"/api/auth/v1/user-context",method:"GET",body:nil,expected:expected,timeout:timeout)
  guard auth.status==200,let a=try? JSONSerialization.jsonObject(with:auth.body) as? [String:Any],let pin=a["producerPin"] as? [String:String],pin==["schemaId":"https://lifestream.dev/contracts/effective-subject/1.0.0","schemaVersion":"1.0.0","digest":"ed098cad970a310a807881ea7a833b96f1c980e8377ee3cfcbdffd68f2bd0cf9"],let c=a["context"] as? [String:Any],Set(c.keys)==Set(["schemaVersion","actorId","effectiveUserId","authenticatedSessionId","installationId","authorityRevision","generation","issuedAt"]),c["schemaVersion"] as? String == "1.0.0",let actor=a["actor"] as? [String:Any],let effective=a["effectiveUser"] as? [String:Any],let impersonating=a["impersonating"] as? NSNumber,CFGetTypeID(impersonating)==CFBooleanGetTypeID(),!impersonating.boolValue,a["contextRef"] as? String == headers["x-lifestream-user-context"],let expectedRef=headers["x-lifestream-user-context"],!expectedRef.isEmpty else{throw Failure.currentness}
  let principal=expected.scope.principal.uuidString.lowercased(),sessionId=expected.scope.session.uuidString.lowercased()
  guard c["actorId"] as? String == principal,c["effectiveUserId"] as? String == principal,actor["principalId"] as? String == principal,effective["principalId"] as? String == principal,c["authenticatedSessionId"] as? String == sessionId,MobileControlOriginal.uuid(c["installationId"]) != nil,MobileControlOriginal.number(c["authorityRevision"],min:0,max:9007199254740991) != nil,MobileControlOriginal.number(c["generation"],min:0,max:9007199254740991) != nil,let issued=c["issuedAt"] as? String,issued.hasSuffix("Z") else{throw Failure.currentness}
  let formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds];if formatter.date(from:issued)==nil {formatter.formatOptions=[.withInternetDateTime];guard formatter.date(from:issued) != nil else{throw Failure.currentness}}
  let session=try request(path:"/api/runtime/v1/session-context",method:"GET",body:nil,expected:expected,timeout:timeout)
  guard session.status==200,let j=try? JSONSerialization.jsonObject(with:session.body) as? [String:Any],let ended=j["ended"] as? NSNumber,CFGetTypeID(ended)==CFBooleanGetTypeID(),!ended.boolValue,MobileControlOriginal.number(j["revision"],min:0,max:9007199254740991)==expected.contextRevision,let generation=MobileControlOriginal.number(j["contextGeneration"],min:0,max:9007199254740991),let endpoint=j["endpoint"] as? [String:Any],MobileControlOriginal.uuid(endpoint["endpointId"])==expected.scope.endpoint,endpoint["privacyClass"] as? String == "personal",let endpointRevision=MobileControlOriginal.number(endpoint["configurationRevision"],min:0,max:9007199254740991),let canonical=try? JSONSerialization.data(withJSONObject:c,options:[.sortedKeys,.withoutEscapingSlashes]) else{throw Failure.currentness}
  return VerifiedSnapshot(subject:canonical,contextGeneration:generation,endpointRevision:endpointRevision)
 }
 func verifyFixtureIdentity(expected:MobileControlFixtureHost.Context,timeout:TimeInterval=10)throws { _ = try verify(expected:expected,timeout:timeout) }
 /// Fixture-only strict policy GET-over-POST; does not enable collection.
 func policyResponseVerified(enrollment:UUID,expected:MobileControlFixtureHost.Context,timeout:TimeInterval=10)throws->Data {
  let before=try verify(expected:expected,timeout:timeout)
  let response=try request(path:"/api/runtime/v1/mobile-context",method:"POST",body:MobileHealthWire.policyRequest(enrollment:enrollment),expected:expected,timeout:timeout)
  let after=try verify(expected:expected,timeout:timeout);guard before==after,response.status==200 else{throw Failure.currentness};return response.body
 }
 func policyVerified(enrollment:UUID,expected:MobileControlFixtureHost.Context,timeout:TimeInterval=10)throws->MobileHealthPolicyProof {
  try MobileHealthPolicyParser.parse(policyResponseVerified(enrollment:enrollment,expected:expected,timeout:timeout),expectedPrincipal:expected.scope.principal,expectedEndpoint:expected.scope.endpoint,expectedEnrollment:enrollment)
 }
 /// Actual Auth owner checks surround the POST; returned bytes are never logged.
 func exchangeVerified(_ body:Data,expected:MobileControlFixtureHost.Context,timeout:TimeInterval=10)throws->(status:Int,body:Data) {
  let before=try verify(expected:expected,timeout:timeout),result=try exchange(body,expected:expected,timeout:timeout),after=try verify(expected:expected,timeout:timeout)
  guard before==after else{throw Failure.currentness};return result
 }
}
