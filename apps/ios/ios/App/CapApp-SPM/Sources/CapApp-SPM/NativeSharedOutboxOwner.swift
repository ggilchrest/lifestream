import Foundation
import AssistantCore

/// Supplied by the ORIGINAL storage custodian. This protocol supplies no witness,
/// lock, installed provider or authority by itself. In particular a path is not a lease.
protocol NativeSharedOutboxCustodyLease: AnyObject {
    func isCurrent(storage: any HealthSnapshotStorage, binding: NativeSharedOutboxOwner.Binding) -> Bool
    func withFence<T>(_ body: () throws -> T) throws -> T
    func release()
    func admissionCurrency(binding:NativeCalendarAdmissionCurrency.Binding)->NativeCalendarAdmissionCurrency?
}
extension NativeSharedOutboxCustodyLease {
    func admissionCurrency(binding:NativeCalendarAdmissionCurrency.Binding)->NativeCalendarAdmissionCurrency?{nil}
}

/// One original snapshot owner. Ordinary Health writers are private Runtime
/// children; Calendar borrows a normal-operation grant only after their real drain.
/// The same parent may serialize an explicit protective Health transaction while
/// that child retains its lifetime grant. No second store or recovery journal.
enum NativeCalendarControlKind {case setupExistingRemote,reconnectExistingLocal,applyConfiguredExistingLocal}

/// Narrow original-file integration seam. The sole production conformance is
/// the SAME concrete NativeProtectedCalendarStorage. Legacy memory ports have
/// no conformance/fallback. These closed purposes cannot grant ordinary IO or
/// run arbitrary Core callbacks; original-object identity remains mandatory.
protocol NativeSavedHealthStorageCustody:AnyObject,HealthSnapshotStorage{
    func savedHealthWithdrawalCurrent(root:NativeSharedOutboxOwner)->Bool
    func performSavedHealthWithdrawal(root:NativeSharedOutboxOwner,expected:HealthOutbox.SavedHealthSelection,disable:Bool,requireRebind:Bool)throws->HealthOutbox.SavedHealthSelection
    func performSavedHealthBackgroundOff(root:NativeSharedOutboxOwner,expected:HealthOutbox.SavedHealthSelection)throws->HealthOutbox.SavedHealthSelection
    func closeForSavedHealthRecovery(root:NativeSharedOutboxOwner,runtime:NativeHealthRuntime)throws
}
final class NativeSharedOutboxOwner {
    struct Binding: Equatable {let origin: String;let human: UUID, session: UUID, endpoint: UUID}
    typealias Custody = (any HealthSnapshotStorage, Binding) throws -> any NativeSharedOutboxCustodyLease
    enum Failure: Error {case unavailable, stale, busy, unresolved}
    private final class Storage: HealthSnapshotStorage {
        weak var owner: NativeSharedOutboxOwner?
        func read() throws -> Data? {guard let owner else{throw Failure.unavailable};return try owner.read()}
        func replace(_ data: Data) throws {guard let owner else{throw Failure.unavailable};try owner.replace(data)}
    }
    final class CalendarLease: NativeCalendarAcquisitionLease {
        private let owner: NativeSharedOutboxOwner
        private let token: UInt64
        private var released=false
        var outbox: HealthOutbox {owner.box}
        fileprivate init(_ owner:NativeSharedOutboxOwner,_ token:UInt64){self.owner=owner;self.token=token}
        func checkCurrent()->Bool {
            guard !released,!owner.savedHealthControlActive,owner.calendarToken==token,owner.activeCalendar,!owner.calendarFenced,owner.available else{return false}
            let current=owner.parent?.isCurrent(storage:owner.original,binding:owner.binding) ?? false
            return current && !released && owner.calendarToken==token && owner.activeCalendar && !owner.calendarFenced && owner.available
        }
        func release(){guard !released else{return};released=true;owner.releaseCalendar(token)}
    }
    private final class AdmissionFrame {
        let attempt:UUID,parent:any NativeSharedOutboxCustodyLease,configuration:NativeCalendarAdmissionCurrency,custody:NativeCalendarAdmissionCurrency,token:UInt64,epoch:Int
        let binding:NativeCalendarAdmissionCurrency.Binding
        init(attempt:UUID,parent:any NativeSharedOutboxCustodyLease,configuration:NativeCalendarAdmissionCurrency,custody:NativeCalendarAdmissionCurrency,token:UInt64,epoch:Int,binding:NativeCalendarAdmissionCurrency.Binding){self.attempt=attempt;self.parent=parent;self.configuration=configuration;self.custody=custody;self.token=token;self.epoch=epoch;self.binding=binding}
    }
    private final class CommandFrame {
        let attempt:UUID,parent:any NativeSharedOutboxCustodyLease,configuration:NativeCalendarCommandCurrency,custody:NativeCalendarCommandCurrency,epoch:Int,token:UInt64
        init(_ attempt:UUID,_ parent:any NativeSharedOutboxCustodyLease,_ configuration:NativeCalendarCommandCurrency,_ custody:NativeCalendarCommandCurrency,_ epoch:Int,_ token:UInt64){self.attempt=attempt;self.parent=parent;self.configuration=configuration;self.custody=custody;self.epoch=epoch;self.token=token}
    }
    private var savedHealthControlActive=false,savedHealthWithdrawal=false
    private var commandFrame:CommandFrame?
    private var commandFrameCurrent:Bool{
        guard let f=commandFrame else{return true}
        return parent === f.parent && activeCalendar && !calendarFenced && calendarToken==f.token && transport.epoch==f.epoch && f.configuration.current(f.attempt,root:self,parent:f.parent) && f.custody.current(f.attempt,root:self,parent:f.parent)
    }
    enum CommandAction {
        case pending,lastTerminal,stage(Data),attempt(Data),terminal(MobileCalendarSettingsWire.Terminal,Bool)
        case consentPending,consentLast,consentStage(Data),consentAttempt(Data),consentSettle(Data,Data,Bool)
        case healthConsentPending,healthConsentLast,healthConsentStage(Data),healthConsentAttempt(Data),healthConsentSettle(Data,Data,Bool)
        case healthControlPending,healthControlLast,healthControlStage(Data),healthControlAttempt(Data),healthControlSettle(MobileOrdinaryControl.Terminal,Bool)
        case healthLocalState(UUID,UUID),healthConfiguredLocal(HealthOutbox.HealthConfiguredLocalState,MobileOrdinaryControl.Terminal,MobileHealthPolicyProof,Set<String>)
        var purpose:String{switch self{case .pending,.consentPending,.healthConsentPending,.healthControlPending,.healthLocalState:return "reconcileOriginal";case .lastTerminal,.consentLast,.healthConsentLast,.healthControlLast:return "reconcileTerminalOriginal";case .stage,.consentStage,.healthConsentStage,.healthControlStage:return "stageOriginal";case .attempt,.consentAttempt,.healthConsentAttempt,.healthControlAttempt:return "markAttempted";case .terminal,.consentSettle,.healthConsentSettle,.healthControlSettle,.healthConfiguredLocal:return "settleOriginal"}}
        var original:Data?{switch self{case .pending,.lastTerminal,.consentPending,.consentLast,.healthConsentPending,.healthConsentLast,.healthControlPending,.healthControlLast,.healthLocalState:return nil;case .stage(let data),.attempt(let data),.consentStage(let data),.consentAttempt(let data),.consentSettle(let data,_,_),.healthConsentStage(let data),.healthConsentAttempt(let data),.healthConsentSettle(let data,_,_):return data;case .healthControlStage(let data),.healthControlAttempt(let data):return data;case .healthConfiguredLocal(_,let value,_,_):return value.original.canonical;case .healthControlSettle(let value,_):return value.original.canonical;case .terminal(let value,_):return value.command.original}}
    }
    enum CommandResult{case pending(HealthOutbox.CalendarNativePending?),lastTerminal(Data?),healthLocal(HealthOutbox.HealthConfiguredLocalState),written}
    /// Typed operations only. There is no arbitrary callback into Core's lock.
    func performCommand(_ action:CommandAction,attempt:UUID,lease:CalendarLease,configuration:NativeCalendarCommandCurrency,owner:AnyObject,identity:NativeHealthRuntime.RootConfiguration.Identity)throws->CommandResult{
        let b=NativeCalendarCommandCurrency.Binding(root:identity,purpose:action.purpose,original:action.original)
        guard !inStorage,admission==nil,commandFrame==nil,available,lease.checkCurrent(),let parent,self.parent === parent,configuration.owner === owner,configuration.binding.matches(b),let actual=parent as? any NativeCalendarCommandCustody,
              identity.origin==binding.origin,identity.human==binding.human,identity.session==binding.session,identity.endpoint==binding.endpoint else{throw Failure.unavailable}
        // All extensible issuance/currentness calls occur BEFORE entering Core.
        guard let currency=actual.commandCurrency(binding:b),currency.owner === parent,currency.binding.matches(b),lease.checkCurrent(),available else{throw Failure.unavailable}
        try configuration.claim(attempt,root:self,parent:parent);try currency.claim(attempt,root:self,parent:parent)
        commandFrame=CommandFrame(attempt,parent,configuration,currency,transport.epoch,calendarToken)
        defer{if !unresolved{commandFrame=nil}}
        guard commandFrameCurrent else{throw Failure.stale}
        let current=HealthOutbox.CalendarNativeBinding(origin:binding.origin,principal:binding.human,session:binding.session,endpoint:binding.endpoint)
        switch action{
        case .pending:return .pending(try box.calendarNativeCommandForReconciliation(origin:binding.origin,principal:binding.human,endpoint:binding.endpoint))
        case .lastTerminal:return .lastTerminal(try box.calendarNativeLastTerminalForReconciliation(origin:binding.origin,principal:binding.human,endpoint:binding.endpoint))
        case .stage(let data):try box.stageCalendarNativeCommand(binding:current,original:data)
        case .attempt(let data):try box.markCalendarNativeCommandAttempted(binding:current,original:data)
        case .terminal(let terminal,let reconciliation):try box.settleCalendarNativeCommand(binding:current,terminal:terminal,reconciliation:reconciliation)
        case .consentPending:return .pending(try box.calendarSourceConsentPending(origin:binding.origin,principal:binding.human,endpoint:binding.endpoint))
        case .consentLast:return .lastTerminal(try box.calendarSourceConsentLastOriginal(origin:binding.origin,principal:binding.human,endpoint:binding.endpoint))
        case .consentStage(let data):try box.stageCalendarSourceConsent(binding:current,original:data)
        case .consentAttempt(let data):try box.markCalendarSourceConsentAttempted(binding:current,original:data)
        case .consentSettle(let original,let response,let reconcile):try box.settleCalendarSourceConsent(binding:current,original:original,response:response,reconciliation:reconcile)
        case .healthControlPending:return .pending(try box.healthControlPending(origin:binding.origin,principal:binding.human))
        case .healthControlLast:return .lastTerminal(try box.healthControlLastOriginal(origin:binding.origin,principal:binding.human))
        case .healthControlStage(let original):try box.stageHealthControl(binding:current,original:original)
        case .healthControlAttempt(let original):try box.markHealthControlAttempted(binding:current,original:original)
        case .healthLocalState(let enrollment,let namespace):return .healthLocal(try box.healthConfiguredLocalState(binding:current,enrollment:enrollment,namespace:namespace))
        case .healthConfiguredLocal(let expected,let terminal,let proof,let selected):return .healthLocal(try box.applyHealthConfiguredExistingLocal(binding:current,expected:expected,terminal:terminal,proof:proof,selectedTypes:selected))
        case .healthControlSettle(let value,let reconcile):try box.settleHealthControl(binding:current,terminal:value,reconciliation:reconcile)
        case .healthConsentPending:return .pending(try box.healthSourceConsentPending(origin:binding.origin,principal:binding.human,endpoint:binding.endpoint))
        case .healthConsentLast:return .lastTerminal(try box.healthSourceConsentLastOriginal(origin:binding.origin,principal:binding.human,endpoint:binding.endpoint))
        case .healthConsentStage(let data):try box.stageHealthSourceConsent(binding:current,original:data)
        case .healthConsentAttempt(let data):try box.markHealthSourceConsentAttempted(binding:current,original:data)
        case .healthConsentSettle(let original,let response,let reconcile):try box.settleHealthSourceConsent(binding:current,original:original,response:response,reconciliation:reconcile)
        }
        return .written
    }
    private var admission:AdmissionFrame?
    var admitting:Bool{admission != nil}
    /// Only stored fields/concrete comparisons; never invokes an authority getter.
    private var admissionCurrent:Bool {
        guard let f=admission else{return true}
        return parent === f.parent && activeCalendar && calendarToken==f.token && !calendarFenced && transport.epoch==f.epoch &&
            !f.configuration.revoked && !f.custody.revoked && f.configuration.attempt==f.attempt && f.custody.attempt==f.attempt &&
            f.configuration.rootOwner==ObjectIdentifier(self) && f.custody.rootOwner==ObjectIdentifier(self) &&
            f.configuration.parentOwner==ObjectIdentifier(f.parent) && f.custody.parentOwner==ObjectIdentifier(f.parent)
    }
    func admitCalendar(attempt:UUID,lease:CalendarLease,configuration:NativeCalendarAdmissionCurrency,owner:AnyObject,binding:NativeCalendarAdmissionCurrency.Binding,proof:MobileCalendarPolicyProof)throws {
        try performCalendarControl(kind:.setupExistingRemote,attempt:attempt,lease:lease,configuration:configuration,owner:owner,binding:binding,proof:proof)
    }
    func reconnectCalendar(attempt:UUID,lease:CalendarLease,configuration:NativeCalendarAdmissionCurrency,owner:AnyObject,binding:NativeCalendarAdmissionCurrency.Binding,proof:MobileCalendarPolicyProof)throws {
        try performCalendarControl(kind:.reconnectExistingLocal,attempt:attempt,lease:lease,configuration:configuration,owner:owner,binding:binding,proof:proof)
    }
    func applyConfiguredCalendar(attempt:UUID,lease:CalendarLease,configuration:NativeCalendarAdmissionCurrency,owner:AnyObject,binding:NativeCalendarAdmissionCurrency.Binding,proof:MobileCalendarPolicyProof)throws{
        try performCalendarControl(kind:.applyConfiguredExistingLocal,attempt:attempt,lease:lease,configuration:configuration,owner:owner,binding:binding,proof:proof)
    }
    private func performCalendarControl(kind:NativeCalendarControlKind,attempt:UUID,lease:CalendarLease,configuration:NativeCalendarAdmissionCurrency,owner:AnyObject,binding:NativeCalendarAdmissionCurrency.Binding,proof:MobileCalendarPolicyProof)throws {
        guard binding.kind==kind,!inStorage,admission==nil,available,lease.checkCurrent(),let parent,self.parent === parent,configuration.owner === owner,configuration.binding.matches(binding) else{throw Failure.stale}
        // Extensible original custody issuance is BEFORE Core/its NSLock.
        guard let currency=parent.admissionCurrency(binding:binding),currency.owner === parent,currency.binding.matches(binding),lease.checkCurrent(),available else{throw Failure.unavailable}
        try configuration.claim(attempt:attempt,root:self,parent:parent)
        try currency.claim(attempt:attempt,root:self,parent:parent)
        let frame=AdmissionFrame(attempt:attempt,parent:parent,configuration:configuration,custody:currency,token:calendarToken,epoch:transport.epoch,binding:binding)
        admission=frame
        defer{if !unresolved{admission=nil}}
        guard admissionCurrent else{throw Failure.stale}
        switch kind {
        case .setupExistingRemote:
            if let run=binding.configuration.scopedRun{
                let selection=try MobileCalendarSettingsWire.phoneSelection(run:run,plan:binding.configuration.plan)
                try box.admitCalendarExistingRemote(proof:proof,selectedCategories:binding.selected,nativeSelection:selection,scopedRun:run)
            }else{try box.admitCalendarExistingRemote(proof:proof,selectedCategories:binding.selected)}
        case .reconnectExistingLocal:try box.reconnectCalendarExistingLocal(proof:proof,expectedCategories:binding.selected)
        case .applyConfiguredExistingLocal:
            guard let terminal=binding.configuration.configuredTerminal,let run=binding.configuration.scopedRun else{throw Failure.unavailable}
            let selection=try MobileCalendarSettingsWire.phoneSelection(run:run,plan:binding.configuration.plan)
            if try box.calendarConfiguredLocalRevision(principal:proof.principal,endpoint:proof.endpoint,enrollment:proof.enrollment,namespace:proof.namespace)==nil{
                try box.admitCalendarExistingRemote(proof:proof,selectedCategories:binding.selected,nativeSelection:selection,scopedRun:run)
            }else{try box.applyCalendarConfiguredExistingLocal(terminal:terminal,proof:proof,selection:selection)}
        }
    }
    var changed:(()->Void)?
    private let original: any HealthSnapshotStorage
    private let transport:NativeTransport
    let binding: Binding
    private let wrapper=Storage()
    private(set) lazy var box=HealthOutbox(storage:wrapper,maxBytes:maxBytes,maxEvents:maxEvents)
    private let maxBytes:Int,maxEvents:Int
    private var parent:(any NativeSharedOutboxCustodyLease)?
    private var calendarToken:UInt64=0
    private(set) var activeCalendar=false, reservingCalendar=false, unresolved=false, revoked=false
    private(set) var healthGeneration:UInt64=0
    private var healthFenced=false,calendarFenced=false, ioDepth=0, protectiveDepth=0, observationDepth=0, publishing=false
    var inStorage:Bool {ioDepth>0}
    var available:Bool {
        guard !revoked,!unresolved,transport.endpoint?.absoluteString==binding.origin,transport.effectiveIsSelf,let owner=transport.currentEffectiveOwner else{return false}
        return UUID(uuidString:owner.principal)==binding.human && UUID(uuidString:owner.session)==binding.session
    }
    var healthIOCurrent:Bool {available && !healthFenced && !activeCalendar}
    var healthAdmission:Bool {healthIOCurrent && !reservingCalendar && !publishing && !inStorage}
    var busy:Bool {savedHealthControlActive || activeCalendar || reservingCalendar || publishing}
    init(storage:any HealthSnapshotStorage,binding:Binding,transport:NativeTransport,maxBytes:Int,maxEvents:Int){
        original=storage;self.binding=binding;self.transport=transport;self.maxBytes=maxBytes;self.maxEvents=maxEvents;wrapper.owner=self
    }
    func fenceHealth(){admission?.configuration.revoke();healthGeneration &+= 1;healthFenced=true}
    func resumeHealth()throws{guard available,!busy,!inStorage else{throw Failure.unavailable};healthGeneration &+= 1;healthFenced=false}
    func cancelAdmission(){commandFrame?.configuration.revoke();admission?.configuration.revoke();if reservingCalendar{calendarToken &+= 1};if activeCalendar{calendarFenced=true}}
    func revoke(){commandFrame?.configuration.revoke();commandFrame?.custody.revoke();admission?.configuration.revoke();admission?.custody.revoke();revoked=true;healthGeneration &+= 1;healthFenced=true;calendarToken &+= 1}
    enum DeferredWork:Hashable {case pause,retirement,authority,calendarCancellation,healthConfigurationRetirement,healthSavedSelectionProtection,healthSavedPolicyInvalidation,healthBackgroundPreferenceProtection}
    private var deferred:[DeferredWork:()->Void]=[:]
    /// At most one action for each owned lifecycle purpose. A still-entered
    /// storage frame retains these actions; it does not spin or poll the queue.
    func afterFrame(_ kind:DeferredWork,_ action:@escaping()->Void){
        if inStorage || ((kind == .healthSavedSelectionProtection || kind == .healthSavedPolicyInvalidation || kind == .healthBackgroundPreferenceProtection) && (savedHealthControlActive || publishing || activeCalendar || reservingCalendar || admitting)){deferred[kind]=action}else{action()}
    }
    private func leaveStorage(){
        ioDepth-=1
        guard ioDepth==0,!deferred.isEmpty else{return}
        let actions=deferred;deferred.removeAll()
        // Storage has returned, but HealthOutbox still holds its NSLock. Run
        // only after its entire original frame has returned to the main queue.
        DispatchQueue.main.async{[self] in
            for key:DeferredWork in [.authority,.retirement,.pause,.calendarCancellation,.healthConfigurationRetirement,.healthSavedSelectionProtection,.healthSavedPolicyInvalidation,.healthBackgroundPreferenceProtection]{if let action=actions[key]{afterFrame(key,action)}}
        }
    }
    private func publishDeferredSavedHealth(){
        for key:DeferredWork in [.healthSavedSelectionProtection,.healthSavedPolicyInvalidation,.healthBackgroundPreferenceProtection]{if let action=deferred.removeValue(forKey:key){afterFrame(key,action)}}
    }
    func observe<T>(_ body:()throws->T)throws->T {
        guard !inStorage,!unresolved else{throw Failure.unavailable}
        observationDepth+=1;defer{observationDepth-=1};return try body()
    }
    func protective<T>(_ body:()throws->T)throws->T {
        guard !inStorage,available else{throw Failure.unavailable}
        protectiveDepth+=1;defer{protectiveDepth-=1};return try body()
    }
    private var normalDomainCurrent:Bool {activeCalendar ? !calendarFenced:!healthFenced}
    private var savedWithdrawalCurrent:Bool{
        savedHealthControlActive && savedHealthWithdrawal && !unresolved && (original as? any NativeSavedHealthStorageCustody)?.savedHealthWithdrawalCurrent(root:self)==true
    }
    private var readAllowed:Bool {savedWithdrawalCurrent || (available && admissionCurrent && commandFrameCurrent && (observationDepth>0 || protectiveDepth>0 || normalDomainCurrent))}
    private var writeAllowed:Bool {savedWithdrawalCurrent || (available && admissionCurrent && commandFrameCurrent && observationDepth==0 && (protectiveDepth>0 || normalDomainCurrent))}
    private func fenced<T>(_ body:()throws->T)throws->T {
        if let parent {
            return try parent.withFence {
                let current=parent.isCurrent(storage:original,binding:binding)
                guard current else{throw Failure.stale};return try body()
            }
        }
        return try body() // Original ordinary Health authority, never a Calendar grant.
    }
    private func read()throws->Data? {
        guard ioDepth==0,readAllowed else{throw Failure.unavailable}
        ioDepth+=1;defer{leaveStorage()}
        let originalParent=parent,originalAdmission=admission
        let value=try fenced {
            guard readAllowed else{throw Failure.stale}
            let value=try original.read()
            // Exclusion across a storage call is not permanent custody currency.
            // Recheck the SAME parent after the original read, then pure domain
            // and context state after that extensible guard, before returning bytes.
            if let originalParent {
                let current=originalParent.isCurrent(storage:original,binding:binding)
                guard current,parent === originalParent,readAllowed else{throw Failure.stale}
            }else{guard parent==nil,readAllowed else{throw Failure.stale}}
            return value
        }
        // The original withFence implementation may run callbacks while its
        // body unwinds. Finish that ENTIRE call before the final pure check;
        // no extensible getter may follow it before Core receives the bytes.
        guard parent === originalParent,admission === originalAdmission,readAllowed else{throw Failure.stale}
        return value
    }
    private func replace(_ data:Data)throws {
        guard ioDepth==0,writeAllowed else{throw Failure.unavailable}
        ioDepth+=1;defer{leaveStorage()}
        try fenced {
            guard writeAllowed else{throw Failure.stale}
            do {try original.replace(data)}
            catch{unresolved=true;healthGeneration &+= 1;DispatchQueue.main.async{[weak self] in self?.changed?()};throw error}
            // A successful invoked write stays known success even if a nested
            // withdrawal revoked subsequent work. Never invent a post-write throw.
        }
    }
    enum SavedHealthControl {
        case read(origin:String,human:UUID,endpoint:UUID)
        case save(HealthOutbox.SavedHealthSelection,HealthOutbox.SavedHealthSelection?,MobileHealthPolicyProof,HealthOutbox.SavedHealthSelection?)
        case check(HealthOutbox.SavedHealthSelection,requireUpdatesEnabled:Bool)
        case adoptSavedLookup(requireSourceRebind:Bool)
        case background(HealthOutbox.SavedHealthSelection,enabled:Bool,proof:MobileHealthPolicyProof?)
        case protect(HealthOutbox.SavedHealthSelection,disable:Bool,requireRebind:Bool)
    }
    enum SavedHealthResult{case selections([HealthOutbox.SavedHealthSelection]),saved(HealthOutbox.SavedHealthSelection),checked}
    func releaseSavedHealthStorage(runtime:NativeHealthRuntime)throws{
        guard runtime.mayReleaseSavedStorage(self),revoked,!unresolved,!busy,!inStorage,parent==nil,!admitting,let storage=original as? any NativeSavedHealthStorageCustody else{throw Failure.unavailable}
        try storage.closeForSavedHealthRecovery(root:self,runtime:runtime)
    }
    func ownsOriginalStorage(_ storage:any NativeSavedHealthStorageCustody)->Bool{(original as? any NativeSavedHealthStorageCustody) === storage}
    private func savedBinding(_ value:HealthOutbox.SavedHealthSelection)->Bool{Data(value.origin.utf8)==Data(binding.origin.utf8) && value.human==binding.human && value.endpoint==binding.endpoint}
    /// Closed metadata purposes on the SAME Core/file owner. This API supplies
    /// no arbitrary callback, SDK invocation, policy proof or ordinary IO grant.
    func savedHealthControl(_ operation:SavedHealthControl)throws->SavedHealthResult{
        guard !inStorage,!unresolved,!savedHealthControlActive,!publishing,!admitting else{throw Failure.busy}
        if case .protect(let value,let disable,let rebind)=operation{
            guard savedBinding(value),disable || rebind,let storage=original as? any NativeSavedHealthStorageCustody else{throw Failure.unavailable}
            savedHealthControlActive=true;savedHealthWithdrawal=true
            defer{finishSavedHealthControl()}
            return .saved(try storage.performSavedHealthWithdrawal(root:self,expected:value,disable:disable,requireRebind:rebind))
        }
        if case .background(let value,false,_)=operation{
            guard savedBinding(value),let storage=original as? any NativeSavedHealthStorageCustody else{throw Failure.unavailable}
            savedHealthControlActive=true;savedHealthWithdrawal=true
            defer{finishSavedHealthControl()}
            return .saved(try storage.performSavedHealthBackgroundOff(root:self,expected:value))
        }
        guard available,!busy,healthAdmission else{throw Failure.unavailable}
        savedHealthControlActive=true
        defer{finishSavedHealthControl()}
        switch operation{
        case .read(let origin,let human,let endpoint):
            guard Data(origin.utf8)==Data(binding.origin.utf8),human==binding.human,endpoint==binding.endpoint else{throw Failure.stale}
            return .selections(try box.savedHealthSelections(origin:origin,human:human,endpoint:endpoint))
        case .save(let value,let expected,let proof,let replacing):
            guard original is any NativeSavedHealthStorageCustody,savedBinding(value),expected.map(savedBinding) ?? true,replacing.map(savedBinding) ?? true else{throw Failure.stale}
            try box.saveHealthSelection(value,expected:expected,proof:proof,replacing:replacing);return .saved(value)
        case .check(let value,let requireUpdatesEnabled):guard savedBinding(value) else{throw Failure.stale};try box.checkHealthSavedRecovery(value,requireUpdatesEnabled:requireUpdatesEnabled);return .checked
        case .adoptSavedLookup(let rebind):try box.adoptSavedHealthLookup(human:binding.human,requireSourceRebind:rebind);return .checked
        case .background(let value,let enabled,let proof):
            guard original is any NativeSavedHealthStorageCustody,savedBinding(value),enabled else{throw Failure.stale}
            return .saved(try box.setHealthBackgroundChoice(expected:value,enabled:true,proof:proof))
        case .protect:throw Failure.unavailable
        }
    }
    func executeSavedHealthBackgroundOff(storage:any NativeSavedHealthStorageCustody,expected:HealthOutbox.SavedHealthSelection)throws->HealthOutbox.SavedHealthSelection{
        guard savedWithdrawalCurrent,ownsOriginalStorage(storage),savedBinding(expected) else{throw Failure.stale}
        return try box.setHealthBackgroundChoice(expected:expected,enabled:false)
    }
    /// Entered only by the already-held original storage's closed withdrawal
    /// frame. Even after Auth withdrawal this operation can ONLY disable/rebind
    /// its exact prior choice; it cannot clear a marker or grant ordinary IO.
    func executeSavedHealthProtection(storage:any NativeSavedHealthStorageCustody,expected:HealthOutbox.SavedHealthSelection,disable:Bool,requireRebind:Bool)throws->HealthOutbox.SavedHealthSelection{
        guard savedWithdrawalCurrent,ownsOriginalStorage(storage),savedBinding(expected),disable || requireRebind else{throw Failure.stale}
        return try box.protectHealthSelection(expected:expected,disable:disable,requireRebind:requireRebind)
    }
    private func finishSavedHealthControl(){
        savedHealthWithdrawal=false;savedHealthControlActive=false;publishing=true
        DispatchQueue.main.async{[self] in publishing=false;publishDeferredSavedHealth();changed?()}
    }
    func acquireCalendar(custody:Custody?,drain:@escaping(@escaping()->Void)->Void,completion:@escaping(Result<CalendarLease,Error>)->Void){
        guard available,!busy,!inStorage,let custody else{completion(.failure(Failure.unavailable));return}
        reservingCalendar=true;calendarToken &+= 1;let token=calendarToken
        drain{[self] in
            // Fence all old drain observer publication, including reentry.
            DispatchQueue.main.async{[self] in
                guard reservingCalendar else{completion(.failure(Failure.stale));return}
                defer{reservingCalendar=false;changed?()}
                do {
                    guard token==calendarToken,available else{throw Failure.stale}
                    let lease=try custody(original,binding)
                    let current=lease.isCurrent(storage:original,binding:binding)
                    guard current,token==calendarToken,available else{lease.release();throw Failure.stale}
                    parent=lease;activeCalendar=true;calendarFenced=false
                    completion(.success(CalendarLease(self,token)))
                }catch{completion(.failure(error))}
            }
        }
    }
    private func releaseCalendar(_ token:UInt64){
        // Revocation may advance currency token while original lifetime persists.
        guard activeCalendar else{return}
        guard !unresolved else{return}
        publishing=true;activeCalendar=false
        let old=parent;parent=nil;old?.release()
        DispatchQueue.main.async{[self] in publishing=false;publishDeferredSavedHealth();changed?()}
    }
}

/// Required revocation currency supplied by the ORIGINAL configuration/custody
/// owner. This type supplies no grant/exclusion by itself. Owners must revoke
/// before EVERY bound mutation (including ABA/provider identity changes), on the
/// main queue or under equivalent original custody serialization. No rearm.
final class NativeCalendarAdmissionCurrency {
    struct Binding {
        let root:NativeHealthRuntime.RootConfiguration.Identity
        let configuration:NativeCalendarAcquisitionOwner.Configuration
        let selected:Set<String>,kind:NativeCalendarControlKind
        init(root:NativeHealthRuntime.RootConfiguration.Identity,configuration:NativeCalendarAcquisitionOwner.Configuration,selected:Set<String>,kind:NativeCalendarControlKind = .setupExistingRemote){self.root=root;self.configuration=configuration;self.selected=selected;self.kind=kind}
        func matches(_ other:Self)->Bool{kind==other.kind && root==other.root && configuration.matches(other.configuration) && Set(selected.map{Data($0.utf8)})==Set(other.selected.map{Data($0.utf8)})}
    }
    let owner:AnyObject,binding:Binding
    private(set) var revoked=false
    private(set) var attempt:UUID?
    private(set) var rootOwner:ObjectIdentifier?,parentOwner:ObjectIdentifier?
    init(owner:AnyObject,binding:Binding){self.owner=owner;self.binding=binding}
    func revoke(){precondition(Thread.isMainThread);revoked=true}
    func claim(attempt:UUID,root:AnyObject,parent:AnyObject)throws{
        precondition(Thread.isMainThread)
        guard !revoked,self.attempt==nil else{throw NativeCalendarAdmissionError.stale}
        self.attempt=attempt;rootOwner=ObjectIdentifier(root);parentOwner=ObjectIdentifier(parent)
    }
}

/// Distinct native control purpose: no source/enrollment/plan is invented to
/// stage a real unbound enrollment command or retrieve its exact original.
final class NativeCalendarCommandCurrency {
    struct Binding {
        let root:NativeHealthRuntime.RootConfiguration.Identity,purpose:String,original:Data?
        func matches(_ b:Self)->Bool{root==b.root && Data(purpose.utf8)==Data(b.purpose.utf8) && original==b.original}
    }
    let owner:AnyObject,binding:Binding
    private(set) var revoked=false,attempt:UUID?,rootIdentity:ObjectIdentifier?,parentIdentity:ObjectIdentifier?
    init(owner:AnyObject,binding:Binding){self.owner=owner;self.binding=binding}
    func revoke(){revoked=true}
    func claim(_ id:UUID,root:AnyObject,parent:AnyObject)throws{
        guard !revoked,attempt==nil else{throw NativeCalendarAdmissionError.stale};attempt=id;rootIdentity=ObjectIdentifier(root);parentIdentity=ObjectIdentifier(parent)
    }
    func current(_ id:UUID,root:AnyObject,parent:AnyObject)->Bool{!revoked && attempt==id && rootIdentity==ObjectIdentifier(root) && parentIdentity==ObjectIdentifier(parent)}
}
protocol NativeCalendarCommandCustody:NativeSharedOutboxCustodyLease {
    func commandCurrency(binding:NativeCalendarCommandCurrency.Binding)->NativeCalendarCommandCurrency?
}
