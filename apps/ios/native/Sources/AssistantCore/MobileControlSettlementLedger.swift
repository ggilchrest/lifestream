import Foundation
import CryptoKit

/// These contracts require independently qualified, durable authority; a test
/// implementation or a process lock does not qualify either one.
public protocol MobileControlSettlementWitness {
    func current(serverDigest: String, principal: UUID) throws -> MobileControlSettlementLedger.WitnessValue?
    func compareAndAdvance(serverDigest: String, principal: UUID, expected: MobileControlSettlementLedger.WitnessValue, next: MobileControlSettlementLedger.WitnessValue) throws -> Bool
}
public struct UnavailableMobileControlSettlementWitness: MobileControlSettlementWitness {
    public init() {}
    public func current(serverDigest: String, principal: UUID) throws -> MobileControlSettlementLedger.WitnessValue? { nil }
    public func compareAndAdvance(serverDigest: String, principal: UUID, expected: MobileControlSettlementLedger.WitnessValue, next: MobileControlSettlementLedger.WitnessValue) throws -> Bool { false }
}
public protocol MobileControlExclusiveLease {
    func withFence<T>(_ body: () throws -> T) throws -> T
    func isCurrent(serverDigest: String, principal: UUID) -> Bool
    func release()
}
public protocol MobileControlExclusivity {
    func acquire(serverDigest: String, principal: UUID) throws -> (any MobileControlExclusiveLease)?
}
public struct UnavailableMobileControlExclusivity: MobileControlExclusivity {
    public init() {}
    public func acquire(serverDigest: String, principal: UUID) throws -> (any MobileControlExclusiveLease)? { nil }
}

/// One witnessed append-only document for both families. Production requires a
/// separately qualified witness and exclusion authority covering legacy writers.
public final class MobileControlSettlementLedger {
    public struct WitnessValue: Equatable { public let epoch: Int; public let digest: String; public init(epoch: Int, digest: String) { self.epoch = epoch; self.digest = digest } }
    public enum Failure: Error { case held, invalid, capacity }
    public struct Scope { public let serverDigest: String, principal: UUID, endpoint: UUID, session: UUID; public init(serverDigest: String, principal: UUID, endpoint: UUID, session: UUID) { self.serverDigest=serverDigest; self.principal=principal; self.endpoint=endpoint; self.session=session } }
    public struct Pending { public let original: Data, expectedRevision: Int }
    private struct Entry: Codable { let kind: String, serverDigest: String, principal: UUID, endpoint: UUID, session: UUID, original: Data, originalDigest: String, expectedRevision: Int, response: Data?; var proofDigest: String? = nil }
    private struct Document: Codable { let version: String, controlSchema: String, controlDigest: String, interpretationSchema: String, interpretationDigest: String; var entries: [Entry] }
    private static let lock = NSLock()
    private static var poisonedScopes = Set<String>()
    private var revalidatedHead: String?
    private let storage: HealthSnapshotStorage, witness: MobileControlSettlementWitness, maxBytes: Int, maxEntries: Int
    public init(storage: HealthSnapshotStorage, witness: MobileControlSettlementWitness = UnavailableMobileControlSettlementWitness(), maxBytes: Int = 4*1024*1024, maxEntries: Int = 1024) { self.storage=storage; self.witness=witness; self.maxBytes=maxBytes; self.maxEntries=maxEntries }
    private static func encode(_ value: Document) throws -> Data { let e=JSONEncoder(); e.outputFormatting=[.sortedKeys,.withoutEscapingSlashes]; return try e.encode(value) }
    private static func digest(_ data: Data) -> String { SHA256.hash(data:data).map { String(format:"%02x",$0) }.joined() }
    private static func validDigest(_ value: String) -> Bool { value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }
    private static func scopeKey(_ scope: Scope) -> String { scope.serverDigest + ":" + scope.principal.uuidString.lowercased() }
    private static func terminalIdentity(_ bytes: Data) -> Data? {
        guard let root=try? JSONSerialization.jsonObject(with:bytes) as? [String:Any],let result=root["result"] as? [String:Any],let nested=result["controlResponse"] as? [String:Any],let control=nested["result"] as? [String:Any],let status=result["interpretationStatus"],let revision=result["interpretationRevision"],let operation=result["operationId"],let controlStatus=control["status"],let receipt=control["receipt"],let digest=control["requestDigest"] else{return nil}
        return try? JSONSerialization.data(withJSONObject:["status":status,"revision":revision,"operation":operation,"controlStatus":controlStatus,"receipt":receipt,"digest":digest],options:[.sortedKeys,.withoutEscapingSlashes])
    }
    private func fenced<T>(_ scope: Scope, _ lease: any MobileControlExclusiveLease, _ body: () throws -> T) throws -> T {
        try lease.withFence { guard lease.isCurrent(serverDigest: scope.serverDigest, principal: scope.principal) else { throw Failure.held }; return try body() }
    }
    public static func genesisBytes() throws -> Data { try encode(Document(version:"MobileControlSettlementLedger/1",controlSchema:MobileControlOriginal.schemaId,controlDigest:MobileControlOriginal.schemaSHA256,interpretationSchema:MobileInterpretationSchema.schemaId,interpretationDigest:MobileInterpretationSchema.digest,entries:[])) }
    public static func genesisWitness() throws -> WitnessValue { WitnessValue(epoch:0,digest:digest(try genesisBytes())) }
    private func read(_ scope: Scope) throws -> (Document, Data, WitnessValue, Entry?) {
        guard !Self.poisonedScopes.contains(Self.scopeKey(scope)), Self.validDigest(scope.serverDigest), maxBytes>0, maxEntries>0,
              let bytes=try storage.read(), bytes.count<=maxBytes, let observed=try witness.current(serverDigest:scope.serverDigest,principal:scope.principal),
              observed.epoch>=0, Self.validDigest(observed.digest), Self.digest(bytes)==observed.digest,
              let d=try? JSONDecoder().decode(Document.self,from:bytes), ["MobileControlSettlementLedger/1","MobileControlSettlementLedger/2"].contains(d.version),
              d.controlSchema==MobileControlOriginal.schemaId,d.controlDigest==MobileControlOriginal.schemaSHA256,d.interpretationSchema==MobileInterpretationSchema.schemaId,d.interpretationDigest==MobileInterpretationSchema.digest,
              d.entries.count<=maxEntries,d.entries.count==observed.epoch,(try? Self.encode(d))==bytes else { throw Failure.held }
        var active: Entry?, seen=Set<UUID>(), upgraded=false
        for (index,entry) in d.entries.enumerated() {
            guard entry.serverDigest==scope.serverDigest,entry.principal==scope.principal else { throw Failure.held }
            if entry.kind == "upgrade" {
                guard d.version=="MobileControlSettlementLedger/2",!upgraded,active==nil,entry.original.isEmpty,entry.response==nil,entry.proofDigest==nil,entry.expectedRevision==index,Self.validDigest(entry.originalDigest) else { throw Failure.held }
                let previous=Document(version:"MobileControlSettlementLedger/1",controlSchema:d.controlSchema,controlDigest:d.controlDigest,interpretationSchema:d.interpretationSchema,interpretationDigest:d.interpretationDigest,entries:Array(d.entries.prefix(index)))
                guard Self.digest(try Self.encode(previous))==entry.originalDigest else { throw Failure.held }; upgraded=true; continue
            }
            guard let original=try? MobileControlOriginal.parse(entry.original),original.canonical==entry.original,original.digest==entry.originalDigest,original.principal==entry.principal,original.endpoint==entry.endpoint,
                  let object=try? JSONSerialization.jsonObject(with:entry.original) as? [String:Any],let action=object["action"] as? [String:Any],let kind=action["kind"] as? String else { throw Failure.held }
            if entry.kind == "intent" || entry.kind == "interpretationIntent" {
                guard active==nil,entry.response==nil,seen.insert(original.operationId).inserted,kind=="configure",entry.expectedRevision>=1 else { throw Failure.held }
                if entry.kind == "intent" { guard !upgraded,entry.proofDigest==nil else { throw Failure.held } }
                else { guard upgraded,let proof=entry.proofDigest,Self.validDigest(proof) else { throw Failure.held } }
                active=entry
            } else if entry.kind == "ordinaryIntent" {
                guard upgraded,active==nil,entry.response==nil,entry.proofDigest==nil,seen.insert(original.operationId).inserted,["enroll","bindSource","configure"].contains(kind),entry.expectedRevision>=0,
                      let target=object["target"] as? [String:Any],MobileControlOriginal.number(target["expectedRevision"],min:0,max:9007199254740991)==entry.expectedRevision,
                      (try? MobileOrdinaryControl.envelope(original:entry.original,operation:.control)) != nil else { throw Failure.held }; active=entry
            } else if ["terminal","interpretationTerminal","ordinaryTerminal"].contains(entry.kind) {
                guard let prior=active,let response=entry.response,prior.original==entry.original,prior.originalDigest==entry.originalDigest,prior.expectedRevision==entry.expectedRevision,prior.endpoint==entry.endpoint,prior.session==entry.session,prior.proofDigest==entry.proofDigest else { throw Failure.held }
                if entry.kind == "ordinaryTerminal" { guard prior.kind=="ordinaryIntent",MobileOrdinaryControl.assessTerminal(response:response,original:entry.original) != .held else { throw Failure.held } }
                else { guard (entry.kind=="terminal" && prior.kind=="intent") || (entry.kind=="interpretationTerminal" && prior.kind=="interpretationIntent") else { throw Failure.held }; switch MobileInterpretation.assessMutation(response,original:entry.original,expectedRevision:entry.expectedRevision) { case .applied,.rejected: break; case .held: throw Failure.held } }
                active=nil
            } else { throw Failure.held }
        }
        guard (d.version=="MobileControlSettlementLedger/2") == upgraded else { throw Failure.held }
        return (d,bytes,observed,active)
    }
    private func commit(_ doc: Document, scope: Scope, expected: WitnessValue) throws -> WitnessValue {
        guard doc.entries.count<=maxEntries,expected.epoch<Int.max else { throw Failure.capacity }
        let bytes=try Self.encode(doc);guard bytes.count<=maxBytes else { throw Failure.capacity };let next=WitnessValue(epoch:expected.epoch+1,digest:Self.digest(bytes))
        do { try storage.replace(bytes);guard try witness.compareAndAdvance(serverDigest:scope.serverDigest,principal:scope.principal,expected:expected,next:next),try storage.read()==bytes,try witness.current(serverDigest:scope.serverDigest,principal:scope.principal)==next else { throw Failure.held };return next }
        catch { Self.poisonedScopes.insert(Self.scopeKey(scope));revalidatedHead=nil;throw Failure.held }
    }
    /// The legacy raw stage cannot prove interpretation-family admission.
    public func stage(scope: Scope, original: Data, expectedRevision: Int) throws -> Data { throw Failure.held }
    public func pending(scope: Scope) throws -> Pending? { Self.lock.lock();defer{Self.lock.unlock()};let (_,_,_,entry)=try read(scope);guard let entry else{return nil};guard entry.kind=="intent" || entry.kind=="interpretationIntent" else {throw Failure.held};return Pending(original:entry.original,expectedRevision:entry.expectedRevision) }
    public func lastSettledOriginal(scope: Scope) throws -> Pending? { Self.lock.lock();defer{Self.lock.unlock()};let (doc,_,_,active)=try read(scope);guard active==nil,let last=doc.entries.last,["terminal","interpretationTerminal"].contains(last.kind) else{return nil};return Pending(original:last.original,expectedRevision:last.expectedRevision) }
    /// Unqualified legacy mutation is unavailable. Use lease-bound overloads.
    public func appendAuthenticatedTerminal(scope: Scope, response: Data) throws { throw Failure.held }
    public func revalidateAuthenticatedTerminal(scope: Scope, response: Data) throws { throw Failure.held }
    public func appendAuthenticatedInterpretationTerminal(scope: Scope, response: Data, lease: any MobileControlExclusiveLease) throws {
        try fenced(scope,lease) { Self.lock.lock(); defer { Self.lock.unlock() }
            let (doc,_,head,active)=try read(scope)
            guard let active, ["intent","interpretationIntent"].contains(active.kind), response.count <= 262144 else { throw Failure.held }
            switch MobileInterpretation.assessMutation(response,original:active.original,expectedRevision:active.expectedRevision) { case .applied,.rejected: break; case .held: throw Failure.held }
            let kind=active.kind == "intent" ? "terminal" : "interpretationTerminal"
            var next=doc;next.entries.append(Entry(kind:kind,serverDigest:active.serverDigest,principal:active.principal,endpoint:active.endpoint,session:active.session,original:active.original,originalDigest:active.originalDigest,expectedRevision:active.expectedRevision,response:response,proofDigest:active.proofDigest))
            let confirmed=try commit(next,scope:scope,expected:head);revalidatedHead=confirmed.digest
        }
    }
    public func revalidateAuthenticatedInterpretationTerminal(scope: Scope, response: Data, lease: any MobileControlExclusiveLease) throws {
        try fenced(scope,lease) { Self.lock.lock(); defer { Self.lock.unlock() }
            let (doc,_,head,active)=try read(scope)
            guard response.count<=262144,active==nil,let last=doc.entries.last,["terminal","interpretationTerminal"].contains(last.kind),let stored=last.response,
                  let identity=Self.terminalIdentity(stored),identity==Self.terminalIdentity(response) else { throw Failure.held }
            switch MobileInterpretation.assessMutation(response,original:last.original,expectedRevision:last.expectedRevision) { case .applied,.rejected: revalidatedHead=head.digest; case .held: throw Failure.held }
        }
    }
    public func revalidateQualifiedUpgrade(scope: Scope, authenticatedInterpretationResponse: Data?, lease: any MobileControlExclusiveLease) throws {
        try fenced(scope,lease) { Self.lock.lock(); defer { Self.lock.unlock() }
            let (doc,_,head,active)=try read(scope)
            guard active==nil,let marker=doc.entries.last,marker.kind=="upgrade" else { throw Failure.held }
            let prior=doc.entries.dropLast().last
            if let prior {
                guard prior.kind=="terminal",let stored=prior.response,let response=authenticatedInterpretationResponse,response.count<=262144,
                      let identity=Self.terminalIdentity(stored),identity==Self.terminalIdentity(response) else { throw Failure.held }
                switch MobileInterpretation.assessMutation(response,original:prior.original,expectedRevision:prior.expectedRevision) { case .applied,.rejected: break; case .held: throw Failure.held }
            } else { guard authenticatedInterpretationResponse==nil else { throw Failure.held } }
            revalidatedHead=head.digest
        }
    }
    public func upgradeQualifiedV1(scope: Scope, authenticatedInterpretationResponse: Data?, lease: any MobileControlExclusiveLease) throws {
        try fenced(scope,lease) { Self.lock.lock();defer{Self.lock.unlock()};let (doc,_,prior,active)=try read(scope);guard doc.version=="MobileControlSettlementLedger/1",active==nil else {throw Failure.held}
            if let last=doc.entries.last {guard last.kind=="terminal",let response=authenticatedInterpretationResponse,response.count<=262144,let stored=last.response,Self.terminalIdentity(stored) != nil,Self.terminalIdentity(stored)==Self.terminalIdentity(response) else {throw Failure.held};switch MobileInterpretation.assessMutation(response,original:last.original,expectedRevision:last.expectedRevision){case .applied,.rejected:break;case .held:throw Failure.held}}
            else {guard authenticatedInterpretationResponse==nil else {throw Failure.held}}
            var entries=doc.entries;entries.append(Entry(kind:"upgrade",serverDigest:scope.serverDigest,principal:scope.principal,endpoint:scope.endpoint,session:scope.session,original:Data(),originalDigest:prior.digest,expectedRevision:prior.epoch,response:nil))
            let next=Document(version:"MobileControlSettlementLedger/2",controlSchema:doc.controlSchema,controlDigest:doc.controlDigest,interpretationSchema:doc.interpretationSchema,interpretationDigest:doc.interpretationDigest,entries:entries);let head=try commit(next,scope:scope,expected:prior);revalidatedHead=head.digest
        }
    }
    private func stageV2(scope: Scope, original: Data, revision: Int, kind: String, proof: String?, lease: any MobileControlExclusiveLease) throws -> Data {
        try fenced(scope,lease) { Self.lock.lock();defer{Self.lock.unlock()};let (doc,_,head,active)=try read(scope);guard doc.version=="MobileControlSettlementLedger/2",active==nil,revalidatedHead==head.digest else {throw Failure.held}
            let request=try MobileControlOriginal.parse(original);guard request.principal==scope.principal,request.endpoint==scope.endpoint,!doc.entries.contains(where:{(try? MobileControlOriginal.parse($0.original).operationId)==request.operationId}) else {throw Failure.invalid}
            var next=doc;next.entries.append(Entry(kind:kind,serverDigest:scope.serverDigest,principal:scope.principal,endpoint:scope.endpoint,session:scope.session,original:request.canonical,originalDigest:request.digest,expectedRevision:revision,response:nil,proofDigest:proof));_ = try commit(next,scope:scope,expected:head);revalidatedHead=nil;return request.canonical
        }
    }
    public func stageInterpretation(scope: Scope, preview: MobileInterpretation.Preview, lease: any MobileControlExclusiveLease) throws -> Data {
        let reviewed=try MobileInterpretation.reviewedEnvelope(preview:preview,stagedOriginal:preview.original)
        return try stageV2(scope:scope,original:preview.original,revision:preview.nextRevision,kind:"interpretationIntent",proof:Self.digest(reviewed),lease:lease)
    }
    public func stageOrdinary(scope: Scope, original: Data, lease: any MobileControlExclusiveLease) throws -> Data {
        _ = try MobileOrdinaryControl.envelope(original:original,operation:.control)
        let object=try JSONSerialization.jsonObject(with:original) as? [String:Any];let target=object?["target"] as? [String:Any]
        guard let revision=MobileControlOriginal.number(target?["expectedRevision"],min:0,max:9007199254740991) else {throw Failure.invalid}
        return try stageV2(scope:scope,original:original,revision:revision,kind:"ordinaryIntent",proof:nil,lease:lease)
    }
    public func pendingOrdinary(scope: Scope) throws -> Data? {Self.lock.lock();defer{Self.lock.unlock()};let (_,_,_,entry)=try read(scope);guard let entry else{return nil};guard entry.kind=="ordinaryIntent" else{throw Failure.held};return entry.original}
    public func lastSettledControlOriginal(scope: Scope) throws -> Data? {Self.lock.lock();defer{Self.lock.unlock()};let (doc,_,_,entry)=try read(scope);guard entry==nil,let last=doc.entries.last,last.kind=="ordinaryTerminal" else{return nil};return last.original}
    public func appendAuthenticatedOrdinaryTerminal(scope: Scope, response: Data, lease: any MobileControlExclusiveLease) throws {
        try fenced(scope,lease) {Self.lock.lock();defer{Self.lock.unlock()};let (doc,_,head,active)=try read(scope);guard let active,active.kind=="ordinaryIntent",MobileOrdinaryControl.assessTerminal(response:response,original:active.original) != .held else{throw Failure.held};var next=doc;next.entries.append(Entry(kind:"ordinaryTerminal",serverDigest:active.serverDigest,principal:active.principal,endpoint:active.endpoint,session:active.session,original:active.original,originalDigest:active.originalDigest,expectedRevision:active.expectedRevision,response:response));let confirmed=try commit(next,scope:scope,expected:head);revalidatedHead=confirmed.digest}
    }
    public func revalidateAuthenticatedOrdinaryTerminal(scope: Scope, response: Data, lease: any MobileControlExclusiveLease) throws {
        try fenced(scope,lease) {Self.lock.lock();defer{Self.lock.unlock()};let (doc,_,head,active)=try read(scope);guard active==nil,let last=doc.entries.last,last.kind=="ordinaryTerminal",let stored=last.response,let first=try? MobileOrdinaryControl.terminalIdentity(response:stored,original:last.original),let second=try? MobileOrdinaryControl.terminalIdentity(response:response,original:last.original),first==second else {throw Failure.held};revalidatedHead=head.digest}
    }
}
