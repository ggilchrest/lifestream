import Foundation
import CoreFoundation
import AssistantCore

/// Required lifetime fence from the original shared-outbox host. Not authority.
protocol NativeCalendarAcquisitionLease: AnyObject {
    var outbox: HealthOutbox {get}
    func checkCurrent() -> Bool
    func release()
}
/// Unregistered composition only. No installed source, broker, store or permissions.
final class NativeCalendarAcquisitionOwner {
    typealias Acquisition = MobileEventKitAcquisition
    typealias Outcome = Acquisition.CommitResult
    /// Source-only results: a settled prefix is not complete synchronization.
    enum DeliveryOutcome: Equatable {
        case acquisitionNotApplied(Acquisition.Failure), acquisitionUnconfirmed(attemptID: UUID)
        case emptyPending(acquired: Int?)
        case settled(accepted: Int, rejected: Int, retryable: Int, mayHaveMore: Bool, acquired: Int?)
        case requestTooLarge, transportFailure, invalidReceipt
        case notApplied(Acquisition.Failure), settlementUnconfirmed(attemptID: UUID)
    }
    private enum Operation {case collect, collectAndDeliver, pending}
    struct Configuration {
        let provenance: String, origin: String
        let human: UUID, session: UUID, endpoint: UUID, enrollment: UUID, namespace: UUID
        let plan: Acquisition.Plan
        let protectedAvailable: () -> Bool
        let deliveryScope:MobileCalendarSyncScope?
        let scopedRun:MobileCalendarSettingsWire.Run?
        let deliveryContract:MobileCalendarSelectedDelivery.Contract
        let configuredTerminal:MobileCalendarSettingsWire.Terminal?
        init(provenance:String,origin:String,human:UUID,session:UUID,endpoint:UUID,enrollment:UUID,namespace:UUID,plan:Acquisition.Plan,protectedAvailable:@escaping()->Bool,deliveryScope:MobileCalendarSyncScope?=nil,scopedRun:MobileCalendarSettingsWire.Run?=nil,configuredTerminal:MobileCalendarSettingsWire.Terminal?=nil,deliveryContract:MobileCalendarSelectedDelivery.Contract = .settingsScoped){
            self.provenance=provenance;self.origin=origin;self.human=human;self.session=session;self.endpoint=endpoint;self.enrollment=enrollment;self.namespace=namespace;self.plan=plan;self.protectedAvailable=protectedAvailable;self.deliveryScope=deliveryScope;self.scopedRun=scopedRun;self.configuredTerminal=configuredTerminal;self.deliveryContract=deliveryContract
        }
        var valid: Bool {
            guard (deliveryContract != .selected || scopedRun != nil),!provenance.isEmpty,provenance.utf8.count<=128,plan.valid,let url=URL(string:origin),url.scheme=="https",url.host != nil,url.user==nil,url.password==nil,url.query==nil,url.fragment==nil,url.path.isEmpty,url.absoluteString==origin else{return false};return true
        }
        func matches(_ b: Self) -> Bool {
            provenance.utf8.elementsEqual(b.provenance.utf8) && origin.utf8.elementsEqual(b.origin.utf8) && human==b.human && session==b.session && endpoint==b.endpoint && enrollment==b.enrollment && namespace==b.namespace && plan==b.plan && deliveryScope==b.deliveryScope && deliveryContract==b.deliveryContract && scopedRun==b.scopedRun && configuredTerminal?.response==b.configuredTerminal?.response && configuredTerminal?.command.original==b.configuredTerminal?.command.original
        }
    }
    private typealias Snapshot = NativeCalendarContext.Snapshot
    private typealias SnapshotNumbers = NativeCalendarSnapshotNumbers
    private final class Run {
        let config: Configuration, epoch: Int, generation: UInt64
        var completion: ((Outcome) -> Void)?
        let operation: Operation, attemptID=UUID()
        var deliveryCompletion: ((DeliveryOutcome) -> Void)?, acquired: Int?
        // Retained unchanged across HTTP uncertainty and, on ambiguous settlement,
        // for the lifetime of the original held Run/lease. Never logged or exported.
        var submitted: [Data]=[], body: Data?, receipt: Data?, task: URLSessionDataTask?
        var mayHaveMore=true
        var lease: (any NativeCalendarAcquisitionLease)?, acquisition: Acquisition?, snapshot: Snapshot?, proof: MobileCalendarPolicyProof?
        var pending=0, terminal=false, reported=false, held=false, committing=false, cancelled=false
        init(_ config: Configuration,_ epoch: Int,_ generation: UInt64,_ operation: Operation,_ completion: ((Outcome) -> Void)?,_ delivery: ((DeliveryOutcome) -> Void)?) {self.config=config;self.epoch=epoch;self.generation=generation;self.operation=operation;self.completion=completion;deliveryCompletion=delivery}
    }
    private let transport: NativeTransport, outbox: HealthOutbox, policy: NativeCalendarPolicy
    private let configuration: (() -> Configuration?)?, leaseFactory: (() throws -> any NativeCalendarAcquisitionLease)?, factory: ((HealthOutbox) -> Acquisition?)?
    private let clock: () throws -> Date
    private var active: Run?, generation: UInt64=0, waiters: [() -> Void]=[], releasing=false, admitting=false, admissionCancelled=false
    var busy: Bool {precondition(Thread.isMainThread);return active != nil || admitting}
    init(transport: NativeTransport, outbox: HealthOutbox, configuration: (() -> Configuration?)?=nil, acquireOriginalOwnerLease: (() throws -> any NativeCalendarAcquisitionLease)?=nil, makeAcquisition: ((HealthOutbox) -> Acquisition?)?=nil, captureClock: @escaping () throws -> Date) {
        self.transport=transport;self.outbox=outbox;self.configuration=configuration;leaseFactory=acquireOriginalOwnerLease;factory=makeAcquisition;clock=captureClock;policy=NativeCalendarPolicy(transport:transport,outbox:outbox)
    }
    func whenDrained(_ done: @escaping () -> Void) {precondition(Thread.isMainThread);waiters.append(done);release()}
    private func begin(_ run: Run){run.pending+=1}
    private func end(_ run: Run){run.pending-=1;precondition(run.pending>=0);release()}
    private func release(){
        guard !releasing,!admitting else{return}
        if let run=active {guard run.terminal,!run.held,run.pending==0 else{return}}
        releasing=true
        DispatchQueue.main.async { [self] in
            // Lease release and observer callbacks may reenter. Admission stays
            // fenced until the entire old retirement publication has returned.
            defer {
                releasing=false
                if !waiters.isEmpty {release()}
            }
            guard !admitting else{return}
            if let run=active {
                guard run.terminal,!run.held,run.pending==0 else{return}
                active=nil;run.lease?.release();run.lease=nil
            }
            let callbacks=waiters;waiters=[]
            for (index,callback) in callbacks.enumerated() {
                guard active==nil,!admitting else{waiters.insert(contentsOf:callbacks[index...],at:0);return}
                callback()
            }
        }
    }

    private func report(_ run: Run,_ outcome: Outcome){guard !run.reported else{return};run.reported=true;let callback=run.completion;run.completion=nil;callback?(outcome)}
    private func finish(_ run: Run,_ outcome: Outcome){
        if run.operation != .collect {
            switch outcome {
            case .committed(let count,_):
                run.acquired=count
                if run.cancelled {finishDelivery(run,.notApplied(.cancelled))}
                else {prepareDelivery(run)}
            case .notApplied(let reason):finishDelivery(run,run.acquired==nil && run.operation == .collectAndDeliver ? .acquisitionNotApplied(reason):.notApplied(reason))
            case .unconfirmed(let id):run.held=true;finishDelivery(run,.acquisitionUnconfirmed(attemptID:id))
            }
            return
        }
        if case .unconfirmed=outcome {run.held=true}
        run.terminal=true
        if case .notApplied=outcome {policy.invalidate(enrollment:run.config.enrollment)}
        report(run,outcome)
        if case .notApplied=outcome {run.acquisition?.cancel()}
        release()
    }
    func cancel(){
        precondition(Thread.isMainThread);generation &+= 1;if admitting{admissionCancelled=true};guard let run=active else{return}
        run.cancelled=true
        // Do not reenter the non-recursive outbox lock from a storage callback.
        // Once a write was invoked its actual outcome must be observed first.
        if run.committing{return}
        policy.invalidate(enrollment:run.config.enrollment)
        if run.held{return}
        run.task?.cancel()
        run.acquisition?.cancel()
        // A synchronous protected write may already have reached disk.
        if !run.committing {finish(run,.notApplied(.cancelled))}
    }
    func invalidate(){cancel()}
    private func pureCurrent(_ run: Run) -> Bool {
        guard active===run,!run.terminal,!run.cancelled,run.generation==generation,transport.epoch==run.epoch,transport.endpoint?.absoluteString.utf8.elementsEqual(run.config.origin.utf8)==true,transport.effectiveIsSelf,let owner=transport.currentEffectiveOwner else{return false}
        return UUID(uuidString:owner.principal)==run.config.human && UUID(uuidString:owner.session)==run.config.session
    }
    private func current(_ run: Run) -> Bool {
        // Finish every extensible protection/lease guard (including its box
        // getter) before taking the final native configuration snapshot. The
        // comparisons and transport/run fence below invoke no source callbacks.
        let protected=run.config.protectedAvailable(), lease=run.lease?.checkCurrent() ?? false, leasedBox=run.lease?.outbox
        let config=configuration?()
        guard let config,config.valid,config.matches(run.config),protected,lease,leasedBox === outbox else{return false}
        return pureCurrent(run)
    }
    private func number(_ value: Any?,_ tokens: SnapshotNumbers,_ path: [String]) -> Int? {
        guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),let exact=tokens.integer(path),n.int64Value==Int64(exact) else{return nil};return exact
    }
    private func bool(_ value: Any?,_ expected: Bool) -> Bool {guard let n=value as? NSNumber,CFGetTypeID(n)==CFBooleanGetTypeID() else{return false};return n.boolValue==expected}
    private func snapshot(_ run: Run,_ done: @escaping (Result<Snapshot,Error>) -> Void){
        guard current(run) else{done(.failure(Acquisition.Failure.stale));return}
        begin(run);var claimed=false
        transport.request("/api/auth/v1/user-context",maxBytes:65536){ [self] response in
            guard !claimed else{return};claimed=true;defer{end(run)}
            guard current(run),case .success(let(data,http))=response,http.statusCode==200,let auth=try? NativeCalendarContext.auth(data,human:run.config.human,session:run.config.session) else{done(.failure(Acquisition.Failure.stale));return}
            begin(run);var sessionClaimed=false
            transport.request("/api/runtime/v1/session-context",maxBytes:65536){ [self] response in
                guard !sessionClaimed else{return};sessionClaimed=true;defer{end(run)}
                guard current(run),case .success(let(data,http))=response,http.statusCode==200,let value=try? NativeCalendarContext.session(data,auth:auth,endpoint:run.config.endpoint,epoch:run.epoch) else{done(.failure(Acquisition.Failure.stale));return}
                done(.success(value))
            }
        }
    }
    private func authorize(_ run: Run, initial: Bool, _ done: @escaping (Result<MobileCalendarPolicyProof,Error>) -> Void){
        snapshot(run){ [self] before in
            guard case .success(let first)=before,current(run),initial || first==run.snapshot else{done(.failure(Acquisition.Failure.stale));return}
            if initial {run.snapshot=first}
            begin(run);var claimed=false
            let binding=NativeCalendarPolicy.Binding(enrollment:run.config.enrollment,namespace:run.config.namespace,collector:"eventKit",category:run.config.plan.category)
            // Existing refresh has no cancellation handle. Keep this reservation
            // until its actual original completion, even after cancellation.
            policy.refresh(binding:binding,admission:.existingEnrollment){ [self] result in
                guard !claimed else{return};claimed=true;defer{end(run)}
                guard current(run),case .success(let proof)=result,proof.principal==run.config.human,proof.endpoint==run.config.endpoint,proof.enrollment==run.config.enrollment,proof.namespace==run.config.namespace,proof.collector=="eventKit",proof.categories.contains(run.config.plan.category),initial || (run.proof.map{Acquisition.sameProof($0,proof)} ?? false) else{done(.failure(Acquisition.Failure.stale));return}
                snapshot(run){ [self] after in
                    guard current(run),case .success(let final)=after,final==first,final==run.snapshot else{done(.failure(Acquisition.Failure.stale));return};done(.success(proof))
                }
            }
        }
    }
    func collect(completion: @escaping (Outcome) -> Void){start(.collect,completion:completion,delivery:nil)}
    func collectAndDeliver(completion: @escaping (DeliveryOutcome) -> Void){start(.collectAndDeliver,completion:nil,delivery:completion)}
    func deliverPending(completion: @escaping (DeliveryOutcome) -> Void){start(.pending,completion:nil,delivery:completion)}
    private func start(_ operation: Operation,completion: ((Outcome) -> Void)?,delivery: ((DeliveryOutcome) -> Void)?){
        precondition(Thread.isMainThread)
        func reject(_ reason: Acquisition.Failure){completion?(.notApplied(reason));delivery?(.notApplied(reason))}
        guard active==nil,!admitting,!releasing else{reject(.busy);return}
        admitting=true;admissionCancelled=false;generation &+= 1;let admission=generation
        defer{admitting=false;release()}
        let supplied=configuration?()
        guard !admissionCancelled,generation==admission,active==nil else{reject(.cancelled);return}
        guard let config=supplied,config.valid,leaseFactory != nil,(operation == .pending || factory != nil) else{reject(.unavailable);return}
        let run=Run(config,transport.epoch,admission,operation,completion,delivery);active=run
        do {run.lease=try leaseFactory?()}catch{finish(run,.notApplied(.unavailable));return}
        guard current(run) else{finish(run,.notApplied(.stale));return}
        if operation == .pending {
            authorize(run,initial:true){[self] result in
                guard current(run),case .success(let proof)=result else{if !run.reported{finishDelivery(run,.notApplied(run.cancelled ? .cancelled:.stale))};return}
                run.proof=proof;prepareDelivery(run)
            }
            return
        }
        guard let acquisition=factory?(outbox),acquisition.outbox === outbox else{finish(run,.notApplied(.unavailable));return};run.acquisition=acquisition
        guard current(run) else{finish(run,.notApplied(.stale));return}
        authorize(run,initial:true){ [self] result in
            guard current(run),case .success(let proof)=result else{if !run.reported{finish(run,.notApplied(run.cancelled ? .cancelled:.stale))};return};run.proof=proof
            do {
                let ticket=try outbox.calendarTicket(enrollment:config.enrollment,category:config.plan.category)
                // A retained out-of-scope prefix stops the original acquisition
                // request as well as delivery. Never assume the queue is empty.
                if config.plan.category=="CalendarEvent"{_ = try scopedPending(run,ticket)}
                begin(run) // Covers source callback/token retirement and any held Page.
                acquisition.acquire(plan:config.plan,proof:proof,ticket:ticket,isCurrent:{ [self] in self.current(run) },captureClock:clock){ [self] result in
                    guard current(run),case .success(let page)=result else{if !run.reported{finish(run,.notApplied(run.cancelled ? .cancelled:.incomplete))};return}
                    authorize(run,initial:false){ [self] result in
                        guard current(run),case .success(let final)=result else{acquisition.discard(page);if !run.reported{finish(run,.notApplied(run.cancelled ? .cancelled:.stale))};return}
                        do {
                            let ticket=try outbox.calendarTicket(enrollment:config.enrollment,category:config.plan.category)
                            run.committing=true
                            let outcome=acquisition.commit(page:page,reauthorizedProof:final,ticket:ticket,isCurrent:{ [self] in self.current(run) })
                            run.committing=false
                            if run.cancelled{policy.invalidate(enrollment:run.config.enrollment)}
                            finish(run,outcome)
                        }catch{acquisition.discard(page);finish(run,.notApplied(.stale))}
                    }
                }
                var retired=false
                acquisition.whenDrained{ [self] in guard !retired else{return};retired=true;end(run) }
            }catch{finish(run,.notApplied(.unavailable))}
        }
    }
    private func finishDelivery(_ run: Run,_ result: DeliveryOutcome){
        guard !run.reported else{return}
        run.terminal=true;run.reported=true
        let callback=run.deliveryCompletion;run.deliveryCompletion=nil
        callback?(result);release()
    }
    private func scopedPending(_ run:Run,_ ticket:CalendarCollectionTicket)throws->[Data]{
        if run.config.plan.category != "CalendarEvent"{return try outbox.pendingCalendar(ticket:ticket,limit:64)}
        guard let scope=run.config.deliveryScope,scope.includes(run.config.plan) else{throw Acquisition.Failure.invalid}
        if let scoped=run.config.scopedRun{guard scoped.matches(scope:scope),scoped.selection.principal==run.config.human,scoped.selection.endpoint==run.config.endpoint,scoped.selection.enrollment==run.config.enrollment,scoped.selection.namespace==run.config.namespace,run.proof?.revision==scoped.selection.revision else{throw Acquisition.Failure.stale}}
        return try outbox.pendingCalendarWithinVerifiedScope(ticket:ticket,scope:scope,limit:64)
    }
    /// Fresh ticket and the exact captured prefix, never a silently rebuilt batch.
    /// Called after extensible native currency checks, followed by pureCurrent.
    private func checkedPending(_ run: Run) throws -> CalendarCollectionTicket {
        let ticket=try outbox.calendarTicket(enrollment:run.config.enrollment,category:run.config.plan.category)
        let now=try scopedPending(run,ticket)
        guard now.count>=run.submitted.count,Array(now.prefix(run.submitted.count))==run.submitted else{throw Acquisition.Failure.stale}
        run.mayHaveMore=run.mayHaveMore || now.count==64 || now.count>run.submitted.count
        return ticket
    }
    private func prepareDelivery(_ run: Run){
        guard current(run) else{finishDelivery(run,.notApplied(run.cancelled ? .cancelled:.stale));return}
        do {
            let ticket=try outbox.calendarTicket(enrollment:run.config.enrollment,category:run.config.plan.category)
            let pending=try scopedPending(run,ticket)
            guard pureCurrent(run) else{throw Acquisition.Failure.stale}
            if pending.isEmpty{finishDelivery(run,.emptyPending(acquired:run.acquired));return}
            var items:[MobileCalendarDelivery.Item]=[]
            for bytes in pending {
                if bytes.count>65536{break}
                let item=try MobileCalendarDelivery.item(bytes)
                let candidate:Data
                if let scoped=run.config.scopedRun{candidate=try run.config.deliveryContract == .selected ? MobileCalendarSelectedDelivery.batch(items+[item],run:scoped):MobileCalendarSettingsWire.batch(items+[item],run:scoped)}
                else{candidate=try MobileCalendarDelivery.batch(items+[item])}
                if candidate.count>65536{break}
                items.append(item);run.submitted.append(bytes);run.body=candidate
            }
            guard !items.isEmpty else{finishDelivery(run,.requestTooLarge);return}
            run.mayHaveMore=pending.count==64 || pending.count>items.count
            authorize(run,initial:false){[self] result in
                guard current(run),case .success=result else{if !run.reported{finishDelivery(run,.notApplied(run.cancelled ? .cancelled:.stale))};return}
                do {
                    guard let body=run.body,body.count<=65536,let text=String(data:body,encoding:.utf8) else{throw Acquisition.Failure.invalid}
                    _=try checkedPending(run)
                    // No extensible source callback or queue hop beyond this fence.
                    guard pureCurrent(run) else{throw Acquisition.Failure.stale}
                    begin(run);var claimed=false
                    let task=transport.request("/api/runtime/v1/mobile-context",method:"POST",body:text,internalHealth:true,maxBytes:65536){[self] response in
                        guard !claimed else{return};claimed=true;defer{end(run)}
                        guard !run.reported else{return}
                        guard current(run) else{finishDelivery(run,.notApplied(run.cancelled ? .cancelled:.stale));return}
                        guard case .success(let(data,http))=response,http.statusCode==200 else{finishDelivery(run,.transportFailure);return}
                        let originalReceipt:Data
                        do {
                            let expected=try run.submitted.map{try MobileCalendarDelivery.item($0)}
                            if run.config.deliveryContract == .selected{originalReceipt=try MobileCalendarSelectedDelivery.originalReceiptEnvelope(data,expected:expected)}
                            else{originalReceipt=run.config.scopedRun==nil ? data:try MobileCalendarSettingsWire.originalReceiptEnvelope(data,expected:expected)}
                            _=try MobileCalendarDelivery.receipts(originalReceipt,expected:expected)
                        }catch{finishDelivery(run,.invalidReceipt);return}
                        run.receipt=data // Retain ACTUAL raw producing response through unknown settlement.
                        authorize(run,initial:false){[self] result in
                            guard current(run),case .success=result else{if !run.reported{finishDelivery(run,.notApplied(run.cancelled ? .cancelled:.stale))};return}
                            do {
                                let result=try MobileCalendarDelivery.receipts(originalReceipt,expected:run.submitted.map{try MobileCalendarDelivery.item($0)})
                                let ticket=try checkedPending(run)
                                guard pureCurrent(run) else{throw Acquisition.Failure.stale}
                                // Mark invocation before entering original storage. Any
                                // throw from here may have replaced the durable snapshot.
                                run.committing=true
                                do {try outbox.settleCalendar(ticket:ticket,submitted:run.submitted,response:originalReceipt)}
                                catch {
                                    run.committing=false;run.held=true
                                    finishDelivery(run,.settlementUnconfirmed(attemptID:run.attemptID));return
                                }
                                run.committing=false
                                if run.cancelled{policy.invalidate(enrollment:run.config.enrollment)}
                                finishDelivery(run,.settled(accepted:result.accepted.count,rejected:result.rejected.count,retryable:result.held.count,mayHaveMore:run.mayHaveMore || !result.held.isEmpty,acquired:run.acquired))
                            }catch{if !run.reported{finishDelivery(run,.notApplied(run.cancelled ? .cancelled:.stale))}}
                        }
                    }
                    run.task=task
                    if run.cancelled || run.terminal{task?.cancel()}
                }catch{if !run.reported{finishDelivery(run,.notApplied(run.cancelled ? .cancelled:.stale))}}
            }
        }catch{if !run.reported{finishDelivery(run,.notApplied(run.cancelled ? .cancelled:.stale))}}
    }

}
