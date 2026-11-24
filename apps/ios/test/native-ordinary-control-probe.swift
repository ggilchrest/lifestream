import Foundation
import CryptoKit
import AssistantCore

// Synthetic external SDK substitute. The real host/factory/ledger/transport are used.
final class HealthKitCollector { func pause(enrollment: UUID) throws {} }
final class Store: ConnectionStore { var value: SavedConnection?;func load()throws->SavedConnection?{value};func save(_ v:SavedConnection)throws{value=v} }
final class Disk: HealthSnapshotStorage { var bytes:Data?;var failRead=false;func read()throws->Data?{if failRead{throw CocoaError(.fileReadNoPermission)};return bytes};func replace(_ value:Data)throws{bytes=value} }
final class Witness: MobileControlSettlementWitness {
 var value:MobileControlSettlementLedger.WitnessValue?;var failAfter=false
 func current(serverDigest:String,principal:UUID)throws->MobileControlSettlementLedger.WitnessValue?{value}
 func compareAndAdvance(serverDigest:String,principal:UUID,expected:MobileControlSettlementLedger.WitnessValue,next:MobileControlSettlementLedger.WitnessValue)throws->Bool{guard value==expected else{return false};value=next;if failAfter{throw CocoaError(.fileWriteUnknown)};return true}
}
final class Lease:MobileControlExclusiveLease {
 let lock:NSRecursiveLock;let onRelease:()->Void;var valid=true,released=false,checks=0;init(_ lock:NSRecursiveLock,_ onRelease:@escaping()->Void){self.lock=lock;self.onRelease=onRelease}
 func withFence<T>(_ body:()throws->T)throws->T{lock.lock();defer{lock.unlock()};return try body()}
 func isCurrent(serverDigest:String,principal:UUID)->Bool{checks += 1;if mode=="lease-before" && checks>=5{valid=false};return valid}
 func release(){lock.lock();defer{lock.unlock()};if !released{released=true;valid=false;onRelease()}}
}
var currentLease: Lease?
final class Exclusion:MobileControlExclusivity {
 let lock=NSRecursiveLock();var allowed=true,active=false
 func acquire(serverDigest:String,principal:UUID)throws->(any MobileControlExclusiveLease)?{lock.lock();defer{lock.unlock()};guard allowed && !active else{return nil};active=true;let next=Lease(lock){self.active=false};currentLease=next;return next}
}
func check(_ value:@autoclosure ()->Bool,_ text:String){if !value(){fputs("FAIL: \(text)\n",stderr);exit(1)}}
func bytes(_ value:Any)throws->Data{try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes])}
func body(_ request:URLRequest)->Data {if let data=request.httpBody{return data};guard let s=request.httpBodyStream else{return Data()};s.open();defer{s.close()};var result=Data(),b=[UInt8](repeating:0,count:4096);while s.hasBytesAvailable{let n=s.read(&b,maxLength:b.count);if n<=0{break};result.append(b,count:n)};return result}
let mode=CommandLine.arguments[1],human="00000000-0000-4000-8000-000000000002",endpoint="00000000-0000-4000-8000-000000000003",session="00000000-0000-4000-8000-000000000006"
let fixture=try! JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:ProcessInfo.processInfo.environment["ORDINARY_VECTORS"]!))) as! [String:Any]
let vectors=fixture["vectors"] as! [[String:Any]]
let previewAssistant="00000000-0000-4000-8000-000000000008",previewEnrollment="00000000-0000-4000-8000-000000000004",previewNamespace="00000000-0000-4000-8000-000000000005",previewOp="00000000-0000-4000-8000-000000000017",previewDigest=String(repeating:"a",count:64)
let previewQuery:[String:Any]=["enrollmentId":previewEnrollment,"assistantId":previewAssistant,"startAt":"2026-10-29T00:00:00Z","endAt":"2026-10-30T00:00:00Z"],previewChange:[String:Any]=["kind":"select","choiceDigest":previewDigest]
let previewPayload:[String:Any]=["schemaVersion":"1.0.0","operation":"preview","operationId":previewOp,"query":previewQuery,"expectedSourceRevision":1,"expectedInterpretationRevision":0,"change":previewChange]
let previewTarget:[String:Any]=["scope":["principalId":human,"collector":"healthKit","sourceNamespace":previewNamespace],"endpointId":endpoint,"enrollmentId":previewEnrollment,"assistantId":previewAssistant]
let previewConfig:[String:Any]=["categories":["SleepSegment"],"uses":["answers"],"assistantIds":[previewAssistant],"collectionPaused":false,"usePaused":false]
let previewOriginal:[String:Any]=["schemaVersion":"1.0.0","operationId":previewOp,"target":["principalId":human,"endpointId":endpoint,"collector":"healthKit","enrollmentId":previewEnrollment,"sourceNamespace":previewNamespace,"expectedRevision":1],"action":["kind":"configure","state":"active","configuration":previewConfig]]
let previewSummary:[String:Any]=["algorithmVersion":"sleep-union/1","timeBasis":"elapsedUTC","coverage":"unknown","totalAsleepMs":NSNull(),"sessions":[],"excludedNonSleepRecords":0,"excludedNonOverlappingSleepRecords":0,"deduplication":"same-source-interval-union","limitations":[]]
let previewProvenance:[String:Any]=["datasetDigest":previewDigest,"policyBindingDigest":previewDigest,"sourceSafetyEpoch":0,"records":[],"readState":"boundedComplete","timeBasis":"elapsedUTC","limitations":[]]
let previewResult:[String:Any]=["state":"ready","operationId":previewOp,"query":previewQuery,"target":previewTarget,"sourceRevision":1,"interpretationRevision":0,"nextInterpretationRevision":1,"change":previewChange,"beforeChoiceDigest":NSNull(),"afterChoiceDigest":previewDigest,"before":previewSummary,"after":previewSummary,"provenance":previewProvenance,"reviewDigest":previewDigest,"controlOriginal":previewOriginal,"limitations":[]]
let previewResponse:[String:Any]=["schemaVersion":"1.0.0","producerPin":["schemaId":"https://lifestream.dev/contracts/mobile-context-interpretation/1.0.0","schemaVersion":"1.0.0","digest":"5ed2ee913fc647ba453be4be302f5701e0d6f3c3072d76a7c49c2736048ee141"],"result":previewResult]
var unexpected=0,controls=0,reconciles=0
var launchLegacy:(()->Void)?
var actualHuman=human,actualSession=session,actualEndpoint=endpoint
final class Offline:URLProtocol {
 override class func canInit(with request:URLRequest)->Bool{true}
 override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
 override func startLoading(){DispatchQueue.main.async{[self] in
  guard request.url?.host=="offline.invalid" else{unexpected += 1;client?.urlProtocol(self,didFailWithError:URLError(.unsupportedURL));return}
  let path=request.url?.path ?? "";let requestBytes = path == "/api/runtime/v1/mobile-context" ? body(request) : Data();var output:[String:Any];var shouldCancel=false
  if path=="/api/auth/v1/user-context" {
   output=["producerPin":["schemaId":"https://lifestream.dev/contracts/effective-subject/1.0.0","schemaVersion":"1.0.0","digest":"ed098cad970a310a807881ea7a833b96f1c980e8377ee3cfcbdffd68f2bd0cf9"],"contextRef":"synthetic","context":["schemaVersion":"1.0.0","actorId":actualHuman,"effectiveUserId":actualHuman,"authenticatedSessionId":actualSession,"installationId":"00000000-0000-4000-8000-000000000007","authorityRevision":1,"generation":1,"issuedAt":"2026-10-30T00:00:00Z"],"actor":["principalId":actualHuman],"effectiveUser":["principalId":actualHuman],"impersonating":false]
  } else if path=="/api/runtime/v1/session-context" {output=["ended":false,"revision":1,"contextGeneration":1,"endpoint":["endpointId":actualEndpoint,"privacyClass":"personal","configurationRevision":1]]}
  else if path=="/api/runtime/v1/mobile-context",let decoded=try? JSONSerialization.jsonObject(with:requestBytes) as? [String:Any],decoded["operation"] as? String == "interpretation",let payload=decoded["payload"] as? [String:Any],payload["operation"] as? String == "preview" {output=previewResponse}
  else if path=="/api/runtime/v1/mobile-context",let incoming=try? JSONSerialization.jsonObject(with:requestBytes) as? [String:Any],let operation=incoming["operation"] as? String,let payload=incoming["payload"] as? [String:Any],let operationId=payload["operationId"] as? String,let vector=vectors.first(where:{(($0["request"] as? [String:Any])?["operationId"] as? String)==operationId && ($0["case"] as? String)?.hasSuffix("-applied")==true}),let response=vector["response"] as? [String:Any] {
   if operation=="control" {controls += 1;if mode.hasPrefix("legacy-") && mode.hasSuffix("-held") {DispatchQueue.main.async {launchLegacy?()};return};if mode=="lost" && controls==1 {client?.urlProtocol(self,didFailWithError:URLError(.networkConnectionLost));return};var copy=response;var result=copy["result"] as! [String:Any];result=["kind":"observed","control":result["control"]!];copy["result"]=result;output=copy}
   else if operation=="reconcile" {
    reconciles += 1
    if mode=="cancel" && reconciles==1 {shouldCancel=true}
    if mode=="epoch" {transport.epoch += 1};if mode=="origin" {transport.endpoint=URL(string:"https://changed.invalid")!};if mode=="principal" {actualHuman="00000000-0000-4000-8000-000000000099"};if mode=="session" {actualSession="00000000-0000-4000-8000-000000000098"};if mode=="endpoint" {actualEndpoint="00000000-0000-4000-8000-000000000097"};if mode=="lease" {currentLease?.valid=false}
    if mode=="unknown" {output=["schemaVersion":"1.0.0","producerPin":fixture["producerPin"]!,"result":["kind":"held","reason":"unknown"]]}
    else if mode=="observed" {var copy=response;let result=copy["result"] as! [String:Any];copy["result"]=["kind":"observed","control":result["control"]!];output=copy}
    else {output=mode=="wrong" ? vectors[2]["response"] as! [String:Any] : response}
   }
   else{unexpected += 1;client?.urlProtocol(self,didFailWithError:URLError(.unsupportedURL));return}
  } else {unexpected += 1;client?.urlProtocol(self,didFailWithError:URLError(.unsupportedURL));return}
  let data=try! bytes(output),url=request.url!,response=HTTPURLResponse(url:url,statusCode:200,httpVersion:nil,headerFields:nil)!
  let respond = { [self] in client?.urlProtocol(self,didReceive:response,cacheStoragePolicy:.notAllowed);client?.urlProtocol(self,didLoad:data);client?.urlProtocolDidFinishLoading(self) }
  if shouldCancel {DispatchQueue.main.async {
   owner.cancel()
   check(currentLease?.valid == true && exclusion.active,"cancel keeps actual lease until callback drains")
   owner.applyOrdinaryWithLedger(original:try! bytes(vectors[0]["request"]!),proof:nil,ledger:ledger){ result in
    guard case .failure(NativeMobileControlOwner.Failure.busy)=result else {check(false,"cancelled owner stays busy");return}
   }
   check((try? exclusion.acquire(serverDigest:digest,principal:UUID(uuidString:human)!)) == nil,"another owner cannot acquire while callback outstanding")
   check(controls==1 && (try? ledger.pendingOrdinary(scope:scope)) != nil,"cancel retains original without a second control")
   respond()
  }} else {respond()}
 }}
 override func stopLoading(){}
}
let disk=Disk(),legacy=Disk(),witness=Witness(),exclusion=Exclusion();disk.bytes=try! MobileControlSettlementLedger.genesisBytes();witness.value=try! MobileControlSettlementLedger.genesisWitness()
let transport=NativeTransport(store:Store());try! transport.configure("https://offline.invalid",username:"synthetic")
let cfg=URLSessionConfiguration.ephemeral;cfg.protocolClasses=[Offline.self];transport.session=URLSession(configuration:cfg,delegate:transport,delegateQueue:OperationQueue.main)
let digest=SHA256.hash(data:Data("https://offline.invalid".utf8)).map{String(format:"%02x",$0)}.joined()
let scope=MobileControlSettlementLedger.Scope(serverDigest:digest,principal:UUID(uuidString:human)!,endpoint:UUID(uuidString:endpoint)!,session:UUID(uuidString:session)!)
let ledger=MobileControlSettlementLedger(storage:disk,witness:witness),upgrade=try! exclusion.acquire(serverDigest:digest,principal:UUID(uuidString:human)!)!
try! ledger.upgradeQualifiedV1(scope:scope,authenticatedInterpretationResponse:nil,lease:upgrade);upgrade.release()
if mode == "emit-v2" {
 let dir=URL(fileURLWithPath:ProcessInfo.processInfo.environment["OLD_READER_FIXTURE"]!,isDirectory:true)
 try! disk.bytes!.write(to:dir.appendingPathComponent("v2.json"))
 let value=witness.value!;let meta:[String:Any]=["epoch":value.epoch,"digest":value.digest,"serverDigest":digest,"principal":human,"endpoint":endpoint,"session":session]
 try! bytes(meta).write(to:dir.appendingPathComponent("witness.json"));print("emit-v2 passed");exit(0)
}
if mode=="denied" {exclusion.allowed=false};if mode=="legacy" {legacy.bytes=Data([1])};if mode=="legacy-error" {legacy.failRead=true};if mode=="cas-unknown" {witness.failAfter=true}
let heldLease: (any MobileControlExclusiveLease)? = mode=="contention" ? try! exclusion.acquire(serverDigest:digest,principal:UUID(uuidString:human)!) : nil
let hostExclusion:any MobileControlExclusivity = mode.hasSuffix("-unavailable") ? UnavailableMobileControlExclusivity() : exclusion
let owner=NativeMobileControlOwner(transport:transport,storage:legacy,exclusivity:hostExclusion,restrict:{_ in})
let config:[String:Any]=["categories":["SleepSegment"],"uses":["answers"],"assistantIds":[],"collectionPaused":false,"usePaused":false]
let enrollment:[String:Any]=["enrollmentId":"00000000-0000-4000-8000-000000000004","principalId":human,"endpointId":endpoint,"collector":"healthKit","sourceNamespace":"00000000-0000-4000-8000-000000000005","revision":1,"state":"active","configuration":config]
let effective:[String:Any]=["policyRevision":1,"sourceBound":true,"collectionAllowed":true,"categories":["SleepSegment"],"uses":["answers"],"assistantIds":[],"sourceNamespace":"00000000-0000-4000-8000-000000000005"]
let p:[String:Any]=["schemaVersion":"1.0.0","producerPin":["schemaId":MobileHealthEncoder.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthEncoder.schemaSHA256],"result":["enrollment":enrollment,"effective":effective]]
let proof=try! MobileHealthPolicyParser.parse(try! bytes(p),expectedPrincipal:UUID(uuidString:human)!,expectedEndpoint:UUID(uuidString:endpoint)!,expectedEnrollment:UUID(uuidString:"00000000-0000-4000-8000-000000000004")!)
func step(_ n:Int){
 if n==3 {check(controls==3 && reconciles==3 && unexpected==0,"sequential offline path");print("\(mode) passed");exit(0)}
 let vector=vectors[n*2],original=try! bytes(vector["request"]!)
 owner.applyOrdinaryWithLedger(original:original,proof:n==2 ? proof:nil,ledger:ledger){ result in
  if mode=="cas-unknown" {guard case .success(.held)=result else{check(false,"ambiguous staging is held");return};check(controls==0,"ambiguous stage not dispatched");do {_ = try ledger.pendingOrdinary(scope:scope);check(false,"poisoned scope must hold")}catch{};print("cas-unknown passed");exit(0)}
  if ["denied","legacy","legacy-error","contention","missing-bundle"].contains(mode) {check((try? result.get())==nil && controls==0 && (try? ledger.pendingOrdinary(scope:scope)) == nil,"deny before dispatch");heldLease?.release();print("\(mode) passed");exit(0)}
  guard case .success(.held)=result else{check(false,"direct result observed only");return}
  check((try? ledger.pendingOrdinary(scope:scope)) == original,"intent retained before reconciliation")
  if mode=="lease-before" {check(controls==0,"lost lease blocks dispatch");print("lease-before passed");exit(0)}
  func reconcile() {
   owner.reconcileOrdinaryWithLedger(ledger:ledger){ result in
    if ["wrong","epoch","origin","principal","session","endpoint","lease","unknown","observed","cancel"].contains(mode) {
     guard case .success(.held)=result else{check(false,"uncertain result held");return}
     check((try? ledger.pendingOrdinary(scope:scope)) == original && unexpected==0,"uncertain original retained")
     if mode=="cancel" {
      DispatchQueue.main.asyncAfter(deadline:.now()+0.15){
       check((try? ledger.pendingOrdinary(scope:scope)) == original,"late response cannot settle cancelled operation")
       owner.applyOrdinaryWithLedger(original:original,proof:nil,ledger:ledger){ repeated in
        guard case .success(.held)=repeated else{check(false,"repeated cancelled apply held");return}
        check(controls==1 && (try? ledger.pendingOrdinary(scope:scope)) == original,"cancelled repeat cannot issue second control")
        owner.reconcileOrdinaryWithLedger(ledger:ledger){ final in
         guard case .success(.applied)=final else{check(false,"cancelled original reconciles");return}
         check(controls==1 && reconciles==2 && unexpected==0,"cancelled original settled only by reconciliation")
         print("cancel passed");exit(0)
        }
       }
      };return
     }
     print("\(mode) passed");exit(0)
    }
    guard case .success(.applied)=result else{check(false,"terminal applied");return}
    if mode=="lost" {check(n==0 && controls==1 && reconciles==1 && unexpected==0,"lost response reconciled");print("lost passed");exit(0)}
    step(n+1)
   }
  }
  if mode=="lost" {
   owner.applyOrdinaryWithLedger(original:original,proof:nil,ledger:ledger){ repeated in
    guard case .success(.held)=repeated else{check(false,"repeated lost apply held");return}
    check(controls==1 && (try? ledger.pendingOrdinary(scope:scope)) == original,"lost response repeat cannot issue second control")
    reconcile()
   }
  } else {reconcile()}
 }
}
transport.request("/api/auth/v1/user-context"){ result in
 check((try? result.get()) != nil && transport.effectiveIsSelf,"synthetic auth")
 func executeLegacy() {
  let before=controls
  if mode.hasPrefix("legacy-apply-") {
   owner.apply(original:try! bytes(vectors[0]["request"]!),proof:nil){ result in
    check(legacy.bytes==nil && controls==before && unexpected==0,"legacy apply must not write or dispatch")
    guard case .failure = result else{check(false,"legacy apply unavailable");return};heldLease?.release();print("\(mode) passed");exit(0)
   };return
  }
  if mode.hasPrefix("legacy-interpretation-") {
   owner.readInterpretation(payload:try! bytes(previewPayload)){ result in
    guard case .success(let read)=result,let reviewed=read.reviewedPreview else{check(false,"synthetic preview");return}
    owner.applyInterpretation(preview:reviewed,proof:proof){ result in
     check(legacy.bytes==nil && controls==before && unexpected==0,"legacy interpretation must not write or dispatch")
     guard case .failure = result else{check(false,"legacy interpretation unavailable");return};heldLease?.release();print("\(mode) passed");exit(0)
    }
   };return
  }
 }
 if mode.hasPrefix("legacy-apply-") || mode.hasPrefix("legacy-interpretation-") {
  if mode.hasSuffix("-held") {
   let blocker=NativeMobileControlOwner(transport:transport,storage:legacy,exclusivity:exclusion,restrict:{_ in})
   launchLegacy={check(controls==1 && currentLease?.valid == true,"first actual host holds lease");executeLegacy()}
   blocker.applyOrdinaryWithLedger(original:try! bytes(vectors[0]["request"]!),proof:nil,ledger:ledger){ _ in check(false,"blocker should stay pending") }
  } else {executeLegacy()};return
 }
 step(0)
}
DispatchQueue.main.asyncAfter(deadline:.now()+12){fputs("timeout \(mode)\n",stderr);exit(3)}
RunLoop.main.run()
