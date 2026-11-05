import Foundation
import AssistantCore

// Only external SDK/storage/HTTP inputs are synthetic. The connection owner,
// Host, Runtime, policy, collector, outbox and callback barriers are production.
let mode=CommandLine.arguments[1],site=CommandLine.arguments.count>2 ? CommandLine.arguments[2]:"default"
func check(_ value:@autoclosure()->Bool,_ message:String){if !value(){fputs("FAIL: \(message)\n",stderr);exit(1)}}
func bytes(_ value:Any)->Data{try! JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes])}
let human=UUID(uuidString:"50000000-0000-4000-8000-000000000001")!,session=UUID(uuidString:"00000000-0000-4000-8000-000000000003")!
let endpoint=UUID(uuidString:"60000000-0000-4000-8000-000000000001")!,enrollment=UUID(uuidString:"00000000-0000-4000-8000-000000000002")!
let namespace=UUID(uuidString:"00000000-0000-4000-8000-000000000004")!,other=UUID(uuidString:"00000000-0000-4000-8000-000000000099")!
let origin="https://offline.invalid",pin=["schemaId":MobileHealthEncoder.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthEncoder.schemaSHA256]
var requests=0,ingests=0,storageFactories=0,sdkFactories=0,factoryArmed=false
var profile:NativeHealthConnectionOwner.Profile?,connection:NativeHealthConnectionOwner?
final class Store:ConnectionStore{var value:SavedConnection?;func load()throws->SavedConnection?{value};func save(_ v:SavedConnection)throws{value=v}}
final class Disk:HealthSnapshotStorage{
    var data:Data?,reads=0,writes=0,failBefore=false,failAfter=false
    func read()throws->Data?{reads+=1;return data}
    func replace(_ value:Data)throws{writes+=1;if failBefore{throw CocoaError(.fileWriteNoPermission)};data=value;if failAfter{throw CocoaError(.fileWriteUnknown)}}
}
final class Query:NativeHealthQuery{func stop(){}}
final class SDK:NativeHealthSDK{
    var available:Bool{true};var permissions=0,queries=0
    func prepareReadAuthorization(types:Set<String>)->NativeHealthAuthorizationDelegate?{
        check(types==["sleep"],"only explicitly configured type reaches SDK")
        return {done in self.permissions+=1;DispatchQueue.main.async{done(.success(()))}}
    }
    func query(plan:NativeHealthCollectionPlan,anchor:Data?,completion:@escaping(Result<NativeHealthPage,Error>)->Void)throws->any NativeHealthQuery{
        queries+=1;check(plan==testPlan,"exact immutable plan reaches original query")
        DispatchQueue.main.async{completion(.success(.init(observations:[],deleted:["synthetic-deletion"],anchor:Data([1]),mayHaveMore:false)))}
        return Query()
    }
}
let disk=Disk(),sdk=SDK(),transport=NativeTransport(store:Store())
let testPlan=NativeHealthCollectionPlan(category:"sleep",scope:"synthetic-test-window",mappingVersion:"healthkit-v1",start:Date(timeIntervalSince1970:1793318400),end:Date(timeIntervalSince1970:1793404800))
func configuration(_ mutation:String="")->NativeHealthRuntime.Configuration{
    let configuredOrigin=mutation=="origin" ? "https://different.invalid":origin
    let plan=mutation=="plan" ? NativeHealthCollectionPlan(category:"sleep",scope:"invalid",mappingVersion:"healthkit-v1",start:testPlan.end,end:testPlan.start):testPlan
    return .init(provenance:"synthetic-original-native-profile",origin:configuredOrigin,human:mutation=="human" ? other:human,session:mutation=="session" ? other:session,endpoint:mutation=="endpoint" ? other:endpoint,enrollment:enrollment,plans:[plan],maxBytes:8*1024*1024,maxEvents:100_000,storageOrigin:configuredOrigin,protectedFilePolicy:"synthetic-external-storage",protectedAvailable:{true},makeStorage:{
        storageFactories+=1;if factoryArmed && site=="storage"{profile?.revoke()};return disk
    },makeSDK:{sdkFactories+=1;if factoryArmed && site=="SDK"{profile?.revoke()};return sdk})
}
func descriptor(_ mutation:String="")->NativeHealthSetupDescriptor{
    .init(selector:"original",revision:1,title:mutation=="label" ? "":"Synthetic approved source",destinationLabel:"Synthetic private destination",namespace:namespace,configuration:configuration(mutation))
}
func requestBody(_ request:URLRequest)->Data{
    if let data=request.httpBody{return data};guard let stream=request.httpBodyStream else{return Data()};stream.open();defer{stream.close()}
    var data=Data(),buffer=[UInt8](repeating:0,count:4096)
    while stream.hasBytesAvailable{let n=stream.read(&buffer,maxLength:buffer.count);if n<=0{break};data.append(buffer,count:n)};return data
}
let selected:[String:Any]=["categories":["SleepSegment"],"uses":[],"assistantIds":[],"collectionPaused":false,"usePaused":false]
func row()->[String:Any]{
    ["enrollmentId":mode=="connection-source" && site=="enrollment" ? other.uuidString.lowercased():enrollment.uuidString.lowercased(),"principalId":human.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"collector":"healthKit","sourceNamespace":mode=="connection-source" && site=="namespace" ? other.uuidString.lowercased():namespace.uuidString.lowercased(),"revision":1,"state":mode=="connection-source" && site=="inactive" ? "disconnected":"active","configuration":selected]
}
final class Offline:URLProtocol{
    override class func canInit(with request:URLRequest)->Bool{true}
    override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
    override func startLoading(){DispatchQueue.main.async{[self] in
        requests+=1;check(request.url?.host=="offline.invalid","only original synthetic origin requested")
        let object:[String:Any]
        switch request.url!.path{
        case "/api/auth/v1/session":object=["csrfToken":"synthetic-csrf"]
        case "/api/auth/v1/user-context":object=["producerPin":["schemaId":"https://lifestream.dev/contracts/effective-subject/1.0.0","schemaVersion":"1.0.0","digest":"ed098cad970a310a807881ea7a833b96f1c980e8377ee3cfcbdffd68f2bd0cf9"],"contextRef":"synthetic-current","context":["schemaVersion":"1.0.0","actorId":human.uuidString.lowercased(),"effectiveUserId":human.uuidString.lowercased(),"authenticatedSessionId":session.uuidString.lowercased(),"installationId":"00000000-0000-4000-8000-000000000009","authorityRevision":1,"generation":1,"issuedAt":"2026-10-30T00:00:00Z"],"actor":["principalId":human.uuidString.lowercased()],"effectiveUser":["principalId":human.uuidString.lowercased()],"impersonating":false]
        case "/api/runtime/v1/session-context":object=["ended":false,"revision":1,"contextGeneration":1,"endpoint":["endpointId":endpoint.uuidString.lowercased(),"privacyClass":"personal","configurationRevision":1]]
        case "/api/runtime/v1/mobile-context":
            check(request.httpMethod=="POST" && request.value(forHTTPHeaderField:"x-lifestream-csrf")=="synthetic-csrf","existing native POST headers")
            let body=try! JSONSerialization.jsonObject(with:requestBody(request)) as! [String:Any],record=row()
            switch body["operation"] as? String{
            case "inventory":object=["schemaVersion":"1.0.0","producerPin":["schemaId":MobileHealthInventory.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthInventory.schemaSHA256],"result":["principalId":human.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"sources":[["sourceNamespace":record["sourceNamespace"]!,"collector":"healthKit","policyRevision":1,"configuration":selected,"enrollmentCount":1,"currentEndpointEnrollment":record,"coverage":["state":"unknown"]]],"unboundEnrollments":[],"nextCursor":NSNull()]]
            case "policy":object=["schemaVersion":"1.0.0","producerPin":pin,"result":["enrollment":record,"effective":["policyRevision":1,"sourceBound":true,"collectionAllowed":true,"categories":["SleepSegment"],"uses":[],"assistantIds":[],"sourceNamespace":namespace.uuidString.lowercased()]]]
            case "ingest":
                ingests+=1;let payload=body["payload"] as! [String:Any],changes=payload["changes"] as! [[String:Any]]
                object=["schemaVersion":"1.0.0","producerPin":pin,"result":changes.map{["eventId":$0["eventId"]!,"outcome":"accepted","code":"deleted"]}]
            default:check(false,"no new operation or enrollment path");return
            }
        default:check(false,"no unrelated HTTP path");return
        }
        client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:bytes(object));client?.urlProtocolDidFinishLoading(self)
    }}
    override func stopLoading(){}
}
@MainActor func load(_ host:NativeHealthHost) async->[String:Any]{await withCheckedContinuation{c in host.loadSetupChoices{c.resume(returning:$0)}}}
@MainActor func perform(_ kind:NativeHealthChoiceAction.Kind,_ input:[String:Any],_ host:NativeHealthHost) async->[String:Any]{await withCheckedContinuation{c in host.performChoice(kind,input:input){c.resume(returning:$0)}}}
func inputs(_ catalog:[String:Any])->([String:Any],[String:Any]){
    check(catalog["state"] as? String=="available","original Host returns eligible catalog")
    let choices=catalog["choices"] as! [[String:Any]];check(choices.count==1,"one original configured source")
    let choice=choices[0],plans=choice["dataChoices"] as! [[String:Any]]
    let base:[String:Any]=["catalogId":catalog["catalogId"]!,"choice":choice["choice"]!]
    return (base,base.merging(["categoryChoice":plans[0]["categoryChoice"]!]){_,new in new})
}
func untouched(){check(storageFactories==0 && sdkFactories==0 && disk.reads==0 && disk.writes==0 && sdk.permissions==0 && sdk.queries==0 && ingests==0,"no constructor/catalog SDK or persistent effects")}
@MainActor func unavailable(_ host:NativeHealthHost) async{let result=await load(host);check(result["state"] as? String != "available","unavailable cannot expose usable handles")}
@MainActor func run() async{
    try! transport.configure(origin)
    let config=URLSessionConfiguration.ephemeral;config.protocolClasses=[Offline.self];transport.session=URLSession(configuration:config,delegate:transport,delegateQueue:.main)
    _=await withCheckedContinuation{c in transport.request("/api/auth/v1/session"){c.resume(returning:$0)}}
    _=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}}
    let before=requests
    if mode=="connection-invalid-profile"{
        check(NativeHealthConnectionOwner.Profile(descriptor:descriptor("label"))==nil,"invalid labels denied")
        check(NativeHealthConnectionOwner.Profile(descriptor:descriptor("plan"))==nil,"invalid fixed plan denied")
    }
    if !["connection-missing-profile","connection-invalid-profile"].contains(mode){profile=NativeHealthConnectionOwner.Profile(descriptor:descriptor(mode=="connection-context" ? site:""));check(profile != nil,"valid native profile")}
    connection=NativeHealthConnectionOwner(transport:transport,profile:profile);let owner=connection!,host=owner.host
    check(requests==before,"construction invokes no network");untouched()
    if ["connection-missing-profile","connection-invalid-profile"].contains(mode){await unavailable(host);check(requests==before,"missing config invokes no HTTP");untouched();return}
    if mode=="connection-inert"{return}
    if mode=="connection-context" || mode=="connection-source"{await unavailable(host);untouched();return}
    if mode=="connection-revoke"{profile!.revoke();await unavailable(host);check(requests==before,"revoked profile no HTTP");let replacement=NativeHealthConnectionOwner(transport:transport,profile:profile);await unavailable(replacement.host);untouched();return}
    if mode=="connection-bind-once"{
        let second=NativeHealthConnectionOwner(transport:transport,profile:profile)
        await unavailable(second.host);check(requests==before,"same profile cannot create second configured Host")
        second.withdraw(authorityChanged:true)
        check(owner.host === host,"refused connection does not replace original Host")
    }
    let (base,sync)=inputs(await load(host));untouched()
    if mode=="connection-catalog" || mode=="connection-bind-once"{return}
    if mode=="connection-factory-reentry"{factoryArmed=true}
    if mode=="connection-unknown-hold"{disk.failBefore=site=="write-before-throw";disk.failAfter=site=="write-after-throw"}
    if mode=="connection-separate-actions"{let denied=await perform(.permission,base,host);check(denied["requestState"] as? String=="notInvoked","catalog does not authorize OS request");untouched()}
    let prepared=await perform(.setup,base,host)
    if mode=="connection-factory-reentry"{
        check(prepared["setupOutcome"] as? String=="notConfirmed","factory revocation cannot publish preparation")
        check(disk.writes==0 && sdk.permissions==0 && sdk.queries==0,"factory revocation precedes effects")
        let oldStorage=storageFactories,oldSDK=sdkFactories;_ = await perform(.setup,base,host)
        check(storageFactories==oldStorage && sdkFactories==oldSDK,"revoked factory not recreated");return
    }
    if mode=="connection-unknown-hold"{
        check(prepared["setupOutcome"] as? String=="notConfirmed","invoked write uncertainty stays unconfirmed")
        let oldData=disk.data,oldWrites=disk.writes,oldStorage=storageFactories,oldSDK=sdkFactories
        _=await perform(.setup,base,host);let second=NativeHealthConnectionOwner(transport:transport,profile:profile);await unavailable(second.host)
        check(owner.host === host && disk.data==oldData && disk.writes==oldWrites && storageFactories==oldStorage && sdkFactories==oldSDK,"same original uncertain Host/storage/factories retained")
        check(sdk.permissions==0 && sdk.queries==0 && ingests==0,"unknown setup cannot prompt or sync");return
    }
    check(prepared["setupOutcome"] as? String=="prepared","original initial setup succeeds")
    check(storageFactories==1 && sdkFactories==1 && sdk.permissions==0 && sdk.queries==0 && ingests==0,"only setup created original storage/SDK")
    if mode=="connection-lifecycle"{
        let oldStorage=storageFactories,oldSDK=sdkFactories;owner.withdraw(authorityChanged:site=="authority")
        check(owner.host === host,"lifecycle keeps exact original Host")
        let second=NativeHealthConnectionOwner(transport:transport,profile:profile);await unavailable(second.host)
        if site=="authority"{await unavailable(host)}
        check(storageFactories==oldStorage && sdkFactories==oldSDK && sdk.queries==0 && sdk.permissions==0,"withdrawal no replacement or hidden request");return
    }
    let savedWrites=disk.writes,permission=await perform(.permission,base,host)
    check(permission["requestState"] as? String=="completedReadNotObservable" && permission["readKnowledge"] as? String=="unknown","separate SDK request never claims readable grant")
    check(sdk.permissions==1 && sdk.queries==0 && ingests==0 && disk.writes==savedWrites,"request does not query/send/save")
    let result=await perform(.sync,sync,host)
    check(result["syncOutcome"] as? String=="applied" && sdk.queries==1 && ingests==1,"separate actual sync follows durable original receipt")
    check(storageFactories==1 && sdkFactories==1 && owner.host === host,"entire flow uses same original Host/SDK/store")
}
Task { @MainActor in await run();print("\(mode)/\(site) passed");exit(0) }
DispatchQueue.main.asyncAfter(deadline:.now()+15){fputs("FAIL: connection probe timed out\n",stderr);exit(2)}
RunLoop.main.run()
