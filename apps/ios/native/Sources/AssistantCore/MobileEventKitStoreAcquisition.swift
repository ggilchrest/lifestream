import Foundation

enum MobileEventKitRecord { case event(any MobileEventKitEventReading), reminder(any MobileEventKitReminderReading) }
enum MobileEventKitReadAccess { case fullRead, denied, restricted, writeOnly, unknown }
protocol MobileEventKitFetchToken: AnyObject {}
protocol MobileEventKitReminderBatch {
    var count: Int { get }
    func reminder(at index: Int) -> any MobileEventKitReminderReading
}
/// The lowest SDK boundary only; tests retain the production bridge below.
protocol MobileEventKitStoreReading {
    func access(_ plan: MobileEventKitAcquisition.Plan) -> MobileEventKitReadAccess
    func enumerateEvents(_ plan: MobileEventKitAcquisition.Plan, yield: @escaping (any MobileEventKitEventReading) -> Bool) throws
    func fetchReminders(_ plan: MobileEventKitAcquisition.Plan, completion: @escaping ((any MobileEventKitReminderBatch)?) -> Void) throws -> any MobileEventKitFetchToken
    /// Documented suppression of a not-yet-entered completion after this returns.
    func cancelFetch(_ token: any MobileEventKitFetchToken)
}
final class MobileEventKitStoreAcquisition {
    typealias Plan = MobileEventKitAcquisition.Plan
    typealias Failure = MobileEventKitAcquisition.Failure
    private let port: any MobileEventKitStoreReading, execute: (@escaping () -> Void) -> Void
    init(port: any MobileEventKitStoreReading, execute: @escaping (@escaping () -> Void) -> Void) { self.port=port;self.execute=execute }
    static func owner<T>(_ body: () -> T) -> T { Thread.isMainThread ? body() : DispatchQueue.main.sync(execute:body) }
    func access(_ plan: Plan) -> Bool { if case .fullRead=port.access(plan){return true};return false }
    func start(plan: Plan, yield: @escaping (MobileEventKitRecord) -> Bool, completion: @escaping (Result<Void,Failure>) -> Void) -> Query {
        let query=Query(port:port,execute:execute,plan:plan,yield:yield,completion:completion);query.start();return query
    }
    /// Retirement means observable callback/token obligations ended under the
    /// SDK contract, not proof of internal EventKit worker/memory quiescence.
    final class Query {
        private let port: any MobileEventKitStoreReading, execute: (@escaping () -> Void) -> Void, plan: Plan
        private let yield: (MobileEventKitRecord) -> Bool, completion: (Result<Void,Failure>) -> Void
        private let lock=NSLock()
        private var worker=1, bodies=0, cancelWork=0
        private var installed=false, pendingResult: Result<Void,Failure>?
        private var awaiting=false, claimed=false, cancelled=false, stopped=false, sent=false, retired=false, cancelScheduled=false
        private var token: (any MobileEventKitFetchToken)?, waiters: [() -> Void]=[]
        init(port: any MobileEventKitStoreReading, execute: @escaping (@escaping () -> Void) -> Void, plan: Plan, yield: @escaping (MobileEventKitRecord) -> Bool, completion: @escaping (Result<Void,Failure>) -> Void) {
            self.port=port;self.execute=execute;self.plan=plan;self.yield=yield;self.completion=completion
        }
        private func synchronized<T>(_ body: () -> T) -> T { lock.lock();defer{lock.unlock()};return body() }
        private func finish(_ result: Result<Void,Failure>) {
            let first=synchronized { () -> Bool in guard !sent else{return false};sent=true;pendingResult=nil;return true }
            if first { MobileEventKitStoreAcquisition.owner { completion(result) } }
        }
        private func callbackResult(_ result: Result<Void,Failure>) {
            let deliver: Result<Void,Failure>?=synchronized {
                guard !sent else{return nil}
                guard installed else{pendingResult=result;return nil}
                return result
            }
            if let deliver{finish(deliver)}
        }
        private func publish() {
            let callbacks: [() -> Void]=synchronized {
                guard !retired,sent,worker==0,bodies==0,cancelWork==0,!awaiting else{return []}
                retired=true;let values=waiters;waiters=[];return values
            }
            if !callbacks.isEmpty { DispatchQueue.main.async {callbacks.forEach{$0()}} }
        }
        func whenRetired(_ done: @escaping () -> Void) {
            let ready=synchronized { () -> Bool in if retired{return true};waiters.append(done);return false }
            if ready {DispatchQueue.main.async(execute:done)}
        }
        private func scheduleCancel() {
            let value: (any MobileEventKitFetchToken)?=synchronized {
                guard cancelled,!retired,!claimed,!cancelScheduled,let token else{return nil};cancelScheduled=true;cancelWork+=1;return token
            }
            guard let value else{return}
            execute { [self] in
                port.cancelFetch(value)
                synchronized {awaiting=false;cancelWork-=1};publish()
            }
        }
        func cancel() {
            synchronized {cancelled=true};finish(.failure(.cancelled));scheduleCancel();publish()
        }
        private func accept(_ value: MobileEventKitRecord) -> Bool {
            guard synchronized({!cancelled && !stopped && !sent}) else{return false}
            let keep=MobileEventKitStoreAcquisition.owner { () -> Bool in
                guard case .fullRead=port.access(plan) else{return false}
                guard synchronized({!cancelled && !stopped && !sent}) else{return false}
                return yield(value)
            }
            if !keep{synchronized{stopped=true}}
            return keep
        }
        func start() {
            execute { [self] in
                defer{synchronized{worker-=1};publish()}
                guard synchronized({!cancelled}) else{finish(.failure(.cancelled));return}
                do {
                    if plan.category=="CalendarEvent" {
                        try port.enumerateEvents(plan) {self.accept(.event($0))}
                        finish(synchronized({cancelled}) ? .failure(.cancelled):synchronized({stopped}) ? .failure(.incomplete):.success(()))
                    } else {
                        synchronized{awaiting=true}
                        let handle=try port.fetchReminders(plan) { [weak self] batch in
                            guard let self else{return}
                            let first=self.synchronized { () -> Bool in self.bodies+=1;guard !self.claimed else{return false};self.claimed=true;self.awaiting=false;return true }
                            defer{self.synchronized{self.bodies-=1};self.publish()}
                            guard first else{return}
                            guard self.synchronized({!self.cancelled}) else{self.callbackResult(.failure(.cancelled));return}
                            guard let batch else{self.callbackResult(.failure(.incomplete));return}
                            let count=batch.count
                            guard count>=0,count<=64 else{self.callbackResult(.failure(.truncated));return}
                            for index in 0..<count {
                                guard self.synchronized({!self.cancelled && !self.stopped && !self.sent}) else{break}
                                if !self.accept(.reminder(batch.reminder(at:index))){break}
                            }
                            self.callbackResult(self.synchronized({self.cancelled}) ? .failure(.cancelled):self.synchronized({self.stopped}) ? .failure(.incomplete):.success(()))
                        }
                        let result: Result<Void,Failure>?=synchronized {
                            token=handle;installed=true
                            let result=sent ? nil:pendingResult;pendingResult=nil;return result
                        }
                        scheduleCancel()
                        if let result{finish(result)}
                    }
                } catch {synchronized{awaiting=false;pendingResult=nil};finish(.failure(.unavailable))}
            }
        }
    }
}

#if canImport(EventKit)
import EventKit

private final class MobileEventKitSDKFetchToken: MobileEventKitFetchToken { let value: Any;init(_ value: Any){self.value=value} }
private struct MobileEventKitSDKReminderBatch: MobileEventKitReminderBatch {
    let values: [EKReminder]
    var count: Int {values.count}
    func reminder(at index: Int) -> any MobileEventKitReminderReading {MobileEventKitSDKReminderProperties(values[index])}
}
/// Caller owns this store and its calendar objects. No construction or access request.
private final class MobileEventKitSDKStore: MobileEventKitStoreReading {
    let store: EKEventStore, calendars: [EKCalendar]
    init(_ store: EKEventStore, _ calendars: [EKCalendar]){self.store=store;self.calendars=calendars}
    private func selected(_ plan: MobileEventKitAcquisition.Plan) -> [EKCalendar]? {
        guard calendars.count==plan.selectedContainerIDs.count,calendars.count<=32 else{return nil}
        let supplied=calendars.map{Data($0.calendarIdentifier.utf8)}, wanted=plan.selectedContainerIDs.map{Data($0.utf8)}
        guard Set(supplied).count==supplied.count,Set(supplied)==Set(wanted) else{return nil}
        return calendars
    }
    func access(_ plan: MobileEventKitAcquisition.Plan) -> MobileEventKitReadAccess {
        guard let calendars=selected(plan),NSTimeZone.default==plan.capturedSDKDefaultTimeZone else{return .unknown}
        let events=plan.category=="CalendarEvent"
        guard calendars.allSatisfy({$0.allowedEntityTypes.contains(events ? .event:.reminder)}) else{return .unknown}
        let status=EKEventStore.authorizationStatus(for:events ? .event:.reminder)
        if #available(iOS 17,macOS 14,*) {if status == .fullAccess{return .fullRead};if status == .writeOnly{return .writeOnly}}
        else if status == .authorized{return .fullRead}
        if status == .denied{return .denied};if status == .restricted{return .restricted};return .unknown
    }
    func enumerateEvents(_ plan: MobileEventKitAcquisition.Plan, yield: @escaping (any MobileEventKitEventReading) -> Bool) throws {
        guard !Thread.isMainThread,let selected=selected(plan) else{throw MobileEventKitAcquisition.Failure.stale}
        let predicate=store.predicateForEvents(withStart:plan.coverageStart,end:plan.coverageEnd,calendars:selected)
        store.enumerateEvents(matching:predicate){event,stop in if !yield(MobileEventKitSDKEventProperties(event)){stop.pointee=true}}
    }
    func fetchReminders(_ plan: MobileEventKitAcquisition.Plan, completion: @escaping ((any MobileEventKitReminderBatch)?) -> Void) throws -> any MobileEventKitFetchToken {
        guard !Thread.isMainThread,let selected=selected(plan) else{throw MobileEventKitAcquisition.Failure.stale}
        let predicate=store.predicateForReminders(in:selected)
        let token=store.fetchReminders(matching:predicate){values in completion(values.map{MobileEventKitSDKReminderBatch(values:$0)})}
        return MobileEventKitSDKFetchToken(token)
    }
    func cancelFetch(_ token: any MobileEventKitFetchToken){if let token=token as? MobileEventKitSDKFetchToken{store.cancelFetchRequest(token.value)}}
}
extension MobileEventKitAcquisition {
    public convenience init(outbox: HealthOutbox, store: EKEventStore, selectedCalendars: [EKCalendar], executeOnWorker: @escaping (@escaping () -> Void) -> Void) {
        self.init(outbox:outbox,storePort:MobileEventKitSDKStore(store,selectedCalendars),executeOnWorker:executeOnWorker)
    }
}
#endif
