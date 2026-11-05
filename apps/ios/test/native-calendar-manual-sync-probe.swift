// TEST ONLY: original offline storage/transport and sealed synthetic SDK fixture.
var sharedAccessChecks=0,sharedQueries=0,factoryCalls=0,clockCalls=0
let originalSDK=SharedStore()
func manualDescriptor()->NativeCalendarSavedDescriptor{
 let d=descriptor(),old=d.selection.configuration.configuration,category=site=="task" ? "Task":"CalendarEvent",categories:Set<String>=[category]
 let plan=MobileEventKitAcquisition.Plan(category:category,selectedContainerIDs:["selected"],mappingVersion:old.plan.mappingVersion,coverageStart:old.plan.coverageStart,coverageEnd:old.plan.coverageEnd,capturedSDKDefaultTimeZone:old.plan.capturedSDKDefaultTimeZone)
 let config=NativeCalendarAcquisitionOwner.Configuration(provenance:old.provenance,origin:old.origin,human:old.human,session:old.session,endpoint:old.endpoint,enrollment:old.enrollment,namespace:old.namespace,plan:plan,protectedAvailable:{true},deliveryScope:syntheticVerifiedCalendarScope)
 let clock:()->Date={clockCalls+=1;return Date(timeIntervalSince1970:1793404800)}
 let originalConfig=NativeHealthRuntime.CalendarConfiguration(configuration:config,custody:d.selection.configuration.custody,makeAcquisition:nil,captureClock:clock)
 let port=NativeCalendarCollectionPort(owner:mode=="defaults" && site=="wrong-owner" ? NSObject():originalOwner,makeAcquisition:{box in
  factoryCalls+=1
  if mode=="fences" && site=="duplicate"{
   connection!.host.calendarCollectAndDeliverChoice(input:input){check($0["reason"] as? String=="busy","manual action cannot reenter itself")}
   connection!.host.calendarCollectAndDeliver(selection:d.selector){check($0 == .notApplied(.unavailable),"legacy selection cannot borrow manual factory permit")}
   connection!.host.setup(selection:"health",action:.enrollExistingRemote){check((try? $0.get())==nil,"cross Health admission refused")}
  }
  if mode=="fences" && site=="context"{transport.epoch+=1}
  return MobileEventKitAcquisition(outbox:box,storePort:originalSDK,executeOnWorker:{$0()})
 })
 return .init(selector:d.selector,label:d.label,destinationLabel:d.destinationLabel,selection:.init(runtimeSelection:d.selection.runtimeSelection,configuration:originalConfig,reconnect:.init(owner:originalOwner,currency:NativeCalendarAdmissionCurrency(owner:originalOwner,binding:.init(root:rootConfiguration().identity,configuration:config,selected:categories,kind:.reconnectExistingLocal)),expectedSavedCategories:categories)),collection:mode=="defaults" && site=="absent" ? nil:port)
}
@MainActor func manualAction(_ request:[String:Any],_ host:NativeHealthHost) async->[String:Any]{await withCheckedContinuation{c in host.calendarCollectAndDeliverChoice(input:request){c.resume(returning:$0)}}}
@MainActor func manualTicks() async{await withCheckedContinuation{(c:CheckedContinuation<Void,Never>) in DispatchQueue.main.asyncAfter(deadline:.now()+0.03){c.resume()}}}
@MainActor func manualRun() async{
 try! transport.configure(origin);let c=URLSessionConfiguration.ephemeral;c.protocolClasses=[Offline.self];transport.session=URLSession(configuration:c,delegate:transport,delegateQueue:.main)
 _=await withCheckedContinuation{c in transport.request("/api/auth/v1/session"){c.resume(returning:$0)}};_=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}}
 let d=manualDescriptor(),box=HealthOutbox(storage:disk),proof=try! MobileCalendarPolicyParser.parse(bytes(fixture["policy"]!),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:enrollment)
 try! box.admitCalendarExistingRemote(proof:proof,selectedCategories:[d.selection.configuration.configuration.plan.category]);disk.reads=0;disk.writes=0
 profile=NativeCalendarSavedProfile(root:rootConfiguration(),descriptors:[d]);check(profile != nil,"original same-root saved profile")
 connection=NativeHealthConnectionOwner(transport:transport,calendarProfile:profile!);let host=connection!.host;input=chosen(host.calendarSavedChoices())
 let before=requests
 let premature=host.calendarCollectionDetailsChoice(input:input);check(premature["reason"] as? String=="unavailable" && allocations==0 && factoryCalls==0 && sharedAccessChecks==0 && clockCalls==0 && requests==before,"catalog/setup hint cannot auto collect or manufacture readiness")
 let reconnected=await action(.reconnect,input,host);check(reconnected["reason"] as? String=="ready","actual original saved reconnect")
 check(factoryCalls==0 && sharedAccessChecks==0 && sharedQueries==0 && clockCalls==0 && posts==0,"reconnect never constructs capture SDK or collects")
 let missingReview=await manualAction(input,host);check(missingReview["reason"] as? String=="unavailable" && factoryCalls==0,"explicit metadata review required before collect/send")
 let snapshot=disk.data,writes=disk.writes,reads=disk.reads,count=requests,details=host.calendarCollectionDetailsChoice(input:input)
 if mode=="defaults"{check(details["reason"] as? String=="unavailable" && factoryCalls==0 && sharedAccessChecks==0 && clockCalls==0 && disk.data==snapshot,"missing/wrong original collection composition unavailable");return}
 check(details["reason"] as? String=="ready","original configured collection details available")
 let meta=details["result"] as! [String:Any]
 check(Set(meta.keys)==Set(["state","scope","destinationLabel","dataLabel","coverageStart","coverageEnd","timeZone"]) && meta["scope"] as? String=="collectAndDeliver","closed truthful metadata")
 let format=ISO8601DateFormatter();format.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
 check(format.date(from:meta["coverageStart"] as! String)==d.selection.configuration.configuration.plan.coverageStart && format.date(from:meta["coverageEnd"] as! String)==d.selection.configuration.configuration.plan.coverageEnd && meta["destinationLabel"] as? String==d.destinationLabel,"EXACT fixed original plan/window/destination disclosed")
 check(factoryCalls==0 && sharedAccessChecks==0 && sharedQueries==0 && clockCalls==0 && requests==count && disk.reads==reads && disk.writes==writes && disk.data==snapshot,"details review is entirely inert")
 if mode=="review"{
  if site=="inert"{
   _=await withCheckedContinuation{c in host.calendarCollectAndDeliver(selection:d.selector){c.resume(returning:$0)}}
   check(factoryCalls==0 && sharedQueries==0 && clockCalls==0 && posts==0,"legacy guessed selector cannot attach original collection factory outside exact manual action");return
  }
  if site=="closed"{for key in ["sourceNamespace","window","plan","category"]{var bad=input;bad[key]="forbidden";check(host.calendarCollectionDetailsChoice(input:bad)["reason"] as? String=="invalid_choice","closed metadata request");let result=await manualAction(bad,host);check(result["reason"] as? String=="invalid_choice","closed capture request")};check(factoryCalls==0 && posts==0,"forged configuration invokes no factory");return}
  transport.epoch+=1;let result=await manualAction(input,host);check(result["reason"] as? String=="context_changed" && factoryCalls==0 && sharedQueries==0 && posts==0,"stale context cannot use original review");return
 }
 let value=await manualAction(input,host),result=value["result"] as! [String:Any]
 check(allocations==1 && factoryCalls==1 && connection!.host === host,"same original Host/runtime/outbox and original factory only once")
 if mode=="holds"{
  check(result["state"] as? String=="unconfirmed" && result["stage"] as? String==(site=="acquisition" ? "acquisition":"settlement") && result["attemptId"] is String,"original unknown stage/attempt not normalized")
  let held=disk.data,n=requests,fx=factoryCalls,p=posts,w=disk.writes
  _=host.calendarCollectionDetailsChoice(input:input);_=await manualAction(input,host);connection!.withdraw();let second=NativeHealthConnectionOwner(transport:transport,calendarProfile:profile!);_=second.host.calendarSavedChoices()
  check(allocations==1 && disk.data==held && disk.writes==w && requests==n && factoryCalls==fx && posts==p,"unknown original owner/queue/hold not replaced or retried");return
 }
 if mode=="delivery"{check(result["state"] as? String=="retained" && result["reason"] as? String==site && queueCount(disk.data)==1 && posts==1,"actual original transport/receipt uncertainty retains queued original item without invented count");return}
 if mode=="fences" && site != "duplicate"{check(result["state"] as? String=="notApplied" && result["stage"] as? String=="acquisition" && posts==0,"original context/status/cancel fences block delivery, no fabricated success");return}
 if site=="empty"{check(result["state"] as? String=="emptyPending" && result["acquired"] as? Int==0 && posts==0,"actual empty collection commit and no delivery")}
 else{check(result["state"] as? String=="settledPrefix" && result["acquired"] as? Int==1 && result["acceptedOrDuplicate"] as? Int==1 && posts==1 && sharedQueries==1 && clockCalls>0,"actual original event/task acquisition commit then receipt settlement")}
 let fx=factoryCalls,p=posts;_=await manualAction(input,host);check(factoryCalls==fx && posts==p,"review consumed; completion never auto-retries")
 await manualTicks();let again=host.calendarCollectionDetailsChoice(input:input);check(again["reason"] as? String=="ready","same original admission can be explicitly reviewed after actual drain; no reconnect currency rearm")
}
Task{@MainActor in await manualRun();print("\(mode)/\(site) passed");exit(0)}
DispatchQueue.main.asyncAfter(deadline:.now()+15){fputs("FAIL: manual sync probe timed out\n",stderr);exit(2)}
RunLoop.main.run()
