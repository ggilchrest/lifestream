import Foundation

/// Untrusted caller-declared signal data. No Shortcut installation, OS
/// execution, current-world, human, audience or action authority is implied.
enum MobileContextSignal {
    enum Failure:Error {case invalid}
    enum Declaration {case reported(String),unknown(String)}
    enum Signal {case focus(sourceId:String?,state:String),connection(kind:String,sourceId:String?,state:String),availability(String),unknownNative(type:String,value:String?),unavailable(String)}
    struct Source {let collector:String,namespace:UUID,upstreamId:String?,originalApp:String?,originalDevice:String?}
    struct Value {let source:Source,observedAt:String?,collectedAt:String,declaration:Declaration,signal:Signal,data:Data;fileprivate let signalData:[String:Any]}
    private static func dict(_ value:Any?)->[String:Any]? {value as? [String:Any]}
    private static func keys(_ d:[String:Any],_ expected:Set<String>)->Bool {Set(d.keys)==expected}
    private static func text(_ value:Any?,max:Int)->Bool {guard let s=value as? String else{return false};return !s.isEmpty && s.unicodeScalars.count<=max}
    private static func nullable(_ value:Any?,max:Int)->Bool {value is NSNull || text(value,max:max)}
    static func decode(_ data:Data)throws->Value {
        guard data.count<=65536,let root=try JSONSerialization.jsonObject(with:data) as? [String:Any],keys(root,["schemaVersion","source","observedAt","collectedAt","declaration","signal"]),root["schemaVersion"] as? String == "1.0.0",let s=dict(root["source"]),keys(s,["collector","namespace","upstreamId","originalApp","originalDevice"]),let collector=s["collector"] as? String,["iosDeclaredIntent","androidDeclaredIntent"].contains(collector),let ns=s["namespace"] as? String,ns==ns.lowercased(),let namespace=UUID(uuidString:ns),namespace.uuidString.lowercased()==ns,nullable(s["upstreamId"],max:1024),nullable(s["originalApp"],max:1024),nullable(s["originalDevice"],max:1024),let collected=root["collectedAt"] as? String,MobileLocationObservation.Instant.parse(collected) != nil,let d=dict(root["declaration"]),let dk=d["kind"] as? String,let p=dict(root["signal"]),let kind=p["kind"] as? String else{throw Failure.invalid}
        let declaration:Declaration
        switch dk {
        case "reported":guard keys(d,["kind","origin"]),let origin=d["origin"] as? String,["userConfiguredAutomation","explicitUserInput"].contains(origin) else{throw Failure.invalid};declaration = .reported(origin)
        case "unknown":guard keys(d,["kind","reason"]),let reason=d["reason"] as? String,["notProvided","notObservable","unsupported"].contains(reason) else{throw Failure.invalid};declaration = .unknown(reason)
        default:throw Failure.invalid
        }
        let observed:String?;if root["observedAt"] is NSNull {observed=nil} else {guard let s=root["observedAt"] as? String,MobileLocationObservation.Instant.parse(s) != nil else{throw Failure.invalid};observed=s}
        let signal:Signal
        switch kind {
        case "focusTransition":guard observed != nil,keys(p,["kind","sourceFocusId","state"]),nullable(p["sourceFocusId"],max:1024),let state=p["state"] as? String,["enabled","disabled","unknown"].contains(state) else{throw Failure.invalid};signal = .focus(sourceId:p["sourceFocusId"] as? String,state:state)
        case "connectionTransition":guard observed != nil,keys(p,["kind","connectionKind","sourceDeviceId","state"]),let connection=p["connectionKind"] as? String,["car","bluetooth"].contains(connection),nullable(p["sourceDeviceId"],max:1024),let state=p["state"] as? String,["connected","disconnected","unknown"].contains(state) else{throw Failure.invalid};signal = .connection(kind:connection,sourceId:p["sourceDeviceId"] as? String,state:state)
        case "availabilityDeclaration":guard observed != nil,keys(p,["kind","state"]),let state=p["state"] as? String,["available","busy","doNotDisturb","unavailable","unknown"].contains(state) else{throw Failure.invalid};signal = .availability(state)
        case "unknownNative":guard observed != nil,keys(p,["kind","nativeType","rawValue"]),text(p["nativeType"],max:128),let nativeType=p["nativeType"] as? String,nullable(p["rawValue"],max:1024) else{throw Failure.invalid};signal = .unknownNative(type:nativeType,value:p["rawValue"] as? String)
        case "unavailable":guard keys(p,["kind","reason"]),let reason=p["reason"] as? String,["notObservable","unsupported","temporarilyUnavailable","unknown"].contains(reason) else{throw Failure.invalid};signal = .unavailable(reason)
        default:throw Failure.invalid
        }
        let source=Source(collector:collector,namespace:namespace,upstreamId:s["upstreamId"] as? String,originalApp:s["originalApp"] as? String,originalDevice:s["originalDevice"] as? String)
        return .init(source:source,observedAt:observed,collectedAt:collected,declaration:declaration,signal:signal,data:try JSONSerialization.data(withJSONObject:root,options:[.sortedKeys,.withoutEscapingSlashes]),signalData:p)
    }
    static func view(_ value:Value)->[String:Any] {["qualification":"declaredSignalOnly","signal":value.signalData]}
    static func assess(_ value:Value,referenceAt:String,maximumAgeMs:Int64)->[String:Any]? {
        guard maximumAgeMs>=0,maximumAgeMs<=9007199254740991,let reference=MobileLocationObservation.Instant.parse(referenceAt),let collected=MobileLocationObservation.Instant.parse(value.collectedAt) else{return nil}
        func unknown(_ reason:String)->[String:Any] {["state":"unknown","reason":reason,"ageNanoseconds":NSNull(),"maximumAgeMs":maximumAgeMs,"qualification":"observationAgeOnly"]}
        if case .unavailable = value.signal {return unknown("unavailable")};guard let text=value.observedAt,let observed=MobileLocationObservation.Instant.parse(text) else{return unknown("unavailable")}
        if observed>reference{return unknown("futureObservation")};if collected>reference{return unknown("futureCollection")};if observed>collected{return unknown("observationAfterCollection")}
        var seconds=reference.seconds-observed.seconds,nanos=reference.nanos-observed.nanos;if nanos<0 {seconds -= 1;nanos += 1_000_000_000};let age=seconds==0 ? String(nanos) : String(seconds)+String(format:"%09lld",nanos),boundSeconds=maximumAgeMs/1000,boundNanos=(maximumAgeMs%1000)*1_000_000
        return ["state":seconds<boundSeconds || (seconds==boundSeconds && nanos<=boundNanos) ? "fresh":"stale","ageNanoseconds":age,"maximumAgeMs":maximumAgeMs,"qualification":"observationAgeOnly"]
    }
}
