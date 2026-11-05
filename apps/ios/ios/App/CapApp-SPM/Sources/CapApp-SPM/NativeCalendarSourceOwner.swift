import Foundation
import AssistantCore

/// Original native composition inputs. No installed policy, settings, calendar
/// names, source IDs, duration defaults, OS calls, or implicit activation.
final class NativeCalendarSourceOwner {
    struct HealthResources {
        let mappingVersion:String
        let makeSDK:()throws->any NativeHealthSDK
    }
    struct Resources {
        let resolveFile:(_ current:()->Bool)throws->URL
        let filePort:any NativeCalendarFilePort
        let health:HealthResources?
        let deliveryContract:MobileCalendarSelectedDelivery.Contract
        let limits:MobileCalendarSyncWindow.Limits,maxBytes:Int,maxEvents:Int,mappingVersion:String
        let protectedAvailable:()->Bool,clock:()->Date,makeSDK:()->any NativeCalendarSelectionSDK
        // Existing explicit-file callers retain the same original location.
        init(file:URL,filePort:any NativeCalendarFilePort,limits:MobileCalendarSyncWindow.Limits,maxBytes:Int,maxEvents:Int,mappingVersion:String,protectedAvailable:@escaping()->Bool,clock:@escaping()->Date,makeSDK:@escaping()->any NativeCalendarSelectionSDK,deliveryContract:MobileCalendarSelectedDelivery.Contract = .settingsScoped,health:HealthResources?=nil){
            self.init(resolveFile:{current in guard current() else{throw NativeCalendarAdmissionError.stale};return file},filePort:filePort,limits:limits,maxBytes:maxBytes,maxEvents:maxEvents,mappingVersion:mappingVersion,protectedAvailable:protectedAvailable,clock:clock,makeSDK:makeSDK,deliveryContract:deliveryContract,health:health)
        }
        init(resolveFile:@escaping(_ current:()->Bool)throws->URL,filePort:any NativeCalendarFilePort,limits:MobileCalendarSyncWindow.Limits,maxBytes:Int,maxEvents:Int,mappingVersion:String,protectedAvailable:@escaping()->Bool,clock:@escaping()->Date,makeSDK:@escaping()->any NativeCalendarSelectionSDK,deliveryContract:MobileCalendarSelectedDelivery.Contract = .settingsScoped,health:HealthResources?=nil){
            self.resolveFile=resolveFile;self.filePort=filePort;self.limits=limits;self.maxBytes=maxBytes;self.maxEvents=maxEvents;self.mappingVersion=mappingVersion;self.protectedAvailable=protectedAvailable;self.clock=clock;self.makeSDK=makeSDK;self.deliveryContract=deliveryContract;self.health=health
        }
    }
    private struct Binding:Equatable {
        let origin:String,human:UUID,session:UUID,endpoint:UUID,epoch:Int,generation:UInt64,snapshot:NativeCalendarContext.Snapshot
    }
    private final class Catalog {
        let id=UUID(),binding:Binding,sdk:any NativeCalendarSelectionSDK,zone:TimeZone,records:[(UUID,NativeCalendarMetadata)]
        init(_ binding:Binding,_ sdk:any NativeCalendarSelectionSDK,_ zone:TimeZone,_ values:[NativeCalendarMetadata]){self.binding=binding;self.sdk=sdk;self.zone=zone;records=values.map{(UUID(),$0)}}
    }
    private final class Preview {
        let id=UUID(),catalog:Catalog,selected:[NativeCalendarMetadata],plan:MobileCalendarSyncWindow.Snapshot
        init(_ catalog:Catalog,_ selected:[NativeCalendarMetadata],_ plan:MobileCalendarSyncWindow.Snapshot){self.catalog=catalog;self.selected=selected;self.plan=plan}
    }
    private let transport:NativeTransport,connection:NativeHealthConnectionOwner,resources:Resources
    private var sdk:(any NativeCalendarSelectionSDK)?,generation:UInt64=0,active:UUID?,catalog:Catalog?,preview:Preview?,profile:NativeCalendarSavedProfile?,storage:NativeProtectedCalendarStorage?
    private var savedForegroundAllowed=false,savedBackgroundAllowed=false,savedWakeRequested=false
    private weak var legacyFencedHealthNotification:NativeTransport.HealthContextTransition?
    private weak var legacyFencedHealthRuntime:NativeHealthRuntime?
    private var savedRecoveryJob:UUID?,savedRecoveryState="notLoaded"
    private var savedHandbackSDK:(any NativeHealthSDK)?
    private var lastStrictHealthHuman:UUID?,lastStrictHealthSession:UUID?,lastStrictHealthReference:String?
    private var needsDurableSubjectRebind=false,strictHealthAuthUnavailable=false
    private var savedRecoveryChoices:[(UUID,HealthOutbox.SavedHealthSelection,Binding,NativeHealthRuntime)]=[]
    private var savedRecoveryCancellation:UInt64=0,savedRecoveryEnrollment:UUID?
    private var applicationRestoreCompletion:(()->Void)?,applicationRestoreOwnerReleased=false
    private var backgroundReview:(UUID,UUID,HealthOutbox.SavedHealthSelection,Binding,NativeHealthRuntime)?
    private var composed=false
    private var controlRuntime:NativeHealthRuntime?,controlBinding:Binding?,knownSettings:MobileCalendarSyncWindow?
    private var controlRetiring=false,controlReplyBinding:Binding?
    private struct ConsentReview {
        let id:UUID,binding:Binding,descriptor:MobileCalendarSourceConsent.Descriptor
        let statuses:[MobileCalendarSourceConsent.Status]
        var reserved:MobileCalendarSourceConsent.Reserved? = nil
    }
    private struct HealthConsentReview {
        let id:UUID,binding:Binding,descriptor:MobileHealthSourceConsent.Descriptor,statuses:[MobileHealthSourceConsent.Status]
        var reserved:MobileHealthSourceConsent.Reserved? = nil
    }
    private final class RemoteHealthCatalog {
        let id=UUID(),binding:Binding,inventory:NativeHealthInventory.Snapshot,fingerprint:Data
        let enrollments:[(choice:UUID,id:UUID,revision:Int,namespace:UUID?)]
        let sources:[(choice:UUID,value:MobileHealthInventoryPage.Source)]
        init(_ binding:Binding,_ inventory:NativeHealthInventory.Snapshot,_ fingerprint:Data,target:HealthOutbox.HealthConfiguredLocalState?=nil){
            self.binding=binding;self.inventory=inventory;self.fingerprint=fingerprint
            sources=inventory.sources.filter{$0.collector=="healthKit" && (target==nil || $0.namespace==target?.namespace)}.map{(UUID(),$0)}
            var values=inventory.unboundEnrollments.filter{$0.collector=="healthKit" && target==nil}.map{(choice:UUID(),id:$0.id,revision:$0.revision,namespace:UUID?.none)}
            for source in inventory.sources where source.collector=="healthKit" && (target==nil || source.namespace==target?.namespace){if let id=source.currentEnrollment,id==target?.enrollment || target==nil{values.append((UUID(),id,source.policyRevision,source.namespace))}}
            enrollments=values
        }
    }
    private struct RemoteHealthReview {let id:UUID,catalog:RemoteHealthCatalog,original:MobileOrdinaryControl.Original,summary:[String:Any]}
    private var remoteHealthCatalog:RemoteHealthCatalog?,remoteHealthReview:RemoteHealthReview?
    private struct HealthLocalReturnReview{let id:UUID,binding:Binding,fingerprint:Data,expected:HealthOutbox.HealthConfiguredLocalState,terminal:MobileOrdinaryControl.Terminal,configuration:NativeHealthRuntime.Configuration}
    private var healthLocalReturnReview:HealthLocalReturnReview?
    private var healthSettingsControlAvailable:Bool{connection.canInstallCalendarConfiguration || (connection.configuredHealthSettingsControl && connection.host.runtime === controlRuntime)}
    private var healthConsentReview:HealthConsentReview?
    private struct ConnectionReview {let id:UUID,binding:Binding,terminal:MobileCalendarSettingsWire.Terminal}
    private var consentReview:ConsentReview?,connectionReview:ConnectionReview?
    init(transport:NativeTransport,connection:NativeHealthConnectionOwner,resources:Resources){self.transport=transport;self.connection=connection;self.resources=resources}
    var busy:Bool{active != nil}
    /// Cancellation never cancels/forgets an entered permission callback. The
    /// sealed request broker retains its true invocation/body obligations.
    func withdraw(){precondition(Thread.isMainThread);generation &+= 1;backgroundReview=nil;savedRecoveryChoices=[];catalog=nil;preview=nil;consentReview=nil;connectionReview=nil;healthConsentReview=nil;remoteHealthCatalog=nil;remoteHealthReview=nil;healthLocalReturnReview=nil;profile?.revoke();controlRuntime?.cancelNativeCommand();controlRuntime?.cancelCalendar()}
    private func authorityCurrent(_ binding:Binding)->Bool{
        guard transport.endpoint?.absoluteString==binding.origin,transport.effectiveIsSelf,let owner=transport.currentEffectiveOwner else{return false}
        return UUID(uuidString:owner.principal)==binding.human && UUID(uuidString:owner.session)==binding.session
    }
    private func current(_ binding:Binding)->Bool{generation==binding.generation && transport.epoch==binding.epoch && authorityCurrent(binding)}
    private func begin()->UUID?{guard active==nil,savedRecoveryJob==nil,!composed,controlRuntime==nil,!controlRetiring,connection.canInstallCalendarConfiguration else{return nil};let id=UUID();active=id;return id}
    private func finish(_ id:UUID,_ value:[String:Any],_ done:@escaping([String:Any])->Void){
        // Follow the complete original transport/SDK callback return.
        let expectedGeneration=generation,expectedEpoch=transport.epoch,expectedOrigin=transport.endpoint?.absoluteString,expectedOwner=transport.currentEffectiveOwner
        DispatchQueue.main.async{[self] in
            guard active==id else{return}
            let owner=transport.currentEffectiveOwner
            let valid=generation==expectedGeneration && transport.epoch==expectedEpoch && transport.endpoint?.absoluteString==expectedOrigin && owner?.principal==expectedOwner?.principal && owner?.session==expectedOwner?.session && connection.canInstallCalendarConfiguration
            active=nil;publishApplicationRestoreReady()
            if valid || value["state"] as? String=="unavailable"{done(value)}
            else if value["requestState"] as? String != nil{done(reply("unavailable","context_changed",["attemptId":value["attemptId"] ?? NSNull(),"requestState":value["attemptId"] is String ? "deferred":"notInvoked","readAccess":"unknown"]))}
            else{done(reply("unavailable","context_changed"))}
        }
    }
    private func reply(_ state:String,_ reason:String,_ extra:[String:Any]=[:])->[String:Any]{["schemaVersion":"1.0.0","state":state,"reason":reason].merging(extra){_,new in new}}
    private func snapshot(_ id:UUID,_ done:@escaping(Binding?)->Void){
        guard active==id,let origin=transport.endpoint?.absoluteString,transport.effectiveIsSelf,let owner=transport.currentEffectiveOwner,let human=UUID(uuidString:owner.principal),let session=UUID(uuidString:owner.session) else{done(nil);return}
        let epoch=transport.epoch,generation=self.generation;var claimed=false
        transport.request("/api/auth/v1/user-context",maxBytes:65536){[self] result in
            guard !claimed else{return};claimed=true
            guard active==id,self.generation==generation,transport.epoch==epoch,case .success(let(data,http))=result,http.statusCode==200,let auth=try? NativeCalendarContext.auth(data,human:human,session:session) else{done(nil);return}
            var sessionClaimed=false
            transport.request("/api/runtime/v1/session-context",maxBytes:65536){[self] result in
                guard !sessionClaimed else{return};sessionClaimed=true
                guard active==id,self.generation==generation,case .success(let(data,http))=result,http.statusCode==200,
                      let object=try? JSONSerialization.jsonObject(with:data) as? [String:Any],let endpoint=object["endpoint"] as? [String:Any],let raw=endpoint["endpointId"] as? String,let actual=UUID(uuidString:raw),
                      let snapshot=try? NativeCalendarContext.session(data,auth:auth,endpoint:actual,epoch:epoch) else{done(nil);return}
                let binding=Binding(origin:origin,human:human,session:session,endpoint:actual,epoch:epoch,generation:generation,snapshot:snapshot)
                done(current(binding) ? binding:nil)
            }
        }
    }
    /// Transport supplies the authentic reply before publishing its effective
    /// owner. Only the strict original parser can classify a Human transition.
    /// No Auth body, credential or identity is copied into diagnostics/storage.
    func observeHealthContextTransition(_ event:NativeTransport.HealthContextTransition){
        precondition(Thread.isMainThread)
        legacyFencedHealthNotification=nil;legacyFencedHealthRuntime=nil
        guard event.kind == .authResponse,let data=event.authData,
              let rawHuman=event.proposedPrincipal,let human=UUID(uuidString:rawHuman),
              let rawSession=event.proposedSession,let session=UUID(uuidString:rawSession),
              let auth=try? NativeCalendarContext.auth(data,human:human,session:session) else{
            // A cancelled/failed old Auth callback can finish while its SAME
            // owner is already withdrawing. That owner stays fenced; its true
            // retirement still precedes a fresh bootstrap Auth read. Do not
            // cancel that waiting recovery on behalf of this old callback.
            if controlRetiring,event.kind == .authUnavailable,let original=controlRuntime{legacyFencedHealthNotification=event;legacyFencedHealthRuntime=original;return}
            strictHealthAuthUnavailable=true;savedRecoveryState="authenticationRequired";savedRecoveryChoices=[]
            withdraw();connection.withdraw();return
        }
        let previouslyKnown=lastStrictHealthHuman != nil
        let actualChange=lastStrictHealthHuman.map{$0 != human} ?? false
        let changed=strictHealthAuthUnavailable || lastStrictHealthHuman != human || lastStrictHealthSession != session || lastStrictHealthReference != auth.reference
        if actualChange{
            needsDurableSubjectRebind=true;savedRecoveryChoices=[]
            // Fence FIRST, then persist the exact original choice under the
            // closed withdrawal purpose. Unknown writes keep this owner held.
            controlRuntime?.protectSavedHealthSelection(disable:false,requireRebind:true)
            withdraw();connection.withdraw(authorityChanged:true)
        }
        strictHealthAuthUnavailable=false
        lastStrictHealthHuman=human;lastStrictHealthSession=session;lastStrictHealthReference=auth.reference
        if changed && (savedRecoveryJob==nil || previouslyKnown){
            savedWakeRequested=true
            DispatchQueue.main.async{[weak self] in self?.recoverSavedHealthOpportunity()}
        }
    }
    /// The original transport still emits its legacy Bool after the typed
    /// notification. Consume only the duplicate failed OLD Auth withdrawal while
    /// that same owner is already fully fenced/retiring. Every other legacy
    /// context event keeps its original full withdrawal/revocation semantics.
    func healthContextWillChange(authorityChanged:Bool,notification:NativeTransport.HealthContextTransition?=nil){
        precondition(Thread.isMainThread)
        if let notification,notification === legacyFencedHealthNotification,controlRetiring,let original=legacyFencedHealthRuntime,controlRuntime === original{
            legacyFencedHealthNotification=nil;legacyFencedHealthRuntime=nil;return
        }
        withdraw();connection.withdraw(authorityChanged:authorityChanged)
    }
    func setSavedHealthForeground(_ allowed:Bool){
        precondition(Thread.isMainThread);savedForegroundAllowed=allowed;savedBackgroundAllowed=false
        controlRuntime?.setNativeHealthActivity(foreground:allowed,eligibleBackground:false)
        if !allowed{savedWakeRequested=false;savedRecoveryChoices=[];savedRecoveryState="foregroundRequired"}
        else{recoverSavedHealthOpportunity()}
    }
    private func finishSavedRecovery(_ id:UUID,_ state:String,cancellation:UInt64,_ completion:(([String:Any])->Void)?){
        DispatchQueue.main.async{[self] in
            guard savedRecoveryJob==id,active==id else{return}
            savedRecoveryJob=nil;active=nil;savedRecoveryEnrollment=nil;savedRecoveryState=savedRecoveryCancellation==cancellation ? state:"stopping";publishApplicationRestoreReady()
            completion?(savedHealthRecoveryStatus())
            let again=savedWakeRequested;savedWakeRequested=false
            if again{DispatchQueue.main.async{[weak self] in self?.recoverSavedHealthOpportunity()}}
        }
    }
    private func refreshSavedRecoveryChoiceFlags(){
        guard let runtime=controlRuntime,let cached=runtime.savedHealthSelection else{return}
        // A known original foreground save is already exact Native metadata.
        // Expose only an opaque token for that SAME current owner; no IO/grant.
        if savedRecoveryChoices.isEmpty,let binding=controlBinding,current(binding),runtime.choiceSourceCurrent{
            savedRecoveryChoices=[(UUID(),cached,binding,runtime)]
        }
        for i in savedRecoveryChoices.indices{
            let row=savedRecoveryChoices[i],old=row.1
            if row.3 === runtime,old.origin==cached.origin,old.human==cached.human,old.endpoint==cached.endpoint,old.enrollment==cached.enrollment,old.namespace==cached.namespace{
                // The original Core keeps one saved row per enrollment. A known
                // same-owner replacement updates that row's exact scope; an old
                // review cannot authorize the new dates/types/revision.
                if old != cached{backgroundReview=nil}
                if old.policyRevision != cached.policyRevision || old.plans != cached.plans{savedRecoveryChoices[i].0=UUID()}
                savedRecoveryChoices[i].1=cached
            }
        }
    }
    func savedHealthRecoveryStatus()->[String:Any]{
        refreshSavedRecoveryChoiceFlags()
        let bound=controlBinding.map{authorityCurrent($0) && transport.epoch==$0.epoch} ?? false
        let runtime=savedForegroundAllowed && bound ? controlRuntime:nil,known=runtime?.savedSelectionPersistence ?? "notLoaded"
        let preference:String
        if known != "notLoaded"{preference=known}
        else if savedRecoveryChoices.count==1{let value=savedRecoveryChoices[0].1;preference=value.requiresRebind ? "requiresRebind":value.updatesEnabled ? "savedEnabled":"savedDisabled"}
        else{preference="notLoaded"}
        return reply(savedRecoveryJob==nil ? savedRecoveryState:"pending","saved_selection_only",["choices":savedRecoveryChoices.map{token,value,_,_ in ["choice":token.uuidString.lowercased(),"updatesEnabled":value.updatesEnabled,"requiresRebind":value.requiresRebind,"selectedCount":value.plans.count]},"continuity":"boundedForegroundRecovery","persistence":preference,"drain":savedRecoveryJob != nil || controlRuntime?.choiceAdmissionAvailable==false ? "pending":"drained"])
    }
    func savedHealthRecoveryChoice(input:[String:Any],completion:@escaping([String:Any])->Void){
        let operation=input["operation"] as? String
        if operation=="status",Set(input.keys)==["operation"]{completion(savedHealthRecoveryStatus());return}
        refreshSavedRecoveryChoiceFlags()
        guard ["restore","stop"].contains(operation ?? ""),Set(input.keys)==["operation","choice"],let raw=input["choice"] as? String,
              let row=savedRecoveryChoices.first(where:{$0.0.uuidString.lowercased()==raw}),!row.1.requiresRebind,
              savedForegroundAllowed,resources.protectedAvailable(),current(row.2),controlRuntime === row.3,controlBinding==row.2 else{completion(reply("unavailable","current_saved_choice_required"));return}
        if operation=="stop"{
            // A process-local cancellation of ONLY the pending recovery job, not
            // a new Auth/source/SDK authority or a fabricated query drain.
            guard savedRecoveryJob==nil || savedRecoveryEnrollment==nil || savedRecoveryEnrollment==row.1.enrollment else{completion(reply("unavailable","different_saved_recovery_selection"));return}
            guard row.3.stopSavedHealthSelection(row.1) else{completion(reply("unavailable","original_saved_choice_unavailable"));return}
            if savedRecoveryJob != nil{savedRecoveryCancellation &+= 1}
            savedRecoveryState="stopping";completion(savedHealthRecoveryStatus());return
        }
        recoverSavedHealthOpportunity(manualChoice:row.1,completion:completion)
    }
    /// Construction is inert. Only an original foreground/Auth/protection event
    /// or an explicit current saved-choice action enters this bounded lookup.
    /// No schedules, OS prompts, discovery or implicit changing date ranges.
    func recoverSavedHealthOpportunity(manualChoice:HealthOutbox.SavedHealthSelection?=nil,completion:(([String:Any])->Void)?=nil){
        precondition(Thread.isMainThread)
        guard (savedForegroundAllowed || savedBackgroundAllowed),resources.protectedAvailable(),resources.health != nil else{completion?(reply("unavailable","foreground_or_protection_required"));return}
        guard applicationRestoreCompletion==nil,savedRecoveryJob==nil,active==nil,!composed,!controlRetiring else{completion?(reply("unavailable","original_owner_busy"));return}
        if let runtime=controlRuntime,runtime.choiceSourceCurrent,runtime.configuration != nil,runtime.canContinueSavedHealthForeground,(savedForegroundAllowed || runtime.backgroundMayContinue){
            // A still-current owner is never replaced simply because the app
            // received another active notification. Existing interest coalesces.
            connection.setNativeHealthActivity(foreground:savedForegroundAllowed,eligibleBackground:savedBackgroundAllowed);completion?(savedHealthRecoveryStatus());return
        }
        let id=UUID();savedRecoveryJob=id;active=id;savedWakeRequested=false;savedRecoveryState="pending";savedRecoveryChoices=[];savedRecoveryEnrollment=nil
        let requestedGeneration=generation,requestedCancellation=savedRecoveryCancellation,epoch=transport.epoch,origin=transport.endpoint?.absoluteString
        func valid()->Bool{self.savedRecoveryJob==id && self.active==id && self.savedRecoveryCancellation==requestedCancellation && (self.savedForegroundAllowed || self.savedBackgroundAllowed) && self.resources.protectedAvailable() && self.generation==requestedGeneration && self.transport.epoch==epoch && self.transport.endpoint?.absoluteString==origin}
        func finish(_ state:String){finishSavedRecovery(id,state,cancellation:requestedCancellation,completion)}
        func bootstrap(){
            guard valid(),let origin else{finish("contextChanged");return}
            // This first authentic Auth read can restore the original effective
            // owner. No cached configuration substitutes for its strict result.
            transport.request("/api/auth/v1/user-context",maxBytes:65536){[self] result in
                guard valid(),case .success(let(data,http))=result,http.statusCode==200,
                      let object=try? JSONSerialization.jsonObject(with:data) as? [String:Any],let subject=object["context"] as? [String:Any],
                      let rawHuman=subject["actorId"] as? String,let human=UUID(uuidString:rawHuman),let rawSession=subject["authenticatedSessionId"] as? String,let session=UUID(uuidString:rawSession),
                      let auth=try? NativeCalendarContext.auth(data,human:human,session:session) else{finish("authenticationRequired");return}
                transport.request("/api/runtime/v1/session-context",maxBytes:65536){[self] result in
                    guard valid(),case .success(let(data,http))=result,http.statusCode==200,
                          let object=try? JSONSerialization.jsonObject(with:data) as? [String:Any],let endpoint=object["endpoint"] as? [String:Any],let raw=endpoint["endpointId"] as? String,let actual=UUID(uuidString:raw),
                          let context=try? NativeCalendarContext.session(data,auth:auth,endpoint:actual,epoch:epoch) else{finish("personalContextRequired");return}
                    let binding=Binding(origin:origin,human:human,session:session,endpoint:actual,epoch:epoch,generation:requestedGeneration,snapshot:context)
                    guard valid(),current(binding) else{finish("contextChanged");return}
                    do{
                        let runtime=try originalRoot(binding)
                        try runtime.prepareExistingHealthProfile(current:{valid() && self.current(binding)})
                        runtime.adoptSavedHealthLookup(requireSourceRebind:needsDurableSubjectRebind){[self] result in
                            guard valid(),current(binding),case .success = result else{finish("storageUnconfirmed");return}
                            // A known transition marker is now durably reflected
                            // in the same snapshot, or no saved map existed.
                            needsDurableSubjectRebind=false
                            runtime.readSavedHealthSelections{[self] result in
                                guard valid(),current(binding),case .success(let values)=result else{finish("storageUnavailable");return}
                                savedRecoveryChoices=values.map{(UUID(),$0,binding,runtime)}
                                let eligible=values.filter{$0.updatesEnabled && !$0.requiresRebind && (self.savedForegroundAllowed || $0.backgroundChoice?.enabled==true)}
                                let off=values.filter{$0.backgroundChoice?.enabled==false && !$0.requiresRebind}
                                if !self.savedForegroundAllowed,eligible.isEmpty,!off.isEmpty,let health=resources.health{
                                    runtime.cleanupSavedBackgroundChoices(off,makeSDK:{try self.savedHandbackSDK ?? health.makeSDK()}){[self] result in if case .success = result{savedHandbackSDK=nil;finish("backgroundCleanupOnly")}else{finish("backgroundCleanupUnconfirmed")}};return
                                }
                                let value:HealthOutbox.SavedHealthSelection
                                if let manualChoice{
                                    guard values.contains(manualChoice),!manualChoice.requiresRebind else{finish("savedChoiceChanged");return};value=manualChoice
                                }else{
                                    guard eligible.count==1 else{finish(values.contains(where:{$0.requiresRebind}) ? "requiresRebind":values.isEmpty ? "absent":"disabled");return};value=eligible[0]
                                }
                                savedRecoveryEnrollment=value.enrollment;restore(value,binding:binding,runtime:runtime)
                            }
                        }
                    }catch{finish("originalOwnerHeld")}
                }
            }
        }
        func restore(_ value:HealthOutbox.SavedHealthSelection,binding:Binding,runtime:NativeHealthRuntime){
            guard valid(),current(binding),let health=resources.health,let storage,
                  value.plans.allSatisfy({$0.mappingVersion==health.mappingVersion}) else{finish("savedChoiceChanged");return}
            NativeHealthInventory(transport:transport).fetch(expectedEndpoint:binding.endpoint){[self] result in
                guard valid(),current(binding),case .success(let inventory)=result,
                      let source=inventory.sources.first(where:{$0.namespace==value.namespace}),source.collector=="healthKit",source.currentEnrollment==value.enrollment,
                      source.policyRevision==value.policyRevision,source.currentState=="active",!source.collectionPaused,
                      Set(value.plans.map{$0.category=="sleep" ? "SleepSegment":$0.category}).isSubset(of:source.categories) else{finish("policyUnavailable");return}
                let root=runtime.rootConfiguration,handback=savedHandbackSDK
                let plans=value.plans.map{NativeHealthCollectionPlan(category:$0.category,scope:$0.scope,mappingVersion:$0.mappingVersion,start:$0.start,end:$0.end)}
                let config=NativeHealthRuntime.Configuration(provenance:root.provenance,origin:root.origin,human:root.human,session:root.session,endpoint:root.endpoint,enrollment:value.enrollment,plans:plans,maxBytes:root.maxBytes,maxEvents:root.maxEvents,storageOrigin:root.identity.storageOrigin,protectedFilePolicy:root.identity.protectedFilePolicy,protectedAvailable:resources.protectedAvailable,makeStorage:{try storage.openStorage()},makeSDK:{try handback ?? health.makeSDK()})
                let descriptor=NativeHealthSetupDescriptor(selector:"saved-health-"+UUID().uuidString.lowercased(),revision:value.policyRevision,title:"Apple Health",destinationLabel:binding.origin,namespace:value.namespace,configuration:config,localSetup:.confirmExistingLocal)
                guard valid(),let profile=NativeHealthConnectionOwner.Profile(descriptor:descriptor),connection.installHealthConfiguration(profile,runtime:runtime) else{finish("originalOwnerHeld");return}
                runtime.restoreSavedHealthSelection(value,configuration:config,manual:manualChoice != nil,current:{valid() && self.current(binding)}){[self] result in
                    DispatchQueue.main.async{[self] in
                        guard valid(),current(binding),case .success = result else{finish("policyOrLocalStateUnavailable");return}
                        savedHandbackSDK=nil
                        if value.updatesEnabled{
                            guard runtime.startObservation(configuration:config,namespace:value.namespace,revision:value.policyRevision,current:{[weak self,weak runtime] in guard let self,let runtime else{return false};return (self.savedForegroundAllowed || (self.savedBackgroundAllowed && runtime.backgroundMayContinue)) && self.current(binding) && self.controlRuntime === runtime && self.connection.host.runtime === runtime}) else{finish("updatesUnavailable");return}
                            // Restoration itself is one eligible foreground
                            // opportunity, independent of an initial OS notice.
                            runtime.setNativeHealthActivity(foreground:savedForegroundAllowed,eligibleBackground:savedBackgroundAllowed)
                        }
                        finish(value.updatesEnabled ? "restoredEnabled":"restoredManual")
                    }
                }
            }
        }
        // Same-process recovery first drains the ACTUAL original owner and
        // releases its one physical file, then hands the SAME SDK forward.
        if let old=controlRuntime,(controlBinding?.generation != requestedGeneration || !old.choiceSourceCurrent || !old.savedHealthControlAdmissionAvailable || old.configuration != nil){
            controlRetiring=true
            func released(_ result:Result<NativeHealthRuntime.RetiredSavedHealthResources,Error>){
                DispatchQueue.main.async{[self] in
                    guard controlRuntime === old else{return}
                    guard case .success(let resources)=result else{finish("originalOwnerHeld");return}
                    savedHandbackSDK=resources.sdk;controlRuntime=nil;controlBinding=nil;storage=nil;controlRetiring=false
                    guard valid() else{finish("contextChanged");return};bootstrap()
                }
            }
            if connection.hasHealthConfigurationForSavedRecovery{connection.retireHealthForSavedRecovery(original:old,completion:released)}
            else{old.retireForSavedHealthRecovery{do{released(.success(try old.takeRetiredSavedHealthResources()))}catch{released(.failure(error))}}}
        }else{bootstrap()}
    }
    func requestPermission(input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        guard input.isEmpty,let id=begin() else{completion(reply("unavailable","busy_or_invalid"));return}
        catalog=nil;preview=nil
        snapshot(id){[self] binding in
            guard let binding,current(binding),connection.canInstallCalendarConfiguration else{finish(id,reply("unavailable","context_changed"),completion);return}
            let original=sdk ?? resources.makeSDK();sdk=original
            guard current(binding),active==id else{finish(id,reply("unavailable","context_changed"),completion);return}
            let access=original.access(category:"CalendarEvent")
            guard current(binding),active==id else{finish(id,reply("unavailable","context_changed"),completion);return}
            if access != .notDetermined && access != .writeOnly{
                finish(id,reply("observed","capability_only",["attemptId":NSNull(),"requestState":"notInvoked","readAccess":access.rawValue]),completion);return
            }
            // Distinct bootstrap purpose, bound to the actual original current
            // self/session/phone endpoint. No root/source/enrollment is fabricated.
            let request=NativeCalendarReadPermissionRequest(sdk:original,category:"CalendarEvent")
            request.start(current:{self.active==id && self.current(binding) && self.connection.canInstallCalendarConfiguration}){[self,request] result in
                _=request
                snapshot(id){[self] after in
                    let valid=after==binding && current(binding),access=valid && !result.error ? original.access(category:"CalendarEvent"):.unknown
                    let stillCurrent=valid && current(binding)
                    finish(id,reply(stillCurrent ? "observed":"unavailable",stillCurrent ? "capability_only":"context_changed",["attemptId":result.invoked ? id.uuidString.lowercased() as Any:NSNull(),"requestState":result.invoked ? (stillCurrent ? "requestCompleted":"deferred"):"notInvoked","readAccess":stillCurrent ? access.rawValue:"unknown"]),completion)
                }
            }
        }
    }
    func discover(input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        if composed{
            guard input.isEmpty,active==nil else{completion(reply("unavailable","busy_or_invalid"));return}
            let id=UUID();active=id;generation &+= 1;let requestedGeneration=generation;catalog=nil;preview=nil
            connection.retireCalendarConfiguration{[self] ready in
                guard active==id else{return}
                if ready{composed=false;profile=nil}
                guard ready,generation==requestedGeneration else{finish(id,reply("unavailable",ready ? "context_changed":"original_owner_not_retired"),completion);return}
                // This continues the SAME explicit metadata action after actual
                // retirement, never an automatic event query or configuration save.
                active=nil;discover(input:input,completion:completion)
            }
            return
        }
        guard input.isEmpty,let id=begin() else{completion(reply("unavailable","busy_or_invalid"));return}
        catalog=nil;preview=nil
        snapshot(id){[self] binding in
            guard let binding,current(binding) else{finish(id,reply("unavailable","context_changed"),completion);return}
            let original=sdk ?? resources.makeSDK();sdk=original
            do{
                guard current(binding),active==id else{throw NativeCalendarAdmissionError.stale}
                let access=original.access(category:"CalendarEvent")
                guard access == .fullRead,current(binding),active==id else{throw NativeCalendarAdmissionError.stale}
                let values=try original.eventCalendars(current:{[self] in active==id && current(binding)})
                guard current(binding),active==id else{throw NativeCalendarAdmissionError.stale}
                let zone=original.capturedDefaultTimeZone
                guard values.count<=256,values.allSatisfy(\.valid),Set(values.map{Data($0.containerID.utf8)}).count==values.count,current(binding) else{throw NativeCalendarAdmissionError.invalid}
                snapshot(id){[self] after in
                    guard after==binding,current(binding) else{finish(id,reply("unavailable","context_changed"),completion);return}
                    let captured=Catalog(binding,original,zone,values);catalog=captured
                    let rows=captured.records.map{handle,metadata in metadata.json.merging(["choice":handle.uuidString.lowercased(),"selected":false]){_,new in new}}
                    let value=reply("available","metadata_only",["catalogId":captured.id.uuidString.lowercased(),"choices":rows,"limits":resources.limits.json,"syncWindow":knownSettings?.json as Any? ?? NSNull()])
                    guard let bytes=try? JSONSerialization.data(withJSONObject:value),bytes.count<=262144 else{catalog=nil;finish(id,reply("unavailable","metadata_limit"),completion);return}
                    finish(id,value,completion)
                }
            }catch{finish(id,reply("unavailable","reading_or_metadata_unavailable"),completion)}
        }
    }
    func prepare(input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        guard Set(input.keys)==Set(["schemaVersion","catalogId","choices","syncWindow"]),input["schemaVersion"] as? String=="1.0.0",let catalog,let raw=input["catalogId"] as? String,raw==catalog.id.uuidString.lowercased(),let handles=input["choices"] as? [String],!handles.isEmpty,handles.count<=resources.limits.maxSelectedCalendars,Set(handles).count==handles.count,
              let settingsJSON=input["syncWindow"] as? [String:Any],let settings=MobileCalendarSyncWindow(settingsJSON),current(catalog.binding),let id=begin() else{completion(reply("unavailable","invalid_or_stale_selection"));return}
        preview=nil
        let chosen=handles.compactMap{key in catalog.records.first{$0.0.uuidString.lowercased()==key}?.1}
        guard chosen.count==handles.count else{finish(id,reply("unavailable","invalid_or_stale_selection"),completion);return}
        snapshot(id){[self] binding in
            do{
                guard binding==catalog.binding,self.catalog === catalog,current(catalog.binding),active==id else{throw NativeCalendarAdmissionError.stale}
                let access=catalog.sdk.access(category:"CalendarEvent")
                guard access == .fullRead,current(catalog.binding),active==id,self.catalog === catalog else{throw NativeCalendarAdmissionError.stale}
                let now=try catalog.sdk.eventCalendars(current:{[self] in active==id && current(catalog.binding) && self.catalog === catalog})
                guard chosen.allSatisfy({selected in now.filter{$0==selected}.count==1}),current(catalog.binding),let plan=settings.plan(anchor:resources.clock(),selectedCalendars:chosen.count,limits:resources.limits) else{throw NativeCalendarAdmissionError.invalid}
                guard current(catalog.binding),self.catalog === catalog else{throw NativeCalendarAdmissionError.stale}
                let original=Preview(catalog,chosen,plan);preview=original
                let windows=plan.windows.map{["start":MobileCalendarSyncScope.timestamp($0.start)!,"endExclusive":MobileCalendarSyncScope.timestamp($0.end)!]}
                finish(id,reply("prepared","explicit_save_required",["previewId":original.id.uuidString.lowercased(),"syncWindow":settings.json,"settingsState":"requestedNotSaved","anchor":MobileCalendarSyncScope.timestamp(plan.anchor)!,"windows":windows,"limits":resources.limits.json,"selectedCount":chosen.count,"coverage":"partialObservations","activation":"unavailable"]),completion)
            }catch{finish(id,reply("unavailable","selection_or_range_unavailable"),completion)}
        }
    }
    private func compose(preview:Preview,enrollment:UUID,namespace:UUID,revision:Int,terminal:MobileCalendarSettingsWire.Terminal?)->Bool{
        let b=preview.catalog.binding,r=resources
        let identity=NativeHealthRuntime.RootConfiguration.Identity(provenance:"native-calendar-source/1",origin:b.origin,human:b.human,session:b.session,endpoint:b.endpoint,maxBytes:r.maxBytes,maxEvents:r.maxEvents,storageOrigin:b.origin,protectedFilePolicy:"complete-file-protection/exclusive-original/1")
        let original:NativeProtectedCalendarStorage
        if let retained=storage{guard retained.identity==identity else{return false};original=retained}
        else{return false} // Save must already own the original file/custody object.
        let root=NativeHealthRuntime.RootConfiguration(identity:identity,protectedAvailable:r.protectedAvailable,makeStorage:{try original.openStorage()})
        guard root.valid,let scope=MobileCalendarSyncScope(containers:preview.selected.map{.init(id:$0.containerID,accountID:$0.sourceID)},start:preview.plan.start,end:preview.plan.end,mappingVersion:r.mappingVersion) else{return false}
        guard let selection=MobileCalendarSettingsWire.Selection(principal:b.human,endpoint:b.endpoint,enrollment:enrollment,namespace:namespace,revision:revision,calendars:preview.selected.map{.init(containerID:$0.containerID,accountID:$0.sourceID)}) else{return false}
        let run=MobileCalendarSettingsWire.Run(selection:selection,snapshot:preview.plan)
        var saved:[NativeCalendarSavedDescriptor]=[]
        for (index,window) in preview.plan.windows.enumerated(){
            let plan=MobileEventKitAcquisition.Plan(category:"CalendarEvent",selectedContainerIDs:preview.selected.map(\.containerID),mappingVersion:r.mappingVersion,coverageStart:window.start,coverageEnd:window.end,capturedSDKDefaultTimeZone:preview.catalog.zone)
            let source=NativeCalendarAcquisitionOwner.Configuration(provenance:"native-calendar-source/1",origin:b.origin,human:b.human,session:b.session,endpoint:b.endpoint,enrollment:enrollment,namespace:namespace,plan:plan,protectedAvailable:r.protectedAvailable,deliveryScope:scope,scopedRun:run,configuredTerminal:terminal,deliveryContract:r.deliveryContract)
            let config=NativeHealthRuntime.CalendarConfiguration(configuration:source,custody:{storage,binding in try original.acquire(storage:storage,binding:binding)},makeAcquisition:nil,captureClock:r.clock)
            let categories:Set<String>=["CalendarEvent"],selector="calendar-window-\(index)",runtimeSelection="original-calendar-root"
            let reconnect=NativeHealthRuntime.CalendarReconnect(owner:self,currency:.init(owner:self,binding:.init(root:identity,configuration:source,selected:categories,kind:.reconnectExistingLocal)),expectedSavedCategories:categories)
            let collection=NativeCalendarCollectionPort(owner:self,makeAcquisition:{[weak self] outbox in guard self?.current(b)==true else{return nil};return preview.catalog.sdk.acquisition(outbox:outbox,selected:preview.selected,current:{[weak self] in self?.current(b)==true})})
            saved.append(.init(selector:selector,label:"Calendar observation window \(index+1)",destinationLabel:b.origin,selection:.init(runtimeSelection:runtimeSelection,configuration:config,reconnect:reconnect),collection:collection))

        }
        guard let profile=NativeCalendarSavedProfile(root:root,descriptors:saved),connection.installCalendarConfiguration(profile) else{return false}
        self.profile=profile;storage=original;composed=true;return true
    }

    /// The original concrete protected-file object survives every generation.
    /// A path, parsed terminal or displayed settings never substitutes for custody.
    private func originalRoot(_ b:Binding)throws->NativeHealthRuntime{
        if let runtime=controlRuntime{guard controlBinding==b,!controlRetiring else{throw NativeCalendarAdmissionError.stale};return runtime}
        guard connection.canInstallCalendarConfiguration,!composed,!controlRetiring else{throw NativeCalendarAdmissionError.unavailable}
        let r=resources,identity=NativeHealthRuntime.RootConfiguration.Identity(provenance:"native-calendar-source/1",origin:b.origin,human:b.human,session:b.session,endpoint:b.endpoint,maxBytes:r.maxBytes,maxEvents:r.maxEvents,storageOrigin:b.origin,protectedFilePolicy:"complete-file-protection/exclusive-original/1")
        let original:NativeProtectedCalendarStorage
        if let retained=storage{guard retained.identity==identity else{throw NativeCalendarAdmissionError.stale};original=retained}
        else{
            guard current(b),r.protectedAvailable(),current(b) else{throw NativeCalendarAdmissionError.stale}
            let file=try r.resolveFile({[weak self] in self?.current(b)==true})
            guard current(b),connection.canInstallCalendarConfiguration else{throw NativeCalendarAdmissionError.stale}
            original=NativeProtectedCalendarStorage(identity:identity,file:file,port:r.filePort,protectedAvailable:r.protectedAvailable,current:{[weak self] in self?.authorityCurrent(b)==true});storage=original
        }
        let runtime=try NativeHealthRuntime.makeRoot(configuration:.init(identity:identity,protectedAvailable:r.protectedAvailable,makeStorage:{try original.openStorage()}),transport:transport)
        controlRuntime=runtime;controlBinding=b;return runtime
    }
    private func control(_ command:MobileCalendarSettingsWire.Command?,reconcile:Bool,id:UUID,binding:Binding,runtime:NativeHealthRuntime,done:@escaping(NativeHealthRuntime.NativeCommandOutcome)->Void){
        guard let original=storage,controlRuntime === runtime,current(binding),active==id else{done(.held(command?.operationID,"context_changed"));return}
        runtime.calendarNativeCommand(command:command,reconcile:reconcile,custody:{storage,b in try original.acquire(storage:storage,binding:b)},owner:self,current:{[weak self,weak runtime] in guard let self,let runtime else{return false};return self.active==id && self.current(binding) && self.controlRuntime === runtime},makeCurrency:{[weak self] b in guard let self,self.active==id,self.current(binding) else{return nil};return .init(owner:self,binding:b)}){value in
            // Follow the complete Runtime completion/publication frame before
            // entering another original command, admission or retirement.
            DispatchQueue.main.async{done(value)}
        }
    }
    private func command(_ b:Binding,enrollment:MobileCalendarSettingsWire.Enrollment?,action:[String:Any])throws->MobileCalendarSettingsWire.Command{
        try MobileCalendarSettingsWire.envelope(payload:["schemaVersion":"1.0.0","operationId":UUID().uuidString.lowercased(),"target":["principalId":b.human.uuidString.lowercased(),"endpointId":b.endpoint.uuidString.lowercased(),"collector":"eventKit","enrollmentId":enrollment?.id.uuidString.lowercased() as Any? ?? NSNull(),"sourceNamespace":enrollment?.namespace?.uuidString.lowercased() as Any? ?? NSNull(),"expectedRevision":enrollment?.revision ?? 0],"action":action])
    }
    private func retireControl(_ runtime:NativeHealthRuntime,done:@escaping()->Void){
        if connection.configuredHealthSettingsControl,controlRuntime === runtime{DispatchQueue.main.async{done()};return}
        guard controlRuntime === runtime,!controlRetiring else{return};controlRetiring=true
        runtime.retire(authorityChanged:false){[self] in
            // Unknown writes/never callbacks never reach this publication.
            DispatchQueue.main.async{[self] in guard controlRuntime === runtime else{return};controlRuntime=nil;controlBinding=nil;controlRetiring=false;done()}
        }
    }
    private func finishControl(_ id:UUID,_ value:[String:Any],_ completion:@escaping([String:Any])->Void){
        let binding=controlReplyBinding
        DispatchQueue.main.async{[self] in
            guard active==id else{return};active=nil;controlReplyBinding=nil;publishApplicationRestoreReady()
            guard let binding,authorityCurrent(binding),transport.epoch==binding.epoch else{completion(reply("unavailable","context_changed"));return}
            var final=value
            if !current(binding),final["activation"] as? String=="manualOnly"{final["activation"]="unavailable";final["reason"]="saved_context_changed"}
            completion(final)
        }
    }
    private func controlFailed(_ outcome:NativeHealthRuntime.NativeCommandOutcome,id:UUID,runtime:NativeHealthRuntime,completion:@escaping([String:Any])->Void){
        switch outcome{
        case .held(let operation,let reason):finishControl(id,reply("held",reason,["operationId":operation?.uuidString.lowercased() as Any? ?? NSNull(),"settingsState":"unconfirmed","activation":"unavailable"]),completion)
        case .notApplied(let reason):retireControl(runtime){[self] in finishControl(id,reply("unavailable",reason),completion)}
        case .terminal,.consent,.healthConsent,.healthControl,.healthLocal:retireControl(runtime){[self] in finishControl(id,reply("unavailable","original_terminal_not_current"),completion)}
        }
    }
    /// Explicit user intent only. No event query, grants, assistant use, unpause,
    /// rebind, reset or implicit replay. Existing remote enrollment is reused by
    /// the producing enroll command; an unbound one alone gets its first source.
    func save(input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        guard Set(input.keys)==Set(["schemaVersion","previewId"]),input["schemaVersion"] as? String=="1.0.0",let preview,input["previewId"] as? String==preview.id.uuidString.lowercased(),self.catalog === preview.catalog,current(preview.catalog.binding),let id=begin() else{completion(reply(controlRuntime==nil ? "unavailable":"held","invalid_stale_or_original_held"));return}
        let b=preview.catalog.binding;controlReplyBinding=b
        snapshot(id){[self] actual in
            do{
                guard actual==b,current(b),active==id else{throw NativeCalendarAdmissionError.stale}
                let access=preview.catalog.sdk.access(category:"CalendarEvent")
                guard access == .fullRead,current(b),active==id,self.preview === preview else{throw NativeCalendarAdmissionError.stale}
                let metadata=try preview.catalog.sdk.eventCalendars(current:{[self] in active==id && current(b) && self.preview === preview})
                guard metadata.count<=256,preview.selected.allSatisfy({selected in metadata.filter{$0==selected}.count==1}),current(b) else{throw NativeCalendarAdmissionError.stale}
                let runtime=try originalRoot(b),enroll=try command(b,enrollment:nil,action:["kind":"enroll"])
                control(enroll,reconcile:false,id:id,binding:b,runtime:runtime){[self] outcome in
                    guard case .terminal(let terminal)=outcome,terminal.applied,terminal.current,let enrollment=terminal.enrollment,current(b) else{controlFailed(outcome,id:id,runtime:runtime,completion:completion);return}
                    if enrollment.namespace==nil{
                        do{let bind=try command(b,enrollment:enrollment,action:["kind":"bindSource","binding":["createNew":true]])
                            control(bind,reconcile:false,id:id,binding:b,runtime:runtime){[self] result in
                                guard case .terminal(let terminal)=result,terminal.applied,terminal.current,let bound=terminal.enrollment,bound.namespace != nil,current(b) else{controlFailed(result,id:id,runtime:runtime,completion:completion);return}
                                configure(preview,bound,id:id,runtime:runtime,completion:completion)
                            }
                        }catch{controlFailed(.notApplied("binding_unavailable"),id:id,runtime:runtime,completion:completion)}
                    }else{configure(preview,enrollment,id:id,runtime:runtime,completion:completion)}
                }
            }catch{finish(id,reply("unavailable","configuration_unavailable"),completion)}
        }
    }
    private func configure(_ preview:Preview,_ enrollment:MobileCalendarSettingsWire.Enrollment,id:UUID,runtime:NativeHealthRuntime,completion:@escaping([String:Any])->Void){
        let b=preview.catalog.binding
        do{
            guard current(b),active==id,let config=try JSONSerialization.jsonObject(with:enrollment.configuration) as? [String:Any],let categories=config["categories"] as? [String],categories.isEmpty || categories==["CalendarEvent"],(config["uses"] as? [String])?.isEmpty==true,(config["assistantIds"] as? [String])?.isEmpty==true,config["usePaused"] as? Bool==true,["active","disconnected"].contains(enrollment.state) else{throw NativeCalendarAdmissionError.unavailable}
            let source:[String:Any]=["categories":["CalendarEvent"],"uses":[],"assistantIds":[],"collectionPaused":enrollment.collectionPaused,"usePaused":true]
            let configure=try command(b,enrollment:enrollment,action:["kind":"configure","state":enrollment.state,"configuration":["sourceConfiguration":source,"syncWindow":preview.plan.settings.json]])
            control(configure,reconcile:false,id:id,binding:b,runtime:runtime){[self] outcome in
                guard case .terminal(let terminal)=outcome,terminal.applied,terminal.current,terminal.window==preview.plan.settings,current(b) else{controlFailed(outcome,id:id,runtime:runtime,completion:completion);return}
                knownSettings=terminal.window
                adopt(preview,terminal,id:id,runtime:runtime,completion:completion)
            }
        }catch{controlFailed(.notApplied("existing_configuration_requires_review"),id:id,runtime:runtime,completion:completion)}
    }
    private func adopt(_ preview:Preview,_ terminal:MobileCalendarSettingsWire.Terminal,id:UUID,runtime:NativeHealthRuntime,completion:@escaping([String:Any])->Void){
        let b=preview.catalog.binding,r=resources
        guard let enrollment=terminal.enrollment,let namespace=enrollment.namespace,let original=storage,let scope=MobileCalendarSyncScope(containers:preview.selected.map{.init(id:$0.containerID,accountID:$0.sourceID)},start:preview.plan.start,end:preview.plan.end,mappingVersion:r.mappingVersion),let selection=MobileCalendarSettingsWire.Selection(principal:b.human,endpoint:b.endpoint,enrollment:enrollment.id,namespace:namespace,revision:enrollment.revision,calendars:preview.selected.map{.init(containerID:$0.containerID,accountID:$0.sourceID)}),let window=preview.plan.windows.first else{controlFailed(.notApplied("local_selection_unavailable"),id:id,runtime:runtime,completion:completion);return}
        let run=MobileCalendarSettingsWire.Run(selection:selection,snapshot:preview.plan),plan=MobileEventKitAcquisition.Plan(category:"CalendarEvent",selectedContainerIDs:preview.selected.map(\.containerID),mappingVersion:r.mappingVersion,coverageStart:window.start,coverageEnd:window.end,capturedSDKDefaultTimeZone:preview.catalog.zone)
        let source=NativeCalendarAcquisitionOwner.Configuration(provenance:"native-calendar-source/1",origin:b.origin,human:b.human,session:b.session,endpoint:b.endpoint,enrollment:enrollment.id,namespace:namespace,plan:plan,protectedAvailable:r.protectedAvailable,deliveryScope:scope,scopedRun:run,configuredTerminal:terminal,deliveryContract:r.deliveryContract),config=NativeHealthRuntime.CalendarConfiguration(configuration:source,custody:{storage,b in try original.acquire(storage:storage,binding:b)},makeAcquisition:nil,captureClock:r.clock)
        let update=NativeHealthRuntime.CalendarSetup(owner:self,currency:.init(owner:self,binding:.init(root:runtime.rootConfiguration.identity,configuration:source,selected:["CalendarEvent"],kind:.applyConfiguredExistingLocal)),selectedCategories:["CalendarEvent"])
        runtime.applyConfiguredCalendar(supplied:config,update:update,selector:"configured-calendar-selection",fresh:{[self] in active==id && current(b) && self.preview === preview && controlRuntime === runtime}){[self] result in
            // A known configured terminal stays saved if local policy or pause
            // denies admission. Ambiguous local writes keep this SAME owner.
            if result.persistence == .unconfirmed{
                finishControl(id,reply("held","local_persistence_unconfirmed",["settingsState":"saved","syncWindow":preview.plan.settings.json,"activation":"unavailable"]),completion);return
            }
            retireControl(runtime){[self] in
                let installed=result.persistence == .saved && result.availability == .available && current(b) && compose(preview:preview,enrollment:enrollment.id,namespace:namespace,revision:enrollment.revision,terminal:terminal)
                finishControl(id,reply("saved",installed ? "saved_manual_collection_only":"saved_local_unavailable",["settingsState":"saved","syncWindow":preview.plan.settings.json,"localPersistence":result.persistence.rawValue,"activation":installed ? "manualOnly":"unavailable","coverage":"partialObservations"]),completion)
            }
        }
    }
    /// Explicit exact-original reconciliation also reloads a prior saved setting.
    /// It never replays a mutation or auto-continues enrollment/configuration.
    func reconcile(input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        guard input.isEmpty,active==nil,!composed,!controlRetiring,connection.canInstallCalendarConfiguration,controlRuntime?.nativeCommandCanReconcile != false else{completion(reply("held","original_owner_unavailable"));return}
        let id=UUID();active=id;controlReplyBinding=nil
        snapshot(id){[self] actual in
            do{
                guard let actual,current(actual) else{throw NativeCalendarAdmissionError.stale}
                let runtime:NativeHealthRuntime,b:Binding
                if let retained=controlRuntime,let binding=controlBinding{guard authorityCurrent(binding),binding.snapshot==actual.snapshot,binding.epoch==actual.epoch,binding.origin==actual.origin,binding.human==actual.human,binding.session==actual.session,binding.endpoint==actual.endpoint else{throw NativeCalendarAdmissionError.stale};runtime=retained;b=actual;controlBinding=actual}
                else{runtime=try originalRoot(actual);b=actual}
                controlReplyBinding=b
                control(nil,reconcile:true,id:id,binding:b,runtime:runtime){[self] outcome in
                    guard case .terminal(let terminal)=outcome else{controlFailed(outcome,id:id,runtime:runtime,completion:completion);return}
                    if terminal.current && terminal.applied{knownSettings=terminal.window}
                    retireControl(runtime){[self] in finishControl(id,reply("reconciled","review_before_next_action",["settingsState":terminal.applied ? "saved":"rejected","syncWindow":terminal.window?.json as Any? ?? NSNull(),"activation":"unavailable"]),completion)}
                }
            }catch{finishControl(id,reply("held","original_context_unavailable"),completion)}
        }
    }
}


extension NativeCalendarSourceOwner {
    private func consentControl(_ command:MobileCalendarSourceConsent.Original?=nil,read:Data?=nil,reconcile:Bool=false,id:UUID,binding:Binding,runtime:NativeHealthRuntime,done:@escaping(NativeHealthRuntime.NativeCommandOutcome)->Void){
        guard let original=storage,controlRuntime === runtime,current(binding),active==id else{done(.held(command?.operationID,"context_changed"));return}
        runtime.calendarNativeConsent(command:command,read:read,reconcile:reconcile,custody:{storage,b in try original.acquire(storage:storage,binding:b)},owner:self,current:{[weak self,weak runtime] in guard let self,let runtime else{return false};return self.active==id && self.current(binding) && self.controlRuntime === runtime},makeCurrency:{[weak self] b in guard let self,self.active==id,self.current(binding) else{return nil};return .init(owner:self,binding:b)}){outcome in DispatchQueue.main.async{done(outcome)}}
    }
    private func consentFinish(_ outcome:NativeHealthRuntime.NativeCommandOutcome,id:UUID,runtime:NativeHealthRuntime,completion:@escaping([String:Any])->Void){
        switch outcome{
        case .held(let op,let reason):finishControl(id,reply("held",reason,["operationId":op?.uuidString.lowercased() as Any? ?? NSNull(),"activation":"unavailable"]),completion)
        default:retireControl(runtime){[self] in finishControl(id,reply("unavailable","consent_unavailable"),completion)}
        }
    }
    private func validDescriptor(_ d:MobileCalendarSourceConsent.Descriptor,_ b:Binding,_ e:MobileCalendarSettingsWire.Enrollment)->Bool{
        guard let subject=try? JSONSerialization.jsonObject(with:b.snapshot.subject) as? [String:Any] else{return false}
        return d.principal==b.human && d.endpoint==b.endpoint && d.enrollment==e.id && d.namespace==e.namespace && d.sourceRevision==e.revision && UUID(uuidString:subject["installationId"] as? String ?? "")==d.installation
    }
    private func consentProjection(_ review:ConsentReview)->[String:Any]{
        var value=reply("review","explicit_choice_required",["reviewId":review.id.uuidString.lowercased(),"source":review.descriptor.json,"serverOrigin":review.binding.origin,"statuses":review.statuses.map{["purpose":$0.scope.purpose.rawValue,"consentState":$0.state,"revision":$0.revision,"validity":$0.validity?.json as Any? ?? NSNull()]},"activation":"unavailable"])
        if let reserved=review.reserved{
            value["request"]=reserved.original.json;value["confirmationDigest"]=reserved.confirmation;value["approvalAvailable"]=reserved.approvalAvailable
        }
        return value
    }
    /// Descriptor is obtained only from the authenticated producing owner after
    /// exact old-command reconciliation. No URL-derived deployment identities.
    private func inspectConsent(id:UUID,binding b:Binding,runtime:NativeHealthRuntime,enrollment e:MobileCalendarSettingsWire.Enrollment,done:@escaping(ConsentReview?)->Void){
        guard let body=try? MobileCalendarSourceConsent.describe(enrollment:e.id) else{done(nil);return}
        consentControl(read:body,id:id,binding:b,runtime:runtime){[self] value in
            guard case .consent(.descriptor(let descriptor))=value,validDescriptor(descriptor,b,e),current(b) else{done(nil);return}
            func inspect(_ purposes:[MobileCalendarSourceConsent.Purpose],_ statuses:[MobileCalendarSourceConsent.Status]){
                guard let purpose=purposes.first else{done(.init(id:UUID(),binding:b,descriptor:descriptor,statuses:statuses));return}
                do{let scope=try descriptor.scope(purpose:purpose)
                    consentControl(read:try MobileCalendarSourceConsent.inspect(scope),id:id,binding:b,runtime:runtime){value in
                        guard case .consent(.status(let status))=value,status.scope==scope,self.current(b) else{done(nil);return};inspect(Array(purposes.dropFirst()),statuses+[status])
                    }
                }catch{done(nil)}
            }
            inspect([.collection,.transmission],[])
        }
    }
    /// Observation only: denial is a valid original policy response, not a
    /// prerequisite grant for connecting a paused source. Admission still uses
    /// the unchanged original policy owner after a known configure terminal.
    private func observeSourcePolicy(id:UUID,binding b:Binding,runtime:NativeHealthRuntime,enrollment e:MobileCalendarSettingsWire.Enrollment,done:@escaping(Bool?)->Void){
        func current()->Bool{self.active==id && self.current(b) && self.controlRuntime === runtime}
        func finish(_ allowed:Bool?){DispatchQueue.main.async{done(current() ? allowed:nil)}}
        snapshot(id){[self] before in
            guard before==b,current(),resources.protectedAvailable(),current(),let body=try? MobileCalendarSourceConsent.canonical(["producerPin":["schemaId":MobileCalendarDelivery.schemaId,"schemaVersion":"1.0.0","digest":MobileCalendarDelivery.schemaDigest],"operation":"calendar","payload":["schemaVersion":"1.0.0","operation":"policy","enrollmentId":e.id.uuidString.lowercased()]]) else{finish(nil);return}
            var claimed=false
            transport.request("/api/runtime/v1/mobile-context",method:"POST",body:String(data:body,encoding:.utf8),internalHealth:true,maxBytes:65536){[self] result in
                guard !claimed else{return};claimed=true
                guard current(),case .success(let(data,http))=result,http.statusCode==200,
                      let numbers=try? NativeCalendarSnapshotNumbers(data),let value=try? JSONSerialization.jsonObject(with:data) as? [String:Any],Set(value.keys)==Set(["schemaVersion","producerPin","result"]),value["schemaVersion"] as? String=="1.0.0",value["producerPin"] as? [String:String]==["schemaId":MobileCalendarDelivery.schemaId,"schemaVersion":"1.0.0","digest":MobileCalendarDelivery.schemaDigest],
                      let result=value["result"] as? [String:Any],Set(result.keys)==Set(["kind","enrollment","effective"]),result["kind"] as? String=="policy",let source=result["enrollment"] as? [String:Any],Set(source.keys)==Set(["enrollmentId","principalId","endpointId","collector","sourceNamespace","revision","state","configuration"]),UUID(uuidString:source["enrollmentId"] as? String ?? "")==e.id,UUID(uuidString:source["principalId"] as? String ?? "")==b.human,UUID(uuidString:source["endpointId"] as? String ?? "")==b.endpoint,source["collector"] as? String=="eventKit",UUID(uuidString:source["sourceNamespace"] as? String ?? "")==e.namespace,NativeCalendarContext.number(source["revision"],numbers,["result","enrollment","revision"])==e.revision,source["state"] as? String==e.state,
                      let config=source["configuration"] as? [String:Any],let canonical=try? MobileCalendarSourceConsent.canonical(config),canonical==e.configuration,
                      let effective=result["effective"] as? [String:Any],Set(effective.keys)==Set(["policyRevision","sourceBound","policyAvailable","policyBindingDigest","collectionAllowed","categories","uses","assistantIds","sourceNamespace"]),NativeCalendarContext.number(effective["policyRevision"],numbers,["result","effective","policyRevision"])==e.revision,UUID(uuidString:effective["sourceNamespace"] as? String ?? "")==e.namespace,NativeCalendarContext.bool(effective["sourceBound"],true),
                      NativeCalendarContext.bool(effective["policyAvailable"],true) || NativeCalendarContext.bool(effective["policyAvailable"],false),NativeCalendarContext.bool(effective["collectionAllowed"],true) || NativeCalendarContext.bool(effective["collectionAllowed"],false),
                      let categories=effective["categories"] as? [String],Set(categories).count==categories.count,Set(categories).isSubset(of:Set(config["categories"] as? [String] ?? [])),let uses=effective["uses"] as? [String],uses.isEmpty,let assistants=effective["assistantIds"] as? [String],assistants.isEmpty else{finish(nil);return}
                let available=NativeCalendarContext.bool(effective["policyAvailable"],true),allowed=NativeCalendarContext.bool(effective["collectionAllowed"],true)
                guard available ? ((effective["policyBindingDigest"] as? String)?.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil):(effective["policyBindingDigest"] is NSNull),!allowed || (available && (try? NativeCalendarContext.policy(data,human:b.human,endpoint:b.endpoint,enrollment:e.id)) != nil) else{finish(nil);return}
                snapshot(id){after in guard after==b,current() else{finish(nil);return};finish(allowed)}
            }
        }
    }
    /// All actions below are explicit and disjoint from Save, OS access and Sync.
    /// Only typed handles return from JS; scopes/IDs/authority come from Native.
    func sourceConsent(operation:String,input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        if composed{
            guard active==nil,input.isEmpty,["load","connectionReview"].contains(operation) else{completion(reply("unavailable","busy_or_invalid"));return}
            let token=UUID();active=token;generation &+= 1;let expected=generation
            connection.retireCalendarConfiguration{[self] ready in
                guard active==token else{return};if ready{composed=false;profile=nil}
                active=nil;publishApplicationRestoreReady();guard ready,generation==expected else{completion(reply("unavailable","original_owner_not_retired"));return}
                consentReview=nil;connectionReview=nil;sourceConsent(operation:operation,input:input,completion:completion)
            };return
        }
        let recover=operation=="recover"
        guard active==nil,!controlRetiring,connection.canInstallCalendarConfiguration,
              recover ? (input.isEmpty && controlRuntime?.nativeCommandCanReconcile != false):(controlRuntime==nil),
              ["load","request","confirm","revoke","recover","connectionReview","connect"].contains(operation) else{completion(reply("held","original_owner_unavailable"));return}
        let prior=consentReview,connect=connectionReview
        if ["load","connectionReview"].contains(operation){guard input.isEmpty else{completion(reply("unavailable","invalid_input"));return};consentReview=nil;connectionReview=nil}
        else if !recover{
            let expected:Set<String>=operation=="request" ? ["reviewId","purpose","validity","reviewDeadlineAt"]:operation=="revoke" ? ["reviewId","purpose","humanConfirmed"]:operation=="connect" ? ["connectionId","humanConfirmed"]:["reviewId","humanConfirmed"]
            guard Set(input.keys)==expected else{completion(reply("unavailable","invalid_input"));return}
            if ["confirm","revoke","connect"].contains(operation){guard NativeCalendarContext.bool(input["humanConfirmed"],true) else{completion(reply("unavailable","explicit_confirmation_required"));return}}
            if operation=="connect"{guard let connect,input["connectionId"] as? String==connect.id.uuidString.lowercased(),input["humanConfirmed"] as? Bool==true,current(connect.binding) else{completion(reply("unavailable","stale_review"));return}}
            else{guard let prior,input["reviewId"] as? String==prior.id.uuidString.lowercased(),current(prior.binding) else{completion(reply("unavailable","stale_review"));return}}
            consentReview=nil;connectionReview=nil
        }
        let id=UUID();active=id;controlReplyBinding=nil
        snapshot(id){[self] actual in
            do{
                guard let b=actual,current(b) else{throw NativeCalendarAdmissionError.stale}
                if !recover,let expected=operation=="connect" ? connect?.binding:prior?.binding,!["load","connectionReview"].contains(operation){guard b==expected else{throw NativeCalendarAdmissionError.stale}}
                let runtime:NativeHealthRuntime
                if recover,let retained=controlRuntime,let binding=controlBinding{
                    guard authorityCurrent(binding),binding.snapshot==b.snapshot,binding.epoch==b.epoch,binding.origin==b.origin,binding.human==b.human,binding.session==b.session,binding.endpoint==b.endpoint else{throw NativeCalendarAdmissionError.stale};runtime=retained;controlBinding=b
                }else{runtime=try originalRoot(b)}
                controlReplyBinding=b
                if recover{
                    consentControl(reconcile:true,id:id,binding:b,runtime:runtime){[self] result in
                        if case .consent(.reserved(let reserved))=result{
                            control(nil,reconcile:true,id:id,binding:b,runtime:runtime){[self] original in
                                guard case .terminal(let terminal)=original,terminal.current,terminal.applied,let e=terminal.enrollment else{controlFailed(original,id:id,runtime:runtime,completion:completion);return}
                                inspectConsent(id:id,binding:b,runtime:runtime,enrollment:e){[self] fresh in
                                    guard var fresh,let scope=try? fresh.descriptor.scope(purpose:reserved.original.scope.purpose),scope==reserved.original.scope,fresh.statuses.contains(where:{$0.scope==scope && $0.revision==reserved.original.revision}) else{consentFinish(.notApplied("review_changed"),id:id,runtime:runtime,completion:completion);return}
                                    fresh.reserved=reserved;consentReview=fresh
                                    retireControl(runtime){[self] in finishControl(id,consentProjection(fresh),completion)}
                                }
                            }
                        }else if case .consent(.terminal(let terminal))=result{
                            retireControl(runtime){[self] in finishControl(id,reply("recorded","decision_recorded_only",["purpose":terminal.original.scope.purpose.rawValue,"decision":terminal.original.kind == .revoke ? "revoked":"approved","activation":"unavailable"]),completion)}
                        }else{consentFinish(result,id:id,runtime:runtime,completion:completion)}
                    };return
                }
                control(nil,reconcile:true,id:id,binding:b,runtime:runtime){[self] original in
                    guard case .terminal(let terminal)=original,terminal.applied,terminal.current,let e=terminal.enrollment,e.namespace != nil else{controlFailed(original,id:id,runtime:runtime,completion:completion);return}
                    inspectConsent(id:id,binding:b,runtime:runtime,enrollment:e){[self] fresh in
                        guard let fresh,current(b) else{consentFinish(.notApplied("source_unavailable"),id:id,runtime:runtime,completion:completion);return}
                        if operation=="load"{
                            // An inert durable request may be recovered separately;
                            // Load never changes a recorded choice or approves it.
                            consentReview=fresh
                            retireControl(runtime){[self] in finishControl(id,consentProjection(fresh),completion)};return
                        }
                        if operation=="connectionReview"{
                            guard terminal.window != nil else{consentFinish(.notApplied("settings_unavailable"),id:id,runtime:runtime,completion:completion);return}
                            let reviewed=ConnectionReview(id:UUID(),binding:b,terminal:terminal);connectionReview=reviewed
                            retireControl(runtime){[self] in finishControl(id,reply("connectionReview","explicit_connect_required",["connectionId":reviewed.id.uuidString.lowercased(),"serverOrigin":b.origin,"source":fresh.descriptor.json,"sourceState":e.state,"collectionPaused":e.collectionPaused,"syncWindow":terminal.window!.json,"activation":"unavailable"]),completion)};return
                        }
                        if operation=="connect"{
                            guard let connect,let reviewed=connect.terminal.enrollment,reviewed.id==e.id,reviewed.namespace==e.namespace,reviewed.revision==e.revision,reviewed.state==e.state,reviewed.configuration==e.configuration,connect.terminal.window==terminal.window,
                                  fresh.statuses.allSatisfy({$0.state=="valid"}),let window=terminal.window,
                                  var config=try? JSONSerialization.jsonObject(with:e.configuration) as? [String:Any],config["categories"] as? [String]==["CalendarEvent"],(config["uses"] as? [String])?.isEmpty==true,(config["assistantIds"] as? [String])?.isEmpty==true,config["usePaused"] as? Bool==true,["active","disconnected"].contains(e.state) else{consentFinish(.notApplied("connection_requires_review"),id:id,runtime:runtime,completion:completion);return}
                            observeSourcePolicy(id:id,binding:b,runtime:runtime,enrollment:e){[self] before in
                                // False is expected for a paused/disconnected source.
                                guard before != nil else{consentFinish(.notApplied("connection_policy_observation_unavailable"),id:id,runtime:runtime,completion:completion);return}
                                config["collectionPaused"]=false
                                do{let command=try command(b,enrollment:e,action:["kind":"configure","state":"active","configuration":["sourceConfiguration":config,"syncWindow":window.json]])
                                    control(command,reconcile:false,id:id,binding:b,runtime:runtime){[self] result in
                                        guard case .terminal(let connected)=result,connected.applied,connected.current,let source=connected.enrollment,source.state=="active",!source.collectionPaused else{controlFailed(result,id:id,runtime:runtime,completion:completion);return}
                                        observeSourcePolicy(id:id,binding:b,runtime:runtime,enrollment:source){[self] after in
                                            guard after==true else{retireControl(runtime){[self] in finishControl(id,reply("connected","connected_policy_unavailable",["policyObservation":after==nil ? "unavailable":"denied","activation":"unavailable"]),completion)};return}
                                            if let preview,self.catalog === preview.catalog,preview.catalog.binding==b,preview.plan.settings==window,current(b){adopt(preview,connected,id:id,runtime:runtime,completion:completion)}
                                            else{retireControl(runtime){[self] in finishControl(id,reply("connected","local_selection_review_required",["policyObservation":"allowed","activation":"unavailable"]),completion)}}
                                        }
                                    }
                                }catch{consentFinish(.notApplied("connection_unavailable"),id:id,runtime:runtime,completion:completion)}
                            }
                            return
                        }
                        guard let prior,prior.descriptor==fresh.descriptor,prior.statuses.count==fresh.statuses.count,zip(prior.statuses,fresh.statuses).allSatisfy({$0.scope==$1.scope && $0.revision==$1.revision && $0.state==$1.state && $0.decision==$1.decision}) else{consentFinish(.notApplied("review_changed"),id:id,runtime:runtime,completion:completion);return}
                        do{
                            let command:MobileCalendarSourceConsent.Original
                            if operation=="confirm"{
                                guard input["humanConfirmed"] as? Bool==true,let reserved=prior.reserved else{throw NativeCalendarAdmissionError.invalid}
                                command=try MobileCalendarSourceConsent.approval(operationID:UUID(),review:reserved,humanConfirmed:true)
                            }else{
                                guard let raw=input["purpose"] as? String,let purpose=MobileCalendarSourceConsent.Purpose(rawValue:raw),purpose != .answers,let status=fresh.statuses.first(where:{$0.scope.purpose==purpose}) else{throw NativeCalendarAdmissionError.invalid}
                                if operation=="request"{
                                    let validity=try MobileCalendarSourceConsent.validity(input["validity"] as Any)
                                    guard let deadline=input["reviewDeadlineAt"] as? String,let date=MobileCalendarSourceConsent.date(deadline),date>resources.clock() else{throw NativeCalendarAdmissionError.invalid}
                                    command=try MobileCalendarSourceConsent.request(operationID:UUID(),scope:status.scope,revision:status.revision,validity:validity,reviewDeadline:deadline)
                                }else{guard input["humanConfirmed"] as? Bool==true else{throw NativeCalendarAdmissionError.invalid};command=try MobileCalendarSourceConsent.revoke(operationID:UUID(),scope:status.scope,revision:status.revision)}
                            }
                            consentControl(command,id:id,binding:b,runtime:runtime){[self] result in
                                switch result{
                                case .consent(.reserved(let reserved)):
                                    var next=fresh;next.reserved=reserved;consentReview=next
                                    retireControl(runtime){[self] in finishControl(id,consentProjection(next),completion)}
                                case .consent(.terminal(let terminal)):
                                    retireControl(runtime){[self] in finishControl(id,reply("recorded","decision_recorded_only",["purpose":terminal.original.scope.purpose.rawValue,"decision":terminal.original.kind == .revoke ? "revoked":"approved","activation":"unavailable"]),completion)}
                                default:consentFinish(result,id:id,runtime:runtime,completion:completion)
                                }
                            }
                        }catch{consentFinish(.notApplied("explicit_choice_unavailable"),id:id,runtime:runtime,completion:completion)}
                    }
                }
            }catch{finishControl(id,reply("held","original_context_unavailable"),completion)}
        }
    }
    // Health consent shares this SAME original broker, Root, storage and command
    // hold. It never constructs a Health SDK, profile or replacement Host.
    private func healthConsentControl(_ command:MobileHealthSourceConsent.Original?=nil,read:Data?=nil,reconcile:Bool=false,id:UUID,binding:Binding,runtime:NativeHealthRuntime,done:@escaping(NativeHealthRuntime.NativeCommandOutcome)->Void){
        guard let original=storage,controlRuntime === runtime,current(binding),active==id else{done(.held(command?.operationID,"context_changed"));return}
        runtime.healthNativeConsent(command:command,read:read,reconcile:reconcile,custody:{storage,b in try original.acquire(storage:storage,binding:b)},owner:self,current:{[weak self,weak runtime] in guard let self,let runtime else{return false};return self.active==id && self.current(binding) && self.controlRuntime === runtime},makeCurrency:{[weak self] b in guard let self,self.active==id,self.current(binding) else{return nil};return .init(owner:self,binding:b)}){value in DispatchQueue.main.async{done(value)}}
    }
    private func healthConsentFinish(_ value:NativeHealthRuntime.NativeCommandOutcome,id:UUID,runtime:NativeHealthRuntime,completion:@escaping([String:Any])->Void){
        if case .held(let op,let reason)=value{finishControl(id,reply("held",reason,["operationId":op?.uuidString.lowercased() as Any? ?? NSNull(),"activation":"unavailable"]),completion);return}
        guard !runtime.nativeCommandHeld else{finishControl(id,reply("held","original_pending",["activation":"unavailable"]),completion);return}
        retireControl(runtime){[self] in finishControl(id,reply("unavailable","consent_unavailable",["activation":"unavailable"]),completion)}
    }
    private func healthConsentReply(_ review:HealthConsentReview)->[String:Any]{
        var value=reply("review","explicit_review_required",["reviewId":review.id.uuidString.lowercased(),"source":review.descriptor.json,"statuses":review.statuses.map{["purpose":$0.scope.purpose.rawValue,"consentState":$0.state,"revision":$0.revision,"validity":$0.validity?.json as Any? ?? NSNull()]},"activation":"unavailable"])
        if let reserved=review.reserved{value["request"]=reserved.original.json;value["confirmationDigest"]=reserved.confirmation;value["approvalAvailable"]=reserved.approvalAvailable}
        return value
    }
    private func readHealthConsent(namespace:UUID,enrollment:UUID?,category:String,id:UUID,binding b:Binding,runtime:NativeHealthRuntime,done:@escaping(HealthConsentReview?)->Void){
        NativeHealthInventory(transport:transport).fetch(expectedEndpoint:b.endpoint){[self] result in
            guard active==id,current(b),case .success(let inventory)=result,let source=inventory.sources.first(where:{$0.namespace==namespace}),source.collector=="healthKit",source.categories.contains(category),let actualEnrollment=source.currentEnrollment,enrollment==nil || enrollment==actualEnrollment,let read=try? MobileHealthSourceConsent.describe(enrollment:actualEnrollment,category:category) else{done(nil);return}
            healthConsentControl(read:read,id:id,binding:b,runtime:runtime){[self] value in
                guard active==id,current(b),case .healthConsent(.descriptor(let descriptor))=value,descriptor.principal==b.human,descriptor.endpoint==b.endpoint,descriptor.enrollment==actualEnrollment,descriptor.namespace==namespace,descriptor.sourceRevision==source.policyRevision,descriptor.category==category,descriptor.collector=="healthKit",let subject=try? JSONSerialization.jsonObject(with:b.snapshot.subject) as? [String:Any],UUID(uuidString:subject["installationId"] as? String ?? "")==descriptor.installation else{done(nil);return}
                func inspect(_ purposes:[MobileHealthSourceConsent.Purpose],_ values:[MobileHealthSourceConsent.Status]){
                    guard active==id,current(b) else{done(nil);return}
                    guard let purpose=purposes.first else{done(.init(id:UUID(),binding:b,descriptor:descriptor,statuses:values));return}
                    guard let scope=try? descriptor.scope(purpose:purpose),let read=try? MobileHealthSourceConsent.inspect(scope) else{done(nil);return}
                    healthConsentControl(read:read,id:id,binding:b,runtime:runtime){value in
                        guard case .healthConsent(.status(let status))=value,status.scope==scope else{done(nil);return}
                        inspect(Array(purposes.dropFirst()),values+[status])
                    }
                }
                inspect([.collection,.transmission],[])
            }
        }
    }
    private func remoteHealthReply(_ state:String,_ reason:String,_ extra:[String:Any]=[:])->[String:Any]{
        reply(state,reason,["readKnowledge":"unknown","activation":"unavailable"].merging(extra){_,new in new})
    }
    private func remoteHealthFingerprint(_ inventory:NativeHealthInventory.Snapshot)throws->Data{
        let sources=inventory.sources.filter{$0.collector=="healthKit"}.sorted{$0.namespace.uuidString<$1.namespace.uuidString}.map{s->[String:Any] in
            ["namespace":s.namespace.uuidString,"revision":s.policyRevision,"enrollment":s.currentEnrollment?.uuidString as Any? ?? NSNull(),"state":s.currentState as Any? ?? NSNull(),"categories":s.categories.sorted(),"uses":s.uses.sorted(),"assistants":s.assistants.sorted(),"collectionPaused":s.collectionPaused,"usePaused":s.usePaused,"preferred":s.preferredSource as Any? ?? NSNull()]
        }
        return try JSONSerialization.data(withJSONObject:["sources":sources,"unbound":inventory.unboundEnrollments.filter{$0.collector=="healthKit"}.sorted{$0.id.uuidString<$1.id.uuidString}.map{["id":$0.id.uuidString,"revision":$0.revision] as [String:Any]}],options:[.sortedKeys,.withoutEscapingSlashes])
    }
    private func remoteHealthRoot(_ b:Binding)throws->NativeHealthRuntime{
        if let runtime=controlRuntime,let old=controlBinding{
            guard !controlRetiring,old.origin==b.origin,old.human==b.human,old.session==b.session,old.endpoint==b.endpoint,old.epoch==b.epoch else{throw NativeCalendarAdmissionError.stale}
            controlBinding=b;return runtime
        }
        return try originalRoot(b)
    }
    private func remoteHealthFinish(_ id:UUID,_ b:Binding?,_ value:[String:Any],_ done:@escaping([String:Any])->Void){DispatchQueue.main.async{[self] in
        guard active==id else{return};active=nil;publishApplicationRestoreReady()
        guard let b,current(b) else{done(remoteHealthReply("held","context_changed"));return};done(value)
    }}
    func healthRemoteSetupOptions(input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        guard active==nil,!composed,!controlRetiring,healthSettingsControlAvailable else{completion(remoteHealthReply("held","original_owner_unavailable"));return}
        if Set(input.keys)==["close"],NativeCalendarContext.bool(input["close"],true){
            guard !connection.configuredHealthSettingsControl else{completion(remoteHealthReply("held","local_confirmation_required"));return}
            remoteHealthCatalog=nil;remoteHealthReview=nil
            guard let runtime=controlRuntime else{completion(remoteHealthReply("unavailable","closed"));return}
            guard runtime.configuration==nil,runtime.choiceAdmissionAvailable else{completion(remoteHealthReply("held","original_owner_unavailable"));return}
            let id=UUID();active=id
            snapshot(id){[self] b in guard let b,current(b) else{remoteHealthFinish(id,b,remoteHealthReply("held","context_changed"),completion);return};retireControl(runtime){[self] in remoteHealthFinish(id,b,remoteHealthReply("unavailable","closed"),completion)}};return
        }
        guard input.isEmpty,controlRuntime?.choiceAdmissionAvailable != false else{completion(remoteHealthReply("held","original_owner_unavailable"));return}
        let id=UUID();active=id;remoteHealthCatalog=nil;remoteHealthReview=nil
        snapshot(id){[self] b in
            guard let b,current(b) else{remoteHealthFinish(id,b,remoteHealthReply("held","context_changed"),completion);return}
            NativeHealthInventory(transport:transport).fetch(expectedEndpoint:b.endpoint){[self] result in
                guard current(b),case .success(let inventory)=result else{remoteHealthFinish(id,b,remoteHealthReply("held","inventory_unavailable"),completion);return}
                snapshot(id){[self] after in do{
                    guard after==b,current(b),active==id else{throw NativeCalendarAdmissionError.stale}
                    let runtime=try remoteHealthRoot(b);try runtime.prepareExistingHealthProfile(current:{self.active==id && self.current(b) && self.healthSettingsControlAvailable})
                    let catalog=RemoteHealthCatalog(b,inventory,try remoteHealthFingerprint(inventory),target:runtime.configuredHealthSettings?.initial);remoteHealthCatalog=catalog
                    let choices=catalog.sources.enumerated().map{["choice":$0.element.choice.uuidString.lowercased(),"label":"Health source \($0.offset+1)"]}
                    let enrollments=catalog.enrollments.enumerated().map{["choice":$0.element.choice.uuidString.lowercased(),"label":"Phone enrollment \($0.offset+1)","bound":$0.element.namespace != nil] as [String:Any]}
                    let value=remoteHealthReply("options","ready",["catalogId":catalog.id.uuidString.lowercased(),"destination":b.origin,"sources":choices,"enrollments":enrollments,"configuredConnection":runtime.configuredSettingsReady])
                    guard let data=try? JSONSerialization.data(withJSONObject:value),data.count<=65536 else{throw NativeCalendarAdmissionError.invalid}
                    remoteHealthFinish(id,b,value,completion)
                }catch{remoteHealthFinish(id,b,remoteHealthReply("held","original_owner_unavailable"),completion)}}
            }
        }
    }
    private func makeRemoteHealthOriginal(_ input:[String:Any],_ catalog:RemoteHealthCatalog)throws->RemoteHealthReview{
        guard input["catalogId"] as? String==catalog.id.uuidString.lowercased(),let kind=input["kind"] as? String else{throw NativeCalendarAdmissionError.invalid}
        if connection.configuredHealthSettingsControl{guard kind=="configure" else{throw NativeCalendarAdmissionError.invalid}}
        let b=catalog.binding;var target:[String:Any]=["principalId":b.human.uuidString.lowercased(),"endpointId":b.endpoint.uuidString.lowercased(),"collector":"healthKit","enrollmentId":NSNull(),"sourceNamespace":NSNull(),"expectedRevision":0]
        var action:[String:Any]=["kind":kind],summary:[String:Any]=["kind":kind,"destination":b.origin]
        switch kind{
        case "enroll":guard Set(input.keys)==["catalogId","kind"] else{throw NativeCalendarAdmissionError.invalid}
        case "bindSource":
            guard let choice=NativeHealthPauseRequest.id(input["enrollmentChoice"]),let enrollment=catalog.enrollments.first(where:{$0.choice==choice}),enrollment.namespace==nil,let mode=input["bindingMode"] as? String else{throw NativeCalendarAdmissionError.invalid}
            target["enrollmentId"]=enrollment.id.uuidString.lowercased();target["expectedRevision"]=enrollment.revision
            if mode=="createNew"{guard Set(input.keys)==["catalogId","kind","enrollmentChoice","bindingMode"] else{throw NativeCalendarAdmissionError.invalid};action["binding"]=["createNew":true];summary["source"]="Create a new Health source"}
            else{guard mode=="existing",Set(input.keys)==["catalogId","kind","enrollmentChoice","bindingMode","sourceChoice"],let choice=NativeHealthPauseRequest.id(input["sourceChoice"]),let source=catalog.sources.first(where:{$0.choice==choice}) else{throw NativeCalendarAdmissionError.invalid};action["binding"]=["sourceNamespace":source.value.namespace.uuidString.lowercased(),"expectedSourceRevision":source.value.policyRevision];summary["source"]="Bind the selected existing Health source"}
        case "configure":
            guard Set(input.keys)==["catalogId","kind","enrollmentChoice","state","configuration","choicesConfirmed"],NativeCalendarContext.bool(input["choicesConfirmed"],true),let choice=NativeHealthPauseRequest.id(input["enrollmentChoice"]),let enrollment=catalog.enrollments.first(where:{$0.choice==choice}),let namespace=enrollment.namespace,
                  let source=catalog.sources.first(where:{$0.value.namespace==namespace})?.value,
                  let state=input["state"] as? String,["active","disconnected"].contains(state),let config=input["configuration"] as? [String:Any],Set(config.keys)==["categories","uses","assistantIds","collectionPaused","usePaused"],
                  let categories=config["categories"] as? [String],Set(categories).count==categories.count,Set(categories).isSubset(of:["SleepSegment","heartRate","restingHeartRate","respiratoryRate","hrvSDNN"]),source.categories.isSubset(of:["SleepSegment","heartRate","restingHeartRate","respiratoryRate","hrvSDNN"]),
                  let uses=config["uses"] as? [String],Set(uses).count==uses.count,Set(uses).isSubset(of:["answers","summaries","memory","proactive"]),let assistants=config["assistantIds"] as? [String],assistants.count<=32,Set(assistants).count==assistants.count,assistants.allSatisfy({$0.utf8.count<=64}),
                  ["collectionPaused","usePaused"].allSatisfy({NativeCalendarContext.bool(config[$0],true)||NativeCalendarContext.bool(config[$0],false)}) else{throw NativeCalendarAdmissionError.invalid}
            var requested=config;if let preferred=source.preferredSource{requested["preferredSource"]=preferred}
            target["enrollmentId"]=enrollment.id.uuidString.lowercased();target["sourceNamespace"]=namespace.uuidString.lowercased();target["expectedRevision"]=enrollment.revision
            action["state"]=state;action["configuration"]=requested
            summary["state"]=state;summary["categories"]=categories.sorted();summary["uses"]=uses.sorted();summary["assistantCount"]=assistants.count;summary["previousAssistantCount"]=source.assistants.count;summary["collectionPaused"]=config["collectionPaused"];summary["usePaused"]=config["usePaused"]
        default:throw NativeCalendarAdmissionError.invalid
        }
        let data=try JSONSerialization.data(withJSONObject:["schemaVersion":"1.0.0","operationId":UUID().uuidString.lowercased(),"target":target,"action":action],options:[.sortedKeys,.withoutEscapingSlashes])
        let original=try MobileOrdinaryControl.original(data);_ = try MobileOrdinaryControl.envelope(original:data,operation:.control)
        return .init(id:UUID(),catalog:catalog,original:original,summary:summary)
    }
    func healthReviewRemoteSetup(input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        guard active==nil,!composed,!controlRetiring,healthSettingsControlAvailable,controlRuntime?.choiceAdmissionAvailable != false,let catalog=remoteHealthCatalog,current(catalog.binding) else{completion(remoteHealthReply("held","original_owner_unavailable"));return}
        let review:RemoteHealthReview
        do{review=try makeRemoteHealthOriginal(input,catalog)}catch{completion(remoteHealthReply("unavailable","invalid_or_unavailable_choices"));return}
        let id=UUID();active=id;remoteHealthReview=nil
        snapshot(id){[self] b in
            guard b==catalog.binding else{remoteHealthFinish(id,b,remoteHealthReply("held","context_changed"),completion);return}
            NativeHealthInventory(transport:transport).fetch(expectedEndpoint:catalog.binding.endpoint){[self] result in do{
                guard current(catalog.binding),case .success(let inventory)=result,try remoteHealthFingerprint(inventory)==catalog.fingerprint else{throw NativeCalendarAdmissionError.stale}
                let runtime=try remoteHealthRoot(catalog.binding);try runtime.prepareExistingHealthProfile(current:{self.active==id && self.current(catalog.binding) && self.healthSettingsControlAvailable})
                snapshot(id){[self] after in
                    guard after==catalog.binding,current(catalog.binding) else{remoteHealthFinish(id,after,remoteHealthReply("held","context_changed"),completion);return}
                    remoteHealthReview=review
                    remoteHealthFinish(id,after,remoteHealthReply("review","ready",["reviewId":review.id.uuidString.lowercased(),"summary":review.summary]),completion)
                }
            }catch{remoteHealthFinish(id,catalog.binding,remoteHealthReply("held","choices_changed"),completion)}}
        }
    }
    func healthApplyRemoteSetup(input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        guard Set(input.keys)==["reviewId","humanConfirmed"],NativeCalendarContext.bool(input["humanConfirmed"],true),let review=remoteHealthReview,input["reviewId"] as? String==review.id.uuidString.lowercased(),current(review.catalog.binding),active==nil,!composed,!controlRetiring,healthSettingsControlAvailable else{completion(remoteHealthReply("held","original_owner_unavailable"));return}
        let id=UUID();active=id;remoteHealthReview=nil;remoteHealthCatalog=nil;let b=review.catalog.binding
        snapshot(id){[self] before in
            guard before==b else{remoteHealthFinish(id,b,remoteHealthReply("held","context_changed"),completion);return}
            NativeHealthInventory(transport:transport).fetch(expectedEndpoint:b.endpoint){[self] result in do{
                guard current(b),case .success(let inventory)=result,try remoteHealthFingerprint(inventory)==review.catalog.fingerprint else{throw NativeCalendarAdmissionError.stale}
                let runtime=try remoteHealthRoot(b)
                remoteHealthControl(review.original,reconcile:false,id:id,binding:b,runtime:runtime){[self] value in remoteHealthControlFinished(value,id:id,binding:b,completion:completion)}
            }catch{remoteHealthFinish(id,b,remoteHealthReply("held","choices_changed"),completion)}}
        }
    }
    func healthRecoverRemoteSetup(input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        guard input.isEmpty,active==nil,!composed,!controlRetiring,healthSettingsControlAvailable,controlRuntime?.nativeCommandCanReconcile != false else{completion(remoteHealthReply("held","original_owner_unavailable"));return}
        let id=UUID();active=id;remoteHealthReview=nil;remoteHealthCatalog=nil
        snapshot(id){[self] b in do{guard let b,current(b) else{throw NativeCalendarAdmissionError.stale};let runtime=try remoteHealthRoot(b);remoteHealthControl(nil,reconcile:true,id:id,binding:b,runtime:runtime){[self] value in remoteHealthControlFinished(value,id:id,binding:b,completion:completion)}}catch{remoteHealthFinish(id,b,remoteHealthReply("held","context_changed"),completion)}}
    }
    private func remoteHealthControl(_ original:MobileOrdinaryControl.Original?,reconcile:Bool,id:UUID,binding b:Binding,runtime:NativeHealthRuntime,done:@escaping(NativeHealthRuntime.NativeCommandOutcome)->Void){
        guard active==id,current(b),controlRuntime === runtime,let storage else{done(.held(original?.operationID,"original_owner_unavailable"));return}
        runtime.healthOrdinaryControl(command:original,reconcile:reconcile,custody:{value,binding in try storage.acquire(storage:value,binding:binding)},owner:self,current:{self.active==id && self.current(b) && self.controlRuntime === runtime},makeCurrency:{[weak self] binding in guard let self,self.active==id,self.current(b) else{return nil};return .init(owner:self,binding:binding)}){value in DispatchQueue.main.async{done(value)}}
    }
    private func remoteHealthControlFinished(_ value:NativeHealthRuntime.NativeCommandOutcome,id:UUID,binding:Binding,completion:@escaping([String:Any])->Void){
        let reply:[String:Any]
        switch value{
        case .healthControl(let terminal):reply=remoteHealthReply("recorded","historical_settings_only",["outcome":terminal.settlement == .applied ? "applied":"rejected","currentness":terminal.currentness,"operationId":terminal.original.operationID.uuidString.lowercased(),"kind":terminal.original.kind.rawValue])
        case .held(let operation,let reason):reply=remoteHealthReply("held",reason,["operationId":operation?.uuidString.lowercased() as Any? ?? NSNull()])
        default:reply=remoteHealthReply("unavailable","original_or_local_unavailable")
        }
        remoteHealthFinish(id,binding,reply,completion)
    }
    func healthBeginConfiguredSettings(input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        guard Set(input.keys)==["humanConfirmed"],NativeCalendarContext.bool(input["humanConfirmed"],true),active==nil,!composed,!controlRetiring,
              let runtime=controlRuntime,connection.host.runtime === runtime else{completion(remoteHealthReply("unavailable","configured_health_required"));return}
        let id=UUID();active=id;remoteHealthCatalog=nil;remoteHealthReview=nil;healthLocalReturnReview=nil
        snapshot(id){[self] b in
            guard let b,current(b),let previous=controlBinding,previous.origin==b.origin,previous.human==b.human,previous.session==b.session,previous.endpoint==b.endpoint,previous.epoch==b.epoch else{remoteHealthFinish(id,b,remoteHealthReply("held","context_changed"),completion);return}
            controlBinding=b
            let state=connection.beginConfiguredHealthSettings(runtime:runtime,current:{[weak self,weak runtime] in guard let self,let runtime else{return false};return self.current(b) && self.controlRuntime === runtime && self.connection.host.runtime === runtime})
            var extra:[String:Any]=[:]
            if state=="settings",let plans=runtime.configuredSettingsOriginalPlans,let first=plans.first,plans.allSatisfy({$0.start==first.start && $0.end==first.end}){
                let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];f.timeZone=TimeZone(secondsFromGMT:0)
                extra=["rangeStart":f.string(from:first.start),"rangeEnd":f.string(from:first.end),"categories":plans.map{$0.category=="sleep" ? "SleepSegment":$0.category}.sorted()]
            }
            remoteHealthFinish(id,b,remoteHealthReply(state,state=="settings" ? "configured_generation_retired":"original_generation_retiring",extra),completion)
        }
    }
    private func configuredDate(_ raw:Any?)->Date?{
        guard let text=raw as? String,text.utf8.count==24 else{return nil};let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];f.timeZone=TimeZone(secondsFromGMT:0)
        guard let date=f.date(from:text),f.string(from:date)==text else{return nil};return date
    }
    func healthReviewConfiguredReturn(input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        guard Set(input.keys)==["categories","rangeStart","rangeEnd"],let categories=input["categories"] as? [String],!categories.isEmpty,categories.count<=5,Set(categories).count==categories.count,Set(categories).isSubset(of:["SleepSegment","heartRate","restingHeartRate","respiratoryRate","hrvSDNN"]),
              let start=configuredDate(input["rangeStart"]),let end=configuredDate(input["rangeEnd"]),end>start,end.timeIntervalSince(start)<=31*86400,
              active==nil,!composed,!controlRetiring,connection.configuredHealthSettingsControl,let runtime=controlRuntime,runtime.configuredSettingsReady else{completion(remoteHealthReply("localDeferred","local_review_unavailable"));return}
        let id=UUID();active=id;healthLocalReturnReview=nil
        snapshot(id){[self] b in do{
            guard let b,current(b),try remoteHealthRoot(b) === runtime else{throw NativeCalendarAdmissionError.stale}
            NativeHealthInventory(transport:transport).fetch(expectedEndpoint:b.endpoint){[self] result in do{
                guard current(b),case .success(let inventory)=result else{throw NativeCalendarAdmissionError.stale}
                let (local,terminal,old)=try runtime.configuredLocalReview(),configured=try MobileOrdinaryControl.healthConfiguration(terminal)
                guard configured.principal==b.human,configured.endpoint==b.endpoint,local.enrollment==configured.enrollment,local.namespace==configured.namespace,
                      let source=inventory.sources.first(where:{$0.namespace==local.namespace}),source.currentEnrollment==local.enrollment,source.policyRevision==configured.revision,
                      Set(categories).isSubset(of:configured.categories) else{throw NativeCalendarAdmissionError.invalid}
                let fingerprint=try remoteHealthFingerprint(inventory)
                runtime.readExistingHealthProfilePolicy(enrollment:local.enrollment){[self] response in
                    guard current(b),case .success(let proof)=response,proof.permitsCollection,proof.revision==configured.revision,proof.sourceNamespace.flatMap(UUID.init(uuidString:))==local.namespace,Set(categories.map{$0=="SleepSegment" ? "sleep":$0}).isSubset(of:proof.healthKitTypes) else{remoteHealthFinish(id,b,remoteHealthReply("localDeferred","remote_saved_local_policy_unavailable",["remoteSaved":true]),completion);return}
                    snapshot(id){[self] after in do{
                        guard after==b,current(b) else{throw NativeCalendarAdmissionError.stale}
                        let plans=categories.sorted().map{NativeHealthCollectionPlan(category:$0=="SleepSegment" ? "sleep":$0,scope:"existing-remote-health/1:"+local.namespace.uuidString.lowercased(),mappingVersion:resources.health?.mappingVersion ?? "",start:start,end:end)}
                        guard plans.allSatisfy(\.valid),plans.allSatisfy({plan in old.plans.first(where:{$0.category==plan.category}).map{$0==plan} ?? true}) else{throw NativeCalendarAdmissionError.invalid}
                        let configuration=try runtime.configuredReturnConfiguration(plans:plans),review=HealthLocalReturnReview(id:UUID(),binding:b,fingerprint:fingerprint,expected:local,terminal:terminal,configuration:configuration);healthLocalReturnReview=review
                        remoteHealthFinish(id,b,remoteHealthReply("localReview","explicit_local_confirmation_required",["reviewId":review.id.uuidString.lowercased(),"destination":b.origin,"categories":categories.sorted(),"rangeStart":input["rangeStart"]!,"rangeEnd":input["rangeEnd"]!,"localPaused":local.paused]),completion)
                    }catch{remoteHealthFinish(id,b,remoteHealthReply("localDeferred","local_review_changed",["remoteSaved":true]),completion)}}
                }
            }catch{remoteHealthFinish(id,b,remoteHealthReply("localDeferred","saved_configuration_unavailable"),completion)}}
        }catch{remoteHealthFinish(id,b,remoteHealthReply("localDeferred","context_changed"),completion)}}
    }
    func healthConfirmConfiguredReturn(input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        guard Set(input.keys)==["reviewId","humanConfirmed"],NativeCalendarContext.bool(input["humanConfirmed"],true),let review=healthLocalReturnReview,input["reviewId"] as? String==review.id.uuidString.lowercased(),current(review.binding),active==nil,connection.configuredHealthSettingsControl,let runtime=controlRuntime,let storage else{completion(remoteHealthReply("localDeferred","local_confirmation_required"));return}
        let id=UUID();active=id;healthLocalReturnReview=nil;let b=review.binding
        snapshot(id){[self] actual in
            guard actual==b,current(b) else{remoteHealthFinish(id,b,remoteHealthReply("localDeferred","context_changed",["remoteSaved":true]),completion);return}
            NativeHealthInventory(transport:transport).fetch(expectedEndpoint:b.endpoint){[self] result in do{
                guard current(b),case .success(let inventory)=result,try remoteHealthFingerprint(inventory)==review.fingerprint else{throw NativeCalendarAdmissionError.stale}
                runtime.confirmConfiguredHealthLocal(expected:review.expected,terminal:review.terminal,selected:Set(review.configuration.plans.map(\.category)),custody:{value,binding in try storage.acquire(storage:value,binding:binding)},owner:self,current:{self.active==id && self.current(b) && self.controlRuntime === runtime},makeCurrency:{binding in guard self.active==id,self.current(b) else{return nil};return .init(owner:self,binding:binding)}){[self] outcome in DispatchQueue.main.async{
                    guard case .healthLocal(let local)=outcome else{remoteHealthFinish(id,b,remoteHealthReply("localDeferred","remote_saved_local_confirmation_unavailable",["remoteSaved":true]),completion);return}
                    snapshot(id){[self] after in do{
                        guard after==b,current(b),connection.configuredHealthSettingsControl,connection.host.runtime === runtime else{throw NativeCalendarAdmissionError.stale}
                        let descriptor=NativeHealthSetupDescriptor(selector:"configured-health-"+UUID().uuidString.lowercased(),revision:local.revision,title:"Apple Health",destinationLabel:b.origin,namespace:local.namespace,configuration:review.configuration,localSetup:.confirmExistingLocal,configuredLocalConfirmed:true)
                        guard let profile=NativeHealthConnectionOwner.Profile(descriptor:descriptor),connection.installHealthConfiguration(profile,runtime:runtime) else{throw NativeCalendarAdmissionError.unavailable}
                        try runtime.finishConfiguredLocalReturn(review.configuration,local:local,current:{self.active==id && self.current(b) && self.connection.host.runtime === runtime})
                        remoteHealthFinish(id,b,remoteHealthReply(local.paused ? "localPaused":"localPrepared","configured_local_saved",["remoteSaved":true,"localSaved":true]),completion)
                    }catch{remoteHealthFinish(id,b,remoteHealthReply("localDeferred","local_saved_context_changed",["remoteSaved":true,"localSaved":true]),completion)}}
                }}
            }catch{remoteHealthFinish(id,b,remoteHealthReply("localDeferred","local_review_changed",["remoteSaved":true]),completion)}}
        }
    }
    func healthResumeConfiguredReturn(input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        guard Set(input.keys)==["humanConfirmed"],NativeCalendarContext.bool(input["humanConfirmed"],true),active==nil,let runtime=controlRuntime,connection.host.runtime === runtime,let request=runtime.configuredSettingsPauseInput else{completion(remoteHealthReply("localDeferred","original_pause_resume_required"));return}
        let id=UUID();active=id
        snapshot(id){[self] b in guard let b,current(b) else{remoteHealthFinish(id,b,remoteHealthReply("localDeferred","context_changed"),completion);return}
            connection.host.resumeCollection(request){[self] value in
                let outcome=value["outcome"] as? String
                remoteHealthFinish(id,b,remoteHealthReply(outcome=="resumed" ? "localPrepared":"localPaused",outcome=="resumed" ? "explicit_local_resume_saved":"original_pause_still_held",["remoteSaved":true]),completion)
            }
        }
    }
    /// Explicit local composition for an already active source. Bridge IDs are
    /// comparison hints; actual authenticated inventory and policy own binding.
    func prepareExistingHealth(input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        func unavailable(_ reason:String)->[String:Any]{reply("unavailable",reason,["readKnowledge":"unknown"])}
        guard active==nil,!composed,!controlRetiring,connection.canInstallCalendarConfiguration,
              controlRuntime?.choiceAdmissionAvailable != false else{completion(unavailable("original_owner_unavailable"));return}
        guard let health=resources.health,!health.mappingVersion.isEmpty,health.mappingVersion.utf8.count<=64 else{completion(unavailable("health_resources_unavailable"));return}
        let expected:Set<String>=["schemaVersion","sourceNamespace","enrollmentId","endpointId","policyRevision","contextRevision","categories","rangeStart","rangeEnd","localSetup"]
        guard Set(input.keys)==expected,input["schemaVersion"] as? String=="1.0.0",
              let namespace=NativeHealthPauseRequest.id(input["sourceNamespace"]),let enrollment=NativeHealthPauseRequest.id(input["enrollmentId"]),
              let endpoint=NativeHealthPauseRequest.id(input["endpointId"]),let revision=NativeHealthStatusRequest.number(input["policyRevision"],minimum:1),
              let contextRevision=NativeHealthStatusRequest.number(input["contextRevision"],minimum:0),
              let categories=input["categories"] as? [String],(1...5).contains(categories.count),Set(categories).count==categories.count,
              Set(categories).isSubset(of:["SleepSegment","heartRate","restingHeartRate","respiratoryRate","hrvSDNN"]),
              let local=input["localSetup"] as? String,["prepareNewLocal","confirmSavedLocal"].contains(local) else{completion(unavailable("invalid_input"));return}
        func date(_ raw:Any?)->Date?{
            guard let text=raw as? String,text.utf8.count==24 else{return nil}
            let formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds];formatter.timeZone=TimeZone(secondsFromGMT:0)
            guard let value=formatter.date(from:text),value.timeIntervalSince1970.isFinite,formatter.string(from:value)==text else{return nil};return value
        }
        guard let start=date(input["rangeStart"]),let end=date(input["rangeEnd"]),end>start,end.timeIntervalSince(start)<=31*86400 else{completion(unavailable("invalid_range"));return}
        let id=UUID();active=id;healthConsentReview=nil;consentReview=nil;connectionReview=nil;catalog=nil;preview=nil
        func finish(_ value:[String:Any]){DispatchQueue.main.async{[self] in
            guard active==id else{return};active=nil;publishApplicationRestoreReady();completion(value)
        }}
        snapshot(id){[self] first in
            guard let binding=first,current(binding),binding.endpoint==endpoint,binding.snapshot.revision==contextRevision else{finish(unavailable("context_changed"));return}
            NativeHealthInventory(transport:transport).fetch(expectedEndpoint:binding.endpoint){[self] result in
                guard active==id,current(binding),connection.canInstallCalendarConfiguration,
                      case .success(let inventory)=result,
                      let source=inventory.sources.first(where:{$0.namespace==namespace}),source.collector=="healthKit",source.currentEnrollment==enrollment,
                      source.policyRevision==revision,source.currentState=="active",!source.collectionPaused,Set(categories).isSubset(of:source.categories) else{finish(unavailable("source_unavailable"));return}
                do{
                    let runtime:NativeHealthRuntime
                    if let retained=controlRuntime,let original=controlBinding{
                        guard original==binding else{throw NativeCalendarAdmissionError.stale};runtime=retained
                    }else{runtime=try originalRoot(binding)}
                    try runtime.prepareExistingHealthProfile(current:{self.active==id && self.current(binding) && self.connection.canInstallCalendarConfiguration})
                    runtime.readExistingHealthProfilePolicy(enrollment:enrollment){[self] result in
                        guard active==id,current(binding),case .success(let proof)=result,proof.permitsCollection,
                              proof.enrollment==enrollment,proof.principal==binding.human,proof.endpoint==binding.endpoint,
                              proof.sourceNamespace==namespace.uuidString.lowercased(),proof.revision==revision,
                              Set(categories).isSubset(of:proof.categories) else{finish(unavailable("policy_unavailable"));return}
                        snapshot(id){[self] after in
                            do{
                                guard after==binding,current(binding),active==id,controlRuntime === runtime,connection.canInstallCalendarConfiguration else{throw NativeCalendarAdmissionError.stale}
                                try runtime.prepareExistingHealthProfile(current:{self.active==id && self.current(binding) && self.connection.canInstallCalendarConfiguration})
                                let plans=categories.sorted().map{NativeHealthCollectionPlan(category:$0=="SleepSegment" ? "sleep":$0,scope:"existing-remote-health/1:"+namespace.uuidString.lowercased(),mappingVersion:health.mappingVersion,start:start,end:end)}
                                guard let storage else{throw NativeCalendarAdmissionError.unavailable}
                                let root=runtime.rootConfiguration
                                let config=NativeHealthRuntime.Configuration(provenance:root.provenance,origin:root.origin,human:root.human,session:root.session,endpoint:root.endpoint,enrollment:enrollment,plans:plans,maxBytes:root.maxBytes,maxEvents:root.maxEvents,storageOrigin:root.identity.storageOrigin,protectedFilePolicy:root.identity.protectedFilePolicy,protectedAvailable:resources.protectedAvailable,makeStorage:{try storage.openStorage()},makeSDK:health.makeSDK)
                                let descriptor=NativeHealthSetupDescriptor(selector:"existing-health-"+UUID().uuidString.lowercased(),revision:revision,title:"Apple Health",destinationLabel:binding.origin,namespace:namespace,configuration:config,localSetup:local=="confirmSavedLocal" ? .confirmExistingLocal:.enrollExistingRemote)
                                guard let profile=NativeHealthConnectionOwner.Profile(descriptor:descriptor),active==id,current(binding),connection.installHealthConfiguration(profile,runtime:runtime) else{throw NativeCalendarAdmissionError.unavailable}
                                DispatchQueue.main.async{[self] in
                                    guard active==id else{return}
                                    let valid=current(binding) && connection.host.runtime === runtime && runtime.choiceSourceCurrent
                                    active=nil;publishApplicationRestoreReady();completion(valid ? reply("prepared","explicit_local_action_required",["readKnowledge":"unknown","localSetup":local]):unavailable("context_changed"))
                                }
                            }catch{finish(unavailable("original_owner_unavailable"))}
                        }
                    }
                }catch{finish(unavailable("original_owner_unavailable"))}
            }
        }
    }
    func healthSourceConsent(operation:String,input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        // An active or held other owner is not implicitly retired for a review.
        let recover=operation=="recover",prior=healthConsentReview
        guard ["load","request","confirm","revoke","recover"].contains(operation),active==nil,!composed,!controlRetiring,healthSettingsControlAvailable,recover ? controlRuntime?.nativeCommandCanReconcile != false:(controlRuntime==nil || connection.configuredHealthSettingsControl) else{completion(reply("held","original_owner_unavailable",["activation":"unavailable"]));return}
        let keys:Set<String>=operation=="load" ? ["sourceNamespace","enrollmentId","category"]:recover ? []:operation=="request" ? ["reviewId","purpose","validity","reviewDeadlineAt"]:operation=="revoke" ? ["reviewId","purpose","humanConfirmed"]:["reviewId","humanConfirmed"]
        guard Set(input.keys)==keys else{completion(reply("unavailable","invalid_input"));return}
        var namespace:UUID?,enrollment:UUID?,category:String?
        if operation=="load"{namespace=UUID(uuidString:input["sourceNamespace"] as? String ?? "");enrollment=UUID(uuidString:input["enrollmentId"] as? String ?? "");category=input["category"] as? String;guard namespace != nil,enrollment != nil,category.map(MobileHealthSourceConsent.categories.contains)==true else{completion(reply("unavailable","invalid_input"));return}}
        else if !recover{guard let prior,input["reviewId"] as? String==prior.id.uuidString.lowercased(),current(prior.binding) else{completion(reply("unavailable","stale_review"));return};namespace=prior.descriptor.namespace;enrollment=prior.descriptor.enrollment;category=prior.descriptor.category}
        if ["confirm","revoke"].contains(operation){guard NativeCalendarContext.bool(input["humanConfirmed"],true) else{completion(reply("unavailable","explicit_confirmation_required"));return}}
        let id=UUID();active=id;healthConsentReview=nil;controlReplyBinding=nil
        snapshot(id){[self] actual in
            guard let b=actual,current(b) else{finishControl(id,reply("held","original_context_unavailable"),completion);return}
            if !recover,operation != "load",prior?.binding != b{finishControl(id,reply("unavailable","stale_review"),completion);return}
            do{
                controlReplyBinding=b
                let runtime:NativeHealthRuntime
                if recover,let retained=controlRuntime,let original=controlBinding{
                    guard authorityCurrent(original),original.snapshot==b.snapshot,original.epoch==b.epoch,original.origin==b.origin,original.human==b.human,original.session==b.session,original.endpoint==b.endpoint else{throw NativeCalendarAdmissionError.stale};runtime=retained;controlBinding=b
                }else{runtime=try remoteHealthRoot(b)}
                func publish(_ value:[String:Any]){retireControl(runtime){[self] in finishControl(id,value,completion)}}
                func outcome(_ value:NativeHealthRuntime.NativeCommandOutcome){
                    guard active==id else{return}
                    switch value{
                    case .healthConsent(.terminal(let terminal)):
                        publish(reply("recorded","decision_recorded_only",["purpose":terminal.original.scope.purpose.rawValue,"category":terminal.original.scope.category,"decision":terminal.original.kind == .revoke ? "revoked":"approved","activation":"unavailable"]))
                    case .healthConsent(.reserved(let reserved)):
                        readHealthConsent(namespace:reserved.original.scope.namespace,enrollment:nil,category:reserved.original.scope.category,id:id,binding:b,runtime:runtime){[self] fresh in
                            guard var fresh,current(b),let scope=try? fresh.descriptor.scope(purpose:reserved.original.scope.purpose),scope==reserved.original.scope,fresh.statuses.contains(where:{$0.scope==scope && $0.revision==reserved.original.revision}) else{healthConsentFinish(.notApplied("review_changed"),id:id,runtime:runtime,completion:completion);return}
                            fresh.reserved=reserved;healthConsentReview=fresh;publish(healthConsentReply(fresh))
                        }
                    default:healthConsentFinish(value,id:id,runtime:runtime,completion:completion)
                    }
                }
                if recover{healthConsentControl(reconcile:true,id:id,binding:b,runtime:runtime,done:outcome);return}
                readHealthConsent(namespace:namespace!,enrollment:enrollment,category:category!,id:id,binding:b,runtime:runtime){[self] fresh in
                    guard let fresh,current(b) else{healthConsentFinish(.notApplied("source_unavailable"),id:id,runtime:runtime,completion:completion);return}
                    if operation=="load"{healthConsentReview=fresh;publish(healthConsentReply(fresh));return}
                    guard let prior,prior.descriptor==fresh.descriptor else{healthConsentFinish(.notApplied("review_changed"),id:id,runtime:runtime,completion:completion);return}
                    do{
                        let command:MobileHealthSourceConsent.Original
                        if operation=="confirm"{
                            guard let reserved=prior.reserved,let deadline=MobileHealthSourceConsent.date(reserved.original.reviewDeadline),deadline>resources.clock(),fresh.statuses.contains(where:{$0.scope==reserved.original.scope && $0.revision==reserved.original.revision}) else{throw NativeCalendarAdmissionError.stale}
                            command=try MobileHealthSourceConsent.approval(operationID:UUID(),review:reserved,humanConfirmed:true)
                        }else{
                            guard let raw=input["purpose"] as? String,let purpose=MobileHealthSourceConsent.Purpose(rawValue:raw),purpose != .answers,let status=fresh.statuses.first(where:{$0.scope.purpose==purpose}),prior.statuses.contains(where:{$0.scope==status.scope && $0.revision==status.revision}) else{throw NativeCalendarAdmissionError.stale}
                            if operation=="request"{
                                let validity=try MobileHealthSourceConsent.validity(input["validity"] as Any)
                                guard let deadline=input["reviewDeadlineAt"] as? String,let date=MobileHealthSourceConsent.date(deadline),date>resources.clock() else{throw NativeCalendarAdmissionError.invalid}
                                if case .expiresAt(let raw)=validity{guard let expiry=MobileHealthSourceConsent.date(raw),expiry>resources.clock() else{throw NativeCalendarAdmissionError.invalid}}
                                command=try MobileHealthSourceConsent.request(operationID:UUID(),scope:status.scope,revision:status.revision,validity:validity,reviewDeadline:deadline)
                            }else{command=try MobileHealthSourceConsent.revoke(operationID:UUID(),scope:status.scope,revision:status.revision)}
                        }
                        healthConsentControl(command,id:id,binding:b,runtime:runtime,done:outcome)
                    }catch{healthConsentFinish(.notApplied("review_changed"),id:id,runtime:runtime,completion:completion)}
                }
            }catch{finishControl(id,reply("held","original_context_unavailable",["activation":"unavailable"]),completion)}
        }
    }

}


extension NativeCalendarSourceOwner {
    /// Only the original native application composition supplies these lifecycle
    /// inputs. There is no bridge-selected OS event or alternative transport.
    func nativeHealthInactive(){savedForegroundAllowed=false;savedBackgroundAllowed=false;controlRuntime?.suspendNativeHealthActivity()}
    func nativeHealthOpportunity(foreground:Bool,background:Bool){
        precondition(Thread.isMainThread)
        savedForegroundAllowed=foreground;savedBackgroundAllowed=background
        if !resources.protectedAvailable() || (!foreground && !background){
            savedForegroundAllowed=false;savedBackgroundAllowed=false;withdraw();connection.withdraw();return
        }
        if !foreground,let original=controlRuntime,!original.backgroundMayContinue{
            withdraw();connection.withdraw()
        }
        recoverSavedHealthOpportunity()
    }
    private func backgroundResponse(_ state:String="current",review:UUID?=nil,plans:[HealthOutbox.SavedHealthPlan]=[])->[String:Any]{
        let original=controlRuntime
        let visible=savedForegroundAllowed && controlBinding.map{current($0)}==true
        return ["schemaVersion":"1.0.0","state":state,"readKnowledge":"unknown","persistence":visible ? (original?.backgroundPreferenceState ?? "unselected"):"unselected",
                "registration":visible ? (original?.backgroundRegistrationState ?? "notRequested"):"notRequested","drain":original?.backgroundWorkHeld==true ? "pending":"drained",
                "review":visible ? (review?.uuidString.lowercased() as Any? ?? NSNull()):NSNull(),"plans":(visible ? plans:[]).map{["category":$0.category,"rangeStart":$0.start.timeIntervalSince1970,"rangeEnd":$0.end.timeIntervalSince1970]},"destination":visible ? (controlBinding?.origin as Any? ?? NSNull()):NSNull()]
    }
    func healthBackgroundChoice(_ input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread);refreshSavedRecoveryChoiceFlags()
        guard let operation=input["operation"] as? String,["status","review","enable","off"].contains(operation),
              let choice=NativeHealthPauseRequest.id(input["choice"]),let row=savedRecoveryChoices.first(where:{$0.0==choice}),
              savedForegroundAllowed,resources.protectedAvailable(),current(row.2),controlRuntime === row.3,controlBinding==row.2,!row.1.requiresRebind else{completion(backgroundResponse("unavailable"));return}
        if operation=="status",Set(input.keys)==["operation","choice"]{completion(backgroundResponse());return}
        if operation=="off",Set(input.keys)==["operation","choice"]{
            backgroundReview=nil;row.3.disableBackgroundChoice(row.1);completion(backgroundResponse("stopping"));return
        }
        guard connection.host.runtime === row.3 else{completion(backgroundResponse("original_owner_required"));return}
        if operation=="review",Set(input.keys)==["operation","choice"],row.1.updatesEnabled{
            let nonce=UUID();backgroundReview=(nonce,row.0,row.1,row.2,row.3);completion(backgroundResponse("reviewed",review:nonce,plans:row.1.plans));return
        }
        guard operation=="enable",Set(input.keys)==["operation","choice","review","humanConfirmed"],NativeCalendarContext.bool(input["humanConfirmed"],true),
              let nonce=NativeHealthPauseRequest.id(input["review"]),let reviewed=backgroundReview,reviewed.0==nonce,reviewed.1==choice,reviewed.2==row.1,reviewed.3==row.2,reviewed.4 === row.3 else{completion(backgroundResponse("review_required"));return}
        backgroundReview=nil
        row.3.enableBackgroundChoice(row.1,current:{[weak self,weak original=row.3] in guard let self,let original else{return false};return self.savedForegroundAllowed && self.resources.protectedAvailable() && self.current(row.2) && self.controlRuntime === original && self.connection.host.runtime === original}){[self] _ in completion(backgroundResponse())}
    }
}

extension NativeCalendarSourceOwner {
    /// An explicit original session restore first retires the SAME Health owner.
    /// Unknown callbacks retain this waiter; there is no fallback/reset timeout.
    func prepareApplicationConnectionRestore(_ done:@escaping()->Void){
        guard applicationRestoreCompletion==nil else{return}
        applicationRestoreCompletion=done;applicationRestoreOwnerReleased=false
        withdraw()
        guard let old=controlRuntime else{applicationRestoreOwnerReleased=true;publishApplicationRestoreReady();return}
        controlRetiring=true
        func released(_ result:Result<NativeHealthRuntime.RetiredSavedHealthResources,Error>){
            DispatchQueue.main.async{[self] in
                guard controlRuntime === old,case .success(let resources)=result else{return}
                savedHandbackSDK=resources.sdk;controlRuntime=nil;controlBinding=nil;storage=nil;controlRetiring=false
                applicationRestoreOwnerReleased=true;publishApplicationRestoreReady()
            }
        }
        if connection.hasHealthConfigurationForSavedRecovery{connection.retireHealthForSavedRecovery(original:old,completion:released)}
        else{old.retireForSavedHealthRecovery{do{released(.success(try old.takeRetiredSavedHealthResources()))}catch{released(.failure(error))}}}
    }
    private func publishApplicationRestoreReady(){
        guard applicationRestoreOwnerReleased,savedRecoveryJob==nil,active==nil,let done=applicationRestoreCompletion else{return}
        DispatchQueue.main.async{[self] in
            guard applicationRestoreOwnerReleased,savedRecoveryJob==nil,active==nil,applicationRestoreCompletion != nil else{return}
            applicationRestoreCompletion=nil;applicationRestoreOwnerReleased=false;done()
        }
    }
}
