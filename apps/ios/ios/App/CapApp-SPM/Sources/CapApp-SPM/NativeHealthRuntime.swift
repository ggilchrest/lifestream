import Foundation
import CryptoKit
import CoreFoundation
import AssistantCore

/// Comparison hints from the selected inventory row, never authority.
struct NativeHealthStatusRequest {
    let sourceNamespace:UUID,enrollment:UUID,endpoint:UUID
    let policyRevision:Int,contextRevision:Int
    static func number(_ value:Any?,minimum:Int)->Int? {
        guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue.rounded()==n.doubleValue,n.doubleValue>=Double(minimum),n.doubleValue<=9007199254740991 else{return nil};return n.intValue
    }
    init?(_ value:[String:Any]) {
        func uuid(_ key:String)->UUID?{guard let raw=value[key] as? String,raw.utf8.count==36,let id=UUID(uuidString:raw),id.uuidString.lowercased()==raw else{return nil};return id}
        guard Set(value.keys)==Set(["schemaVersion","sourceNamespace","enrollmentId","endpointId","policyRevision","contextRevision"]),value["schemaVersion"] as? String=="1.0.0",let source=uuid("sourceNamespace"),let enrollment=uuid("enrollmentId"),let endpoint=uuid("endpointId"),let policy=Self.number(value["policyRevision"],minimum:1),let context=Self.number(value["contextRevision"],minimum:0) else{return nil}
        sourceNamespace=source;self.enrollment=enrollment;self.endpoint=endpoint;policyRevision=policy;contextRevision=context
    }
}
enum NativeHealthSelectedStatus {
    static func response(_ state:String,_ reason:String,binding:[String:Any]?=nil,local:[String:Any]?=nil)->[String:Any] {
        ["schemaVersion":"1.0.0","state":state,"reason":reason,"binding":binding as Any? ?? NSNull(),"local":local as Any? ?? NSNull()]
    }
}

struct NativeHealthPauseRequest:Equatable {
    let operationId:UUID,sourceNamespace:UUID,enrollment:UUID,endpoint:UUID
    static func id(_ value:Any?)->UUID? {
        guard let raw=value as? String,raw.utf8.count==36,let id=UUID(uuidString:raw),id.uuidString.lowercased()==raw else{return nil};return id
    }
    init?(_ value:[String:Any]) {
        guard Set(value.keys)==Set(["schemaVersion","operationId","sourceNamespace","enrollmentId","endpointId"]),value["schemaVersion"] as? String=="1.0.0",let op=Self.id(value["operationId"]),let ns=Self.id(value["sourceNamespace"]),let en=Self.id(value["enrollmentId"]),let ep=Self.id(value["endpointId"]) else{return nil}
        operationId=op;sourceNamespace=ns;enrollment=en;endpoint=ep
    }
    var binding:[String:Any] {["sourceNamespace":sourceNamespace.uuidString.lowercased(),"enrollmentId":enrollment.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased()]}
}
enum NativeHealthPauseResponse {
    static func make(id:UUID?,binding:[String:Any]?=nil,persistence:String="notApplied",drain:String="notStarted",reason:String)->[String:Any] {
        ["schemaVersion":"1.0.0","operationId":id.map{$0.uuidString.lowercased()} as Any? ?? NSNull(),"binding":binding as Any? ?? NSNull(),"persistence":persistence,"drain":drain,"reason":reason]
    }
}

struct NativeHealthResumeRequest:Equatable {
    let operationId:UUID,expectedPauseOperationId:UUID,sourceNamespace:UUID,enrollment:UUID,endpoint:UUID
    init?(_ value:[String:Any]) {
        guard Set(value.keys)==Set(["schemaVersion","operationId","expectedPauseOperationId","sourceNamespace","enrollmentId","endpointId"]),value["schemaVersion"] as? String=="1.0.0",let operation=NativeHealthPauseRequest.id(value["operationId"]),let pause=NativeHealthPauseRequest.id(value["expectedPauseOperationId"]),let source=NativeHealthPauseRequest.id(value["sourceNamespace"]),let enrollment=NativeHealthPauseRequest.id(value["enrollmentId"]),let endpoint=NativeHealthPauseRequest.id(value["endpointId"]) else{return nil}
        operationId=operation;expectedPauseOperationId=pause;sourceNamespace=source;self.enrollment=enrollment;self.endpoint=endpoint
    }
}
enum NativeHealthResumeResponse {
    static func make(id:UUID?,binding:[String:Any]?=nil,outcome:String="notApplied",reason:String)->[String:Any] {
        ["schemaVersion":"1.0.0","operationId":id.map{$0.uuidString.lowercased()} as Any? ?? NSNull(),"binding":binding as Any? ?? NSNull(),"outcome":outcome,"reason":reason]
    }
}

/// Native-owned inputs only. There is deliberately no bridge decoder or installed default.
final class NativeHealthRuntime: NativeHealthPolicySuspending {
    enum Failure: Error { case unavailable, stale, busy, invalid, sourceMismatch }
    enum LocalSetup:Equatable { case enrollExistingRemote, confirmExistingLocal, resumeExistingLocal, rebindExistingLocal }
    struct RootConfiguration {
        struct Identity:Equatable {
            let provenance:String,origin:String
            let human:UUID,session:UUID,endpoint:UUID
            let maxBytes:Int,maxEvents:Int
            let storageOrigin:String,protectedFilePolicy:String
            static func ==(a:Self,b:Self)->Bool {
                a.provenance.utf8.elementsEqual(b.provenance.utf8) && a.origin.utf8.elementsEqual(b.origin.utf8) &&
                a.human==b.human && a.session==b.session && a.endpoint==b.endpoint && a.maxBytes==b.maxBytes && a.maxEvents==b.maxEvents &&
                a.storageOrigin.utf8.elementsEqual(b.storageOrigin.utf8) && a.protectedFilePolicy.utf8.elementsEqual(b.protectedFilePolicy.utf8)
            }
        }
        let identity:Identity
        let protectedAvailable:()->Bool
        let makeStorage:()throws->any HealthSnapshotStorage
        var provenance:String{identity.provenance};var origin:String{identity.origin}
        var human:UUID{identity.human};var session:UUID{identity.session};var endpoint:UUID{identity.endpoint}
        var maxBytes:Int{identity.maxBytes};var maxEvents:Int{identity.maxEvents}
        var valid:Bool {
            guard !identity.provenance.isEmpty,identity.provenance.utf8.count<=128,!identity.protectedFilePolicy.isEmpty,identity.protectedFilePolicy.utf8.count<=128,
                  maxBytes>0,maxBytes<=8*1024*1024,maxEvents>0,maxEvents<=100_000,
                  let url=URL(string:origin),url.scheme=="https",url.host != nil,url.user==nil,url.password==nil,url.query==nil,url.fragment==nil,url.path.isEmpty,url.absoluteString==origin,identity.storageOrigin==origin else{return false};return true
        }
    }
    struct Configuration {
        let provenance: String, origin: String
        let human: UUID, session: UUID, endpoint: UUID, enrollment: UUID
        let plans: [NativeHealthCollectionPlan]
        let maxBytes: Int, maxEvents: Int
        let storageOrigin: String, protectedFilePolicy: String
        let protectedAvailable: () -> Bool
        let makeStorage: () throws -> any HealthSnapshotStorage
        let makeSDK: () throws -> any NativeHealthSDK
        var rootConfiguration:RootConfiguration {.init(identity:.init(provenance:provenance,origin:origin,human:human,session:session,endpoint:endpoint,maxBytes:maxBytes,maxEvents:maxEvents,storageOrigin:storageOrigin,protectedFilePolicy:protectedFilePolicy),protectedAvailable:protectedAvailable,makeStorage:makeStorage)}
        func matches(_ other:Configuration)->Bool {
            provenance.utf8.elementsEqual(other.provenance.utf8) && origin.utf8.elementsEqual(other.origin.utf8) && human==other.human && session==other.session && endpoint==other.endpoint && enrollment==other.enrollment && plans==other.plans && maxBytes==other.maxBytes && maxEvents==other.maxEvents && storageOrigin.utf8.elementsEqual(other.storageOrigin.utf8) && protectedFilePolicy.utf8.elementsEqual(other.protectedFilePolicy.utf8)
        }
        var valid: Bool {
            guard !provenance.isEmpty,provenance.utf8.count<=128,!protectedFilePolicy.isEmpty,protectedFilePolicy.utf8.count<=128,
                  maxBytes>0,maxBytes<=8*1024*1024,maxEvents>0,maxEvents<=100_000,
                  !plans.isEmpty,plans.count<=HealthKitCollector.supportedCategories.count,plans.allSatisfy(\.valid),Set(plans.map(\.category)).count==plans.count,
                  let url=URL(string:origin),url.scheme=="https",url.host != nil,url.user==nil,url.password==nil,url.query==nil,url.fragment==nil,url.path.isEmpty,
                  url.absoluteString==origin,storageOrigin==origin else{return false}
            return true
        }
    }
    struct CalendarConfiguration {
        let configuration:NativeCalendarAcquisitionOwner.Configuration
        let custody:NativeSharedOutboxOwner.Custody?
        let makeAcquisition:((HealthOutbox)->MobileEventKitAcquisition?)?
        let captureClock:()->Date
    }
    struct CalendarSetup {
        let owner:AnyObject,currency:NativeCalendarAdmissionCurrency?
        let selectedCategories:Set<String>
    }
    struct CalendarSetupResult {
        enum Persistence:String{case notApplied,saved,unconfirmed}
        enum Availability:String{case unavailable,available}
        let attempt:UUID?,persistence:Persistence,availability:Availability
        var response:[String:Any]{["attemptId":attempt?.uuidString.lowercased() as Any? ?? NSNull(),"persistence":persistence.rawValue,"availability":availability.rawValue]}
        static var unavailable:Self{.init(attempt:nil,persistence:.notApplied,availability:.unavailable)}
    }
    struct CalendarReconnect {
        let owner:AnyObject,currency:NativeCalendarAdmissionCurrency?
        let expectedSavedCategories:Set<String>
    }
    struct CalendarReconnectResult {
        enum Outcome:String{case reconnected,notApplied}
        let attempt:UUID?,outcome:Outcome,availability:CalendarSetupResult.Availability
        var response:[String:Any]{["operation":"reconnect","attemptId":attempt?.uuidString.lowercased() as Any? ?? NSNull(),"outcome":outcome.rawValue,"snapshotWrite":"notRequested","availability":availability.rawValue]}
        static var unavailable:Self{.init(attempt:nil,outcome:.notApplied,availability:.unavailable)}
    }
    private final class AdmissionRun {
        private enum Completion {case setup((CalendarSetupResult)->Void),reconnect((CalendarReconnectResult)->Void)}
        private enum Observation {case setup(CalendarSetupResult),reconnect(CalendarReconnectResult)}
        let attempt=UUID(),kind:NativeCalendarControlKind,owner:AnyObject,currency:NativeCalendarAdmissionCurrency?,categories:Set<String>
        let selector:Data,source:NativeCalendarAcquisitionOwner.Configuration,identity:RootConfiguration.Identity,epoch:Int
        var reader:NativeCalendarAdmission?,lease:NativeSharedOutboxOwner.CalendarLease?,cancelled=false
        private var completion:Completion?,observation:Observation?
        var result:CalendarSetupResult?{if case .setup(let value)=observation{return value};return nil}
        init(selector:String,source:NativeCalendarAcquisitionOwner.Configuration,identity:RootConfiguration.Identity,epoch:Int,setup:CalendarSetup,kind:NativeCalendarControlKind = .setupExistingRemote,completion:@escaping(CalendarSetupResult)->Void){self.selector=Data(selector.utf8);self.source=source;self.identity=identity;self.epoch=epoch;self.kind=kind;owner=setup.owner;currency=setup.currency;categories=setup.selectedCategories;self.completion = .setup(completion)}
        init(selector:String,source:NativeCalendarAcquisitionOwner.Configuration,identity:RootConfiguration.Identity,epoch:Int,reconnect:CalendarReconnect,completion:@escaping(CalendarReconnectResult)->Void){self.selector=Data(selector.utf8);self.source=source;self.identity=identity;self.epoch=epoch;kind = .reconnectExistingLocal;owner=reconnect.owner;currency=reconnect.currency;categories=reconnect.expectedSavedCategories;self.completion = .reconnect(completion)}
        func report(_ result:CalendarSetupResult){guard case .setup(let done)=completion else{return};observation = .setup(result);completion=nil;done(result)}
        func reportReconnect(_ result:CalendarReconnectResult){guard case .reconnect(let done)=completion else{return};observation = .reconnect(result);completion=nil;done(result)}
    }
    private var admissionRun:AdmissionRun?
    /// Historical exact intent only. A held write is not a writable-root grant.
    /// Do not invoke providers/protection/custody or require a live currency here.
    func calendarAdmissionObservation(selector:String)->CalendarSetupResult?{
        guard calendarReadPermissionRun==nil,permissionRun==nil,permissionReservation==nil else{return nil}
        guard !selector.isEmpty,selector.utf8.count<=128,!authorityWithdrawn,let run=admissionRun,run.kind == .setupExistingRemote,
              run.selector==Data(selector.utf8),run.identity==rootConfiguration.identity,transport.epoch==run.epoch,
              let origin=transport.endpoint,Data(origin.absoluteString.utf8)==Data(run.identity.origin.utf8),
              transport.effectiveIsSelf,let owner=transport.currentEffectiveOwner,
              UUID(uuidString:owner.principal)==run.identity.human,UUID(uuidString:owner.session)==run.identity.session,
              let result=run.result,result.persistence == .unconfirmed else{return nil}
        return result
    }
    var hasAdmission:Bool{observationOperations>0 || observationLocal != nil || nativeCommandRun != nil || calendarReadPermissionRun != nil || permissionReservation != nil || permissionRun != nil || admissionRun != nil || root.admitting || root.inStorage}
    private final class CalendarRun {
        var owner:NativeCalendarAcquisitionOwner?,cancelled=false
        var completion:((NativeCalendarAcquisitionOwner.DeliveryOutcome)->Void)?
        init(_ done:@escaping(NativeCalendarAcquisitionOwner.DeliveryOutcome)->Void){completion=done}
        func report(_ result:NativeCalendarAcquisitionOwner.DeliveryOutcome){let done=completion;completion=nil;done?(result)}
    }
    private var calendarRun:CalendarRun?,calendarDrainRequest:(()->Void)?,calendarDrainChecking=false
    private struct Context: Equatable {let epoch:Int,revision:Int,generation:Int,endpointRevision:Int;let subject:Data}
    private let outbox:HealthOutbox
    private var collector:HealthKitCollector?,sessionOwner:NativeHealthSessionOwner?
    private var retainedHealthSDK:(any NativeHealthSDK)?
    private let root:NativeSharedOutboxOwner
    private(set) var configuration:Configuration?
    let rootConfiguration:RootConfiguration
    private let transport:NativeTransport
    private final class PermissionRun {
        let action:NativeHealthChoiceAction,root:NativeSharedOutboxOwner,generation:UInt64,epoch:Int
        var finishing=false,cancelled=false
        init(action:NativeHealthChoiceAction,root:NativeSharedOutboxOwner,epoch:Int){self.action=action;self.root=root;generation=root.healthGeneration;self.epoch=epoch}
    }
    private var permissionRun:PermissionRun?,permissionReservation:PermissionRun?
    private var calendarReadPermissionRun:CalendarReadPermissionRun?
    private var nativeCommandRun:NativeCommandRun?
    private var lastCalendarReconnectProof:(configuration:NativeCalendarAcquisitionOwner.Configuration,categories:Set<String>,proof:MobileCalendarPolicyProof)?
    private var ready=false,retired=false,settingUp=false,adopted=false,authorityWithdrawn=false
    private var pending=0,drainScheduled=false
    private var setupTask:URLSessionDataTask?
    private var waiters:[()->Void]=[]
    private struct KnownLocalBinding {let namespace:UUID;let origin:Data;let human:UUID,session:UUID,enrollment:UUID,endpoint:UUID}
    private var knownLocalBinding:KnownLocalBinding?
    private final class ResumeObservation {
        let request:NativeHealthResumeRequest
        var pending=true,outcome="notApplied",reason="busy"
        var binding:[String:Any]?
        var tickets:[HealthCollectionTicket]=[]
        init(_ request:NativeHealthResumeRequest){self.request=request}
        func response()->[String:Any]{NativeHealthResumeResponse.make(id:request.operationId,binding:binding,outcome:outcome,reason:reason)}
    }
    private final class PauseOperation {
        let request:NativeHealthPauseRequest
        var persistence="unconfirmed",reason="storage_unconfirmed"
        var collectorDrained=false,sessionDrained=false,drained=false,superseded=false,resumeInFlight=false,resumeUnconfirmed=false,firstPending=false,observingDrain=false
        var resumeObservation:ResumeObservation?
        init(_ request:NativeHealthPauseRequest){self.request=request}
    }
    private var pauseOperation:PauseOperation?
    private var operationGeneration=0
    private final class ObservationInterest {
        let configuration:Configuration,namespace:UUID,revision:Int,current:()->Bool
        var armed=Set<String>(),catchup=Set<String>(),opportunity=Set<String>(),delivery=Set<String>()
        var renewRequested=true,renewing=false,proofReady=false,unsupported=false
        init(_ c:Configuration,_ n:UUID,_ revision:Int,_ current:@escaping()->Bool){configuration=c;namespace=n;self.revision=revision;self.current=current}
    }
    private final class ObservationLocal {
        let interest:ObservationInterest,plan:NativeHealthCollectionPlan,finishSDK:()->Void
        var notificationFinished=false,reported=false,committed=false,changeCount=0
        var allowExistingQueue=false
        var stopFence:UInt64?
        init(_ i:ObservationInterest,_ p:NativeHealthCollectionPlan,_ done:@escaping()->Void){interest=i;plan=p;finishSDK=done}
        func finishNotification(){guard !notificationFinished else{return};notificationFinished=true;finishSDK()}
    }
    private var observationInterest:ObservationInterest?,observationLocal:ObservationLocal?
    private var observationOperations=0,observationPumpQueued=false
    private(set) var savedHealthSelection:HealthOutbox.SavedHealthSelection?
    private var savedRememberInFlight=false,savedRememberCancelled=false,savedProtectionPending=false,savedProtectionUnconfirmed=false
    private var savedDesiredDisable=false,savedDesiredRebind=false,savedRetirementPublished=false,savedResourcesTaken=false
    private var savedStopFence:UInt64?
    private final class BackgroundCategory {
        let category:String
        var desired=false,known:Bool?,inFlight:Bool?,lastAttempt:Int = -1
        init(_ category:String){self.category=category}
    }
    private var backgroundCategories:[String:BackgroundCategory]=[:]
    private var backgroundOpportunity=0,backgroundForeground=true,backgroundInactive=false
    private var backgroundOptOutRequested=false,backgroundPreferencePending=false,backgroundPreferenceUnconfirmed=false
    private var backgroundEnabling=false,backgroundEnableCancelled=false

    // Temporary IO/custody/publication gates do not revoke this live configured
    // owner. Its ORIGINAL foreground entry still enforces all admission guards.
    var canContinueSavedHealthForeground:Bool{ready && adopted && retainedHealthSDK != nil && !savedProtectionUnconfirmed && !preservesPauseHold}
    var savedSelectionPersistence:String{savedProtectionUnconfirmed ? "unconfirmed":savedProtectionPending || savedRememberInFlight ? "pending":savedHealthSelection.map{$0.requiresRebind ? "requiresRebind":$0.updatesEnabled ? "savedEnabled":"savedDisabled"} ?? "notLoaded"}

    private var independentHealthPauseHold:Bool{if savedProtectionUnconfirmed{return true};if root.unresolved{return true};if let p=pauseOperation{return p.firstPending || p.persistence=="unconfirmed" || !p.drained || p.resumeUnconfirmed};return false}
    var preservesPauseHold:Bool {if savedProtectionUnconfirmed{return true};if nativeCommandRun?.held==true{return true};if root.unresolved{return true};if let p=pauseOperation{return p.firstPending || p.persistence=="unconfirmed" || !p.drained || p.resumeUnconfirmed};return false}

    var mayHaveMore:Bool {collector?.mayHaveMore ?? false}
    static func make(configuration:Configuration?,transport:NativeTransport)throws->NativeHealthRuntime {
        guard let c=configuration,c.valid else{throw Failure.unavailable}
        let runtime=try makeRoot(configuration:c.rootConfiguration,transport:transport)
        runtime.configuration=c;return runtime
    }
    static func makeRoot(configuration c:RootConfiguration,transport:NativeTransport)throws->NativeHealthRuntime {
        guard c.valid,c.protectedAvailable(),transport.endpoint?.absoluteString==c.origin,transport.effectiveIsSelf,let owner=transport.currentEffectiveOwner,UUID(uuidString:owner.principal)==c.human,UUID(uuidString:owner.session)==c.session else{throw Failure.unavailable}
        let root=NativeSharedOutboxOwner(storage:try c.makeStorage(),binding:.init(origin:c.origin,human:c.human,session:c.session,endpoint:c.endpoint),transport:transport,maxBytes:c.maxBytes,maxEvents:c.maxEvents)
        return NativeHealthRuntime(configuration:c,transport:transport,root:root)
    }
    private init(configuration:RootConfiguration,transport:NativeTransport,root:NativeSharedOutboxOwner) {
        rootConfiguration=configuration;self.transport=transport;self.root=root;outbox=root.box
        root.changed={[weak self] in self?.finishSavedStopFence();self?.publishDrain()}
    }
    /// Read-only original-file preflight. A cold durable command remains held;
    /// parsed paths or an apparently idle new Runtime cannot discard its owner.
    func prepareExistingHealthProfile(current fresh:()->Bool)throws {
        guard configuration==nil,choiceAdmissionAvailable,choiceSourceCurrent,fresh() else{throw Failure.unavailable}
        let c=rootConfiguration
        try root.observe {
            guard try outbox.calendarNativeCommandForReconciliation(origin:c.origin,principal:c.human,endpoint:c.endpoint)==nil else{throw Failure.unavailable}
            _ = try outbox.calendarNativeLastTerminalForReconciliation(origin:c.origin,principal:c.human,endpoint:c.endpoint)
            _ = try outbox.calendarSourceConsentLastOriginal(origin:c.origin,principal:c.human,endpoint:c.endpoint)
            _ = try outbox.healthSourceConsentLastOriginal(origin:c.origin,principal:c.human,endpoint:c.endpoint)
            _ = try outbox.healthControlLastOriginal(origin:c.origin,principal:c.human,endpoint:c.endpoint)
        }
        guard fresh(),configuration==nil,choiceAdmissionAvailable,choiceSourceCurrent else{throw Failure.stale}
    }
    func readExistingHealthProfilePolicy(enrollment:UUID,completion:@escaping(Result<MobileHealthPolicyProof,Error>)->Void){
        guard configuration==nil,choiceAdmissionAvailable,choiceSourceCurrent else{completion(.failure(Failure.unavailable));return}
        NativeHealthPolicy(transport:transport,outbox:outbox,collector:self).readForControl(enrollment:enrollment,expectedEndpoint:rootConfiguration.endpoint,completion:completion)
    }
    func attachHealth(_ c:Configuration)throws {
        guard calendarReadPermissionRun==nil,permissionRun==nil,permissionReservation==nil,c.valid,c.rootConfiguration.identity==rootConfiguration.identity,configuration.map({$0.matches(c)}) ?? true else{throw Failure.stale}
        configuration=c
    }
    func suspendForPolicyRefresh(enrollment:UUID){
        if root.inStorage{
            root.fenceHealth()
            root.afterFrame(.healthSavedPolicyInvalidation){[self] in if let collector{collector.suspendForPolicyRefresh(enrollment:enrollment)}else{outbox.invalidatePolicy(enrollment:enrollment)}}
            return
        }
        if let i=observationInterest{i.armed.removeAll();i.proofReady=false;if !i.renewing{i.renewRequested=true}}
        if let collector{collector.suspendForPolicyRefresh(enrollment:enrollment)}else{outbox.invalidatePolicy(enrollment:enrollment)}
    }
    private func constructHealth(_ configuration:Configuration,sdk:any NativeHealthSDK){
        // A new configured collector must not inherit disabled history from a
        // completed metadata-only cleanup. Never forget pending/unknown effects.
        if backgroundRetirementReady{backgroundCategories.removeAll()}
        retainedHealthSDK=sdk
        let collector=HealthKitCollector(outbox:outbox,sdk:sdk);self.collector=collector
        // SessionOwner also refreshes policy directly through its SAME collector.
        // Weak notification preserves one owner and avoids a Runtime/session cycle.
        collector.backgroundChanged={[weak self] in self?.pumpBackgroundControls();self?.publishDrain()}
        collector.observationWillStop={[weak self] in
            self?.stopBackgroundEffects();guard let i=self?.observationInterest else{return};i.armed.removeAll();i.proofReady=false;if !i.renewing{i.renewRequested=true}
        }
        let root=self.root
        let hooks=NativeHealthSessionOwner.CollectorHooks(policySuspender:collector,collect:{ticket,done in
            let generation=root.healthGeneration
            guard root.healthIOCurrent,let plan=configuration.plans.first(where:{$0.category==ticket.category}) else{done(.failure(Failure.invalid));return}
            collector.collect(ticket:ticket,plan:plan){result in
                guard root.healthIOCurrent,generation==root.healthGeneration else{done(.failure(Failure.stale));return}
                switch result{case .committed:done(.success(()));default:done(.failure(Failure.unavailable))}
            }
        },stop:{collector.stop()},whenDrained:{collector.whenDrained($0)})
        sessionOwner=NativeHealthSessionOwner(transport:transport,outbox:outbox,collector:hooks)
    }
    private func collectorDrained(_ done:@escaping()->Void){if let collector{collector.whenDrained(done)}else{done()}}
    private func sessionDrained(_ done:@escaping()->Void){if let sessionOwner{sessionOwner.whenDrained(done)}else{done()}}
    private func capturedTransportCurrent()->Bool {
        guard !retired,transport.endpoint?.absoluteString==rootConfiguration.origin,transport.effectiveIsSelf,let owner=transport.currentEffectiveOwner else{return false}
        return UUID(uuidString:owner.principal)==rootConfiguration.human && UUID(uuidString:owner.session)==rootConfiguration.session
    }
    private func current()->Bool {
        !retired && root.available && !root.admitting && !root.inStorage && rootConfiguration.protectedAvailable() && capturedTransportCurrent() && root.available && !root.inStorage
    }
    private func begin(){pending+=1}
    private func end(){pending-=1;updatePauseDrain();pumpCalendarDrain();publishDrain()}
    private func updatePauseDrain(){
        guard let p=pauseOperation else{return}
        if !p.drained && p.collectorDrained && p.sessionDrained && pending==0 && !settingUp && backgroundRetirementReady {p.drained=true;publishDrain()}
    }
    private func publishDrain(){
        // Registration callbacks and preference publication are full-owner work.
        // The one-way drained flag bounds the nested publication to one revisit.
        updatePauseDrain()
        queueObservationPump()
        publishConfiguredSettingsDrain()
        guard backgroundRetirementReady,retired,!savedProtectionPending,!savedProtectionUnconfirmed,nativeCommandRun==nil,calendarReadPermissionRun==nil,permissionReservation==nil,admissionRun==nil,pending==0,!settingUp,!root.busy,calendarRun==nil,!drainScheduled,!preservesPauseHold else{return};drainScheduled=true
        collectorDrained{[self] in sessionDrained{[self] in
            drainScheduled=false;guard backgroundRetirementReady,retired,!savedProtectionPending,!savedProtectionUnconfirmed,nativeCommandRun==nil,calendarReadPermissionRun==nil,permissionReservation==nil,admissionRun==nil,pending==0,!settingUp,!root.busy,calendarRun==nil,!preservesPauseHold else{return}
            let callbacks=waiters;waiters.removeAll();callbacks.forEach{$0()}
        }}
    }
    /// One configured child retires while the ORIGINAL nonrevoked Root/file/SDK
    /// remains owned here. Full Runtime.retire is never an unretire mechanism.
    final class ConfiguredHealthSettings {
        let id=UUID(),configuration:Configuration,initial:HealthOutbox.HealthConfiguredLocalState
        let current:()->Bool,published:()->Void
        var collectorDrained=false,sessionDrained=false,publishing=false,ready=false,returned=false
        init(_ configuration:Configuration,_ initial:HealthOutbox.HealthConfiguredLocalState,_ current:@escaping()->Bool,_ published:@escaping()->Void){self.configuration=configuration;self.initial=initial;self.current=current;self.published=published}
    }
    private(set) var configuredHealthSettings:ConfiguredHealthSettings?
    var configuredSettingsReady:Bool{configuredHealthSettings?.ready==true && configuredHealthSettings?.returned==false && configuration==nil && choiceSourceCurrent && !root.unresolved}
    var configuredSettingsState:String{if configuredSettingsReady{return "settings"};return configuredHealthSettings==nil ? "unavailable":"retiring"}
    func configuredSettingsPreflight(current fresh:()->Bool)->Bool{
        guard fresh(),!retired,root.available,!root.unresolved,!root.inStorage,!preservesPauseHold,nativeCommandRun==nil,calendarRun==nil,admissionRun==nil,calendarReadPermissionRun==nil,
              let configuration,let known=knownLocalBinding,known.enrollment==configuration.enrollment,retainedHealthSDK != nil else{return false}
        let binding=HealthOutbox.CalendarNativeBinding(origin:rootConfiguration.origin,principal:rootConfiguration.human,session:rootConfiguration.session,endpoint:rootConfiguration.endpoint)
        do{let local=try root.observe{try outbox.healthConfiguredLocalState(binding:binding,enrollment:known.enrollment,namespace:known.namespace)};return !local.requiresRebind && local.types==Set(configuration.plans.map(\.category)) && fresh() && choiceSourceCurrent}catch{return false}
    }
    func beginConfiguredHealthSettings(current fresh:@escaping()->Bool,published:@escaping()->Void)->Bool {
        precondition(Thread.isMainThread)
        if let existing=configuredHealthSettings{if !existing.returned{return true};configuredHealthSettings=nil}
        guard fresh(),!retired,root.available,!root.unresolved,!root.inStorage,!preservesPauseHold,nativeCommandRun==nil,
              calendarRun==nil,admissionRun==nil,calendarReadPermissionRun==nil,let configuration,let known=knownLocalBinding,
              known.enrollment==configuration.enrollment,retainedHealthSDK != nil else{return false}
        let binding=HealthOutbox.CalendarNativeBinding(origin:rootConfiguration.origin,principal:rootConfiguration.human,session:rootConfiguration.session,endpoint:rootConfiguration.endpoint)
        let local:HealthOutbox.HealthConfiguredLocalState
        do{local=try root.observe{try outbox.healthConfiguredLocalState(binding:binding,enrollment:known.enrollment,namespace:known.namespace)}}catch{return false}
        guard fresh(),!local.requiresRebind,local.types==Set(configuration.plans.map(\.category)),choiceSourceCurrent else{return false}
        let transition=ConfiguredHealthSettings(configuration,local,fresh,published);configuredHealthSettings=transition
        observationInterest=nil;stopBackgroundEffects()
        if let saved=savedHealthSelection,saved.backgroundChoice != nil{disableBackgroundChoice(saved)}
        ready=false;operationGeneration &+= 1;root.fenceHealth();permissionRun?.cancelled=true;permissionReservation?.cancelled=true
        root.afterFrame(.healthConfigurationRetirement){[self] in
            guard configuredHealthSettings === transition,!retired,root.available,!root.unresolved else{return}
            outbox.invalidatePolicy(enrollment:configuration.enrollment);collector?.stop();sessionOwner?.cancel();setupTask?.cancel()
            collectorDrained{[self] in transition.collectorDrained=true;publishConfiguredSettingsDrain()}
            sessionDrained{[self] in transition.sessionDrained=true;publishConfiguredSettingsDrain()}
            publishConfiguredSettingsDrain()
        }
        return true
    }
    func holdConfiguredSettings(){
        // Revoked profile/currency never leaves old collection running after a
        // refused extensible preflight. No generation is published as retired.
        ready=false;root.fenceHealth()
        root.afterFrame(.healthConfigurationRetirement){[self] in collector?.stop();sessionOwner?.cancel();setupTask?.cancel()}
    }
    private func publishConfiguredSettingsDrain(){
        guard let value=configuredHealthSettings,!value.ready,!value.returned,!value.publishing,
              backgroundRetirementReady,value.collectorDrained,value.sessionDrained,pending==0,!settingUp,permissionRun==nil,permissionReservation==nil,
              nativeCommandRun==nil,calendarReadPermissionRun==nil,calendarRun==nil,admissionRun==nil,!root.busy,!root.inStorage,!root.unresolved,
              !preservesPauseHold,!retired,root.available,value.current() else{return}
        value.publishing=true
        // Follows the FULL original SDK/session/custody callback return, then the
        // original owner publication frame. An entered/never callback stays held.
        DispatchQueue.main.async{[self] in
            guard backgroundRetirementReady,configuredHealthSettings === value,!value.ready,!retired,root.available,!root.unresolved,
                  pending==0,!settingUp,permissionRun==nil,permissionReservation==nil,nativeCommandRun==nil,
                  calendarReadPermissionRun==nil,calendarRun==nil,admissionRun==nil,!root.busy,!root.inStorage,!preservesPauseHold,value.current() else{value.publishing=false;return}
            // All original per-type effects are confirmed disabled and their
            // callbacks/publication have drained. The retired scope can now go.
            backgroundCategories.removeAll()
            collector=nil;sessionOwner=nil;configuration=nil;value.ready=true;value.publishing=false
            DispatchQueue.main.async{[self] in guard configuredHealthSettings === value,value.ready,!retired,root.available,value.current() else{return};value.published()}
        }
    }
    func configuredLocalReview()throws->(HealthOutbox.HealthConfiguredLocalState,MobileOrdinaryControl.Terminal,Configuration){
        guard configuredSettingsReady,choiceAdmissionAvailable,let transition=configuredHealthSettings else{throw Failure.unavailable}
        let binding=HealthOutbox.CalendarNativeBinding(origin:rootConfiguration.origin,principal:rootConfiguration.human,session:rootConfiguration.session,endpoint:rootConfiguration.endpoint)
        return try root.observe{
            let local=try outbox.healthConfiguredLocalState(binding:binding,enrollment:transition.initial.enrollment,namespace:transition.initial.namespace)
            guard !local.requiresRebind,let terminal=try outbox.healthControlLastTerminal(binding:binding) else{throw Failure.unavailable}
            let configured=try MobileOrdinaryControl.healthConfiguration(terminal)
            guard configured.enrollment==local.enrollment,configured.namespace==local.namespace else{throw Failure.sourceMismatch}
            return (local,terminal,transition.configuration)
        }
    }
    func finishConfiguredLocalReturn(_ supplied:Configuration,local:HealthOutbox.HealthConfiguredLocalState,current fresh:()->Bool)throws {
        guard fresh(),configuredSettingsReady,choiceAdmissionAvailable,let transition=configuredHealthSettings,
              supplied.rootConfiguration.identity==rootConfiguration.identity,supplied.enrollment==transition.initial.enrollment,
              Set(supplied.plans.map(\.category))==local.types,!local.requiresRebind,let sdk=retainedHealthSDK else{throw Failure.unavailable}
        guard fresh(),root.available,!root.busy,!root.inStorage else{throw Failure.stale}
        configuration=supplied;constructHealth(supplied,sdk:sdk);adopted=true
        knownLocalBinding=KnownLocalBinding(namespace:local.namespace,origin:Data(rootConfiguration.origin.utf8),human:local.principal,session:rootConfiguration.session,enrollment:local.enrollment,endpoint:local.endpoint)
        if !local.paused{try root.resumeHealth()}
        ready = !local.paused;transition.returned=true
    }
    func configuredReturnConfiguration(plans:[NativeHealthCollectionPlan])throws->Configuration{
        guard configuredSettingsReady,let old=configuredHealthSettings?.configuration,let sdk=retainedHealthSDK else{throw Failure.unavailable}
        return .init(provenance:old.provenance,origin:old.origin,human:old.human,session:old.session,endpoint:old.endpoint,enrollment:old.enrollment,plans:plans,maxBytes:old.maxBytes,maxEvents:old.maxEvents,storageOrigin:old.storageOrigin,protectedFilePolicy:old.protectedFilePolicy,protectedAvailable:old.protectedAvailable,makeStorage:old.makeStorage,makeSDK:{sdk})
    }
    var configuredSettingsOriginalPlans:[NativeHealthCollectionPlan]?{configuredHealthSettings?.configuration.plans}
    var configuredSettingsPauseInput:[String:Any]?{
        guard let local=knownLocalBinding,let pause=pauseOperation,pause.persistence=="savedPaused",pause.drained,!pause.resumeUnconfirmed,!pause.firstPending,!pause.superseded else{return nil}
        return ["schemaVersion":"1.0.0","operationId":UUID().uuidString.lowercased(),"expectedPauseOperationId":pause.request.operationId.uuidString.lowercased(),"sourceNamespace":local.namespace.uuidString.lowercased(),"enrollmentId":local.enrollment.uuidString.lowercased(),"endpointId":local.endpoint.uuidString.lowercased()]
    }
    func withdrawAuthority(){
        precondition(Thread.isMainThread);cancelCalendarReadPermission()
        guard !authorityWithdrawn else{return};authorityWithdrawn=true
        root.revoke()
        root.afterFrame(.authority){[self] in try? outbox.setHuman(nil)}
    }
    func retire(authorityChanged:Bool,completion:@escaping()->Void){
        precondition(Thread.isMainThread);observationInterest=nil;stopBackgroundEffects();cancelNativeCommand();cancelCalendarReadPermission();waiters.append(completion);retired=true;ready=false;permissionRun?.cancelled=true;permissionReservation?.cancelled=true
        root.revoke();calendarRun?.cancelled=true;admissionRun?.cancelled=true;admissionRun?.currency?.revoke();admissionRun?.reader?.cancel()
        root.afterFrame(.retirement){[self] in
            calendarRun?.owner?.cancel()
            if let configuration{outbox.invalidatePolicy(enrollment:configuration.enrollment)}
            collector?.stop();sessionOwner?.cancel();setupTask?.cancel()
            if authorityChanged{withdrawAuthority()}
            publishDrain()
        }
    }
    private func snapshot(_ done:@escaping(Result<Context,Error>)->Void){
        guard current() else{done(.failure(Failure.stale));return}
        let epoch=transport.epoch
        begin()
        setupTask=transport.request("/api/auth/v1/user-context",maxBytes:65536){[self] response in
            defer{end()}
            guard current(),transport.epoch==epoch,case .success(let(data,http))=response,http.statusCode==200,
                  let value=try? JSONSerialization.jsonObject(with:data) as? [String:Any],
                  let subject=value["context"] as? [String:Any],let actor=value["actor"] as? [String:Any],let effective=value["effectiveUser"] as? [String:Any],
                  let pin=value["producerPin"] as? [String:String],pin==["schemaId":"https://lifestream.dev/contracts/effective-subject/1.0.0","schemaVersion":"1.0.0","digest":"ed098cad970a310a807881ea7a833b96f1c980e8377ee3cfcbdffd68f2bd0cf9"],
                  let impersonating=value["impersonating"] as? NSNumber,CFGetTypeID(impersonating)==CFBooleanGetTypeID(),!impersonating.boolValue,
                  Set(subject.keys)==Set(["schemaVersion","actorId","effectiveUserId","authenticatedSessionId","installationId","authorityRevision","generation","issuedAt"]),subject["schemaVersion"] as? String=="1.0.0",UUID(uuidString:subject["installationId"] as? String ?? "") != nil,
                  let authority=subject["authorityRevision"] as? NSNumber,CFGetTypeID(authority) != CFBooleanGetTypeID(),authority.doubleValue.isFinite,authority.doubleValue.rounded()==authority.doubleValue,authority.doubleValue>=0,authority.doubleValue<=9007199254740991,
                  let generation=subject["generation"] as? NSNumber,CFGetTypeID(generation) != CFBooleanGetTypeID(),generation.doubleValue.isFinite,generation.doubleValue.rounded()==generation.doubleValue,generation.doubleValue>=0,generation.doubleValue<=9007199254740991,
                  let issued=subject["issuedAt"] as? String,issued.hasSuffix("Z"),UUID(uuidString:actor["principalId"] as? String ?? "")==rootConfiguration.human,UUID(uuidString:effective["principalId"] as? String ?? "")==rootConfiguration.human,
                  UUID(uuidString:subject["actorId"] as? String ?? "")==rootConfiguration.human,UUID(uuidString:subject["effectiveUserId"] as? String ?? "")==rootConfiguration.human,UUID(uuidString:subject["authenticatedSessionId"] as? String ?? "")==rootConfiguration.session,
                  let canonical=try? JSONSerialization.data(withJSONObject:subject,options:[.sortedKeys,.withoutEscapingSlashes]) else{done(.failure(Failure.stale));return}
            let formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
            if formatter.date(from:issued)==nil {formatter.formatOptions=[.withInternetDateTime];guard formatter.date(from:issued) != nil else{done(.failure(Failure.stale));return}}
            begin()
            setupTask=transport.request("/api/runtime/v1/session-context",maxBytes:65536){[self] response in
                defer{end()}
                func number(_ value:Any?)->Int?{guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue.rounded()==n.doubleValue,n.doubleValue>=0,n.doubleValue<=9007199254740991 else{return nil};return n.intValue}
                guard current(),transport.epoch==epoch,case .success(let(data,http))=response,http.statusCode==200,let value=try? JSONSerialization.jsonObject(with:data) as? [String:Any],let ended=value["ended"] as? NSNumber,CFGetTypeID(ended)==CFBooleanGetTypeID(),!ended.boolValue,
                      let revision=number(value["revision"]),let generation=number(value["contextGeneration"]),let endpoint=value["endpoint"] as? [String:Any],UUID(uuidString:endpoint["endpointId"] as? String ?? "")==rootConfiguration.endpoint,endpoint["privacyClass"] as? String=="personal",let endpointRevision=number(endpoint["configurationRevision"]) else{done(.failure(Failure.stale));return}
                done(.success(Context(epoch:epoch,revision:revision,generation:generation,endpointRevision:endpointRevision,subject:canonical)))
            }
        }
    }
    func setup(_ action:LocalSetup,expectedSourceNamespace:UUID?=nil,completion:@escaping(Result<Void,Error>)->Void){
        precondition(Thread.isMainThread)
        guard observationOperations==0,observationLocal==nil,calendarReadPermissionRun==nil,permissionRun==nil,permissionReservation==nil else{completion(.failure(Failure.busy));return}
        if action == .resumeExistingLocal,let p=pauseOperation,p.persistence=="savedPaused",p.drained,!p.resumeUnconfirmed,!p.firstPending {try? root.resumeHealth()}
        guard root.healthAdmission,current(),root.healthAdmission,!settingUp,!(sessionOwner?.busy ?? false) else{completion(.failure(Failure.unavailable));return}
        guard let configuration else{completion(.failure(Failure.unavailable));return}
        let acceptedPause=pauseOperation
        if let p=acceptedPause, p.resumeUnconfirmed || (!p.superseded && !(action == .resumeExistingLocal && p.persistence=="savedPaused" && p.drained)) {completion(.failure(Failure.unavailable));return}
        let started=operationGeneration
        func samePause()->Bool {if let p=acceptedPause{return pauseOperation === p};return pauseOperation==nil}
        func setupCurrent()->Bool{
            guard started==operationGeneration,samePause(),current() else{return false}
            return started==operationGeneration && samePause()
        }
        if action == .resumeExistingLocal {acceptedPause?.resumeInFlight=true}
        settingUp=true;ready=false
        func finish(_ result:Result<Void,Error>){acceptedPause?.resumeInFlight=false;settingUp=false;completion(result);updatePauseDrain();pumpCalendarDrain();publishDrain()}
        snapshot{[self] first in
            guard case .success(let initial)=first,setupCurrent() else{finish(.failure(Failure.stale));return}
            begin()
            let policy=NativeHealthPolicy(transport:transport,outbox:outbox,collector:self)
            policy.readForControl(enrollment:configuration.enrollment,expectedEndpoint:rootConfiguration.endpoint){[self] result in
                defer{end()}
                guard setupCurrent(),case .success(let proof)=result,proof.permitsCollection else{finish(.failure(Failure.stale));return}
                snapshot{[self] second in
                    guard setupCurrent(),case .success(let final)=second,initial==final else{finish(.failure(Failure.stale));return}
                    do {
                        if let expectedSourceNamespace{guard proof.sourceNamespace.flatMap(UUID.init(uuidString:))==expectedSourceNamespace else{throw Failure.sourceMismatch}}
                        let selected=Set(configuration.plans.map(\.category));guard selected.isSubset(of:proof.healthKitTypes) else{throw Failure.invalid}
                        if action == .confirmExistingLocal {
                            if !adopted {try outbox.setHuman(rootConfiguration.human);adopted=true}
                            let saved=try outbox.status(enrollment:configuration.enrollment)
                            guard !saved.paused,!saved.requiresRebind,!saved.localChangePending,setupCurrent() else{throw Failure.unavailable}
                        }
                        if collector == nil {
                            let sdk=try configuration.makeSDK()
                            guard setupCurrent() else{throw Failure.stale}
                            constructHealth(configuration,sdk:sdk)
                        }
                        if !adopted {try outbox.setHuman(rootConfiguration.human);adopted=true}
                        switch action {
                        case .enrollExistingRemote:try outbox.enroll(proof:proof,selectedTypes:selected)
                        case .confirmExistingLocal:
                            let state=try outbox.status(enrollment:configuration.enrollment);guard !state.paused,!state.requiresRebind,!state.localChangePending else{throw Failure.unavailable}
                            try outbox.narrow(enrollment:configuration.enrollment,types:selected)
                        case .resumeExistingLocal:
                            // This explicit opposing action ends the old current-pause observation.
                            // Keep its ID as a bounded tombstone; never replay its write.
                            if let observation=acceptedPause?.resumeObservation,observation.pending {
                                guard UUID(uuidString:proof.sourceNamespace ?? "")==observation.request.sourceNamespace else{throw Failure.sourceMismatch}
                                observation.binding=["sourceNamespace":proof.sourceNamespace!,"enrollmentId":proof.enrollment.uuidString.lowercased(),"endpointId":proof.endpoint.uuidString.lowercased(),"policyRevision":proof.revision]
                            }
                            acceptedPause?.superseded=true;acceptedPause?.resumeUnconfirmed=true
                            try outbox.resume(proof:proof,selectedTypes:selected)
                        case .rebindExistingLocal:
                            try outbox.confirmSourceOwner(proof:proof,explicitOwnerDecision:true)
                            try outbox.narrow(enrollment:configuration.enrollment,types:selected)
                        }
                        let state=try outbox.status(enrollment:configuration.enrollment)
                        guard setupCurrent(),let rawNamespace=proof.sourceNamespace,let namespace=UUID(uuidString:rawNamespace) else{throw Failure.stale}
                        knownLocalBinding=KnownLocalBinding(namespace:namespace,origin:Data(rootConfiguration.origin.utf8),human:rootConfiguration.human,session:rootConfiguration.session,enrollment:configuration.enrollment,endpoint:rootConfiguration.endpoint)
                        ready = !state.paused && !state.requiresRebind
                        if action == .resumeExistingLocal {acceptedPause?.resumeUnconfirmed=false}
                        finish(.success(()))
                    }catch{finish(.failure(error))}
                }
            }
        }
    }
    func sync(category:String,completion:@escaping(Result<HealthSyncCoordinator.Completion,Error>)->Void){
        precondition(Thread.isMainThread)
        guard observationOperations==0,observationLocal==nil,calendarReadPermissionRun==nil,permissionRun==nil,permissionReservation==nil,let configuration,let sessionOwner,root.healthAdmission,current(),root.healthAdmission,!preservesPauseHold,(pauseOperation==nil || pauseOperation?.superseded==true),ready,!settingUp,configuration.plans.contains(where:{$0.category==category}) else{completion(.failure(Failure.unavailable));return}
        let generation=root.healthGeneration
        sessionOwner.run(scope:.init(human:rootConfiguration.human,enrollment:configuration.enrollment,endpoint:rootConfiguration.endpoint,category:category)){[self] result in
            if root.healthIOCurrent,generation==root.healthGeneration{completion(result)}else{completion(.failure(Failure.stale))}
            sessionOwner.whenDrained{[weak self] in self?.queueObservationPump()}
        }
    }
    /// Callback-free targeting identity. It grants no permission to collect.
    private func protectiveIdentity()->Bool {
        guard let configuration,!authorityWithdrawn,let known=knownLocalBinding,let origin=transport.endpoint,Data(origin.absoluteString.utf8)==known.origin,transport.effectiveIsSelf,let owner=transport.currentEffectiveOwner else{return false}
        return UUID(uuidString:owner.principal)==known.human && UUID(uuidString:owner.session)==known.session && known.enrollment==configuration.enrollment && known.endpoint==rootConfiguration.endpoint
    }
    func pauseCollection(_ request:NativeHealthPauseRequest,completion:@escaping([String:Any])->Void) {
        precondition(Thread.isMainThread);cancelCalendarReadPermission()
        guard let known=knownLocalBinding else{completion(NativeHealthPauseResponse.make(id:request.operationId,reason:"no_local_binding"));return}
        guard protectiveIdentity() else{completion(NativeHealthPauseResponse.make(id:request.operationId,reason:"context_changed"));return}
        guard request.sourceNamespace==known.namespace,request.enrollment==known.enrollment,request.endpoint==known.endpoint else{completion(NativeHealthPauseResponse.make(id:request.operationId,reason:"source_mismatch"));return}
        let actual:[String:Any]=["sourceNamespace":known.namespace.uuidString.lowercased(),"enrollmentId":known.enrollment.uuidString.lowercased(),"endpointId":known.endpoint.uuidString.lowercased()]
        if let existing=pauseOperation {
            if existing.firstPending{completion(NativeHealthPauseResponse.make(id:request.operationId,binding:actual,reason:"busy"));return}
            if existing.request==request {
                if existing.persistence=="notApplied"{completion(NativeHealthPauseResponse.make(id:request.operationId,binding:actual,reason:existing.reason));return}
                if existing.superseded || existing.resumeInFlight {completion(NativeHealthPauseResponse.make(id:request.operationId,binding:actual,reason:"context_changed"));return}
                completion(NativeHealthPauseResponse.make(id:request.operationId,binding:actual,persistence:existing.persistence,drain:existing.drained ? "drained":"pending",reason:existing.reason));return
            }
            guard existing.superseded || existing.resumeInFlight else{completion(NativeHealthPauseResponse.make(id:request.operationId,binding:actual,reason:existing.persistence=="unconfirmed" ? "prior_unconfirmed":"busy"));return}
            // A distinct explicit pause ends the one-record cache lifetime. No ID history is kept.
        }
        // Store the bounded hold BEFORE any extensible stop/cancel callback or I/O.
        observationInterest=nil;stopBackgroundEffects()
        let pause=PauseOperation(request);pause.firstPending=true;pauseOperation=pause;operationGeneration+=1;ready=false
        root.fenceHealth()
        root.afterFrame(.pause){[self] in
        guard pauseOperation === pause,protectiveIdentity(),!retired,root.available else{
            pause.firstPending=false;pause.persistence="notApplied";pause.reason="context_changed"
            observePauseDrain(pause)
            completion(NativeHealthPauseResponse.make(id:request.operationId,binding:actual,reason:"context_changed"));publishDrain();return
        }
        do {try root.protective {
        outbox.invalidatePolicy(enrollment:known.enrollment)
        sessionOwner?.cancel();setupTask?.cancel()
        do {
            let prior=try? outbox.status(enrollment:known.enrollment)
            if prior?.paused==true && prior?.localChangePending==false {
                collector?.stop();pause.reason="already_paused"
            }else {try collector?.pause(enrollment:known.enrollment);pause.reason="paused"}
            let saved=try outbox.status(enrollment:known.enrollment)
            guard protectiveIdentity(),saved.paused,!saved.localChangePending else{throw Failure.stale}
            pause.persistence="savedPaused"
        }catch{pause.persistence="unconfirmed";pause.reason="storage_unconfirmed"}
        }}catch{pause.persistence="unconfirmed";pause.reason="storage_unconfirmed"}
        pause.firstPending=false
        observePauseDrain(pause)
        completion(NativeHealthPauseResponse.make(id:request.operationId,binding:actual,persistence:pause.persistence,drain:pause.drained ? "drained":"pending",reason:pause.reason));return
        }
    }
    /// An obsolete uninvoked action does not create uncertainty, but the old
    /// collector/session still require real retirement. Register exactly once.
    private func observePauseDrain(_ pause:PauseOperation){
        guard !pause.observingDrain else{return};pause.observingDrain=true
        collectorDrained{[self,weak pause] in guard let pause,pauseOperation === pause else{return};pause.collectorDrained=true;updatePauseDrain()}
        sessionDrained{[self,weak pause] in guard let pause,pauseOperation === pause else{return};pause.sessionDrained=true;updatePauseDrain()}
        updatePauseDrain()
    }
    /// The host supplies only its existing captured selector/currentness gate.
    /// Completed observations never repeat the remote read or the local write.
    func resumeCollection(_ request:NativeHealthResumeRequest,hostCurrent:@escaping()->Bool,start:@escaping(@escaping(Result<Void,Error>)->Void)->Void,completion:@escaping([String:Any])->Void) {
        guard calendarReadPermissionRun==nil,permissionRun==nil,permissionReservation==nil else{completion(NativeHealthResumeResponse.make(id:request.operationId,reason:"busy"));return}
        precondition(Thread.isMainThread)
        func no(_ reason:String){completion(NativeHealthResumeResponse.make(id:request.operationId,reason:reason))}
        // An exact original uncertain result is historical intent, not a grant.
        // Observe it without I/O even when its write latched the root unresolved.
        // Never relabel that original attempt as notApplied on a duplicate.
        if let prior=pauseOperation?.resumeObservation,prior.request==request,!prior.pending,prior.outcome=="unconfirmed",protectiveIdentity(),capturedTransportCurrent(){completion(prior.response());return}
        guard let configuration,hostCurrent(),current(),protectiveIdentity() else{no("context_changed");return}
        guard let known=knownLocalBinding,request.sourceNamespace==known.namespace,request.enrollment==known.enrollment,request.endpoint==known.endpoint else{no("source_mismatch");return}
        guard let pause=pauseOperation else{no("no_known_pause");return}
        if let prior=pause.resumeObservation,prior.request.operationId==request.operationId,prior.request != request{no("source_mismatch");return}
        guard request.expectedPauseOperationId==pause.request.operationId else{no("pause_changed");return}
        func valid(_ tickets:[HealthCollectionTicket])->Bool {
            guard capturedTransportCurrent(),pauseOperation === pause,!settingUp,!pause.resumeInFlight,!pause.resumeUnconfirmed,!tickets.isEmpty,tickets.count==configuration.plans.count else{return false}
            guard let flags=try? outbox.status(enrollment:configuration.enrollment),flags.policyConfirmed,!flags.paused,!flags.requiresRebind,!flags.localChangePending else{return false}
            for ticket in tickets {
                guard ticket.humanId==known.human,ticket.enrollmentId==known.enrollment,UUID(uuidString:ticket.sourceNamespace)==known.namespace,(try? outbox.verify(ticket:ticket)) != nil else{return false}
            }
            return capturedTransportCurrent() && pauseOperation === pause
        }
        if let observation=pause.resumeObservation {
            if observation.request.operationId==request.operationId {
                guard observation.request==request else{no("source_mismatch");return}
                if observation.pending {no("busy");return}
                if observation.outcome=="resumed" && !valid(observation.tickets){no("context_changed");return}
                completion(observation.response());return
            }
            if observation.pending{no("busy");return}
            if pause.superseded || pause.resumeUnconfirmed{no("pause_changed");return}
        }
        guard !pause.superseded else{no("pause_changed");return}
        guard pause.persistence=="savedPaused",pause.drained,!pause.resumeUnconfirmed,!pause.resumeInFlight else{no("pause_pending");return}
        let observation=ResumeObservation(request);pause.resumeObservation=observation
        start { [self] result in
            guard observation.pending else{return}
            // Extensible checks precede the final pure proof observation.
            let isCurrent=hostCurrent() && current() && protectiveIdentity() && pauseOperation === pause
            let invoked=pause.superseded || pause.resumeUnconfirmed
            var tickets:[HealthCollectionTicket]=[]
            if isCurrent,case .success=result {
                for plan in configuration.plans {if let ticket=try? outbox.ticket(enrollment:configuration.enrollment,type:plan.category){tickets.append(ticket)}}
            }
            if isCurrent,case .success=result,valid(tickets),let revision=tickets.first?.expectedPolicyRevision,tickets.allSatisfy({$0.expectedPolicyRevision==revision}) {
                observation.tickets=tickets
                observation.binding=["sourceNamespace":known.namespace.uuidString.lowercased(),"enrollmentId":known.enrollment.uuidString.lowercased(),"endpointId":known.endpoint.uuidString.lowercased(),"policyRevision":revision]
                observation.outcome="resumed";observation.reason="resumed"
            }else if invoked {
                pause.resumeUnconfirmed=true;ready=false
                observation.outcome="unconfirmed";observation.reason=isCurrent ? "storage_unconfirmed":"context_changed"
            }else {
                observation.outcome="notApplied"
                if !isCurrent {observation.reason="context_changed"}
                else if case .failure(Failure.sourceMismatch)=result{observation.reason="source_mismatch"}
                else if case .failure(Failure.invalid)=result{observation.reason="categories_changed"}
                else{observation.reason="policy_unavailable"}
            }
            observation.pending=false;completion(observation.response())
        }
    }
    private func pumpCalendarDrain(){
        guard permissionReservation==nil,calendarDrainRequest != nil,!calendarDrainChecking,pending==0,!settingUp else{return}
        calendarDrainChecking=true
        collectorDrained{[self] in sessionDrained{[self] in
            calendarDrainChecking=false
            guard pending==0,!settingUp else{return}
            let callback=calendarDrainRequest;calendarDrainRequest=nil;callback?()
        }}
    }
    func setupCalendar(supplied:CalendarConfiguration,setup:CalendarSetup,selector:String,fresh:@escaping()->Bool,completion:@escaping(CalendarSetupResult)->Void){performCalendarSetup(supplied:supplied,setup:setup,selector:selector,kind:.setupExistingRemote,fresh:fresh,completion:completion)}
    func applyConfiguredCalendar(supplied:CalendarConfiguration,update:CalendarSetup,selector:String,fresh:@escaping()->Bool,completion:@escaping(CalendarSetupResult)->Void){performCalendarSetup(supplied:supplied,setup:update,selector:selector,kind:.applyConfiguredExistingLocal,fresh:fresh,completion:completion)}
    private func performCalendarSetup(supplied:CalendarConfiguration,setup:CalendarSetup,selector:String,kind:NativeCalendarControlKind,fresh:@escaping()->Bool,completion:@escaping(CalendarSetupResult)->Void){
        precondition(Thread.isMainThread)
        guard calendarReadPermissionRun==nil,permissionRun==nil,permissionReservation==nil else{completion(.unavailable);return}
        guard !selector.isEmpty,selector.utf8.count<=128 else{completion(.unavailable);return}
        if let held=admissionRun {
            if let result=calendarAdmissionObservation(selector:selector),held.source.matches(supplied.configuration),held.kind==kind,held.owner === setup.owner,held.currency === setup.currency,held.categories==setup.selectedCategories{completion(result)}else{completion(.unavailable)}
            return
        }
        guard admissionRun==nil,calendarRun==nil,!settingUp,!retired,!root.busy,!root.inStorage,root.available,
              supplied.configuration.valid,!setup.selectedCategories.isEmpty,setup.selectedCategories.isSubset(of:["CalendarEvent","Task"]),
              supplied.configuration.human==rootConfiguration.human,supplied.configuration.session==rootConfiguration.session,supplied.configuration.endpoint==rootConfiguration.endpoint,supplied.configuration.origin==rootConfiguration.origin,
              let currency=setup.currency,!currency.revoked else{completion(.unavailable);return}
        let binding=NativeCalendarAdmissionCurrency.Binding(root:rootConfiguration.identity,configuration:supplied.configuration,selected:setup.selectedCategories,kind:kind)
        guard currency.owner === setup.owner,currency.binding.matches(binding) else{completion(.unavailable);return}
        let run=AdmissionRun(selector:selector,source:supplied.configuration,identity:rootConfiguration.identity,epoch:transport.epoch,setup:setup,kind:kind,completion:completion);admissionRun=run
        func pure()->Bool{self.admissionRun === run && !run.cancelled && !self.retired && !currency.revoked && self.root.available && self.capturedTransportCurrent()}
        func current()->Bool {
            let protected=self.rootConfiguration.protectedAvailable() && supplied.configuration.protectedAvailable()
            let selected=fresh()
            return protected && selected && pure()
        }
        func retireKnown(){
            guard self.admissionRun === run,!self.root.unresolved else{return}
            // Keep the original run reserved throughout parent release/reentry.
            run.lease?.release();run.lease=nil;run.reader=nil
            self.admissionRun=nil;self.publishDrain()
        }
        func finish(_ persistence:CalendarSetupResult.Persistence){
            let usable=pure() && persistence == .saved
            run.report(.init(attempt:run.attempt,persistence:persistence,availability:usable ? .available:.unavailable))
            if run.reader==nil {
                // Early admission/custody failure also returns inside an original
                // root callback. Retire after that complete frame has returned.
                DispatchQueue.main.async{retireKnown()}
            }
        }
        root.acquireCalendar(custody:supplied.custody,drain:{[self] done in calendarDrainRequest=done;pumpCalendarDrain()}){[self] result in
            guard case .success(let lease)=result else{finish(.notApplied);return};run.lease=lease
            guard current() else{finish(.notApplied);return}
            let reader=NativeCalendarPolicy.readForAdmission(transport:transport,configuration:supplied.configuration,current:current);run.reader=reader
            reader.whenDrained{retireKnown()}
            reader.read{[self] result in
                guard current(),case .success(let proof)=result,setup.selectedCategories.isSubset(of:proof.categories) else{finish(.notApplied);return}
                do {
                    if kind == .applyConfiguredExistingLocal{try root.applyConfiguredCalendar(attempt:run.attempt,lease:lease,configuration:currency,owner:setup.owner,binding:binding,proof:proof)}else{try root.admitCalendar(attempt:run.attempt,lease:lease,configuration:currency,owner:setup.owner,binding:binding,proof:proof)}
                    adopted=true
                    finish(.saved)
                }catch{finish(root.unresolved ? .unconfirmed:.notApplied)}
            }
        }
    }
    /// Read-only existing-local adoption. Pending delivery is a separate command.
    func reconnectCalendar(supplied:CalendarConfiguration,reconnect:CalendarReconnect,selector:String,fresh:@escaping()->Bool,completion:@escaping(CalendarReconnectResult)->Void){
        precondition(Thread.isMainThread)
        guard calendarReadPermissionRun==nil,permissionRun==nil,permissionReservation==nil else{completion(.unavailable);return}
        guard !selector.isEmpty,selector.utf8.count<=128,admissionRun==nil,calendarRun==nil,!settingUp,!retired,!root.busy,!root.inStorage,root.available,
              supplied.configuration.valid,!reconnect.expectedSavedCategories.isEmpty,
              supplied.configuration.human==rootConfiguration.human,supplied.configuration.session==rootConfiguration.session,supplied.configuration.endpoint==rootConfiguration.endpoint,supplied.configuration.origin==rootConfiguration.origin,
              let currency=reconnect.currency,!currency.revoked else{completion(.unavailable);return}
        let binding=NativeCalendarAdmissionCurrency.Binding(root:rootConfiguration.identity,configuration:supplied.configuration,selected:reconnect.expectedSavedCategories,kind:.reconnectExistingLocal)
        guard currency.owner === reconnect.owner,currency.binding.matches(binding) else{completion(.unavailable);return}
        let run=AdmissionRun(selector:selector,source:supplied.configuration,identity:rootConfiguration.identity,epoch:transport.epoch,reconnect:reconnect,completion:completion);admissionRun=run
        var validated=false,retirementScheduled=false
        func pure()->Bool{self.admissionRun === run && !run.cancelled && !self.retired && !currency.revoked && self.root.available && self.capturedTransportCurrent() && self.transport.epoch==run.epoch}
        func current()->Bool{
            let protected=self.rootConfiguration.protectedAvailable() && supplied.configuration.protectedAvailable()
            let selected=fresh()
            return protected && selected && pure()
        }
        func report(){
            let usable=validated && pure()
            run.reportReconnect(.init(attempt:run.attempt,outcome:usable ? .reconnected:.notApplied,availability:usable ? .available:.unavailable))
        }
        func retire(){
            guard !retirementScheduled,self.admissionRun === run else{return};retirementScheduled=true
            // A different real writer may have latched the SAME root unresolved.
            // Report this read's unavailable outcome without releasing that hold.
            guard !self.root.unresolved else{report();return}
            run.lease?.release();run.lease=nil
            // Original Root release queues its publication fence first. Keep the
            // run reserved through parent-release reentry and that full barrier.
            DispatchQueue.main.async{[self] in
                guard admissionRun === run else{return}
                let usable=validated && pure()
                run.reader=nil;admissionRun=nil
                run.reportReconnect(.init(attempt:run.attempt,outcome:usable ? .reconnected:.notApplied,availability:usable ? .available:.unavailable))
                publishDrain()
            }
        }
        func finish(){if run.reader==nil{DispatchQueue.main.async{retire()}}}
        root.acquireCalendar(custody:supplied.custody,drain:{[self] done in calendarDrainRequest=done;pumpCalendarDrain()}){[self] result in
            guard case .success(let lease)=result else{finish();return};run.lease=lease
            guard current() else{finish();return}
            // Existing owner semantics invalidate all Calendar ticket generations,
            // but do not alter Health/Share authority or any persistent bytes.
            outbox.invalidateCalendarPolicy(enrollment:supplied.configuration.enrollment)
            let reader=NativeCalendarPolicy.readForAdmission(transport:transport,configuration:supplied.configuration,current:current);run.reader=reader
            reader.whenDrained{retire()}
            reader.read{[self] result in
                guard current(),case .success(let proof)=result else{return}
                do{
                    try root.reconnectCalendar(attempt:run.attempt,lease:lease,configuration:currency,owner:reconnect.owner,binding:binding,proof:proof)
                    adopted=true;validated=true;lastCalendarReconnectProof=(supplied.configuration,reconnect.expectedSavedCategories,proof)
                }catch{validated=false}
            }
        }
    }
    func calendar(collect:Bool,supplied:CalendarConfiguration,fresh:@escaping()->CalendarConfiguration?,completion:@escaping(NativeCalendarAcquisitionOwner.DeliveryOutcome)->Void){
        precondition(Thread.isMainThread)
        guard calendarReadPermissionRun==nil,permissionRun==nil,permissionReservation==nil,admissionRun==nil,calendarRun==nil,!retired,adopted,root.available,!root.inStorage,let config=fresh(),config.configuration.valid,config.configuration.matches(supplied.configuration),
              config.configuration.human==rootConfiguration.human,config.configuration.session==rootConfiguration.session,config.configuration.endpoint==rootConfiguration.endpoint,config.configuration.origin==rootConfiguration.origin else{completion(.notApplied(.unavailable));return}
        let run=CalendarRun(completion);calendarRun=run
        root.acquireCalendar(custody:config.custody,drain:{[self] done in calendarDrainRequest=done;pumpCalendarDrain()}){[self] result in
            guard case .success(let lease)=result else{
                run.report(.notApplied(run.cancelled ? .cancelled:.unavailable));calendarRun=nil;publishDrain();return
            }
            guard calendarRun === run,!run.cancelled,!retired,root.available else{lease.release();run.report(.notApplied(.cancelled));calendarRun=nil;publishDrain();return}
            var claimed=false
            let owner=NativeCalendarAcquisitionOwner(transport:transport,outbox:outbox,configuration:{[weak self,weak run] in
                guard let self,let run,self.calendarRun === run,!run.cancelled,!self.retired,let current=fresh(),current.configuration.matches(config.configuration) else{return nil};return current.configuration
            },acquireOriginalOwnerLease:{guard !claimed else{throw Failure.busy};claimed=true;return lease},makeAcquisition:config.makeAcquisition,captureClock:config.captureClock)
            run.owner=owner
            let done:(NativeCalendarAcquisitionOwner.DeliveryOutcome)->Void = { value in run.report(value) }
            if collect{owner.collectAndDeliver(completion:done)}else{owner.deliverPending(completion:done)}
            owner.whenDrained{[self] in
                // A rejected admission may never claim the prepared grant.
                if !claimed{lease.release()}
                guard calendarRun === run else{return};calendarRun=nil;publishDrain()
            }
        }
    }
    func cancelCalendar(){
        precondition(Thread.isMainThread);cancelCalendarReadPermission();if let run=admissionRun{run.cancelled=true;run.currency?.revoke();run.reader?.cancel();root.cancelAdmission()};guard let run=calendarRun,!run.cancelled else{return}
        run.cancelled=true;root.cancelAdmission()
        root.afterFrame(.calendarCancellation){run.owner?.cancel()}
        if run.owner==nil{run.report(.notApplied(.cancelled))}
    }
    var statusCurrent:Bool { current() }
    /// Read-only observation. The supplied source is parsed native inventory, not bridge input.
    func selectedStatus(source:MobileHealthInventoryPage.Source,contextRevision:Int,publicationCurrent:()->Bool)->[String:Any] {
        guard calendarReadPermissionRun==nil,permissionRun==nil,permissionReservation==nil,let configuration,current(),!root.inStorage,!root.unresolved,source.currentEnrollment==configuration.enrollment,source.collector.utf8.elementsEqual("healthKit".utf8) else{return NativeHealthSelectedStatus.response("unavailable","context_changed")}
        let binding:[String:Any]=["sourceNamespace":source.namespace.uuidString.lowercased(),"enrollmentId":configuration.enrollment.uuidString.lowercased(),"endpointId":rootConfiguration.endpoint.uuidString.lowercased(),"policyRevision":source.policyRevision,"contextRevision":contextRevision]
        // A failed pause may invalidate Core's readable context. The original
        // held intent remains known; do not read or invent a local snapshot.
        if let pause=pauseOperation,preservesPauseHold,!pause.superseded,
           pause.request.sourceNamespace==source.namespace,pause.request.enrollment==configuration.enrollment,pause.request.endpoint==rootConfiguration.endpoint {
            return NativeHealthSelectedStatus.response("unavailable","local_change_pending",binding:binding)
        }
        let observedGeneration=root.healthGeneration
        do {return try root.observe {
            let state=try outbox.status(enrollment:configuration.enrollment)
            let local:[String:Any]=["policyConfirmed":state.policyConfirmed,"localChangePending":state.localChangePending,"paused":state.paused,"requiresRebind":state.requiresRebind,"busy":settingUp || (sessionOwner?.busy ?? false) || root.busy || calendarRun != nil]
            func reply(_ status:String,_ reason:String)->[String:Any]{NativeHealthSelectedStatus.response(status,reason,binding:binding,local:local)}
            if preservesPauseHold{return NativeHealthSelectedStatus.response("unavailable","context_unavailable")}
            if state.localChangePending{return reply("unavailable","local_change_pending")}
            if state.paused{return reply("unavailable","paused")}
            if state.requiresRebind{return reply("unavailable","rebind_required")}
            if source.currentState != "active" || source.collectionPaused{return reply("unavailable","source_mismatch")}
            if !state.policyConfirmed{return reply("unknown","policy_unconfirmed")}
            do {
                for plan in configuration.plans {
                    let ticket=try outbox.ticket(enrollment:configuration.enrollment,type:plan.category)
                    guard ticket.humanId==rootConfiguration.human,ticket.enrollmentId==configuration.enrollment,UUID(uuidString:ticket.sourceNamespace)==source.namespace,ticket.expectedPolicyRevision==source.policyRevision else{return reply("unknown","proof_unavailable")}
                    try outbox.verify(ticket:ticket)
                }
            }catch{return reply("unknown","proof_unavailable")}
            // Storage/proof reads can change configuration or protection. Run
            // the same Host gate after them, then only original owner fields:
            // its callbacks may themselves pause, retire or admit other work.
            guard publicationCurrent(),capturedTransportCurrent(),root.available,!hasAdmission,!preservesPauseHold,root.healthGeneration==observedGeneration else{return NativeHealthSelectedStatus.response("unavailable","context_changed")}
            return reply("ready","ready")
        }}catch{return NativeHealthSelectedStatus.response("unavailable","storage_unavailable",binding:binding)}
    }
    func status()->[String:Any]{
        guard calendarReadPermissionRun==nil,permissionRun==nil,permissionReservation==nil,let configuration,current(),!root.inStorage,!root.unresolved,let status=try? root.observe({try outbox.status(enrollment:configuration.enrollment)}) else{return ["state":"unavailable"]}
        return ["state":ready ? "ready":"unavailable","busy":settingUp || (sessionOwner?.busy ?? false) || root.busy || calendarRun != nil,"pending":status.pending,"quarantined":status.quarantined,"paused":status.paused,"requiresRebind":status.requiresRebind,"mayHaveMore":mayHaveMore]
    }
}

extension NativeHealthRuntime {
    /// Stored-field admission only: catalog discovery must not touch a store/SDK.
    var choiceAdmissionAvailable:Bool {permissionReservation==nil && choiceRuntimeIdle}
    private var choiceRuntimeIdle:Bool {
        !retired && !root.unresolved && !root.busy && !root.inStorage && !settingUp && pending==0 &&
        nativeCommandRun==nil && calendarReadPermissionRun==nil && admissionRun==nil && calendarRun==nil && permissionRun==nil && !preservesPauseHold && !(sessionOwner?.busy ?? false)
    }
    var choiceSourceCurrent:Bool{!retired && root.available && capturedTransportCurrent()}
    /// Capture the actual Root/generation BEFORE Host resolver/inventory callbacks.
    func reserveReadPermission(action:NativeHealthChoiceAction)->Bool{
        precondition(Thread.isMainThread)
        guard choiceAdmissionAvailable,ready,adopted,root.healthAdmission,let configuration,let known=knownLocalBinding,
              action.kind == .permission,action.runtime === self,configuration.matches(action.record.descriptor.configuration),known.namespace==action.record.descriptor.namespace,action.isCurrent() else{return false}
        permissionReservation=PermissionRun(action:action,root:root,epoch:transport.epoch);return true
    }
    func releaseReadPermissionReservation(action:NativeHealthChoiceAction){
        precondition(Thread.isMainThread)
        guard permissionReservation?.action === action else{return}
        permissionReservation=nil;pumpCalendarDrain();publishDrain()
    }
    func requestReadPermission(action:NativeHealthChoiceAction,completion:@escaping(HealthKitCollector.PermissionResult)->Void){
        precondition(Thread.isMainThread)
        guard let run=permissionReservation,run.action === action,!run.cancelled,choiceRuntimeIdle,ready,adopted,root.healthAdmission,
              run.root === root,run.generation==root.healthGeneration,run.epoch==transport.epoch,let configuration,let collector,let known=knownLocalBinding,
              action.kind == .permission,action.runtime === self,configuration.matches(action.record.descriptor.configuration),known.namespace==action.record.descriptor.namespace else{releaseReadPermissionReservation(action:action);completion(.notInvoked);return}
        permissionRun=run;begin();permissionReservation=nil // Atomic transition, never a gap/replacement.
        func pure()->Bool {
            self.permissionRun === run && !run.cancelled && !self.retired && self.root === run.root && self.root.healthGeneration==run.generation &&
            self.root.healthAdmission && self.transport.epoch==run.epoch && self.capturedTransportCurrent() && action.isCurrent()
        }
        func finish(_ value:HealthKitCollector.PermissionResult){
            guard permissionRun === run,!run.finishing else{return};run.finishing=true
            collector.whenDrained{[self] in
                DispatchQueue.main.async{[self] in
                    guard permissionRun === run else{return}
                    let usable=pure(),result:HealthKitCollector.PermissionResult
                    if usable{result=value}else{switch value{case .requestCompletedReadNotObservable,.deferred:result = .deferred;default:result = .notInvoked}}
                    permissionRun=nil;end();completion(result)
                }
            }
        }
        // Complete extensible protection checks before actual Core reads.
        guard current(),pure() else{finish(.notInvoked);return}
        let selected=Set(configuration.plans.map(\.category))
        let before:[HealthCollectionTicket]
        do {
            before=try configuration.plans.map{try outbox.ticket(enrollment:configuration.enrollment,type:$0.category)}
            guard before.allSatisfy({$0.humanId==rootConfiguration.human && $0.enrollmentId==configuration.enrollment && UUID(uuidString:$0.sourceNamespace)==known.namespace}),pure() else{throw Failure.stale}
        }catch{finish(.notInvoked);return}
        snapshot{[self] first in
            guard pure(),case .success(let initial)=first else{finish(.notInvoked);return}
            begin()
            let policy=NativeHealthPolicy(transport:transport,outbox:outbox,collector:self)
            policy.readForControl(enrollment:configuration.enrollment,expectedEndpoint:rootConfiguration.endpoint){[self] result in
                defer{end()}
                guard pure(),case .success(let proof)=result,proof.permitsCollection,
                      UUID(uuidString:proof.sourceNamespace ?? "")==known.namespace,
                      before.allSatisfy({$0.expectedPolicyRevision==proof.revision}),selected.isSubset(of:proof.healthKitTypes) else{finish(.notInvoked);return}
                snapshot{[self] second in
                    guard pure(),case .success(let final)=second,initial==final,current(),pure() else{finish(.notInvoked);return}
                    // Same collector/SDK preparation finishes FIRST. Its private
                    // verifier then invokes the unchanged Core method through
                    // the normal Root, verifies new tickets, and finally gates
                    // the captured OS delegate with stored-only currentness.
                    collector.requestReadPermission(enrollment:configuration.enrollment,types:selected,proof:proof,explicitOwnerAction:true,current:pure){value in finish(value)}
                }
            }
        }
    }
}

// Calendar OS request handling shares the SAME original outbox owner, but never
// admits, refreshes, migrates, collects or writes a Calendar record.
extension NativeHealthRuntime {
    private final class CalendarReadPermissionRun {
        let action:NativeCalendarReadPermissionAction,config:CalendarConfiguration,generation:UInt64
        var parent:(any NativeSharedOutboxCustodyLease)?,custodyCurrency:NativeCalendarReadPermissionCurrency?,lease:NativeSharedOutboxOwner.CalendarLease?
        var reader:NativeCalendarAdmission?,request:NativeCalendarReadPermissionRequest?
        var cancelled=false,readerDrained=true,requestDrained=true,finishing=false,bindingCurrent=false,observed=false
        var value:NativeCalendarReadPermissionResult?
        let completion:(NativeCalendarReadPermissionResult)->Void
        init(_ action:NativeCalendarReadPermissionAction,_ config:CalendarConfiguration,_ generation:UInt64,_ completion:@escaping(NativeCalendarReadPermissionResult)->Void){self.action=action;self.config=config;self.generation=generation;self.completion=completion}
    }
    private func cancelCalendarReadPermission(){
        // This latch is BEFORE every original cancelCalendar early return and
        // protective/retirement/authority mutation. No invented SDK cancel.
        lastCalendarReconnectProof=nil
        guard let run=calendarReadPermissionRun else{return}
        run.cancelled=true;run.reader?.cancel();root.cancelAdmission()
    }
    func requestCalendarReadPermission(action:NativeCalendarReadPermissionAction,supplied:CalendarConfiguration,completion:@escaping(NativeCalendarReadPermissionResult)->Void){
        precondition(Thread.isMainThread)
        func unavailable(){completion(.init(attempt:action.id,state:.notInvoked,access:.unknown))}
        guard calendarReadPermissionRun==nil,choiceAdmissionAvailable,adopted,action.runtime === self,action.isCurrent(),
              let known=lastCalendarReconnectProof,known.configuration.matches(supplied.configuration),known.categories==Set([supplied.configuration.plan.category]),
              let configCurrency=action.port.currency,configCurrency.owner === action.port.owner,let host=action.host,configCurrency.isBound(host),
              configCurrency.binding.matches(.init(root:rootConfiguration.identity,configuration:supplied.configuration,category:supplied.configuration.plan.category)),let originalCustody=supplied.custody else{unavailable();return}
        let run=CalendarReadPermissionRun(action,supplied,root.healthGeneration,completion);calendarReadPermissionRun=run
        let binding=NativeCalendarReadPermissionCurrency.Binding(root:rootConfiguration.identity,configuration:supplied.configuration,category:supplied.configuration.plan.category)
        func base()->Bool{
            self.calendarReadPermissionRun === run && !run.cancelled && !self.retired && self.adopted && self.root.available && !self.root.inStorage && self.root.healthGeneration==run.generation && self.capturedTransportCurrent() && action.isCurrent() && configCurrency.isBound(host)
        }
        func frontiersCurrent()->Bool{
            guard base(),let parent=run.parent,run.lease != nil,let custody=run.custodyCurrency else{return false}
            return configCurrency.current(action.id,root:self.root,parent:parent) && custody.current(action.id,root:self.root,parent:parent) && custody.owner === parent
        }
        func pure()->Bool{!run.finishing && frontiersCurrent()}
        func cleanup(){
            guard self.calendarReadPermissionRun === run,let value=run.value,run.readerDrained,run.requestDrained,!run.finishing else{return};run.finishing=true
            // Keep BOTH original claims through the parent's entire release,
            // unwind and queued publication check. Finishing blocks new use of
            // the released lease; its retained identity is only a final witness.
            run.lease?.release()
            DispatchQueue.main.async{[self] in
                guard calendarReadPermissionRun === run else{return}
                let current=frontiersCurrent(),result:NativeCalendarReadPermissionResult
                configCurrency.release(action.id);run.custodyCurrency?.release(action.id);run.lease=nil
                if current{result=value}else{result = .init(attempt:action.id,state:value.state == .notInvoked ? .notInvoked:.deferred,access:.unknown)}
                calendarReadPermissionRun=nil;run.reader=nil;run.request=nil;run.parent=nil;run.completion(result);pumpCalendarDrain();publishDrain()
            }
        }
        func finish(_ state:NativeCalendarReadPermissionResult.State,_ access:NativeCalendarReadAccess = .unknown){
            guard run.value==nil else{return};run.value = .init(attempt:action.id,state:state,access:access,originalBindingCurrent:run.bindingCurrent,observed:run.observed);cleanup()
        }
        let custody:NativeSharedOutboxOwner.Custody={[self] storage,scope in
            let parent=try originalCustody(storage,scope);run.parent=parent
            guard base(),let actual=parent as? any NativeCalendarReadPermissionCustody,
                  let currency=actual.readPermissionCurrency(binding:binding),currency.owner === parent,currency.binding.matches(binding),currency.bind(host) else{parent.release();throw Failure.unavailable}
            run.custodyCurrency=currency
            guard base(),configCurrency.claim(action.id,root:root,parent:parent),currency.claim(action.id,root:root,parent:parent),base() else{configCurrency.release(action.id);currency.release(action.id);parent.release();throw Failure.stale}
            return parent // EXACT original parent; no wrapper lease/store/provider.
        }
        root.acquireCalendar(custody:custody,drain:{[self] done in calendarDrainRequest=done;pumpCalendarDrain()}){[self] result in
            guard case .success(let lease)=result else{finish(.notInvoked);return};run.lease=lease
            guard pure() else{finish(.notInvoked);return}
            let initial:CalendarCollectionTicket
            do{initial=try root.observe{try outbox.calendarTicket(enrollment:supplied.configuration.enrollment,category:binding.category)}}catch{finish(.notInvoked);return}
            guard pure() else{finish(.notInvoked);return}
            let reader=NativeCalendarPolicy.readForAdmission(transport:transport,configuration:supplied.configuration,current:pure);run.reader=reader;run.readerDrained=false
            reader.whenDrained{run.readerDrained=true;cleanup()}
            reader.read{[self] result in
                guard pure(),case .success(let proof)=result,MobileEventKitAcquisition.sameProof(known.proof,proof),proof.categories.contains(binding.category) else{finish(.notInvoked);return}
                // All extensible input/status preparation is before final Core read.
                guard supplied.configuration.protectedAvailable(),rootConfiguration.protectedAvailable(),pure() else{finish(.notInvoked);return}
                let sdk=action.port.prepare()
                guard pure() else{finish(.notInvoked);return}
                let status=sdk?.access(category:binding.category) ?? .unknown
                guard pure() else{finish(.notInvoked);return}
                let final:CalendarCollectionTicket
                do{final=try root.observe{try outbox.calendarTicket(enrollment:supplied.configuration.enrollment,category:binding.category)}}catch{finish(.notInvoked);return}
                // Callback-free pure fields only after COMPLETE original read and
                // parent.withFence unwind; never lease.checkCurrent/status getter.
                guard final==initial,pure() else{finish(.notInvoked);return}
                run.bindingCurrent=true;run.observed=sdk != nil
                guard let sdk else{finish(.notInvoked);return}
                guard status == .notDetermined || status == .writeOnly else{finish(.notInvoked,status);return}
                let request=NativeCalendarReadPermissionRequest(sdk:sdk,category:binding.category);run.request=request;run.requestDrained=false
                request.start(current:pure){[self] response in
                    run.requestDrained=true
                    guard response.invoked else{finish(.notInvoked);return}
                    guard pure() else{finish(.deferred);return}
                    let observed=response.error ? NativeCalendarReadAccess.unknown:sdk.access(category:binding.category);run.observed = !response.error
                    guard pure() else{finish(.deferred);return}
                    do{guard try root.observe({try outbox.calendarTicket(enrollment:supplied.configuration.enrollment,category:binding.category)})==initial,pure() else{run.bindingCurrent=false;finish(.deferred);return}}catch{run.bindingCurrent=false;finish(.deferred);return}
                    finish(.requestCompleted,observed)
                }
            }
        }
    }
}

extension NativeHealthRuntime {
    enum NativeCommandOutcome {case notApplied(String),held(UUID?,String),terminal(MobileCalendarSettingsWire.Terminal),consent(MobileCalendarSourceConsent.Response),healthConsent(MobileHealthSourceConsent.Response),healthControl(MobileOrdinaryControl.Terminal),healthLocal(HealthOutbox.HealthConfiguredLocalState)}
    private final class NativeCommandChild {
        let id=UUID(),owner:AnyObject,current:()->Bool,makeCurrency:(NativeCalendarCommandCurrency.Binding)->NativeCalendarCommandCurrency?
        let reconcile:Bool
        var consentFamily=false,healthConsentFamily=false,ordinaryHealthFamily=false,healthLocalFamily=false,readBody:Data?
        var completion:((NativeCommandOutcome)->Void)?,wanted:NativeCommandOutcome?,pending=0,cancelled=false,publishing=false,drained=false
        var token:NativeCalendarCommandCurrency?,task:URLSessionDataTask?,snapshot:NativeCalendarContext.Snapshot?
        init(owner:AnyObject,reconcile:Bool,current:@escaping()->Bool,makeCurrency:@escaping(NativeCalendarCommandCurrency.Binding)->NativeCalendarCommandCurrency?,completion:@escaping(NativeCommandOutcome)->Void){self.owner=owner;self.reconcile=reconcile;self.current=current;self.makeCurrency=makeCurrency;self.completion=completion}
    }
    private final class NativeCommandRun {
        var ordinaryHealthCommand:MobileOrdinaryControl.Original?,ordinaryHealthStaged=false
        var localExpected:HealthOutbox.HealthConfiguredLocalState?,localTerminal:MobileOrdinaryControl.Terminal?,localSelected:Set<String>?
        var consentCommand:MobileCalendarSourceConsent.Original?
        var healthConsentCommand:MobileHealthSourceConsent.Original?
        var operationID:UUID?{ordinaryHealthCommand?.operationID ?? healthConsentCommand?.operationID ?? consentCommand?.operationID ?? command?.operationID}
        var command:MobileCalendarSettingsWire.Command?,lease:NativeSharedOutboxOwner.CalendarLease?,child:NativeCommandChild,held=false
        init(_ command:MobileCalendarSettingsWire.Command?,_ child:NativeCommandChild){self.command=command;self.child=child}
    }
    var nativeCommandHeld:Bool{nativeCommandRun?.held==true}
    var nativeCommandCanReconcile:Bool{guard let run=nativeCommandRun else{return true};return run.held && run.child.drained && !root.unresolved && !retired}
    func cancelNativeCommand(){
        precondition(Thread.isMainThread)
        guard let run=nativeCommandRun else{return};run.child.cancelled=true;run.child.token?.revoke();run.child.task?.cancel()
        // Do not revoke/release the physical parent or erase original custody.
        if run.child.wanted==nil{nativeCommandFinish(run,run.child.readBody != nil && run.consentCommand==nil && run.healthConsentCommand==nil && !root.unresolved ? .notApplied("context_changed"):.held(run.operationID,"context_changed"))}
    }
    private func nativeCommandPure(_ run:NativeCommandRun)->Bool{
        nativeCommandRun === run && !run.child.cancelled && !retired && root.available && !root.unresolved && capturedTransportCurrent()
    }
    private func nativeCommandCurrent(_ run:NativeCommandRun)->Bool{
        let protected=rootConfiguration.protectedAvailable(),lease=run.lease?.checkCurrent() ?? false,current=run.child.current()
        return protected && lease && current && nativeCommandPure(run)
    }
    private func nativeCommandFinish(_ run:NativeCommandRun,_ value:NativeCommandOutcome){
        if run.child.wanted != nil{
            // A known invoked terminal save cannot become a fabricated unknown
            // merely because withdrawal ran inside its successful write frame.
            guard !run.child.drained,run.child.completion != nil else{return}
            switch value{case .terminal,.consent,.healthConsent,.healthControl,.healthLocal:break;default:return}
        }
        run.child.wanted=value
        switch value{case .held:run.held=true;default:run.held=false}
        nativeCommandPublish(run)
    }
    private func nativeCommandPublish(_ run:NativeCommandRun){
        let child=run.child
        guard nativeCommandRun === run,child.wanted != nil,child.pending==0,!child.publishing else{return};child.publishing=true
        // Follows complete original HTTP callbacks and storage/custody unwind.
        DispatchQueue.main.async{[self] in
            guard nativeCommandRun === run,run.child === child,child.pending==0,let value=child.wanted else{return}
            if !run.held{run.lease?.release();run.lease=nil}
            // Also follow original parent.release and Root publication callbacks.
            DispatchQueue.main.async{[self] in
                guard nativeCommandRun === run,run.child === child else{return}
                child.drained=true;let done=child.completion;child.completion=nil
                if !run.held{nativeCommandRun=nil}
                done?(value);publishDrain()
            }
        }
    }
    private func nativeCommandRequest(_ run:NativeCommandRun,_ path:String,method:String="GET",body:Data?=nil,done:@escaping(Result<(Data,HTTPURLResponse),Error>)->Void){
        let child=run.child;child.pending+=1;var claimed=false
        child.task=transport.request(path,method:method,body:body.flatMap{String(data:$0,encoding:.utf8)},internalHealth:method=="POST" && !child.consentFamily && !child.ordinaryHealthFamily,internalCalendarConsent:child.consentFamily && !child.healthConsentFamily && method=="POST",internalHealthConsent:child.healthConsentFamily && method=="POST",internalHealthControl:child.ordinaryHealthFamily && method=="POST",maxBytes:(child.healthConsentFamily || child.ordinaryHealthFamily) ? 524288:child.consentFamily ? 262144:65536){[self] result in
            guard !claimed else{return};claimed=true
            defer{child.pending-=1;nativeCommandPublish(run)}
            guard nativeCommandRun === run,run.child === child else{return};done(result)
        }
    }
    private func nativeCommandSnapshot(_ run:NativeCommandRun,_ done:@escaping(NativeCalendarContext.Snapshot?)->Void){
        guard nativeCommandCurrent(run) else{done(nil);return}
        let epoch=transport.epoch
        nativeCommandRequest(run,"/api/auth/v1/user-context"){[self] result in
            guard nativeCommandCurrent(run),case .success(let(data,http))=result,http.statusCode==200,let auth=try? NativeCalendarContext.auth(data,human:rootConfiguration.human,session:rootConfiguration.session) else{done(nil);return}
            nativeCommandRequest(run,"/api/runtime/v1/session-context"){[self] result in
                guard nativeCommandCurrent(run),case .success(let(data,http))=result,http.statusCode==200,let snapshot=try? NativeCalendarContext.session(data,auth:auth,endpoint:rootConfiguration.endpoint,epoch:epoch) else{done(nil);return};done(snapshot)
            }
        }
    }
    private func nativeCommandInvoke(_ run:NativeCommandRun,_ action:NativeSharedOutboxOwner.CommandAction)throws->NativeSharedOutboxOwner.CommandResult{
        guard nativeCommandCurrent(run) else{throw Failure.stale}
        let b=NativeCalendarCommandCurrency.Binding(root:rootConfiguration.identity,purpose:action.purpose,original:action.original)
        guard let currency=run.child.makeCurrency(b),currency.owner === run.child.owner,currency.binding.matches(b),nativeCommandCurrent(run),let lease=run.lease else{throw Failure.unavailable}
        run.child.token=currency
        return try root.performCommand(action,attempt:run.child.id,lease:lease,configuration:currency,owner:run.child.owner,identity:rootConfiguration.identity)
    }
    /// Native-only original command entry. No arbitrary bridge payload is accepted.
    /// Cold recovery and held runs use ONLY exact-original reconciliation.
    func calendarNativeCommand(command:MobileCalendarSettingsWire.Command?,reconcile:Bool,custody:NativeSharedOutboxOwner.Custody?,owner:AnyObject,current:@escaping()->Bool,makeCurrency:@escaping(NativeCalendarCommandCurrency.Binding)->NativeCalendarCommandCurrency?,completion:@escaping(NativeCommandOutcome)->Void){
        precondition(Thread.isMainThread)
        guard !retired,!root.unresolved,root.available,configuration==nil,admissionRun==nil,calendarRun==nil,calendarReadPermissionRun==nil,permissionRun==nil,permissionReservation==nil else{completion(.held(nativeCommandRun?.command?.operationID,"original_owner_unavailable"));return}
        let child=NativeCommandChild(owner:owner,reconcile:reconcile,current:current,makeCurrency:makeCurrency,completion:completion)
        if let run=nativeCommandRun{
            guard reconcile,!run.child.consentFamily,!run.child.ordinaryHealthFamily,run.held,run.child.drained else{completion(.held(run.operationID,"original_owner_busy"));return}
            run.child=child;run.held=false;nativeCommandStart(run);return
        }
        guard reconcile || command != nil,!root.busy else{completion(.notApplied("busy_or_invalid"));return}
        if let command{guard command.principal==rootConfiguration.human,command.endpoint==rootConfiguration.endpoint else{completion(.notApplied("wrong_owner"));return}}
        let run=NativeCommandRun(command,child);nativeCommandRun=run
        root.acquireCalendar(custody:custody,drain:{[self] done in calendarDrainRequest=done;pumpCalendarDrain()}){[self] result in
            guard case .success(let lease)=result else{nativeCommandFinish(run,.notApplied("custody_unavailable"));return};run.lease=lease
            nativeCommandStart(run)
        }
    }
    private func nativeCommandStart(_ run:NativeCommandRun){
        if run.child.consentFamily{nativeConsentStart(run);return}
        nativeCommandSnapshot(run){[self] snapshot in
            guard let snapshot else{nativeCommandFinish(run,.held(run.operationID,"context_unavailable"));return};run.child.snapshot=snapshot
            do{
                let observed=try nativeCommandInvoke(run,.pending)
                guard case .pending(let pending)=observed else{throw Failure.invalid}
                if run.child.reconcile{
                    let data:Data
                    if let pending{data=pending.original}
                    else if case .lastTerminal(let stored)=try nativeCommandInvoke(run,.lastTerminal),let stored{data=stored}
                    else{nativeCommandFinish(run,.notApplied("no_pending_original"));return}
                    let original=try MobileCalendarSettingsWire.command(data)
                    if let known=run.command{guard known.original==original.original else{throw Failure.stale}}
                    run.command=original
                }else{
                    if let pending{run.command=try MobileCalendarSettingsWire.command(pending.original);nativeCommandFinish(run,.held(pending.operationID,"pending_original"));return}
                    guard let command=run.command else{throw Failure.invalid}
                    _ = try nativeCommandInvoke(run,.stage(command.original))
                    guard nativeCommandCurrent(run) else{nativeCommandFinish(run,.held(command.operationID,"staged_context_changed"));return}
                    _ = try nativeCommandInvoke(run,.attempt(command.original))
                }
                nativeCommandSend(run)
            }catch{nativeCommandFinish(run,root.unresolved ? .held(run.operationID,"persistence_unconfirmed"):.notApplied("local_unavailable"))}
        }
    }
    private func nativeCommandSend(_ run:NativeCommandRun){
        guard let command=run.command else{nativeCommandFinish(run,.notApplied("no_original"));return}
        nativeCommandSnapshot(run){[self] current in
            guard current==run.child.snapshot,current != nil,nativeCommandCurrent(run) else{nativeCommandFinish(run,.held(command.operationID,"staged_context_changed"));return}
            do{
                let body=try run.child.reconcile ? MobileCalendarSettingsWire.reconcile(command):command.original
                // Final pure fence after every extensible guard, before POST.
                guard nativeCommandPure(run),run.child.token?.revoked != true else{throw Failure.stale}
                nativeCommandRequest(run,"/api/runtime/v1/mobile-context",method:"POST",body:body){[self] response in
                    guard nativeCommandCurrent(run),case .success(let(data,http))=response,http.statusCode==200 else{nativeCommandFinish(run,.held(command.operationID,"transport_or_context"));return}
                    let terminal:MobileCalendarSettingsWire.Terminal
                    do{terminal=try MobileCalendarSettingsWire.terminal(data,original:command)}catch{nativeCommandFinish(run,.held(command.operationID,"original_terminal_unconfirmed"));return}
                    nativeCommandSnapshot(run){[self] current in
                        guard current==run.child.snapshot,current != nil,nativeCommandCurrent(run) else{nativeCommandFinish(run,.held(command.operationID,"terminal_context_changed"));return}
                        do{
                            _ = try nativeCommandInvoke(run,.terminal(terminal,run.child.reconcile))
                            // Known terminal persistence remains known even if a
                            // nested withdrawal makes later adoption unavailable.
                            nativeCommandFinish(run,.terminal(terminal))
                        }catch{nativeCommandFinish(run,.held(command.operationID,root.unresolved ? "terminal_persistence_unconfirmed":"terminal_unavailable"))}
                    }
                }
            }catch{nativeCommandFinish(run,.held(command.operationID,"staged_context_changed"))}
        }
    }
    /// Explicit local return is a child of the SAME original command owner and
    /// custody path. No mutation is reissued and no receipt is treated as policy.
    func confirmConfiguredHealthLocal(expected:HealthOutbox.HealthConfiguredLocalState,terminal:MobileOrdinaryControl.Terminal,selected:Set<String>,custody:NativeSharedOutboxOwner.Custody?,owner:AnyObject,current:@escaping()->Bool,makeCurrency:@escaping(NativeCalendarCommandCurrency.Binding)->NativeCalendarCommandCurrency?,completion:@escaping(NativeCommandOutcome)->Void){
        precondition(Thread.isMainThread)
        guard configuredSettingsReady,choiceAdmissionAvailable,nativeCommandRun==nil,!root.busy,configuration==nil else{completion(.notApplied("original_owner_unavailable"));return}
        let child=NativeCommandChild(owner:owner,reconcile:false,current:current,makeCurrency:makeCurrency,completion:completion);child.ordinaryHealthFamily=true;child.healthLocalFamily=true
        let run=NativeCommandRun(nil,child);run.ordinaryHealthCommand=terminal.original;run.localExpected=expected;run.localTerminal=terminal;run.localSelected=selected;nativeCommandRun=run
        root.acquireCalendar(custody:custody,drain:{[self] done in calendarDrainRequest=done;pumpCalendarDrain()}){[self] result in
            guard case .success(let lease)=result else{nativeCommandFinish(run,.notApplied("custody_unavailable"));return};run.lease=lease
            nativeCommandSnapshot(run){[self] before in
                guard let before else{nativeCommandFinish(run,.notApplied("local_context_unavailable"));return};child.snapshot=before
                do{guard case .healthLocal(let actual)=try nativeCommandInvoke(run,.healthLocalState(expected.enrollment,expected.namespace)),actual==expected else{throw Failure.stale}}catch{nativeCommandFinish(run,.notApplied("local_review_changed"));return}
                // NativeHealthPolicy keeps its authentic context-before/after
                // pipeline; this real callback is still an original run obligation.
                child.pending+=1
                NativeHealthPolicy(transport:transport,outbox:outbox,collector:self).readForControl(enrollment:expected.enrollment,expectedEndpoint:rootConfiguration.endpoint){[self] response in
                    defer{child.pending-=1;nativeCommandPublish(run)}
                    guard nativeCommandCurrent(run),case .success(let proof)=response,proof.permitsCollection else{nativeCommandFinish(run,.notApplied("remote_saved_local_policy_unavailable"));return}
                    nativeCommandSnapshot(run){[self] after in
                        guard after==before,nativeCommandCurrent(run) else{nativeCommandFinish(run,.notApplied("local_context_changed"));return}
                        do{
                            guard case .healthLocal(let applied)=try nativeCommandInvoke(run,.healthConfiguredLocal(expected,terminal,proof,selected)) else{throw Failure.invalid}
                            nativeCommandFinish(run,.healthLocal(applied))
                        }catch{nativeCommandFinish(run,root.unresolved ? .held(terminal.original.operationID,"local_persistence_unconfirmed"):.notApplied("local_confirmation_unavailable"))}
                    }
                }
            }
        }
    }
    /// Published Health settings adjunct, serialized by the SAME original run.
    /// Initial control never settles: only explicit exact-original reconciliation.
    func healthOrdinaryControl(command:MobileOrdinaryControl.Original?,reconcile:Bool,custody:NativeSharedOutboxOwner.Custody?,owner:AnyObject,current:@escaping()->Bool,makeCurrency:@escaping(NativeCalendarCommandCurrency.Binding)->NativeCalendarCommandCurrency?,completion:@escaping(NativeCommandOutcome)->Void){
        precondition(Thread.isMainThread)
        let sameHeldReconciliation:Bool
        if let held=nativeCommandRun{sameHeldReconciliation=reconcile && held.held && held.child.ordinaryHealthFamily && !held.child.healthLocalFamily && held.child.drained && !independentHealthPauseHold}else{sameHeldReconciliation=false}
        guard !retired,!root.unresolved,root.available,configuration==nil,admissionRun==nil,calendarRun==nil,calendarReadPermissionRun==nil,permissionRun==nil,permissionReservation==nil,(!preservesPauseHold || sameHeldReconciliation) else{completion(.held(nativeCommandRun?.operationID,"original_owner_unavailable"));return}
        let child=NativeCommandChild(owner:owner,reconcile:reconcile,current:current,makeCurrency:makeCurrency,completion:completion);child.ordinaryHealthFamily=true
        if let run=nativeCommandRun{
            guard reconcile,run.child.ordinaryHealthFamily,!run.child.healthLocalFamily,run.held,run.child.drained else{completion(.held(run.operationID,"original_owner_busy"));return}
            run.child=child;run.held=false;ordinaryHealthStart(run);return
        }
        guard reconcile || command != nil,!root.busy else{completion(.notApplied("busy_or_invalid"));return}
        if let command{guard !reconcile,command.principal==rootConfiguration.human,command.endpoint==rootConfiguration.endpoint,command.collector=="healthKit" else{completion(.notApplied("wrong_owner"));return}}
        let run=NativeCommandRun(nil,child);run.ordinaryHealthCommand=command;nativeCommandRun=run
        root.acquireCalendar(custody:custody,drain:{[self] done in calendarDrainRequest=done;pumpCalendarDrain()}){[self] result in
            guard case .success(let lease)=result else{nativeCommandFinish(run,.notApplied("custody_unavailable"));return};run.lease=lease;ordinaryHealthStart(run)
        }
    }
    private func ordinaryHealthStart(_ run:NativeCommandRun){
        nativeCommandSnapshot(run){[self] snapshot in
            guard let snapshot else{nativeCommandFinish(run,.held(run.operationID,"context_unavailable"));return};run.child.snapshot=snapshot
            do{
                guard case .pending(let pending)=try nativeCommandInvoke(run,.healthControlPending) else{throw Failure.invalid}
                if run.child.reconcile{
                    let data:Data
                    if let pending{data=pending.original}
                    else if case .lastTerminal(let stored)=try nativeCommandInvoke(run,.healthControlLast),let stored{data=stored}
                    else{nativeCommandFinish(run,.notApplied("no_pending_original"));return}
                    let original=try MobileOrdinaryControl.original(data)
                    guard original.principal==rootConfiguration.human,original.collector=="healthKit" else{throw Failure.stale}
                    if let known=run.ordinaryHealthCommand{guard known.canonical==original.canonical else{throw Failure.stale}}
                    run.ordinaryHealthCommand=original;run.ordinaryHealthStaged=pending != nil
                }else{
                    if let pending{run.ordinaryHealthCommand=try MobileOrdinaryControl.original(pending.original);run.ordinaryHealthStaged=true;nativeCommandFinish(run,.held(pending.operationID,"pending_original"));return}
                    guard let command=run.ordinaryHealthCommand else{throw Failure.invalid}
                    _ = try MobileOrdinaryControl.envelope(original:command.canonical,operation:.control)
                    _ = try nativeCommandInvoke(run,.healthControlStage(command.canonical));run.ordinaryHealthStaged=true
                    guard nativeCommandCurrent(run) else{nativeCommandFinish(run,.held(command.operationID,"staged_context_changed"));return}
                    _ = try nativeCommandInvoke(run,.healthControlAttempt(command.canonical))
                }
                ordinaryHealthSend(run)
            }catch{nativeCommandFinish(run,(root.unresolved || run.ordinaryHealthStaged) ? .held(run.operationID,"persistence_or_original_unconfirmed"):.notApplied("local_or_other_family_unavailable"))}
        }
    }
    private func ordinaryHealthSend(_ run:NativeCommandRun){
        guard let command=run.ordinaryHealthCommand else{nativeCommandFinish(run,.notApplied("no_original"));return}
        nativeCommandSnapshot(run){[self] current in
            guard current==run.child.snapshot,current != nil,nativeCommandCurrent(run) else{nativeCommandFinish(run,.held(command.operationID,"staged_context_changed"));return}
            do{
                let body=try MobileOrdinaryControl.envelope(original:command.canonical,operation:run.child.reconcile ? .reconcile:.control)
                guard nativeCommandPure(run),run.child.token?.revoked != true else{throw Failure.stale}
                nativeCommandRequest(run,"/api/runtime/v1/mobile-context",method:"POST",body:body){[self] response in
                    guard nativeCommandCurrent(run),case .success(let(data,http))=response,http.statusCode==200 else{nativeCommandFinish(run,.held(command.operationID,"transport_or_context"));return}
                    // Even a nested applied row or an unexpected positive frame
                    // cannot settle an initial control invocation.
                    guard run.child.reconcile else{nativeCommandFinish(run,.held(command.operationID,"reconcile_original"));return}
                    let terminal:MobileOrdinaryControl.Terminal
                    do{terminal=try MobileOrdinaryControl.terminalValue(response:data,original:command.canonical)}catch{nativeCommandFinish(run,.held(command.operationID,"terminal_unconfirmed"));return}
                    nativeCommandSnapshot(run){[self] current in
                        guard current==run.child.snapshot,current != nil,nativeCommandCurrent(run) else{nativeCommandFinish(run,.held(command.operationID,"terminal_context_changed"));return}
                        do{
                            _ = try nativeCommandInvoke(run,.healthControlSettle(terminal,true))
                            nativeCommandFinish(run,.healthControl(terminal))
                        }catch{nativeCommandFinish(run,.held(command.operationID,"terminal_persistence_unconfirmed"))}
                    }
                }
            }catch{nativeCommandFinish(run,.held(command.operationID,"staged_context_changed"))}
        }
    }
    /// Separate schema consumer, sharing the exact original Root/run/custody.
    /// Read envelopes never stage; mutation unknowns retain their original lease.
    func calendarNativeConsent(command:MobileCalendarSourceConsent.Original?,read:Data?=nil,reconcile:Bool,custody:NativeSharedOutboxOwner.Custody?,owner:AnyObject,current:@escaping()->Bool,makeCurrency:@escaping(NativeCalendarCommandCurrency.Binding)->NativeCalendarCommandCurrency?,completion:@escaping(NativeCommandOutcome)->Void){
        precondition(Thread.isMainThread)
        guard !retired,!root.unresolved,root.available,configuration==nil,admissionRun==nil,calendarRun==nil,calendarReadPermissionRun==nil,permissionRun==nil,permissionReservation==nil else{completion(.held(nativeCommandRun?.operationID,"original_owner_unavailable"));return}
        let child=NativeCommandChild(owner:owner,reconcile:reconcile,current:current,makeCurrency:makeCurrency,completion:completion);child.consentFamily=true;child.readBody=read
        if let run=nativeCommandRun{
            guard reconcile,read==nil,run.child.consentFamily,!run.child.healthConsentFamily,run.held,run.child.drained else{completion(.held(run.operationID,"original_owner_busy"));return}
            run.child=child;run.held=false;nativeConsentStart(run);return
        }
        guard reconcile || command != nil || read != nil,!root.busy else{completion(.notApplied("busy_or_invalid"));return}
        if let command{guard command.scope.principal==rootConfiguration.human else{completion(.notApplied("wrong_owner"));return}}
        let run=NativeCommandRun(nil,child);run.consentCommand=command;nativeCommandRun=run
        root.acquireCalendar(custody:custody,drain:{[self] done in calendarDrainRequest=done;pumpCalendarDrain()}){[self] result in
            guard case .success(let lease)=result else{nativeCommandFinish(run,.notApplied("custody_unavailable"));return};run.lease=lease;nativeConsentStart(run)
        }
    }
    private func nativeConsentStart(_ run:NativeCommandRun){
        nativeCommandSnapshot(run){[self] snapshot in
            guard let snapshot else{nativeCommandFinish(run,.held(run.operationID,"context_unavailable"));return};run.child.snapshot=snapshot
            do{
                guard case .pending(let pending)=try nativeCommandInvoke(run,.consentPending) else{throw Failure.invalid}
                if run.child.reconcile{
                    let original:Data
                    if let pending{original=pending.original}
                    else if case .lastTerminal(let stored)=try nativeCommandInvoke(run,.consentLast),let stored{original=stored}
                    else{nativeCommandFinish(run,.notApplied("no_pending_original"));return}
                    let command=try MobileCalendarSourceConsent.command(original)
                    guard run.consentCommand==nil || run.consentCommand?.original==original else{throw Failure.stale};run.consentCommand=command
                }else{
                    guard pending==nil else{run.consentCommand=try MobileCalendarSourceConsent.command(pending!.original);nativeCommandFinish(run,.held(pending!.operationID,"pending_original"));return}
                    if let command=run.consentCommand{
                        _=try nativeCommandInvoke(run,.consentStage(command.original))
                        guard nativeCommandCurrent(run) else{nativeCommandFinish(run,.held(command.operationID,"staged_context_changed"));return}
                        _=try nativeCommandInvoke(run,.consentAttempt(command.original))
                    }else{guard run.child.readBody != nil else{throw Failure.invalid}}
                }
                nativeConsentSend(run)
            }catch{nativeCommandFinish(run,root.unresolved ? .held(run.operationID,"persistence_unconfirmed"):.notApplied("local_unavailable"))}
        }
    }
    private func nativeConsentSend(_ run:NativeCommandRun){
        nativeCommandSnapshot(run){[self] snapshot in
            guard snapshot != nil,snapshot==run.child.snapshot,nativeCommandCurrent(run) else{nativeCommandFinish(run,.held(run.operationID,"context_changed"));return}
            do{
                let body:Data
                if let command=run.consentCommand{
                    guard let subject=try JSONSerialization.jsonObject(with:snapshot!.subject) as? [String:Any],UUID(uuidString:subject["installationId"] as? String ?? "")==command.scope.installation else{throw Failure.invalid}
                    body=try run.child.reconcile ? MobileCalendarSourceConsent.reconcile(command):command.original
                }else{guard let read=run.child.readBody,let frame=try JSONSerialization.jsonObject(with:read) as? [String:Any],frame["producerPin"] as? [String:String]==MobileCalendarSourceConsent.pin,["describe","inspect"].contains(frame["operation"] as? String ?? "") else{throw Failure.invalid};body=read}
                guard nativeCommandPure(run),run.child.token?.revoked != true else{throw Failure.stale}
                nativeCommandRequest(run,"/api/runtime/v1/mobile-context-policy",method:"POST",body:body){[self] result in
                    guard nativeCommandCurrent(run),case .success(let(data,http))=result,http.statusCode==200 else{nativeCommandFinish(run,run.consentCommand==nil ? .notApplied("read_unavailable"):.held(run.operationID,"transport_or_context"));return}
                    do{
                        let response=try MobileCalendarSourceConsent.response(data,expected:run.consentCommand)
                        if run.consentCommand==nil{
                            switch response{case .descriptor,.status:break;default:nativeCommandFinish(run,.notApplied("read_unavailable"));return}
                            nativeCommandSnapshot(run){[self] after in
                                guard after != nil,after==run.child.snapshot,nativeCommandCurrent(run) else{nativeCommandFinish(run,.notApplied("read_context_changed"));return}
                                nativeCommandFinish(run,.consent(response))
                            };return
                        }
                        switch response{case .reserved,.terminal:break;default:nativeCommandFinish(run,.held(run.operationID,"original_result_unconfirmed"));return}
                        nativeCommandSnapshot(run){[self] after in
                            guard after != nil,after==run.child.snapshot,nativeCommandCurrent(run),let command=run.consentCommand else{nativeCommandFinish(run,.held(run.operationID,"result_context_changed"));return}
                            do{_=try nativeCommandInvoke(run,.consentSettle(command.original,data,run.child.reconcile));nativeCommandFinish(run,.consent(response))}
                            catch{nativeCommandFinish(run,.held(run.operationID,"result_persistence_unconfirmed"))}
                        }
                    }catch{nativeCommandFinish(run,run.consentCommand==nil ? .notApplied("invalid_response"):.held(run.operationID,"original_result_unconfirmed"))}
                }
            }catch{nativeCommandFinish(run,run.consentCommand==nil ? .notApplied("invalid_read"):.held(run.operationID,"staged_context_changed"))}
        }
    }

    func healthNativeConsent(command:MobileHealthSourceConsent.Original?,read:Data?=nil,reconcile:Bool,custody:NativeSharedOutboxOwner.Custody?,owner:AnyObject,current:@escaping()->Bool,makeCurrency:@escaping(NativeCalendarCommandCurrency.Binding)->NativeCalendarCommandCurrency?,completion:@escaping(NativeCommandOutcome)->Void){
        precondition(Thread.isMainThread)
        guard !retired,!root.unresolved,root.available,configuration==nil,admissionRun==nil,calendarRun==nil,calendarReadPermissionRun==nil,permissionRun==nil,permissionReservation==nil else{completion(.held(nativeCommandRun?.operationID,"original_owner_unavailable"));return}
        let child=NativeCommandChild(owner:owner,reconcile:reconcile,current:current,makeCurrency:makeCurrency,completion:completion);child.consentFamily=true;child.healthConsentFamily=true;child.readBody=read
        if let run=nativeCommandRun{
            guard reconcile,read==nil,run.child.healthConsentFamily,run.held,run.child.drained else{completion(.held(run.operationID,"original_owner_busy"));return}
            run.child=child;run.held=false;nativeHealthConsentStart(run);return
        }
        guard reconcile || command != nil || read != nil,!root.busy else{completion(.notApplied("busy_or_invalid"));return}
        if let command{guard command.scope.principal==rootConfiguration.human else{completion(.notApplied("wrong_owner"));return}}
        let run=NativeCommandRun(nil,child);run.healthConsentCommand=command;nativeCommandRun=run
        root.acquireCalendar(custody:custody,drain:{[self] done in calendarDrainRequest=done;pumpCalendarDrain()}){[self] result in
            guard case .success(let lease)=result else{nativeCommandFinish(run,.notApplied("custody_unavailable"));return};run.lease=lease;nativeHealthConsentStart(run)
        }
    }
    private func nativeHealthConsentStart(_ run:NativeCommandRun){
        nativeCommandSnapshot(run){[self] snapshot in
            guard let snapshot else{nativeCommandFinish(run,.held(run.operationID,"context_unavailable"));return};run.child.snapshot=snapshot
            do{
                guard case .pending(let pending)=try nativeCommandInvoke(run,.healthConsentPending) else{throw Failure.invalid}
                if run.child.reconcile{
                    let original:Data
                    if let pending{original=pending.original}
                    else if case .lastTerminal(let stored)=try nativeCommandInvoke(run,.healthConsentLast),let stored{original=stored}
                    else{nativeCommandFinish(run,.notApplied("no_pending_original"));return}
                    let command=try MobileHealthSourceConsent.command(original)
                    guard run.healthConsentCommand==nil || run.healthConsentCommand?.original==original else{throw Failure.stale};run.healthConsentCommand=command
                }else{
                    guard pending==nil else{run.healthConsentCommand=try MobileHealthSourceConsent.command(pending!.original);nativeCommandFinish(run,.held(pending!.operationID,"pending_original"));return}
                    if let command=run.healthConsentCommand{
                        _=try nativeCommandInvoke(run,.healthConsentStage(command.original))
                        guard nativeCommandCurrent(run) else{nativeCommandFinish(run,.held(command.operationID,"staged_context_changed"));return}
                        _=try nativeCommandInvoke(run,.healthConsentAttempt(command.original))
                    }else{guard run.child.readBody != nil else{throw Failure.invalid}}
                }
                nativeHealthConsentSend(run)
            }catch{nativeCommandFinish(run,root.unresolved ? .held(run.operationID,"persistence_unconfirmed"):.notApplied("local_unavailable"))}
        }
    }
    private func nativeHealthConsentSend(_ run:NativeCommandRun){
        nativeCommandSnapshot(run){[self] snapshot in
            guard snapshot != nil,snapshot==run.child.snapshot,nativeCommandCurrent(run) else{nativeCommandFinish(run,.held(run.operationID,"context_changed"));return}
            do{
                let body:Data
                if let command=run.healthConsentCommand{
                    guard let subject=try JSONSerialization.jsonObject(with:snapshot!.subject) as? [String:Any],UUID(uuidString:subject["installationId"] as? String ?? "")==command.scope.installation else{throw Failure.invalid}
                    body=try run.child.reconcile ? MobileHealthSourceConsent.reconcile(command):command.original
                }else{guard let read=run.child.readBody,let frame=try JSONSerialization.jsonObject(with:read) as? [String:Any],frame["producerPin"] as? [String:String]==MobileHealthSourceConsent.pin,["describe","inspect"].contains(frame["operation"] as? String ?? "") else{throw Failure.invalid};body=read}
                guard nativeCommandPure(run),run.child.token?.revoked != true else{throw Failure.stale}
                nativeCommandRequest(run,"/api/runtime/v1/mobile-context-policy",method:"POST",body:body){[self] result in
                    guard nativeCommandCurrent(run),case .success(let(data,http))=result,http.statusCode==200 else{nativeCommandFinish(run,run.healthConsentCommand==nil ? .notApplied("read_unavailable"):.held(run.operationID,"transport_or_context"));return}
                    do{
                        let response=try MobileHealthSourceConsent.response(data,expected:run.healthConsentCommand)
                        if run.healthConsentCommand==nil{
                            switch response{case .descriptor,.status:break;default:nativeCommandFinish(run,.notApplied("read_unavailable"));return}
                            nativeCommandSnapshot(run){[self] after in
                                guard after != nil,after==run.child.snapshot,nativeCommandCurrent(run) else{nativeCommandFinish(run,.notApplied("read_context_changed"));return}
                                nativeCommandFinish(run,.healthConsent(response))
                            };return
                        }
                        switch response{case .reserved,.terminal:break;default:nativeCommandFinish(run,.held(run.operationID,"original_result_unconfirmed"));return}
                        nativeCommandSnapshot(run){[self] after in
                            guard after != nil,after==run.child.snapshot,nativeCommandCurrent(run),let command=run.healthConsentCommand else{nativeCommandFinish(run,.held(run.operationID,"result_context_changed"));return}
                            do{_=try nativeCommandInvoke(run,.healthConsentSettle(command.original,data,run.child.reconcile));nativeCommandFinish(run,.healthConsent(response))}
                            catch{nativeCommandFinish(run,.held(run.operationID,"result_persistence_unconfirmed"))}
                        }
                    }catch{nativeCommandFinish(run,run.healthConsentCommand==nil ? .notApplied("invalid_response"):.held(run.operationID,"original_result_unconfirmed"))}
                }
            }catch{nativeCommandFinish(run,run.healthConsentCommand==nil ? .notApplied("invalid_read"):.held(run.operationID,"staged_context_changed"))}
        }
    }

}

// Explicit in-process updates. No persisted plan, background restoration or new owner.
extension NativeHealthRuntime {
    var observationState:String{
        guard !retired,root.available else{return "unavailable"}
        guard let i=observationInterest else{return observationOperations>0 ? "stopping":"inactive"}
        if !i.current(){return "unavailable"}
        if i.unsupported{return "unsupported"}
        if i.renewRequested || i.renewing || observationLocal != nil || observationOperations>0{return "waiting"}
        return i.armed.count==i.configuration.plans.count && i.catchup.isEmpty ? "armed":"deferred"
    }
    private func observationCurrent(_ i:ObservationInterest)->Bool{
        observationInterest === i && !retired && !root.unresolved && root.available && i.current() &&
        configuration?.matches(i.configuration)==true && knownLocalBinding?.namespace==i.namespace && choiceSourceCurrent
    }
    private func observationIdle(_ i:ObservationInterest)->Bool{
        observationCurrent(i) && current() && root.healthAdmission && !preservesPauseHold && ready && adopted &&
        pending==0 && !settingUp && nativeCommandRun==nil && calendarRun==nil && admissionRun==nil &&
        permissionRun==nil && permissionReservation==nil && calendarReadPermissionRun==nil && !(sessionOwner?.busy ?? false) && observationLocal==nil
    }
    func startObservation(configuration c:Configuration,namespace:UUID,revision:Int,current fresh:@escaping()->Bool)->Bool{
        precondition(Thread.isMainThread)
        guard fresh(),configuration?.matches(c)==true,choiceAdmissionAvailable,ready,adopted,root.healthAdmission,
              knownLocalBinding?.namespace==namespace,!preservesPauseHold,observationOperations==0 else{return false}
        if let i=observationInterest{return i.configuration.matches(c) && i.namespace==namespace && i.revision==revision && i.current()}
        let i=ObservationInterest(c,namespace,revision,fresh);observationInterest=i;queueObservationPump();return true
    }
    func stopObservation(){
        precondition(Thread.isMainThread)
        backgroundEnableCancelled=true;stopBackgroundEffects()
        if savedRememberInFlight{
            savedRememberCancelled=true
            if root.healthIOCurrent{root.fenceHealth();savedStopFence=root.healthGeneration}
        }
        // Fence/cancel the original observation BEFORE entering extensible
        // metadata storage. A write hook cannot deliver a late page ahead of Stop.
        let disableSaved=savedHealthSelection?.updatesEnabled==true
        defer{if disableSaved{protectSavedHealthSelection(disable:true,requireRebind:false)}}
        guard observationInterest != nil else{return}
        observationInterest=nil
        // Never cancel an independent original manual sync merely to stop updates.
        // Full pause/withdrawal still uses the existing stronger collector stop.
        if let local=observationLocal{
            // Stop can reenter INSIDE Core.commit's original storage read after
            // the Collector result check. Revoke the original final IO gate now,
            // without calling a locking Core mutation from its own read frame.
            // Own a reopening right ONLY if this Stop closes an open original
            // Health gate. An existing independent fence is never ours to resume.
            if root.healthIOCurrent{root.fenceHealth();local.stopFence=root.healthGeneration}
            collector?.stop()
        }else{collector?.stopObservationRegistrations()}
    }
    func observationForegroundOpportunity(){
        backgroundOpportunity &+= 1
        guard let i=observationInterest,observationCurrent(i) else{return}
        i.renewRequested=true;i.opportunity.formUnion(i.configuration.plans.map(\.category));queueObservationPump()
    }
    private func queueObservationPump(){
        guard observationInterest != nil,!observationPumpQueued else{return};observationPumpQueued=true
        DispatchQueue.main.async{[weak self] in guard let self else{return};observationPumpQueued=false;pumpObservation()}
    }
    private func observationBegin(){observationOperations+=1;begin()}
    private func observationEnd(){observationOperations-=1;end()}
    private func pumpObservation(){
        guard let i=observationInterest,observationIdle(i),!i.unsupported else{return}
        if i.renewRequested{renewObservation(i);return}
        guard i.proofReady,!i.unsupported else{return}
        if i.armed.isEmpty{armObservation(i)}
        reconcileBackgroundObservation(i)
        guard backgroundCollectionEligible else{return}
        if let category=i.delivery.sorted().first,let sessionOwner{
            i.delivery.remove(category);observationBegin()
            sessionOwner.deliverPending(scope:.init(human:rootConfiguration.human,enrollment:i.configuration.enrollment,endpoint:rootConfiguration.endpoint,category:category)){[self] _ in
                sessionOwner.whenDrained{[self] in observationEnd()}
            };return
        }
        guard observationIdle(i) else{return}
        // Consume one finite opportunity round. More pages remain pending for a
        // later external notification/foreground/manual opportunity, never a timer.
        let selected=i.opportunity;i.opportunity.removeAll()
        if let plan=i.configuration.plans.first(where:{selected.contains($0.category)}){
            i.opportunity.formUnion(selected.subtracting([plan.category]))
            collectObservation(i,plan:plan,allowExistingQueue:true,finishSDK:{})
        }
    }
    private func renewObservation(_ i:ObservationInterest){
        guard observationIdle(i),!i.renewing else{return}
        i.renewing=true;i.renewRequested=false;observationBegin()
        var finished=false
        func finish(_ allowed:Bool){
            guard !finished else{return};finished=true
            DispatchQueue.main.async{[self] in
                i.renewing=false;i.proofReady=allowed && observationCurrent(i)
                // A failed refresh consumes this opportunity. No recursive retry.
                i.renewRequested=false;observationEnd()
            }
        }
        snapshot{[self] before in
            guard observationCurrent(i),case .success(let initial)=before else{finish(false);return}
            NativeHealthPolicy(transport:transport,outbox:outbox,collector:self).readForControl(enrollment:i.configuration.enrollment,expectedEndpoint:rootConfiguration.endpoint){[self] result in
                guard observationCurrent(i),case .success(let proof)=result,proof.permitsCollection,proof.revision==i.revision,
                      proof.sourceNamespace.flatMap(UUID.init(uuidString:))==i.namespace,Set(i.configuration.plans.map(\.category)).isSubset(of:proof.healthKitTypes) else{finish(false);return}
                snapshot{[self] after in
                    guard observationCurrent(i),case .success(let final)=after,initial==final,current() else{finish(false);return}
                    do{
                        try outbox.confirmUnchangedEffectivePolicy(proof:proof,expectedTypes:Set(i.configuration.plans.map(\.category)))
                        guard observationCurrent(i),current() else{finish(false);return};finish(true)
                    }catch{finish(false)}
                }
            }
        }
    }
    private func armObservation(_ i:ObservationInterest){
        guard observationIdle(i),i.proofReady,!i.unsupported,let collector else{return}
        // Preparation/execute/registered callbacks may reenter withdrawal. Keep
        // the original Runtime exclusion through the entire submission unwind.
        observationBegin();defer{observationEnd()}
        for plan in i.configuration.plans{
            guard observationCurrent(i),root.healthAdmission,current(),let ticket=try? outbox.ticket(enrollment:i.configuration.enrollment,type:plan.category),ticket.expectedPolicyRevision==i.revision else{return}
            let accepted=collector.observe(ticket:ticket,plan:plan,background:false,current:{[weak self,weak i] in guard let self,let i else{return false};return self.observationCurrent(i) && self.root.healthAdmission && i.proofReady}){[weak self,weak i] error,done in
                guard let self,let i else{done();return}
                guard error==nil else{done();i.catchup.insert(plan.category);return}
                self.collectObservation(i,plan:plan,finishSDK:done)
            }
            guard observationCurrent(i) else{return}
            if accepted{i.armed.insert(plan.category)}else{i.unsupported=true;collector.stop();i.armed.removeAll();return}
        }
    }
    private func collectObservation(_ i:ObservationInterest,plan:NativeHealthCollectionPlan,allowExistingQueue:Bool=false,finishSDK:@escaping()->Void){
        guard backgroundCollectionEligible,observationIdle(i),i.proofReady,let collector,
              let ticket=try? outbox.ticket(enrollment:i.configuration.enrollment,type:plan.category),ticket.expectedPolicyRevision==i.revision,
              ticket.sourceNamespace==i.namespace.uuidString.lowercased(),observationCurrent(i) else{
            i.catchup.insert(plan.category);finishSDK();return
        }
        i.catchup.remove(plan.category)
        let run=ObservationLocal(i,plan,finishSDK);run.allowExistingQueue=allowExistingQueue;observationLocal=run;observationBegin()
        collector.collect(ticket:ticket,plan:plan,handledChanges:{run.changeCount=$0},current:{[weak self,weak i] in guard let self,let i else{return false};return self.observationCurrent(i) && self.root.healthIOCurrent}){[self] result in
            guard observationLocal === run,!run.reported else{return};run.reported=true
            if case .committed(let more)=result{run.committed=true;if more{i.catchup.insert(plan.category)}}else{i.catchup.insert(plan.category)}
            run.finishNotification()
            collector.whenDrained{[self] in
                guard observationLocal === run else{return}
                if run.committed,(run.changeCount>0 || run.allowExistingQueue),observationCurrent(i),let queue=try? outbox.pending(ticket:ticket,limit:1),!queue.isEmpty,observationCurrent(i){i.delivery.insert(plan.category)}
                // Release only this Stop's temporary Health fence, after the
                // real query and full SDK completion/publication have drained.
                // A later pause/retirement/unknown or another fence wins forever.
                if let fence=run.stopFence,rootConfiguration.protectedAvailable(),
                   root.healthGeneration==fence,!retired,!preservesPauseHold,
                   configuration?.matches(i.configuration)==true,ready,adopted,capturedTransportCurrent(){
                    try? root.resumeHealth()
                }
                observationLocal=nil;observationEnd()
            }
        }
        // SDK submission has FULLY returned. This single logical publication
        // completes a NEVER result's notification without stopping/draining the
        // true query, decrementing its operation, advancing an anchor or sending.
        DispatchQueue.main.async{run.finishNotification()}
    }
}

// Durable local choices and sequential full-withdrawal recovery. These are
// original-owner operations; configuration never substitutes for current policy.
extension NativeHealthRuntime {
    private func finishSavedStopFence(){
        guard let fence=savedStopFence,!savedRememberInFlight,!savedProtectionPending,!root.busy,!root.inStorage else{return};savedStopFence=nil
        if rootConfiguration.protectedAvailable(),root.healthGeneration==fence,!retired,!preservesPauseHold,!savedProtectionUnconfirmed,ready,adopted,capturedTransportCurrent(){try? root.resumeHealth()}
    }
    var savedHealthControlAdmissionAvailable:Bool{root.healthAdmission && (configuration != nil || backgroundRetirementReady)}
    /// Metadata selected by the ORIGINAL Source lookup/opaque choice. This can
    /// ONLY stop/disable that exact current saved choice; never configure/read.
    func stopSavedHealthSelection(_ expected:HealthOutbox.SavedHealthSelection)->Bool{
        guard !retired,root.available,expected.origin==rootConfiguration.origin,expected.human==rootConfiguration.human,expected.endpoint==rootConfiguration.endpoint,
              !expected.requiresRebind,configuration==nil || configuration?.enrollment==expected.enrollment,
              savedHealthSelection==nil || savedHealthSelection==expected else{return false}
        savedHealthSelection=expected
        // Even an already-off preference can have a newer enabling operation
        // in flight. Stop must cancel that original operation, not return early.
        if expected.updatesEnabled && (settingUp || configuration==nil){
            if root.healthIOCurrent{root.fenceHealth();savedStopFence=root.healthGeneration}
        }
        stopObservation();return true
    }
    func adoptSavedHealthLookup(requireSourceRebind:Bool,completion:@escaping(Result<Void,Error>)->Void){
        guard current(),choiceAdmissionAvailable else{completion(.failure(Failure.unavailable));return}
        begin();let result:Result<Void,Error>
        do{_ = try root.savedHealthControl(.adoptSavedLookup(requireSourceRebind:requireSourceRebind));result = .success(())}catch{result = .failure(error)}
        DispatchQueue.main.async{[self] in end();completion(result)}
    }
    func readSavedHealthSelections(completion:@escaping(Result<[HealthOutbox.SavedHealthSelection],Error>)->Void){
        guard current(),choiceAdmissionAvailable else{completion(.failure(Failure.unavailable));return}
        begin()
        let result:Result<[HealthOutbox.SavedHealthSelection],Error>
        do{guard case .selections(let values)=try root.savedHealthControl(.read(origin:rootConfiguration.origin,human:rootConfiguration.human,endpoint:rootConfiguration.endpoint)) else{throw Failure.invalid};result = .success(values)}catch{result = .failure(error)}
        DispatchQueue.main.async{[self] in end();completion(result)}
    }
    func rememberHealthSelection(configuration c:Configuration,namespace:UUID,revision:Int,enabled:Bool,current fresh:@escaping()->Bool,completion:@escaping(Result<HealthOutbox.SavedHealthSelection,Error>)->Void){
        guard fresh(),configuration?.matches(c)==true,choiceAdmissionAvailable,ready,adopted,observationOperations==0,knownLocalBinding?.namespace==namespace,!preservesPauseHold,!savedRememberInFlight,!savedProtectionPending,!savedProtectionUnconfirmed else{completion(.failure(Failure.unavailable));return}
        savedRememberInFlight=true;savedRememberCancelled=false;begin()
        var finished=false
        func usable()->Bool{!self.savedRememberCancelled && fresh() && self.current() && self.configuration?.matches(c)==true && !self.preservesPauseHold}
        func finish(_ result:Result<HealthOutbox.SavedHealthSelection,Error>){
            guard !finished else{return};finished=true
            DispatchQueue.main.async{[self] in
                savedRememberInFlight=false
                if savedRememberCancelled,savedHealthSelection?.updatesEnabled==true{savedDesiredDisable=true}
                if savedDesiredDisable || savedDesiredRebind{protectSavedHealthSelection(disable:savedDesiredDisable,requireRebind:savedDesiredRebind)}
                finishSavedStopFence();end();completion(result)
            }
        }
        let previous:[HealthOutbox.SavedHealthSelection]
        do{guard case .selections(let values)=try root.savedHealthControl(.read(origin:c.origin,human:c.human,endpoint:c.endpoint)) else{throw Failure.invalid};previous=values}catch{finish(.failure(error));return}
        // The original metadata-control publication fully returns before Auth.
        DispatchQueue.main.async{[self] in
            guard usable() else{finish(.failure(Failure.stale));return}
            snapshot{[self] before in
                guard usable(),case .success(let initial)=before else{finish(.failure(Failure.stale));return}
                NativeHealthPolicy(transport:transport,outbox:outbox,collector:self).readForControl(enrollment:c.enrollment,expectedEndpoint:c.endpoint){[self] result in
                    guard usable(),case .success(let proof)=result,proof.permitsCollection,proof.revision==revision,proof.sourceNamespace==namespace.uuidString.lowercased() else{finish(.failure(Failure.stale));return}
                    snapshot{[self] after in
                        do{
                            guard usable(),case .success(let final)=after,initial==final else{throw Failure.stale}
                            try outbox.confirmUnchangedEffectivePolicy(proof:proof,expectedTypes:Set(c.plans.map(\.category)))
                            let plans=try c.plans.map{try HealthOutbox.SavedHealthPlan(category:$0.category,scope:$0.scope,mappingVersion:$0.mappingVersion,start:$0.start,end:$0.end)}
                            let old=previous.first{$0.enrollment==c.enrollment}
                            let retainedBackground=old?.backgroundChoice.map{HealthOutbox.SavedHealthBackgroundChoice(enabled:$0.enabled && enabled)}
                            let value=try HealthOutbox.SavedHealthSelection(origin:c.origin,human:c.human,endpoint:c.endpoint,enrollment:c.enrollment,namespace:namespace,policyRevision:revision,plans:plans,updatesEnabled:enabled,backgroundChoice:retainedBackground)
                            guard usable() else{throw Failure.stale}
                            // A different remembered connection is not silently
                            // replaced. It needs its separate explicit review.
                            guard !previous.contains(where:{$0.enrollment != value.enrollment && $0.updatesEnabled && !$0.requiresRebind}) else{throw Failure.unavailable}
                            let expected=previous.first{$0.enrollment==value.enrollment}
                            guard case .saved(let saved)=try root.savedHealthControl(.save(value,expected,proof,nil)) else{throw Failure.invalid}
                            savedHealthSelection=saved // Known invoked write remains known after reentry.
                            finish(.success(saved))
                        }catch{finish(.failure(error))}
                    }
                }
            }
        }
    }
    /// Stop/actual-subject invalidation stores its hold before any extensible
    /// frame. Its closed protective operation can never reenable a preference.
    func protectSavedHealthSelection(disable:Bool,requireRebind:Bool){
        guard disable || requireRebind else{return}
        if requireRebind{ready=false;root.fenceHealth();observationInterest=nil;stopBackgroundEffects()}
        savedDesiredDisable = savedDesiredDisable || disable;savedDesiredRebind = savedDesiredRebind || requireRebind
        guard !savedProtectionPending,!savedProtectionUnconfirmed,let expected=savedHealthSelection else{return}
        savedProtectionPending=true;begin()
        root.afterFrame(.healthSavedSelectionProtection){[self] in
            let applyingDisable=savedDesiredDisable,applyingRebind=savedDesiredRebind
            do{
                guard case .saved(let value)=try root.savedHealthControl(.protect(expected,disable:applyingDisable,requireRebind:applyingRebind)) else{throw Failure.invalid}
                savedHealthSelection=value
                // Preserve a stronger protective intent reentered from the
                // original write; a known invoked success is still known.
                savedDesiredDisable = savedDesiredDisable && !applyingDisable
                savedDesiredRebind = savedDesiredRebind && !applyingRebind
            }catch{savedProtectionUnconfirmed=true}
            savedProtectionPending=false
            // Follow the complete Core/storage/control publication before any
            // lifetime release or callback reporting.
            DispatchQueue.main.async{[self] in
                if !savedProtectionUnconfirmed && (savedDesiredDisable || savedDesiredRebind){protectSavedHealthSelection(disable:savedDesiredDisable,requireRebind:savedDesiredRebind)}
                finishSavedStopFence();end()
            }
        }
    }
    func restoreSavedHealthSelection(_ value:HealthOutbox.SavedHealthSelection,configuration c:Configuration,manual:Bool=false,current fresh:@escaping()->Bool,completion:@escaping(Result<Void,Error>)->Void){
        guard fresh(),choiceAdmissionAvailable,configuration==nil || configuration?.matches(c)==true,current(),!savedProtectionUnconfirmed,!savedProtectionPending,!settingUp,!preservesPauseHold,(manual || value.updatesEnabled),!value.requiresRebind,value.origin==c.origin,value.human==c.human,value.endpoint==c.endpoint,value.enrollment==c.enrollment,
              value.plans.count==c.plans.count,zip(value.plans,c.plans).allSatisfy({a,b in a.category==b.category && a.scope==b.scope && a.mappingVersion==b.mappingVersion && a.start.timeIntervalSince1970.bitPattern==b.start.timeIntervalSince1970.bitPattern && a.end.timeIntervalSince1970.bitPattern==b.end.timeIntervalSince1970.bitPattern}) else{completion(.failure(Failure.unavailable));return}
        do{try attachHealth(c)}catch{completion(.failure(error));return}
        settingUp=true;ready=false;savedHealthSelection=value
        var finished=false
        func usable()->Bool{fresh() && self.current() && !self.retired && !self.savedProtectionUnconfirmed && self.configuration?.matches(c)==true}
        func finish(_ result:Result<Void,Error>){guard !finished else{return};finished=true;settingUp=false;completion(result);publishDrain()}
        snapshot{[self] before in
            guard usable(),case .success(let initial)=before else{finish(.failure(Failure.stale));return}
            NativeHealthPolicy(transport:transport,outbox:outbox,collector:self).readForControl(enrollment:c.enrollment,expectedEndpoint:c.endpoint){[self] result in
                guard usable(),case .success(let proof)=result,proof.permitsCollection,proof.revision==value.policyRevision,proof.sourceNamespace==value.namespace.uuidString.lowercased() else{finish(.failure(Failure.stale));return}
                snapshot{[self] after in
                    do{
                        guard usable(),case .success(let final)=after,initial==final else{throw Failure.stale}
                        if !adopted{try outbox.setHuman(c.human);adopted=true}
                        try outbox.confirmUnchangedEffectivePolicy(proof:proof,expectedTypes:Set(c.plans.map(\.category)))
                        _=try root.savedHealthControl(.check(value,requireUpdatesEnabled:!manual))
                        // SDK factory follows the entire original Core/fence
                        // unwind and control publication, never inside its read.
                        DispatchQueue.main.async{[self] in
                            do{
                                guard usable(),root.healthAdmission else{throw Failure.stale}
                                let sdk=try retainedHealthSDK ?? c.makeSDK()
                                guard usable(),root.healthAdmission else{throw Failure.stale}
                                constructHealth(c,sdk:sdk);knownLocalBinding = .init(namespace:value.namespace,origin:Data(c.origin.utf8),human:c.human,session:c.session,enrollment:c.enrollment,endpoint:c.endpoint);ready=true
                                finish(.success(()))
                            }catch{finish(.failure(error))}
                        }
                    }catch{finish(.failure(error))}
                }
            }
        }
    }
    func retireForSavedHealthRecovery(completion:@escaping()->Void){
        retire(authorityChanged:false){[self] in
            DispatchQueue.main.async{[self] in
                guard backgroundRetirementReady,retired,pending==0,!settingUp,!root.busy,!root.inStorage,!preservesPauseHold,!savedProtectionPending,!savedProtectionUnconfirmed else{return}
                savedRetirementPublished=true;completion()
            }
        }
    }
    func mayReleaseSavedStorage(_ owner:NativeSharedOutboxOwner)->Bool{
        backgroundRetirementReady && root === owner && retired && savedRetirementPublished && !savedResourcesTaken && pending==0 && !settingUp && !root.busy && !root.inStorage && !preservesPauseHold && !savedProtectionPending && !savedProtectionUnconfirmed
    }
    struct RetiredSavedHealthResources{let sdk:(any NativeHealthSDK)?}
    func takeRetiredSavedHealthResources()throws->RetiredSavedHealthResources{
        guard mayReleaseSavedStorage(root) else{throw Failure.unavailable}
        try root.releaseSavedHealthStorage(runtime:self)
        savedResourcesTaken=true;let sdk=retainedHealthSDK;retainedHealthSDK=nil;collector=nil;sessionOwner=nil
        return .init(sdk:sdk)
    }
}

// Background is a separate explicit local scope on the SAME configured owner.
// None of these stored outcomes establishes OS read permission or scheduling.
extension NativeHealthRuntime {
    var backgroundWorkHeld:Bool{
        backgroundPreferencePending || backgroundPreferenceUnconfirmed || backgroundEnabling || collector?.backgroundControlsPending==true ||
        backgroundCategories.values.contains{$0.inFlight != nil || $0.known==nil} || pending>0 || settingUp || hasAdmission || root.busy || root.inStorage || (sessionOwner?.busy ?? false)
    }
    var backgroundRetirementReady:Bool{
        !backgroundPreferencePending && !backgroundPreferenceUnconfirmed && !backgroundEnabling &&
        collector?.backgroundControlsPending != true && backgroundCategories.values.allSatisfy{$0.inFlight==nil && $0.known==false}
    }
    var backgroundMayContinue:Bool{
        !retired && ready && adopted && !savedProtectionUnconfirmed && !backgroundOptOutRequested &&
        savedHealthSelection?.updatesEnabled==true && savedHealthSelection?.requiresRebind==false && savedHealthSelection?.backgroundChoice?.enabled==true
    }
    var backgroundRegistrationState:String{
        if backgroundCategories.values.contains(where:{$0.inFlight==false}){return "pendingDisable"}
        if backgroundCategories.values.contains(where:{$0.inFlight==true}){return "pendingEnable"}
        if backgroundCategories.values.contains(where:{$0.known==nil}){return "unknown"}
        if !backgroundCategories.isEmpty && backgroundCategories.values.allSatisfy({$0.known==false}){return "disabled"}
        if !backgroundCategories.isEmpty && backgroundCategories.values.allSatisfy({$0.known==true}){return "registered"}
        return "notRequested"
    }
    var backgroundPreferenceState:String{
        if backgroundPreferenceUnconfirmed{return "unconfirmed"}
        if backgroundPreferencePending || backgroundEnabling{return "pending"}
        guard let choice=savedHealthSelection?.backgroundChoice else{return "unselected"}
        return choice.enabled ? "enabled":"disabled"
    }
    private var backgroundCollectionEligible:Bool{
        backgroundForeground || (backgroundInactive && backgroundMayContinue &&
            configuration?.plans.allSatisfy{backgroundCategories[$0.category]?.known==true && backgroundCategories[$0.category]?.inFlight==nil}==true)
    }
    func suspendNativeHealthActivity(){backgroundForeground=false;backgroundInactive=false}
    func setNativeHealthActivity(foreground:Bool,eligibleBackground:Bool){
        precondition(Thread.isMainThread);backgroundForeground=foreground;backgroundInactive=eligibleBackground;backgroundOpportunity &+= 1
        if !foreground && !eligibleBackground{stopBackgroundEffects()}
        observationForegroundOpportunity()
    }
    private func reconcileBackgroundObservation(_ interest:ObservationInterest){
        guard observationCurrent(interest) else{return}
        let enable=backgroundMayContinue && interest.proofReady && (backgroundForeground || backgroundInactive)
        if enable{
            for plan in interest.configuration.plans where backgroundCategories[plan.category]==nil{backgroundCategories[plan.category]=BackgroundCategory(plan.category)}
        }
        for value in backgroundCategories.values{
            let next=enable && interest.configuration.plans.contains{$0.category==value.category}
            // A different original intent (renewed current proof after cleanup)
            // is eligible once; unchanged failed intent never self-retries.
            if value.desired != next{value.desired=next;value.lastAttempt = -1}
        }
        pumpBackgroundControls()
    }
    private func stopBackgroundEffects(){
        backgroundOpportunity &+= 1
        for value in backgroundCategories.values{value.desired=false}
        pumpBackgroundControls()
    }
    private func pumpBackgroundControls(){
        guard let collector,!collector.backgroundControlsPending else{return}
        for category in backgroundCategories.keys.sorted(){
            guard let value=backgroundCategories[category],value.inFlight==nil,value.known != value.desired,value.lastAttempt != backgroundOpportunity else{continue}
            let desired=value.desired;value.lastAttempt=backgroundOpportunity;value.inFlight=desired
            let entered=collector.backgroundDelivery(category:category,enabled:desired,current:{[self] in
                // Cleanup stays with this SAME SDK even after full Auth/Root
                // withdrawal. Enable still needs current original admission.
                self.collector === collector && (!desired || (backgroundMayContinue && current() && observationInterest?.proofReady==true))
            }){[self] result in
                guard backgroundCategories[category] === value else{return}
                value.inFlight=nil;value.known=result.success && result.error==nil ? desired:nil
                if desired && !value.desired{value.lastAttempt = -1} // Original queued opt-out, not an automatic retry.
                queueObservationPump()
            }
            if !entered{value.inFlight=nil;value.known=nil}
            return // One entered per-type control on the original SDK at a time.
        }
    }
    /// Explicit off fences eligibility BEFORE metadata or extensible SDK work.
    func disableBackgroundChoice(_ expected:HealthOutbox.SavedHealthSelection){
        guard !retired,expected.origin==rootConfiguration.origin,expected.human==rootConfiguration.human,expected.endpoint==rootConfiguration.endpoint,
              savedHealthSelection==nil || savedHealthSelection==expected else{return}
        backgroundOptOutRequested=true;backgroundEnableCancelled=true;savedHealthSelection=expected
        stopBackgroundEffects()
        guard !backgroundPreferencePending,!backgroundPreferenceUnconfirmed else{return}
        backgroundPreferencePending=true
        root.afterFrame(.healthBackgroundPreferenceProtection){[self] in
            do{
                let latest=savedHealthSelection ?? expected
                guard latest.origin==expected.origin,latest.human==expected.human,latest.endpoint==expected.endpoint,latest.enrollment==expected.enrollment,latest.namespace==expected.namespace,latest.plans==expected.plans,
                      case .saved(let value)=try root.savedHealthControl(.background(latest,enabled:false,proof:nil)) else{throw Failure.invalid}
                savedHealthSelection=value
            }catch{backgroundPreferenceUnconfirmed=true}
            DispatchQueue.main.async{[self] in backgroundPreferencePending=false;publishDrain()}
        }
    }
    func enableBackgroundChoice(_ expected:HealthOutbox.SavedHealthSelection,current fresh:@escaping()->Bool,completion:@escaping(Result<Void,Error>)->Void){
        guard fresh(),choiceAdmissionAvailable,ready,adopted,!backgroundEnabling,!backgroundPreferencePending,!backgroundPreferenceUnconfirmed,
              let c=configuration,savedHealthSelection==expected,expected.updatesEnabled,!expected.requiresRebind else{completion(.failure(Failure.unavailable));return}
        backgroundEnabling=true;backgroundEnableCancelled=false
        func usable()->Bool{fresh() && self.current() && !self.backgroundEnableCancelled && self.savedHealthSelection==expected && self.configuration?.matches(c)==true}
        var finished=false
        func finish(_ result:Result<Void,Error>){
            guard !finished else{return};finished=true
            DispatchQueue.main.async{[self] in
                backgroundEnabling=false
                if backgroundEnableCancelled,let known=savedHealthSelection,known.backgroundChoice?.enabled==true{disableBackgroundChoice(known)}
                if !backgroundEnableCancelled,case .success = result{backgroundOptOutRequested=false;observationForegroundOpportunity()}
                completion(result);publishDrain()
            }
        }
        snapshot{[self] before in
            guard usable(),case .success(let initial)=before else{finish(.failure(Failure.stale));return}
            NativeHealthPolicy(transport:transport,outbox:outbox,collector:self).readForControl(enrollment:expected.enrollment,expectedEndpoint:expected.endpoint){[self] result in
                guard usable(),case .success(let proof)=result,proof.permitsCollection,proof.revision==expected.policyRevision,proof.sourceNamespace==expected.namespace.uuidString.lowercased() else{finish(.failure(Failure.stale));return}
                snapshot{[self] after in
                    do{
                        guard usable(),case .success(let final)=after,initial==final else{throw Failure.stale}
                        try outbox.confirmUnchangedEffectivePolicy(proof:proof,expectedTypes:Set(expected.plans.map(\.category)))
                        guard usable(),case .saved(let known)=try root.savedHealthControl(.background(expected,enabled:true,proof:proof)) else{throw Failure.stale}
                        savedHealthSelection=known // Known invoked write is never masked by Stop reentry.
                        finish(.success(()))
                    }catch{finish(.failure(error))}
                }
            }
        }
    }
    /// Explicitly tagged-off cold scope: no Health status, query, SessionOwner or
    /// collection proof is created. Only this same subject's exact types disable.
    func cleanupSavedBackgroundChoices(_ values:[HealthOutbox.SavedHealthSelection],makeSDK:@escaping()throws->any NativeHealthSDK,completion:@escaping(Result<Void,Error>)->Void){
        guard !retired,current(),choiceAdmissionAvailable,(1...32).contains(values.count),let value=values.first,
              Set(values.map(\.enrollment)).count==values.count,
              values.allSatisfy({!$0.requiresRebind && $0.backgroundChoice?.enabled==false && $0.origin==rootConfiguration.origin && $0.human==rootConfiguration.human && $0.endpoint==rootConfiguration.endpoint}) else{completion(.failure(Failure.unavailable));return}
        let types=Set(values.flatMap{$0.plans.map(\.category)})
        guard !types.isEmpty,types.count<=5,types.isSubset(of:HealthKitCollector.supportedCategories) else{completion(.failure(Failure.invalid));return}
        do{
            guard case .selections(let actual)=try root.savedHealthControl(.read(origin:value.origin,human:value.human,endpoint:value.endpoint)),
                  actual.filter({!$0.requiresRebind && $0.backgroundChoice?.enabled==false})==values,
                  !actual.contains(where:{$0.updatesEnabled && !$0.requiresRebind && $0.backgroundChoice?.enabled==true}) else{throw Failure.stale}
        }catch{completion(.failure(error));return}
        savedHealthSelection=value;begin()
        // The original read/control publication fully returns before this sole
        // SDK factory. Cancellation before entry creates no invented OS effect.
        DispatchQueue.main.async{[self] in
            do{
                guard current(),root.healthAdmission,savedHealthSelection==value else{throw Failure.stale}
                let sdk=try retainedHealthSDK ?? makeSDK();retainedHealthSDK=sdk
                if collector==nil{collector=HealthKitCollector(outbox:outbox,sdk:sdk);collector?.backgroundChanged={[weak self] in self?.pumpBackgroundControls();self?.publishDrain()}}
                // The SDK registration is per type. Coalesce all exact retained
                // off scopes, never just the first enrollment, on this SAME SDK.
                for category in types where backgroundCategories[category]==nil{backgroundCategories[category]=BackgroundCategory(category)}
                backgroundOptOutRequested=true;stopBackgroundEffects();end();completion(.success(()))
            }catch{end();completion(.failure(error))}
        }
    }
}
