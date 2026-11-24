import Foundation
import CryptoKit

/// Local collector state only. This is not the server ingestion contract.
/// The caller must never put these values into routine diagnostics.
public struct HealthChange: Codable, Equatable {
    public let eventId: UUID
    public let upstreamId: String
    public let operation: Operation
    public let body: Data?
    public let collectedAt: Date
    public let expectedPolicyRevision: Int
    public let mappingVersion: String
    public enum Operation: String, Codable { case upsert, delete }
    public init(eventId: UUID = UUID(), upstreamId: String, operation: Operation, body: Data?, collectedAt: Date = Date(), expectedPolicyRevision: Int, mappingVersion: String) {
        self.eventId = eventId; self.upstreamId = upstreamId; self.operation = operation; self.body = body; self.collectedAt = collectedAt; self.expectedPolicyRevision = expectedPolicyRevision; self.mappingVersion = mappingVersion
    }
}

public struct HealthCollectionTicket: Equatable {
    fileprivate let human: UUID
    fileprivate let enrollment: UUID
    fileprivate let generation: UInt64
    fileprivate let type: String
    fileprivate let proofId: UUID
    public let sourceNamespace: String
    public let expectedPolicyRevision: Int
    public var humanId: UUID { human }
    public var enrollmentId: UUID { enrollment }
    public var category: String { type }
}

/// Owner-scoped counts only; this contains no samples or source identifiers.
/// Calendar ticket cannot be substituted for a HealthKit ticket. It contains no grant by itself.
public struct CalendarCollectionTicket:Equatable {
    fileprivate let human:UUID,enrollment:UUID,generation:UInt64,category:String,proofId:UUID,namespace:UUID,collector:String,revision:Int,endpoint:UUID,bindingDigest:String
    public var enrollmentId:UUID {enrollment};public var categoryName:String {category}
}

public struct HealthOutboxStatus {
    public let pending: Int
    public let quarantined: Int
    public let paused: Bool
    public let requiresRebind: Bool
    public let policyConfirmed: Bool
    public let localChangePending: Bool
}

public enum HealthOutboxError: Error, Equatable {
    case lockedOrUnavailable, corrupt, notEnrolled, ownerChanged, disabled, staleAnchor, invalid, capacity
}

/// Implementations must atomically replace a protected snapshot or throw without changing it.
public protocol HealthSnapshotStorage {
    func read() throws -> Data?
    func replace(_ bytes: Data) throws
}

/// A single file is the transaction boundary for anchors and queued changes.
/// iOS complete file protection intentionally defers collection while locked.
public struct ProtectedHealthFileStorage: HealthSnapshotStorage {
    private let file: URL
    public init(file: URL) { self.file = file }
    public func read() throws -> Data? {
        do { return try Data(contentsOf: file) }
        catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError { return nil }
    }
    public func replace(_ bytes: Data) throws {
        #if os(iOS)
        try bytes.write(to: file, options: [.atomic, .completeFileProtection])
        #else
        try bytes.write(to: file, options: [.atomic])
        #endif
    }
}

/// Internal, per-process admission fence; no HealthKit or network work is started here.
/// A host must call setHuman(nil) whenever its authenticated context is uncertain.
public final class HealthOutbox {
    /// Local configuration only. Exact saved predicates do not assert SDK read
    /// access, current source binding, delivery authority, or a rolling window.
    public struct SavedHealthPlan:Codable,Equatable {
        public let category:String,scope:String,mappingVersion:String,startBits:String,endBits:String
        public init(category:String,scope:String,mappingVersion:String,start:Date,end:Date)throws{
            self.category=category;self.scope=scope;self.mappingVersion=mappingVersion
            startBits=String(format:"%016llx",start.timeIntervalSince1970.bitPattern)
            endBits=String(format:"%016llx",end.timeIntervalSince1970.bitPattern)
            guard valid else{throw HealthOutboxError.invalid}
        }
        public var start:Date{Date(timeIntervalSince1970:Double(bitPattern:UInt64(startBits,radix:16) ?? 0))}
        public var end:Date{Date(timeIntervalSince1970:Double(bitPattern:UInt64(endBits,radix:16) ?? 0))}
        fileprivate var valid:Bool{
            let supported:Set<String>=["sleep","heartRate","restingHeartRate","respiratoryRate","hrvSDNN"]
            guard supported.contains(category),!scope.isEmpty,scope.utf8.count<=140,!scope.unicodeScalars.contains(where:{$0.value<32}),!mappingVersion.isEmpty,mappingVersion.utf8.count<=64,!mappingVersion.unicodeScalars.contains(where:{$0.value<32}),
                  startBits.utf8.count==16,endBits.utf8.count==16,let a=UInt64(startBits,radix:16),let b=UInt64(endBits,radix:16),String(format:"%016llx",a)==startBits,String(format:"%016llx",b)==endBits else{return false}
            let first=Double(bitPattern:a),last=Double(bitPattern:b)
            return first.isFinite && last.isFinite && last>first && last-first<=31*86400
        }
    }
    /// Desired local scope only. Presence survives opt-out for exact-scope cleanup;
    /// it never records an OS grant or successful background registration.
    public struct SavedHealthBackgroundChoice:Codable,Equatable {
        public let format:String
        public var enabled:Bool
        public init(enabled:Bool){format="native-health-background-choice/1";self.enabled=enabled}
        fileprivate var valid:Bool{format=="native-health-background-choice/1"}
    }
    public struct SavedHealthSelection:Codable,Equatable {
        public let origin:String,human:UUID,endpoint:UUID,enrollment:UUID,namespace:UUID,policyRevision:Int,plans:[SavedHealthPlan]
        public var updatesEnabled:Bool,requiresRebind:Bool
        public var backgroundChoice:SavedHealthBackgroundChoice?
        public init(origin:String,human:UUID,endpoint:UUID,enrollment:UUID,namespace:UUID,policyRevision:Int,plans:[SavedHealthPlan],updatesEnabled:Bool,requiresRebind:Bool=false,backgroundChoice:SavedHealthBackgroundChoice?=nil)throws{
            self.origin=origin;self.human=human;self.endpoint=endpoint;self.enrollment=enrollment;self.namespace=namespace;self.policyRevision=policyRevision;self.plans=plans;self.updatesEnabled=updatesEnabled;self.requiresRebind=requiresRebind;self.backgroundChoice=backgroundChoice
            guard valid else{throw HealthOutboxError.invalid}
        }
        fileprivate var valid:Bool{
            guard backgroundChoice.map({$0.valid && (!$0.enabled || (updatesEnabled && !requiresRebind))}) ?? true else{return false}
            guard let url=URL(string:origin),url.scheme=="https",url.host != nil,url.user==nil,url.password==nil,url.query==nil,url.fragment==nil,url.path.isEmpty,url.absoluteString==origin,
                  policyRevision>0,policyRevision<=9_007_199_254_740_991,(1...5).contains(plans.count),Set(plans.map(\.category)).count==plans.count,plans.allSatisfy({$0.valid}) else{return false}
            return true
        }
        fileprivate func sameContext(_ other:Self)->Bool{Data(origin.utf8)==Data(other.origin.utf8) && human==other.human && endpoint==other.endpoint}
    }
    private struct QueuedChange: Codable { var type: String; var change: HealthChange; var quarantined: Bool = false; var quarantineCode: HealthDeliveryCode?; var lastRequeuedProof: UUID? }
    private struct Enrollment: Codable {
        var human: UUID
        var sourceNamespace: String
        var enabledTypes: Set<String>
        var policyRevision: Int
        var paused: Bool
        var requiresRebind: Bool
        var anchors: [String: Data]
        var queue: [QueuedChange]
    }
    private struct CalendarQueued:Codable {var data:Data,eventId:UUID,digest:String,category:String,quarantined:Bool=false,code:String?=nil}
    private struct CalendarEnrollment:Codable {var human:UUID,endpoint:UUID,namespace:UUID,collector:String,revision:Int,categories:Set<String>,paused:Bool,requiresRebind:Bool,checkpoints:[String:Data],queue:[CalendarQueued]}
    private struct ShareRecord:Codable {var human:UUID,endpoint:UUID,namespace:UUID,collector:String,epoch:UInt64,attempt:UUID,receipt:UUID,item:Data,digest:String,bytes:Data,contentDigest:String,length:Int}
    public struct CalendarNativeBinding:Codable,Equatable {
        public let origin:String,principal:UUID,session:UUID,endpoint:UUID
        public init(origin:String,principal:UUID,session:UUID,endpoint:UUID){self.origin=origin;self.principal=principal;self.session=session;self.endpoint=endpoint}
    }
    public struct CalendarNativePending:Codable {
        public let binding:CalendarNativeBinding,original:Data,requestDigest:String,operationID:UUID
        public fileprivate(set) var attempted:Bool
    }
    private struct CalendarNativeTerminal:Codable{let binding:CalendarNativeBinding,original:Data,response:Data}
    private struct CalendarNativeState:Codable {
        var format:String
        var pending:CalendarNativePending?,terminal:CalendarNativeTerminal?
        var consentPending:CalendarNativePending? = nil,consentResult:CalendarNativeTerminal? = nil
        var healthConsentResult:CalendarNativeTerminal? = nil
        var healthControlResult:CalendarNativeTerminal? = nil
        var selections:[UUID:Data]
    }
    private struct Snapshot: Codable { var version: Int = 1; var lastHuman: UUID?; var enrollments: [UUID: Enrollment] = [:]; var calendarEnrollments:[UUID:CalendarEnrollment]? = nil; var shareAssociations:[String:ShareRecord]? = nil;var calendarNative:CalendarNativeState? = nil;var healthSelections:[UUID:SavedHealthSelection]? = nil }

    private let lock = NSLock()
    private let storage: HealthSnapshotStorage
    private let maxBytes: Int
    private let maxEvents: Int
    private var human: UUID?
    private var identityInitialized = false
    private var generation: UInt64 = 0
    private var calendarGeneration:UInt64 = 0
    private var contextReady = false
    private var shareGeneration:UInt64 = 0
    private var shareAuthority:(any OutboxShareAuthority)? = nil
    private var policyReady: Set<UUID> = []
    private var policyProofs: [UUID: UUID] = [:]
    private var pendingPauses: Set<UUID> = []
    private var pendingNarrowings: [UUID: Set<String>] = [:]
    private var calendarProofs:[UUID:UUID]=[:]
    private var calendarBindingDigests:[UUID:String]=[:]

    public init(storage: HealthSnapshotStorage, maxBytes: Int = 8 * 1024 * 1024, maxEvents: Int = 100_000) {
        self.storage = storage; self.maxBytes = maxBytes; self.maxEvents = maxEvents
    }
    /// These entry points require a validated producer policy response bound to current self and endpoint.
    /// The native host must discard proofs whenever its session or endpoint changes.
    public func enroll(proof: MobileHealthPolicyProof, selectedTypes: Set<String>) throws {
        guard proof.permitsCollection,let namespace=proof.sourceNamespace, !selectedTypes.isEmpty,selectedTypes.isSubset(of:proof.healthKitTypes) else { throw HealthOutboxError.disabled }
        try enroll(proof.enrollment,human:proof.principal,enabledTypes:selectedTypes,confirmedPolicyRevision:proof.revision,confirmedSourceNamespace:namespace)
    }
    public func confirmEffectivePolicy(proof: MobileHealthPolicyProof) throws {
        guard proof.permitsCollection,let namespace=proof.sourceNamespace else { invalidatePolicy(enrollment:proof.enrollment);throw HealthOutboxError.disabled }
        try confirmEffectivePolicy(enrollment:proof.enrollment,revision:proof.revision,enabledTypes:proof.healthKitTypes,sourceNamespace:namespace,serverActive:true)
    }
    /// Restore only unchanged, already enrolled Health policy after the control
    /// reader's deliberate fence. OS authorization is separate and unobservable.
    /// This normal-operation read never adopts a human or writes the snapshot.
    public func confirmUnchangedEffectivePolicy(proof:MobileHealthPolicyProof, expectedTypes:Set<String>) throws {
        lock.lock();defer{lock.unlock()}
        generation &+= 1;policyReady.remove(proof.enrollment);policyProofs.removeValue(forKey:proof.enrollment)
        let state=try read()
        let e=try enrollment(proof.enrollment,in:state)
        let expected=Set(expectedTypes.map{Data($0.utf8)}),saved=Set(e.enabledTypes.map{Data($0.utf8)})
        let allowed=Set(proof.healthKitTypes.map{Data($0.utf8)})
        guard identityInitialized,contextReady,human==proof.principal,e.human==proof.principal,proof.permitsCollection,
              let namespace=proof.sourceNamespace,Data(e.sourceNamespace.utf8)==Data(namespace.utf8),e.policyRevision==proof.revision,
              !e.paused,!e.requiresRebind,!pendingPauses.contains(proof.enrollment),pendingNarrowings[proof.enrollment]==nil,
              !expected.isEmpty,expected.count<=32,expected==saved,expected.isSubset(of:allowed) else{throw HealthOutboxError.disabled}
        policyReady.insert(proof.enrollment);policyProofs[proof.enrollment]=UUID()
    }
    /// Clear stale admission before a policy refresh or whenever currentness becomes uncertain.
    public func invalidatePolicy(enrollment: UUID) {
        lock.lock();defer { lock.unlock() };generation &+= 1;policyReady.remove(enrollment);policyProofs.removeValue(forKey:enrollment)
    }
    public func confirmSourceOwner(proof: MobileHealthPolicyProof, explicitOwnerDecision: Bool) throws {
        guard explicitOwnerDecision,proof.sourceBound,let namespace=proof.sourceNamespace else { throw HealthOutboxError.disabled }
        try confirmSourceOwner(enrollment:proof.enrollment,bindingOwner:proof.principal,sourceNamespace:namespace,serverRevision:proof.revision,sourceBound:true)
    }
    public func resume(proof: MobileHealthPolicyProof, selectedTypes: Set<String>) throws {
        guard proof.permitsCollection,let namespace=proof.sourceNamespace else { throw HealthOutboxError.disabled }
        try resume(enrollment:proof.enrollment,revision:proof.revision,selectedTypes:selectedTypes,serverTypes:proof.healthKitTypes,sourceNamespace:namespace,serverActive:true)
    }
    /// A change of human or loss of currentness invalidates every in-flight collector ticket.
    public func setHuman(_ value: UUID?) throws {
        lock.lock(); defer { lock.unlock() }
        identityInitialized = true
        generation &+= 1;calendarGeneration &+= 1;shareGeneration &+= 1 // Authentication transitions invalidate all admission tickets.
        policyReady.removeAll();policyProofs.removeAll();calendarProofs.removeAll();calendarBindingDigests.removeAll() // Authentication transition invalidates both domains.
        human = value; contextReady = false
        guard let value else { return }
        var state = try read()
        if let last = state.lastHuman, last != value {
            for key in state.enrollments.keys { state.enrollments[key]?.requiresRebind = true }
            if state.healthSelections != nil{for key in state.healthSelections!.keys{state.healthSelections?[key]?.requiresRebind=true;if state.healthSelections?[key]?.backgroundChoice != nil{state.healthSelections?[key]?.backgroundChoice?.enabled=false}}}
            if state.calendarEnrollments != nil {for key in state.calendarEnrollments!.keys {state.calendarEnrollments?[key]?.requiresRebind=true}}
        }
        if state.lastHuman != value { state.lastHuman = value; try save(state) }
        contextReady = true
    }
    private func read() throws -> Snapshot {
        let bytes: Data?
        do { bytes = try storage.read() } catch { throw HealthOutboxError.lockedOrUnavailable }
        guard let bytes else { return Snapshot() }
        guard bytes.count<=maxBytes,let state=try? JSONDecoder().decode(Snapshot.self,from:bytes) else{throw HealthOutboxError.corrupt}
        let rawRoot=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any]
        let legacy=rawRoot?["healthSelections"]==nil && state.healthSelections==nil && rawRoot?["calendarNative"]==nil && state.calendarNative==nil && ((state.version==1 && state.calendarEnrollments==nil && state.shareAssociations==nil) || (state.version==2 && state.calendarEnrollments != nil && state.shareAssociations==nil) || (state.version==3 && state.shareAssociations != nil && validShares(state) && shareStructureValid(bytes)))
        let current=rawRoot?["healthSelections"]==nil && state.healthSelections==nil && state.version==4 && state.calendarEnrollments != nil && state.shareAssociations != nil && validShares(state) && shareStructureValid(bytes) && calendarNativeValid(state,bytes)
        let saved=state.version==5 && state.calendarEnrollments != nil && state.shareAssociations != nil && validShares(state) && shareStructureValid(bytes) && savedHealthValid(state,bytes) && (state.calendarNative==nil || calendarNativeValid(state,bytes))
        guard legacy || current || saved else{throw HealthOutboxError.corrupt}
        return state
    }
    private func save(_ state: Snapshot) throws {
        guard let bytes = try? JSONEncoder().encode(state) else { throw HealthOutboxError.invalid }
        guard bytes.count <= maxBytes else { throw HealthOutboxError.capacity }
        if state.version==5{guard savedHealthValid(state,bytes),state.calendarNative==nil || calendarNativeValid(state,bytes) else{throw HealthOutboxError.invalid}}
        shareGeneration &+= 1
        do { try storage.replace(bytes) } catch { throw HealthOutboxError.lockedOrUnavailable }
    }
    private func savedHealthValid(_ state:Snapshot,_ bytes:Data)->Bool{
        guard let selections=state.healthSelections,selections.count<=32,
              let raw=try? JSONSerialization.jsonObject(with:bytes) as? [String:Any],
              MobileCalendarSettingsWire.keys(raw,["version","enrollments","healthSelections"],["lastHuman","calendarEnrollments","shareAssociations","calendarNative"]),
              let list=raw["healthSelections"] as? [Any],list.count==selections.count*2 else{return false}
        var ids=Set<UUID>(),enabled:[SavedHealthSelection]=[]
        for index in stride(from:0,to:list.count,by:2){
            guard let key=list[index] as? String,let id=UUID(uuidString:key),ids.insert(id).inserted,let value=selections[id],value.enrollment==id,value.valid,
                  let record=list[index+1] as? [String:Any],MobileCalendarSettingsWire.keys(record,["origin","human","endpoint","enrollment","namespace","policyRevision","plans","updatesEnabled","requiresRebind"],["backgroundChoice"]),
                  (record["backgroundChoice"]==nil || (record["backgroundChoice"] as? [String:Any]).map{MobileCalendarSettingsWire.keys($0,["format","enabled"])}==true),
                  let plans=record["plans"] as? [[String:Any]],plans.count==value.plans.count,plans.allSatisfy({MobileCalendarSettingsWire.keys($0,["category","scope","mappingVersion","startBits","endBits"])}) else{return false}
            if value.updatesEnabled && !value.requiresRebind{guard !enabled.contains(where:{$0.sameContext(value)}) else{return false};enabled.append(value)}
        }
        return true
    }
    private func savedHealthEnvelope(_ state:inout Snapshot){
        state.version=5
        if state.calendarEnrollments==nil{state.calendarEnrollments=[:]}
        if state.shareAssociations==nil{state.shareAssociations=[:]}
        if state.healthSelections==nil{state.healthSelections=[:]}
    }
    /// Selection metadata only, under the original caller's file/Auth fence.
    /// Does not adopt a Human, publish policy, create SDKs, or return records.
    public func savedHealthSelections(origin:String,human:UUID,endpoint:UUID)throws->[SavedHealthSelection]{
        lock.lock();defer{lock.unlock()}
        let state=try read()
        return (state.healthSelections ?? [:]).values.filter{Data($0.origin.utf8)==Data(origin.utf8) && $0.human==human && $0.endpoint==endpoint}.sorted{$0.enrollment.uuidString<$1.enrollment.uuidString}
    }
    /// Fresh authenticated metadata lookup. No empty file, enrollment, policy or
    /// SDK is created. A known subject transition is persisted in this SAME
    /// snapshot before any remembered choice can become usable again.
    public func adoptSavedHealthLookup(human value:UUID,requireSourceRebind:Bool)throws{
        lock.lock();defer{lock.unlock()}
        var state=try read()
        guard state.healthSelections != nil else{return}
        identityInitialized=true;generation &+= 1;calendarGeneration &+= 1;shareGeneration &+= 1
        policyReady.removeAll();policyProofs.removeAll();calendarProofs.removeAll();calendarBindingDigests.removeAll()
        human=value;contextReady=false
        let changed=requireSourceRebind || (state.lastHuman != nil && state.lastHuman != value)
        if changed{
            for key in state.enrollments.keys{state.enrollments[key]?.requiresRebind=true}
            for key in state.healthSelections!.keys{state.healthSelections?[key]?.requiresRebind=true;if state.healthSelections?[key]?.backgroundChoice != nil{state.healthSelections?[key]?.backgroundChoice?.enabled=false}}
            if state.calendarEnrollments != nil{for key in state.calendarEnrollments!.keys{state.calendarEnrollments?[key]?.requiresRebind=true}}
        }
        if changed || state.lastHuman != value{state.lastHuman=value;try save(state)}
        contextReady=true
    }
    public func saveHealthSelection(_ value:SavedHealthSelection,expected:SavedHealthSelection?,proof:MobileHealthPolicyProof,replacing:SavedHealthSelection?=nil,allowBackgroundChoiceChange:Bool=false)throws{
        lock.lock();defer{lock.unlock()}
        var state=try read();let e=try enrollment(value.enrollment,in:state)
        guard value.valid,!value.requiresRebind,proof.permitsCollection,proof.principal==value.human,proof.enrollment==value.enrollment,proof.endpoint==value.endpoint,proof.sourceNamespace==value.namespace.uuidString.lowercased(),proof.revision==value.policyRevision,
              human==value.human,contextReady,!e.paused,!e.requiresRebind,e.human==value.human,e.sourceNamespace==value.namespace.uuidString.lowercased(),e.policyRevision==value.policyRevision,
              Set(value.plans.map(\.category))==e.enabledTypes,e.enabledTypes.isSubset(of:proof.healthKitTypes),policyReady.contains(value.enrollment),policyProofs[value.enrollment] != nil,!pendingPauses.contains(value.enrollment),pendingNarrowings[value.enrollment]==nil,
              state.healthSelections?[value.enrollment]==expected else{throw HealthOutboxError.disabled}
        if !allowBackgroundChoiceChange,let old=expected?.backgroundChoice{
            // An ordinary foreground writer cannot lose the cleanup tag, inherit
            // it into a different scope, or silently enable background work.
            guard let choice=value.backgroundChoice,choice.format==old.format,
                  choice.enabled==old.enabled || (!choice.enabled && !value.updatesEnabled),
                  (!old.enabled || (expected?.plans==value.plans && expected?.namespace==value.namespace)) else{throw HealthOutboxError.disabled}
        }else if !allowBackgroundChoiceChange{guard value.backgroundChoice==nil else{throw HealthOutboxError.disabled}}
        let others=(state.healthSelections ?? [:]).values.filter{$0.enrollment != value.enrollment && $0.sameContext(value) && $0.updatesEnabled && !$0.requiresRebind}
        if let replacing{guard others.count==1,others[0]==replacing else{throw HealthOutboxError.staleAnchor}}else{guard !value.updatesEnabled || others.isEmpty else{throw HealthOutboxError.disabled}}
        savedHealthEnvelope(&state)
        if var replacing{guard replacing.backgroundChoice?.enabled != true else{throw HealthOutboxError.disabled};replacing.updatesEnabled=false;state.healthSelections?[replacing.enrollment]=replacing}
        state.healthSelections?[value.enrollment]=value
        guard state.healthSelections!.count<=32 else{throw HealthOutboxError.capacity}
        try save(state)
    }
    /// Protective local preference operation only. The ORIGINAL Root must issue
    /// its narrow original-owner control fence; this does not grant normal IO.
    /// Exact expected metadata prevents stale actions from retargeting a choice.
    public func protectHealthSelection(expected:SavedHealthSelection,disable:Bool,requireRebind:Bool)throws->SavedHealthSelection{
        lock.lock();defer{lock.unlock()}
        var state=try read()
        guard expected.valid,var value=state.healthSelections?[expected.enrollment],value==expected,disable || requireRebind else{throw HealthOutboxError.staleAnchor}
        if disable{value.updatesEnabled=false}
        if (disable || requireRebind),value.backgroundChoice != nil{value.backgroundChoice?.enabled=false}
        if requireRebind{
            value.requiresRebind=true;generation &+= 1;policyReady.remove(value.enrollment);policyProofs.removeValue(forKey:value.enrollment)
            if var e=state.enrollments[value.enrollment],e.human==value.human,e.sourceNamespace==value.namespace.uuidString.lowercased(){e.requiresRebind=true;state.enrollments[value.enrollment]=e}
        }
        state.healthSelections?[value.enrollment]=value;try save(state);return value
    }
    /// The original Native owner supplies current proof for widening. A closed
    /// exact-choice opt-out needs no collection grant and cannot read samples.
    public func setHealthBackgroundChoice(expected:SavedHealthSelection,enabled:Bool,proof:MobileHealthPolicyProof?=nil)throws->SavedHealthSelection{
        var value=expected;value.backgroundChoice = .init(enabled:enabled)
        if enabled{
            guard let proof else{throw HealthOutboxError.disabled}
            try checkHealthSavedRecovery(expected)
            try saveHealthSelection(value,expected:expected,proof:proof,allowBackgroundChoiceChange:true)
            return value
        }
        lock.lock();defer{lock.unlock()}
        var state=try read()
        guard expected.valid,value.valid,state.healthSelections?[expected.enrollment]==expected else{throw HealthOutboxError.staleAnchor}
        state.healthSelections?[expected.enrollment]=value;try save(state);return value
    }
    public func checkHealthSavedRecovery(_ value:SavedHealthSelection,requireUpdatesEnabled:Bool=true)throws{
        lock.lock();defer{lock.unlock()}
        let state=try read();let e=try enrollment(value.enrollment,in:state)
        guard state.lastHuman==value.human,state.healthSelections?[value.enrollment]==value,value.valid,(!requireUpdatesEnabled || value.updatesEnabled),!value.requiresRebind,
              policyReady.contains(value.enrollment),policyProofs[value.enrollment] != nil,!pendingPauses.contains(value.enrollment),pendingNarrowings[value.enrollment]==nil,
              e.human==value.human,e.sourceNamespace==value.namespace.uuidString.lowercased(),e.policyRevision==value.policyRevision,Set(value.plans.map(\.category))==e.enabledTypes,!e.paused,!e.requiresRebind,
              state.calendarNative?.pending==nil,state.calendarNative?.consentPending==nil else{throw HealthOutboxError.disabled}
    }
    private func enrollment(_ id: UUID, in state: Snapshot) throws -> Enrollment {
        guard contextReady, let human else { throw HealthOutboxError.ownerChanged }
        guard let e = state.enrollments[id] else { throw HealthOutboxError.notEnrolled }
        guard e.human == human else { throw HealthOutboxError.ownerChanged }
        return e
    }
    /// Called only after explicit owner enrollment and effective policy confirmation.
    /// An existing enrollment cannot be rebound to a different person.
    func enroll(_ id: UUID, human owner: UUID, enabledTypes: Set<String>, confirmedPolicyRevision: Int, confirmedSourceNamespace: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard contextReady, human == owner else { throw HealthOutboxError.ownerChanged }
        guard !confirmedSourceNamespace.isEmpty, confirmedSourceNamespace.utf8.count <= 256, !confirmedSourceNamespace.unicodeScalars.contains(where: { $0.value < 32 }), (0...9007199254740991).contains(confirmedPolicyRevision), !enabledTypes.isEmpty, enabledTypes.count <= 32, enabledTypes.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 128 && !$0.unicodeScalars.contains(where: { $0.value < 32 }) }) else { throw HealthOutboxError.invalid }
        var state = try read()
        if let existing = state.enrollments[id] {
            guard existing.human == owner else { throw HealthOutboxError.ownerChanged }
            throw HealthOutboxError.invalid // enrollment changes must use an explicit, policy-aware path
        }
        state.enrollments[id] = Enrollment(human: owner, sourceNamespace: confirmedSourceNamespace, enabledTypes: enabledTypes, policyRevision: confirmedPolicyRevision, paused: false, requiresRebind: false, anchors: [:], queue: [])
        try save(state); policyReady.insert(id);policyProofs[id]=UUID()
    }
    public func ticket(enrollment id: UUID, type: String) throws -> HealthCollectionTicket {
        lock.lock(); defer { lock.unlock() }
        let e = try enrollment(id, in: read())
        guard policyReady.contains(id), !pendingPauses.contains(id), pendingNarrowings[id]?.contains(type) != false, !e.paused, !e.requiresRebind, e.enabledTypes.contains(type), let human else { throw HealthOutboxError.disabled }
        guard let proofId=policyProofs[id] else { throw HealthOutboxError.disabled }
        return HealthCollectionTicket(human: human, enrollment: id, generation: generation, type: type, proofId:proofId, sourceNamespace: e.sourceNamespace, expectedPolicyRevision: e.policyRevision)
    }
    /// Recheck the local subject, effective-policy proof and restriction fence immediately before work.
    public func verify(ticket: HealthCollectionTicket) throws {
        lock.lock(); defer { lock.unlock() }; _ = try checked(ticket,in:read())
    }
    /// Allows the authenticated owner to see local recovery status while collection is paused.
    public func status(enrollment id: UUID) throws -> HealthOutboxStatus {
        lock.lock();defer { lock.unlock() };let e=try enrollment(id,in:read())
        return HealthOutboxStatus(pending:e.queue.filter { !$0.quarantined }.count,quarantined:e.queue.filter { $0.quarantined }.count,paused:e.paused || pendingPauses.contains(id),requiresRebind:e.requiresRebind,policyConfirmed:policyReady.contains(id),localChangePending:pendingPauses.contains(id) || pendingNarrowings[id] != nil)
    }
    /// Cursor scope includes category/predicate/mapping; the caller creates this opaque key.
    public func anchor(for scope: String, ticket: HealthCollectionTicket) throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        let e = try checked(ticket, in: read()); guard !scope.isEmpty && scope.utf8.count <= 256 && !scope.unicodeScalars.contains(where: { $0.value < 32 }) else { throw HealthOutboxError.invalid }
        return e.anchors[ticket.type + "\u{0}" + scope]
    }
    private func checked(_ ticket: HealthCollectionTicket, in state: Snapshot) throws -> Enrollment {
        guard human == ticket.human, generation == ticket.generation else { throw HealthOutboxError.ownerChanged }
        let e = try enrollment(ticket.enrollment, in: state)
        guard policyReady.contains(ticket.enrollment), policyProofs[ticket.enrollment] == ticket.proofId, !pendingPauses.contains(ticket.enrollment), pendingNarrowings[ticket.enrollment]?.contains(ticket.type) != false, !e.paused, !e.requiresRebind, e.enabledTypes.contains(ticket.type), e.sourceNamespace == ticket.sourceNamespace, e.policyRevision == ticket.expectedPolicyRevision else { throw HealthOutboxError.disabled }
        return e
    }
    /// The old anchor prevents concurrent callbacks from overwriting one another.
    /// Either all events and the next anchor are durable, or neither is committed.
    public func commit(scope: String, expectedAnchor: Data?, nextAnchor: Data, changes: [HealthChange], ticket: HealthCollectionTicket) throws {
        lock.lock(); defer { lock.unlock() }
        var state = try read(); var e = try checked(ticket, in: state)
        guard !scope.isEmpty, scope.utf8.count <= 256, !scope.unicodeScalars.contains(where: { $0.value < 32 }), !nextAnchor.isEmpty, nextAnchor.count <= 65536, changes.count <= 4096 else { throw HealthOutboxError.invalid }
        let anchorKey = ticket.type + "\u{0}" + scope
        guard e.anchors[anchorKey] == expectedAnchor else { throw HealthOutboxError.staleAnchor }
        let known = Set(e.queue.map { $0.change.eventId }); let incoming = Set(changes.map(\.eventId))
        guard incoming.count == changes.count, known.isDisjoint(with: incoming), changes.allSatisfy({ $0.expectedPolicyRevision == ticket.expectedPolicyRevision && !$0.mappingVersion.isEmpty && $0.mappingVersion.utf8.count <= 64 && !$0.mappingVersion.unicodeScalars.contains(where: { $0.value < 32 }) && $0.collectedAt.timeIntervalSince1970.isFinite && !$0.upstreamId.isEmpty && $0.upstreamId.utf8.count <= 256 && (($0.operation == .delete && $0.body == nil) || ($0.operation == .upsert && $0.body != nil && $0.body!.count <= 262144)) }) else { throw HealthOutboxError.invalid }
        guard state.enrollments.values.reduce(0, { $0 + $1.queue.count }) + (state.calendarEnrollments?.values.reduce(0, { $0 + $1.queue.count }) ?? 0) + (state.shareAssociations?.count ?? 0) + changes.count <= maxEvents else { throw HealthOutboxError.capacity }
        e.queue.append(contentsOf: changes.map { QueuedChange(type: ticket.type, change: $0) }); e.anchors[anchorKey] = nextAnchor; state.enrollments[ticket.enrollment] = e
        try save(state)
    }
    public func pending(ticket: HealthCollectionTicket, limit: Int = 64) throws -> [HealthChange] {
        lock.lock(); defer { lock.unlock() }
        let e = try checked(ticket, in: read())
        guard (1...64).contains(limit) else { throw HealthOutboxError.invalid }
        return Array(e.queue.lazy.filter { $0.type == ticket.type && !$0.quarantined }.prefix(limit).map(\.change))
    }
    /// Only IDs durably accepted by the server for this still-current subject may be acknowledged.
    public func acknowledge(ticket: HealthCollectionTicket, eventIds: Set<UUID>) throws {
        lock.lock(); defer { lock.unlock() }
        var state = try read(); var e = try checked(ticket, in: state)
        let allowed = Set(e.queue.filter { $0.type == ticket.type }.map { $0.change.eventId })
        guard eventIds.count <= 64, eventIds.isSubset(of: allowed) else { throw HealthOutboxError.invalid }
        e.queue.removeAll { $0.type == ticket.type && eventIds.contains($0.change.eventId) }
        state.enrollments[ticket.enrollment] = e; try save(state)
    }
    /// Requeue only temporary policy/scope rejections once per fresh current proof.
    /// No event body, source identity, timestamp, or original policy revision is changed.
    public func releaseRecoverable(ticket: HealthCollectionTicket) throws -> Int {
        lock.lock(); defer { lock.unlock() }
        var state=try read();var e=try checked(ticket,in:state);var count=0
        for index in e.queue.indices {
            let q=e.queue[index]
            guard q.type==ticket.type,q.quarantined,q.lastRequeuedProof != ticket.proofId,
                  q.quarantineCode == .scope || q.quarantineCode == .settingsChanged else { continue }
            e.queue[index].quarantined=false;e.queue[index].quarantineCode=nil;e.queue[index].lastRequeuedProof=ticket.proofId;count += 1
        }
        if count>0 { state.enrollments[ticket.enrollment]=e;try save(state) }
        return count
    }
    /// Sanitized counts only; private records do not enter operational diagnostics.
    public func quarantineCounts(ticket: HealthCollectionTicket) throws -> [HealthDeliveryCode:Int] {
        lock.lock(); defer { lock.unlock() }
        let e=try checked(ticket,in:read());var counts:[HealthDeliveryCode:Int]=[:]
        for item in e.queue where item.type == ticket.type && item.quarantined { if let code=item.quarantineCode { counts[code,default:0] += 1 } }
        return counts
    }
    /// Explicit owner resume after a current authenticated server policy receipt.
    /// Existing queued changes retain their original event IDs, body and revision.
    func resume(enrollment id: UUID, revision: Int, selectedTypes: Set<String>, serverTypes: Set<String>, sourceNamespace: String, serverActive: Bool) throws {
        lock.lock(); defer { lock.unlock() }
        generation &+= 1;policyReady.remove(id)
        do {
            var state=try read();var e=try enrollment(id,in:state)
            guard serverActive, !e.requiresRebind, !pendingPauses.contains(id), pendingNarrowings[id] == nil,
                  revision >= e.policyRevision, revision <= 9007199254740991,
                  !selectedTypes.isEmpty, selectedTypes.isSubset(of:serverTypes), e.sourceNamespace == sourceNamespace else { throw HealthOutboxError.disabled }
            e.enabledTypes=selectedTypes;e.policyRevision=revision;e.paused=false;state.enrollments[id]=e;try save(state);policyReady.insert(id);policyProofs[id]=UUID()
        } catch { contextReady=false;throw error }
    }
    /// The host calls only after authenticating the current self and reading effective server policy.
    /// On restart, no collection or delivery is admitted until this confirmation succeeds.
    /// Local narrowing may be stricter than the server grant but can never widen it.
    func confirmEffectivePolicy(enrollment id: UUID, revision: Int, enabledTypes: Set<String>, sourceNamespace: String, serverActive: Bool) throws {
        lock.lock(); defer { lock.unlock() }
        generation &+= 1;policyReady.remove(id);policyProofs.removeValue(forKey:id)
        var state=try read();var e = try enrollment(id, in: state)
        guard serverActive, !e.paused, !e.requiresRebind, revision >= e.policyRevision, revision <= 9007199254740991,
              e.enabledTypes.isSubset(of: enabledTypes), e.sourceNamespace == sourceNamespace, !pendingPauses.contains(id) else { throw HealthOutboxError.disabled }
        if revision != e.policyRevision { e.policyRevision=revision;state.enrollments[id]=e;try save(state) }
        policyReady.insert(id);policyProofs[id]=UUID()
    }
    /// Apply a validated durable receipt atomically; rejected records are kept for owner recovery.
    public func settle(ticket: HealthCollectionTicket, accepted: Set<UUID>, rejected: [UUID: HealthDeliveryCode]) throws {
        lock.lock(); defer { lock.unlock() }
        var state=try read(); var e=try checked(ticket,in:state)
        let eligible=Set(e.queue.filter { $0.type == ticket.type && !$0.quarantined }.map { $0.change.eventId })
        guard accepted.count + rejected.count <= 64, accepted.isDisjoint(with:Set(rejected.keys)), accepted.union(rejected.keys).isSubset(of:eligible), rejected.values.allSatisfy({ [.invalid,.scope,.settingsChanged,.suppressed,.conflict,.quota].contains($0) }) else { throw HealthOutboxError.invalid }
        e.queue.removeAll { $0.type == ticket.type && accepted.contains($0.change.eventId) }
        for index in e.queue.indices where e.queue[index].type == ticket.type && rejected[e.queue[index].change.eventId] != nil { e.queue[index].quarantined = true; e.queue[index].quarantineCode = rejected[e.queue[index].change.eventId]; e.queue[index].lastRequeuedProof = ticket.proofId }
        state.enrollments[ticket.enrollment]=e;try save(state)
    }
    public func quarantinedCount(ticket: HealthCollectionTicket) throws -> Int {
        lock.lock(); defer { lock.unlock() }
        let e=try checked(ticket,in:read());return e.queue.filter { $0.type == ticket.type && $0.quarantined }.count
    }
    /// Local narrowing takes effect before any remote policy round-trip.
    /// This operation cannot grant a new type or resume a paused enrollment.
    public func narrow(enrollment id: UUID, types: Set<String>) throws {
        lock.lock(); defer { lock.unlock() }
        generation &+= 1
        let effective = pendingNarrowings[id].map { $0.intersection(types) } ?? types
        pendingNarrowings[id] = effective
        do {
            guard types == effective else { throw HealthOutboxError.invalid }
            var state = try read(); var e = try enrollment(id, in: state)
            guard !e.requiresRebind, types.isSubset(of: e.enabledTypes) else { throw HealthOutboxError.invalid }
            e.enabledTypes = types; if types.isEmpty { e.paused = true }
            state.enrollments[id] = e; try save(state)
            pendingNarrowings.removeValue(forKey:id)
        } catch { contextReady = false; throw error }
    }
    /// Only an explicit owner decision, confirmed by the server binding, can clear quarantine.
    /// Effective collection policy still requires a separate current confirmation.
    func confirmSourceOwner(enrollment id: UUID, bindingOwner: UUID, sourceNamespace: String, serverRevision: Int, sourceBound: Bool) throws {
        lock.lock(); defer { lock.unlock() }
        var state = try read(); var e = try enrollment(id, in: state)
        guard human == bindingOwner, e.human == bindingOwner, sourceBound, e.sourceNamespace == sourceNamespace, serverRevision >= e.policyRevision, serverRevision <= 9007199254740991 else { throw HealthOutboxError.ownerChanged }
        guard e.requiresRebind else { return }
        e.requiresRebind = false; state.enrollments[id] = e; try save(state); generation &+= 1
    }
    public func pause(enrollment id: UUID) throws {
        lock.lock(); defer { lock.unlock() }
        generation &+= 1; pendingPauses.insert(id)
        do {
            var state = try read(); var e = try enrollment(id, in: state)
            e.paused = true; state.enrollments[id] = e; try save(state)
            pendingPauses.remove(id)
        } catch { contextReady = false; throw error }
    }
    /// First local admission of an already authorized remote Calendar source.
    /// The native owner supplies currentness/exclusion around the original storage;
    /// no callbacks or issuer are supplied to this method. Subject and selection
    /// become durable together. Existing local enrollment is never resumed/rebound.
    public func admitCalendarExistingRemote(proof:MobileCalendarPolicyProof,selectedCategories:Set<String>,nativeSelection:Data?=nil,scopedRun:MobileCalendarSettingsWire.Run?=nil) throws {
        lock.lock();defer{lock.unlock()}
        guard !selectedCategories.isEmpty,selectedCategories.isSubset(of:proof.categories) else{throw HealthOutboxError.disabled}
        guard (!identityInitialized && human == nil && !contextReady) || (identityInitialized && contextReady && human == proof.principal) else{throw HealthOutboxError.ownerChanged}
        var state=try read()
        guard state.lastHuman == nil || state.lastHuman == proof.principal else{throw HealthOutboxError.ownerChanged}
        guard state.enrollments[proof.enrollment] == nil,state.calendarEnrollments?[proof.enrollment] == nil else{throw HealthOutboxError.invalid}
        if state.version == 1{state.version=2}
        if state.calendarEnrollments == nil{state.calendarEnrollments=[:]}
        guard state.calendarNative?.pending==nil,state.calendarNative?.consentPending==nil else{throw HealthOutboxError.disabled}
        if let nativeSelection,let scopedRun{
            guard let stored=state.calendarNative?.terminal,let original=try? MobileCalendarSettingsWire.command(stored.original),let terminal=try? MobileCalendarSettingsWire.terminal(stored.response,original:original),terminal.applied,terminal.current,original.kind=="configure",terminal.enrollment?.id==proof.enrollment,terminal.enrollment?.principal==proof.principal,terminal.enrollment?.endpoint==proof.endpoint,terminal.enrollment?.namespace==proof.namespace,terminal.enrollment?.revision==proof.revision,
                  scopedRun.selection.principal==proof.principal,scopedRun.selection.endpoint==proof.endpoint,scopedRun.selection.enrollment==proof.enrollment,scopedRun.selection.namespace==proof.namespace,scopedRun.selection.revision==proof.revision,let settings=terminal.window,let planned=settings.plan(anchor:scopedRun.anchor,selectedCalendars:scopedRun.selection.calendars.count,limits:.init(maxTotalDays:366,maxScans:8,maxSelectedCalendars:32)!),planned.start==scopedRun.start,planned.end==scopedRun.end,
                  let value=try? MobileCalendarSettingsWire.object(nativeSelection),let selected=try? MobileCalendarSettingsWire.selection(value["identity"]),selected==scopedRun.selection else{throw HealthOutboxError.disabled}
            state.calendarNative!.selections[proof.enrollment]=nativeSelection
        }else{guard nativeSelection==nil,scopedRun==nil else{throw HealthOutboxError.invalid}}
        state.lastHuman=proof.principal
        state.calendarEnrollments?[proof.enrollment]=CalendarEnrollment(human:proof.principal,endpoint:proof.endpoint,namespace:proof.namespace,collector:proof.collector,revision:proof.revision,categories:selectedCategories,paused:false,requiresRebind:false,checkpoints:[:],queue:[])
        if state.version==4 || (state.version==5 && state.calendarNative != nil){guard let encoded=try? JSONEncoder().encode(state),calendarNativeValid(state,encoded) else{throw HealthOutboxError.invalid}}
        try save(state)
        identityInitialized=true;human=proof.principal;contextReady=true
        calendarProofs[proof.enrollment]=UUID();calendarBindingDigests[proof.enrollment]=proof.bindingDigest
    }
    /// Reopen ONLY an unchanged, already saved Calendar binding. This operation
    /// makes no persistent change: the original native owner fences its read.
    /// Native session and configuration are current inputs, never invented
    /// historical fields in the saved snapshot.
    public func reconnectCalendarExistingLocal(proof:MobileCalendarPolicyProof,expectedCategories:Set<String>) throws {
        lock.lock();defer{lock.unlock()}
        guard (!identityInitialized && human == nil && !contextReady) || (identityInitialized && contextReady && human == proof.principal) else{throw HealthOutboxError.ownerChanged}
        calendarProofs.removeValue(forKey:proof.enrollment);calendarBindingDigests.removeValue(forKey:proof.enrollment)
        let state=try read()
        guard state.calendarNative?.pending==nil,state.calendarNative?.consentPending==nil,let last=state.lastHuman,last==proof.principal,state.enrollments[proof.enrollment]==nil,
              let e=state.calendarEnrollments?[proof.enrollment],e.human==proof.principal,e.endpoint==proof.endpoint,e.namespace==proof.namespace,
              Data(e.collector.utf8)==Data(proof.collector.utf8),!e.paused,!e.requiresRebind,e.revision==proof.revision else{throw HealthOutboxError.disabled}
        let expected=Set(expectedCategories.map{Data($0.utf8)}),saved=Set(e.categories.map{Data($0.utf8)}),allowed=Set(proof.categories.map{Data($0.utf8)})
        let supported:Set<Data>=[Data("CalendarEvent".utf8),Data("Task".utf8)]
        guard !expected.isEmpty,expected==saved,expected.isSubset(of:supported),expected.isSubset(of:allowed) else{throw HealthOutboxError.disabled}
        // No callbacks or storage work follows the original fenced read.
        identityInitialized=true;human=proof.principal;contextReady=true
        calendarProofs[proof.enrollment]=UUID();calendarBindingDigests[proof.enrollment]=proof.bindingDigest
    }
    /// First B admission performs the only v1→v2 migration. Proof must come
    /// from the authenticated Calendar policy owner, never HealthKit or an OS permission.
    public func admitCalendar(proof:MobileCalendarPolicyProof)throws {
        lock.lock();defer{lock.unlock()};guard contextReady,human==proof.principal else{throw HealthOutboxError.ownerChanged}
        var state=try read();guard state.calendarNative?.pending==nil,state.calendarNative?.consentPending==nil,state.enrollments[proof.enrollment]==nil,state.calendarEnrollments?[proof.enrollment]==nil else{throw HealthOutboxError.invalid}
        if state.version==1 {state.version=2};if state.calendarEnrollments==nil {state.calendarEnrollments=[:]}
        state.calendarEnrollments?[proof.enrollment]=CalendarEnrollment(human:proof.principal,endpoint:proof.endpoint,namespace:proof.namespace,collector:proof.collector,revision:proof.revision,categories:proof.categories,paused:false,requiresRebind:false,checkpoints:[:],queue:[])
        try save(state);calendarProofs[proof.enrollment]=UUID();calendarBindingDigests[proof.enrollment]=proof.bindingDigest
    }
    /// The authenticated host must call this before every B policy refresh or
    /// whenever currentness is uncertain; unavailable policy cannot leave an old proof live.
    public func invalidateCalendarPolicy(enrollment id:UUID) {
        lock.lock();defer{lock.unlock()};calendarGeneration &+= 1;calendarProofs.removeValue(forKey:id);calendarBindingDigests.removeValue(forKey:id)
    }
    /// Fresh proof restores currentness but cannot broaden locally selected types.
    public func confirmCalendarPolicy(proof:MobileCalendarPolicyProof)throws {
        lock.lock();defer{lock.unlock()};calendarGeneration &+= 1;calendarProofs.removeValue(forKey:proof.enrollment);calendarBindingDigests.removeValue(forKey:proof.enrollment)
        var state=try read();guard state.calendarNative?.pending==nil,state.calendarNative?.consentPending==nil,contextReady,human==proof.principal,var e=state.calendarEnrollments?[proof.enrollment],e.human==proof.principal,e.endpoint==proof.endpoint,e.namespace==proof.namespace,e.collector==proof.collector,!e.paused,!e.requiresRebind,proof.revision>=e.revision else{throw HealthOutboxError.disabled}
        e.categories.formIntersection(proof.categories);e.revision=proof.revision
        for i in e.queue.indices {
            let item=try? MobileCalendarDelivery.item(e.queue[i].data)
            if item == nil || !e.categories.contains(e.queue[i].category) || item?.policyRevision != e.revision {e.queue[i].quarantined=true;e.queue[i].code="settingsChanged"}
        }
        if e.categories.isEmpty {e.paused=true};state.calendarEnrollments?[proof.enrollment]=e;try save(state)
        guard !e.paused else{throw HealthOutboxError.disabled};calendarProofs[proof.enrollment]=UUID();calendarBindingDigests[proof.enrollment]=proof.bindingDigest
    }
    public func calendarTicket(enrollment id:UUID,category:String)throws->CalendarCollectionTicket {
        lock.lock();defer{lock.unlock()};let state=try read();guard state.calendarNative?.pending==nil,state.calendarNative?.consentPending==nil,contextReady,let human,let e=state.calendarEnrollments?[id],e.human==human,!e.paused,!e.requiresRebind,e.categories.contains(category),let proof=calendarProofs[id],let binding=calendarBindingDigests[id] else{throw HealthOutboxError.disabled}
        return CalendarCollectionTicket(human:human,enrollment:id,generation:calendarGeneration,category:category,proofId:proof,namespace:e.namespace,collector:e.collector,revision:e.revision,endpoint:e.endpoint,bindingDigest:binding)
    }
    private func checkedCalendar(_ ticket:CalendarCollectionTicket,in state:Snapshot)throws->CalendarEnrollment {
        guard state.calendarNative?.pending==nil,state.calendarNative?.consentPending==nil,contextReady,human==ticket.human,calendarGeneration==ticket.generation,calendarProofs[ticket.enrollment]==ticket.proofId,calendarBindingDigests[ticket.enrollment]==ticket.bindingDigest,let e=state.calendarEnrollments?[ticket.enrollment],e.human==ticket.human,e.endpoint==ticket.endpoint,e.namespace==ticket.namespace,e.collector==ticket.collector,e.revision==ticket.revision,e.categories.contains(ticket.category),!e.paused,!e.requiresRebind else{throw HealthOutboxError.disabled};return e
    }
    /// Checkpoint names are explicit source/coverage windows, never OS anchors.
    public func calendarCheckpoint(scope:MobileCalendarDelivery.CheckpointScope,ticket:CalendarCollectionTicket)throws->Data? {
        lock.lock();defer{lock.unlock()};let e=try checkedCalendar(ticket,in:read());guard scope.collector==ticket.collector,scope.namespace==ticket.namespace else{throw HealthOutboxError.invalid};return e.checkpoints[ticket.category+"\u{0}"+(try scope.key())]
    }
    public func commitCalendar(scope:MobileCalendarDelivery.CheckpointScope,expectedCheckpoint:Data?,nextCheckpoint:Data,items:[Data],ticket:CalendarCollectionTicket)throws {
        lock.lock();defer{lock.unlock()};var state=try read();var e=try checkedCalendar(ticket,in:state)
        guard scope.collector==ticket.collector,scope.namespace==ticket.namespace,!nextCheckpoint.isEmpty,nextCheckpoint.count<=65536,items.count<=4096 else{throw HealthOutboxError.invalid}
        let key=ticket.category+"\u{0}"+(try scope.key());guard e.checkpoints[key]==expectedCheckpoint else{throw HealthOutboxError.staleAnchor}
        let parsed=try items.map{try MobileCalendarDelivery.item($0)};guard Set(parsed.map(\.eventId)).count==parsed.count,Set(e.queue.map(\.eventId)).isDisjoint(with:Set(parsed.map(\.eventId))),parsed.allSatisfy({$0.enrollmentId==ticket.enrollment && $0.namespace==ticket.namespace && $0.collector==ticket.collector && $0.category==ticket.category && $0.policyRevision==ticket.revision && Data($0.mappingVersion.utf8)==Data(scope.mappingVersion.utf8)}) else{throw HealthOutboxError.invalid}
        let count=state.enrollments.values.reduce(0){$0+$1.queue.count}+(state.calendarEnrollments?.values.reduce(0){$0+$1.queue.count} ?? 0)+(state.shareAssociations?.count ?? 0);guard count+parsed.count<=maxEvents else{throw HealthOutboxError.capacity}
        e.queue.append(contentsOf:parsed.map{CalendarQueued(data:$0.data,eventId:$0.eventId,digest:$0.digest,category:$0.category)});e.checkpoints[key]=nextCheckpoint;state.calendarEnrollments?[ticket.enrollment]=e;try save(state)
    }
    public func pendingCalendar(ticket:CalendarCollectionTicket,limit:Int=64)throws->[Data] {
        lock.lock();defer{lock.unlock()};let e=try checkedCalendar(ticket,in:read());guard (1...64).contains(limit) else{throw HealthOutboxError.invalid};return Array(e.queue.lazy.filter{$0.category==ticket.category && !$0.quarantined}.prefix(limit).map(\.data))
    }
    /// Prove the ENTIRE retained category before exposing any delivery prefix.
    /// Quarantined and later-than-prefix rows are included in the scope check;
    /// no filtering, deletion, replacement, callback or authority mint occurs.
    public func pendingCalendarWithinVerifiedScope(ticket:CalendarCollectionTicket,scope:MobileCalendarSyncScope,limit:Int=64)throws->[Data] {
        lock.lock();defer{lock.unlock()};let e=try checkedCalendar(ticket,in:read())
        guard ticket.category=="CalendarEvent",(1...64).contains(limit),e.queue.filter({$0.category==ticket.category}).allSatisfy({scope.proves($0.data,enrollment:ticket.enrollment,namespace:ticket.namespace)}) else{throw HealthOutboxError.invalid}
        return Array(e.queue.lazy.filter{$0.category==ticket.category && !$0.quarantined}.prefix(limit).map(\.data))
    }
    /// Validate the complete pinned response, IDs, digests and durability before
    /// mutating anything; rejected originals stay quarantined and retries stay queued.
    public func settleCalendar(ticket:CalendarCollectionTicket,submitted:[Data],response:Data)throws {
        lock.lock();defer{lock.unlock()};var state=try read();var e=try checkedCalendar(ticket,in:state);let items=try submitted.map{try MobileCalendarDelivery.item($0)}
        guard !items.isEmpty,items.count<=64,Set(items.map(\.eventId)).count==items.count,items.allSatisfy({item in e.queue.contains(where:{$0.category==ticket.category && !$0.quarantined && $0.eventId==item.eventId && $0.digest==item.digest && $0.data==item.data})}) else{throw HealthOutboxError.invalid}
        let result=try MobileCalendarDelivery.receipts(response,expected:items);e.queue.removeAll{result.accepted.contains($0.eventId)}
        for i in e.queue.indices {if let code=result.rejected[e.queue[i].eventId] {e.queue[i].quarantined=true;e.queue[i].code=code}}
        state.calendarEnrollments?[ticket.enrollment]=e;try save(state)
    }
    public func pauseCalendar(enrollment id:UUID)throws {
        lock.lock();defer{lock.unlock()};calendarGeneration &+= 1;calendarProofs.removeValue(forKey:id);calendarBindingDigests.removeValue(forKey:id)
        do {var state=try read();guard contextReady,let human,var e=state.calendarEnrollments?[id],e.human==human else{throw HealthOutboxError.ownerChanged};e.paused=true;state.calendarEnrollments?[id]=e;try save(state)}catch{contextReady=false;throw error}
    }


    private func calendarNativeBindingValid(_ b:CalendarNativeBinding)->Bool {
        guard let url=URL(string:b.origin),url.scheme=="https",url.host != nil,url.user==nil,url.password==nil,url.query==nil,url.fragment==nil,url.path.isEmpty,url.absoluteString==b.origin else{return false};return true
    }
    private func calendarNativeValid(_ state:Snapshot,_ bytes:Data)->Bool{
        guard let native=state.calendarNative,["CalendarNative/1","CalendarNative/2","CalendarNative/3","CalendarNative/4"].contains(native.format),(native.pending != nil || native.terminal != nil || native.consentPending != nil || native.consentResult != nil || native.healthConsentResult != nil || native.healthControlResult != nil),native.selections.count<=32,let root=try? JSONSerialization.jsonObject(with:bytes) as? [String:Any],let raw=root["calendarNative"] as? [String:Any],MobileCalendarSettingsWire.keys(raw,["format","selections"],native.format=="CalendarNative/1" ? ["pending","terminal"]:native.format=="CalendarNative/2" ? ["pending","terminal","consentPending","consentResult"]:native.format=="CalendarNative/3" ? ["pending","terminal","consentPending","consentResult","healthConsentResult"]:["pending","terminal","consentPending","consentResult","healthConsentResult","healthControlResult"]) else{return false}
        guard native.pending==nil || native.consentPending==nil else{return false}
        if native.format=="CalendarNative/1" && (native.consentPending != nil || native.consentResult != nil){return false}
        if let p=native.consentPending{
            let validOriginal:Bool
            if let command=try? MobileCalendarSourceConsent.command(p.original){validOriginal=command.original==p.original && command.digest==p.requestDigest && command.operationID==p.operationID && command.scope.principal==p.binding.principal}
            else if ["CalendarNative/3","CalendarNative/4"].contains(native.format),let command=try? MobileHealthSourceConsent.command(p.original){validOriginal=command.original==p.original && command.digest==p.requestDigest && command.operationID==p.operationID && command.scope.principal==p.binding.principal}
            else{validOriginal=false}
            guard validOriginal,calendarNativeBindingValid(p.binding),let r=raw["consentPending"] as? [String:Any],MobileCalendarSettingsWire.keys(r,["binding","original","requestDigest","operationID","attempted"]),let binding=r["binding"] as? [String:Any],MobileCalendarSettingsWire.keys(binding,["origin","principal","session","endpoint"]) else{return false}
        }
        if let r=native.healthConsentResult{
            guard ["CalendarNative/3","CalendarNative/4"].contains(native.format),calendarNativeBindingValid(r.binding),let command=try? MobileHealthSourceConsent.command(r.original),command.original==r.original,command.scope.principal==r.binding.principal,let value=try? MobileHealthSourceConsent.response(r.response,expected:command),let rawResult=raw["healthConsentResult"] as? [String:Any],MobileCalendarSettingsWire.keys(rawResult,["binding","original","response"]),let binding=rawResult["binding"] as? [String:Any],MobileCalendarSettingsWire.keys(binding,["origin","principal","session","endpoint"]) else{return false}
            switch value{case .reserved,.terminal:break;default:return false}
        }
        if let r=native.consentResult{
            guard calendarNativeBindingValid(r.binding),let command=try? MobileCalendarSourceConsent.command(r.original),command.original==r.original,command.scope.principal==r.binding.principal,let value=try? MobileCalendarSourceConsent.response(r.response,expected:command),let rawResult=raw["consentResult"] as? [String:Any],MobileCalendarSettingsWire.keys(rawResult,["binding","original","response"]),let binding=rawResult["binding"] as? [String:Any],MobileCalendarSettingsWire.keys(binding,["origin","principal","session","endpoint"]) else{return false}
            switch value{case .reserved,.terminal:break;default:return false}
        }
        if let r=native.healthControlResult{
            guard native.format=="CalendarNative/4",calendarNativeBindingValid(r.binding),let terminal=try? MobileOrdinaryControl.terminalValue(response:r.response,original:r.original),terminal.original.principal==r.binding.principal,terminal.original.endpoint==r.binding.endpoint,
                  let result=raw["healthControlResult"] as? [String:Any],MobileCalendarSettingsWire.keys(result,["binding","original","response"]),let binding=result["binding"] as? [String:Any],MobileCalendarSettingsWire.keys(binding,["origin","principal","session","endpoint"]) else{return false}
        }
        if let p=native.pending{
            let valid:Bool
            if let command=try? MobileCalendarSettingsWire.command(p.original){valid=command.original==p.original && command.operationID==p.operationID && command.requestDigest==p.requestDigest && command.principal==p.binding.principal && command.endpoint==p.binding.endpoint}
            else if native.format=="CalendarNative/4",let command=try? MobileOrdinaryControl.original(p.original){valid=command.operationID==p.operationID && command.digest==p.requestDigest && command.principal==p.binding.principal && command.endpoint==p.binding.endpoint}
            else{valid=false}
            guard valid,calendarNativeBindingValid(p.binding),p.original.count<=65536,let r=raw["pending"] as? [String:Any],MobileCalendarSettingsWire.keys(r,["binding","original","requestDigest","operationID","attempted"]),let binding=r["binding"] as? [String:Any],MobileCalendarSettingsWire.keys(binding,["origin","principal","session","endpoint"]) else{return false}
        }
        if let terminal=native.terminal{
            guard calendarNativeBindingValid(terminal.binding),terminal.response.count<=65536,let command=try? MobileCalendarSettingsWire.command(terminal.original),command.principal==terminal.binding.principal,command.endpoint==terminal.binding.endpoint,(try? MobileCalendarSettingsWire.terminal(terminal.response,original:command)) != nil,let r=raw["terminal"] as? [String:Any],MobileCalendarSettingsWire.keys(r,["binding","original","response"]),let binding=r["binding"] as? [String:Any],MobileCalendarSettingsWire.keys(binding,["origin","principal","session","endpoint"]) else{return false}
        }
        return native.selections.allSatisfy{id,bytes in
            guard let value=try? MobileCalendarSettingsWire.object(bytes),MobileCalendarSettingsWire.keys(value,["identity","capturedSDKDefaultTimeZone","mappingVersion"]),let identity=try? MobileCalendarSettingsWire.selection(value["identity"]),identity.enrollment==id,let zone=value["capturedSDKDefaultTimeZone"] as? String,TimeZone(identifier:zone) != nil,zone.utf8.count<=128,let mapping=value["mappingVersion"] as? String,!mapping.isEmpty,mapping.utf8.count<=64 else{return false};return true
        }
    }
    /// Local custody only; not a terminal/currentness witness. Migration never
    /// creates enrollment rows and never drops any original domain state.
    public func stageCalendarNativeCommand(binding:CalendarNativeBinding,original:Data)throws{
        lock.lock();defer{lock.unlock()};let command=try MobileCalendarSettingsWire.command(original)
        guard calendarNativeBindingValid(binding),command.original==original,command.principal==binding.principal,command.endpoint==binding.endpoint else{throw HealthOutboxError.invalid}
        var state=try read();guard state.lastHuman==nil || state.lastHuman==binding.principal,state.calendarNative?.pending==nil,state.calendarNative?.consentPending==nil else{throw HealthOutboxError.disabled}
        for prior in [state.calendarNative?.terminal,state.calendarNative?.consentResult,state.calendarNative?.healthConsentResult,state.calendarNative?.healthControlResult].compactMap({$0}){guard prior.binding.origin==binding.origin,prior.binding.principal==binding.principal,prior.binding.endpoint==binding.endpoint else{throw HealthOutboxError.ownerChanged}}
        if state.version<4{state.version=4};if state.calendarEnrollments==nil{state.calendarEnrollments=[:]};if state.shareAssociations==nil{state.shareAssociations=[:]};if state.calendarNative==nil{state.calendarNative = .init(format:"CalendarNative/1",pending:nil,terminal:nil,selections:[:])}
        state.lastHuman=binding.principal;state.calendarNative!.pending = .init(binding:binding,original:original,requestDigest:command.requestDigest,operationID:command.operationID,attempted:false)
        try save(state)
    }
    public func markCalendarNativeCommandAttempted(binding:CalendarNativeBinding,original:Data)throws{
        lock.lock();defer{lock.unlock()};var state=try read()
        guard (try? MobileCalendarSettingsWire.command(original)) != nil else{throw HealthOutboxError.disabled}
        guard var pending=state.calendarNative?.pending,pending.binding==binding,pending.original==original,!pending.attempted else{throw HealthOutboxError.disabled}
        pending.attempted=true;state.calendarNative!.pending=pending;try save(state)
    }
    /// A separately authenticated original self may ONLY retrieve the unchanged
    /// original for explicit reconciliation, including after a session restart.
    public func calendarNativeCommandForReconciliation(origin:String,principal:UUID,endpoint:UUID)throws->CalendarNativePending?{
        lock.lock();defer{lock.unlock()};let state=try read()
        guard state.lastHuman==nil || state.lastHuman==principal else{throw HealthOutboxError.ownerChanged}
        guard state.calendarNative?.consentPending==nil else{throw HealthOutboxError.disabled}
        guard let pending=state.calendarNative?.pending else{return nil}
        guard (try? MobileCalendarSettingsWire.command(pending.original)) != nil else{throw HealthOutboxError.disabled}
        guard pending.binding.origin==origin,pending.binding.principal==principal,pending.binding.endpoint==endpoint else{throw HealthOutboxError.ownerChanged};return pending
    }
    /// Historical original only; never a currentness or settlement witness.
    public func calendarNativeLastTerminalForReconciliation(origin:String,principal:UUID,endpoint:UUID)throws->Data?{
        lock.lock();defer{lock.unlock()};let state=try read()
        guard state.lastHuman==nil || state.lastHuman==principal else{throw HealthOutboxError.ownerChanged}
        guard let terminal=state.calendarNative?.terminal else{return nil}
        guard terminal.binding.origin==origin,terminal.binding.principal==principal,terminal.binding.endpoint==endpoint else{throw HealthOutboxError.ownerChanged};return terminal.original
    }
    /// The native ORIGINAL owner must independently qualify authenticated
    /// terminal transport/currentness and BOTH original custody currencies.
    /// Held/observed/inspect cannot construct this exact terminal transition.
    public func settleCalendarNativeCommand(binding:CalendarNativeBinding,terminal:MobileCalendarSettingsWire.Terminal,reconciliation:Bool)throws{
        lock.lock();defer{lock.unlock()};var state=try read()
        guard (try? MobileCalendarSettingsWire.terminal(terminal.response,original:terminal.command)) != nil else{throw HealthOutboxError.disabled}
        if let pending=state.calendarNative?.pending{
            guard pending.original==terminal.command.original,pending.binding.origin==binding.origin,pending.binding.principal==binding.principal,pending.binding.endpoint==binding.endpoint,reconciliation || pending.binding.session==binding.session else{throw HealthOutboxError.disabled}
            state.calendarNative!.terminal = .init(binding:pending.binding,original:pending.original,response:terminal.response);state.calendarNative!.pending=nil
        }else{
            guard reconciliation,let last=state.calendarNative?.terminal,last.original==terminal.command.original,last.binding.origin==binding.origin,last.binding.principal==binding.principal,last.binding.endpoint==binding.endpoint,
                  let old=try? MobileCalendarSettingsWire.object(last.response)["result"] as? [String:Any],let next=try? MobileCalendarSettingsWire.object(terminal.response)["result"] as? [String:Any],
                  try MobileCalendarDelivery.canonical(old["outcome"]!)==MobileCalendarDelivery.canonical(next["outcome"]!),try MobileCalendarDelivery.canonical(old["binding"]!)==MobileCalendarDelivery.canonical(next["binding"]!) else{throw HealthOutboxError.disabled}
            state.calendarNative!.terminal = .init(binding:last.binding,original:last.original,response:terminal.response)
        }
        try save(state)
    }
    /// CalendarNative/2 is deliberately rejected by the prior /1 reader before
    /// any write. It retains the old command terminal/selection and all domains.
    public func stageCalendarSourceConsent(binding:CalendarNativeBinding,original:Data)throws{
        lock.lock();defer{lock.unlock()}
        let command=try MobileCalendarSourceConsent.command(original)
        guard calendarNativeBindingValid(binding),command.original==original,command.scope.principal==binding.principal else{throw HealthOutboxError.invalid}
        var state=try read()
        guard state.lastHuman==nil || state.lastHuman==binding.principal,state.calendarNative?.pending==nil,state.calendarNative?.consentPending==nil else{throw HealthOutboxError.disabled}
        for prior in [state.calendarNative?.terminal,state.calendarNative?.consentResult,state.calendarNative?.healthConsentResult,state.calendarNative?.healthControlResult].compactMap({$0}){
            guard prior.binding.origin==binding.origin,prior.binding.principal==binding.principal,prior.binding.endpoint==binding.endpoint else{throw HealthOutboxError.ownerChanged}
        }
        if command.kind == .approve{
            guard let prior=state.calendarNative?.consentResult,let request=try? MobileCalendarSourceConsent.command(prior.original),case .reserved(let review)=try MobileCalendarSourceConsent.response(prior.response,expected:request),review.approvalAvailable,command.request==request.payload,command.confirmation==review.confirmation else{throw HealthOutboxError.disabled}
        }
        if state.version<4{state.version=4;if state.calendarEnrollments==nil{state.calendarEnrollments=[:]};if state.shareAssociations==nil{state.shareAssociations=[:]}}
        if state.calendarNative==nil{state.calendarNative = .init(format:"CalendarNative/2",pending:nil,terminal:nil,selections:[:])}
        if !["CalendarNative/3","CalendarNative/4"].contains(state.calendarNative!.format){state.calendarNative!.format="CalendarNative/2"};state.lastHuman=binding.principal
        state.calendarNative!.consentPending = .init(binding:binding,original:original,requestDigest:command.digest,operationID:command.operationID,attempted:false)
        try save(state)
    }
    public func markCalendarSourceConsentAttempted(binding:CalendarNativeBinding,original:Data)throws{
        _ = try MobileCalendarSourceConsent.command(original)
        lock.lock();defer{lock.unlock()};var state=try read()
        guard var p=state.calendarNative?.consentPending,p.binding==binding,p.original==original,!p.attempted else{throw HealthOutboxError.disabled}
        p.attempted=true;state.calendarNative!.consentPending=p;try save(state)
    }
    public func calendarSourceConsentPending(origin:String,principal:UUID,endpoint:UUID)throws->CalendarNativePending?{
        lock.lock();defer{lock.unlock()};let state=try read()
        guard state.lastHuman==nil || state.lastHuman==principal,state.calendarNative?.pending==nil else{throw HealthOutboxError.ownerChanged}
        guard let p=state.calendarNative?.consentPending else{return nil}
        guard (try? MobileCalendarSourceConsent.command(p.original)) != nil,p.binding.origin==origin,p.binding.principal==principal,p.binding.endpoint==endpoint else{throw HealthOutboxError.ownerChanged};return p
    }
    public func calendarSourceConsentLastOriginal(origin:String,principal:UUID,endpoint:UUID)throws->Data?{
        lock.lock();defer{lock.unlock()};let state=try read()
        guard state.lastHuman==nil || state.lastHuman==principal,state.calendarNative?.pending==nil else{throw HealthOutboxError.ownerChanged}
        guard let r=state.calendarNative?.consentResult else{return nil}
        guard r.binding.origin==origin,r.binding.principal==principal,r.binding.endpoint==endpoint else{throw HealthOutboxError.ownerChanged};return r.original
    }
    /// Reserved settles ONLY an inert request; it can never settle an approval.
    /// Held/observed/status/descriptor cannot settle any original operation.
    public func settleCalendarSourceConsent(binding:CalendarNativeBinding,original:Data,response:Data,reconciliation:Bool)throws{
        lock.lock();defer{lock.unlock()};var state=try read();let command=try MobileCalendarSourceConsent.command(original)
        let parsed=try MobileCalendarSourceConsent.response(response,expected:command)
        switch parsed{case .reserved,.terminal:break;default:throw HealthOutboxError.disabled}
        guard command.scope.principal==binding.principal,state.calendarNative?.pending==nil else{throw HealthOutboxError.ownerChanged}
        if let pending=state.calendarNative?.consentPending{
            guard pending.attempted,pending.original==original,pending.binding.origin==binding.origin,pending.binding.principal==binding.principal,pending.binding.endpoint==binding.endpoint,reconciliation || pending.binding.session==binding.session else{throw HealthOutboxError.disabled}
            state.calendarNative!.consentResult = .init(binding:pending.binding,original:original,response:response);state.calendarNative!.consentPending=nil
        }else{
            guard reconciliation,let last=state.calendarNative?.consentResult,last.original==original,last.binding.origin==binding.origin,last.binding.principal==binding.principal,last.binding.endpoint==binding.endpoint else{throw HealthOutboxError.disabled}
            // Same reserved review can become unavailable. A terminal's committed
            // receipt and bindings must remain identical across reconciliation.
            let old=try MobileCalendarSourceConsent.response(last.response,expected:command)
            switch(old,parsed){
            case (.reserved,.reserved):break
            case (.terminal,.terminal):
                let a=try MobileCalendarSettingsWire.object(last.response)["result"] as! [String:Any],b=try MobileCalendarSettingsWire.object(response)["result"] as! [String:Any]
                guard try MobileCalendarSourceConsent.canonical(a)==MobileCalendarSourceConsent.canonical(b) else{throw HealthOutboxError.disabled}
            default:throw HealthOutboxError.disabled
            }
            state.calendarNative!.consentResult = .init(binding:last.binding,original:original,response:response)
        }
        try save(state)
    }
    /// Ordinary Health uses the SAME pending slot, with a closed /4 semantic fence.
    /// Its bounded last result never overwrites Calendar or either consent result.
    public func stageHealthControl(binding:CalendarNativeBinding,original:Data)throws{
        let command=try MobileOrdinaryControl.original(original)
        _ = try MobileOrdinaryControl.envelope(original:original,operation:.control)
        lock.lock();defer{lock.unlock()}
        guard calendarNativeBindingValid(binding),command.principal==binding.principal,command.endpoint==binding.endpoint else{throw HealthOutboxError.invalid}
        var state=try read()
        guard state.lastHuman==nil || state.lastHuman==binding.principal,state.calendarNative?.pending==nil,state.calendarNative?.consentPending==nil else{throw HealthOutboxError.disabled}
        for prior in [state.calendarNative?.terminal,state.calendarNative?.consentResult,state.calendarNative?.healthConsentResult,state.calendarNative?.healthControlResult].compactMap({$0}){
            guard prior.binding.origin==binding.origin,prior.binding.principal==binding.principal,prior.binding.endpoint==binding.endpoint else{throw HealthOutboxError.ownerChanged}
        }
        if state.version<4{state.version=4;if state.calendarEnrollments==nil{state.calendarEnrollments=[:]};if state.shareAssociations==nil{state.shareAssociations=[:]}}
        if state.calendarNative==nil{state.calendarNative = .init(format:"CalendarNative/4",pending:nil,terminal:nil,selections:[:])}
        state.calendarNative!.format="CalendarNative/4";state.lastHuman=binding.principal
        state.calendarNative!.pending = .init(binding:binding,original:original,requestDigest:command.digest,operationID:command.operationID,attempted:false)
        try save(state)
    }
    public func markHealthControlAttempted(binding:CalendarNativeBinding,original:Data)throws{
        _ = try MobileOrdinaryControl.original(original)
        lock.lock();defer{lock.unlock()};var state=try read()
        guard var pending=state.calendarNative?.pending,pending.binding==binding,pending.original==original,!pending.attempted else{throw HealthOutboxError.disabled}
        pending.attempted=true;state.calendarNative!.pending=pending;try save(state)
    }
    /// Same-Human cold/changed-endpoint recovery reads ONLY the unchanged original.
    public func healthControlPending(origin:String,principal:UUID)throws->CalendarNativePending?{
        lock.lock();defer{lock.unlock()};let state=try read()
        guard state.lastHuman==nil || state.lastHuman==principal,state.calendarNative?.consentPending==nil else{throw HealthOutboxError.ownerChanged}
        guard let pending=state.calendarNative?.pending else{return nil}
        guard (try? MobileOrdinaryControl.original(pending.original)) != nil,pending.binding.origin==origin,pending.binding.principal==principal else{throw HealthOutboxError.ownerChanged};return pending
    }
    public func healthControlLastOriginal(origin:String,principal:UUID,endpoint:UUID?=nil)throws->Data?{
        lock.lock();defer{lock.unlock()};let state=try read()
        guard state.lastHuman==nil || state.lastHuman==principal,state.calendarNative?.pending==nil,state.calendarNative?.consentPending==nil else{throw HealthOutboxError.ownerChanged}
        guard let last=state.calendarNative?.healthControlResult else{return nil}
        guard last.binding.origin==origin,last.binding.principal==principal,endpoint==nil || last.binding.endpoint==endpoint else{throw HealthOutboxError.ownerChanged};return last.original
    }
    /// ONLY separately qualified read-only reconciliation may publish a terminal.
    public func settleHealthControl(binding:CalendarNativeBinding,terminal:MobileOrdinaryControl.Terminal,reconciliation:Bool)throws{
        guard reconciliation,calendarNativeBindingValid(binding),terminal.original.principal==binding.principal,
              try MobileOrdinaryControl.terminalIdentity(response:terminal.response,original:terminal.original.canonical)==terminal.identity else{throw HealthOutboxError.disabled}
        lock.lock();defer{lock.unlock()};var state=try read()
        guard (state.lastHuman==nil || state.lastHuman==binding.principal),state.calendarNative?.consentPending==nil else{throw HealthOutboxError.disabled}
        if let pending=state.calendarNative?.pending{
            guard pending.original==terminal.original.canonical,pending.binding.origin==binding.origin,pending.binding.principal==binding.principal,
                  (try? MobileOrdinaryControl.original(pending.original)) != nil else{throw HealthOutboxError.disabled}
            state.calendarNative!.healthControlResult = .init(binding:pending.binding,original:pending.original,response:terminal.response);state.calendarNative!.pending=nil
        }else{
            guard let last=state.calendarNative?.healthControlResult,last.original==terminal.original.canonical,last.binding.origin==binding.origin,last.binding.principal==binding.principal,
                  try MobileOrdinaryControl.terminalIdentity(response:last.response,original:last.original)==terminal.identity else{throw HealthOutboxError.disabled}
            state.calendarNative!.healthControlResult = .init(binding:last.binding,original:last.original,response:terminal.response)
        }
        try save(state)
    }
    public func healthControlLastTerminal(binding:CalendarNativeBinding)throws->MobileOrdinaryControl.Terminal? {
        lock.lock();defer{lock.unlock()};let state=try read()
        guard state.lastHuman==binding.principal,state.calendarNative?.pending==nil,state.calendarNative?.consentPending==nil else{throw HealthOutboxError.disabled}
        guard let saved=state.calendarNative?.healthControlResult else{return nil}
        guard saved.binding.origin==binding.origin,saved.binding.principal==binding.principal,saved.binding.endpoint==binding.endpoint else{throw HealthOutboxError.ownerChanged}
        return try MobileOrdinaryControl.terminalValue(response:saved.response,original:saved.original)
    }
    /// Native-owned review of the actual existing local row; no source authority.
    public struct HealthConfiguredLocalState:Equatable {
        public let principal:UUID,endpoint:UUID,enrollment:UUID,namespace:UUID,revision:Int
        public let types:Set<String>,paused:Bool,requiresRebind:Bool
    }
    public func healthConfiguredLocalState(binding:CalendarNativeBinding,enrollment:UUID,namespace:UUID)throws->HealthConfiguredLocalState {
        lock.lock();defer{lock.unlock()};let state=try read()
        guard calendarNativeBindingValid(binding),state.lastHuman==binding.principal,let e=state.enrollments[enrollment],e.human==binding.principal,
              UUID(uuidString:e.sourceNamespace)==namespace,!pendingPauses.contains(enrollment),pendingNarrowings[enrollment]==nil else{throw HealthOutboxError.disabled}
        return .init(principal:e.human,endpoint:binding.endpoint,enrollment:enrollment,namespace:namespace,revision:e.policyRevision,types:e.enabledTypes,paused:e.paused,requiresRebind:e.requiresRebind)
    }
    /// Distinct explicit SAME-source settings adoption. Local L is a strict CAS;
    /// latest remote R may exceed L after earlier saves were locally deferred.
    /// A fresh policy and owner choice are required; receipts never unpause/rebind.
    public func applyHealthConfiguredExistingLocal(binding:CalendarNativeBinding,expected:HealthConfiguredLocalState,terminal:MobileOrdinaryControl.Terminal,proof:MobileHealthPolicyProof,selectedTypes:Set<String>)throws->HealthConfiguredLocalState {
        let configured=try MobileOrdinaryControl.healthConfiguration(terminal)
        guard calendarNativeBindingValid(binding),configured.principal==binding.principal,configured.endpoint==binding.endpoint,
              expected.principal==binding.principal,expected.endpoint==binding.endpoint,expected.enrollment==configured.enrollment,expected.namespace==configured.namespace,
              proof.principal==configured.principal,proof.endpoint==configured.endpoint,proof.enrollment==configured.enrollment,
              proof.sourceNamespace.flatMap(UUID.init(uuidString:))==configured.namespace,proof.revision==configured.revision,proof.permitsCollection,
              configured.state=="active",!configured.collectionPaused,!selectedTypes.isEmpty,selectedTypes.isSubset(of:proof.healthKitTypes),
              selectedTypes.isSubset(of:Set(configured.categories.map{$0=="SleepSegment" ? "sleep":$0})),
              configured.revision>expected.revision && configured.expectedRemoteRevision>=expected.revision || configured.revision==expected.revision && selectedTypes==expected.types else{throw HealthOutboxError.disabled}
        lock.lock();defer{lock.unlock()};var state=try read()
        guard (!identityInitialized && human==nil && !contextReady) || (identityInitialized && contextReady && human==proof.principal),
              state.lastHuman==binding.principal,state.calendarNative?.pending==nil,state.calendarNative?.consentPending==nil,
              let saved=state.calendarNative?.healthControlResult,saved.binding.origin==binding.origin,saved.binding.principal==binding.principal,saved.binding.endpoint==binding.endpoint,
              saved.original==terminal.original.canonical,saved.response==terminal.response,
              !pendingPauses.contains(expected.enrollment),pendingNarrowings[expected.enrollment]==nil,
              var e=state.enrollments[expected.enrollment],e.human==expected.principal,UUID(uuidString:e.sourceNamespace)==expected.namespace,
              e.policyRevision==expected.revision,e.enabledTypes==expected.types,e.paused==expected.paused,e.requiresRebind==expected.requiresRebind,!e.requiresRebind else{throw HealthOutboxError.disabled}
        let changed=e.policyRevision != configured.revision || e.enabledTypes != selectedTypes
        e.policyRevision=configured.revision;e.enabledTypes=selectedTypes
        // Anchors, exact queued bodies/revisions and intentional pause survive.
        state.enrollments[expected.enrollment]=e
        if changed{try save(state)}
        identityInitialized=true;human=proof.principal;contextReady=true;generation &+= 1
        policyReady.remove(expected.enrollment);policyProofs.removeValue(forKey:expected.enrollment)
        if !e.paused{policyReady.insert(expected.enrollment);policyProofs[expected.enrollment]=UUID()}
        return .init(principal:e.human,endpoint:binding.endpoint,enrollment:expected.enrollment,namespace:expected.namespace,revision:e.policyRevision,types:e.enabledTypes,paused:e.paused,requiresRebind:e.requiresRebind)
    }
    /// Dedicated Health family in the SAME pending consent slot. Prior /2 readers refuse /3.
    public func stageHealthSourceConsent(binding:CalendarNativeBinding,original:Data)throws{
        lock.lock();defer{lock.unlock()}
        let command=try MobileHealthSourceConsent.command(original)
        guard calendarNativeBindingValid(binding),command.original==original,command.scope.principal==binding.principal else{throw HealthOutboxError.invalid}
        var state=try read()
        guard state.lastHuman==nil || state.lastHuman==binding.principal,state.calendarNative?.pending==nil,state.calendarNative?.consentPending==nil else{throw HealthOutboxError.disabled}
        for prior in [state.calendarNative?.terminal,state.calendarNative?.consentResult,state.calendarNative?.healthConsentResult,state.calendarNative?.healthControlResult].compactMap({$0}){
            guard prior.binding.origin==binding.origin,prior.binding.principal==binding.principal,prior.binding.endpoint==binding.endpoint else{throw HealthOutboxError.ownerChanged}
        }
        if command.kind == .approve{
            guard let prior=state.calendarNative?.healthConsentResult,let request=try? MobileHealthSourceConsent.command(prior.original),case .reserved(let review)=try MobileHealthSourceConsent.response(prior.response,expected:request),review.approvalAvailable,command.request==request.payload,command.confirmation==review.confirmation else{throw HealthOutboxError.disabled}
        }
        if state.version<4{state.version=4;if state.calendarEnrollments==nil{state.calendarEnrollments=[:]};if state.shareAssociations==nil{state.shareAssociations=[:]}}
        if state.calendarNative==nil{state.calendarNative = .init(format:"CalendarNative/3",pending:nil,terminal:nil,selections:[:])}
        if state.calendarNative!.format != "CalendarNative/4"{state.calendarNative!.format="CalendarNative/3"};state.lastHuman=binding.principal
        state.calendarNative!.consentPending = .init(binding:binding,original:original,requestDigest:command.digest,operationID:command.operationID,attempted:false)
        try save(state)
    }
    public func markHealthSourceConsentAttempted(binding:CalendarNativeBinding,original:Data)throws{
        _ = try MobileHealthSourceConsent.command(original)
        lock.lock();defer{lock.unlock()};var state=try read()
        guard var p=state.calendarNative?.consentPending,p.binding==binding,p.original==original,!p.attempted else{throw HealthOutboxError.disabled}
        p.attempted=true;state.calendarNative!.consentPending=p;try save(state)
    }
    public func healthSourceConsentPending(origin:String,principal:UUID,endpoint:UUID)throws->CalendarNativePending?{
        lock.lock();defer{lock.unlock()};let state=try read()
        guard state.lastHuman==nil || state.lastHuman==principal,state.calendarNative?.pending==nil else{throw HealthOutboxError.ownerChanged}
        guard let p=state.calendarNative?.consentPending else{return nil}
        guard (try? MobileHealthSourceConsent.command(p.original)) != nil,p.binding.origin==origin,p.binding.principal==principal,p.binding.endpoint==endpoint else{throw HealthOutboxError.ownerChanged};return p
    }
    public func healthSourceConsentLastOriginal(origin:String,principal:UUID,endpoint:UUID)throws->Data?{
        lock.lock();defer{lock.unlock()};let state=try read()
        guard state.lastHuman==nil || state.lastHuman==principal,state.calendarNative?.pending==nil else{throw HealthOutboxError.ownerChanged}
        guard let r=state.calendarNative?.healthConsentResult else{return nil}
        guard r.binding.origin==origin,r.binding.principal==principal,r.binding.endpoint==endpoint else{throw HealthOutboxError.ownerChanged};return r.original
    }
    /// Reserved settles ONLY an inert request; it can never settle an approval.
    /// Held/observed/status/descriptor cannot settle any original operation.
    public func settleHealthSourceConsent(binding:CalendarNativeBinding,original:Data,response:Data,reconciliation:Bool)throws{
        lock.lock();defer{lock.unlock()};var state=try read();let command=try MobileHealthSourceConsent.command(original)
        let parsed=try MobileHealthSourceConsent.response(response,expected:command)
        switch parsed{case .reserved,.terminal:break;default:throw HealthOutboxError.disabled}
        guard command.scope.principal==binding.principal,state.calendarNative?.pending==nil else{throw HealthOutboxError.ownerChanged}
        if let pending=state.calendarNative?.consentPending{
            guard pending.attempted,pending.original==original,pending.binding.origin==binding.origin,pending.binding.principal==binding.principal,pending.binding.endpoint==binding.endpoint,reconciliation || pending.binding.session==binding.session else{throw HealthOutboxError.disabled}
            state.calendarNative!.healthConsentResult = .init(binding:pending.binding,original:original,response:response);state.calendarNative!.consentPending=nil
        }else{
            guard reconciliation,let last=state.calendarNative?.healthConsentResult,last.original==original,last.binding.origin==binding.origin,last.binding.principal==binding.principal,last.binding.endpoint==binding.endpoint else{throw HealthOutboxError.disabled}
            // Same reserved review can become unavailable. A terminal's committed
            // receipt and bindings must remain identical across reconciliation.
            let old=try MobileHealthSourceConsent.response(last.response,expected:command)
            switch(old,parsed){
            case (.reserved,.reserved):break
            case (.terminal,.terminal):
                let a=try MobileCalendarSettingsWire.object(last.response)["result"] as! [String:Any],b=try MobileCalendarSettingsWire.object(response)["result"] as! [String:Any]
                guard try MobileHealthSourceConsent.canonical(a)==MobileHealthSourceConsent.canonical(b) else{throw HealthOutboxError.disabled}
            default:throw HealthOutboxError.disabled
            }
            state.calendarNative!.healthConsentResult = .init(binding:last.binding,original:original,response:response)
        }
        try save(state)
    }
    /// Original custodian reads this inside the same explicit configured-save
    /// frame. Absence alone never grants admission or permits a fallback retry.
    public func calendarConfiguredLocalRevision(principal:UUID,endpoint:UUID,enrollment:UUID,namespace:UUID)throws->Int?{
        lock.lock();defer{lock.unlock()};let state=try read()
        guard state.lastHuman==nil || state.lastHuman==principal,state.calendarNative?.pending==nil,state.calendarNative?.consentPending==nil,state.enrollments[enrollment]==nil else{throw HealthOutboxError.ownerChanged}
        guard let row=state.calendarEnrollments?[enrollment] else{return nil}
        guard row.human==principal,row.endpoint==endpoint,row.namespace==namespace,row.collector=="eventKit" else{throw HealthOutboxError.ownerChanged};return row.revision
    }
    /// Distinct, explicitly receipt-bound configured-local transaction. The old
    /// reconnect above remains ZERO-WRITE and revision-equal.
    public func applyCalendarConfiguredExistingLocal(terminal:MobileCalendarSettingsWire.Terminal,proof:MobileCalendarPolicyProof,selection:Data)throws{
        lock.lock();defer{lock.unlock()}
        guard terminal.applied,terminal.current,terminal.command.kind=="configure",let result=terminal.enrollment,let settings=terminal.window,
              result.id==proof.enrollment,result.principal==proof.principal,result.endpoint==proof.endpoint,result.namespace==proof.namespace,result.revision==proof.revision,result.state=="active",!result.collectionPaused,proof.collector=="eventKit",proof.categories==["CalendarEvent"],terminal.command.settings==nil || terminal.command.settings==settings,
              (!identityInitialized && human==nil && !contextReady) || (identityInitialized && contextReady && human==proof.principal) else{throw HealthOutboxError.disabled}
        var state=try read()
        guard (state.version==4 || state.version==5),state.calendarNative?.pending==nil,state.calendarNative?.consentPending==nil,state.lastHuman==proof.principal,state.enrollments[proof.enrollment]==nil,var e=state.calendarEnrollments?[proof.enrollment],e.human==proof.principal,e.endpoint==proof.endpoint,e.namespace==proof.namespace,e.collector==proof.collector,!e.paused,!e.requiresRebind,e.revision==terminal.command.expectedRevision,e.categories==["CalendarEvent"],
              let saved=state.calendarNative?.terminal,saved.original==terminal.command.original,saved.response==terminal.response,
              let value=try? MobileCalendarSettingsWire.object(selection),let identity=value["identity"] as? [String:Any],MobileCalendarSettingsWire.id(identity["principalId"])==proof.principal,MobileCalendarSettingsWire.id(identity["endpointId"])==proof.endpoint,MobileCalendarSettingsWire.id(identity["enrollmentId"])==proof.enrollment,MobileCalendarSettingsWire.id(identity["sourceNamespace"])==proof.namespace,MobileCalendarSettingsWire.integer(identity["configurationRevision"])==proof.revision else{throw HealthOutboxError.disabled}
        e.revision=proof.revision
        for i in e.queue.indices{let item=try? MobileCalendarDelivery.item(e.queue[i].data);if item==nil || item?.policyRevision != e.revision{e.queue[i].quarantined=true;e.queue[i].code="settingsChanged"}}
        state.calendarEnrollments?[proof.enrollment]=e;state.calendarNative!.selections[proof.enrollment]=selection
        guard let encoded=try? JSONEncoder().encode(state),calendarNativeValid(state,encoded) else{throw HealthOutboxError.invalid}
        try save(state)
        identityInitialized=true;human=proof.principal;contextReady=true;calendarGeneration &+= 1;calendarProofs[proof.enrollment]=UUID();calendarBindingDigests[proof.enrollment]=proof.bindingDigest
    }

}

// This seam has no production implementation. A test host supplies its own
// synchronous fence and admission witness; identifiers are not grants.
protocol OutboxShareAuthority:AnyObject {
    func withFence<T>(_ body:() throws -> T) rethrows -> T
    func permits(_ context:OutboxShareContext,reading:Bool)->Bool
}
final class OutboxShareContext:SharedCaptureBinding {
    let owner:HealthOutbox,human:UUID,endpoint:UUID,namespace:UUID,collector:String,epoch:UInt64,leaseToken:UUID,recoveryOnly:Bool
    init(owner:HealthOutbox,human:UUID,endpoint:UUID,namespace:UUID,collector:String,epoch:UInt64,leaseToken:UUID=UUID(),recoveryOnly:Bool){self.owner=owner;self.human=human;self.endpoint=endpoint;self.namespace=namespace;self.collector=collector;self.epoch=epoch;self.leaseToken=leaseToken;self.recoveryOnly=recoveryOnly}
}
final class OutboxShareAttempt:SharedCaptureAttempt {
    let id:UUID,owner:HealthOutbox,human:UUID,endpoint:UUID,namespace:UUID,collector:String,epoch:UInt64,leaseToken:UUID,recoveryOnly:Bool
    init(_ id:UUID,context:OutboxShareContext){self.id=id;owner=context.owner;human=context.human;endpoint=context.endpoint;namespace=context.namespace;collector=context.collector;epoch=context.epoch;leaseToken=context.leaseToken;recoveryOnly=context.recoveryOnly}
    func matches(_ context:OutboxShareContext)->Bool {owner === context.owner && human==context.human && endpoint==context.endpoint && namespace==context.namespace && collector==context.collector && epoch==context.epoch && leaseToken==context.leaseToken && recoveryOnly==context.recoveryOnly}
}
private final class OutboxShareReceipt:SharedCaptureReceipt {let id:UUID;init(_ id:UUID){self.id=id}}
private final class OutboxShareReservation:SharedCaptureReservation {
    let context:OutboxShareContext,attempt:UUID,digest:String,item:Data,length:Int,contentDigest:String,receipt:UUID,generation:UInt64,snapshotDigest:String,quote:Int
    var consumed=false
    init(context:OutboxShareContext,attempt:UUID,digest:String,item:Data,length:Int,contentDigest:String,receipt:UUID,generation:UInt64,snapshotDigest:String,quote:Int){self.context=context;self.attempt=attempt;self.digest=digest;self.item=item;self.length=length;self.contentDigest=contentDigest;self.receipt=receipt;self.generation=generation;self.snapshotDigest=snapshotDigest;self.quote=quote}
}

extension HealthOutbox:SharedCaptureOwner {
    /// Internal test seam. The public initializer leaves Share unavailable.
    convenience init(storage:HealthSnapshotStorage,maxBytes:Int=8*1024*1024,maxEvents:Int=100_000,shareAuthority:any OutboxShareAuthority){self.init(storage:storage,maxBytes:maxBytes,maxEvents:maxEvents);self.shareAuthority=shareAuthority}
    private func shareHash(_ data:Data)->String{SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined()}
    private func shareKey(human:UUID,endpoint:UUID,namespace:UUID,collector:String,attempt:UUID)->String {
        // JSON array makes scope boundaries unambiguous before hashing.
        let value=[human.uuidString.lowercased(),endpoint.uuidString.lowercased(),namespace.uuidString.lowercased(),collector,attempt.uuidString.lowercased()]
        return shareHash((try? JSONEncoder().encode(value)) ?? Data())
    }
    private func validShares(_ state:Snapshot)->Bool {
        guard let records=state.shareAssociations else{return false}
        return records.allSatisfy { key,r in
            guard key==shareKey(human:r.human,endpoint:r.endpoint,namespace:r.namespace,collector:r.collector,attempt:r.attempt),r.digest==shareHash(r.item),r.contentDigest==shareHash(r.bytes),r.length==r.bytes.count,let item=try? MobileSharedItem.decode(r.item),item.data==r.item,item.source.namespace==r.namespace,item.source.collector==r.collector,case .attachment(_,let artifact,_)=item.content,artifact.sha256==r.contentDigest,artifact.byteLength==r.length else{return false};return true
        }
    }
    private func shareStructureValid(_ bytes:Data)->Bool {
        guard let root=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any],let records=root["shareAssociations"] as? [String:Any] else{return false}
        let keys:Set<String>=["human","endpoint","namespace","collector","epoch","attempt","receipt","item","digest","bytes","contentDigest","length"]
        return records.values.allSatisfy{guard let value=$0 as? [String:Any] else{return false};return Set(value.keys)==keys}
    }
    private func shareReadIdentity()throws->String {do{return shareHash(try storage.read() ?? Data())}catch{throw HealthOutboxError.lockedOrUnavailable}}
    private func shareCount(_ state:Snapshot)->Int {state.enrollments.values.reduce(0){$0+$1.queue.count}+(state.calendarEnrollments?.values.reduce(0){$0+$1.queue.count} ?? 0)+(state.shareAssociations?.count ?? 0)}
    private func shareContext(_ raw:any SharedCaptureBinding,item:MobileSharedItem.Value,reading:Bool,authority:any OutboxShareAuthority)->OutboxShareContext? {
        guard let c=raw as? OutboxShareContext,c.owner === self,contextReady,human==c.human,(!reading || !c.recoveryOnly),item.source.namespace==c.namespace,item.source.collector==c.collector,authority.permits(c,reading:reading) else{return nil};return c
    }
    func reconcile(attempt:any SharedCaptureAttempt,payloadDigest:String,item:MobileSharedItem.Value,context:any SharedCaptureBinding)throws->SharedCaptureReconciliation {
        guard let authority=shareAuthority,let attempt=attempt as? OutboxShareAttempt else{return .unavailable}
        return try authority.withFence {lock.lock();defer{lock.unlock()};guard let c=shareContext(context,item:item,reading:false,authority:authority),attempt.matches(c) else{return .unavailable};let state=try read(),key=shareKey(human:c.human,endpoint:c.endpoint,namespace:c.namespace,collector:c.collector,attempt:attempt.id);guard let row=state.shareAssociations?[key] else{return .absent};guard row.digest==payloadDigest,row.item==item.data else{return .conflict};return .committed(OutboxShareReceipt(row.receipt))}
    }
    func reserve(attempt:any SharedCaptureAttempt,payloadDigest:String,item:MobileSharedItem.Value,context:any SharedCaptureBinding)throws->SharedCaptureReservationResult {
        guard let authority=shareAuthority,let attempt=attempt as? OutboxShareAttempt,case .attachment(_,let artifact,_)=item.content else{return .held}
        return try authority.withFence {lock.lock();defer{lock.unlock()};guard let c=shareContext(context,item:item,reading:true,authority:authority),attempt.matches(c),payloadDigest==shareHash(item.data),artifact.byteLength<=maxBytes,artifact.byteLength<=8*1024*1024 else{return .held};var state=try read();let identity=try shareReadIdentity(),key=shareKey(human:c.human,endpoint:c.endpoint,namespace:c.namespace,collector:c.collector,attempt:attempt.id);guard state.shareAssociations?[key]==nil,shareCount(state)<maxEvents else{return .held}
            let receipt=UUID(),placeholder=Data(repeating:255,count:artifact.byteLength);if state.version<3{state.version=3};if state.shareAssociations==nil{state.shareAssociations=[:]};state.shareAssociations?[key]=ShareRecord(human:c.human,endpoint:c.endpoint,namespace:c.namespace,collector:c.collector,epoch:c.epoch,attempt:attempt.id,receipt:receipt,item:item.data,digest:payloadDigest,bytes:placeholder,contentDigest:artifact.sha256,length:artifact.byteLength)
            guard let encoded=try? JSONEncoder().encode(state),encoded.count<=maxBytes else{return .held}
            return .reserved(OutboxShareReservation(context:c,attempt:attempt.id,digest:payloadDigest,item:item.data,length:artifact.byteLength,contentDigest:artifact.sha256,receipt:receipt,generation:shareGeneration,snapshotDigest:identity,quote:encoded.count),rawBudget:artifact.byteLength)
        }
    }
    func check(_ raw:any SharedCaptureReservation)throws {
        guard let r=raw as? OutboxShareReservation,r.context.owner === self,let authority=shareAuthority else{throw HealthOutboxError.disabled}
        try authority.withFence {lock.lock();defer{lock.unlock()};guard !r.consumed,r.generation==shareGeneration,r.context.owner === self,contextReady,human==r.context.human,authority.permits(r.context,reading:true),try shareReadIdentity()==r.snapshotDigest else{throw HealthOutboxError.disabled}}
    }
    func commit(_ raw:any SharedCaptureReservation,itemJSON:Data,capturedBytes:Data,integrity:[String:Any])throws->SharedCaptureCommitResult {
        guard let r=raw as? OutboxShareReservation,r.context.owner === self,let authority=shareAuthority else{return .held}
        return try authority.withFence {lock.lock();defer{lock.unlock()};guard !r.consumed else{return .held};r.consumed=true
            guard r.context.owner === self,contextReady,human==r.context.human,r.generation==shareGeneration,authority.permits(r.context,reading:true),try shareReadIdentity()==r.snapshotDigest,itemJSON==r.item,shareHash(itemJSON)==r.digest,capturedBytes.count==r.length,shareHash(capturedBytes)==r.contentDigest,let item=try? MobileSharedItem.decode(itemJSON),MobileSharedItem.verify(item,bytes:capturedBytes) != nil else{return .held}
            var state=try read();let c=r.context,key=shareKey(human:c.human,endpoint:c.endpoint,namespace:c.namespace,collector:c.collector,attempt:r.attempt);guard state.shareAssociations?[key]==nil,shareCount(state)<maxEvents else{return .held};if state.version<3{state.version=3};if state.shareAssociations==nil{state.shareAssociations=[:]};state.shareAssociations?[key]=ShareRecord(human:c.human,endpoint:c.endpoint,namespace:c.namespace,collector:c.collector,epoch:c.epoch,attempt:r.attempt,receipt:r.receipt,item:itemJSON,digest:r.digest,bytes:capturedBytes,contentDigest:r.contentDigest,length:r.length)
            guard let bytes=try? JSONEncoder().encode(state),bytes.count<=maxBytes,bytes.count<=r.quote else{return .held}
            shareGeneration &+= 1
            // Any error from invoked replacement is ambiguous to the caller.
            try storage.replace(bytes);return .acknowledged(OutboxShareReceipt(r.receipt))
        }
    }
    func abandon(_ raw:any SharedCaptureReservation){guard let r=raw as? OutboxShareReservation,r.context.owner === self,let authority=shareAuthority else{return};authority.withFence{lock.lock();defer{lock.unlock()};r.consumed=true}}
}
