import Foundation
import CryptoKit
import AssistantCore
#if os(iOS) && canImport(HealthKit)
import HealthKit
#endif

/// SDK-only port. The actual collector owns tickets, anchors and all outbox writes.
protocol NativeHealthQuery { func stop() }
struct NativeHealthPage {
    let observations: [NativeHealthObservation]
    let deleted: [String]
    let anchor: Data
    let mayHaveMore: Bool
}
struct NativeHealthCollectionPlan: Equatable {
    let category: String, scope: String, mappingVersion: String
    let start: Date, end: Date
    var valid: Bool {
        HealthKitCollector.supportedCategories.contains(category) && start.timeIntervalSince1970.isFinite && end.timeIntervalSince1970.isFinite && end > start && end.timeIntervalSince(start) <= 31 * 86400 && !scope.isEmpty && scope.utf8.count <= 140 && !mappingVersion.isEmpty && mappingVersion.utf8.count <= 64 && !scope.unicodeScalars.contains(where:{$0.value < 32})
    }
    static func ==(lhs:Self,rhs:Self)->Bool {
        lhs.category.utf8.elementsEqual(rhs.category.utf8) && lhs.scope.utf8.elementsEqual(rhs.scope.utf8) && lhs.mappingVersion.utf8.elementsEqual(rhs.mappingVersion.utf8) && lhs.start.timeIntervalSince1970.bitPattern==rhs.start.timeIntervalSince1970.bitPattern && lhs.end.timeIntervalSince1970.bitPattern==rhs.end.timeIntervalSince1970.bitPattern
    }
    var anchorScope: String {
        // Length-framed exact bytes avoid Unicode normalization and delimiter aliases
        // in the protected outbox's existing String-keyed cursor dictionary.
        let fields=[category,scope,mappingVersion,String(start.timeIntervalSince1970.bitPattern,radix:16),String(end.timeIntervalSince1970.bitPattern,radix:16)]
        var input=Data("native-health-plan/1|".utf8)
        for field in fields {input.append(Data("\(field.utf8.count):".utf8));input.append(contentsOf:field.utf8)}
        return "native-health-plan/1:"+SHA256.hash(data:input).map{String(format:"%02x",$0)}.joined()
    }
}
protocol NativeHealthSDK {
    var available: Bool { get }
    func query(plan: NativeHealthCollectionPlan, anchor: Data?, completion: @escaping (Result<NativeHealthPage, Error>) -> Void) throws -> any NativeHealthQuery
    func prepareReadAuthorization(types:Set<String>)->NativeHealthAuthorizationDelegate?
    func prepareObservation(plan:NativeHealthCollectionPlan,background:Bool)->NativeHealthObservationDelegate?
    func prepareBackgroundDelivery(category:String,enabled:Bool)->NativeHealthBackgroundDelegate?
}
/// Preparation is not execution. Submission returns the original SDK query;
/// notifications supply no samples/authority and own an exactly-once completion.
typealias NativeHealthObservationDelegate = (@escaping (Error?,@escaping()->Void)->Void,@escaping(Bool)->Void)->any NativeHealthQuery
struct NativeHealthBackgroundResult {let success:Bool,error:Error?}
typealias NativeHealthBackgroundDelegate = (@escaping(NativeHealthBackgroundResult)->Void)->Void
typealias NativeHealthAuthorizationDelegate = (@escaping(Result<Void,Error>)->Void)->Void
extension NativeHealthSDK {
    func prepareReadAuthorization(types:Set<String>)->NativeHealthAuthorizationDelegate?{nil}
    func prepareObservation(plan:NativeHealthCollectionPlan,background:Bool)->NativeHealthObservationDelegate?{nil}
    func prepareBackgroundDelivery(category:String,enabled:Bool)->NativeHealthBackgroundDelegate?{nil}
}

/// The same preparation/effect boundary is used by the production SDK adapter
/// and low-level offline delegates. No preparation runs inside the delegate.
enum NativeHealthAuthorizationBoundary {
    final class Invocation {fileprivate(set) var entered=false}
    enum Start {case entered,unsupported,notInvoked}
    static func request(sdk:any NativeHealthSDK,types:Set<String>,invocation:Invocation,verify:()->Bool,current:()->Bool,completion:@escaping(Result<Void,Error>)->Void)->Start {
        let delegate=sdk.prepareReadAuthorization(types:types)
        guard current() else{return .notInvoked}
        guard let delegate else{return .unsupported}
        let verified=verify() // May read storage: finish its entire unwind first.
        guard verified,current() else{return .notInvoked}
        invocation.entered=true // Stored fact, not an extensible callback.
        delegate(completion)
        return .entered
    }
}

/// Construction is inert. This is the single collector for the supplied outbox.
final class HealthKitCollector: NativeHealthPolicySuspending {
    enum CollectionResult { case committed(mayHaveMore: Bool), unavailable, deferred, invalid }
    enum PermissionResult { case requestCompletedReadNotObservable, notInvoked, unsupported, deferred }
    static let supportedCategories: Set<String> = ["sleep","heartRate","restingHeartRate","respiratoryRate","hrvSDNN"]
    let outbox: HealthOutbox
    private let sdk: any NativeHealthSDK
    private final class Observation {
        let key:String,epoch:UInt64,current:()->Bool
        var stopped=false,query:(any NativeHealthQuery)?
        var completions:[UUID:()->Void]=[:]
        init(_ key:String,_ epoch:UInt64,_ current:@escaping()->Bool){self.key=key;self.epoch=epoch;self.current=current}
    }
    private var observations:[UUID:Observation]=[:]
    private var observerSubmitDepth=0,observerFrames=0
    private final class BackgroundEffect {let id=UUID();var claimed=false}
    private var backgroundEffects:[UUID:BackgroundEffect]=[:]
    private var backgroundSubmitDepth=0,backgroundPublishing=0
    private var backgroundWaiters:[()->Void]=[]
    var backgroundChanged:(()->Void)?
    var backgroundControlsPending:Bool{!backgroundEffects.isEmpty || backgroundSubmitDepth>0 || backgroundPublishing>0}
    func whenBackgroundControlsDrained(_ done:@escaping()->Void){backgroundWaiters.append(done);publishBackgroundDrain()}
    private func publishBackgroundDrain(){
        guard !backgroundControlsPending else{return}
        DispatchQueue.main.async{[self] in
            guard !backgroundControlsPending else{return}
            let callbacks=backgroundWaiters;backgroundWaiters=[];callbacks.forEach{$0()}
        }
    }
    /// Separate from ordinary query drain. A NEVER registration result retains
    /// the SAME SDK lifetime, without holding an independent manual query ACK.
    @discardableResult func backgroundDelivery(category:String,enabled:Bool,current:()->Bool,result:@escaping(NativeHealthBackgroundResult)->Void)->Bool{
        precondition(Thread.isMainThread)
        guard Self.supportedCategories.contains(category),current(),let submit=sdk.prepareBackgroundDelivery(category:category,enabled:enabled),current() else{return false}
        let run=BackgroundEffect();backgroundEffects[run.id]=run;backgroundSubmitDepth+=1
        defer{backgroundSubmitDepth-=1;publishBackgroundDrain();backgroundChanged?()}
        submit{[self] value in
            // Production adapter normalizes SDK callbacks to the main queue.
            // Do not mask a known SDK success because currentness was withdrawn.
            DispatchQueue.main.async{[self] in
                guard backgroundEffects[run.id] === run,!run.claimed else{return};run.claimed=true
                backgroundPublishing+=1
                result(value)
                backgroundPublishing-=1
                // Entire original result/publication return precedes release.
                DispatchQueue.main.async{[self] in backgroundEffects.removeValue(forKey:run.id);publishBackgroundDrain();backgroundChanged?()}
            }
        }
        return true
    }
    var observationWillStop:(()->Void)?
    private(set) var mayHaveMore=false
    private var generation: UInt64 = 0
    private struct Pending { var query: (any NativeHealthQuery)?; let finish: (CollectionResult) -> Void }
    private var active: [UUID:Pending] = [:]
    private var outstanding = Set<UUID>()
    private final class Permission {
        let id=UUID(),invocation=NativeHealthAuthorizationBoundary.Invocation()
        var cancelled=false,claimed=false
    }
    private var permission:Permission?
    private var drainWaiters: [() -> Void] = []
    private var drainScheduled = false
    init(outbox: HealthOutbox, sdk: any NativeHealthSDK) { self.outbox=outbox;self.sdk=sdk }
    func whenDrained(_ done: @escaping () -> Void) {
        precondition(Thread.isMainThread);drainWaiters.append(done);publishDrain()
    }
    private func publishDrain() {
        guard outstanding.isEmpty,observerSubmitDepth==0,observerFrames==0, !drainScheduled else { return };drainScheduled=true
        DispatchQueue.main.async { [self] in
            drainScheduled=false;guard outstanding.isEmpty,observerSubmitDepth==0,observerFrames==0 else{return}
            let callbacks=drainWaiters;drainWaiters.removeAll();callbacks.forEach{$0()}
        }
    }
    func transitionHuman(_ human: UUID?) throws { stop();try outbox.setHuman(human) }
    func suspendForPolicyRefresh(enrollment: UUID) { stop();outbox.invalidatePolicy(enrollment:enrollment) }
    func pause(enrollment: UUID) throws { stop();try outbox.pause(enrollment:enrollment) }
    func narrow(enrollment: UUID, types: Set<String>) throws { stop();try outbox.narrow(enrollment:enrollment,types:types) }
    func stop() {
        precondition(Thread.isMainThread);observationWillStop?();generation &+= 1
        permission?.cancelled=true // An entered OS request has no synthetic stop.
        let old=active;active.removeAll()
        stopObservationRegistrations()
        for value in old.values { value.query?.stop();value.finish(.deferred) }
        // Outstanding callbacks remain owned even if the SDK never calls back.
        publishDrain()
    }
    func stopObservationRegistrations(){
        precondition(Thread.isMainThread);observerSubmitDepth+=1
        defer{observerSubmitDepth-=1;publishDrain()}
        let observing=observations;observations.removeAll()
        for run in observing.values{run.stopped=true;run.query?.stop();Array(run.completions.values).forEach{$0()}}
    }
    /// Uses the same SDK, ticket and original Root storage. Passive registration
    /// is not a drain obligation; entered submission/notification/query frames are.
    func observe(ticket:HealthCollectionTicket,plan:NativeHealthCollectionPlan,background:Bool=false,current:@escaping()->Bool,registered:@escaping(Bool)->Void={_ in},receive:@escaping(Error?,@escaping()->Void)->Void)->Bool{
        precondition(Thread.isMainThread)
        let key=ticket.enrollmentId.uuidString+"|"+plan.anchorScope
        guard plan.valid,ticket.category==plan.category,observations.count<32,!observations.values.contains(where:{$0.key==key}),
              let submit=sdk.prepareObservation(plan:plan,background:background),current(),(try? outbox.verify(ticket:ticket)) != nil,current() else{return false}
        let id=UUID(),run=Observation(key,generation,current);observations[id]=run
        observerSubmitDepth+=1
        defer{observerSubmitDepth-=1;publishDrain()}
        let query=submit({[self] error,done in
            let once=HealthObserverCompletion(done)
            DispatchQueue.main.async{[self] in
                guard observations[id] === run,!run.stopped,run.epoch==generation,run.current() else{once.finish();return}
                let notification=UUID();observerFrames+=1
                let finish={ [self] in
                    guard run.completions.removeValue(forKey:notification) != nil else{return}
                    // The SDK completion can reenter withdrawal. Keep the real
                    // entered frame counted until that entire callback returns.
                    once.finish();observerFrames-=1;publishDrain()
                }
                run.completions[notification]=finish
                receive(error,finish)
            }
        },{[self] value in registered(value && observations[id] === run && !run.stopped && run.epoch==generation && run.current())})
        guard observations[id] === run,!run.stopped,run.epoch==generation,run.current() else{query.stop();return false}
        run.query=query;return true
    }
    func requestReadPermission(enrollment:UUID,types:Set<String>,proof:MobileHealthPolicyProof,explicitOwnerAction:Bool,current:@escaping()->Bool,completion:@escaping(PermissionResult)->Void) {
        precondition(Thread.isMainThread)
        guard explicitOwnerAction,!types.isEmpty,types.isSubset(of:Self.supportedCategories),permission==nil,outstanding.isEmpty else{completion(.notInvoked);return}
        let run=Permission(),epoch=generation
        permission=run;outstanding.insert(run.id)
        func pure()->Bool{self.permission === run && !run.cancelled && self.generation==epoch && current()}
        func finish(_ proposed:PermissionResult){
            guard !run.claimed else{return};run.claimed=true
            // Even synchronous SDK callbacks must finish their original handler.
            DispatchQueue.main.async{[self] in
                let usable=pure()
                DispatchQueue.main.async{[self] in
                    guard permission === run else{return}
                    let result:PermissionResult = usable && pure() ? proposed:(run.invocation.entered ? .deferred:.notInvoked)
                    permission=nil;outstanding.remove(run.id)
                    completion(result);publishDrain()
                }
            }
        }
        let start=NativeHealthAuthorizationBoundary.request(sdk:sdk,types:types,invocation:run.invocation,verify:{[self] in
            do{
                // SDK preparation has fully returned. The SAME normal Root's
                // final read gate precedes this memory-only Core publication.
                guard proof.enrollment==enrollment else{throw HealthOutboxError.invalid}
                try outbox.confirmUnchangedEffectivePolicy(proof:proof,expectedTypes:types)
                for type in types{let ticket=try outbox.ticket(enrollment:enrollment,type:type);try outbox.verify(ticket:ticket)}
                return true
            }catch{return false}
        },current:pure){result in
            // SDK completions may arrive on any queue. Claim on the original actor.
            DispatchQueue.main.async{
                finish((try? result.get()) != nil ? .requestCompletedReadNotObservable:.deferred)
            }
        }
        switch start{case .entered:break;case .unsupported:finish(.unsupported);case .notInvoked:finish(.notInvoked)}
    }
    func collect(ticket: HealthCollectionTicket, plan: NativeHealthCollectionPlan, handledChanges:@escaping(Int)->Void = {_ in}, current:@escaping()->Bool = {true}, completion: @escaping (CollectionResult) -> Void) {
        precondition(Thread.isMainThread)
        let submittedGeneration=generation
        guard plan.valid, plan.category == ticket.category else {completion(.invalid);return}
        guard sdk.available else{completion(.unavailable);return}
        guard submittedGeneration==generation,current() else{completion(.deferred);return}
        guard outstanding.count < 8 else{completion(.deferred);return}
        let anchor:Data?
        do {guard try outbox.ticket(enrollment:ticket.enrollmentId,type:plan.category) == ticket else{throw HealthOutboxError.disabled};anchor=try outbox.anchor(for:plan.anchorScope,ticket:ticket)}catch{completion(.deferred);return}
        guard submittedGeneration==generation,current() else{completion(.deferred);return}
        let id=UUID(),epoch=generation
        var finished=false
        let finish:(CollectionResult)->Void={ result in guard !finished else{return};finished=true;completion(result) }
        outstanding.insert(id);active[id]=Pending(query:nil,finish:finish)
        do {
            let query=try sdk.query(plan:plan,anchor:anchor){ [self] result in
                DispatchQueue.main.async { [self] in
                    guard outstanding.contains(id) else{return}
                    defer { outstanding.remove(id);publishDrain() }
                    active.removeValue(forKey:id)
                    guard generation == epoch,current() else{finish(.deferred);return}
                    do {
                        let page=try result.get()
                        guard page.observations.count+page.deleted.count <= 1024, page.anchor.count <= 65536 else{throw HealthOutboxError.capacity}
                        let additions=try page.observations.map { observation -> HealthChange in
                            guard observation.category == plan.category else{throw HealthOutboxError.invalid}
                            return HealthChange(upstreamId:observation.upstreamId,operation:.upsert,body:try JSONEncoder().encode(observation),expectedPolicyRevision:ticket.expectedPolicyRevision,mappingVersion:plan.mappingVersion)
                        }
                        let removals=page.deleted.map{HealthChange(upstreamId:$0,operation:.delete,body:nil,expectedPolicyRevision:ticket.expectedPolicyRevision,mappingVersion:plan.mappingVersion)}
                        try outbox.commit(scope:plan.anchorScope,expectedAnchor:anchor,nextAnchor:page.anchor,changes:additions+removals,ticket:ticket)
                        mayHaveMore=page.mayHaveMore
                        handledChanges(additions.count+removals.count)
                        finish(.committed(mayHaveMore:page.mayHaveMore))
                    }catch{finish(.deferred)}
                }
            }
            if active[id] != nil {active[id]?.query=query}else{query.stop()}
        }catch{active.removeValue(forKey:id);outstanding.remove(id);finish(.deferred);publishDrain()}
    }
}

#if os(iOS) && canImport(HealthKit)
extension HealthKitCollector {
    convenience init(health: HKHealthStore, outbox: HealthOutbox) {self.init(outbox:outbox,sdk:HealthKitSDK(health:health))}
    func collect(type:HKSampleType,category:String,enrollment:UUID,scope:String,start:Date,end:Date,mappingVersion:String,completion:@escaping(CollectionResult)->Void) {
        guard HealthKitSDK.sampleType(category)?.identifier==type.identifier,let ticket=try? outbox.ticket(enrollment:enrollment,type:category) else{completion(.deferred);return}
        collect(ticket:ticket,plan:NativeHealthCollectionPlan(category:category,scope:scope,mappingVersion:mappingVersion,start:start,end:end),completion:completion)
    }
    /// Legacy explicit entry delegates to the same typed SDK/collector owner.
    /// The production Runtime's separately enabled path always requests foreground only.
    func observe(type:HKSampleType,category:String,enrollment:UUID,scope:String,start:Date,end:Date,mappingVersion:String,background:Bool,catchUpNeeded:@escaping()->Void,registered:@escaping(Bool)->Void){
        guard HealthKitSDK.sampleType(category)?.identifier==type.identifier,let ticket=try? outbox.ticket(enrollment:enrollment,type:category) else{registered(false);return}
        let plan=NativeHealthCollectionPlan(category:category,scope:scope,mappingVersion:mappingVersion,start:start,end:end)
        let submitted=observe(ticket:ticket,plan:plan,background:background,current:{true},registered:registered){[self] error,done in
            guard error==nil else{done();return}
            collect(ticket:ticket,plan:plan){result in done();if case .committed(mayHaveMore:true)=result{catchUpNeeded()}}
        }
        if !submitted{registered(false)}
    }

}
private final class HealthKitQuery: NativeHealthQuery {
    let health:HKHealthStore,query:HKQuery
    init(_ health:HKHealthStore,_ query:HKQuery){self.health=health;self.query=query}
    func stop(){health.stop(query)}
}
final class HealthKitSDK: NativeHealthSDK {
    fileprivate let health:HKHealthStore
    init(health:HKHealthStore){self.health=health}
    var available:Bool{HKHealthStore.isHealthDataAvailable()}
    func prepareReadAuthorization(types:Set<String>)->NativeHealthAuthorizationDelegate? {
        guard available else{return nil}
        let mapped=types.compactMap{Self.sampleType($0)}
        guard mapped.count==types.count else{return nil}
        let health=self.health
        return {done in
            health.requestAuthorization(toShare:[],read:Set(mapped)){success,error in
                if success,error==nil{done(.success(()))}else{done(.failure(error ?? HealthOutboxError.disabled))}
            }
        }
    }
    func prepareObservation(plan:NativeHealthCollectionPlan,background:Bool)->NativeHealthObservationDelegate?{
        guard available,plan.valid,let type=Self.sampleType(plan.category) else{return nil}
        let health=self.health
        return {notification,registered in
            let query=HKObserverQuery(sampleType:type,predicate:HKQuery.predicateForSamples(withStart:plan.start,end:plan.end,options:[])){_,finish,error in notification(error,finish)}
            health.execute(query)
            // Preserves the existing explicit legacy capability. Bounded Runtime
            // calls never request it and do not claim background qualification.
            if background{health.enableBackgroundDelivery(for:type,frequency:.immediate){enabled,_ in DispatchQueue.main.async{registered(enabled)}}}else{registered(true)}
            return HealthKitQuery(health,query)
        }
    }
    func prepareBackgroundDelivery(category:String,enabled:Bool)->NativeHealthBackgroundDelegate?{
        guard let type=Self.sampleType(category) else{return nil}
        let health=self.health
        // A protective disable does not inspect availability or read permission.
        return {done in
            let finish:(Bool,Error?)->Void={success,error in DispatchQueue.main.async{done(.init(success:success,error:error))}}
            if enabled{health.enableBackgroundDelivery(for:type,frequency:.immediate,withCompletion:finish)}
            else{health.disableBackgroundDelivery(for:type,withCompletion:finish)}
        }
    }
    func query(plan:NativeHealthCollectionPlan,anchor:Data?,completion:@escaping(Result<NativeHealthPage,Error>)->Void)throws->any NativeHealthQuery {
        guard let type=Self.sampleType(plan.category) else{throw HealthOutboxError.invalid}
        let previous:HKQueryAnchor?
        if let anchor {guard let value=try NSKeyedUnarchiver.unarchivedObject(ofClass:HKQueryAnchor.self,from:anchor) else{throw HealthOutboxError.corrupt};previous=value}else{previous=nil}
        let query=HKAnchoredObjectQuery(type:type,predicate:HKQuery.predicateForSamples(withStart:plan.start,end:plan.end,options:[]),anchor:previous,limit:512){ _,samples,deleted,next,error in
            do {
                if let error {throw error};guard let next else{throw HealthOutboxError.invalid}
                let observations=try (samples ?? []).map{try Self.map($0,category:plan.category)}
                let data=try NSKeyedArchiver.archivedData(withRootObject:next,requiringSecureCoding:true)
                completion(.success(NativeHealthPage(observations:observations,deleted:(deleted ?? []).map{$0.uuid.uuidString},anchor:data,mayHaveMore:(samples?.count ?? 0)+(deleted?.count ?? 0)>=512)))
            }catch{completion(.failure(error))}
        }
        health.execute(query);return HealthKitQuery(health,query)
    }
    fileprivate static func sampleType(_ category:String) -> HKSampleType? {
        switch category {
        case "sleep": return HKObjectType.categoryType(forIdentifier:.sleepAnalysis)
        case "heartRate": return HKObjectType.quantityType(forIdentifier:.heartRate)
        case "restingHeartRate": return HKObjectType.quantityType(forIdentifier:.restingHeartRate)
        case "respiratoryRate": return HKObjectType.quantityType(forIdentifier:.respiratoryRate)
        case "hrvSDNN": return HKObjectType.quantityType(forIdentifier:.heartRateVariabilitySDNN)
        default: return nil // RMSSD is not substituted with SDNN.
        }
    }
    private static func map(_ sample: HKSample, category: String) throws -> NativeHealthObservation {
        let sleep: HealthSleepValue?, quantity: Double?, unit: String?
        if category == "sleep", let value=sample as? HKCategorySample {
            sleep=HealthSleepValue(nativeValue:value.value); quantity=nil; unit=nil
        } else if let value=sample as? HKQuantitySample {
            let hkUnit: HKUnit
            switch category {
            case "heartRate", "restingHeartRate": hkUnit=HKUnit.count().unitDivided(by:.minute()); unit="bpm"
            case "respiratoryRate": hkUnit=HKUnit.count().unitDivided(by:.minute()); unit="breathsPerMinute"
            case "hrvSDNN": hkUnit=HKUnit.secondUnit(with:.milli); unit="ms"
            default: throw HealthOutboxError.invalid
            }
            guard value.quantity.is(compatibleWith:hkUnit) else { throw HealthOutboxError.invalid }
            let measured=value.quantity.doubleValue(for:hkUnit); guard measured.isFinite else { throw HealthOutboxError.invalid }
            sleep=nil; quantity=measured
        } else { throw HealthOutboxError.invalid }
        return NativeHealthObservation(upstreamId:sample.uuid.uuidString,category:category,start:sample.startDate,end:sample.endDate,nativeSleep:sleep,quantity:quantity,unit:unit,sourceBundle:sample.sourceRevision.source.bundleIdentifier,sourceVersion:sample.sourceRevision.version,deviceName:sample.device?.name,deviceModel:sample.device?.model,sourceTimeZone:sample.metadata?[HKMetadataKeyTimeZone] as? String)
    }}
#endif
