// TEST ONLY: original external storage, transport and permission SDK are fake.
let scenario=ProcessInfo.processInfo.environment["PERMISSION_SUBCASE"] ?? "default"
var permissionReadHook:(()->Void)?,permissionFenceHook:(()->Void)?,permissionReleaseHook:(()->Void)?,parentPermissionCurrency:NativeCalendarReadPermissionCurrency?,permissionReleases=0
var permissionPhase=false,policyMode="approved",sdkPreparation=0,sdkStatus=0,sdkDelegates=0,sdkInside=false
var sdkPrepareHook:(()->Void)?,sdkStatusHook:(()->Void)?,sdkDelegateHook:(()->Void)?
var configPermissionCurrency:NativeCalendarReadPermissionCurrency?
func permissionPolicy()->[String:Any]{
 var p=fixture["policy"] as! [String:Any],r=p["result"] as! [String:Any],e=r["effective"] as! [String:Any],en=r["enrollment"] as! [String:Any]
 if permissionPhase && policyMode=="denied"{e["collectionAllowed"]=false}
 if permissionPhase && policyMode=="changed"{en["revision"]=3;e["policyRevision"]=3}
 r["effective"]=e;r["enrollment"]=en;p["result"]=r;return p
}
final class PermissionSDK:NativeCalendarReadPermissionSDK {
 var value:NativeCalendarReadAccess = .notDetermined,callback:((Bool,Error?)->Void)?
 func access(category:String)->NativeCalendarReadAccess{check(Thread.isMainThread,"status on owner");check(category=="CalendarEvent" || category=="Task","exact category");sdkStatus+=1;sdkStatusHook?();return value}
 func request(category:String,current:()->Bool,completion:@escaping(Bool,Error?)->Void)->Bool{
  check(Thread.isMainThread,"delegate preparation on owner");sdkInside=true;defer{sdkInside=false};sdkDelegateHook?();guard current() else{return false};sdkDelegates+=1
  if mode=="fences" && (site=="never" || site=="late"){callback=completion;return true}
  value=site=="write-only" ? .writeOnly:site=="false" ? .denied:.fullRead
  let error:Error?=site=="error" ? CocoaError(.userCancelled):nil
  if site=="async"{DispatchQueue.main.async{completion(true,error)}}
  else if site=="off-main"{DispatchQueue.global().async{completion(true,nil)}}
  else{completion(site != "false",error);if site=="duplicate"{completion(false,CocoaError(.userCancelled))}}
  return true
 }
}
let permissionSDK=PermissionSDK()
func permissionDescriptor()->NativeCalendarSavedDescriptor{
 let base=descriptor(),old=base.selection.configuration.configuration,category=site=="full-reminders" ? "Task":"CalendarEvent",categories:Set<String>=[category]
 let plan=MobileEventKitAcquisition.Plan(category:category,selectedContainerIDs:["fixture-calendar"],mappingVersion:old.plan.mappingVersion,coverageStart:old.plan.coverageStart,coverageEnd:old.plan.coverageEnd,capturedSDKDefaultTimeZone:old.plan.capturedSDKDefaultTimeZone)
 let c=NativeCalendarAcquisitionOwner.Configuration(provenance:old.provenance,origin:old.origin,human:old.human,session:old.session,endpoint:old.endpoint,enrollment:old.enrollment,namespace:old.namespace,plan:plan,protectedAvailable:{true},deliveryScope:old.deliveryScope)
 let config=NativeHealthRuntime.CalendarConfiguration(configuration:c,custody:base.selection.configuration.custody,makeAcquisition:nil,captureClock:{check(false,"permission never captures");return Date()})
 let currency=NativeCalendarReadPermissionCurrency(owner:mode=="defaults"&&site=="wrong-currency" ? NSObject():originalOwner,binding:.init(root:rootConfiguration().identity,configuration:c,category:category));configPermissionCurrency=currency
 let port=NativeCalendarReadPermissionPort(owner:originalOwner,currency:currency,prepare:{sdkPreparation+=1;sdkPrepareHook?();return permissionSDK})
 return .init(selector:base.selector,label:base.label,destinationLabel:base.destinationLabel,selection:.init(runtimeSelection:base.selection.runtimeSelection,configuration:config,reconnect:.init(owner:originalOwner,currency:NativeCalendarAdmissionCurrency(owner:originalOwner,binding:.init(root:rootConfiguration().identity,configuration:c,selected:categories,kind:.reconnectExistingLocal)),expectedSavedCategories:categories)),readPermission:mode=="defaults"&&site=="absent" ? nil:port)
}
@MainActor func permissionAction(_ input:[String:Any],_ h:NativeHealthHost) async->[String:Any]{await withCheckedContinuation{c in h.requestCalendarReadPermissionChoice(input:input){check(!sdkInside,"completion is after entire SDK delegate return");c.resume(returning:$0)}}}
@MainActor func ticks() async{await withCheckedContinuation{(c:CheckedContinuation<Void,Never>) in DispatchQueue.main.asyncAfter(deadline:.now()+0.03){c.resume()}}}
@MainActor func permissionRun() async{
 try! transport.configure(origin);let c=URLSessionConfiguration.ephemeral;c.protocolClasses=[Offline.self];transport.session=URLSession(configuration:c,delegate:transport,delegateQueue:.main)
 _=await withCheckedContinuation{c in transport.request("/api/auth/v1/session"){c.resume(returning:$0)}};_=await withCheckedContinuation{c in transport.request("/api/auth/v1/user-context"){c.resume(returning:$0)}}
 let d=permissionDescriptor(),box=HealthOutbox(storage:disk),proof=try! MobileCalendarPolicyParser.parse(bytes(fixture["policy"]!),expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:enrollment)
 try! box.admitCalendarExistingRemote(proof:proof,selectedCategories:[d.selection.configuration.configuration.plan.category]);disk.writes=0;disk.reads=0
 profile=NativeCalendarSavedProfile(root:rootConfiguration(),descriptors:[d]);check(profile != nil,"original saved profile configured")
 connection=NativeHealthConnectionOwner(transport:transport,calendarProfile:profile!);let host=connection!.host
 if mode=="defaults" && site=="unbound"{let other=NativeCalendarSavedProfile(root:rootConfiguration(),descriptors:[d])!;let refused=NativeHealthConnectionOwner(transport:transport,calendarProfile:other);refused.withdraw(authorityChanged:true);check(configPermissionCurrency!.isBound(host),"refused holder gets no original permission revoke rights")}
 input=chosen(host.calendarSavedChoices());check(sdkStatus==0 && sdkPreparation==0 && sdkDelegates==0,"binding/catalog inert")
 if mode=="authority" && site=="no-reconnect"{let value=await permissionAction(input,host);check(value["reason"] as? String=="unavailable" && allocations==0 && sdkStatus==0,"catalog alone never status/request");return}
 let reconnected=await action(.reconnect,input,host);check(reconnected["reason"] as? String=="ready","actual original saved reconnect")
 check(sdkStatus==0 && sdkPreparation==0 && sdkDelegates==0 && disk.writes==0,"reconnect never touches permission SDK or persistent bytes")
 permissionPhase=true;let original=disk.data,releases=permissionReleases
 if mode=="fences" && site=="forged"{
  for kind in ["extra","choice","catalog"]{var bad=input;if kind=="extra"{bad["category"]="Task"}else{bad[kind=="choice" ? "choice":"catalogId"]=UUID().uuidString.lowercased()};let value=await permissionAction(bad,host);check(value["reason"] as? String=="invalid_choice","closed native handles")};check(sdkStatus==0 && disk.data==original && disk.writes==0,"forged request inert");return
 }
 if mode=="authority"{policyMode=site;if site=="paused"{var state=try! JSONSerialization.jsonObject(with:disk.data!) as! [String:Any],rows=state["calendarEnrollments"] as! [Any],row=rows[1] as! [String:Any];row["paused"]=true;rows[1]=row;state["calendarEnrollments"]=rows;disk.data=bytes(state)}}
 if mode=="status"{permissionSDK.value=site=="full-events" || site=="full-reminders" ? .fullRead:site=="denied" ? .denied:site=="restricted" ? .restricted:site=="write-only" ? .writeOnly:.unknown}
 if mode=="fences" && site=="reentry"{
  sdkPrepareHook={host.requestCalendarReadPermissionChoice(input:input){check($0["reason"] as? String=="busy","duplicate wrapper refused")};host.setupCalendar(selection:d.selector){check($0.persistence == .notApplied,"Calendar direct cannot borrow permit")};host.setup(selection:"health",action:.enrollExistingRemote){check((try? $0.get())==nil,"cross Health refused")}}
  sdkStatusHook={if sdkStatus==1{host.requestCalendarReadPermissionChoice(input:input){check($0["reason"] as? String=="busy","status callback reentry refused")}}}
 }
 if mode=="fences" && site=="custody"{
  var fired=false
  let cancel:()->Void={guard !fired else{return};fired=true;host.calendarCancel()}
  if scenario=="raw-read"{sdkStatusHook={permissionReadHook=cancel}}
  if scenario=="fence-unwind"{sdkStatusHook={permissionFenceHook=cancel}}
  if scenario=="currency-unwind"{sdkStatusHook={permissionFenceHook={if let currency=parentPermissionCurrency{currency.revoke()}}}}
  if scenario=="config-unwind"{sdkStatusHook={permissionFenceHook={configPermissionCurrency?.revoke()}}}
  if scenario=="release-unwind"{permissionReleaseHook={parentPermissionCurrency?.revoke()}}
  if scenario=="sdk-final"{sdkDelegateHook=cancel}
  if scenario=="pause"{sdkPrepareHook={host.pauseCollection(["schemaVersion":"1.0.0","operationId":UUID().uuidString.lowercased(),"sourceNamespace":namespace.uuidString.lowercased(),"enrollmentId":enrollment.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased()]){_ in}}}
  if scenario=="retire"{sdkStatusHook={connection!.withdraw()}}
 }
 if mode=="fences" && (site=="never" || site=="late"){
  var result:[String:Any]?
  host.requestCalendarReadPermissionChoice(input:input){result=$0}
  for _ in 0..<20{if sdkDelegates==1{break};await ticks()};check(sdkDelegates==1 && result==nil,"actual fake request pending")
  check(host.runtime!.hasAdmission && permissionReleases==releases,"completion absence retains original owner/lease")
  connection!.withdraw();check(permissionReleases==releases,"withdraw cannot guess SDK retirement")
  if site=="never"{_ = host.calendarSavedChoices();check(result==nil && permissionReleases==releases && sdkDelegates==1 && disk.writes==0,"never callback retains SAME hold without retry");return}
  permissionSDK.value = .fullRead;permissionSDK.callback?(true,nil);await ticks();check(result != nil,"late callback drains")
  let value=result!["result"] as! [String:Any];check(value["requestState"] as? String=="deferred" && value["attemptId"] is String && value["readAccess"] as? String=="unknown" && sdkStatus==1,"late original request preserved, no stale capability claim or post-status")
  check(permissionReleases==releases+1,"original lease released only after real callback");return
 }
 let value=await permissionAction(input,host),result=value["result"] as! [String:Any]
 check(disk.writes==0 && posts==0 && allocations==1,"permission never writes/captures/ingests/replaces original root")
 if mode != "authority" || site != "paused"{check(disk.data==original,"persistent snapshot exact bytes unchanged")}
 check(Set(value.keys)==Set(["schemaVersion","operation","catalogId","choice","reason","result"]) && Set(result.keys)==Set(["attemptId","requestState","readAccess"]),"closed reply has no source/config/data identifiers")
 if mode=="defaults" && site != "unbound"{check(value["reason"] as? String=="unavailable" && sdkPreparation==0 && sdkStatus==0 && sdkDelegates==0,"missing original port/currency unavailable");return}
 if mode=="authority"{check(sdkPreparation==0 && sdkStatus==0 && sdkDelegates==0 && result["requestState"] as? String=="notInvoked","fresh failed original proof/binding blocks even status");return}
 if mode=="fences" && site=="custody" && scenario=="release-unwind"{
  check(sdkDelegates==1 && result["requestState"] as? String=="deferred" && result["readAccess"] as? String=="unknown" && result["attemptId"] is String,"exact parent release-unwind revocation must prevent current publication and preserve invoked attempt")
  check(permissionReleases==releases+1,"actual release returned once before deferred publication")
  let pending=await action(.deliverPending,input,host);check(pending["reason"] as? String != "ready","release revocation invalidates prior admission, never publishes new readiness");return
 }
 if mode=="fences" && site=="custody"{check(sdkDelegates==0 && result["requestState"] as? String=="notInvoked","original mutation/revocation before gate forbids actual SDK delegate");return}
 if mode=="status" && site != "write-only"{let expected=site=="full-events" || site=="full-reminders" ? "fullRead":site;check(result["readAccess"] as? String==expected && result["requestState"] as? String=="notInvoked" && sdkDelegates==0,"honest system capability without prompt")}
 else{check(sdkDelegates==1 && result["requestState"] as? String=="requestCompleted","one actual fake request and real callback completion");let expected=site=="false" ? "denied":site=="error" ? "unknown":site=="write-only" ? "writeOnly":"fullRead";check(result["readAccess"] as? String==expected,"Bool/error does not become false access authority")}
 check(permissionReleases==releases+1,"real callback/status action retires original custody once")
 let pending=await action(.deliverPending,input,host);check((pending["result"] as? [String:Any])?["state"] as? String=="emptyPending" && posts==0,"permission only preserves ORIGINAL established readiness, no reconnect rearm or automatic delivery")
}
Task{@MainActor in await permissionRun();print("\(mode)/\(site) passed");exit(0)}
DispatchQueue.main.asyncAfter(deadline:.now()+15){fputs("FAIL: permission probe timed out\n",stderr);exit(2)}
RunLoop.main.run()
