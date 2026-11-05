import Foundation

/// Inert native value preparation only. No EventKit/Android SDK, permission,
/// identity authority, persistence, transport or write capability is provided.
enum MobileCalendarMapping {
    /// Producer instants support milliseconds, so reject unrepresentable values
    /// rather than silently rounding source time or inventing a year/zone.
    private static func validInstant(_ date:Date)->Bool {
        guard date.timeIntervalSince1970.isFinite else{return false}
        let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];let text=f.string(from:date)
        guard text.range(of:"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",options:.regularExpression) != nil else{return false}
        return MobileCalendarDate(String(text.prefix(10))) != nil && f.date(from:text) == date
    }
    enum Platform: String { case eventKit, androidCalendar, googleTasks }
    enum Failure: Error { case invalid, unsupported }
    /// Namespace is supplied by the enrolled source owner; local/external IDs
    /// are preserved as scoped evidence and are never treated as global identity.
    struct Source: Equatable {
        let platform:Platform, namespace:UUID, containerID:String, localID:String
        let accountID:String?, externalID:String?, revision:String?
        init(platform:Platform,namespace:UUID,containerID:String,localID:String,accountID:String?,externalID:String?,revision:String?) throws {
            func valid(_ s:String?,required:Bool=false)->Bool {guard let s else{return !required};return !s.isEmpty && s.utf8.count<=1024}
            guard valid(containerID,required:true),valid(localID,required:true),valid(accountID),valid(externalID),valid(revision) else{throw Failure.invalid}
            self.platform=platform;self.namespace=namespace;self.containerID=containerID;self.localID=localID;self.accountID=accountID;self.externalID=externalID;self.revision=revision
        }
    }
    /// A floating local time is a source value, not an instant or device zone.
    struct LocalDateTime: Equatable {
        let date:MobileCalendarDate, hour:Int, minute:Int, second:Int
        init(date:String,hour:Int,minute:Int,second:Int)throws {
            guard let date=MobileCalendarDate(date),(0...23).contains(hour),(0...59).contains(minute),(0...59).contains(second) else{throw Failure.invalid}
            self.date=date;self.hour=hour;self.minute=minute;self.second=second
        }
    }
    enum ZoneEvidence:Equatable {case unknown,supplied(String),inferred(String,basis:String)}
    enum OffsetEvidence:Equatable {case unknown,supplied(Int),inferred(Int,basis:String)}
    private static func validZone(_ value:ZoneEvidence)->Bool {
        switch value {case .unknown:return true;case .supplied(let id):return id.utf8.count<=128 && TimeZone(identifier:id) != nil;case .inferred(let id,let basis):return id.utf8.count<=128 && TimeZone(identifier:id) != nil && !basis.isEmpty && basis.utf8.count<=256}
    }
    private static func validOffset(_ value:OffsetEvidence)->Bool {
        switch value {case .unknown:return true;case .supplied(let n):return (-840...840).contains(n);case .inferred(let n,let basis):return (-840...840).contains(n) && !basis.isEmpty && basis.utf8.count<=256}
    }
    enum EventTime: Equatable {
        case allDay(MobileCalendarAllDayRange)
        case allDayWithZone(MobileCalendarAllDayRange,ZoneEvidence)
        case evidencedInstants(start:Date,end:Date,startZone:ZoneEvidence,endZone:ZoneEvidence,startOffset:OffsetEvidence,endOffset:OffsetEvidence)
        case instants(start:Date,end:Date,sourceZone:MobileSourceTimeZone)
        /// Inference retains its basis; it is never labelled as source-supplied.
        case inferredInstants(start:Date,end:Date,zone:String,basis:String)
        case floating(start:LocalDateTime,end:LocalDateTime)
        static func allDay(start:String,endExclusive:String)throws->Self {guard let range=MobileCalendarAllDayRange(start:start,endExclusive:endExclusive) else{throw Failure.invalid};return .allDay(range)}
        static func instants(start:Date,end:Date,sourceZone:String?)throws->Self {
            guard validInstant(start),validInstant(end),end>start,let zone=MobileSourceTimeZone(supplied:sourceZone) else{throw Failure.invalid};return .instants(start:start,end:end,sourceZone:zone)
        }
        static func validatedFloating(start:LocalDateTime,end:LocalDateTime)throws->Self {
            let a=(start.date,start.hour,start.minute,start.second),b=(end.date,end.hour,end.minute,end.second)
            guard a<b else{throw Failure.invalid};return .floating(start:start,end:end)
        }
    }
    /// Original occurrence is distinct from the edited start of a detached item.
    enum OccurrenceSelector: Equatable {case civilDate(MobileCalendarDate),instant(Date),floating(LocalDateTime),unknown}
    struct Occurrence: Equatable {
        let original:OccurrenceSelector,detached:Bool,seriesUpstreamID:String?
        init(original:OccurrenceSelector,detached:Bool,seriesUpstreamID:String?=nil)throws {
            if let id=seriesUpstreamID {guard !id.isEmpty,id.utf8.count<=1024 else{throw Failure.invalid}}
            self.original=original;self.detached=detached;self.seriesUpstreamID=seriesUpstreamID
        }
    }
    /// A missing rule differs from an unobservable or unsupported rule. Opaque
    /// provider data remains bounded and is not expanded or guessed by this type.
    enum Recurrence: Equatable {
        case none, unknown
        case observedNativeRule(String)
        static func observed(_ value:String)throws->Self {guard !value.isEmpty,value.utf8.count<=4096 else{throw Failure.invalid};return .observedNativeRule(value)}
    }
    enum EventStatus:Equatable {case confirmed,tentative,cancelled,unknown}
    struct Event: Equatable {
        let source:Source,time:EventTime,occurrence:Occurrence?,recurrence:Recurrence,status:EventStatus,title:String?,notes:String?
        /// Alarm metadata is not a task and grants no operation by itself.
        let alarmOffsetsSeconds:[Int]?
        init(source:Source,time:EventTime,occurrence:Occurrence?,recurrence:Recurrence,status:EventStatus,alarmOffsetsSeconds:[Int]?,title:String?=nil,notes:String?=nil)throws {
            guard source.platform != .googleTasks,alarmOffsetsSeconds.map({$0.count<=32 && $0.allSatisfy({(-31536000...31536000).contains($0)})}) ?? true else{throw Failure.invalid}
            guard title.map({$0.unicodeScalars.count<=1024}) ?? true,notes.map({$0.unicodeScalars.count<=8192}) ?? true else{throw Failure.invalid}
            if case .allDayWithZone(_,let z)=time {guard validZone(z) else{throw Failure.invalid}}
            if case .evidencedInstants(let start,let end,let a,let b,let c,let d)=time {guard validInstant(start),validInstant(end),end>start,validZone(a),validZone(b),validOffset(c),validOffset(d) else{throw Failure.invalid}}
            if case .instants(let start,let end,_) = time {guard validInstant(start),validInstant(end),end>start else{throw Failure.invalid}}
            if case .inferredInstants(let start,let end,let zone,let basis) = time {
                guard validInstant(start),validInstant(end),end>start,TimeZone(identifier:zone) != nil,!basis.isEmpty,basis.utf8.count<=256 else{throw Failure.invalid}
            }
            if case .floating(let start,let end) = time {_ = try EventTime.validatedFloating(start:start,end:end)}
            if case .instant(let date)? = occurrence?.original {guard validInstant(date) else{throw Failure.invalid}}
            self.source=source;self.time=time;self.occurrence=occurrence;self.recurrence=recurrence;self.status=status;self.alarmOffsetsSeconds=alarmOffsetsSeconds;self.title=title;self.notes=notes
        }
    }
    /// Partial date components are retained as supplied, without filling from now.
    struct DueComponents:Equatable {
        let year:Int?,month:Int?,day:Int?,hour:Int?,minute:Int?,second:Int?,sourceZone:MobileSourceTimeZone,calendarIdentifier:String?
        init(year:Int?,month:Int?,day:Int?,hour:Int?,minute:Int?,second:Int?,sourceZone:String?,calendarIdentifier:String?=nil)throws {
            guard [year,month,day,hour,minute,second].contains(where:{$0 != nil}),year.map({(1...9999).contains($0)}) ?? true,month.map({(1...13).contains($0)}) ?? true,day.map({(1...31).contains($0)}) ?? true,hour.map({(0...23).contains($0)}) ?? true,minute.map({(0...59).contains($0)}) ?? true,second.map({(0...59).contains($0)}) ?? true,let zone=MobileSourceTimeZone(supplied:sourceZone) else{throw Failure.invalid}
            if let calendarIdentifier {guard !calendarIdentifier.isEmpty,calendarIdentifier.utf8.count<=128 else{throw Failure.invalid}}
            if let month, calendarIdentifier == "gregorian" || calendarIdentifier == "iso8601" {guard month<=12 else{throw Failure.invalid}}
            if let month,let day,calendarIdentifier == "gregorian" || calendarIdentifier == "iso8601" {
                let validationYear = year ?? 2000
                guard MobileCalendarDate(String(format:"%04d-%02d-%02d",validationYear,month,day)) != nil else{throw Failure.invalid}
            }
            self.year=year;self.month=month;self.day=day;self.hour=hour;self.minute=minute;self.second=second;self.sourceZone=zone;self.calendarIdentifier=calendarIdentifier
        }
    }
    enum TaskDue:Equatable {case absent,unknown,date(MobileCalendarDate),instant(Date,MobileSourceTimeZone),components(DueComponents)}
    enum Completion:Equatable {case incomplete,completed(at:Date?),unknown}
    struct Task:Equatable {
        let source:Source,due:TaskDue,completion:Completion,recurrence:Recurrence,title:String?,notes:String?
        init(source:Source,due:TaskDue,completion:Completion,recurrence:Recurrence,title:String?=nil,notes:String?=nil)throws {
            guard source.platform != .androidCalendar,title.map({$0.unicodeScalars.count<=1024}) ?? true,notes.map({$0.unicodeScalars.count<=8192}) ?? true else{throw Failure.invalid}
            if source.platform == .googleTasks {
                switch due {case .absent,.unknown,.date:break;case .instant,.components:throw Failure.unsupported}
                if case .none = recurrence {throw Failure.unsupported}
            }
            if case .instant(let date,_) = due {guard validInstant(date) else{throw Failure.invalid}}
            if case .completed(let date?) = completion {guard validInstant(date) else{throw Failure.invalid}}
            self.source=source;self.due=due;self.completion=completion;self.recurrence=recurrence;self.title=title;self.notes=notes
        }
    }
    /// Only an explicit provider deletion signal can produce a tombstone. An
    /// empty, partial or inaccessible scan conveys coverage and no deletes.
    enum Coverage:Equatable {case complete,partial,unknown}
    enum Change:Equatable {case event(Event),task(Task),explicitDeletion(Source)}
    static func changes(records:[Change],coverage:Coverage)->[Change] {records}
    /// Deterministic standalone producer *semantic data*, not a change envelope,
    /// authority, wire transport, SDK extraction or second schema validator.
    private static func zone(_ source:MobileSourceTimeZone)->[String:Any] {
        switch source {case .unknown:return ["kind":"unknown"];case .supplied(let id):return ["kind":"supplied","identifier":id]}
    }
    private static func zone(_ evidence:ZoneEvidence)->[String:Any] {switch evidence {case .unknown:return ["kind":"unknown"];case .supplied(let id):return ["kind":"supplied","identifier":id];case .inferred(let id,let basis):return ["kind":"inferred","identifier":id,"basis":basis]}}
    private static func offset(_ evidence:OffsetEvidence)->[String:Any] {switch evidence {case .unknown:return ["kind":"unknown"];case .supplied(let n):return ["kind":"supplied","minutes":n];case .inferred(let n,let basis):return ["kind":"inferred","minutes":n,"basis":basis]}}
    private static func instant(_ date:Date,zone:[String:Any],offset:[String:Any]=["kind":"unknown"])->[String:Any] {
        let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
        return ["at":f.string(from:date),"timeZone":zone,"offset":offset]
    }
    private static func wall(_ value:LocalDateTime)->String {String(format:"%@T%02d:%02d:%02d",value.date.text,value.hour,value.minute,value.second)}
    private static func recurrence(_ value:Recurrence)->[String:Any] {
        switch value {case .none:return ["kind":"none"];case .unknown:return ["kind":"unavailable","reason":"unknown","nativeRule":NSNull()];case .observedNativeRule(let raw):return ["kind":"unavailable","reason":"unsupported","nativeRule":raw]}
    }
    private static func occurrence(_ value:Occurrence?)->[String:Any] {
        guard let value else{return ["state":"unknown","seriesUpstreamId":NSNull(),"originalStart":NSNull()]}
        let point:Any
        switch value.original {case .unknown:point=NSNull();case .civilDate(let d):point=["kind":"date","date":d.text];case .instant(let d):point=["kind":"instant","value":instant(d,zone:["kind":"unknown"])];case .floating(let d):point=["kind":"floating","local":wall(d)]}
        return ["state":value.detached ? "detached":"occurrence","seriesUpstreamId":(value.seriesUpstreamID as Any?) ?? NSNull(),"originalStart":point]
    }
    static func producerEvent(_ event:Event)throws->Data {
        let time:[String:Any]
        switch event.time {
        case .allDay(let range):time=["kind":"allDay","startDate":range.start.text,"endDateExclusive":range.endExclusive.text,"timeZone":["kind":"unknown"]]
        case .allDayWithZone(let range,let z):time=["kind":"allDay","startDate":range.start.text,"endDateExclusive":range.endExclusive.text,"timeZone":zone(z)]
        case .evidencedInstants(let start,let end,let sz,let ez,let so,let eo):time=["kind":"instantRange","start":instant(start,zone:zone(sz),offset:offset(so)),"end":instant(end,zone:zone(ez),offset:offset(eo))]
        case .instants(let start,let end,let sourceZone):time=["kind":"instantRange","start":instant(start,zone:zone(sourceZone)),"end":instant(end,zone:zone(sourceZone))]
        case .inferredInstants(let start,let end,let id,let basis):let z:[String:Any]=["kind":"inferred","identifier":id,"basis":basis];time=["kind":"instantRange","start":instant(start,zone:z),"end":instant(end,zone:z)]
        case .floating(let start,let end):time=["kind":"floatingRange","startLocal":wall(start),"endLocal":wall(end)]
        }
        let status:String;switch event.status {case .confirmed:status="confirmed";case .tentative:status="tentative";case .cancelled:status="cancelled";case .unknown:status="unknown"}
        let alarms:Any=event.alarmOffsetsSeconds.map{$0.map{["kind":"relative","seconds":$0] as [String:Any]}} ?? NSNull()
        return try JSONSerialization.data(withJSONObject:["schemaVersion":"1.0.0","title":(event.title as Any?) ?? NSNull(),"notes":(event.notes as Any?) ?? NSNull(),"time":time,"recurrence":recurrence(event.recurrence),"occurrence":occurrence(event.occurrence),"status":status,"attendees":NSNull(),"alarms":alarms],options:[.sortedKeys,.withoutEscapingSlashes])
    }
    static func producerTask(_ task:Task)throws->Data {
        let due:[String:Any]
        switch task.due {
        case .absent:due=["kind":"none"];case .unknown:due=["kind":"unknown"];case .date(let d):due=["kind":"date","date":d.text]
        case .instant(let d,let z):due=["kind":"instant","value":instant(d,zone:zone(z))]
        case .components(let c):
            var values:[String:Int]=[:];if let n=c.year{values["year"]=n};if let n=c.month{values["month"]=n};if let n=c.day{values["day"]=n};if let n=c.hour{values["hour"]=n};if let n=c.minute{values["minute"]=n};if let n=c.second{values["second"]=n}
            due=["kind":"components","values":values,"calendarIdentifier":(c.calendarIdentifier as Any?) ?? NSNull(),"timeZone":zone(c.sourceZone)]
        }
        let completion:[String:Any];switch task.completion {case .unknown:completion=["state":"unknown"];case .incomplete:completion=["state":"incomplete"];case .completed(let date):completion=["state":"completed","completedAt":date.map{instant($0,zone:["kind":"unknown"])} ?? NSNull()]}
        return try JSONSerialization.data(withJSONObject:["schemaVersion":"1.0.0","title":(task.title as Any?) ?? NSNull(),"notes":(task.notes as Any?) ?? NSNull(),"due":due,"completion":completion,"recurrence":recurrence(task.recurrence)],options:[.sortedKeys,.withoutEscapingSlashes])
    }
    enum SystemAccess:Equatable {case full,writeOnly,denied,restricted,notDetermined,unknown,unsupported}
    enum ApplicationReadGrant:Equatable {case allowed,notAllowed,unknown}
    static func mayRead(system:SystemAccess,application:ApplicationReadGrant)->Bool {system == .full && application == .allowed}
}
