import Foundation
import CoreFoundation
import AssistantCore

/// Original native configuration inputs only; no bridge decoder or installed default.
struct NativeHealthSetupDescriptor {
    let selector:String,revision:Int,title:String,destinationLabel:String
    let namespace:UUID,configuration:NativeHealthRuntime.Configuration
    let localSetup:NativeHealthRuntime.LocalSetup
    let configuredLocalConfirmed:Bool
    init(selector:String,revision:Int,title:String,destinationLabel:String,namespace:UUID,configuration:NativeHealthRuntime.Configuration,localSetup:NativeHealthRuntime.LocalSetup = .enrollExistingRemote,configuredLocalConfirmed:Bool=false){
        self.selector=selector;self.revision=revision;self.title=title;self.destinationLabel=destinationLabel;self.namespace=namespace;self.configuration=configuration;self.localSetup=localSetup;self.configuredLocalConfirmed=configuredLocalConfirmed
    }
    func matches(_ other:Self)->Bool {
        Data(selector.utf8)==Data(other.selector.utf8) && revision==other.revision && Data(title.utf8)==Data(other.title.utf8) &&
        Data(destinationLabel.utf8)==Data(other.destinationLabel.utf8) && namespace==other.namespace && configuredLocalConfirmed==other.configuredLocalConfirmed && localSetup==other.localSetup && configuration.matches(other.configuration)
    }
    var valid:Bool {
        func label(_ s:String)->Bool{!s.isEmpty && s.unicodeScalars.count<=120 && s.utf8.count<=512 && !s.unicodeScalars.contains{$0.value<32}}
        return !selector.isEmpty && selector.utf8.count<=128 && revision>0 && revision<=9007199254740991 && label(title) && label(destinationLabel) && configuration.valid && (localSetup == .enrollExistingRemote || localSetup == .confirmExistingLocal)
    }
}
final class NativeHealthChoiceCurrency {
    let owner:AnyObject
    private let descriptors:[NativeHealthSetupDescriptor]
    private weak var host:NativeHealthHost?
    private var bindingWasSet=false
    private(set) var revoked=false
    init(owner:AnyObject,descriptors:[NativeHealthSetupDescriptor]){self.owner=owner;self.descriptors=descriptors}
    fileprivate func matches(_ values:[NativeHealthSetupDescriptor])->Bool{values.count==descriptors.count && zip(values,descriptors).allSatisfy{$0.0.matches($0.1)}}
    fileprivate func bind(_ original:NativeHealthHost)->Bool {
        precondition(Thread.isMainThread)
        guard !revoked,!bindingWasSet else{return false};bindingWasSet=true;host=original;return true
    }
    /// ORIGINAL owner must call before every bound change, including ABA. A
    /// weak Host disappearing never permits rebinding this one-way currency.
    func revoke(){
        precondition(Thread.isMainThread)
        guard !revoked else{return};revoked=true;host?.invalidateChoiceCurrency(self)
    }
}
struct NativeHealthSetupChoicePort {
    let owner:AnyObject,currency:NativeHealthChoiceCurrency?
    let descriptors:[NativeHealthSetupDescriptor]
}
final class NativeHealthChoiceAction {
    enum Kind:String {case setup,permission,sync}
    let id=UUID(),kind:Kind,record:NativeHealthHost.ChoiceRecord,catalog:NativeHealthHost.ChoiceCatalog
    private weak var host:NativeHealthHost?
    var runtime:NativeHealthRuntime?,invoked=false
    init(host:NativeHealthHost,kind:Kind,record:NativeHealthHost.ChoiceRecord,catalog:NativeHealthHost.ChoiceCatalog){self.host=host;self.kind=kind;self.record=record;self.catalog=catalog}
    /// Concrete original owner fields only. Never calls a provider, SDK or store.
    func isCurrent()->Bool{host?.choiceActionCurrent(self)==true}
}

/// Read-only owner inventory entry point. No HealthKit permission or collection is started here.
final class NativeHealthHost {
    enum Failure: Error { case currentness, unavailable }
    private let transport: NativeTransport
    private let inventory: NativeHealthInventory
    typealias TrustedConfiguration = (String) -> NativeHealthRuntime.Configuration?
    private var configuration: TrustedConfiguration?
    struct CalendarSelection {
        let runtimeSelection:String;let configuration:NativeHealthRuntime.CalendarConfiguration
        let setup:NativeHealthRuntime.CalendarSetup?
        let reconnect:NativeHealthRuntime.CalendarReconnect?
        init(runtimeSelection:String,configuration:NativeHealthRuntime.CalendarConfiguration,setup:NativeHealthRuntime.CalendarSetup?=nil,reconnect:NativeHealthRuntime.CalendarReconnect?=nil){self.runtimeSelection=runtimeSelection;self.configuration=configuration;self.setup=setup;self.reconnect=reconnect}
    }
    typealias TrustedRootConfiguration=(String)->NativeHealthRuntime.RootConfiguration?
    private let rootConfiguration:TrustedRootConfiguration?
    typealias TrustedCalendarConfiguration=(String)->CalendarSelection?
    private let calendarConfiguration:TrustedCalendarConfiguration?
    private let calendarChoiceProfile:NativeCalendarSavedProfile?
    private var calendarSavedCatalog:CalendarSavedCatalog?,calendarSavedAction:CalendarSavedAction?
    private var calendarLocalCatalog:CalendarLocalCatalog?,calendarLocalAction:CalendarLocalAction?
    private var calendarLocalListing=false
    private var calendarLocalObservations:[Data:NativeHealthRuntime.CalendarSetupResult]=[:]
    private var calendarReadPermissionAction:NativeCalendarReadPermissionAction?
    private var calendarReadPermissionScope:(CalendarSavedCatalog,CalendarSavedRecord)?
    private var calendarManualAction:CalendarManualAction?
    private var calendarManualReviewing=false
    private var calendarListing=false
    private var calendarChoiceBusy:Bool{calendarManualAction != nil || calendarManualReviewing || calendarReadPermissionAction != nil || calendarListing || calendarSavedAction != nil || calendarLocalListing || calendarLocalAction != nil}
    private var choicePort:NativeHealthSetupChoicePort?
    private var choiceBound=false,choiceLoad:UUID?
    private var choiceCatalog:ChoiceCatalog?,choiceAction:NativeHealthChoiceAction?
    private var choiceBusy:Bool{choiceLoad != nil || choiceAction != nil || observationJob != nil || savedChoiceJob != nil}
    private final class ObservationJob {
        let catalog:ChoiceCatalog,record:ChoiceRecord,runtime:NativeHealthRuntime
        var cancelled=false
        init(_ c:ChoiceCatalog,_ r:ChoiceRecord,_ runtime:NativeHealthRuntime){catalog=c;record=r;self.runtime=runtime}
    }
    private var observationJob:ObservationJob?
    private var calendarEntering=false,healthEntering=false
    private var lifecycleGeneration:UInt64=0
    private(set) var runtime: NativeHealthRuntime?
    private var retiring: NativeHealthRuntime?
    private var lastRetiredHealthRuntime:NativeHealthRuntime?
    private final class SavedHealthRetirement {
        let runtime:NativeHealthRuntime,completion:(Bool)->Void
        var drained=false,publishing=false,reported=false
        init(_ runtime:NativeHealthRuntime,_ completion:@escaping(Bool)->Void){self.runtime=runtime;self.completion=completion}
    }
    private var savedHealthRetirement:SavedHealthRetirement?
    private final class SavedChoiceJob {
        let catalog:ChoiceCatalog,record:ChoiceRecord,runtime:NativeHealthRuntime
        var cancelled=false
        init(_ catalog:ChoiceCatalog,_ record:ChoiceRecord,_ runtime:NativeHealthRuntime){self.catalog=catalog;self.record=record;self.runtime=runtime}
    }
    private var savedChoiceJob:SavedChoiceJob?
    private var selection: String?
    init(transport: NativeTransport, configuration: TrustedConfiguration? = nil,calendarConfiguration:TrustedCalendarConfiguration?=nil,rootConfiguration:TrustedRootConfiguration?=nil,choicePort:NativeHealthSetupChoicePort?=nil,calendarChoiceProfile:NativeCalendarSavedProfile?=nil) {
        self.transport = transport; self.inventory = NativeHealthInventory(transport: transport); self.configuration = configuration;self.calendarConfiguration=calendarConfiguration;self.rootConfiguration=rootConfiguration;self.choicePort=choicePort;self.calendarChoiceProfile=calendarChoiceProfile
        if let port=choicePort,let currency=port.currency,currency.owner === port.owner,currency.matches(port.descriptors){choiceBound=currency.bind(self)}
    }
    /// Initial attachment only; no factory, storage callback or replacement owner.
    func installHealthConfiguration(configuration:@escaping TrustedConfiguration,port:NativeHealthSetupChoicePort,runtime original:NativeHealthRuntime)->Bool {
        precondition(Thread.isMainThread)
        guard canInstallHealthConfiguration(runtime:original),original.configuration==nil,original.choiceAdmissionAvailable,original.choiceSourceCurrent,
              port.descriptors.count==1,let descriptor=port.descriptors.first,descriptor.valid,
              descriptor.configuration.rootConfiguration.identity==original.rootConfiguration.identity,
              let currency=port.currency,currency.owner === port.owner,currency.matches(port.descriptors),currency.bind(self) else{return false}
        self.configuration=configuration;choicePort=port;choiceBound=true;runtime=original;selection=descriptor.selector;healthSettingsReady=false;healthSettingsOriginal=nil
        return true
    }
    private var healthSettingsRevocation:NativeHealthChoiceCurrency?
    private var healthSettingsOriginal:NativeHealthRuntime?
    private var healthSettingsRetiring=false,healthSettingsReady=false,healthSettingsPublishing=false
    private var healthSettingsCurrent:(()->Bool)?,healthSettingsPublished:(()->Void)?
    var canEnterConfiguredHealthSettings:Bool{configuration != nil && choicePort != nil && calendarChoiceProfile==nil && runtime != nil && retiring==nil && !healthSettingsRetiring}
    func canInstallHealthConfiguration(runtime original:NativeHealthRuntime)->Bool{
        canInstallCalendarConfiguration || (healthSettingsReady && !healthSettingsRetiring && runtime === original && original.configuredSettingsReady && configuration==nil && choicePort==nil && retiring==nil && !choiceBusy && !calendarChoiceBusy && !healthEntering && !calendarEntering)
    }
    var configuredHealthSettingsControl:Bool{healthSettingsReady && !healthSettingsRetiring && runtime === healthSettingsOriginal && runtime?.configuredSettingsReady==true}
    func beginConfiguredHealthSettings(revoke:@escaping()->Void,current:@escaping()->Bool,published:@escaping()->Void)->String{
        precondition(Thread.isMainThread)
        if healthSettingsRetiring{return "retiring"}
        if configuredHealthSettingsControl{return "settings"}
        guard canEnterConfiguredHealthSettings,let original=runtime,let currency=choicePort?.currency,!currency.revoked,current(),original.configuredSettingsPreflight(current:current) else{return "unavailable"}
        // Only this explicit original-owner transition changes the revocation
        // disposition. All other revocations keep full Runtime withdrawal.
        healthSettingsOriginal=original;healthSettingsRetiring=true;healthSettingsRevocation=currency;healthSettingsCurrent=current;healthSettingsPublished=published
        lifecycleGeneration &+= 1;choiceCatalog=nil
        var accepted=false
        healthSettingsStart={ [self] in
            accepted=original.beginConfiguredHealthSettings(current:current){[self] in
                guard healthSettingsOriginal === original,runtime === original,retiring==nil,healthSettingsRetiring,original.configuredSettingsReady,current() else{return}
                publishConfiguredHealthRetirement()
            }
        }
        revoke();healthSettingsStart=nil;healthSettingsRevocation=nil
        if !accepted{original.holdConfiguredSettings();return "held"};return configuredHealthSettingsControl ? "settings":"retiring"
    }
    private func publishConfiguredHealthRetirement(){
        publishSavedHealthRetirement()
        guard healthSettingsRetiring,!healthSettingsPublishing,!choiceBusy,!calendarChoiceBusy,!healthEntering,!calendarEntering,
              let original=healthSettingsOriginal,runtime === original,retiring==nil,original.configuredSettingsReady,healthSettingsCurrent?()==true else{return}
        healthSettingsPublishing=true
        DispatchQueue.main.async{[self] in
            guard healthSettingsRetiring,!choiceBusy,!calendarChoiceBusy,!healthEntering,!calendarEntering,runtime === original,retiring==nil,original.configuredSettingsReady,healthSettingsCurrent?()==true else{healthSettingsPublishing=false;return}
            configuration=nil;choicePort=nil;choiceBound=false;choiceCatalog=nil;selection=nil
            healthSettingsPublished?()
            DispatchQueue.main.async{[self] in
                guard healthSettingsRetiring,runtime === original,retiring==nil,original.configuredSettingsReady,healthSettingsCurrent?()==true else{healthSettingsPublishing=false;return}
                healthSettingsRetiring=false;healthSettingsPublishing=false;healthSettingsReady=true;healthSettingsPublished=nil
            }
        }
    }
    private var healthSettingsStart:(()->Void)?
    private var calendarReplacementPending=false,calendarReplacementReady=false
    var calendarReplacementRetired:Bool{calendarReplacementReady && !calendarReplacementPending && runtime==nil && retiring==nil}
    /// A new generation is possible only AFTER the original Runtime publishes
    /// real retirement. Unknown writes, held runs and never callbacks do not
    /// publish it. The final queue barrier follows ALL original observers.
    func retireCalendarConfiguration(completion:@escaping(Bool)->Void){
        precondition(Thread.isMainThread)
        guard calendarChoiceProfile != nil,configuration==nil,choicePort==nil,!calendarReplacementPending,!calendarReplacementReady,
              runtime?.configuration==nil,retiring?.configuration==nil else{completion(false);return}
        calendarReplacementPending=true
        let original=runtime ?? retiring
        if runtime != nil{withdraw()}
        func publish(){
            DispatchQueue.main.async{[self] in
                guard calendarReplacementPending,runtime==nil,retiring==nil,original?.preservesPauseHold != true else{return}
                calendarReplacementPending=false;calendarReplacementReady=true;completion(true)
            }
        }
        if let original{original.retire(authorityChanged:false,completion:publish)}else{publish()}
    }
    /// Only a never-configured, fully inert original Host may receive a profile.
    var canInstallCalendarConfiguration:Bool{runtime==nil && retiring==nil && configuration==nil && rootConfiguration==nil && calendarConfiguration==nil && choicePort==nil && calendarChoiceProfile==nil && !choiceBusy && !calendarChoiceBusy && !calendarEntering && !healthEntering}
    func withdraw(authorityChanged: Bool = false) {
        precondition(Thread.isMainThread)
        lifecycleGeneration &+= 1;choiceCatalog=nil;clearCalendarSavedReadiness();calendarSavedCatalog=nil;calendarLocalCatalog=nil
        guard let current = runtime else {
            if authorityChanged {retiring?.withdrawAuthority()}
            return
        }
        if current.configuration != nil || healthSettingsOriginal === current{lastRetiredHealthRuntime=current}
        runtime=nil;selection=nil;retiring=current
        current.retire(authorityChanged:authorityChanged) { [weak self,weak current] in
            // Keep the old Host owner reserved through ALL original Runtime
            // retirement observers, including synchronous reentry from them.
            DispatchQueue.main.async { [weak self,weak current] in
                guard let self,let current,self.retiring === current,!current.preservesPauseHold else{return};self.retiring=nil
            }
        }
    }
    func setup(selection:String,action:NativeHealthRuntime.LocalSetup,expectedSourceNamespace:UUID?=nil,completion:@escaping(Result<Void,Error>)->Void){
        performSetup(selection:selection,action:action,expectedSourceNamespace:expectedSourceNamespace,authorized:nil,completion:completion)
    }
    private func performSetup(selection: String, action: NativeHealthRuntime.LocalSetup, expectedSourceNamespace:UUID?,authorized:NativeHealthChoiceAction?,completion: @escaping (Result<Void,Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !calendarChoiceBusy,(!choiceBusy || choiceAction === authorized && authorized != nil),!healthEntering,!calendarEntering,runtime?.hasAdmission != true else{completion(.failure(Failure.unavailable));return}
        healthEntering=true;defer{healthEntering=false;DispatchQueue.main.async{[self] in publishSavedHealthRetirement()}}
        let admission=lifecycleGeneration
        guard retiring == nil,!selection.isEmpty,selection.utf8.count<=128,let config=configuration?(selection) else{completion(.failure(Failure.unavailable));return}
        guard lifecycleGeneration==admission,retiring==nil else{completion(.failure(Failure.currentness));return}
        do {
            if let runtime,(runtime.rootConfiguration.identity != config.rootConfiguration.identity || runtime.configuration.map({!$0.matches(config)}) == true) {withdraw();throw Failure.currentness}
            if runtime == nil {
                let created=try NativeHealthRuntime.make(configuration:config,transport:transport)
                runtime=created;self.selection=selection
                // Factories are extensible but construction itself is inert. If
                // they withdrew this Host, retire the inert owner before setup.
                guard lifecycleGeneration==admission,retiring==nil else{withdraw();throw Failure.currentness}
            }
            guard lifecycleGeneration==admission,self.selection==selection,let current=runtime else{throw Failure.unavailable}
            try current.attachHealth(config)
            current.setup(action,expectedSourceNamespace:expectedSourceNamespace){[weak self,weak current] result in
                guard let self,let current,self.runtime === current else{completion(.failure(Failure.currentness));return};completion(result)
            }
        }catch{completion(.failure(error))}
    }
    func sync(selection:String,category:String,completion:@escaping(Result<HealthSyncCoordinator.Completion,Error>)->Void){
        performSync(selection:selection,category:category,authorized:nil,completion:completion)
    }
    private func performSync(selection:String,category:String,authorized:NativeHealthChoiceAction?,completion:@escaping(Result<HealthSyncCoordinator.Completion,Error>)->Void){
        precondition(Thread.isMainThread)
        guard !calendarChoiceBusy,(!choiceBusy || choiceAction === authorized && authorized != nil),self.selection==selection,retiring==nil,let runtime,!runtime.hasAdmission else{completion(.failure(Failure.unavailable));return}
        guard let config=configuration?(selection),config.valid,runtime.configuration?.matches(config)==true else{withdraw();completion(.failure(Failure.currentness));return}
        runtime.sync(category:category,completion:completion)
    }
    func status()->[String:Any]{
        precondition(Thread.isMainThread)
        if choiceBusy || calendarChoiceBusy{return ["state":"unavailable"]}
        if retiring != nil{return ["state":"draining"]}
        if runtime?.hasAdmission==true{return ["state":"unavailable"]}
        return runtime?.status() ?? ["state":"unavailable"]
    }

    func pauseCollection(_ value:[String:Any],completion:@escaping([String:Any])->Void) {
        precondition(Thread.isMainThread)
        guard let request=NativeHealthPauseRequest(value) else{completion(NativeHealthPauseResponse.make(id:NativeHealthPauseRequest.id(value["operationId"]),reason:"invalid_request"));return}
        guard let target=runtime ?? retiring else{completion(NativeHealthPauseResponse.make(id:request.operationId,reason:"no_local_binding"));return}
        target.pauseCollection(request,completion:completion)
    }
    func setupCalendar(selection:String,completion:@escaping(NativeHealthRuntime.CalendarSetupResult)->Void){
        precondition(Thread.isMainThread)
        guard !calendarChoiceBusy else{completion(.unavailable);return}
        setupCalendar(selection:selection,authorized:nil,completion:completion)
    }
    private func setupCalendar(selection:String,authorized:CalendarLocalAction?,completion:@escaping(NativeHealthRuntime.CalendarSetupResult)->Void){
        precondition(Thread.isMainThread)
        guard calendarLocalPermit(authorized),!choiceBusy,!selection.isEmpty,selection.utf8.count<=128 else{completion(.unavailable);return}
        clearCalendarSavedReadiness()
        if let result=(runtime ?? retiring)?.calendarAdmissionObservation(selector:selection){completion(result);return}
        guard !calendarEntering,!healthEntering,retiring==nil,runtime?.hasAdmission != true,!selection.isEmpty,selection.utf8.count<=128 else{completion(.unavailable);return}
        calendarEntering=true;defer{calendarEntering=false;DispatchQueue.main.async{[self] in publishSavedHealthRetirement()}}
        let generation=lifecycleGeneration
        guard let supplied=calendarConfiguration?(selection),let setup=supplied.setup,let rootConfig=rootConfiguration?(supplied.runtimeSelection),rootConfig.valid,
              lifecycleGeneration==generation,retiring==nil else{completion(.unavailable);return}
        do{
            if let runtime{guard runtime.rootConfiguration.identity==rootConfig.identity,self.selection==supplied.runtimeSelection else{throw Failure.currentness}}
            else{
                let created=try NativeHealthRuntime.makeRoot(configuration:rootConfig,transport:transport)
                runtime=created;self.selection=supplied.runtimeSelection
                guard lifecycleGeneration==generation,retiring==nil else{withdraw();throw Failure.currentness}
            }
            guard let observed=runtime,lifecycleGeneration==generation else{throw Failure.currentness}
            authorized?.runtime=observed
            func fresh()->Bool{
                let calendar=calendarConfiguration?(selection)
                let root=rootConfiguration?(supplied.runtimeSelection)
                return self.runtime === observed && retiring==nil && lifecycleGeneration==generation && self.selection==supplied.runtimeSelection && calendar?.runtimeSelection==supplied.runtimeSelection && calendar?.configuration.configuration.matches(supplied.configuration.configuration)==true && calendar?.setup?.owner === setup.owner && calendar?.setup?.currency === setup.currency && calendar?.setup?.selectedCategories==setup.selectedCategories && root?.identity==rootConfig.identity && (authorized.map{calendarLocalActionCurrent($0)} ?? true)
            }
            observed.setupCalendar(supplied:supplied.configuration,setup:setup,selector:selection,fresh:fresh,completion:completion)
        }catch{completion(.unavailable)}
    }
    func reconnectCalendar(selection:String,completion:@escaping(NativeHealthRuntime.CalendarReconnectResult)->Void){
        precondition(Thread.isMainThread)
        guard !calendarChoiceBusy else{completion(.unavailable);return}
        clearCalendarSavedReadiness()
        reconnectCalendar(selection:selection,authorized:nil,completion:completion)
    }
    private func reconnectCalendar(selection:String,authorized:CalendarSavedAction?,completion:@escaping(NativeHealthRuntime.CalendarReconnectResult)->Void){
        precondition(Thread.isMainThread)
        guard calendarSavedPermit(authorized,.reconnect),!choiceBusy,!selection.isEmpty,selection.utf8.count<=128,!calendarEntering,!healthEntering,retiring==nil,runtime?.hasAdmission != true else{completion(.unavailable);return}
        calendarEntering=true;defer{calendarEntering=false;DispatchQueue.main.async{[self] in publishSavedHealthRetirement()}}
        let generation=lifecycleGeneration
        guard let supplied=calendarConfiguration?(selection),let reconnect=supplied.reconnect,let rootConfig=rootConfiguration?(supplied.runtimeSelection),rootConfig.valid,
              lifecycleGeneration==generation,retiring==nil else{completion(.unavailable);return}
        do{
            if let runtime{guard runtime.rootConfiguration.identity==rootConfig.identity,self.selection==supplied.runtimeSelection else{throw Failure.currentness}}
            else{
                let created=try NativeHealthRuntime.makeRoot(configuration:rootConfig,transport:transport)
                runtime=created;self.selection=supplied.runtimeSelection
                guard lifecycleGeneration==generation,retiring==nil else{withdraw();throw Failure.currentness}
            }
            guard let observed=runtime,lifecycleGeneration==generation else{throw Failure.currentness}
            authorized?.runtime=observed
            func fresh()->Bool{
                let calendar=calendarConfiguration?(selection)
                let root=rootConfiguration?(supplied.runtimeSelection)
                return self.runtime === observed && retiring==nil && lifecycleGeneration==generation && self.selection==supplied.runtimeSelection && calendar?.runtimeSelection==supplied.runtimeSelection && calendar?.configuration.configuration.matches(supplied.configuration.configuration)==true && calendar?.reconnect?.owner === reconnect.owner && calendar?.reconnect?.currency === reconnect.currency && Set((calendar?.reconnect?.expectedSavedCategories ?? []).map{Data($0.utf8)})==Set(reconnect.expectedSavedCategories.map{Data($0.utf8)}) && root?.identity==rootConfig.identity && (authorized.map{calendarSavedActionCurrent($0)} ?? true)
            }
            observed.reconnectCalendar(supplied:supplied.configuration,reconnect:reconnect,selector:selection,fresh:fresh,completion:completion)
        }catch{completion(.unavailable)}
    }
    func calendarCollectAndDeliver(selection:String,completion:@escaping(NativeCalendarAcquisitionOwner.DeliveryOutcome)->Void){precondition(Thread.isMainThread);guard !calendarChoiceBusy else{completion(.notApplied(.unavailable));return};clearCalendarSavedReadiness();calendar(selection:selection,collect:true,completion:completion)}
    func calendarDeliverPending(selection:String,completion:@escaping(NativeCalendarAcquisitionOwner.DeliveryOutcome)->Void){precondition(Thread.isMainThread);guard !calendarChoiceBusy else{completion(.notApplied(.unavailable));return};clearCalendarSavedReadiness();calendar(selection:selection,collect:false,completion:completion)}
    func calendarCancel(){(runtime ?? retiring)?.cancelCalendar()}
    private func calendar(selection:String,collect:Bool,authorized:CalendarSavedAction?=nil,manual:CalendarManualAction?=nil,completion:@escaping(NativeCalendarAcquisitionOwner.DeliveryOutcome)->Void){
        precondition(Thread.isMainThread)
        guard (manual.map{collect && calendarManualActionCurrent($0)} ?? calendarSavedPermit(authorized,.deliverPending)),!choiceBusy,!calendarEntering,retiring==nil,runtime?.hasAdmission != true,!selection.isEmpty,selection.utf8.count<=128,let observed=runtime,let capturedSelection=self.selection else{completion(.notApplied(.unavailable));return}
        calendarEntering=true;defer{calendarEntering=false;DispatchQueue.main.async{[self] in publishSavedHealthRetirement()}}
        guard let supplied=calendarConfiguration?(selection),supplied.runtimeSelection==capturedSelection else{completion(.notApplied(.unavailable));return}
        func fresh()->NativeHealthRuntime.CalendarConfiguration? {
            guard self.runtime === observed,retiring==nil,self.selection==capturedSelection,let current=calendarConfiguration?(selection),current.runtimeSelection==capturedSelection else{return nil}
            // The Calendar provider is extensible and may remap the trusted
            // backing root. Snapshot that root configuration AFTER the provider;
            // final matching and owner identity checks below invoke no callbacks.
            let matches:Bool
            if let rootConfiguration {matches=rootConfiguration(capturedSelection)?.identity==observed.rootConfiguration.identity}
            else{matches=configuration?(capturedSelection).map{observed.configuration?.matches($0)==true} ?? false}
            guard matches,self.runtime === observed,retiring==nil,self.selection==capturedSelection else{return nil};guard authorized.map({calendarSavedActionCurrent($0)}) ?? true,manual.map({calendarManualActionCurrent($0)}) ?? true else{return nil};return current.configuration
        }
        observed.calendar(collect:collect,supplied:supplied.configuration,fresh:fresh,completion:completion)
    }

    func resumeCollection(_ value:[String:Any],completion:@escaping([String:Any])->Void) {
        precondition(Thread.isMainThread)
        guard let request=NativeHealthResumeRequest(value) else{completion(NativeHealthResumeResponse.make(id:NativeHealthPauseRequest.id(value["operationId"]),reason:"invalid_request"));return}
        guard !calendarChoiceBusy,!choiceBusy,retiring==nil,let observed=runtime,!observed.hasAdmission,let selector=selection,let initial=configuration?(selector),initial.valid else{completion(NativeHealthResumeResponse.make(id:request.operationId,reason:"no_known_pause"));return}
        guard let expected=observed.configuration else{completion(NativeHealthResumeResponse.make(id:request.operationId,reason:"no_known_pause"));return}
        func current()->Bool {
            guard runtime === observed,retiring==nil,selection==selector,let actual=configuration?(selector),actual.valid,expected.matches(initial),expected.matches(actual) else{return false}
            return true
        }
        observed.resumeCollection(request,hostCurrent:current,start:{ done in
            guard current() else{done(.failure(Failure.currentness));return}
            // Direct existing-runtime setup cannot allocate a replacement after a callback.
            observed.setup(.resumeExistingLocal,completion:done)
        },completion:completion)
    }

    /// Explicit, source-bound observation only; never creates or changes a runtime.
    func selectedStatus(_ value:[String:Any],completion:@escaping([String:Any])->Void) {
        precondition(Thread.isMainThread)
        func fail(_ reason:String,_ state:String="unavailable"){completion(NativeHealthSelectedStatus.response(state,reason))}
        guard !choiceBusy else{fail("context_changed");return}
        guard let hint=NativeHealthStatusRequest(value) else{fail("invalid_request");return}
        guard retiring==nil else{fail("draining");return}
        guard runtime?.hasAdmission != true else{fail("context_changed");return}
        guard configuration != nil else{fail("no_configuration");return}
        guard let observed=runtime,let select=selection else{fail("no_runtime");return}
        guard let supplied=configuration?(select),supplied.valid else{fail("no_configuration");return}
        guard let config=observed.configuration else{fail("no_configuration");return}
        guard config.matches(supplied),observed.statusCurrent else{fail("context_changed");return}
        guard hint.endpoint==config.endpoint,hint.enrollment==config.enrollment else{fail("source_mismatch");return}
        guard let origin=transport.endpoint,let owner=transport.currentEffectiveOwner,transport.effectiveIsSelf else{fail("context_unavailable");return}
        let originBytes=Data(origin.absoluteString.utf8),epoch=transport.epoch
        func capturedCurrent()->Bool {
            guard runtime === observed,retiring==nil,selection==select,transport.epoch==epoch,let nowOrigin=transport.endpoint,Data(nowOrigin.absoluteString.utf8)==originBytes,transport.effectiveIsSelf,let now=transport.currentEffectiveOwner else{return false}
            return now.principal==owner.principal && now.session==owner.session
        }
        func current()->Bool {
            guard let fresh=configuration?(select),fresh.valid,config.matches(fresh),observed.statusCurrent else{return false}
            return capturedCurrent()
        }
        struct Context:Equatable {let revision:Int,generation:Int,endpointRevision:Int}
        func context(_ done:@escaping(Context?)->Void){
            transport.request("/api/runtime/v1/session-context",maxBytes:65536){response in
                guard current(),case .success(let(data,http))=response,http.statusCode==200,let body=try? JSONSerialization.jsonObject(with:data) as? [String:Any],let ended=body["ended"] as? NSNumber,CFGetTypeID(ended)==CFBooleanGetTypeID(),!ended.boolValue,
                      let revision=NativeHealthStatusRequest.number(body["revision"],minimum:0),revision==hint.contextRevision,let generation=NativeHealthStatusRequest.number(body["contextGeneration"],minimum:0),let endpoint=body["endpoint"] as? [String:Any],UUID(uuidString:endpoint["endpointId"] as? String ?? "")==config.endpoint,endpoint["privacyClass"] as? String=="personal",let endpointRevision=NativeHealthStatusRequest.number(endpoint["configurationRevision"],minimum:0) else{done(nil);return}
                done(Context(revision:revision,generation:generation,endpointRevision:endpointRevision))
            }
        }
        context{[self] first in
            guard current(),let first else{fail("context_unavailable","unknown");return}
            inventory.fetch(expectedEndpoint:config.endpoint){result in
                guard current() else{fail("context_changed");return}
                guard case .success(let snapshot)=result else{fail("inventory_unavailable","unknown");return}
                guard let source=snapshot.sources.first(where:{$0.namespace==hint.sourceNamespace}),source.collector.utf8.elementsEqual("healthKit".utf8),source.currentEnrollment==config.enrollment,source.policyRevision==hint.policyRevision else{fail("source_mismatch");return}
                context{last in
                    guard current(),last==first else{fail("context_changed");return}
                    let result=observed.selectedStatus(source:source,contextRevision:first.revision,publicationCurrent:current)
                    // No config/protected-state callback after final pure proof inspection.
                    guard capturedCurrent() else{fail("context_changed");return};completion(result)
                }
            }
        }
    }

    func loadInventory(completion: @escaping (Result<[String: Any], Error>) -> Void) {
        DispatchQueue.main.async { [self] in
            guard transport.effectiveIsSelf, let owner = transport.currentEffectiveOwner else { completion(.failure(Failure.currentness)); return }
            let epoch = transport.epoch
            func current() -> Bool {
                guard transport.epoch == epoch, transport.effectiveIsSelf, let now = transport.currentEffectiveOwner else { return false }
                return now.principal == owner.principal && now.session == owner.session
            }
            transport.request("/api/runtime/v1/session-context", maxBytes: 65536) { response in
                guard current(), case .success(let (data, http)) = response, http.statusCode == 200,
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let endpoint = object["endpoint"] as? [String: Any], let raw = endpoint["endpointId"] as? String,
                      let endpointId = UUID(uuidString: raw) else { completion(.failure(Failure.unavailable)); return }
                inventory.fetch(expectedEndpoint: endpointId) { result in
                    guard current() else { completion(.failure(Failure.currentness)); return }
                    switch result {
                    case .failure(let error): completion(.failure(error))
                    case .success(let snapshot):
                        let sources: [[String: Any]] = snapshot.sources.map { source in
                            var item: [String: Any] = ["sourceNamespace": source.namespace.uuidString.lowercased(), "collector": source.collector,
                                "policyRevision": source.policyRevision, "enrollmentCount": source.enrollmentCount,
                                "categories": source.categories.sorted(), "uses": source.uses.sorted(),
                                "assistantIds": source.assistants.sorted(),
                                "collectionPaused": source.collectionPaused, "usePaused": source.usePaused, "coverage": "unknown"]
                            if let enrollment = source.currentEnrollment { item["currentEnrollmentId"] = enrollment.uuidString.lowercased() }
                            if let state = source.currentState { item["currentState"] = state }
                            if let preferred = source.preferredSource { item["preferredSource"] = preferred }
                            return item
                        }
                        completion(.success(["sources": sources, "unboundEnrollments": snapshot.unboundEnrollments.map { ["enrollmentId": $0.id.uuidString.lowercased(), "collector": $0.collector, "revision": $0.revision] as [String: Any] }]))
                    }
                }
            }
        }
    }
}

extension NativeHealthHost {
    struct ChoiceContext {
        let generation:UInt64,epoch:Int,principal:String,session:String,origin:String,endpoint:UUID
    }
    final class ChoiceRecord {
        let id=UUID(),descriptor:NativeHealthSetupDescriptor
        let plans:[UUID:NativeHealthCollectionPlan]
        init(_ descriptor:NativeHealthSetupDescriptor){self.descriptor=descriptor;plans=Dictionary(uniqueKeysWithValues:descriptor.configuration.plans.map{(UUID(),$0)})}
    }
    final class ChoiceCatalog {
        let id=UUID(),context:ChoiceContext,currency:NativeHealthChoiceCurrency,records:[ChoiceRecord]
        init(context:ChoiceContext,currency:NativeHealthChoiceCurrency,records:[ChoiceRecord]){self.context=context;self.currency=currency;self.records=records}
    }
    fileprivate func invalidateChoiceCurrency(_ currency:NativeHealthChoiceCurrency){
        guard choiceBound,choicePort?.currency === currency else{return}
        if healthSettingsRetiring,healthSettingsRevocation === currency,let start=healthSettingsStart{start();return}
        // Concrete existing invalidation synchronously revokes the original Root.
        // Core/SDK cleanup remains in Runtime's original afterFrame path.
        withdraw()
    }
    private func choiceContextCurrent(_ context:ChoiceContext)->Bool {
        guard lifecycleGeneration==context.generation,transport.epoch==context.epoch,transport.effectiveIsSelf,
              transport.endpoint?.absoluteString==context.origin,let owner=transport.currentEffectiveOwner else{return false}
        return owner.principal==context.principal && owner.session==context.session
    }
    private func catalogCurrent(_ catalog:ChoiceCatalog)->Bool {
        choiceCatalog === catalog && choiceBound && choicePort?.currency === catalog.currency && !catalog.currency.revoked &&
        retiring==nil && choiceContextCurrent(catalog.context)
    }
    fileprivate func choiceActionCurrent(_ run:NativeHealthChoiceAction)->Bool {
        guard choiceAction === run,catalogCurrent(run.catalog) else{return false}
        if let expected=run.runtime{return runtime === expected && expected.choiceSourceCurrent}
        return true
    }
    private static func nativeTypes(_ categories:Set<String>)->Set<String>{Set(categories.compactMap{$0=="SleepSegment" ? "sleep":HealthKitCollector.supportedCategories.contains($0) ? $0:nil})}
    private static func sourceMatches(_ source:MobileHealthInventoryPage.Source,_ descriptor:NativeHealthSetupDescriptor)->Bool {
        source.collector=="healthKit" && source.namespace==descriptor.namespace && source.currentEnrollment==descriptor.configuration.enrollment &&
        source.currentState=="active" && !source.collectionPaused && Set(descriptor.configuration.plans.map(\.category)).isSubset(of:nativeTypes(source.categories))
    }
    private static let planNames=["sleep":"Sleep","heartRate":"Heart rate","restingHeartRate":"Resting heart rate","respiratoryRate":"Respiratory rate","hrvSDNN":"HRV (SDNN)"]
    private static func bounded(_ value:[String:Any],bytes:Int)->Bool{guard let data=try? JSONSerialization.data(withJSONObject:value) else{return false};return data.count<=bytes}
    private static func catalogReply(_ state:String,_ reason:String,catalog:ChoiceCatalog?=nil)->[String:Any]{
        let choices:[[String:Any]]=catalog?.records.map{record in ["choice":record.id.uuidString.lowercased(),"label":record.descriptor.title,"destinationLabel":record.descriptor.destinationLabel,"setupScope":"existingRemoteOnThisPhone","localSetup":record.descriptor.configuredLocalConfirmed ? "configuredLocalConfirmed":record.descriptor.localSetup == .confirmExistingLocal ? "confirmSavedLocal":"prepareNewLocal","useInspection":"notChecked","dataChoices":record.plans.sorted{$0.key.uuidString<$1.key.uuidString}.map{["categoryChoice":$0.key.uuidString.lowercased(),"label":planNames[$0.value.category]!]}]} ?? []
        return ["schemaVersion":"1.0.0","state":state,"reason":reason,"catalogId":catalog?.id.uuidString.lowercased() as Any? ?? NSNull(),"choices":choices]
    }
    func loadSetupChoices(completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        guard !calendarChoiceBusy else{completion(Self.catalogReply("unavailable","busy"));return}
        guard !choiceBusy,!healthEntering,!calendarEntering,retiring==nil,runtime?.choiceAdmissionAvailable != false else{completion(Self.catalogReply("unavailable","busy"));return}
        let load=UUID();choiceLoad=load;choiceCatalog=nil
        func finish(_ value:[String:Any]){DispatchQueue.main.async{[self] in guard choiceLoad==load else{return};choiceLoad=nil;DispatchQueue.main.async{[self] in publishSavedHealthRetirement()}
            if value["state"] as? String=="available",choiceCatalog.map({catalogCurrent($0)}) != true{completion(Self.catalogReply("unavailable","context_changed"))}else{completion(value)}}}
        guard let port=choicePort,let currency=port.currency,choiceBound,!currency.revoked,currency.owner === port.owner,currency.matches(port.descriptors),configuration != nil else{finish(Self.catalogReply("unavailable","no_configuration"));return}
        let values=port.descriptors
        guard (1...8).contains(values.count),values.allSatisfy(\.valid),Set(values.map{Data($0.selector.utf8)}).count==values.count,
              Set(values.map{$0.namespace}).count==values.count,Set(values.map{$0.configuration.enrollment}).count==values.count,
              transport.effectiveIsSelf,let owner=transport.currentEffectiveOwner,let origin=transport.endpoint?.absoluteString,let first=values.first else{finish(Self.catalogReply("unavailable","invalid_choice"));return}
        let context=ChoiceContext(generation:lifecycleGeneration,epoch:transport.epoch,principal:owner.principal,session:owner.session,origin:origin,endpoint:first.configuration.endpoint)
        for item in values {
            guard let resolved=configuration?(item.selector),resolved.matches(item.configuration),resolved.protectedAvailable(),
                  UUID(uuidString:context.principal)==resolved.human,UUID(uuidString:context.session)==resolved.session,resolved.origin==origin,resolved.endpoint==context.endpoint,
                  !currency.revoked,choiceContextCurrent(context),choiceLoad==load else{finish(Self.catalogReply("unavailable","context_changed"));return}
        }
        inventory.fetch(expectedEndpoint:context.endpoint){[self] result in
            guard choiceLoad==load,!currency.revoked,choiceContextCurrent(context),retiring==nil else{finish(Self.catalogReply("unavailable","context_changed"));return}
            guard case .success(let snapshot)=result else{finish(Self.catalogReply("unknown","inventory_unavailable"));return}
            for descriptor in values {
                let matches=snapshot.sources.filter{Self.sourceMatches($0,descriptor)}
                guard matches.count==1 else{finish(Self.catalogReply("unavailable","invalid_choice"));return}
            }
            let catalog=ChoiceCatalog(context:context,currency:currency,records:values.map{ChoiceRecord($0)})
            let reply=Self.catalogReply("available","ready",catalog:catalog)
            guard Self.bounded(reply,bytes:32768),!currency.revoked,choiceContextCurrent(context) else{finish(Self.catalogReply("unavailable","invalid_choice"));return}
            choiceCatalog=catalog;finish(reply)
        }
    }
    static func choiceReply(kind:NativeHealthChoiceAction.Kind,catalog:UUID?=nil,choice:UUID?=nil,attempt:UUID?=nil,reason:String,value:Any)->[String:Any]{
        var result:[String:Any]=["schemaVersion":"1.0.0","operation":kind.rawValue,"catalogId":catalog?.uuidString.lowercased() as Any? ?? NSNull(),"choice":choice?.uuidString.lowercased() as Any? ?? NSNull(),"attemptId":attempt?.uuidString.lowercased() as Any? ?? NSNull(),"reason":reason,"readKnowledge":"unknown"]
        result[kind == .setup ? "setupOutcome":kind == .permission ? "requestState":"syncOutcome"]=value
        return result
    }
    func performChoice(_ kind:NativeHealthChoiceAction.Kind,input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        guard !calendarChoiceBusy else{completion(Self.choiceReply(kind:kind,reason:"busy",value:kind == .sync ? NSNull():"notInvoked"));return}
        func denied(_ reason:String){completion(Self.choiceReply(kind:kind,reason:reason,value:kind == .sync ? NSNull():"notInvoked"))}
        let keys:Set<String>=kind == .sync ? ["catalogId","choice","categoryChoice"]:["catalogId","choice"]
        guard Set(input.keys)==keys,let catalogID=NativeHealthPauseRequest.id(input["catalogId"]),let choiceID=NativeHealthPauseRequest.id(input["choice"]) else{denied("not_started");return}
        guard !choiceBusy,!healthEntering,!calendarEntering,retiring==nil,runtime?.choiceAdmissionAvailable != false else{denied("busy");return}
        guard let catalog=choiceCatalog,catalog.id==catalogID,catalogCurrent(catalog),let record=catalog.records.first(where:{$0.id==choiceID}) else{denied("source_unavailable");return}
        var plan:NativeHealthCollectionPlan?
        if kind == .sync {guard let id=NativeHealthPauseRequest.id(input["categoryChoice"]),let found=record.plans[id] else{denied("source_unavailable");return};plan=found}
        let run=NativeHealthChoiceAction(host:self,kind:kind,record:record,catalog:catalog);choiceAction=run
        if kind != .setup{run.runtime=runtime}
        func finish(_ value:Any,_ reason:String){DispatchQueue.main.async{[self] in
            guard choiceAction === run else{return}
            if kind == .permission{run.runtime?.releaseReadPermissionReservation(action:run)}
            let current=run.isCurrent()
            let actual:Any
            if current{actual=value}
            else if kind == .setup && run.invoked{actual="notConfirmed"}
            else if kind == .permission && run.invoked{actual="deferred"}
            else if kind == .sync{actual=NSNull()}
            else{actual="notInvoked"}
            let reply=Self.choiceReply(kind:kind,catalog:current ? catalog.id:nil,choice:current ? record.id:nil,attempt:run.id,reason:current ? reason:"context_changed",value:actual)
            choiceAction=nil;completion(reply);DispatchQueue.main.async{[self] in publishConfiguredHealthRetirement()}
        }}
        if kind == .permission{
            guard let target=run.runtime,target.reserveReadPermission(action:run) else{finish("notInvoked","local_setup_required");return}
        }
        guard let resolved=configuration?(record.descriptor.selector),resolved.matches(record.descriptor.configuration),resolved.protectedAvailable(),run.isCurrent() else{finish(kind == .sync ? NSNull():"notInvoked","context_changed");return}
        inventory.fetch(expectedEndpoint:resolved.endpoint){[self] result in
            guard run.isCurrent(),case .success(let snapshot)=result else{finish(kind == .sync ? NSNull():"notInvoked","context_changed");return}
            guard snapshot.sources.filter({Self.sourceMatches($0,record.descriptor)}).count==1 else{finish(kind == .sync ? NSNull():"notInvoked","source_unavailable");return}
            switch kind {
            case .setup:
                run.invoked=true
                performSetup(selection:record.descriptor.selector,action:record.descriptor.localSetup,expectedSourceNamespace:record.descriptor.namespace,authorized:run){[self] result in
                    run.runtime=runtime
                    switch result{case .success:finish("prepared","ready");case .failure:finish("notConfirmed","operation_unconfirmed")}
                }
            case .permission:
                guard let target=run.runtime,runtime === target else{finish("notInvoked","local_setup_required");return}
                target.requestReadPermission(action:run){value in
                    switch value {
                    case .requestCompletedReadNotObservable:run.invoked=true;finish("completedReadNotObservable","ready")
                    case .notInvoked:finish("notInvoked","policy_unavailable")
                    case .unsupported:finish("unsupported","unsupported")
                    case .deferred:run.invoked=true;finish("deferred","request_failed")
                    }
                }
            case .sync:
                guard let plan,run.runtime != nil else{finish(NSNull(),"local_setup_required");return}
                run.invoked=true
                performSync(selection:record.descriptor.selector,category:plan.category,authorized:run){result in
                    switch result {
                    case .failure:finish(NSNull(),"operation_unconfirmed")
                    case .success(let value):
                        let text:String
                        switch value{case .idle:text="idle";case .applied:text="applied";case .retry:text="retry";case .needsAttention:text="needsAttention";case .invalidReceipt:text="invalidReceipt";case .deferred:text="deferred"}
                        finish(text,value == .deferred ? "sync_deferred":"ready")
                    }
                }
            }
        }
    }
}


/// Immutable ORIGINAL native inputs for an already-saved Calendar connection.
/// Listing these hints proves neither a saved row nor current authority.
/// ORIGINAL native composition only, not an SDK/provider issuer or authority.
/// Owner revokes the SAME profile before any factory/backing mutation, even ABA.
final class NativeCalendarCollectionPort {
    let owner:AnyObject,makeAcquisition:(HealthOutbox)->MobileEventKitAcquisition?
    init(owner:AnyObject,makeAcquisition:@escaping(HealthOutbox)->MobileEventKitAcquisition?){self.owner=owner;self.makeAcquisition=makeAcquisition}
    func valid(_ descriptor:NativeCalendarSavedDescriptor)->Bool{
        descriptor.selection.reconnect?.owner === owner && descriptor.selection.reconnect?.expectedSavedCategories==Set([descriptor.selection.configuration.configuration.plan.category])
    }
}
struct NativeCalendarSavedDescriptor {
    let selector:String,label:String,destinationLabel:String
    let selection:NativeHealthHost.CalendarSelection
    let readPermission:NativeCalendarReadPermissionPort?
    let collection:NativeCalendarCollectionPort?
    init(selector:String,label:String,destinationLabel:String,selection:NativeHealthHost.CalendarSelection,readPermission:NativeCalendarReadPermissionPort?=nil,collection:NativeCalendarCollectionPort?=nil){self.selector=selector;self.label=label;self.destinationLabel=destinationLabel;self.selection=selection;self.readPermission=readPermission;self.collection=collection}
    func valid(root:NativeHealthRuntime.RootConfiguration)->Bool {
        func labelValid(_ s:String)->Bool{!s.isEmpty && s.unicodeScalars.count<=120 && s.utf8.count<=512 && !s.unicodeScalars.contains{$0.value<32}}
        let source=selection.configuration.configuration
        guard !selector.isEmpty,selector.utf8.count<=128,!selection.runtimeSelection.isEmpty,selection.runtimeSelection.utf8.count<=128,
              labelValid(label),labelValid(destinationLabel),source.valid,selection.setup==nil,selection.configuration.makeAcquisition==nil,selection.configuration.custody != nil,
              source.human==root.human,source.session==root.session,source.endpoint==root.endpoint,Data(source.origin.utf8)==Data(root.origin.utf8),
              let reconnect=selection.reconnect,!reconnect.expectedSavedCategories.isEmpty,reconnect.expectedSavedCategories.isSubset(of:["CalendarEvent","Task"]),reconnect.expectedSavedCategories.contains(source.plan.category),
              let currency=reconnect.currency,!currency.revoked,currency.owner === reconnect.owner else{return false}
        return currency.binding.matches(.init(root:root.identity,configuration:source,selected:reconnect.expectedSavedCategories,kind:.reconnectExistingLocal))
    }
}
final class NativeCalendarSavedProfile {
    let root:NativeHealthRuntime.RootConfiguration,descriptors:[NativeCalendarSavedDescriptor]
    let setupDescriptors:[NativeCalendarLocalSetupDescriptor]
    private var bound=false,revoked=false
    private var boundPermissionCurrencies:[NativeCalendarReadPermissionCurrency]=[]
    private weak var host:NativeHealthHost?
    init?(root:NativeHealthRuntime.RootConfiguration,descriptors:[NativeCalendarSavedDescriptor],setupDescriptors:[NativeCalendarLocalSetupDescriptor]=[]){
        guard root.valid,!descriptors.isEmpty,descriptors.count<=8,Set(descriptors.map{Data($0.selector.utf8)}).count==descriptors.count,
              descriptors.allSatisfy({$0.valid(root:root) && $0.selection.reconnect?.currency?.attempt==nil}) else{return nil}
        guard setupDescriptors.count<=8,Set((descriptors.map{$0.selector}+setupDescriptors.map{$0.selector}).map{Data($0.utf8)}).count==descriptors.count+setupDescriptors.count,
              setupDescriptors.allSatisfy({$0.valid(root:root,saved:descriptors) && $0.selection.setup?.currency?.attempt==nil}) else{return nil}
        self.root=root;self.descriptors=descriptors;self.setupDescriptors=setupDescriptors
    }
    /// ORIGINAL composition calls BEFORE changing backing inputs, including ABA.
    func revoke(){precondition(Thread.isMainThread);guard !revoked else{return};revoked=true;boundPermissionCurrencies.forEach{$0.revoke()};host?.withdraw(authorityChanged:true)}
    fileprivate func current(_ original:NativeHealthHost)->Bool{bound && !revoked && host === original && descriptors.allSatisfy{$0.valid(root:root)}}
    func bind(transport:NativeTransport)->NativeHealthHost?{
        precondition(Thread.isMainThread);guard !bound,!revoked else{return nil};bound=true
        // No resolver, custody, storage or SDK callback during construction.
        let original=NativeHealthHost(transport:transport,calendarConfiguration:{[self] selector in
            guard !revoked else{return nil}
            if let manual=host?.manualCollectionSelection(selector:selector,profile:self){return manual}
            return descriptors.first{Data($0.selector.utf8)==Data(selector.utf8)}?.selection ?? setupDescriptors.first{Data($0.selector.utf8)==Data(selector.utf8)}?.selection
        },rootConfiguration:{[self] selector in
            guard !revoked,descriptors.contains(where:{Data($0.selection.runtimeSelection.utf8)==Data(selector.utf8)}) else{return nil};return root
        },calendarChoiceProfile:self)
        host=original
        for d in descriptors{if let port=d.readPermission,port.valid(root:root,descriptor:d),let c=port.currency,c.bind(original){boundPermissionCurrencies.append(c)}}
        return original
    }
}

extension NativeHealthHost {
    enum CalendarSavedOperation:String{case reconnect,deliverPending}
    private struct CalendarSavedContext{let generation:UInt64,epoch:Int,principal:String,session:String,origin:String}
    private final class CalendarSavedRecord{
        let id=UUID(),descriptor:NativeCalendarSavedDescriptor
        weak var admitted:NativeHealthRuntime?
        var collectionReview:CalendarCollectionReview?
        init(_ descriptor:NativeCalendarSavedDescriptor){self.descriptor=descriptor}
    }
    private final class CalendarSavedCatalog{
        let id=UUID(),profile:NativeCalendarSavedProfile,context:CalendarSavedContext,records:[CalendarSavedRecord]
        init(_ profile:NativeCalendarSavedProfile,_ context:CalendarSavedContext){self.profile=profile;self.context=context;records=profile.descriptors.map(CalendarSavedRecord.init)}
    }
    private final class CalendarSavedAction{
        let operation:CalendarSavedOperation,catalog:CalendarSavedCatalog,record:CalendarSavedRecord
        var runtime:NativeHealthRuntime?
        init(_ operation:CalendarSavedOperation,_ catalog:CalendarSavedCatalog,_ record:CalendarSavedRecord){self.operation=operation;self.catalog=catalog;self.record=record}
    }
    private func clearCalendarSavedReadiness(){calendarSavedCatalog?.records.forEach{$0.admitted=nil;$0.collectionReview=nil}}
    private func calendarSavedCurrent(_ catalog:CalendarSavedCatalog)->Bool{
        let c=catalog.context,p=catalog.profile
        guard calendarSavedCatalog === catalog,calendarChoiceProfile === p,p.current(self),retiring==nil,lifecycleGeneration==c.generation,transport.epoch==c.epoch,
              transport.effectiveIsSelf,transport.endpoint?.absoluteString==c.origin,c.origin==p.root.origin,let owner=transport.currentEffectiveOwner else{return false}
        return owner.principal==c.principal && owner.session==c.session && UUID(uuidString:owner.principal)==p.root.human && UUID(uuidString:owner.session)==p.root.session
    }
    private func calendarSavedActionCurrent(_ action:CalendarSavedAction)->Bool{
        guard calendarSavedAction === action,calendarSavedCurrent(action.catalog) else{return false}
        return action.runtime.map{runtime === $0 && $0.choiceSourceCurrent} ?? true
    }
    private func calendarSavedPermit(_ action:CalendarSavedAction?,_ operation:CalendarSavedOperation)->Bool{
        if let action{return action.operation==operation && calendarSavedActionCurrent(action)}
        return !calendarChoiceBusy
    }
    static func calendarSavedUnavailable(_ reason:String="no_configuration")->[String:Any]{["schemaVersion":"1.0.0","state":"unavailable","reason":reason,"catalogId":NSNull(),"choices":[]]}
    private static func calendarSavedEnvelope(_ operation:CalendarSavedOperation,_ reason:String,_ catalog:CalendarSavedCatalog?=nil,_ record:CalendarSavedRecord?=nil,result:[String:Any])->[String:Any]{
        ["schemaVersion":"1.0.0","operation":operation.rawValue,"catalogId":reason=="ready" ? catalog!.id.uuidString.lowercased() as Any:NSNull(),"choice":reason=="ready" ? record!.id.uuidString.lowercased() as Any:NSNull(),"reason":reason,"result":result]
    }
    private static func calendarSavedDelivery(_ value:NativeCalendarAcquisitionOwner.DeliveryOutcome)->[String:Any]{
        switch value{
        case .settled(let accepted,let rejected,let retryable,let more,let acquired):return ["state":"settledPrefix","acceptedOrDuplicate":accepted,"rejected":rejected,"retryable":retryable,"mayHaveMore":more,"acquired":acquired as Any? ?? NSNull()]
        case .emptyPending:return ["state":"emptyPending"]
        case .requestTooLarge:return ["state":"retained","reason":"request_too_large"]
        case .transportFailure:return ["state":"retained","reason":"transport"]
        case .invalidReceipt:return ["state":"retained","reason":"receipt"]
        case .settlementUnconfirmed,.acquisitionUnconfirmed:return ["state":"unconfirmed"]
        case .notApplied,.acquisitionNotApplied:return ["state":"unavailable"]
        }
    }
    func calendarSavedChoices()->[String:Any]{
        precondition(Thread.isMainThread)
        guard !choiceBusy,!calendarChoiceBusy,!healthEntering,!calendarEntering,runtime?.hasAdmission != true else{return Self.calendarSavedUnavailable("busy")}
        calendarListing=true;defer{calendarListing=false;DispatchQueue.main.async{[self] in publishSavedHealthRetirement()}}
        clearCalendarSavedReadiness();calendarSavedCatalog=nil;calendarLocalCatalog=nil
        guard let profile=calendarChoiceProfile,profile.current(self) else{return Self.calendarSavedUnavailable()}
        guard retiring==nil,transport.effectiveIsSelf,let origin=transport.endpoint?.absoluteString,let owner=transport.currentEffectiveOwner,
              origin==profile.root.origin,UUID(uuidString:owner.principal)==profile.root.human,UUID(uuidString:owner.session)==profile.root.session else{return Self.calendarSavedUnavailable("context_unavailable")}
        let catalog=CalendarSavedCatalog(profile,.init(generation:lifecycleGeneration,epoch:transport.epoch,principal:owner.principal,session:owner.session,origin:origin));calendarSavedCatalog=catalog
        let rows:[[String:Any]]=catalog.records.map{["choice":$0.id.uuidString.lowercased(),"label":$0.descriptor.label,"destinationLabel":$0.descriptor.destinationLabel,"dataLabel":$0.descriptor.selection.configuration.configuration.plan.category=="CalendarEvent" ? "Calendar events":"Reminders","scope":"existingSavedOnly","pendingDeliveryReady":false]}
        let reply:[String:Any]=["schemaVersion":"1.0.0","state":"available","reason":"ready","catalogId":catalog.id.uuidString.lowercased(),"choices":rows]
        guard let bytes=try? JSONSerialization.data(withJSONObject:reply),bytes.count<=16384 else{calendarSavedCatalog=nil;return Self.calendarSavedUnavailable()};return reply
    }
    func performCalendarSavedChoice(_ operation:CalendarSavedOperation,input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        let unavailable=operation == .reconnect ? NativeHealthRuntime.CalendarReconnectResult.unavailable.response:["state":"unavailable"]
        func deny(_ reason:String){completion(Self.calendarSavedEnvelope(operation,reason,result:unavailable))}
        guard !choiceBusy,!calendarChoiceBusy,!calendarEntering,!healthEntering else{deny("busy");return}
        guard Set(input.keys)==Set(["schemaVersion","catalogId","choice"]),input["schemaVersion"] as? String=="1.0.0",
              let id=NativeHealthPauseRequest.id(input["catalogId"]),let choice=NativeHealthPauseRequest.id(input["choice"]),
              let catalog=calendarSavedCatalog,catalog.id==id,let record=catalog.records.first(where:{$0.id==choice}) else{deny("invalid_choice");return}
        guard calendarSavedCurrent(catalog) else{clearCalendarSavedReadiness();deny("context_changed");return}
        if operation == .deliverPending{
            guard let ready=record.admitted,runtime === ready,ready.choiceSourceCurrent,!ready.hasAdmission else{record.admitted=nil;deny("unavailable");return}
        }
        let action=CalendarSavedAction(operation,catalog,record);calendarSavedAction=action
        if operation == .reconnect{
            clearCalendarSavedReadiness()
            reconnectCalendar(selection:record.descriptor.selector,authorized:action){[self] result in
                let current=calendarSavedActionCurrent(action),ready=current && result.outcome == .reconnected && result.availability == .available && result.attempt != nil && action.runtime?.hasAdmission==false
                if ready{record.admitted=action.runtime}else{record.admitted=nil}
                let reply=Self.calendarSavedEnvelope(operation,ready ? "ready":current ? "unavailable":"context_changed",ready ? catalog:nil,ready ? record:nil,result:ready ? result.response:NativeHealthRuntime.CalendarReconnectResult.unavailable.response)
                if calendarSavedAction === action{calendarSavedAction=nil;DispatchQueue.main.async{[self] in publishSavedHealthRetirement()}};completion(reply)
            }
        }else{
            action.runtime=runtime
            calendar(selection:record.descriptor.selector,collect:false,authorized:action){[self] value in
                var result=Self.calendarSavedDelivery(value);let current=calendarSavedActionCurrent(action)
                let state=result["state"] as? String,ready=current && ["settledPrefix","emptyPending","retained"].contains(state ?? "")
                if !ready{record.admitted=nil;if state != "unconfirmed"{result=["state":"unavailable"]}}
                let reply=Self.calendarSavedEnvelope(operation,ready ? "ready":current ? "unavailable":"context_changed",ready ? catalog:nil,ready ? record:nil,result:result)
                if calendarSavedAction === action{calendarSavedAction=nil;DispatchQueue.main.async{[self] in publishSavedHealthRetirement()}};completion(reply)
            }
        }
    }
}


/// First LOCAL admission only. Remote approval still comes from original policy.
struct NativeCalendarLocalSetupDescriptor {
    let selector:String,label:String,destinationLabel:String
    let selection:NativeHealthHost.CalendarSelection
    func valid(root:NativeHealthRuntime.RootConfiguration,saved:[NativeCalendarSavedDescriptor])->Bool{
        func labelValid(_ s:String)->Bool{!s.isEmpty && s.unicodeScalars.count<=120 && s.utf8.count<=512 && !s.unicodeScalars.contains{$0.value<32}}
        let c=selection.configuration.configuration
        guard !selector.isEmpty,selector.utf8.count<=128,labelValid(label),labelValid(destinationLabel),c.valid,selection.reconnect==nil,
              selection.configuration.makeAcquisition==nil,selection.configuration.custody != nil,let setup=selection.setup,
              setup.selectedCategories==Set([c.plan.category]),
              let currency=setup.currency,!currency.revoked,currency.owner === setup.owner,
              currency.binding.matches(.init(root:root.identity,configuration:c,selected:setup.selectedCategories,kind:.setupExistingRemote)) else{return false}
        return saved.contains{d in
            d.valid(root:root) && Data(d.selection.runtimeSelection.utf8)==Data(selection.runtimeSelection.utf8) && d.selection.configuration.configuration.matches(c) &&
            d.selection.reconnect?.owner === setup.owner && d.selection.reconnect?.currency !== currency &&
            Set((d.selection.reconnect?.expectedSavedCategories ?? []).map{Data($0.utf8)})==Set(setup.selectedCategories.map{Data($0.utf8)})
        }
    }
}
extension NativeHealthHost {
    private final class CalendarLocalRecord{
        let id=UUID(),descriptor:NativeCalendarLocalSetupDescriptor
        init(_ d:NativeCalendarLocalSetupDescriptor){descriptor=d}
    }
    private final class CalendarLocalCatalog{
        let id=UUID(),profile:NativeCalendarSavedProfile,context:CalendarSavedContext,records:[CalendarLocalRecord]
        init(_ p:NativeCalendarSavedProfile,_ c:CalendarSavedContext){profile=p;context=c;records=p.setupDescriptors.map(CalendarLocalRecord.init)}
    }
    private final class CalendarLocalAction{
        let catalog:CalendarLocalCatalog,record:CalendarLocalRecord
        var runtime:NativeHealthRuntime?
        init(_ c:CalendarLocalCatalog,_ r:CalendarLocalRecord){catalog=c;record=r}
    }
    private func calendarLocalCurrent(_ catalog:CalendarLocalCatalog)->Bool{
        let c=catalog.context,p=catalog.profile
        guard calendarLocalCatalog === catalog,calendarChoiceProfile === p,p.current(self),retiring==nil,lifecycleGeneration==c.generation,transport.epoch==c.epoch,
              transport.effectiveIsSelf,transport.endpoint?.absoluteString==c.origin,c.origin==p.root.origin,let owner=transport.currentEffectiveOwner else{return false}
        return owner.principal==c.principal && owner.session==c.session && UUID(uuidString:owner.principal)==p.root.human && UUID(uuidString:owner.session)==p.root.session
    }
    private func calendarLocalActionCurrent(_ a:CalendarLocalAction)->Bool{
        guard calendarLocalAction === a,calendarLocalCurrent(a.catalog),a.record.descriptor.valid(root:a.catalog.profile.root,saved:a.catalog.profile.descriptors) else{return false}
        return a.runtime.map{runtime === $0 && $0.choiceSourceCurrent} ?? true
    }
    private func calendarLocalPermit(_ a:CalendarLocalAction?)->Bool{a.map{calendarLocalActionCurrent($0)} ?? !calendarChoiceBusy}
    static func calendarLocalUnavailable(_ reason:String="no_configuration")->[String:Any]{["schemaVersion":"1.0.0","state":"unavailable","reason":reason,"catalogId":NSNull(),"choices":[]]}
    private static func calendarLocalEnvelope(_ reason:String,_ c:CalendarLocalCatalog?=nil,_ r:CalendarLocalRecord?=nil,result:NativeHealthRuntime.CalendarSetupResult)->[String:Any]{
        ["schemaVersion":"1.0.0","operation":"setupLocal","catalogId":reason=="ready" ? c!.id.uuidString.lowercased() as Any:NSNull(),"choice":reason=="ready" ? r!.id.uuidString.lowercased() as Any:NSNull(),"reason":reason,"result":result.response]
    }
    func calendarLocalSetupChoices()->[String:Any]{
        precondition(Thread.isMainThread)
        guard !choiceBusy,!calendarChoiceBusy,!healthEntering,!calendarEntering,runtime?.hasAdmission != true else{return Self.calendarLocalUnavailable("busy")}
        calendarLocalListing=true;defer{calendarLocalListing=false;DispatchQueue.main.async{[self] in publishSavedHealthRetirement()}}
        clearCalendarSavedReadiness();calendarSavedCatalog=nil;calendarLocalCatalog=nil
        guard let p=calendarChoiceProfile,p.current(self),!p.setupDescriptors.isEmpty,p.setupDescriptors.allSatisfy({$0.valid(root:p.root,saved:p.descriptors)}) else{return Self.calendarLocalUnavailable()}
        guard retiring==nil,transport.effectiveIsSelf,let origin=transport.endpoint?.absoluteString,let owner=transport.currentEffectiveOwner,origin==p.root.origin,
              UUID(uuidString:owner.principal)==p.root.human,UUID(uuidString:owner.session)==p.root.session else{return Self.calendarLocalUnavailable("context_unavailable")}
        let c=CalendarLocalCatalog(p,.init(generation:lifecycleGeneration,epoch:transport.epoch,principal:owner.principal,session:owner.session,origin:origin));calendarLocalCatalog=c
        let rows:[[String:Any]]=c.records.map{["choice":$0.id.uuidString.lowercased(),"label":$0.descriptor.label,"destinationLabel":$0.descriptor.destinationLabel,"dataLabel":$0.descriptor.selection.configuration.configuration.plan.category=="CalendarEvent" ? "Calendar events":"Reminders","scope":"existingRemoteLocalSetupOnly"]}
        let reply:[String:Any]=["schemaVersion":"1.0.0","state":"available","reason":"ready","catalogId":c.id.uuidString.lowercased(),"choices":rows]
        guard let b=try? JSONSerialization.data(withJSONObject:reply),b.count<=16384 else{calendarLocalCatalog=nil;return Self.calendarLocalUnavailable()};return reply
    }
    func performCalendarLocalSetupChoice(input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        func deny(_ reason:String){completion(Self.calendarLocalEnvelope(reason,result:.unavailable))}
        guard !choiceBusy,!calendarChoiceBusy,!healthEntering,!calendarEntering else{deny("busy");return}
        guard Set(input.keys)==Set(["schemaVersion","catalogId","choice"]),input["schemaVersion"] as? String=="1.0.0",
              let id=NativeHealthPauseRequest.id(input["catalogId"]),let choice=NativeHealthPauseRequest.id(input["choice"]),
              let c=calendarLocalCatalog,c.id==id,let r=c.records.first(where:{$0.id==choice}) else{deny("invalid_choice");return}
        guard calendarLocalCurrent(c),r.descriptor.valid(root:c.profile.root,saved:c.profile.descriptors) else{deny("context_changed");return}
        // Observation is not authority. Never relabel an already known durable
        // or uncertain first write as notApplied on a duplicate invocation.
        if let known=calendarLocalObservations[Data(r.descriptor.selector.utf8)],known.persistence != .notApplied{
            completion(Self.calendarLocalEnvelope("unavailable",result:.init(attempt:known.attempt,persistence:known.persistence,availability:.unavailable)));return
        }
        let a=CalendarLocalAction(c,r);a.runtime=runtime;calendarLocalAction=a;clearCalendarSavedReadiness()
        setupCalendar(selection:r.descriptor.selector,authorized:a){[self] value in
            if value.attempt != nil,value.persistence != .notApplied{calendarLocalObservations[Data(r.descriptor.selector.utf8)]=value}
            let current=calendarLocalActionCurrent(a),ready=current && value.persistence == .saved && value.availability == .available && value.attempt != nil
            // Availability may narrow after a write. ORIGINAL persistence and
            // attempt must survive scope loss and unknown settlement verbatim.
            let result=NativeHealthRuntime.CalendarSetupResult(attempt:value.attempt,persistence:value.persistence,availability:ready ? .available:.unavailable)
            let reply=Self.calendarLocalEnvelope(ready ? "ready":current ? "unavailable":"context_changed",ready ? c:nil,ready ? r:nil,result:result)
            if calendarLocalAction === a{calendarLocalAction=nil;DispatchQueue.main.async{[self] in publishSavedHealthRetirement()}};completion(reply)
        }
    }
}

// Permission uses the ORIGINAL saved choice, never a new remote selector/catalog.
extension NativeHealthHost {
    func calendarReadPermissionActionCurrent(_ action:NativeCalendarReadPermissionAction)->Bool{
        guard calendarReadPermissionAction === action,let (catalog,record)=calendarReadPermissionScope,
              calendarSavedCurrent(catalog),runtime === action.runtime,action.runtime.choiceSourceCurrent,
              Data(record.descriptor.selector.utf8)==action.selector,let port=record.descriptor.readPermission,
              port.currency === action.port.currency,port.owner === action.port.owner,
              port.valid(root:catalog.profile.root,descriptor:record.descriptor),port.currency?.isBound(self)==true else{return false}
        return true
    }
    func calendarReadPermissionCurrencyRevoked(_ currency:NativeCalendarReadPermissionCurrency){
        precondition(Thread.isMainThread)
        guard calendarReadPermissionAction != nil else{return}
        clearCalendarSavedReadiness();(runtime ?? retiring)?.cancelCalendar()
    }
    private static func permissionEnvelope(_ reason:String,_ input:[String:Any]=[:],_ result:NativeCalendarReadPermissionResult = .unavailable)->[String:Any]{
        ["schemaVersion":"1.0.0","operation":"requestReadPermission","catalogId":reason=="ready" ? input["catalogId"] as Any:NSNull(),"choice":reason=="ready" ? input["choice"] as Any:NSNull(),"reason":reason,"result":result.response]
    }
    func requestCalendarReadPermissionChoice(input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        func deny(_ reason:String){completion(Self.permissionEnvelope(reason))}
        guard !choiceBusy,!calendarChoiceBusy,!calendarEntering,!healthEntering else{deny("busy");return}
        guard Set(input.keys)==Set(["schemaVersion","catalogId","choice"]),input["schemaVersion"] as? String=="1.0.0",
              let id=NativeHealthPauseRequest.id(input["catalogId"]),let choice=NativeHealthPauseRequest.id(input["choice"]),
              let catalog=calendarSavedCatalog,catalog.id==id,let record=catalog.records.first(where:{$0.id==choice}) else{deny("invalid_choice");return}
        guard calendarSavedCurrent(catalog),let observed=record.admitted,runtime === observed,!observed.hasAdmission,
              let port=record.descriptor.readPermission,port.valid(root:catalog.profile.root,descriptor:record.descriptor),port.currency?.isBound(self)==true else{deny("unavailable");return}
        let action=NativeCalendarReadPermissionAction(host:self,runtime:observed,selector:record.descriptor.selector,port:port)
        calendarReadPermissionAction=action;calendarReadPermissionScope=(catalog,record)
        observed.requestCalendarReadPermission(action:action,supplied:record.descriptor.selection.configuration){[self] value in
            let current=calendarReadPermissionActionCurrent(action)
            let result:NativeCalendarReadPermissionResult
            if current{result=value}else{result = .init(attempt:value.attempt,state:value.state == .notInvoked ? .notInvoked:.deferred,access:.unknown)}
            if !current || !result.originalBindingCurrent || result.state == .deferred{record.admitted=nil}
            let reply=Self.permissionEnvelope(current ? (result.state == .deferred || !result.observed ? "unavailable":"ready"):"context_changed",input,result)
            if calendarReadPermissionAction === action{calendarReadPermissionAction=nil;DispatchQueue.main.async{[self] in publishSavedHealthRetirement()};calendarReadPermissionScope=nil}
            completion(reply)
        }
    }
}


/// Capability snapshots only: never source policy, records, or collection authority.
enum NativeCalendarReadAccess:String {case fullRead,denied,restricted,writeOnly,notDetermined,unknown}
protocol NativeCalendarReadPermissionSDK:AnyObject {
    func access(category:String)->NativeCalendarReadAccess
    /// Must call the captured pure gate immediately before the actual OS delegate.
    /// Return true only when that delegate was entered. A Bool callback is not access.
    func request(category:String,current:()->Bool,completion:@escaping(Bool,Error?)->Void)->Bool
}
final class NativeCalendarReadPermissionCurrency {
    struct Binding {
        let root:NativeHealthRuntime.RootConfiguration.Identity,configuration:NativeCalendarAcquisitionOwner.Configuration
        let category:String
        func matches(_ b:Self)->Bool{root==b.root && configuration.matches(b.configuration) && Data(category.utf8)==Data(b.category.utf8)}
    }
    let owner:AnyObject,binding:Binding
    private weak var host:NativeHealthHost?
    private var bound=false
    private(set) var revoked=false,attempt:UUID?,rootIdentity:ObjectIdentifier?,parentIdentity:ObjectIdentifier?
    init(owner:AnyObject,binding:Binding){self.owner=owner;self.binding=binding}
    func bind(_ original:NativeHealthHost)->Bool{precondition(Thread.isMainThread);guard !bound,!revoked else{return false};bound=true;host=original;return true}
    func isBound(_ original:NativeHealthHost)->Bool{bound && !revoked && host === original}
    func revoke(){precondition(Thread.isMainThread);guard !revoked else{return};revoked=true;if attempt != nil{host?.calendarReadPermissionCurrencyRevoked(self)}}
    func claim(_ id:UUID,root:AnyObject,parent:AnyObject)->Bool{
        precondition(Thread.isMainThread);guard bound,host != nil,!revoked,attempt==nil else{return false};attempt=id;rootIdentity=ObjectIdentifier(root);parentIdentity=ObjectIdentifier(parent);return true
    }
    func current(_ id:UUID,root:AnyObject,parent:AnyObject)->Bool{!revoked && attempt==id && rootIdentity==ObjectIdentifier(root) && parentIdentity==ObjectIdentifier(parent)}
    func release(_ id:UUID){precondition(Thread.isMainThread);guard attempt==id else{return};attempt=nil;rootIdentity=nil;parentIdentity=nil}
}
/// Optional refinement on the EXACT original parent returned by original custody.
protocol NativeCalendarReadPermissionCustody:NativeSharedOutboxCustodyLease {
    func readPermissionCurrency(binding:NativeCalendarReadPermissionCurrency.Binding)->NativeCalendarReadPermissionCurrency?
}
struct NativeCalendarReadPermissionPort {
    let owner:AnyObject,currency:NativeCalendarReadPermissionCurrency?
    let prepare:()->(any NativeCalendarReadPermissionSDK)?
    func valid(root:NativeHealthRuntime.RootConfiguration,descriptor:NativeCalendarSavedDescriptor)->Bool{
        let c=descriptor.selection.configuration.configuration
        guard descriptor.selection.reconnect?.expectedSavedCategories==Set([c.plan.category]),let currency,currency.owner === owner,!currency.revoked else{return false}
        return currency.binding.matches(.init(root:root.identity,configuration:c,category:c.plan.category))
    }
}
final class NativeCalendarReadPermissionAction {
    let id=UUID(),selector:Data,port:NativeCalendarReadPermissionPort
    weak var host:NativeHealthHost?
    let runtime:NativeHealthRuntime
    init(host:NativeHealthHost,runtime:NativeHealthRuntime,selector:String,port:NativeCalendarReadPermissionPort){self.host=host;self.runtime=runtime;self.selector=Data(selector.utf8);self.port=port}
    func isCurrent()->Bool{host?.calendarReadPermissionActionCurrent(self)==true}
}
struct NativeCalendarReadPermissionResult {
    enum State:String{case notInvoked,requestCompleted,deferred}
    let attempt:UUID?,state:State,access:NativeCalendarReadAccess
    let originalBindingCurrent:Bool,observed:Bool
    init(attempt:UUID?,state:State,access:NativeCalendarReadAccess,originalBindingCurrent:Bool=false,observed:Bool=false){self.attempt=attempt;self.state=state;self.access=access;self.originalBindingCurrent=originalBindingCurrent;self.observed=observed}
    var response:[String:Any]{["attemptId":attempt?.uuidString.lowercased() as Any? ?? NSNull(),"requestState":state.rawValue,"readAccess":access.rawValue]}
    static var unavailable:Self{.init(attempt:nil,state:.notInvoked,access:.unknown)}
}
/// Owns actual invocation-return/callback-body obligations, not a timer or token.
final class NativeCalendarReadPermissionRequest {
    struct Completion {let invoked:Bool,error:Bool}
    private let sdk:any NativeCalendarReadPermissionSDK,category:String,lock=NSLock()
    private var returned=false,invoked=false,claimed=false,error=false,bodies=0,scheduled=false,delivered=false
    private var done:((Completion)->Void)?
    init(sdk:any NativeCalendarReadPermissionSDK,category:String){self.sdk=sdk;self.category=category}
    func start(current:@escaping()->Bool,done:@escaping(Completion)->Void){
        precondition(Thread.isMainThread);self.done=done
        let entered=sdk.request(category:category,current:current){[self] _,error in
            lock.lock();bodies+=1
            if !claimed{claimed=true;self.error=error != nil}
            lock.unlock()
            // Publication follows this ENTIRE original callback frame, including
            // synchronous callback-before-delegate-return and off-main bodies.
            lock.lock();bodies-=1;lock.unlock();publish()
        }
        lock.lock();returned=true;invoked=entered;lock.unlock();publish()
    }
    private func publish(){
        lock.lock();let ready=returned && (!invoked || claimed) && bodies==0 && !scheduled && !delivered;if ready{scheduled=true};lock.unlock()
        guard ready else{return}
        DispatchQueue.main.async{[self] in
            lock.lock();scheduled=false
            guard returned,(!invoked || claimed),bodies==0,!delivered else{lock.unlock();publish();return}
            delivered=true;let result=Completion(invoked:invoked,error:error),callback=done;done=nil;lock.unlock();callback?(result)
        }
    }
}


// Only normal saved-choice composition can expose its original capture factory.
extension NativeHealthHost {
    private final class CalendarCollectionReview {
        let port:NativeCalendarCollectionPort,runtime:NativeHealthRuntime
        let details:[String:Any]
        init(_ record:CalendarSavedRecord,_ port:NativeCalendarCollectionPort,_ runtime:NativeHealthRuntime){
            self.port=port;self.runtime=runtime
            let plan=record.descriptor.selection.configuration.configuration.plan
            let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];f.timeZone=TimeZone(secondsFromGMT:0)
            details=["state":"configured","scope":"collectAndDeliver","destinationLabel":record.descriptor.destinationLabel,"dataLabel":plan.category=="CalendarEvent" ? "Calendar events":"Reminders","coverageStart":f.string(from:plan.coverageStart),"coverageEnd":f.string(from:plan.coverageEnd),"timeZone":plan.capturedSDKDefaultTimeZone.identifier]
        }
    }
    private final class CalendarManualAction {
        let catalog:CalendarSavedCatalog,record:CalendarSavedRecord,review:CalendarCollectionReview
        init(_ catalog:CalendarSavedCatalog,_ record:CalendarSavedRecord,_ review:CalendarCollectionReview){self.catalog=catalog;self.record=record;self.review=review}
    }
    private func calendarManualActionCurrent(_ action:CalendarManualAction)->Bool{
        calendarManualAction === action && calendarSavedCurrent(action.catalog) && action.record.collectionReview === action.review && action.record.descriptor.collection === action.review.port && action.review.port.valid(action.record.descriptor) && runtime === action.review.runtime && action.record.admitted === action.review.runtime && action.review.runtime.choiceSourceCurrent
    }
    fileprivate func manualCollectionSelection(selector:String,profile:NativeCalendarSavedProfile)->CalendarSelection?{
        guard calendarChoiceProfile === profile,let action=calendarManualAction,Data(selector.utf8)==Data(action.record.descriptor.selector.utf8),calendarManualActionCurrent(action) else{return nil}
        let original=action.record.descriptor.selection
        // Reuse EXACT source/plan/custody/clock; attach only the ORIGINAL factory.
        return .init(runtimeSelection:original.runtimeSelection,configuration:.init(configuration:original.configuration.configuration,custody:original.configuration.custody,makeAcquisition:action.review.port.makeAcquisition,captureClock:original.configuration.captureClock))
    }
    private static func manualEnvelope(_ operation:String,_ reason:String,_ input:[String:Any]=[:],result:[String:Any]=["state":"unavailable"])->[String:Any]{
        ["schemaVersion":"1.0.0","operation":operation,"catalogId":reason=="ready" ? input["catalogId"] as Any:NSNull(),"choice":reason=="ready" ? input["choice"] as Any:NSNull(),"reason":reason,"result":result]
    }
    private func manualRecord(_ input:[String:Any])->(CalendarSavedCatalog,CalendarSavedRecord)?{
        guard Set(input.keys)==Set(["schemaVersion","catalogId","choice"]),input["schemaVersion"] as? String=="1.0.0",let id=NativeHealthPauseRequest.id(input["catalogId"]),let choice=NativeHealthPauseRequest.id(input["choice"]),let catalog=calendarSavedCatalog,catalog.id==id,let record=catalog.records.first(where:{$0.id==choice}) else{return nil};return(catalog,record)
    }
    func calendarCollectionDetailsChoice(input:[String:Any])->[String:Any]{
        precondition(Thread.isMainThread)
        guard !choiceBusy,!calendarChoiceBusy,!calendarEntering,!healthEntering else{return Self.manualEnvelope("reviewCollection","busy")}
        guard let (catalog,record)=manualRecord(input) else{return Self.manualEnvelope("reviewCollection","invalid_choice")}
        guard calendarSavedCurrent(catalog) else{return Self.manualEnvelope("reviewCollection","context_changed")}
        record.collectionReview=nil
        guard let observed=record.admitted,runtime === observed,observed.choiceSourceCurrent,let port=record.descriptor.collection,port.valid(record.descriptor) else{return Self.manualEnvelope("reviewCollection","unavailable")}
        guard observed.choiceAdmissionAvailable else{return Self.manualEnvelope("reviewCollection","busy")}
        calendarManualReviewing=true;defer{calendarManualReviewing=false;DispatchQueue.main.async{[self] in publishSavedHealthRetirement()}}
        let review=CalendarCollectionReview(record,port,observed)
        guard let zone=review.details["timeZone"] as? String,!zone.isEmpty,zone.utf8.count<=128,!zone.unicodeScalars.contains(where:{$0.value<32}),let bytes=try? JSONSerialization.data(withJSONObject:review.details),bytes.count<=3072,calendarSavedCurrent(catalog),runtime === observed else{return Self.manualEnvelope("reviewCollection","unavailable")}
        record.collectionReview=review
        return Self.manualEnvelope("reviewCollection","ready",input,result:review.details)
    }
    private static func manualFailure(_ reason:MobileEventKitAcquisition.Failure)->String{
        switch reason{case .unavailable:return "unavailable";case .invalid:return "invalid";case .stale:return "stale";case .cancelled:return "cancelled";case .incomplete:return "incomplete";case .truncated:return "truncated";case .busy:return "busy";case .storage:return "storage"}
    }
    private static func manualOutcome(_ value:NativeCalendarAcquisitionOwner.DeliveryOutcome)->[String:Any]{
        switch value{
        case .settled(let accepted,let rejected,let retryable,let more,let acquired):return ["state":"settledPrefix","acquired":acquired as Any? ?? NSNull(),"acceptedOrDuplicate":accepted,"rejected":rejected,"retryable":retryable,"mayHaveMore":more]
        case .emptyPending(let acquired):return ["state":"emptyPending","acquired":acquired as Any? ?? NSNull()]
        case .requestTooLarge:return ["state":"retained","reason":"request_too_large"]
        case .transportFailure:return ["state":"retained","reason":"transport"]
        case .invalidReceipt:return ["state":"retained","reason":"receipt"]
        case .acquisitionNotApplied(let failure):return ["state":"notApplied","stage":"acquisition","reason":manualFailure(failure)]
        case .notApplied(let failure):return ["state":"notApplied","stage":"delivery","reason":manualFailure(failure)]
        case .acquisitionUnconfirmed(let attempt):return ["state":"unconfirmed","stage":"acquisition","attemptId":attempt.uuidString.lowercased()]
        case .settlementUnconfirmed(let attempt):return ["state":"unconfirmed","stage":"settlement","attemptId":attempt.uuidString.lowercased()]
        }
    }
    func calendarCollectAndDeliverChoice(input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        func deny(_ reason:String){completion(Self.manualEnvelope("collectAndDeliver",reason))}
        guard !choiceBusy,!calendarChoiceBusy,!calendarEntering,!healthEntering else{deny("busy");return}
        guard let (catalog,record)=manualRecord(input) else{deny("invalid_choice");return}
        guard calendarSavedCurrent(catalog) else{deny("context_changed");return}
        guard let review=record.collectionReview,record.descriptor.collection === review.port,review.port.valid(record.descriptor),record.admitted === review.runtime,runtime === review.runtime,review.runtime.choiceSourceCurrent else{deny("unavailable");return}
        guard review.runtime.choiceAdmissionAvailable else{deny("busy");return}
        let action=CalendarManualAction(catalog,record,review);calendarManualAction=action
        calendar(selection:record.descriptor.selector,collect:true,manual:action){[self] value in
            // Preserve ORIGINAL stage/count/attempt: known or possible data effects
            // must not become a fabricated no-op when the scope later disappears.
            let result=Self.manualOutcome(value),current=calendarManualActionCurrent(action)
            if record.collectionReview === review{record.collectionReview=nil}
            if !review.runtime.choiceSourceCurrent || result["state"] as? String=="unconfirmed"{record.admitted=nil}
            let reply=Self.manualEnvelope("collectAndDeliver",current ? "ready":calendarSavedCurrent(catalog) ? "unavailable":"context_changed",input,result:result)
            if calendarManualAction === action{calendarManualAction=nil;DispatchQueue.main.async{[self] in publishSavedHealthRetirement()}};completion(reply)
            // Actual Runtime/SDK drain and unknown hold remain original owners'.
        }
    }
}

extension NativeHealthHost {
    private func observationBindingCurrent(_ catalog:ChoiceCatalog,_ record:ChoiceRecord,_ original:NativeHealthRuntime)->Bool{
        choiceBound && choicePort?.currency === catalog.currency && !catalog.currency.revoked &&
        choicePort?.owner === catalog.currency.owner && retiring==nil && runtime === original &&
        choiceContextCurrent(catalog.context) && original.choiceSourceCurrent &&
        original.configuration?.matches(record.descriptor.configuration)==true
    }
    private static func observationReply(_ operation:String,_ state:String,_ reason:String,catalog:ChoiceCatalog?=nil,record:ChoiceRecord?=nil)->[String:Any]{
        let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];f.timeZone=TimeZone(secondsFromGMT:0)
        return ["schemaVersion":"1.0.0","operation":operation,"state":state,"reason":reason,"catalogId":catalog?.id.uuidString.lowercased() as Any? ?? NSNull(),"choice":record?.id.uuidString.lowercased() as Any? ?? NSNull(),"readKnowledge":"unknown","plans":record?.descriptor.configuration.plans.map{["category":$0.category,"rangeStart":f.string(from:$0.start),"rangeEnd":f.string(from:$0.end)]} as Any? ?? []]
    }
    /// Original opaque catalog/choice and one-way currency. No bridge-selected
    /// category/date/background flag, no replacement issuer or persisted intent.
    func observationChoice(_ input:[String:Any],completion:@escaping([String:Any])->Void){
        precondition(Thread.isMainThread)
        let operation=input["operation"] as? String ?? "status"
        func unavailable(_ reason:String){completion(Self.observationReply(operation,"unavailable",reason))}
        let keys:Set<String>=operation=="start" ? ["operation","catalogId","choice","humanConfirmed"]:["operation","catalogId","choice"]
        guard ["start","stop","status"].contains(operation),Set(input.keys)==keys,
              let id=NativeHealthPauseRequest.id(input["catalogId"]),let selected=NativeHealthPauseRequest.id(input["choice"]),
              let catalog=choiceCatalog,catalog.id==id,catalogCurrent(catalog),let record=catalog.records.first(where:{$0.id==selected}),
              let original=runtime,observationBindingCurrent(catalog,record,original) else{unavailable("current_connection_required");return}
        func reply(){let state=observationJob.map{$0.cancelled ? "stopping":"waiting"} ?? original.observationState;completion(Self.observationReply(operation,state,"current",catalog:catalog,record:record))}
        if operation=="status"{reply();return}
        if operation=="stop"{
            if let job=observationJob,job.catalog === catalog,job.record === record{job.cancelled=true}
            original.stopObservation();reply();return
        }
        guard NativeCalendarContext.bool(input["humanConfirmed"],true),!choiceBusy,!calendarChoiceBusy,!healthEntering,!calendarEntering,original.choiceAdmissionAvailable else{unavailable("explicit_confirmation_or_idle_required");return}
        let job=ObservationJob(catalog,record,original);observationJob=job
        inventory.fetch(expectedEndpoint:record.descriptor.configuration.endpoint){[self] result in
            // Follows the complete original inventory callback before publishing
            // this activation or releasing its Host exclusion claim.
            DispatchQueue.main.async{[self] in
                guard observationJob === job else{return}
                var accepted=false
                if !job.cancelled,catalogCurrent(catalog),observationBindingCurrent(catalog,record,original),
                   case .success(let snapshot)=result,snapshot.sources.filter({Self.sourceMatches($0,record.descriptor)}).count==1{
                    accepted=original.startObservation(configuration:record.descriptor.configuration,namespace:record.descriptor.namespace,revision:record.descriptor.revision,current:{[weak self,weak original] in guard let self,let original else{return false};return self.observationBindingCurrent(catalog,record,original)})
                }
                observationJob=nil;DispatchQueue.main.async{[self] in publishSavedHealthRetirement()}
                guard accepted,observationBindingCurrent(catalog,record,original) else{unavailable("activation_deferred");return}
                reply()
            }
        }
    }
    func setNativeHealthActivity(foreground:Bool,eligibleBackground:Bool){runtime?.setNativeHealthActivity(foreground:foreground,eligibleBackground:eligibleBackground)}
    func observationForegroundOpportunity(){runtime?.observationForegroundOpportunity()}
}

extension NativeHealthHost {
    /// The stored original Runtime is retained even after ordinary withdrawal's
    /// retirement publication. A matching path or vanished Host is no proof.
    func retireHealthForSavedRecovery(original:NativeHealthRuntime,completion:@escaping(Bool)->Void){
        precondition(Thread.isMainThread)
        guard calendarChoiceProfile==nil,calendarConfiguration==nil,rootConfiguration==nil,
              runtime === original || retiring === original || lastRetiredHealthRuntime === original || healthSettingsOriginal === original,
              savedHealthRetirement==nil else{completion(false);return}
        let value=SavedHealthRetirement(original,completion);savedHealthRetirement=value
        observationJob?.cancelled=true;savedChoiceJob?.cancelled=true
        if runtime === original{withdraw()}
        original.retireForSavedHealthRecovery{[self] in
            guard savedHealthRetirement === value else{return};value.drained=true;publishSavedHealthRetirement()
        }
    }
    private func publishSavedHealthRetirement(){
        if let value=savedHealthRetirement,value.drained,runtime==nil,retiring==nil,healthSettingsOriginal === value.runtime,!value.runtime.preservesPauseHold{
            // Full original retirement cancels a purely local settings-return
            // publication; it never clears a real pending/unknown command hold.
            healthSettingsRetiring=false;healthSettingsPublishing=false;healthSettingsPublished=nil;healthSettingsCurrent=nil
        }
        guard let value=savedHealthRetirement,value.drained,!value.publishing,!value.reported,
              runtime==nil,retiring==nil,!choiceBusy,!calendarChoiceBusy,!healthEntering,!calendarEntering,
              !healthSettingsRetiring,!value.runtime.preservesPauseHold else{return}
        value.publishing=true
        DispatchQueue.main.async{[self] in
            guard savedHealthRetirement === value,value.drained,runtime==nil,retiring==nil,!choiceBusy,!calendarChoiceBusy,!healthEntering,!calendarEntering,!healthSettingsRetiring,!value.runtime.preservesPauseHold else{value.publishing=false;return}
            DispatchQueue.main.async{[self] in
                guard savedHealthRetirement === value,runtime==nil,retiring==nil,!choiceBusy,!calendarChoiceBusy,!healthEntering,!calendarEntering,!healthSettingsRetiring,!value.runtime.preservesPauseHold else{value.publishing=false;return}
                value.reported=true;value.completion(true)
            }
        }
    }
    /// Separate trusted first remember action; normal startup recovery does not
    /// come through this confirmation path or use bridge-selected identities.
    func savedHealthChoice(_ input:[String:Any],completion:@escaping([String:Any])->Void){
        let operation=input["operation"] as? String ?? "status"
        func unavailable(_ reason:String){completion(Self.observationReply(operation,"unavailable",reason))}
        let keys:Set<String>=operation=="remember" ? ["operation","catalogId","choice","humanConfirmed","updatesEnabled"]:["operation","catalogId","choice"]
        guard ["remember","stop","status"].contains(operation),Set(input.keys)==keys,
              let id=NativeHealthPauseRequest.id(input["catalogId"]),let selected=NativeHealthPauseRequest.id(input["choice"]),let catalog=choiceCatalog,catalog.id==id,catalogCurrent(catalog),let record=catalog.records.first(where:{$0.id==selected}),let original=runtime,observationBindingCurrent(catalog,record,original) else{unavailable("current_connection_required");return}
        func reply(_ reason:String="current"){
            var value=Self.observationReply(operation,original.observationState,reason,catalog:catalog,record:record)
            value["persistence"]=original.savedSelectionPersistence;value["updatesEnabled"]=original.savedHealthSelection?.updatesEnabled as Any? ?? NSNull();value["recoveryScope"]="nativeForegroundAndRelaunch";completion(value)
        }
        if operation=="stop"{savedChoiceJob?.cancelled=true;original.stopObservation();reply();return}
        if operation=="status"{reply();return}
        guard !choiceBusy,!calendarChoiceBusy,!healthEntering,!calendarEntering,original.choiceAdmissionAvailable,NativeCalendarContext.bool(input["humanConfirmed"],true),(NativeCalendarContext.bool(input["updatesEnabled"],true) || NativeCalendarContext.bool(input["updatesEnabled"],false)),let enabled=input["updatesEnabled"] as? Bool else{unavailable("explicit_confirmation_or_idle_required");return}
        let job=SavedChoiceJob(catalog,record,original);savedChoiceJob=job
        original.rememberHealthSelection(configuration:record.descriptor.configuration,namespace:record.descriptor.namespace,revision:record.descriptor.revision,enabled:enabled,current:{[weak self,weak original] in guard let self,let original else{return false};return self.savedChoiceJob === job && !job.cancelled && self.observationBindingCurrent(catalog,record,original)}){[self] result in
            DispatchQueue.main.async{[self] in
                guard savedChoiceJob === job else{return};savedChoiceJob=nil
                DispatchQueue.main.async{[self] in publishConfiguredHealthRetirement();publishSavedHealthRetirement()}
                guard observationBindingCurrent(catalog,record,original) else{unavailable("context_changed");return}
                if case .success = result,!job.cancelled{
                    if enabled{_ = original.startObservation(configuration:record.descriptor.configuration,namespace:record.descriptor.namespace,revision:record.descriptor.revision,current:{[weak self,weak original] in guard let self,let original else{return false};return self.observationBindingCurrent(catalog,record,original)})}else{original.stopObservation()}
                    reply("saved")
                }else{reply(job.cancelled ? "stopping":"not_saved")}
            }
        }
    }
}
