// TEST ONLY: appended to the sealed offline saved-choices fixture by the harness.
var localAfterWrite:(()->Void)?,localReentry:(()->Void)?
func localSavedDescriptor(_ multi:Bool=false)->NativeCalendarSavedDescriptor{
 let d=descriptor(),c=d.selection.configuration.configuration,categories:Set<String>=multi ? ["CalendarEvent","Task"]:[c.plan.category]
 let currency=NativeCalendarAdmissionCurrency(owner:originalOwner,binding:.init(root:rootConfiguration().identity,configuration:c,selected:categories,kind:.reconnectExistingLocal))
 return .init(selector:d.selector,label:d.label,destinationLabel:d.destinationLabel,selection:.init(runtimeSelection:d.selection.runtimeSelection,configuration:d.selection.configuration,reconnect:.init(owner:originalOwner,currency:currency,expectedSavedCategories:categories)))
}
func localDescriptor(_ saved:NativeCalendarSavedDescriptor,_ invalid:String="")->NativeCalendarLocalSetupDescriptor{
 let selection=saved.selection,c=selection.configuration.configuration,categories:Set<String>=invalid=="multicategory" ? ["CalendarEvent","Task"]:[c.plan.category]
 let owner:AnyObject=invalid=="pair" ? NSObject():originalOwner
 let currency=NativeCalendarAdmissionCurrency(owner:owner,binding:.init(root:rootConfiguration().identity,configuration:c,selected:categories,kind:invalid=="kind" ? .reconnectExistingLocal:.setupExistingRemote))
 return .init(selector:"fixture-local-setup-selector",label:"Synthetic approved Calendar",destinationLabel:"Synthetic destination",selection:.init(runtimeSelection:selection.runtimeSelection,configuration:selection.configuration,setup:.init(owner:owner,currency:currency,selectedCategories:categories)))
}
func localChosen(_ c:[String:Any])->[String:Any]{
 check(c["state"] as? String=="available","local configured hints available")
 let rows=c["choices"] as! [[String:Any]];check(rows.count==1 && rows[0]["scope"] as? String=="existingRemoteLocalSetupOnly","local hints have distinct scope")
 check(Set(rows[0].keys)==Set(["choice","label","destinationLabel","dataLabel","scope"]),"closed configured hint")
 return ["schemaVersion":"1.0.0","catalogId":c["catalogId"]!,"choice":rows[0]["choice"]!]
}
@MainActor func localAction(_ request:[String:Any],_ h:NativeHealthHost) async->[String:Any]{await withCheckedContinuation{c in h.performCalendarLocalSetupChoice(input:request){c.resume(returning:$0)}}}
@MainActor func localRun() async{
 try! transport.configure(origin)
 let c=URLSessionConfiguration.ephemeral;c.protocolClasses=[Offline.self];transport.session=URLSession(configuration:c,delegate:transport,delegateQueue:.main)
 _=await withCheckedContinuation{c in transport.request("/api/auth/v1/session"){c.resume(returning:$0)}}
 _=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}}
 let before=requests,saved=localSavedDescriptor(),local=localDescriptor(saved)
 if mode=="defaults"{
  if site=="no-local-port"{profile=NativeCalendarSavedProfile(root:rootConfiguration(),descriptors:[saved]);connection=NativeHealthConnectionOwner(transport:transport,calendarProfile:profile!);check(connection!.host.calendarLocalSetupChoices()["state"] as? String=="unavailable","old saved-only profile has no local port")}
  else{let bad=localDescriptor(saved,site=="bad-pair" ? "pair":"kind");check(NativeCalendarSavedProfile(root:rootConfiguration(),descriptors:[saved],setupDescriptors:[bad])==nil,"distinct original kind and paired owner required")
   if site=="bad-pair"{let multi=localSavedDescriptor(true);check(NativeCalendarSavedProfile(root:rootConfiguration(),descriptors:[multi],setupDescriptors:[localDescriptor(multi,"multicategory")])==nil,"single displayed label cannot authorize two categories")}
  }
  check(allocations==0 && disk.reads==0 && disk.writes==0 && requests==before && custodyCalls==0,"default construction inert");return
 }
 profile=NativeCalendarSavedProfile(root:rootConfiguration(),descriptors:[saved],setupDescriptors:[local]);check(profile != nil,"original paired kind-bound currencies accepted")
 connection=NativeHealthConnectionOwner(transport:transport,calendarProfile:profile!);let host=connection!.host
 transport.healthContextWillChange={connection?.withdraw(authorityChanged:$0)}
 let catalog=host.calendarLocalSetupChoices();input=localChosen(catalog)
 check(allocations==0 && disk.reads==0 && disk.writes==0 && requests==before && custodyCalls==0,"catalog invokes no provider/storage/custody/HTTP")
 if mode=="catalog"{
  if site=="inert"{return}
  if site=="opaque"{let text=String(data:bytes(catalog),encoding:.utf8)!;for secret in [local.selector,saved.selector,namespace.uuidString.lowercased(),enrollment.uuidString.lowercased(),"runtimeSelection","policyRevision"]{check(!text.contains(secret),"native identity/approval/configuration not exported")};return}
  if site=="stale"{_ = host.calendarLocalSetupChoices()}
  else{input=chosen(host.calendarSavedChoices())}
  let v=await localAction(input,host);check(v["reason"] as? String=="invalid_choice" && allocations==0 && requests==before,"stale and wrong-kind handles inert");return
 }
 if mode=="request"{
  if site=="extra"{input["selection"]=local.selector}else{input["choice"]=UUID().uuidString.lowercased()}
  let v=await localAction(input,host);check(v["reason"] as? String=="invalid_choice" && allocations==0 && requests==before,"closed opaque request inert");return
 }
 if mode=="setup" && (site=="duplicate" || site=="cross-health"){
  localReentry={
   host.performCalendarLocalSetupChoice(input:input){check($0["reason"] as? String=="busy","wrapper reentry refused");reentryCount+=1}
   host.setupCalendar(selection:local.selector){check($0.persistence == .notApplied,"direct setup cannot borrow private permit");reentryCount+=1}
   host.setup(selection:"fixture-health",action:.enrollExistingRemote){check((try? $0.get())==nil,"cross Health setup refused");reentryCount+=1}
   check(host.calendarSavedChoices()["reason"] as? String=="busy","saved catalog cannot cross active setup")
  }
 }
 if mode=="setup" && site=="context"{localAfterWrite={transport.epoch+=1}}
 if mode=="unknown"{disk.failBefore=site=="before";disk.failAfter=site=="after"}
 let value=await localAction(input,host),result=value["result"] as! [String:Any]
 check(posts==0 && allocations==1,"local admission uses one root and never ingests")
 check(Set(value.keys)==Set(["schemaVersion","operation","catalogId","choice","reason","result"]) && value["operation"] as? String=="setupLocal","closed action result")
 if mode=="setup" && site=="denied"{check(result["persistence"] as? String=="notApplied" && disk.writes==0 && value["reason"] as? String != "ready","fresh denied policy prevents write");return}
 check(disk.writes==1,"exactly one atomic local write invocation")
 if mode=="unknown"{
  check(result["persistence"] as? String=="unconfirmed" && result["availability"] as? String=="unavailable" && result["attemptId"] is String,"original invoked uncertainty and attempt preserved")
  check(site=="before" ? disk.data==nil:disk.data != nil,"actual before/after write fault injected")
  let attempt=result["attemptId"] as! String,count=requests,held=disk.data
  let again=await localAction(input,host),r=again["result"] as! [String:Any]
  check(r["persistence"] as? String=="unconfirmed" && r["attemptId"] as? String==attempt,"duplicate preserves original uncertainty")
  connection!.withdraw();let other=NativeHealthConnectionOwner(transport:transport,calendarProfile:profile!);_ = other.host.calendarLocalSetupChoices()
  check(connection!.host === host && allocations==1 && disk.writes==1 && disk.data==held && requests==count,"unknown original owner/store/hold cannot be escaped");return
 }
 check(result["persistence"] as? String=="saved" && result["attemptId"] is String,"original saved persistence and attempt")
 if mode=="setup" && site=="context"{check(value["reason"] as? String=="context_changed" && result["availability"] as? String=="unavailable" && value["catalogId"] is NSNull,"known saved survives later context loss honestly");return}
 check(value["reason"] as? String=="ready" && result["availability"] as? String=="available","current saved local setup")
 if mode=="setup" && (site=="duplicate" || site=="cross-health"){check(reentryCount==3,"all original reentry fences execute")}
 // A repeated native-issued choice must report the original durable observation,
 // including after catalog refresh. It must never make another write/proof request.
 let count=requests,attempt=result["attemptId"] as! String
 let again=await localAction(input,host),r=again["result"] as! [String:Any]
 check(r["persistence"] as? String=="saved" && r["attemptId"] as? String==attempt && r["availability"] as? String=="unavailable" && requests==count && disk.writes==1,"duplicate saved observation remains truthful without retry")
 if mode=="setup"{return}
 // Completion is not drain; original reader/custody retirement publishes later.
 await withCheckedContinuation{(c:CheckedContinuation<Void,Never>) in DispatchQueue.main.async{DispatchQueue.main.async{c.resume()}}}
 let refreshed=host.calendarLocalSetupChoices();let refreshedInput=localChosen(refreshed)
 let observed=await localAction(refreshedInput,host),o=observed["result"] as! [String:Any]
 check(o["persistence"] as? String=="saved" && o["attemptId"] as? String==attempt && requests==count && disk.writes==1,"fresh catalog cannot erase saved observation or replay original setup")
 let savedInput=chosen(host.calendarSavedChoices())
 let early=await action(.deliverPending,savedInput,host);check(early["reason"] as? String=="unavailable" && posts==0,"setup completion does not ready retained delivery")
 let connected=await action(.reconnect,savedInput,host),cr=connected["result"] as! [String:Any]
 check(connected["reason"] as? String=="ready" && cr["snapshotWrite"] as? String=="notRequested" && allocations==1 && disk.writes==1 && connection!.host === host,"separate original reconnect reuses same root with zero new writes")
 check(local.selection.setup!.currency !== saved.selection.reconnect!.currency && local.selection.setup!.currency!.binding.kind == .setupExistingRemote && saved.selection.reconnect!.currency!.binding.kind == .reconnectExistingLocal,"original currencies retain independent kinds")
 let pending=await action(.deliverPending,savedInput,host),pr=pending["result"] as! [String:Any]
 check(pr["state"] as? String=="emptyPending" && posts==0 && allocations==1,"separate pending-only action with no capture")
}
@MainActor func selectorByteRun() async{
 try! transport.configure(origin)
 let c=URLSessionConfiguration.ephemeral;c.protocolClasses=[Offline.self];transport.session=URLSession(configuration:c,delegate:transport,delegateQueue:.main)
 _=await withCheckedContinuation{c in transport.request("/api/auth/v1/session"){c.resume(returning:$0)}}
 _=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}}
 let a=localSavedDescriptor(),base=a.selection.configuration.configuration
 let bConfig=NativeCalendarAcquisitionOwner.Configuration(provenance:"fixture-original-calendar-B",origin:origin,human:human,session:sessionID,endpoint:endpoint,enrollment:UUID(uuidString:"30000000-0000-4000-8000-000000000002")!,namespace:UUID(uuidString:"10000000-0000-4000-8000-000000000002")!,plan:base.plan,protectedAvailable:{true})
 let configured=NativeHealthRuntime.CalendarConfiguration(configuration:bConfig,custody:a.selection.configuration.custody,makeAcquisition:nil,captureClock:{check(false,"byte-binding test never captures");return Date()})
 let categories:Set<String>=[base.plan.category]
 let b=NativeCalendarSavedDescriptor(selector:"fixture-saved-B",label:"Synthetic saved B",destinationLabel:"Synthetic destination B",selection:.init(runtimeSelection:a.selection.runtimeSelection,configuration:configured,reconnect:.init(owner:originalOwner,currency:NativeCalendarAdmissionCurrency(owner:originalOwner,binding:.init(root:rootConfiguration().identity,configuration:bConfig,selected:categories,kind:.reconnectExistingLocal)),expectedSavedCategories:categories)))
 let firstSelector="fixture-local-caf\u{e9}",secondSelector="fixture-local-cafe\u{301}"
 check(firstSelector==secondSelector && Data(firstSelector.utf8) != Data(secondSelector.utf8),"test controls Swift canonical equality but distinct original bytes")
 func localPair(_ d:NativeCalendarSavedDescriptor,_ selector:String)->NativeCalendarLocalSetupDescriptor{
  let config=d.selection.configuration.configuration
  return .init(selector:selector,label:d.label,destinationLabel:d.destinationLabel,selection:.init(runtimeSelection:d.selection.runtimeSelection,configuration:d.selection.configuration,setup:.init(owner:originalOwner,currency:NativeCalendarAdmissionCurrency(owner:originalOwner,binding:.init(root:rootConfiguration().identity,configuration:config,selected:categories,kind:.setupExistingRemote)),selectedCategories:categories)))
 }
 profile=NativeCalendarSavedProfile(root:rootConfiguration(),descriptors:[a,b],setupDescriptors:[localPair(a,firstSelector),localPair(b,secondSelector)]);check(profile != nil,"exact-byte distinct original paired descriptors accepted")
 connection=NativeHealthConnectionOwner(transport:transport,calendarProfile:profile!);let host=connection!.host
 func request(_ catalog:[String:Any],_ index:Int)->[String:Any]{let choices=catalog["choices"] as! [[String:Any]];check(choices.count==2,"two original native choices");return ["schemaVersion":"1.0.0","catalogId":catalog["catalogId"]!,"choice":choices[index]["choice"]!]}
 let first=await localAction(request(host.calendarLocalSetupChoices(),0),host),ar=first["result"] as! [String:Any]
 check(ar["persistence"] as? String=="saved" && first["reason"] as? String=="ready","original A really saved")
 let attempt=ar["attemptId"] as! String
 await withCheckedContinuation{(c:CheckedContinuation<Void,Never>) in DispatchQueue.main.async{DispatchQueue.main.async{c.resume()}}}
 let catalog=host.calendarLocalSetupChoices(),requestCount=requests,writes=disk.writes
 let second=await localAction(request(catalog,1),host),br=second["result"] as! [String:Any]
 check(br["attemptId"] as? String != attempt && br["persistence"] as? String != "saved" && br["persistence"] as? String != "unconfirmed","byte-distinct B must never borrow original A attempt or persistence")
 // The existing original policy fixture belongs to A, so B correctly refuses it.
 // This test makes no claim that B should bypass original proof or succeed.
 check(requests>requestCount && disk.writes==writes && allocations==1 && posts==0,"B follows original proof refusal without new write/root/ingest")
 let original=await localAction(request(catalog,0),host),again=original["result"] as! [String:Any]
 check(again["attemptId"] as? String==attempt && again["persistence"] as? String=="saved","A retains exact original saved observation")
}
Task{@MainActor in if mode=="binding"{await selectorByteRun()}else{await localRun()};print("\(mode)/\(site) passed");exit(0)}
DispatchQueue.main.asyncAfter(deadline:.now()+15){fputs("FAIL: local Calendar probe timed out\n",stderr);exit(2)}
RunLoop.main.run()
