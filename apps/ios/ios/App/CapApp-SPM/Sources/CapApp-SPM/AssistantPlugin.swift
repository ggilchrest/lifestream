// SPDX-License-Identifier: Apache-2.0
import Capacitor
import UIKit
import AVFoundation
import AssistantCore

@objc(AssistantPlugin)
public final class AssistantPlugin: CAPPlugin,CAPBridgedPlugin {
    public let identifier="AssistantPlugin",jsName="Assistant"
    public let pluginMethods=["healthBackgroundChoice","healthSavedRecoveryChoice","healthRememberedChoice","healthObservationChoice","healthBeginConfiguredSettings","healthReviewConfiguredReturn","healthConfirmConfiguredReturn","healthResumeConfiguredReturn","healthRemoteSetupOptions","healthReviewRemoteSetup","healthApplyRemoteSetup","healthRecoverRemoteSetup","healthPrepareExistingSource","healthLoadSourceConsent","healthRequestSourceConsent","healthConfirmSourceConsent","healthRevokeSourceConsent","healthRecoverSourceConsent","calendarLoadSourceConsent","calendarRequestSourceConsent","calendarConfirmSourceConsent","calendarRevokeSourceConsent","calendarRecoverSourceConsent","calendarReviewSourceConnection","calendarConnectSource","calendarBootstrapReadPermission","calendarDiscoverSelections","calendarPrepareSelection","calendarSaveSelection","calendarReconcileSelection","calendarCollectionDetailsChoice","calendarCollectAndDeliverChoice","calendarRequestReadPermissionChoice","calendarLocalSetupChoices","calendarSetupExistingChoice","calendarSavedChoices","calendarReconnectChoice","calendarDeliverPendingChoice","healthSetupChoices","healthSetupChoice","healthRequestReadPermission","healthSyncChoice","calendarReconnect","calendarSetup","calendarCollectAndDeliver","calendarDeliverPending","calendarCancel","healthInventory","healthSetup","healthStatus","healthPauseCollection","healthResumeCollection","healthSync","configure","restoreConnection","forgetSession","saveSettings","request","setBackgroundPolicy","pendingPersonalLock","sendText","cancelText","start","stop","finishUtterance","snapshot","routePicker","startAudioProbe","stopAudioProbe","copyAudioDiagnostics","diagnosticsStatus","setDiagnosticsEnabled","logDiagnostic","clearDiagnostics","shareDiagnostics","shareAuditDiagnostics","startVoicePreview","stopVoicePreview","voicePreviewStatus"].compactMap{CAPPluginMethod(name:$0,returnType:CAPPluginReturnPromise)}
    private let transport:NativeTransport
    private var sharedHealthConnection:NativeHealthConnectionOwner?
    private var applicationOwnsHealth=false
    private let healthConnectionProfile:NativeHealthConnectionOwner.Profile?
    private let calendarConnectionProfile:NativeCalendarSavedProfile?
    private var calendarSourceResources:NativeCalendarSourceOwner.Resources?
    private var calendarRegistration:NativeCalendarAppComposition.Registration?
    private lazy var calendarSource:NativeCalendarSourceOwner?={
        if let calendarRegistration{return calendarRegistration.bind(transport:transport,connection:healthConnectionOwner)}
        return calendarSourceResources.map{NativeCalendarSourceOwner(transport:transport,connection:healthConnectionOwner,resources:$0)}
    }()
    private lazy var healthConnectionOwner:NativeHealthConnectionOwner={
        if let sharedHealthConnection{return sharedHealthConnection}
        if let calendarConnectionProfile{return NativeHealthConnectionOwner(transport:transport,calendarProfile:calendarConnectionProfile)}
        return NativeHealthConnectionOwner(transport:transport,profile:healthConnectionProfile)
    }()
    private var healthHost:NativeHealthHost{healthConnectionOwner.host}
    public override init(){transport=NativeTransport();healthConnectionProfile=nil;calendarConnectionProfile=nil;super.init()}
    /// Original native composition may inject one validated profile before load.
    /// There is deliberately no JavaScript setter or installed default profile.
    init(healthConnectionProfile:NativeHealthConnectionOwner.Profile){transport=NativeTransport();self.healthConnectionProfile=healthConnectionProfile;calendarConnectionProfile=nil;super.init()}
    init(calendarConnectionProfile:NativeCalendarSavedProfile){transport=NativeTransport();healthConnectionProfile=nil;self.calendarConnectionProfile=calendarConnectionProfile;super.init()}
    /// Inactive source composition only; no bridge setter and no installed defaults.
    init(calendarSourceResources:NativeCalendarSourceOwner.Resources){transport=NativeTransport();healthConnectionProfile=nil;calendarConnectionProfile=nil;self.calendarSourceResources=calendarSourceResources;super.init()}
    init(calendarRegistration:NativeCalendarAppComposition.Registration){
        if let owners=calendarRegistration.applicationOwners(){transport=owners.transport;sharedHealthConnection=owners.connection;applicationOwnsHealth=true}else{transport=NativeTransport()}
        healthConnectionProfile=nil;calendarConnectionProfile=nil;self.calendarRegistration=calendarRegistration;super.init()
    }
    private lazy var voicePreview=NativeVoicePreview(transport:transport)
    private let diagnosticLog=NativeDiagnostics()
    private var diagnosticSequence=0
    private lazy var text:NativeText={let value=NativeText(transport:transport);value.diagnostic={[weak self] name,status,turn in if let event=DiagnosticEvent(rawValue:name){self?.diagnosticLog.record(event,status:status,turn:turn)}};return value}()
    private lazy var audioProbe:NativePlaybackProbe={let value=NativePlaybackProbe();value.emit={[weak self] message in guard UIApplication.shared.applicationState == .active else{return};self?.notifyListeners("event",data:message)};return value}()
    private var lifecycleObservers=[NSObjectProtocol](),continueWhenLocked=false
    private var auditTimer:Timer?,lastAuditActive=false,lastAuditContent=false,lastAuditStopping=false,auditStopping=false,lastAuditObservation:AuditDiscoveryObservation?
    private var personalLifecycle=AudienceLifecycle(),personalAccess=PersonalSessionAccess(),pendingPersonalLock:String?
    private func withdrawPersonal(_ reason:String,notify:Bool=true){
        personalAccess.withdraw();voicePreview.stop();audioProbe.stop();text.stop();voice.stop(reason)
        if notify{notifyListeners("event",data:["type":"personalSession","active":false,"reason":reason])}
    }
    public override func load(){
        if !applicationOwnsHealth{transport.healthContextTransition={[weak self] event in self?.calendarSource?.observeHealthContextTransition(event)}
        transport.healthContextPairedWillChange={[weak self] authorityChanged,notification in guard let self else{return};if let source=self.calendarSource{source.healthContextWillChange(authorityChanged:authorityChanged,notification:notification)}else{self.healthConnectionOwner.withdraw(authorityChanged:authorityChanged)}}}
        diagnosticLog.record(.appStarted);if UIApplication.shared.applicationState != .active{transport.audit.suspend()}
        let auditShares=FileManager.default.temporaryDirectory.appendingPathComponent("lifestream-audit-shares",isDirectory:true);if let files=try? FileManager.default.contentsOfDirectory(at:auditShares,includingPropertiesForKeys:nil){for file in files where file.lastPathComponent.hasPrefix("Lifestream-Diagnostics-"){DiagnosticExportFile.finish(file)}}
        transport.auditChanged={[weak self] in self?.publishAudit()}
        transport.auditStopConfirmed={[weak self] in guard let self else{return};self.auditStopping=false;self.publishAudit()}
        auditTimer=Timer.scheduledTimer(withTimeInterval:1,repeats:true){[weak self] _ in guard let self else{return};self.transport.audit.prune();self.publishAudit()}
        func observe(_ name:Notification.Name,_ action:@escaping()->Void){lifecycleObservers.append(NotificationCenter.default.addObserver(forName:name,object:nil,queue:.main){_ in action()})}
        observe(UIApplication.willResignActiveNotification){[weak self] in self?.voicePreview.stop();self?.personalLifecycle.resignActive()}
        observe(UIApplication.protectedDataWillBecomeUnavailableNotification){[weak self] in self?.legacyHealthWithdrawal();self?.personalLifecycle.protectedDataUnavailable()}
        observe(UIApplication.protectedDataDidBecomeAvailableNotification){[weak self] in self?.protectedDataAvailable()}
        observe(UIApplication.didBecomeActiveNotification){[weak self] in self?.legacyHealthForeground();self?.diagnosticLog.record(.appForeground);self?.transport.audit.resumeForeground();self?.personalLifecycle.becomeActive()}
        observe(UIApplication.didEnterBackgroundNotification){[weak self] in guard let self else{return};self.legacyHealthWithdrawal();self.diagnosticLog.record(.appBackground);self.voice.stopAudit();self.transport.audit.suspend();self.publishAudit();self.voicePreview.stop();self.text.stop();if !self.personalLifecycle.enterBackground(continueWhenLocked:self.continueWhenLocked,protectedDataAvailable:UIApplication.shared.isProtectedDataAvailable){self.withdrawPersonal("App left the foreground. Start again after reopening.")}}
        observe(AVAudioSession.interruptionNotification){[weak self] in self?.voicePreview.stop()}
        lifecycleObservers.append(NotificationCenter.default.addObserver(forName:AVAudioSession.routeChangeNotification,object:nil,queue:.main){[weak self] note in
            guard let raw=note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,let reason=AVAudioSession.RouteChangeReason(rawValue:raw),reason != .categoryChange else{return};self?.voicePreview.stop()
        })
        observe(UIApplication.willTerminateNotification){[weak self] in self?.legacyHealthWithdrawal();self?.withdrawPersonal("App closed.")}
    }
    private func legacyHealthWithdrawal(){guard !applicationOwnsHealth else{return};calendarSource?.setSavedHealthForeground(false);calendarSource?.withdraw();healthConnectionOwner.withdraw()}
    private func legacyHealthForeground(){guard !applicationOwnsHealth else{return};calendarSource?.setSavedHealthForeground(true);healthConnectionOwner.foregroundHealthOpportunity()}
    private func restoreOriginalConnection(_ done:@escaping(Result<[String:Any],Error>)->Void){
        if applicationOwnsHealth,let calendarRegistration{calendarRegistration.restoreApplicationConnection(done)}else{transport.restoreSession{done($0.map{ $0.payload })}}
    }
    @objc public func healthBackgroundChoice(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active,let calendarSource,let input=call.options as? [String:Any] else{call.reject("Health source is unavailable.");return}
        calendarSource.healthBackgroundChoice(input){call.resolve($0)}
    }}
    private func protectedDataAvailable(){if UIApplication.shared.applicationState == .active{legacyHealthForeground()};if !personalLifecycle.protectedDataAvailable(){withdrawPersonal("Phone unlocked outside the app. Open Lifestream and tap Start to resume.")}}
    deinit{auditTimer?.invalidate();lifecycleObservers.forEach{NotificationCenter.default.removeObserver($0)}}
    private func markAuditStopping(){auditStopping=true;transport.audit.invalidatePendingStatus();publishAudit()}
    private func publishAudit(){
        let active=transport.audit.active,content=transport.audit.recordsContent,stopping=auditStopping
        if diagnosticLog.enabled,let observation=transport.audit.observation,observation != lastAuditObservation{
            let event:DiagnosticEvent
            switch observation {case .absent:event = .auditDiscoveryAbsent;case .invalid:event = .auditDiscoveryInvalid;case .unavailable:event = .auditDiscoveryUnavailable;case .expired:event = .auditDiscoveryExpired;case .deadlineOutOfRange:event = .auditDiscoveryDeadlineOutOfRange;case .retired:event = .auditDiscoveryRetired;case .available:event = .auditDiscoveryAvailable;case .backgroundExcluded:event = .auditDiscoveryBackground}
            diagnosticLog.record(event);lastAuditObservation=observation
        }
        guard active != lastAuditActive || content != lastAuditContent || stopping != lastAuditStopping else{return};lastAuditActive=active;lastAuditContent=content;lastAuditStopping=stopping;notifyListeners("event",data:["type":"audit","active":active,"contentEnabled":content,"stopping":stopping])
    }
    private lazy var voice:NativeVoice={let value=NativeVoice(transport:transport);value.diagnosticsEnabled={[weak self] in self?.diagnosticLog.enabled ?? false};value.auditStopping={[weak self] in self?.markAuditStopping()};value.diagnostic={[weak self] event,number in self?.diagnosticLog.record(event,value:number)};value.nextDiagnosticTurn={[weak self] in self?.diagnosticLog.nextTurn()};value.diagnosticTurn={[weak self] event,code,turn in self?.diagnosticLog.record(event,code:code,turn:turn)};value.diagnosticFailure={[weak self] event,code,turn,origin in self?.diagnosticLog.record(event,code:code,turn:turn,failureOrigin:origin)};value.authorizationChanged={[weak self] in self?.withdrawPersonal("Session authorization or scope changed.")};value.emit={[weak self] message in guard UIApplication.shared.applicationState == .active else{return};self?.notifyListeners("event",data:message)};return value}()
    private func perform(_ call:CAPPluginCall,_ work:@escaping()->Void){DispatchQueue.main.async{[weak self] in guard let self,let url=self.bridge?.webView?.url,url.scheme=="capacitor",url.host=="localhost" else{call.reject("Only the bundled app may use native audio.");return};work()}}
    private func calendarSourceAction(_ call:CAPPluginCall,_ operation:String){perform(call){[self] in
        guard let calendarSource else{call.resolve(["schemaVersion":"1.0.0","state":"unavailable","reason":"no_configuration"]);return}
        let input=call.options as? [String:Any] ?? [:]
        switch operation{case "permission":calendarSource.requestPermission(input:input){call.resolve($0)};case "metadata":calendarSource.discover(input:input){call.resolve($0)};case "save":calendarSource.save(input:input){call.resolve($0)};case "reconcile":calendarSource.reconcile(input:input){call.resolve($0)};default:calendarSource.prepare(input:input){call.resolve($0)}}
    }}
    private func healthConsentAction(_ call:CAPPluginCall,_ operation:String){perform(call){[self] in
        guard transport.effectiveIsSelf,let calendarSource else{call.resolve(["schemaVersion":"1.0.0","state":"unavailable","reason":"no_configuration","activation":"unavailable"]);return}
        calendarSource.healthSourceConsent(operation:operation,input:call.options as? [String:Any] ?? [:]){call.resolve($0)}
    }}
    @objc public func healthLoadSourceConsent(_ call:CAPPluginCall){healthConsentAction(call,"load")}
    @objc public func healthRequestSourceConsent(_ call:CAPPluginCall){healthConsentAction(call,"request")}
    @objc public func healthConfirmSourceConsent(_ call:CAPPluginCall){healthConsentAction(call,"confirm")}
    @objc public func healthRevokeSourceConsent(_ call:CAPPluginCall){healthConsentAction(call,"revoke")}
    @objc public func healthRecoverSourceConsent(_ call:CAPPluginCall){healthConsentAction(call,"recover")}
    private func calendarConsentAction(_ call:CAPPluginCall,_ operation:String){perform(call){[self] in
        guard transport.effectiveIsSelf,let calendarSource else{call.resolve(["schemaVersion":"1.0.0","state":"unavailable","reason":"no_configuration"]);return}
        calendarSource.sourceConsent(operation:operation,input:call.options as? [String:Any] ?? [:]){call.resolve($0)}
    }}
    @objc public func calendarLoadSourceConsent(_ call:CAPPluginCall){calendarConsentAction(call,"load")}
    @objc public func calendarRequestSourceConsent(_ call:CAPPluginCall){calendarConsentAction(call,"request")}
    @objc public func calendarConfirmSourceConsent(_ call:CAPPluginCall){calendarConsentAction(call,"confirm")}
    @objc public func calendarRevokeSourceConsent(_ call:CAPPluginCall){calendarConsentAction(call,"revoke")}
    @objc public func calendarRecoverSourceConsent(_ call:CAPPluginCall){calendarConsentAction(call,"recover")}
    @objc public func calendarReviewSourceConnection(_ call:CAPPluginCall){calendarConsentAction(call,"connectionReview")}
    @objc public func calendarConnectSource(_ call:CAPPluginCall){calendarConsentAction(call,"connect")}
    @objc public func calendarBootstrapReadPermission(_ call:CAPPluginCall){calendarSourceAction(call,"permission")}
    @objc public func calendarDiscoverSelections(_ call:CAPPluginCall){calendarSourceAction(call,"metadata")}
    @objc public func calendarPrepareSelection(_ call:CAPPluginCall){calendarSourceAction(call,"prepare")}
    @objc public func calendarSaveSelection(_ call:CAPPluginCall){calendarSourceAction(call,"save")}
    @objc public func calendarReconcileSelection(_ call:CAPPluginCall){calendarSourceAction(call,"reconcile")}
    @objc public func calendarCollectionDetailsChoice(_ call:CAPPluginCall){perform(call){[self] in call.resolve(healthHost.calendarCollectionDetailsChoice(input:call.options as? [String:Any] ?? [:]))}}
    @objc public func calendarCollectAndDeliverChoice(_ call:CAPPluginCall){perform(call){[self] in healthHost.calendarCollectAndDeliverChoice(input:call.options as? [String:Any] ?? [:]){call.resolve($0)}}}
    @objc public func calendarRequestReadPermissionChoice(_ call:CAPPluginCall){perform(call){[self] in healthHost.requestCalendarReadPermissionChoice(input:call.options as? [String:Any] ?? [:]){call.resolve($0)}}}
    @objc public func calendarLocalSetupChoices(_ call:CAPPluginCall){perform(call){[self] in
        guard transport.effectiveIsSelf,call.options.isEmpty else{call.resolve(NativeHealthHost.calendarLocalUnavailable("context_unavailable"));return}
        call.resolve(healthHost.calendarLocalSetupChoices())
    }}
    @objc public func calendarSetupExistingChoice(_ call:CAPPluginCall){perform(call){[self] in
        healthHost.performCalendarLocalSetupChoice(input:call.options as? [String:Any] ?? [:]){call.resolve($0)}
    }}
    @objc public func calendarSavedChoices(_ call:CAPPluginCall){perform(call){[self] in
        guard transport.effectiveIsSelf,call.options.isEmpty else{call.resolve(NativeHealthHost.calendarSavedUnavailable("context_unavailable"));return}
        call.resolve(healthHost.calendarSavedChoices())
    }}
    private func calendarSavedChoice(_ call:CAPPluginCall,_ operation:NativeHealthHost.CalendarSavedOperation){perform(call){[self] in
        healthHost.performCalendarSavedChoice(operation,input:call.options as? [String:Any] ?? [:]){call.resolve($0)}
    }}
    @objc public func calendarReconnectChoice(_ call:CAPPluginCall){calendarSavedChoice(call,.reconnect)}
    @objc public func calendarDeliverPendingChoice(_ call:CAPPluginCall){calendarSavedChoice(call,.deliverPending)}
    private func healthConfiguredSettings(_ call:CAPPluginCall,_ operation:String){perform(call){[self] in
        guard transport.effectiveIsSelf,let source=calendarSource,let input=call.options as? [String:Any] else{call.resolve(["schemaVersion":"1.0.0","state":"unavailable","reason":"configured_health_required","readKnowledge":"unknown","activation":"unavailable"]);return}
        switch operation{
        case "begin":source.healthBeginConfiguredSettings(input:input){call.resolve($0)}
        case "review":source.healthReviewConfiguredReturn(input:input){call.resolve($0)}
        case "confirm":source.healthConfirmConfiguredReturn(input:input){call.resolve($0)}
        default:source.healthResumeConfiguredReturn(input:input){call.resolve($0)}
        }
    }}
    @objc public func healthBeginConfiguredSettings(_ call:CAPPluginCall){healthConfiguredSettings(call,"begin")}
    @objc public func healthReviewConfiguredReturn(_ call:CAPPluginCall){healthConfiguredSettings(call,"review")}
    @objc public func healthConfirmConfiguredReturn(_ call:CAPPluginCall){healthConfiguredSettings(call,"confirm")}
    @objc public func healthResumeConfiguredReturn(_ call:CAPPluginCall){healthConfiguredSettings(call,"resume")}
    private func healthRemoteSetup(_ call:CAPPluginCall,_ operation:String){perform(call){[self] in
        guard transport.effectiveIsSelf,let source=calendarSource,let input=call.options as? [String:Any] else{call.resolve(["schemaVersion":"1.0.0","state":"unavailable","reason":"original_owner_unavailable","readKnowledge":"unknown","activation":"unavailable"]);return}
        switch operation{
        case "options":source.healthRemoteSetupOptions(input:input){call.resolve($0)}
        case "review":source.healthReviewRemoteSetup(input:input){call.resolve($0)}
        case "apply":source.healthApplyRemoteSetup(input:input){call.resolve($0)}
        default:source.healthRecoverRemoteSetup(input:input){call.resolve($0)}
        }
    }}
    @objc public func healthRemoteSetupOptions(_ call:CAPPluginCall){healthRemoteSetup(call,"options")}
    @objc public func healthReviewRemoteSetup(_ call:CAPPluginCall){healthRemoteSetup(call,"review")}
    @objc public func healthApplyRemoteSetup(_ call:CAPPluginCall){healthRemoteSetup(call,"apply")}
    @objc public func healthRecoverRemoteSetup(_ call:CAPPluginCall){healthRemoteSetup(call,"recover")}
    @objc public func healthPrepareExistingSource(_ call:CAPPluginCall){perform(call){[self] in
        guard transport.effectiveIsSelf,let input=call.options as? [String:Any],let source=calendarSource else{
            call.resolve(["schemaVersion":"1.0.0","state":"unavailable","reason":"original_owner_unavailable","readKnowledge":"unknown"]);return
        }
        source.prepareExistingHealth(input:input){call.resolve($0)}
    }}
    @objc public func healthRememberedChoice(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active,let input=call.options as? [String:Any] else{call.resolve(["state":"unavailable"]);return}
        healthHost.savedHealthChoice(input){call.resolve($0)}
    }}
    @objc public func healthSavedRecoveryChoice(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active,let source=calendarSource,let input=call.options as? [String:Any] else{call.resolve(["state":"unavailable"]);return}
        source.savedHealthRecoveryChoice(input:input){call.resolve($0)}
    }}
    @objc public func healthObservationChoice(_ call:CAPPluginCall){perform(call){[self] in
        guard transport.effectiveIsSelf,let input=call.options as? [String:Any] else{call.resolve(["schemaVersion":"1.0.0","operation":"status","state":"unavailable","reason":"current_connection_required","catalogId":NSNull(),"choice":NSNull(),"readKnowledge":"unknown","plans":[]] as [String:Any]);return}
        healthHost.observationChoice(input){call.resolve($0)}
    }}
    @objc public func healthSetupChoices(_ call:CAPPluginCall){perform(call){[self] in
        guard transport.effectiveIsSelf,call.options.isEmpty else{call.resolve(["schemaVersion":"1.0.0","state":"unavailable","reason":"context_unavailable","catalogId":NSNull(),"choices":[]] as [String:Any]);return}
        healthHost.loadSetupChoices{call.resolve($0)}
    }}
    private func healthChoice(_ call:CAPPluginCall,_ kind:NativeHealthChoiceAction.Kind){perform(call){[self] in
        guard transport.effectiveIsSelf,let input=call.options as? [String:Any] else{call.resolve(NativeHealthHost.choiceReply(kind:kind,reason:"context_unavailable",value:kind == .sync ? NSNull():"notInvoked"));return}
        healthHost.performChoice(kind,input:input){call.resolve($0)}
    }}
    @objc public func healthSetupChoice(_ call:CAPPluginCall){healthChoice(call,.setup)}
    @objc public func healthRequestReadPermission(_ call:CAPPluginCall){healthChoice(call,.permission)}
    @objc public func healthSyncChoice(_ call:CAPPluginCall){healthChoice(call,.sync)}
    @objc public func healthInventory(_ call:CAPPluginCall){perform(call){[self] in
        healthHost.loadInventory { result in
            switch result { case .success(let value): call.resolve(value); case .failure: call.reject("Health connection details are unavailable. Check your connection and sign-in.") }
        }
    }}
    private func calendarResult(_ result:NativeCalendarAcquisitionOwner.DeliveryOutcome)->[String:Any]{
        switch result {
        case .settled(let accepted,let rejected,let retryable,let more,let acquired):return ["state":"settledPrefix","acceptedOrDuplicate":accepted,"rejected":rejected,"retryable":retryable,"mayHaveMore":more,"acquired":acquired as Any? ?? NSNull()]
        case .emptyPending:return ["state":"emptyPending"]
        case .requestTooLarge:return ["state":"retained","reason":"request_too_large"]
        case .transportFailure:return ["state":"retained","reason":"transport"]
        case .invalidReceipt:return ["state":"retained","reason":"receipt"]
        case .settlementUnconfirmed,.acquisitionUnconfirmed:return ["state":"unconfirmed"]
        case .notApplied,.acquisitionNotApplied:return ["state":"unavailable"]
        }
    }
    @objc public func calendarSetup(_ call:CAPPluginCall){perform(call){[self] in
        guard transport.effectiveIsSelf,let selection=call.getString("selection"),!selection.isEmpty,selection.utf8.count<=128 else{call.resolve(NativeHealthRuntime.CalendarSetupResult.unavailable.response);return}
        healthHost.setupCalendar(selection:selection){call.resolve($0.response)}
    }}
    @objc public func calendarReconnect(_ call:CAPPluginCall){perform(call){[self] in
        guard transport.effectiveIsSelf,let selection=call.getString("selection"),!selection.isEmpty,selection.utf8.count<=128 else{call.resolve(NativeHealthRuntime.CalendarReconnectResult.unavailable.response);return}
        healthHost.reconnectCalendar(selection:selection){call.resolve($0.response)}
    }}
    @objc public func calendarCollectAndDeliver(_ call:CAPPluginCall){perform(call){[self] in
        guard let selection=call.getString("selection"),transport.effectiveIsSelf else{call.reject("Calendar selection unavailable.");return}
        healthHost.calendarCollectAndDeliver(selection:selection){call.resolve(self.calendarResult($0))}
    }}
    @objc public func calendarDeliverPending(_ call:CAPPluginCall){perform(call){[self] in
        guard let selection=call.getString("selection"),transport.effectiveIsSelf else{call.reject("Calendar selection unavailable.");return}
        healthHost.calendarDeliverPending(selection:selection){call.resolve(self.calendarResult($0))}
    }}
    @objc public func calendarCancel(_ call:CAPPluginCall){perform(call){[self] in healthHost.calendarCancel();call.resolve()}}
    @objc public func healthSetup(_ call:CAPPluginCall){perform(call){[self] in
        guard let selection=call.getString("selection"),let raw=call.getString("action") else{call.reject("Select an existing Health connection.");return}
        let action:NativeHealthRuntime.LocalSetup
        switch raw {case "setup":action = .enrollExistingRemote;case "confirm":action = .confirmExistingLocal;case "resume":action = .resumeExistingLocal;case "rebind":action = .rebindExistingLocal;default:call.reject("Invalid Health action.");return}
        healthHost.setup(selection:selection,action:action){ result in switch result{case .success:call.resolve(self.healthHost.status());case .failure:call.reject("Health connection is unavailable.")}}
    }}
    @objc public func healthStatus(_ call:CAPPluginCall){perform(call){[self] in guard let input=call.options as? [String:Any] else{call.resolve(NativeHealthSelectedStatus.response("unavailable","invalid_request"));return};healthHost.selectedStatus(input){call.resolve($0)}}}
    @objc public func healthPauseCollection(_ call:CAPPluginCall){perform(call){[self] in
        guard let input=call.options as? [String:Any] else{call.resolve(NativeHealthPauseResponse.make(id:nil,reason:"invalid_request"));return}
        healthHost.pauseCollection(input){call.resolve($0)}
    }}
    @objc public func healthResumeCollection(_ call:CAPPluginCall){perform(call){[self] in
        guard let input=call.options as? [String:Any] else{call.resolve(NativeHealthResumeResponse.make(id:nil,reason:"invalid_request"));return}
        healthHost.resumeCollection(input){call.resolve($0)}
    }}
    @objc public func healthSync(_ call:CAPPluginCall){perform(call){[self] in
        guard let selection=call.getString("selection"),let category=call.getString("category"),HealthKitCollector.supportedCategories.contains(category) else{call.reject("Invalid Health selection.");return}
        healthHost.sync(selection:selection,category:category){result in switch result{case .success:call.resolve(self.healthHost.status());case .failure:call.reject("Health sync is unavailable.")}}
    }}
    @objc public func configure(_ call:CAPPluginCall){perform(call){[self] in
        guard let endpoint=call.getString("endpoint") else{call.reject("Enter an HTTPS server address.");return}
        voicePreview.stop();audioProbe.stop();pendingPersonalLock=nil;withdrawPersonal("Server changed",notify:false);text.stop();voice.stop("Server changed")
        do{try transport.configure(endpoint,username:call.getString("username") ?? "");call.resolve(["configured":true])}catch{call.reject("Use an HTTPS server origin without a path, credentials or query.")}
    }}
    @objc public func restoreConnection(_ call:CAPPluginCall){perform(call){[self] in
        diagnosticLog.record(.connectionRestoreNativeStart);voicePreview.stop();audioProbe.stop();withdrawPersonal("Restoring connection",notify:false);text.stop();voice.stop("Restoring connection")
        restoreOriginalConnection{result in
            switch result{case .success(let restored):self.diagnosticLog.record(.connectionRestoreNativeDone);DispatchQueue.main.async{[weak self] in guard let self,UIApplication.shared.applicationState == .active else{return};self.legacyHealthForeground()};call.resolve(restored);case .failure:self.diagnosticLog.record(.connectionRestoreNativeFailed);call.reject("Saved connection is unavailable. Unlock this device and try again.")}
        }
    }}
    @objc public func forgetSession(_ call:CAPPluginCall){perform(call){[self] in
        voicePreview.stop();audioProbe.stop();pendingPersonalLock=nil;withdrawPersonal("Signed out",notify:false);text.stop();voice.stop("Signed out")
        do{try transport.forgetSession();call.resolve()}catch{call.reject("Could not clear the saved session. Unlock the device and try signing out again.")}
    }}
    @objc public func saveSettings(_ call:CAPPluginCall){perform(call){[self] in
        audioProbe.stop();do{try transport.saveSettings(call.getString("settings") ?? "{}");call.resolve()}catch{call.reject("Could not save settings on this device.")}
    }}
    @objc public func request(_ call:CAPPluginCall){perform(call){[self] in
        guard let path=call.getString("path") else{call.reject("Missing request path.");return}
        let method=call.getString("method") ?? "GET"
        if method=="POST",path.contains("/voices"),voicePreview.busy{call.reject("Wait for voice preview playback to finish or stop.");return}
        let kind:DiagnosticEvent = path.hasPrefix("/api/auth/") ? .httpAuth : path.hasPrefix("/api/runtime/v1/audience") ? .httpAudience : path=="/api/runtime/v1/session-context" ? .httpSession : path.hasPrefix("/api/runtime/v1/conversations") ? .httpHistory : .httpOther
        let logging=diagnosticLog.enabled,repetitive=method=="GET" && path=="/api/runtime/v1/audience",started=logging ? ProcessInfo.processInfo.systemUptime:0
        if logging && !repetitive{diagnosticSequence=diagnosticSequence%384_000+1;diagnosticLog.record(kind,value:diagnosticSequence)}
        let correlation=diagnosticSequence
        if method != "GET",!path.hasSuffix("/messages"){audioProbe.stop();if !EndpointPolicy.preservesAudience(path,method:method),path != "/api/runtime/v1/audience/personal-session"{withdrawPersonal("Session settings changed",notify:false)};text.stop();voice.stop("Session settings changed")}
        let personalBody=call.getString("body")
        if method=="POST",path=="/api/runtime/v1/audience/personal-session",let raw=personalBody,let body=(try? JSONSerialization.jsonObject(with:Data(raw.utf8))) as? [String:Any],let operation=body["operation"] as? String {
            if operation == "lock" {
                if let pending=pendingPersonalLock,pending != raw {call.reject("Retry the pending lock before changing this session.");return}
                pendingPersonalLock=raw;withdrawPersonal("Personal session locked.")
                do{try transport.persistPendingLock(raw)}catch{call.reject("Lock is active on this phone, but its pending request could not be saved. Reconnect and retry.");return}
            } else if operation == "unlock",pendingPersonalLock != nil || transport.pendingLockState().state != "none" {call.reject("Finish the pending lock before unlocking.");return}
        }
        let personalTicket=personalAccess.generation
        transport.request(path,method:method,body:call.getString("body")){[weak self] result in
            switch result{case .failure:if logging{self?.diagnosticLog.record(kind,durationMs:Int(min(3_600_000,max(0,(ProcessInfo.processInfo.systemUptime-started)*1000))),value:correlation,code:.networkUnavailable)};call.reject("The server could not be reached securely.")
            case .success(let (data,response)):
                if logging && (!repetitive || response.statusCode>=400){
                    var code:DiagnosticCode?;if response.statusCode>=400,data.count<=4096,let object=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any]{let raw=(object["code"] as? String) ?? ((object["error"] as? [String:Any])?["code"] as? String);if let raw{code=DiagnosticCode(rawValue:raw) ?? .unknown}}
                    self?.diagnosticLog.record(kind,status:response.statusCode,durationMs:Int(min(3_600_000,max(0,(ProcessInfo.processInfo.systemUptime-started)*1000))),value:correlation,code:code)
                }
                if let self,path=="/api/runtime/v1/audience/personal-session",self.personalAccess.generation==personalTicket {
                    if let pending=self.pendingPersonalLock,method=="POST",personalBody==pending,response.statusCode==200,let body=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],body["personalSessionPolicy"] as? String == "personalDevice",body["personalSessionState"] as? String == "locked" {do{try self.transport.confirmPendingLock(pending);self.pendingPersonalLock=nil}catch{call.reject("Lock was acknowledged, but its pending request could not be cleared on this phone.");return}}
                    let parsed=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any]
                    let appResponse=response.statusCode==200 && parsed?["personalSessionPolicy"] as? String == "personalApp"
                    let owner=self.transport.currentEffectiveOwner
                    let canObserve=appResponse ? self.transport.effectiveIsSelf && self.transport.personalAppPendingState().state == "none" : self.pendingPersonalLock==nil && self.transport.hasEffectiveOwner && self.transport.pendingLockState().state == "none"
                    if canObserve || response.statusCode==401 || response.statusCode==403 {
                        let wasEnabled=self.personalAccess.enabled
                        let enabled=self.personalAccess.observe(status:response.statusCode,data:data,ticket:personalTicket,expectedPrincipal:owner?.principal,expectedSession:owner?.session)
                        if enabled && appResponse {self.pendingPersonalLock=nil}
                        if wasEnabled && !enabled{self.withdrawPersonal("Personal session authorization changed.")}
                    } else if appResponse {self.withdrawPersonal("A current-session withdrawal remains unconfirmed.")}

                } else if response.statusCode==401 && path.hasPrefix("/api/"){self?.withdrawPersonal("Sign-in expired.")}
                let binary=path.hasPrefix("/api/runtime/v1/presentation/resources/")
                call.resolve(["status":response.statusCode,"body":binary ? data.base64EncodedString():String(data:data,encoding:.utf8) ?? "","encoding":binary ? "base64":"utf8"])
            }
        }
    }}
    @objc public func pendingPersonalLock(_ call:CAPPluginCall){perform(call){[self] in
        let confirmed=personalAccess.enabled && personalAccess.policy == "personalApp";let value=confirmed ? transport.personalAppPendingState() : transport.pendingLockState();var result:[String:Any]=["state":value.state,"unresolvedElsewhere":value.unresolvedElsewhere,"personalAppConfirmed":confirmed]
        if let body=value.body{result["body"]=body;pendingPersonalLock=body;personalAccess.withdraw()}
        if value.state=="mismatch"{personalAccess.withdraw()}
        call.resolve(result)
    }}
    @objc public func setBackgroundPolicy(_ call:CAPPluginCall){perform(call){[self] in audioProbe.stop();continueWhenLocked=call.getBool("enabled") ?? false;call.resolve()}}
    @objc public func sendText(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active,personalAccess.enabled,
              let assistant=call.getString("assistantId"),let prompt=call.getString("userInput"),let trace=call.getString("trace") else{call.reject("Open the app and enter a message for the selected Assistant.");return}
        let turn=diagnosticLog.nextTurn();diagnosticLog.record(.textStart,turn:turn);audioProbe.stop();voice.stop("Sending text; microphone is off.")
        text.send(["assistantId":assistant,"userInput":prompt,"trace":trace],diagnosticTurn:turn){result in
            guard UIApplication.shared.applicationState == .active else{call.reject("Text response stopped because the display is locked.");return}
            switch result{
            case .success(let reply):self.diagnosticLog.record(.textDone,turn:turn);call.resolve(reply)
            case .failure(let error):
                self.diagnosticLog.record(.textFailed,turn:turn)
                if let textError=error as? NativeTextError,case .contextChanged(let preparation)=textError {self.diagnosticLog.record(.textContextChanged,code:preparation ? .contextPreparation:.contextValidation,turn:turn);call.reject(error.localizedDescription,"runtime_context_changed")}
                else{call.reject(error.localizedDescription)}
            }
        }
    }}
    @objc public func cancelText(_ call:CAPPluginCall){perform(call){[self] in diagnosticLog.record(.textCancelled);text.stop();call.resolve()}}
    @objc public func start(_ call:CAPPluginCall){perform(call){[self] in
        guard !voicePreview.busy else{call.reject("Wait for voice preview playback to finish or stop.");return}
        guard personalAccess.enabled,let request=call.getObject("request") else{call.reject("Select a current session first.");return}
        diagnosticLog.record(.voiceStart);audioProbe.stop();continueWhenLocked=call.getBool("background") ?? false;text.stop();voice.start(request,background:continueWhenLocked){error in if error != nil{self.diagnosticLog.record(.voiceFailed);let detail=self.voice.snapshot()["lastError"] as? String;call.reject(detail?.isEmpty==false ? detail!:"Audio could not start. Check microphone permission, sign-in and audience.")}else{self.diagnosticLog.record(.voiceTransportStarted);call.resolve(self.voice.snapshot())}}
    }}
    @objc public func stop(_ call:CAPPluginCall){perform(call){[self] in diagnosticLog.record(.voiceStop);audioProbe.stop();text.stop();voice.stop();call.resolve(voice.snapshot())}}
    @objc public func finishUtterance(_ call:CAPPluginCall){perform(call){[self] in
        guard voice.finishUtterance() else{call.reject("There is no active speech to finish.");return}
        call.resolve(voice.snapshot())
    }}
    @objc public func startVoicePreview(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active,personalAccess.enabled,let request=call.getObject("request") else{call.reject("Open the app and establish a private session before previewing.");return}
        audioProbe.stop();text.stop();voice.stop("Preparing voice preview.")
        voicePreview.start(request){result in switch result{case .success(let value):call.resolve(value);case .failure:call.reject("The voice preview did not complete. Wait for output ownership to clear before trying again.")}}
    }}
    @objc public func voicePreviewStatus(_ call:CAPPluginCall){perform(call){[self] in call.resolve(voicePreview.status)}}
    @objc public func stopVoicePreview(_ call:CAPPluginCall){perform(call){[self] in voicePreview.stop();call.resolve()}}
    @objc public func startAudioProbe(_ call:CAPPluginCall){perform(call){[self] in
        guard !voicePreview.busy else{call.reject("Wait for voice preview playback to finish or stop.");return}
        guard UIApplication.shared.applicationState == .active,let raw=call.getString("mode"),let mode=NativePlaybackProbe.Mode(rawValue:raw) else{call.reject("Open the app and select a local audio test.");return}
        text.stop();voice.stop("Conversation stopped for the local audio test. Tap Start listening afterward to resume.")
        audioProbe.start(mode){error in if let error{call.reject(error)}else{call.resolve(["active":true])}}
    }}
    @objc public func stopAudioProbe(_ call:CAPPluginCall){perform(call){[self] in audioProbe.stop();call.resolve()}}
    @objc public func copyAudioDiagnostics(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active else{call.reject("Open the app before copying audio diagnostics.");return}
        // Copy only native diagnostic metadata. Never serialize the full snapshot:
        // it also contains route names, conversation identifiers and UI state.
        let snapshot=voice.snapshot()
        func lines(_ key:String)->String{(snapshot[key] as? [String] ?? []).suffix(24).map{String($0.prefix(512))}.joined(separator:"\n")}
        let playback=lines("playbackDiagnostics"),capture=lines("captureDiagnostics"),probe=audioProbe.diagnosticsText()
        let sections=[("Playback",playback),("Capture",capture),("Local test",probe)].filter{!$0.1.isEmpty}
        guard !sections.isEmpty else{call.reject("No audio diagnostics yet. Start listening or run a local test first.");return}
        let text="Lifestream audio diagnostics\n"+sections.map{"\($0.0)\n\($0.1)"}.joined(separator:"\n\n")
        UIPasteboard.general.setItems([["public.utf8-plain-text":text]],options:[.localOnly:true,.expirationDate:Date(timeIntervalSinceNow:300)])
        call.resolve(["copied":true])
    }}
    @objc public func diagnosticsStatus(_ call:CAPPluginCall){perform(call){[self] in call.resolve(["enabled":diagnosticLog.enabled,"count":diagnosticLog.count,"storageError":diagnosticLog.failed,"auditActive":transport.audit.active,"auditContent":transport.audit.recordsContent,"auditStopping":auditStopping])}}
    @objc public func setDiagnosticsEnabled(_ call:CAPPluginCall){perform(call){[self] in
        guard let enabled=call.getBool("enabled") else{call.reject("Choose whether diagnostics are enabled.");return}
        diagnosticLog.setEnabled(enabled);if enabled{lastAuditObservation=nil;publishAudit()};call.resolve(["enabled":diagnosticLog.enabled,"count":diagnosticLog.count])
    }}
    @objc public func logDiagnostic(_ call:CAPPluginCall){perform(call){[self] in
        guard let name=call.getString("event"),let event=DiagnosticEvent(rawValue:name) else{call.reject("Unknown diagnostic event.");return}
        // The web view can report an enumerated stage only; numeric observations
        // and error codes originate from native owners, never from page data.
        diagnosticLog.record(event)
        call.resolve()
    }}
    @objc public func clearDiagnostics(_ call:CAPPluginCall){perform(call){[self] in diagnosticLog.clear();transport.audit.clear();lastAuditObservation=nil;call.resolve(["count":0])}}
    @objc public func shareDiagnostics(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active,let controller=bridge?.viewController,controller.viewIfLoaded?.window != nil,controller.presentedViewController==nil,!controller.isBeingDismissed else{call.reject("Open the app and close other panels before sharing diagnostics.");return}
        guard diagnosticLog.count>0 else{call.reject("There are no diagnostic events to share yet.");return}
        let file:URL;do{file=try diagnosticLog.exportFile()}catch{call.reject("The diagnostic file could not be prepared on this device.");return}
        let sheet=UIActivityViewController(activityItems:[file],applicationActivities:nil)
        if let popover=sheet.popoverPresentationController{popover.sourceView=controller.view;popover.sourceRect=CGRect(x:controller.view.bounds.midX,y:controller.view.bounds.midY,width:1,height:1);popover.permittedArrowDirections=[]}
        sheet.completionWithItemsHandler={_,completed,_,_ in DiagnosticExportFile.finish(file);call.resolve(["shared":completed])}
        controller.present(sheet,animated:true)
    }}
    @objc public func shareAuditDiagnostics(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active,let controller=bridge?.viewController,controller.viewIfLoaded?.window != nil,controller.presentedViewController==nil,!controller.isBeingDismissed else{call.reject("Open the app and close other panels before sharing diagnostics.");return}
        let file:URL;do{file=try NativeAuditExport.prepare(entries:transport.audit.snapshot(),in:FileManager.default.temporaryDirectory.appendingPathComponent("lifestream-audit-shares",isDirectory:true))}catch NativeAuditExport.Failure.empty{diagnosticLog.record(.auditShareEmpty);call.reject("There are no audit events to share yet.");return}catch{call.reject("The audit file could not be prepared on this device.");return}
        let sheet=UIActivityViewController(activityItems:[file],applicationActivities:nil)
        if let popover=sheet.popoverPresentationController{popover.sourceView=controller.view;popover.sourceRect=CGRect(x:controller.view.bounds.midX,y:controller.view.bounds.midY,width:1,height:1);popover.permittedArrowDirections=[]}
        sheet.completionWithItemsHandler={_,completed,_,_ in DiagnosticExportFile.finish(file);call.resolve(["shared":completed])};DispatchQueue.main.asyncAfter(deadline:.now()+3600){DiagnosticExportFile.finish(file)};controller.present(sheet,animated:true)
    }}
    @objc public func snapshot(_ call:CAPPluginCall){perform(call){[self] in call.resolve(voice.snapshot())}}
    @objc public func routePicker(_ call:CAPPluginCall){perform(call){[self] in
        guard UIApplication.shared.applicationState == .active,let controller=bridge?.viewController,
              controller.viewIfLoaded?.window != nil else{call.reject("Open the app to choose a microphone.");return}
        guard controller.presentedViewController==nil,!controller.isBeingDismissed else{call.reject("Close the current panel, then open Microphone again.");return}
        audioProbe.stop()
        let choices=voice.inputChoices()
        let discovery=choices.count>2 ? "Connected inputs listed below are checked again at Start.":"iOS currently exposes no external microphone choices. System default follows the iOS input route, including a connected headset. Inputs are checked again at Start."
        let panel=UIAlertController(title:"Microphone",message:"Selected: \(voice.inputSelectionSummary()).\n\nChoosing stops the current conversation and applies on your next Start. It does not begin recording.\n\n"+discovery+"\n\nBluetooth microphone selection may also move playback to that headset. Use iOS Control Center for playback destinations.",preferredStyle:.actionSheet)
        for choice in choices {
            let title=choice.label+(choice.id==voice.selectedInput ? " (selected)":"")
            panel.addAction(UIAlertAction(title:title,style:.default){[weak self] _ in self?.voice.selectInput(choice.id)})
        }
        panel.addAction(UIAlertAction(title:"Cancel",style:.cancel))
        if let popover=panel.popoverPresentationController{popover.sourceView=controller.view;popover.sourceRect=CGRect(x:controller.view.bounds.midX,y:controller.view.bounds.midY,width:1,height:1);popover.permittedArrowDirections=[]}
        controller.present(panel,animated:true){if panel.presentingViewController != nil{call.resolve()}else{call.reject("The microphone panel could not open. Close other panels and try again.")}}
    }}
}
public final class AssistantViewController:CAPBridgeViewController {
    private var shields=[NSObjectProtocol]()
    private var shield:UIView?
    public override func capacitorDidLoad(){bridge?.registerPluginInstance(AssistantPlugin(calendarRegistration:NativeCalendarAppComposition.standardApplicationRegistration()))}
    public override func viewDidLoad(){
        super.viewDidLoad()
        shields.append(NotificationCenter.default.addObserver(forName:UIApplication.willResignActiveNotification,object:nil,queue:.main){[weak self] _ in self?.protectDisplay()})
        shields.append(NotificationCenter.default.addObserver(forName:UIApplication.didBecomeActiveNotification,object:nil,queue:.main){[weak self] _ in self?.bridge?.webView?.evaluateJavaScript("document.dispatchEvent(new Event('lifestream-native-resume'))"){[weak self] _,error in if error==nil{self?.shield?.removeFromSuperview();self?.shield=nil}}})
    }
    private func protectDisplay(){
        guard shield==nil else{return}
        let cover=UIView(frame:view.bounds);cover.autoresizingMask=[.flexibleWidth,.flexibleHeight];cover.backgroundColor = .systemBackground
        let label=UILabel(frame:cover.bounds);label.autoresizingMask=[.flexibleWidth,.flexibleHeight];label.text="Lifestream";label.textAlignment = .center
        cover.addSubview(label);view.addSubview(cover);shield=cover
    }
    deinit{shields.forEach{NotificationCenter.default.removeObserver($0)}}
}
