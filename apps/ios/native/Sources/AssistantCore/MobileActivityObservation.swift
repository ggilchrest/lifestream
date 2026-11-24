import Foundation
import CoreFoundation

/// Inert source reports only. No SDK capture, collection permission, presence,
/// identity, audience or policy authority is established by these values.
enum MobileActivityObservation {
    enum Failure: Error { case invalid }
    enum Confidence { case categorical(String), unrecognized(Int32), unknown(String) }
    struct MotionFlags { let stationary:Bool, walking:Bool, running:Bool, cycling:Bool, automotive:Bool, unknown:Bool }
    struct Candidate { let nativeType:Int32, confidencePercent:Int }
    enum Observation { case coreMotion(MotionFlags,Confidence), android([Candidate]), unavailable(String) }
    struct Source { let collector:String, namespace:UUID, upstreamId:String?, originalApp:String?, originalDevice:String? }
    struct Value { let source:Source, observedAt:String?, collectedAt:String, observation:Observation, data:Data }
    private static let reasons:Set<String>=["notProvided","notObservable","unsupported"]
    private static func dict(_ v:Any?)->[String:Any]? {v as? [String:Any]}
    private static func keys(_ d:[String:Any],_ expected:Set<String>)->Bool {Set(d.keys)==expected}
    private static func text(_ v:Any?,max:Int)->Bool {guard let s=v as? String else{return false};return !s.isEmpty && s.unicodeScalars.count<=max}
    private static func optionalText(_ v:Any?,max:Int)->Bool {v is NSNull || text(v,max:max)}
    private static func boolean(_ v:Any?)->Bool? {guard let n=v as? NSNumber,CFGetTypeID(n)==CFBooleanGetTypeID() else{return nil};return n.boolValue}
    private static func integer(_ v:Any?,min:Double,max:Double)->Int? {guard let n=v as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue.rounded()==n.doubleValue,n.doubleValue>=min,n.doubleValue<=max else{return nil};return n.intValue}
    static func decode(_ data:Data)throws->Value {
        guard data.count<=65536,let root=try JSONSerialization.jsonObject(with:data) as? [String:Any],keys(root,["schemaVersion","source","observedAt","collectedAt","method","observation"]),root["schemaVersion"] as? String == "1.0.0",let s=dict(root["source"]),keys(s,["collector","namespace","upstreamId","originalApp","originalDevice"]),let collector=s["collector"] as? String,["coreMotion","androidActivityRecognition"].contains(collector),let namespace=s["namespace"] as? String,namespace==namespace.lowercased(),let uid=UUID(uuidString:namespace),uid.uuidString.lowercased()==namespace,optionalText(s["upstreamId"],max:1024),optionalText(s["originalApp"],max:1024),optionalText(s["originalDevice"],max:1024),let collected=root["collectedAt"] as? String,MobileLocationObservation.Instant.parse(collected) != nil,let method=dict(root["method"]),let mk=method["kind"] as? String,((mk=="unknown" && keys(method,["kind"])) || (mk=="reported" && keys(method,["kind","value"]) && text(method["value"],max:128))),let o=dict(root["observation"]),let kind=o["kind"] as? String else {throw Failure.invalid}
        let observed:String?;if root["observedAt"] is NSNull {observed=nil} else {guard let v=root["observedAt"] as? String,MobileLocationObservation.Instant.parse(v) != nil else{throw Failure.invalid};observed=v}
        let observation:Observation
        switch kind {
        case "unavailable":guard keys(o,["kind","reason"]),let why=o["reason"] as? String,["notObservable","unsupported","temporarilyUnavailable","invalidMeasurement","unknown"].contains(why) else{throw Failure.invalid};observation = .unavailable(why)
        case "coreMotion":
            guard observed != nil,collector==kind,keys(o,["kind","flags","confidence"]),let f=dict(o["flags"]),keys(f,["stationary","walking","running","cycling","automotive","unknown"]),let stationary=boolean(f["stationary"]),let walking=boolean(f["walking"]),let running=boolean(f["running"]),let cycling=boolean(f["cycling"]),let automotive=boolean(f["automotive"]),let unknown=boolean(f["unknown"]),let c=dict(o["confidence"]),let ck=c["kind"] as? String else{throw Failure.invalid}
            let confidence:Confidence
            switch ck {
            case "categorical":guard keys(c,["kind","value"]),let v=c["value"] as? String,["low","medium","high"].contains(v) else{throw Failure.invalid};confidence = .categorical(v)
            case "unrecognized":guard keys(c,["kind","nativeValue"]),let n=integer(c["nativeValue"],min:-2147483648,max:2147483647) else{throw Failure.invalid};confidence = .unrecognized(Int32(n))
            case "unknown":guard keys(c,["kind","reason"]),let r=c["reason"] as? String,reasons.contains(r) else{throw Failure.invalid};confidence = .unknown(r)
            default:throw Failure.invalid
            }
            observation = .coreMotion(.init(stationary:stationary,walking:walking,running:running,cycling:cycling,automotive:automotive,unknown:unknown),confidence)
        case "androidActivityRecognition":
            guard observed != nil,collector==kind,keys(o,["kind","activities"]),let a=o["activities"] as? [[String:Any]],(1...32).contains(a.count) else{throw Failure.invalid};var values=[Candidate](),seen=Set<Int32>()
            for candidate in a {guard keys(candidate,["nativeType","confidencePercent"]),let type=integer(candidate["nativeType"],min:-2147483648,max:2147483647),let pct=integer(candidate["confidencePercent"],min:0,max:100),seen.insert(Int32(type)).inserted else{throw Failure.invalid};values.append(.init(nativeType:Int32(type),confidencePercent:pct))};observation = .android(values)
        default:throw Failure.invalid
        }
        let source=Source(collector:collector,namespace:uid,upstreamId:s["upstreamId"] as? String,originalApp:s["originalApp"] as? String,originalDevice:s["originalDevice"] as? String)
        return .init(source:source,observedAt:observed,collectedAt:collected,observation:observation,data:try JSONSerialization.data(withJSONObject:root,options:[.sortedKeys,.withoutEscapingSlashes]))
    }
    /// A view of all source classifications, not a selected or accepted activity.
    static func meaning(_ v:Value)->[String:Any] {
        var categories=Set<String>(),unrecognized=[Int32]()
        switch v.observation {
        case .unavailable(let reason):return ["kind":"unavailable","reason":reason]
        case .coreMotion(let f,_):for (name,enabled) in [("stationary",f.stationary),("walking",f.walking),("running",f.running),("cycling",f.cycling),("inVehicle",f.automotive),("unknown",f.unknown)] where enabled {categories.insert(name)}
        case .android(let values):let labels:[Int32:String]=[0:"inVehicle",1:"cycling",2:"onFoot",3:"stationary",4:"unknown",5:"tilting",7:"walking",8:"running"];for item in values {if let label=labels[item.nativeType] {categories.insert(label)} else {unrecognized.append(item.nativeType)}}
        }
        return ["kind":"classifications","categories":categories.sorted(),"unrecognizedNativeTypes":unrecognized.sorted()]
    }
    static func assess(_ v:Value,referenceAt:String,maximumAgeMs:Int64)->[String:Any]? {
        guard maximumAgeMs>=0,maximumAgeMs<=9007199254740991,let reference=MobileLocationObservation.Instant.parse(referenceAt),let collected=MobileLocationObservation.Instant.parse(v.collectedAt) else{return nil}
        func unknown(_ reason:String)->[String:Any] {["state":"unknown","reason":reason,"ageNanoseconds":NSNull(),"maximumAgeMs":maximumAgeMs,"qualification":"observationAgeOnly"]}
        if case .unavailable = v.observation {return unknown("unavailable")};guard let text=v.observedAt,let observed=MobileLocationObservation.Instant.parse(text) else{return unknown("unavailable")}
        if observed>reference{return unknown("futureObservation")};if collected>reference{return unknown("futureCollection")};if observed>collected{return unknown("observationAfterCollection")}
        var seconds=reference.seconds-observed.seconds,nanos=reference.nanos-observed.nanos;if nanos<0 {seconds -= 1;nanos += 1_000_000_000};let age=seconds==0 ? String(nanos) : String(seconds)+String(format:"%09lld",nanos),boundSeconds=maximumAgeMs/1000,boundNanos=(maximumAgeMs%1000)*1_000_000
        return ["state":seconds<boundSeconds || (seconds==boundSeconds && nanos<=boundNanos) ? "fresh":"stale","ageNanoseconds":age,"maximumAgeMs":maximumAgeMs,"qualification":"observationAgeOnly"]
    }
}
