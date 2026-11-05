import Foundation
import CoreFoundation

/// Inert raw phone-source observation. This is neither a permission, source
/// enrollment nor a conclusion about presence, identity or audience.
enum MobileLocationObservation {
    enum Failure: Error { case invalid }
    enum Kind: String { case position, regionTransition, unavailable }
    enum Confidence { case reported(Double), unspecified }
    enum Accuracy { case reported(meters:Double,confidence:Confidence), unknown(reason:String) }
    enum Observation {
        case position(latitude:Double,longitude:Double,accuracy:Accuracy)
        case regionTransition(sourceRegionId:String,transition:String)
        case unavailable(reason:String)
    }
    struct Source { let collector:String, namespace:UUID, upstreamId:String?, originalApp:String?, originalDevice:String? }
    struct Instant: Comparable {
        let seconds: Int64, nanos: Int64
        static func < (a:Self,b:Self)->Bool {a.seconds == b.seconds ? a.nanos < b.nanos : a.seconds < b.seconds}
        static func parse(_ s:String)->Self? {
            let a=Array(s.utf8);guard a.count>=20,a.count<=30,a[4]==45,a[7]==45,a[10]==84,a[13]==58,a[16]==58,a.last==90 else{return nil}
            func number(_ range:Range<Int>)->Int? {var n=0;for i in range {guard (48...57).contains(a[i]) else{return nil};n=n*10+Int(a[i]-48)};return n}
            guard let y=number(0..<4),let m=number(5..<7),let d=number(8..<10),let h=number(11..<13),let minute=number(14..<16),let sec=number(17..<19),(1...9999).contains(y),(1...12).contains(m),(0...23).contains(h),(0...59).contains(minute),(0...59).contains(sec) else{return nil}
            let leap=y%4==0 && (y%100 != 0 || y%400==0),months=[31,leap ? 29:28,31,30,31,30,31,31,30,31,30,31];guard d>=1,d<=months[m-1] else{return nil}
            var ns:Int64=0;if a.count>20 {guard a[19]==46 else{return nil};let count=a.count-21;guard (1...9).contains(count),let fraction=number(20..<(a.count-1)) else{return nil};ns=Int64(fraction);for _ in count..<9 {ns *= 10}} else if a[19] != 90{return nil}
            let py=y-1,days=py*365+py/4-py/100+py/400+months.prefix(m-1).reduce(0,+)+(d-1)-719162
            return .init(seconds:Int64(days)*86400+Int64(h*3600+minute*60+sec),nanos:ns)
        }
    }
    struct Value {
        let kind:Kind, source:Source, observation:Observation, observedAt:String?, collectedAt:String
        /// Validated closed producer JSON; original timestamp strings retained.
        let data:Data
    }
    private static let reasons:Set<String>=["notProvided","notObservable","unsupported"]
    private static func dict(_ value:Any?)->[String:Any]? {value as? [String:Any]}
    private static func keys(_ d:[String:Any],_ required:Set<String>,_ optional:Set<String>=[])->Bool {required.isSubset(of:Set(d.keys)) && Set(d.keys).isSubset(of:required.union(optional))}
    private static func text(_ value:Any?,max:Int)->Bool {guard let s=value as? String else{return false};return !s.isEmpty && s.unicodeScalars.count<=max}
    private static func nullableText(_ value:Any?,max:Int)->Bool {value is NSNull || text(value,max:max)}
    private static func number(_ value:Any?)->Double? {guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite else{return nil};return n.doubleValue}
    private static func bool(_ value:Any?)->Bool {guard let n=value as? NSNumber else{return false};return CFGetTypeID(n)==CFBooleanGetTypeID()}
    private static func unknown(_ d:[String:Any])->Bool {keys(d,["kind","reason"]) && d["kind"] as? String == "unknown" && reasons.contains(d["reason"] as? String ?? "")}
    private static func flag(_ value:Any?)->Bool {guard let d=dict(value) else{return false};if d["kind"] as? String == "reported" {return keys(d,["kind","value"]) && bool(d["value"])};return unknown(d)}
    private static func confidence(_ value:Any?)->Bool {guard let d=dict(value),let k=d["kind"] as? String else{return false};if k=="unspecified" {return keys(d,["kind"])};if k=="reported",keys(d,["kind","probability"]),let p=number(d["probability"]) {return (0...1).contains(p)};return false}
    private static func clock(_ value:Any?)->Bool {
        guard let d=dict(value),let k=d["kind"] as? String else{return false};if k=="unknown" {return unknown(d)}
        guard k=="reported",keys(d,["kind","elapsedRealtimeNanoseconds","uncertainty","clockScope"]),let counter=d["elapsedRealtimeNanoseconds"] as? String,counter.range(of:"^(0|[1-9][0-9]{0,18})$",options:.regularExpression) != nil,let n=UInt64(counter),n<=UInt64(Int64.max),nullableText(d["clockScope"],max:1024),let u=dict(d["uncertainty"]),let kind=u["kind"] as? String else{return false}
        if kind=="unknown" {return unknown(u)};guard kind=="reported",keys(u,["kind","nanoseconds","confidence"]),let x=number(u["nanoseconds"]),x>=0 else{return false};return confidence(u["confidence"])
    }
    static func decode(_ data:Data)throws->Value {
        guard data.count<=65536,let root=try JSONSerialization.jsonObject(with:data) as? [String:Any],keys(root,["schemaVersion","source","observedAt","collectedAt","provenance","observation"]),root["schemaVersion"] as? String == "1.0.0",let source=dict(root["source"]),keys(source,["collector","namespace","upstreamId","originalApp","originalDevice"]),["coreLocation","androidLocation"].contains(source["collector"] as? String ?? ""),let namespace=source["namespace"] as? String,namespace==namespace.lowercased(),let uid=UUID(uuidString:namespace),uid.uuidString.lowercased()==namespace,nullableText(source["upstreamId"],max:1024),nullableText(source["originalApp"],max:1024),nullableText(source["originalDevice"],max:1024),let collected=root["collectedAt"] as? String,Instant.parse(collected) != nil,let p=dict(root["provenance"]),keys(p,["method","simulatedBySoftware","accessoryProduced","mockProvider"],["monotonicClock"]),let method=dict(p["method"]),let mk=method["kind"] as? String,((mk=="unknown" && keys(method,["kind"])) || (mk=="reported" && keys(method,["kind","value"]) && text(method["value"],max:128))),flag(p["simulatedBySoftware"]),flag(p["accessoryProduced"]),flag(p["mockProvider"]),p["monotonicClock"] == nil || clock(p["monotonicClock"]),let o=dict(root["observation"]),let kind=Kind(rawValue:o["kind"] as? String ?? "") else{throw Failure.invalid}
        let observed:String?;if root["observedAt"] is NSNull {observed=nil} else {guard let s=root["observedAt"] as? String,Instant.parse(s) != nil else{throw Failure.invalid};observed=s}
        let observation:Observation
        switch kind {
        case .unavailable:guard keys(o,["kind","reason"]),let reason=o["reason"] as? String,["notObservable","unsupported","temporarilyUnavailable","invalidMeasurement","unknown"].contains(reason) else{throw Failure.invalid};observation = .unavailable(reason:reason)
        case .regionTransition:guard observed != nil,keys(o,["kind","sourceRegionId","transition"]),text(o["sourceRegionId"],max:1024),let region=o["sourceRegionId"] as? String,let transition=o["transition"] as? String,["entered","exited","unknown"].contains(transition) else{throw Failure.invalid};observation = .regionTransition(sourceRegionId:region,transition:transition)
        case .position:
            guard observed != nil,keys(o,["kind","coordinates","horizontalAccuracy"]),let c=dict(o["coordinates"]),keys(c,["system","latitude","longitude"]),c["system"] as? String == "WGS84",let lat=number(c["latitude"]),(-90...90).contains(lat),let lon=number(c["longitude"]),(-180...180).contains(lon),let acc=dict(o["horizontalAccuracy"]),let k=acc["kind"] as? String else{throw Failure.invalid}
            let accuracy:Accuracy
            if k=="unknown" {guard unknown(acc),let reason=acc["reason"] as? String else{throw Failure.invalid};accuracy = .unknown(reason:reason)} else {guard k=="reported",keys(acc,["kind","meters","confidence"]),let metres=number(acc["meters"]),metres>=0,confidence(acc["confidence"]),let c=dict(acc["confidence"]) else{throw Failure.invalid};let reported:Confidence = c["kind"] as? String == "reported" ? .reported(number(c["probability"])!) : .unspecified;accuracy = .reported(meters:metres,confidence:reported)}
            observation = .position(latitude:lat,longitude:lon,accuracy:accuracy)
        }
        let identity=Source(collector:source["collector"] as! String,namespace:uid,upstreamId:source["upstreamId"] as? String,originalApp:source["originalApp"] as? String,originalDevice:source["originalDevice"] as? String)
        return Value(kind:kind,source:identity,observation:observation,observedAt:observed,collectedAt:collected,data:try JSONSerialization.data(withJSONObject:root,options:[.sortedKeys,.withoutEscapingSlashes]))
    }
    /// Age qualification only; caller supplies reference and bound. No TTL or
    /// source/presence/currentness authority follows from this calculation.
    static func assess(_ value:Value,referenceAt:String,maximumAgeMs:Int64)->[String:Any]? {
        guard maximumAgeMs>=0,maximumAgeMs<=9007199254740991,let reference=Instant.parse(referenceAt),let collected=Instant.parse(value.collectedAt) else{return nil}
        func unknown(_ why:String)->[String:Any] {["state":"unknown","reason":why,"ageNanoseconds":NSNull(),"maximumAgeMs":maximumAgeMs,"qualification":"observationAgeOnly"]}
        guard value.kind != .unavailable,let text=value.observedAt,let observed=Instant.parse(text) else{return unknown("unavailable")}
        if observed>reference{return unknown("futureObservation")};if collected>reference{return unknown("futureCollection")};if observed>collected{return unknown("observationAfterCollection")}
        var seconds=reference.seconds-observed.seconds,nanos=reference.nanos-observed.nanos;if nanos<0 {seconds -= 1;nanos += 1_000_000_000}
        let age=seconds==0 ? String(nanos) : String(seconds)+String(format:"%09lld",nanos),boundSeconds=maximumAgeMs/1000,boundNanos=(maximumAgeMs%1000)*1_000_000
        let fresh=seconds<boundSeconds || (seconds==boundSeconds && nanos<=boundNanos)
        return ["state":fresh ? "fresh":"stale","ageNanoseconds":age,"maximumAgeMs":maximumAgeMs,"qualification":"observationAgeOnly"]
    }
}
