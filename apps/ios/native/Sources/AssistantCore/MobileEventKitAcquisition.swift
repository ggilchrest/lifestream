import Foundation
import CryptoKit

/// Native-only acquisition into the existing shared outbox. Construction is inert.
public final class MobileEventKitAcquisition {
    public enum Failure: Error, Equatable { case unavailable, invalid, stale, cancelled, incomplete, truncated, busy, storage }
    public enum CommitResult: Equatable { case committed(count: Int, attemptID: UUID), notApplied(Failure), unconfirmed(attemptID: UUID) }
    public struct Plan: Equatable {
        public let category: String, selectedContainerIDs: [String], mappingVersion: String
        public let coverageStart: Date, coverageEnd: Date, capturedSDKDefaultTimeZone: TimeZone
        public init(category: String, selectedContainerIDs: [String], mappingVersion: String, coverageStart: Date, coverageEnd: Date, capturedSDKDefaultTimeZone: TimeZone) {
            self.category=category; self.selectedContainerIDs=selectedContainerIDs; self.mappingVersion=mappingVersion
            self.coverageStart=coverageStart; self.coverageEnd=coverageEnd; self.capturedSDKDefaultTimeZone=capturedSDKDefaultTimeZone
        }
        public static func ==(a: Self, b: Self) -> Bool {
            a.category.utf8.elementsEqual(b.category.utf8) && a.mappingVersion.utf8.elementsEqual(b.mappingVersion.utf8) &&
            a.selectedContainerIDs.map { Data($0.utf8) } == b.selectedContainerIDs.map { Data($0.utf8) } &&
            a.coverageStart.timeIntervalSince1970.bitPattern == b.coverageStart.timeIntervalSince1970.bitPattern &&
            a.coverageEnd.timeIntervalSince1970.bitPattern == b.coverageEnd.timeIntervalSince1970.bitPattern &&
            a.capturedSDKDefaultTimeZone.identifier.utf8.elementsEqual(b.capturedSDKDefaultTimeZone.identifier.utf8) && a.capturedSDKDefaultTimeZone == b.capturedSDKDefaultTimeZone
        }
        public var valid: Bool {
            ["CalendarEvent","Task"].contains(category) && !selectedContainerIDs.isEmpty && selectedContainerIDs.count<=32 &&
            selectedContainerIDs.allSatisfy { !$0.isEmpty && $0.utf8.count<=1024 } && Set(selectedContainerIDs.map { Data($0.utf8) }).count == selectedContainerIDs.count &&
            !mappingVersion.isEmpty && mappingVersion.utf8.count<=64 && !mappingVersion.unicodeScalars.contains { $0.value<32 } &&
            (try? MobileEventKitAcquisition.timestamp(coverageStart)) != nil && (try? MobileEventKitAcquisition.timestamp(coverageEnd)) != nil &&
            coverageEnd>coverageStart && coverageEnd.timeIntervalSince(coverageStart)<=31*86400
        }
    }
    public struct Page { fileprivate let run: Run }
    fileprivate final class Run {
        let plan: Plan, proof: MobileCalendarPolicyProof, ticket: CalendarCollectionTicket, scope: MobileCalendarDelivery.CheckpointScope
        let expectedCheckpoint: Data?, generation: UInt64, attemptID=UUID()
        let current: () -> Bool, clock: () throws -> Date
        var completion: ((Result<Page,Failure>) -> Void)?
        var query: MobileEventKitStoreAcquisition.Query?, installing=true, retired=false, terminal=false, cancelled=false, reported=false, held=false, invoked=false
        var failure: Failure?, candidates: [MobileCalendarScanController.Candidate]=[], encoded: [Data]=[], bytes=0
        var started: Date?, ended: Date?, lastCapture: Date?, nextCheckpoint: Data?
        init(plan: Plan, proof: MobileCalendarPolicyProof, ticket: CalendarCollectionTicket, scope: MobileCalendarDelivery.CheckpointScope, expected: Data?, generation: UInt64, current: @escaping () -> Bool, clock: @escaping () throws -> Date, completion: @escaping (Result<Page,Failure>) -> Void) {
            self.plan=plan; self.proof=proof; self.ticket=ticket; self.scope=scope; expectedCheckpoint=expected; self.generation=generation; self.current=current; self.clock=clock; self.completion=completion
        }
    }
    public let outbox: HealthOutbox
    private let source: MobileEventKitStoreAcquisition, scanner: MobileCalendarScanController
    private var active: Run?, waiters: [() -> Void]=[], releaseScheduled=false, admitting=false, admissionCancelled=false
    public var busy: Bool { precondition(Thread.isMainThread); return active != nil || admitting }
    init(outbox: HealthOutbox, storePort: any MobileEventKitStoreReading, executeOnWorker: @escaping (@escaping () -> Void) -> Void) {
        self.outbox=outbox; source=MobileEventKitStoreAcquisition(port:storePort,execute:executeOnWorker); scanner=MobileCalendarScanController(outbox:outbox)
    }
    static func timestamp(_ value: Date) throws -> String {
        guard value.timeIntervalSince1970.isFinite else { throw Failure.invalid }
        let f=ISO8601DateFormatter(); f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]; let s=f.string(from:value)
        guard s.range(of:"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",options:.regularExpression) != nil, f.date(from:s)==value else { throw Failure.invalid }; return s
    }
    public static func sameProof(_ a: MobileCalendarPolicyProof, _ b: MobileCalendarPolicyProof) -> Bool {
        a.principal==b.principal && a.endpoint==b.endpoint && a.enrollment==b.enrollment && a.namespace==b.namespace &&
        a.collector.utf8.elementsEqual(b.collector.utf8) && a.revision==b.revision && a.categories==b.categories && a.bindingDigest.utf8.elementsEqual(b.bindingDigest.utf8)
    }
    public func whenDrained(_ done: @escaping () -> Void) { precondition(Thread.isMainThread); waiters.append(done); release() }
    private func release() {
        guard !releaseScheduled,!admitting else { return }
        if let run=active { guard run.terminal, !run.held, !run.installing, run.retired else { return } }
        releaseScheduled=true
        DispatchQueue.main.async { [self] in
            // Keep admission fenced through all externally supplied observers.
            defer {
                releaseScheduled=false
                if !waiters.isEmpty {release()}
            }
            guard !admitting else{return}
            if let run=active {guard run.terminal,!run.held,!run.installing,run.retired else{return};active=nil}
            let callbacks=waiters;waiters=[]
            for (index,callback) in callbacks.enumerated() {
                guard active==nil,!admitting else{waiters.insert(contentsOf:callbacks[index...],at:0);return}
                callback()
            }
        }
    }

    private func report(_ run: Run, _ result: Result<Page,Failure>) { guard !run.reported else{return}; run.reported=true;let callback=run.completion;run.completion=nil;callback?(result) }
    private func reject(_ run: Run, _ reason: Failure) {
        guard !run.held else{return}; run.failure=reason; run.terminal=true; run.cancelled=true; scanner.cancel()
        run.candidates=[]; run.encoded=[]; run.query?.cancel(); report(run,.failure(reason)); release()
    }
    public func cancel() { precondition(Thread.isMainThread); if admitting{admissionCancelled=true}; guard let run=active,!run.held else{return}; reject(run,.cancelled) }
    public func discard(_ page: Page) { precondition(Thread.isMainThread); guard active===page.run,!page.run.invoked else{return}; reject(page.run,.cancelled) }
    private func current(_ run: Run) -> Bool {
        // Extensible checks first, then re-check the original run after reentrancy.
        let access=source.access(run.plan), owner=run.current()
        return access && owner && active===run && !run.cancelled && !run.terminal
    }
    private func capture(_ run: Run) throws -> Date {
        let value=try run.clock(); _=try Self.timestamp(value)
        if let prior=run.lastCapture, value<prior { throw Failure.invalid }
        run.lastCapture=value; return value
    }
    public func acquire(plan: Plan, proof: MobileCalendarPolicyProof, ticket: CalendarCollectionTicket, isCurrent: @escaping () -> Bool, captureClock: @escaping () throws -> Date, completion: @escaping (Result<Page,Failure>) -> Void) {
        precondition(Thread.isMainThread)
        guard active==nil,!admitting,!releaseScheduled else{completion(.failure(.busy));return}
        admitting=true;admissionCancelled=false;defer{admitting=false;release()}
        guard plan.valid,proof.collector=="eventKit",proof.categories.contains(plan.category),ticket.enrollmentId==proof.enrollment,ticket.categoryName==plan.category else{completion(.failure(.invalid));return}
        do {
            let scope=try MobileCalendarDelivery.CheckpointScope(collector:"eventKit",namespace:proof.namespace,mappingVersion:plan.mappingVersion,coverage:.partial,start:Self.timestamp(plan.coverageStart),end:Self.timestamp(plan.coverageEnd))
            let access=source.access(plan), owner=isCurrent()
            guard access,owner,!admissionCancelled,active==nil,try outbox.calendarTicket(enrollment:proof.enrollment,category:plan.category)==ticket else{throw Failure.stale}
            let checkpoint=try outbox.calendarCheckpoint(scope:scope,ticket:ticket)
            let run=Run(plan:plan,proof:proof,ticket:ticket,scope:scope,expected:checkpoint,generation:scanner.begin(),current:isCurrent,clock:captureClock,completion:completion); active=run
            do { run.started=try capture(run) } catch { run.installing=false; run.retired=true; reject(run,.invalid); return }
            guard current(run),(try? outbox.calendarTicket(enrollment:proof.enrollment,category:plan.category))==ticket else{run.installing=false;run.retired=true;reject(run,.stale);return}
            let query=source.start(plan:plan,yield:{ [weak self,weak run] record in guard let self,let run else{return false};return self.consume(record,run) },completion:{ [weak self,weak run] result in guard let self,let run else{return};self.finishQuery(run,result) })
            run.query=query; run.installing=false
            query.whenRetired { [self,weak run] in guard let run else{return};run.retired=true;release() }
            if run.cancelled { query.cancel() }; release()
        } catch let error as Failure { completion(.failure(error)) }
        catch { completion(.failure(.unavailable)) }
    }
    private func consume(_ record: MobileEventKitRecord, _ run: Run) -> Bool {
        precondition(Thread.isMainThread)
        guard current(run) else { run.failure=run.cancelled ? .cancelled:.stale; return false }
        guard run.candidates.count<64 else { run.failure = .truncated;return false }
        do {
            let stamp=try capture(run)
            guard current(run) else{throw Failure.stale}
            let context=MobileEventKitSourceExtractor.Context(namespace:run.proof.namespace,capturedSDKDefaultTimeZone:run.plan.capturedSDKDefaultTimeZone)
            let observation: MobileEventKitAdapter.Observation, container: String
            switch record {
            case .event(let reader):
                guard run.plan.category=="CalendarEvent" else{throw Failure.incomplete}
                observation=try MobileEventKitSourceExtractor.event(reader,context:context)
                guard case .event(let value)=observation else{throw Failure.incomplete};container=value.source.containerID
            case .reminder(let reader):
                guard run.plan.category=="Task" else{throw Failure.incomplete}
                observation=try MobileEventKitSourceExtractor.reminder(reader,context:context)
                guard case .reminder(let value)=observation else{throw Failure.incomplete};container=value.source.containerID
            }
            guard run.plan.selectedContainerIDs.contains(where:{$0.utf8.elementsEqual(container.utf8)}) else{throw Failure.stale}
            let envelope=MobileEventKitAdapter.Envelope(eventId:UUID(),enrollmentId:run.proof.enrollment,policyRevision:run.proof.revision,mappingVersion:run.plan.mappingVersion,collectedAt:stamp,identityScope:.providerLocal)
            let item=try MobileEventKitAdapter.item(observation,envelope:envelope)
            guard run.bytes+item.data.count<=262144 else{throw Failure.truncated}
            guard current(run),try outbox.calendarTicket(enrollment:run.proof.enrollment,category:run.plan.category)==run.ticket else{throw Failure.stale}
            run.candidates.append(.init(observation:observation,envelope:envelope));run.encoded.append(item.data);run.bytes+=item.data.count;return true
        } catch let failure as Failure { run.failure=failure;return false }
        catch {run.failure = .incomplete;return false}
    }
    private func finishQuery(_ run: Run, _ result: Result<Void,Failure>) {
        precondition(Thread.isMainThread)
        guard active===run,!run.terminal,!run.reported else{return}
        if let failure=run.failure { reject(run,failure);return }
        guard case .success=result else{if case .failure(let error)=result{reject(run,error)};return}
        do {
            guard current(run) else{throw Failure.stale};run.ended=try capture(run)
            var candidateHash=Data();for bytes in run.encoded{candidateHash.append(Data("\(bytes.count):".utf8));candidateHash.append(bytes)}
            let marker:[String:Any]=["kind":"selectedContainerObservation/1","attemptId":run.attemptID.uuidString.lowercased(),"category":run.plan.category,"containers":run.plan.selectedContainerIDs,"coverageStart":try Self.timestamp(run.plan.coverageStart),"coverageEnd":try Self.timestamp(run.plan.coverageEnd),"decodeZone":run.plan.capturedSDKDefaultTimeZone.identifier,"mappingVersion":run.plan.mappingVersion,"captureStartedAt":try Self.timestamp(run.started!),"captureEndedAt":try Self.timestamp(run.ended!),"candidateDigest":SHA256.hash(data:candidateHash).map{String(format:"%02x",$0)}.joined()]
            run.nextCheckpoint=try MobileCalendarDelivery.canonical(marker)
            guard current(run) else{throw Failure.stale};report(run,.success(Page(run:run)))
        }catch let failure as Failure{reject(run,failure)}catch{reject(run,.invalid)}
    }
    public func commit(page: Page, reauthorizedProof: MobileCalendarPolicyProof, ticket: CalendarCollectionTicket, isCurrent: () -> Bool) -> CommitResult {
        precondition(Thread.isMainThread);let run=page.run
        if active===run,run.held{return .unconfirmed(attemptID:run.attemptID)}
        guard active===run,!run.invoked,!run.terminal,run.reported,let next=run.nextCheckpoint else{return .notApplied(.stale)}
        let access=source.access(run.plan), owner=run.current(), final=isCurrent()
        guard access,owner,final,active===run,!run.terminal,!run.cancelled,Self.sameProof(run.proof,reauthorizedProof),
              (try? outbox.calendarTicket(enrollment:run.proof.enrollment,category:run.plan.category))==ticket else{reject(run,.stale);return .notApplied(.stale)}
        run.invoked=true
        do {
            try scanner.commit(generation:run.generation,state:.complete,scope:run.scope,expectedCheckpoint:run.expectedCheckpoint,nextCheckpoint:next,candidates:run.candidates,ticket:ticket)
            run.terminal=true;let count=run.candidates.count;run.candidates=[];run.encoded=[];release();return .committed(count:count,attemptID:run.attemptID)
        }catch{
            // Existing commit API does not reveal whether replacement bytes reached disk.
            run.held=true;run.terminal=true;return .unconfirmed(attemptID:run.attemptID)
        }
    }
}
