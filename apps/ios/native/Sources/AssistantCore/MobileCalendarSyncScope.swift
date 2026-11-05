import Foundation
import CoreFoundation
import CryptoKit

/// User intent and bounded planning only. Neither a setting nor a scope grants access.
public struct MobileCalendarSyncWindow: Equatable {
    public let lookBackDays:Int,lookAheadDays:Int,timeZone:TimeZone
    public init?(lookBackDays:Int,lookAheadDays:Int,timeZone:String){
        guard (0...366).contains(lookBackDays),(0...366).contains(lookAheadDays),(1...366).contains(lookBackDays+lookAheadDays),
              !timeZone.isEmpty,timeZone.utf8.count<=128,TimeZone.knownTimeZoneIdentifiers.contains(timeZone) || timeZone=="UTC",let zone=TimeZone(identifier:timeZone) else{return nil}
        self.lookBackDays=lookBackDays;self.lookAheadDays=lookAheadDays;self.timeZone=zone
    }
    public init?(_ value:[String:Any]){
        func integer(_ key:String)->Int?{guard let n=value[key] as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue.rounded()==n.doubleValue,(0...366).contains(n.intValue),n.doubleValue==Double(n.intValue) else{return nil};return n.intValue}
        guard Set(value.keys)==Set(["schemaVersion","lookBackDays","lookAheadDays","timeZone"]),value["schemaVersion"] as? String=="1.0.0",let back=integer("lookBackDays"),let ahead=integer("lookAheadDays"),let zone=value["timeZone"] as? String else{return nil}
        self.init(lookBackDays:back,lookAheadDays:ahead,timeZone:zone)
    }
    public var json:[String:Any]{["schemaVersion":"1.0.0","lookBackDays":lookBackDays,"lookAheadDays":lookAheadDays,"timeZone":timeZone.identifier]}
    public struct Limits {
        public let maxTotalDays:Int,maxScans:Int,maxSelectedCalendars:Int
        public init?(maxTotalDays:Int,maxScans:Int,maxSelectedCalendars:Int){guard (1...366).contains(maxTotalDays),(1...8).contains(maxScans),(1...32).contains(maxSelectedCalendars) else{return nil};self.maxTotalDays=maxTotalDays;self.maxScans=maxScans;self.maxSelectedCalendars=maxSelectedCalendars}
        public var json:[String:Any]{["maxTotalDays":maxTotalDays,"maxScans":maxScans,"maxSelectedCalendars":maxSelectedCalendars,"maxScanSeconds":31*86400,"maxObservationsPerScan":64,"maxScanBytes":262144,"maxDeliveryBytes":65536]}
    }
    public struct Snapshot {
        public struct Window {public let start:Date,end:Date}
        public let settings:MobileCalendarSyncWindow,anchor:Date,start:Date,end:Date,windows:[Window]
    }
    /// One supplied anchor, local-day arithmetic, no rolling, truncation or cadence.
    public func plan(anchor:Date,selectedCalendars:Int,limits:Limits)->Snapshot?{
        guard lookBackDays+lookAheadDays<=limits.maxTotalDays,(1...limits.maxSelectedCalendars).contains(selectedCalendars),MobileCalendarSyncScope.timestamp(anchor) != nil else{return nil}
        var calendar=Calendar(identifier:.gregorian);calendar.timeZone=timeZone
        guard let start=calendar.date(byAdding:.day,value:-lookBackDays,to:anchor),let end=calendar.date(byAdding:.day,value:lookAheadDays,to:anchor),start<end else{return nil}
        var windows:[Snapshot.Window]=[]
        // Keeping the anchor as a boundary preserves the requested past/future split.
        for (a,b) in [(start,anchor),(anchor,end)]{
            var cursor=a
            while cursor<b {
                guard windows.count<limits.maxScans else{return nil}
                let next=min(b,cursor.addingTimeInterval(31*86400))
                guard next>cursor,MobileCalendarSyncScope.timestamp(cursor) != nil,MobileCalendarSyncScope.timestamp(next) != nil else{return nil}
                windows.append(.init(start:cursor,end:next));cursor=next
            }
        }
        return .init(settings:self,anchor:anchor,start:start,end:end,windows:windows)
    }
}

/// Immutable proof boundary supplied by the ORIGINAL verified selection owner.
/// Every matching scan observation is preserved. Logical event deduplication
/// belongs to stable source/occurrence identity and the original backend upsert.
public struct MobileCalendarSyncScope:Equatable {
    public struct Container:Equatable {
        public let id:String,accountID:String
        public init(id:String,accountID:String){self.id=id;self.accountID=accountID}
        public static func ==(a:Self,b:Self)->Bool{Data(a.id.utf8)==Data(b.id.utf8) && Data(a.accountID.utf8)==Data(b.accountID.utf8)}
    }
    public let containers:[Container],start:Date,end:Date,mappingVersion:String
    public init?(containers:[Container],start:Date,end:Date,mappingVersion:String){
        func identity(_ s:String)->Bool{!s.isEmpty && s.utf8.count<=1024 && !s.unicodeScalars.contains{$0.value<32}}
        guard !containers.isEmpty,containers.count<=32,containers.allSatisfy({identity($0.id)&&identity($0.accountID)}),Set(containers.map{Data($0.id.utf8)}).count==containers.count,
              Self.timestamp(start) != nil,Self.timestamp(end) != nil,end>start,end.timeIntervalSince(start)<=367*86400,
              !mappingVersion.isEmpty,mappingVersion.utf8.count<=64 else{return nil}
        self.containers=containers;self.start=start;self.end=end;self.mappingVersion=mappingVersion
    }
    public static func ==(a:Self,b:Self)->Bool{a.containers==b.containers && a.start.timeIntervalSince1970.bitPattern==b.start.timeIntervalSince1970.bitPattern && a.end.timeIntervalSince1970.bitPattern==b.end.timeIntervalSince1970.bitPattern && Data(a.mappingVersion.utf8)==Data(b.mappingVersion.utf8)}
    public func includes(_ plan:MobileEventKitAcquisition.Plan)->Bool{
        plan.category=="CalendarEvent" && Data(plan.mappingVersion.utf8)==Data(mappingVersion.utf8) && plan.coverageStart>=start && plan.coverageEnd<=end &&
        plan.selectedContainerIDs.allSatisfy{id in containers.contains{Data($0.id.utf8)==Data(id.utf8)}}
    }
    public static func timestamp(_ date:Date)->String?{
        guard date.timeIntervalSince1970.isFinite else{return nil};let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];let s=f.string(from:date);return f.date(from:s)==date ? s:nil
    }
    private static func date(_ text:Any?)->Date?{
        guard let s=text as? String,s.utf8.count<=64,s.hasSuffix("Z") else{return nil};let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];if let d=f.date(from:s){return d};f.formatOptions=[.withInternetDateTime];return f.date(from:s)
    }
    /// Unknown zones, floating times and tombstones cannot prove this temporal scope.
    private static func interval(_ time:[String:Any])->(Date,Date)?{
        if time["kind"] as? String=="instantRange",let a=time["start"] as? [String:Any],let b=time["end"] as? [String:Any],let start=date(a["at"]),let end=date(b["at"]),start<end{return(start,end)}
        guard time["kind"] as? String=="allDay",let zone=time["timeZone"] as? [String:Any],["supplied","inferred"].contains(zone["kind"] as? String ?? ""),let identifier=zone["identifier"] as? String,let tz=TimeZone(identifier:identifier),let a=time["startDate"] as? String,let b=time["endDateExclusive"] as? String else{return nil}
        let f=DateFormatter();f.locale=Locale(identifier:"en_US_POSIX");f.calendar=Calendar(identifier:.gregorian);f.timeZone=tz;f.dateFormat="yyyy-MM-dd";f.isLenient=false
        guard let start=f.date(from:a),let end=f.date(from:b),f.string(from:start)==a,f.string(from:end)==b,start<end else{return nil};return(start,end)
    }
    public func proves(_ data:Data,enrollment:UUID,namespace:UUID)->Bool{
        guard let item=try? MobileCalendarDelivery.item(data),item.enrollmentId==enrollment,item.namespace==namespace,item.category=="CalendarEvent",item.collector=="eventKit",item.operation=="upsert",Data(item.mappingVersion.utf8)==Data(mappingVersion.utf8),
              let root=try? JSONSerialization.jsonObject(with:item.data) as? [String:Any],let change=root["change"] as? [String:Any],let source=change["source"] as? [String:Any],let id=source["containerId"] as? String,let account=source["accountId"] as? String,
              containers.contains(where:{Data($0.id.utf8)==Data(id.utf8)&&Data($0.accountID.utf8)==Data(account.utf8)}),let record=change["record"] as? [String:Any],let time=record["time"] as? [String:Any],let (a,b)=Self.interval(time) else{return false}
        // Whole matching records may span the bounds; do not clip or discard them.
        return a<end && b>start
    }
}

// Consumer of the actual producer bundle r4 (schema hash below). This wire
// commitment never supplies SDK/store/session provenance or policy authority.
public enum MobileCalendarSettingsWire {
    public static let schemaID="https://lifestream.dev/contracts/mobile-context-calendar-settings-control/1.0.0"
    public static let schemaDigest="3d1582eedeb603448498625981aec1a0f3ab9126365d6c4f9688858b0eedfd28"
    public static var pin:[String:String]{["schemaId":schemaID,"schemaVersion":"1.0.0","digest":schemaDigest]}
    public enum Failure:Error{case invalid,held}
    static func keys(_ value:[String:Any],_ required:Set<String>,_ optional:Set<String>=[])->Bool{required.isSubset(of:Set(value.keys)) && Set(value.keys).isSubset(of:required.union(optional))}
    static func object(_ bytes:Data)throws->[String:Any]{
        guard bytes.count<=262144 else{throw Failure.invalid}
        let numbers=try CalendarSettingsNumbers(bytes)
        guard numbers.values.keys.allSatisfy({numbers.integer($0) != nil}),let value=try? JSONSerialization.jsonObject(with:bytes) as? [String:Any] else{throw Failure.invalid};return value
    }
    static func id(_ value:Any?)->UUID?{MobileControlOriginal.uuid(value)}
    static func integer(_ value:Any?,min:Int=1)->Int?{MobileControlOriginal.number(value,min:min,max:9007199254740991)}
    static func bool(_ value:Any?,_ expected:Bool)->Bool{MobileControlOriginal.boolean(value) && (value as? NSNumber)?.boolValue==expected}
    static func hash(_ domain:String,_ value:Data)->String{SHA256.hash(data:Data((domain+"\n").utf8)+value).map{String(format:"%02x",$0)}.joined()}
    static func digest(_ value:Any?)->Bool{(value as? String)?.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil}
    public struct Selection:Equatable {
        public struct CalendarIdentity:Equatable {
            public let containerID:String,accountID:String?
            public init(containerID:String,accountID:String?){self.containerID=containerID;self.accountID=accountID}
            public static func ==(a:Self,b:Self)->Bool{Data(a.containerID.utf8)==Data(b.containerID.utf8) && a.accountID.map{Data($0.utf8)}==b.accountID.map{Data($0.utf8)}}
        }
        public let principal:UUID,endpoint:UUID,enrollment:UUID,namespace:UUID,revision:Int,calendars:[CalendarIdentity],canonical:Data,digest:String
        public init?(principal:UUID,endpoint:UUID,enrollment:UUID,namespace:UUID,revision:Int,calendars:[CalendarIdentity]){
            func valid(_ s:String)->Bool{!s.isEmpty && s.unicodeScalars.count<=512 && !s.unicodeScalars.contains{$0.value<32}}
            guard (1...9007199254740991).contains(revision),!calendars.isEmpty,calendars.count<=32,calendars.allSatisfy({valid($0.containerID) && ($0.accountID.map(valid) ?? true)}),Set(calendars.map{Data($0.containerID.utf8)}).count==calendars.count else{return nil}
            let rows=calendars.map{["containerId":$0.containerID as Any,"accountId":$0.accountID as Any? ?? NSNull()]}
            guard let sorted=try? rows.map({(try MobileCalendarDelivery.canonical($0),$0)}).sorted(by:{$0.0.lexicographicallyPrecedes($1.0)}).map(\.1),
                  let bytes=try? MobileCalendarDelivery.canonical(["principalId":principal.uuidString.lowercased(),"endpointId":endpoint.uuidString.lowercased(),"enrollmentId":enrollment.uuidString.lowercased(),"sourceNamespace":namespace.uuidString.lowercased(),"configurationRevision":revision,"collector":"eventKit","upstreamIdentityScope":"providerLocal","calendars":sorted]) else{return nil}
            self.principal=principal;self.endpoint=endpoint;self.enrollment=enrollment;self.namespace=namespace;self.revision=revision;self.calendars=calendars;canonical=bytes;digest=MobileCalendarSettingsWire.hash("lifestream/calendar-selection/1",bytes)
        }
        public static func ==(a:Self,b:Self)->Bool{a.canonical==b.canonical}
    }
    public struct Run:Equatable {
        public let selection:Selection,anchor:Date,start:Date,end:Date,timeZone:String
        public init(selection:Selection,snapshot:MobileCalendarSyncWindow.Snapshot){self.selection=selection;anchor=snapshot.anchor;start=snapshot.start;end=snapshot.end;timeZone=snapshot.settings.timeZone.identifier}
        public var json:[String:Any]{["anchorAt":MobileCalendarSyncScope.timestamp(anchor)!,"startAt":MobileCalendarSyncScope.timestamp(start)!,"endAt":MobileCalendarSyncScope.timestamp(end)!,"timeZone":timeZone,"configurationRevision":selection.revision,"selectionDigest":selection.digest]}
        public func matches(scope:MobileCalendarSyncScope)->Bool{start==scope.start && end==scope.end && selection.calendars.count==scope.containers.count && selection.calendars.allSatisfy{a in scope.containers.contains{Data($0.id.utf8)==Data(a.containerID.utf8) && a.accountID.map{Data($0.utf8)}==Data($0.accountID.utf8)}}}
        public static func ==(a:Self,b:Self)->Bool{a.selection==b.selection && a.anchor==b.anchor && a.start==b.start && a.end==b.end && Data(a.timeZone.utf8)==Data(b.timeZone.utf8)}
    }
    public static func batch(_ items:[MobileCalendarDelivery.Item],run:Run)throws->Data{
        guard !items.isEmpty,items.count<=64,Set(items.map(\.eventId)).count==items.count,items.allSatisfy({$0.enrollmentId==run.selection.enrollment && $0.namespace==run.selection.namespace && $0.collector=="eventKit" && $0.category=="CalendarEvent" && $0.policyRevision==run.selection.revision}) else{throw Failure.invalid}
        let objects=try items.map{try object($0.data)}
        return try MobileCalendarDelivery.canonical(["producerPin":pin,"operation":"ingestScoped","payload":["schemaVersion":"1.0.0","enrollmentId":run.selection.enrollment.uuidString.lowercased(),"run":run.json,"items":objects]])
    }
    /// The new producer owns the outer pin. The ORIGINAL receipts/digests and
    /// sqlCommit durability are passed unchanged to the existing receipt parser.
    /// This pure shape adapter never upgrades held/observed/control results.
    public static func originalReceiptEnvelope(_ bytes:Data,expected:[MobileCalendarDelivery.Item])throws->Data{
        let root=try object(bytes)
        guard keys(root,["schemaVersion","producerPin","result"]),root["schemaVersion"] as? String=="1.0.0",root["producerPin"] as? [String:String]==pin,let result=root["result"] as? [String:Any],keys(result,["kind","receipts"]),result["kind"] as? String=="sync" else{throw Failure.invalid}
        let original=try MobileCalendarDelivery.canonical(["schemaVersion":"1.0.0","producerPin":["schemaId":MobileCalendarDelivery.schemaId,"schemaVersion":"1.0.0","digest":MobileCalendarDelivery.schemaDigest],"result":result])
        _ = try MobileCalendarDelivery.receipts(original,expected:expected);return original
    }
}

private struct CalendarSettingsNumbers {
    let values: [[String]:String]
    init(_ data: Data) throws {var reader=Reader(bytes:Array(data));values=try reader.read()}
    func integer(_ path: [String]) -> Int? {
        guard let raw=values[path],raw.range(of:"^-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?$",options:.regularExpression) != nil else{return nil}
        let exponentParts=raw.lowercased().split(separator:"e",maxSplits:1,omittingEmptySubsequences:false)
        var mantissa=String(exponentParts[0]);let negative=mantissa.hasPrefix("-");if negative{mantissa.removeFirst()}
        let parts=mantissa.split(separator:".",maxSplits:1,omittingEmptySubsequences:false),fraction=parts.count==2 ? String(parts[1]):""
        var digits=Array((String(parts[0])+fraction).utf8).drop(while:{$0==48}).map{$0}
        if digits.isEmpty{return 0}
        
        var exponent=0
        if exponentParts.count==2 {
            var text=String(exponentParts[1]);let minus=text.hasPrefix("-")
            if text.hasPrefix("-") || text.hasPrefix("+"){text.removeFirst()}
            text=String(text.drop(while:{$0=="0"}))
            let magnitude=text.count>6 ? 1000000:(Int(text) ?? 0);exponent=minus ? -magnitude:magnitude
        }
        let scale=exponent-fraction.utf8.count
        if scale>=0 {guard digits.count+scale<=16 else{return nil};digits.append(contentsOf:repeatElement(UInt8(48),count:scale))}
        else {let remove = -scale;guard remove<=digits.count,digits.suffix(remove).allSatisfy({$0==48}) else{return nil};digits.removeLast(remove)}
        guard !digits.isEmpty,digits.count<=16,let value=Int(String(decoding:digits,as:UTF8.self)),value<=9007199254740991 else{return nil};return negative ? -value:value
    }
    private struct Reader {
        let bytes: [UInt8]
        var index=0,values: [[String]:String]=[:]
        mutating func spaces(){while index<bytes.count,[9,10,13,32].contains(bytes[index]){index+=1}}
        mutating func take(_ byte: UInt8) -> Bool {spaces();if index<bytes.count,bytes[index]==byte{index+=1;return true};return false}
        mutating func string() throws -> String {
            spaces();let start=index;guard take(34) else{throw MobileCalendarSettingsWire.Failure.invalid}
            while index<bytes.count {
                let byte=bytes[index];index+=1
                if byte==34 {guard let text=try JSONSerialization.jsonObject(with:Data(bytes[start..<index]),options:.fragmentsAllowed) as? String else{throw MobileCalendarSettingsWire.Failure.invalid};return text}
                if byte==92 {guard index<bytes.count else{throw MobileCalendarSettingsWire.Failure.invalid};index+=1}
                else if byte<32 {throw MobileCalendarSettingsWire.Failure.invalid}
            }
            throw MobileCalendarSettingsWire.Failure.invalid
        }
        mutating func value(_ path: [String],_ depth: Int) throws {
            guard depth<64 else{throw MobileCalendarSettingsWire.Failure.invalid};spaces();guard index<bytes.count else{throw MobileCalendarSettingsWire.Failure.invalid}
            if take(123) {
                if take(125){return};var seen=Set<Data>()
                repeat {let key=try string();guard seen.insert(Data(key.utf8)).inserted,take(58) else{throw MobileCalendarSettingsWire.Failure.invalid};try value(path+[key],depth+1);if take(125){return};guard take(44) else{throw MobileCalendarSettingsWire.Failure.invalid}}while true
            }
            if take(91) {
                if take(93){return};var count=0
                repeat {try value(path+["[\(count)]"],depth+1);count+=1;if take(93){return};guard take(44) else{throw MobileCalendarSettingsWire.Failure.invalid}}while true
            }
            if bytes[index]==34 {_=try string();return}
            for text in ["true","false","null"] {
                let literal=Array(text.utf8)
                if bytes[index...].starts(with:literal){index+=literal.count;return}
            }
            let start=index
            while index<bytes.count,![9,10,13,32,44,93,125].contains(bytes[index]){index+=1}
            guard index>start else{throw MobileCalendarSettingsWire.Failure.invalid}
            let token=String(decoding:bytes[start..<index],as:UTF8.self)
            guard token.range(of:"^-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?$",options:.regularExpression) != nil else{throw MobileCalendarSettingsWire.Failure.invalid}
            values[path]=token
        }
        mutating func read() throws -> [[String]:String] {try value([],0);spaces();guard index==bytes.count else{throw MobileCalendarSettingsWire.Failure.invalid};return values}
    }
}


extension MobileCalendarSettingsWire {
    public struct Command {
        public let original:Data,payload:Data,requestDigest:String,operationID:UUID,principal:UUID,endpoint:UUID,enrollment:UUID?,namespace:UUID?,expectedRevision:Int,kind:String,settings:MobileCalendarSyncWindow?,configuration:Data?,desiredState:String?
    }
    public struct Enrollment {
        public let id:UUID,principal:UUID,endpoint:UUID,namespace:UUID?,revision:Int,state:String,configuration:Data,collectionPaused:Bool
    }
    public struct Settings {public let enrollment:Enrollment,window:MobileCalendarSyncWindow?}
    /// Parsed contract evidence only. Original authenticated transport/currentness
    /// and custody owners MUST qualify it before any consequential operation.
    public struct Terminal {
        public let command:Command,response:Data,current:Bool,applied:Bool,enrollment:Enrollment?,window:MobileCalendarSyncWindow?
    }
    private static func sourceConfiguration(_ value:Any?,collectionOnly:Bool)throws->Data{
        guard let c=value as? [String:Any],keys(c,["categories","uses","assistantIds","collectionPaused","usePaused"]),let categories=c["categories"] as? [String],categories.count<=2,Set(categories).count==categories.count,Set(categories).isSubset(of:["CalendarEvent","Task"]),let uses=c["uses"] as? [String],uses.count<=4,Set(uses).count==uses.count,Set(uses).isSubset(of:["answers","summaries","memory","proactive"]),let assistants=c["assistantIds"] as? [String],assistants.count<=32,Set(assistants).count==assistants.count,assistants.allSatisfy({MobileControlOriginal.sharedUUID($0)}),MobileControlOriginal.boolean(c["collectionPaused"]),MobileControlOriginal.boolean(c["usePaused"]) else{throw Failure.invalid}
        if collectionOnly{guard categories==["CalendarEvent"],uses.isEmpty,assistants.isEmpty,bool(c["usePaused"],true) else{throw Failure.invalid}}
        return try MobileCalendarDelivery.canonical(c)
    }
    public static func command(_ bytes:Data)throws->Command{
        let root=try object(bytes)
        guard bytes.count<=65536,keys(root,["producerPin","operation","payload"]),root["producerPin"] as? [String:String]==pin,root["operation"] as? String=="control",let payload=root["payload"] as? [String:Any],keys(payload,["schemaVersion","operationId","target","action"]),payload["schemaVersion"] as? String=="1.0.0",let op=id(payload["operationId"]),let target=payload["target"] as? [String:Any],keys(target,["principalId","endpointId","collector","enrollmentId","sourceNamespace","expectedRevision"]),let principal=id(target["principalId"]),let endpoint=id(target["endpointId"]),target["collector"] as? String=="eventKit",let revision=integer(target["expectedRevision"],min:0),let action=payload["action"] as? [String:Any],let kind=action["kind"] as? String else{throw Failure.invalid}
        let enrollment=id(target["enrollmentId"]),namespace=id(target["sourceNamespace"])
        guard target["enrollmentId"] is NSNull || enrollment != nil,target["sourceNamespace"] is NSNull || namespace != nil else{throw Failure.invalid}
        var settings:MobileCalendarSyncWindow?,configuration:Data?,state:String?
        switch kind{
        case "enroll":guard keys(action,["kind"]),enrollment==nil,namespace==nil,revision==0 else{throw Failure.invalid}
        case "bindSource":
            guard keys(action,["kind","binding"]),enrollment != nil,namespace==nil,revision>=1,let binding=action["binding"] as? [String:Any] else{throw Failure.invalid}
            guard keys(binding,["createNew"]) && bool(binding["createNew"],true) || keys(binding,["sourceNamespace"]) && id(binding["sourceNamespace"]) != nil else{throw Failure.invalid}
        case "configure":
            guard keys(action,["kind","state","configuration"]),enrollment != nil,namespace != nil,revision>=1,revision<9007199254740991,let value=action["state"] as? String,["active","disconnected"].contains(value),let c=action["configuration"] as? [String:Any],keys(c,["sourceConfiguration"],["syncWindow"]) else{throw Failure.invalid}
            state=value;configuration=try sourceConfiguration(c["sourceConfiguration"],collectionOnly:true)
            if let value=c["syncWindow"]{guard let json=value as? [String:Any],let parsed=MobileCalendarSyncWindow(json) else{throw Failure.invalid};settings=parsed}
        default:throw Failure.invalid
        }
        let canonical=try MobileCalendarDelivery.canonical(payload),original=try MobileCalendarDelivery.canonical(root)
        return .init(original:original,payload:canonical,requestDigest:hash("lifestream/calendar-control/request/1",canonical),operationID:op,principal:principal,endpoint:endpoint,enrollment:enrollment,namespace:namespace,expectedRevision:revision,kind:kind,settings:settings,configuration:configuration,desiredState:state)
    }
    public static func envelope(payload:[String:Any])throws->Command{try command(MobileCalendarDelivery.canonical(["producerPin":pin,"operation":"control","payload":payload]))}
    public static func reconcile(_ command:Command)throws->Data{try MobileCalendarDelivery.canonical(["producerPin":pin,"operation":"reconcile","payload":object(command.payload)])}
    public static func inspect(enrollment:UUID)throws->Data{try MobileCalendarDelivery.canonical(["producerPin":pin,"operation":"inspect","payload":["schemaVersion":"1.0.0","enrollmentId":enrollment.uuidString.lowercased()]])}
    private static func enrollment(_ value:Any?)throws->Enrollment{
        guard let e=value as? [String:Any],keys(e,["enrollmentId","principalId","endpointId","collector","sourceNamespace","revision","state","configuration"]),let enrollment=id(e["enrollmentId"]),let principal=id(e["principalId"]),let endpoint=id(e["endpointId"]),e["collector"] as? String=="eventKit",let revision=integer(e["revision"]),let state=e["state"] as? String,["unbound","active","disconnected"].contains(state),e["sourceNamespace"] is NSNull || id(e["sourceNamespace"]) != nil else{throw Failure.invalid}
        let config=try sourceConfiguration(e["configuration"],collectionOnly:false),c=try object(config)
        return .init(id:enrollment,principal:principal,endpoint:endpoint,namespace:id(e["sourceNamespace"]),revision:revision,state:state,configuration:config,collectionPaused:(c["collectionPaused"] as! NSNumber).boolValue)
    }
    private static func window(_ value:Any?)throws->MobileCalendarSyncWindow?{if value is NSNull{return nil};guard let json=value as? [String:Any],let window=MobileCalendarSyncWindow(json) else{throw Failure.invalid};return window}
    private static func response(_ bytes:Data)throws->[String:Any]{let root=try object(bytes);guard keys(root,["schemaVersion","producerPin","result"]),root["schemaVersion"] as? String=="1.0.0",root["producerPin"] as? [String:String]==pin,let result=root["result"] as? [String:Any] else{throw Failure.invalid};return result}
    public static func inspected(_ bytes:Data,principal:UUID,endpoint:UUID,enrollment expected:UUID)throws->Settings{
        let result=try response(bytes);guard keys(result,["kind","enrollment","syncWindow"]),result["kind"] as? String=="settings" else{throw Failure.invalid}
        let e=try enrollment(result["enrollment"]);guard e.principal==principal,e.endpoint==endpoint,e.id==expected else{throw Failure.invalid};return .init(enrollment:e,window:try window(result["syncWindow"]))
    }
    public static func terminal(_ bytes:Data,original:Command)throws->Terminal{
        let result=try response(bytes)
        guard result["kind"] as? String=="terminal" else{throw Failure.held}
        guard keys(result,["kind","originalRequest","requestDigest","outcome","current","binding"]),let raw=result["originalRequest"] as? [String:Any],try MobileCalendarDelivery.canonical(raw)==original.payload,result["requestDigest"] as? String==original.requestDigest,MobileControlOriginal.boolean(result["current"]),let binding=result["binding"] as? [String:Any],keys(binding,["family","reservationDigest","terminalDigest"],["preparedDigest"]),binding["family"] as? String=="calendarControl",binding["reservationDigest"] as? String==hash("lifestream/calendar-control/reservation/1",original.payload),digest(binding["terminalDigest"]),let outcome=result["outcome"] as? [String:Any],let status=outcome["status"] as? String else{throw Failure.invalid}
        let current=(result["current"] as! NSNumber).boolValue
        if status=="rejected"{guard keys(outcome,["status","code"]),["scope","settingsChanged","invalid","unavailable"].contains(outcome["code"] as? String ?? ""),binding["preparedDigest"]==nil else{throw Failure.invalid};return .init(command:original,response:bytes,current:current,applied:false,enrollment:nil,window:nil)}
        guard status=="applied",keys(outcome,["status","receipt","enrollment","syncWindow"]),digest(binding["preparedDigest"]),let receipt=outcome["receipt"] as? [String:Any],keys(receipt,["operationId","committedAt"]),id(receipt["operationId"])==original.operationID,let committed=receipt["committedAt"] as? String,committed.hasSuffix("Z") else{throw Failure.invalid}
        let formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds];if formatter.date(from:committed)==nil{formatter.formatOptions=[.withInternetDateTime];guard formatter.date(from:committed) != nil else{throw Failure.invalid}}
        let e=try enrollment(outcome["enrollment"]),w=try window(outcome["syncWindow"])
        guard e.principal==original.principal,e.endpoint==original.endpoint,original.kind=="enroll" || e.id==original.enrollment else{throw Failure.invalid}
        if original.kind=="configure"{guard e.namespace==original.namespace,e.revision==original.expectedRevision+1,e.state==original.desiredState,e.configuration==original.configuration,original.settings==nil || w==original.settings else{throw Failure.invalid}}
        return .init(command:original,response:bytes,current:current,applied:true,enrollment:e,window:w)
    }
}

extension MobileCalendarSettingsWire {
    static func selection(_ value:Any?)throws->Selection{
        guard let s=value as? [String:Any],keys(s,["principalId","endpointId","enrollmentId","sourceNamespace","configurationRevision","collector","upstreamIdentityScope","calendars"]),let principal=id(s["principalId"]),let endpoint=id(s["endpointId"]),let enrollment=id(s["enrollmentId"]),let namespace=id(s["sourceNamespace"]),let revision=integer(s["configurationRevision"]),s["collector"] as? String=="eventKit",s["upstreamIdentityScope"] as? String=="providerLocal",let rows=s["calendars"] as? [[String:Any]] else{throw Failure.invalid}
        var calendars:[Selection.CalendarIdentity]=[]
        for row in rows{guard keys(row,["containerId","accountId"]),let container=row["containerId"] as? String,row["accountId"] is NSNull || row["accountId"] is String else{throw Failure.invalid};calendars.append(.init(containerID:container,accountID:row["accountId"] as? String))}
        guard let selected=Selection(principal:principal,endpoint:endpoint,enrollment:enrollment,namespace:namespace,revision:revision,calendars:calendars) else{throw Failure.invalid};return selected
    }
    public static func phoneSelection(run:Run,plan:MobileEventKitAcquisition.Plan)throws->Data{
        guard plan.category=="CalendarEvent",plan.selectedContainerIDs.count==run.selection.calendars.count,plan.selectedContainerIDs.allSatisfy({wanted in run.selection.calendars.contains{Data($0.containerID.utf8)==Data(wanted.utf8)}}) else{throw Failure.invalid}
        return try MobileCalendarDelivery.canonical(["identity":object(run.selection.canonical),"capturedSDKDefaultTimeZone":plan.capturedSDKDefaultTimeZone.identifier,"mappingVersion":plan.mappingVersion])
    }
}
