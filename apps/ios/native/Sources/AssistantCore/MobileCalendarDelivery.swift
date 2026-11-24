import Foundation
import CoreFoundation
import CryptoKit

/// Calendar delivery canonicalization and receipt checks; no network, SDK or authority.
public enum MobileCalendarDelivery {
    public static let schemaId="https://lifestream.dev/contracts/mobile-context-calendar-delivery/1.0.0"
    public static let schemaDigest="91dd3ae326706285babde6b31649f3f4d9687826df05fc9a524941301e5a212c"
    public enum Failure:Error {case invalid,oversized}
    public struct Item {
        public let data:Data,digest:String,eventId:UUID,enrollmentId:UUID,namespace:UUID,collector:String,category:String,operation:String,mappingVersion:String,policyRevision:Int
    }
    public struct ResultSet {public let accepted:Set<UUID>,rejected:[UUID:String],held:Set<UUID>}
    /// An explicit observation window, not an OS incremental-deletion cursor.
    public struct CheckpointScope {
        public enum Coverage:String {case complete,partial,unknown}
        public let collector:String,namespace:UUID,mappingVersion:String,coverage:Coverage,start:String,end:String
        public init(collector:String,namespace:UUID,mappingVersion:String,coverage:Coverage,start:String,end:String)throws {
            let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
            func parse(_ v:String)->Date? {guard v.hasSuffix("Z"),v.utf8.count<=64 else{return nil};if let x=f.date(from:v){return x};f.formatOptions=[.withInternetDateTime];defer{f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]};return f.date(from:v)}
            guard ["eventKit","androidCalendar","googleTasks"].contains(collector),!mappingVersion.isEmpty,mappingVersion.utf8.count<=64,!mappingVersion.unicodeScalars.contains(where:{$0.value<32}),let a=parse(start),let b=parse(end),a<b else{throw Failure.invalid}
            self.collector=collector;self.namespace=namespace;self.mappingVersion=mappingVersion;self.coverage=coverage;self.start=start;self.end=end
        }
        func key()throws->String {
            let d=try MobileCalendarDelivery.canonical(["collector":collector,"namespace":namespace.uuidString.lowercased(),"mappingVersion":mappingVersion,"coverage":coverage.rawValue,"start":start,"end":end]);return d.map{String(format:"%02x",$0)}.joined()
        }
    }

    private static func str(_ s:String)->String {
        var out="\"";for c in s.unicodeScalars {switch c.value {
        case 34:out += "\\\"";case 92:out += "\\\\";case 8:out += "\\b";case 9:out += "\\t";case 10:out += "\\n";case 12:out += "\\f";case 13:out += "\\r"
        case 0...31:out += String(format:"\\u%04x",c.value)
        default:out.unicodeScalars.append(c)
        }};return out+"\""
    }
    private static func render(_ v:Any,depth:Int)throws->String {
        guard depth<64 else{throw Failure.invalid};if v is NSNull{return "null"}
        if let n=v as? NSNumber {
            if CFGetTypeID(n)==CFBooleanGetTypeID(){return n.boolValue ? "true":"false"}
            let x=n.doubleValue;guard x.isFinite,x.rounded()==x,abs(x)<=9007199254740991 else{throw Failure.invalid};return String(Int64(x))
        }
        if let s=v as? String {return str(s)}
        if let a=v as? [Any] {return "[" + (try a.map{try render($0,depth:depth+1)}).joined(separator:",") + "]"}
        if let o=v as? [String:Any] {
            let keys=o.keys.sorted{Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8))}
            guard keys.allSatisfy({$0.range(of:"^[A-Za-z][A-Za-z0-9]*$",options:.regularExpression) != nil}) else{throw Failure.invalid}
            return "{" + (try keys.map{str($0)+":"+(try render(o[$0]!,depth:depth+1))}).joined(separator:",") + "}"
        };throw Failure.invalid
    }
    public static func canonical(_ value:Any)throws->Data {let bytes=Data(try render(value,depth:0).utf8);guard bytes.count<=262144 else{throw Failure.oversized};return bytes}
    private static func uuid(_ value:Any?)->UUID? {MobileControlOriginal.uuid(value)}
    private static func object(_ data:Data)throws->[String:Any] {guard data.count<=262144,let v=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else{throw Failure.invalid};return v}
    /// Performs local delivery-binding checks; the producer remains the owner of
    /// complete Calendar semantic validation. The canonical bytes are retained.
    public static func item(_ data:Data)throws->Item {
        let root=try object(data);guard Set(root.keys)==Set(["change","locator"]),let c=root["change"] as? [String:Any],let l=root["locator"] as? [String:Any],c["schemaVersion"] as? String=="1.0.0",let id=uuid(c["eventId"]),let enrollment=uuid(c["enrollmentId"]),let rev=MobileControlOriginal.number(c["expectedPolicyRevision"],min:1,max:9007199254740991),let source=c["source"] as? [String:Any],let ns=uuid(source["namespace"]),let collector=source["collector"] as? String,["eventKit","androidCalendar","googleTasks"].contains(collector),let mapping=c["mappingVersion"] as? String,!mapping.isEmpty,mapping.utf8.count<=64,let category=c["recordType"] as? String,["CalendarEvent","Task"].contains(category),let op=c["operation"] as? String,["upsert","delete"].contains(op),let locator=l["kind"] as? String else{throw Failure.invalid}
        guard (category=="Task" ? source["containerKind"] as? String=="taskList" : source["containerKind"] as? String=="calendar"),collector != "googleTasks" || category=="Task",collector != "androidCalendar" || category=="CalendarEvent",let upstream=source["upstreamId"] as? String,!upstream.isEmpty,upstream.unicodeScalars.count<=1024,let container=source["containerId"] as? String,!container.isEmpty,container.unicodeScalars.count<=1024 else{throw Failure.invalid}
        switch locator {case "sourceItem":guard Set(l.keys)==["kind"] else{throw Failure.invalid};case "occurrence":guard category=="CalendarEvent",Set(l.keys)==Set(["kind","originalStart"]),l["originalStart"] is [String:Any] else{throw Failure.invalid};default:throw Failure.invalid}
        if op=="delete" {guard c["deletionEvidence"] as? String=="explicitProviderTombstone",c["record"]==nil else{throw Failure.invalid}}
        else {guard let record=c["record"] as? [String:Any],c["deletionEvidence"]==nil else{throw Failure.invalid};if category=="CalendarEvent" {guard let occurrence=record["occurrence"] as? [String:Any],let state=occurrence["state"] as? String,let original=occurrence["originalStart"] else{throw Failure.invalid};if !(original is NSNull) {guard locator=="occurrence",let actual=l["originalStart"],try canonical(original)==canonical(actual) else{throw Failure.invalid}} else {guard locator=="sourceItem",state != "occurrence",state != "detached" else{throw Failure.invalid}}}}
        let canonicalBytes=try canonical(root),digest=SHA256.hash(data:Data("lifestream/mobile-context-calendar-delivery-item/1\n".utf8)+canonicalBytes).map{String(format:"%02x",$0)}.joined()
        return Item(data:canonicalBytes,digest:digest,eventId:id,enrollmentId:enrollment,namespace:ns,collector:collector,category:category,operation:op,mappingVersion:mapping,policyRevision:rev)
    }
    public static func batch(_ items:[Item])throws->Data {
        guard !items.isEmpty,items.count<=64,Set(items.map(\.eventId)).count==items.count else{throw Failure.invalid}
        let objects=try items.map{try object($0.data)};let envelope:[String:Any]=["producerPin":["schemaId":schemaId,"schemaVersion":"1.0.0","digest":schemaDigest],"operation":"calendar","payload":["schemaVersion":"1.0.0","operation":"ingest","items":objects]]
        return try canonical(envelope)
    }
    public static func receipts(_ data:Data,expected:[Item])throws->ResultSet {
        let r=try object(data);guard !expected.isEmpty,expected.count<=64,Set(r.keys)==Set(["schemaVersion","producerPin","result"]),r["schemaVersion"] as? String=="1.0.0",let pin=r["producerPin"] as? [String:String],pin==["schemaId":schemaId,"schemaVersion":"1.0.0","digest":schemaDigest],let result=r["result"] as? [String:Any],Set(result.keys)==Set(["kind","receipts"]),result["kind"] as? String=="sync",let receipts=result["receipts"] as? [[String:Any]],receipts.count==expected.count,Set(expected.map(\.eventId)).count==expected.count else{throw Failure.invalid}
        let map=Dictionary(uniqueKeysWithValues:expected.map{($0.eventId,$0)});var seen=Set<UUID>(),accepted=Set<UUID>(),rejected=[UUID:String](),held=Set<UUID>()
        for r in receipts {
            guard Set(r.keys)==Set(["eventId","requestDigest","outcome","code","durability"]),let id=uuid(r["eventId"]),seen.insert(id).inserted,let item=map[id],r["requestDigest"] as? String==item.digest,let outcome=r["outcome"] as? String,let code=r["code"] as? String else{throw Failure.invalid}
            switch outcome {
            case "accepted","duplicate":guard r["durability"] as? String=="sqlCommit",code==(item.operation=="delete" ? "deleted":"applied") else{throw Failure.invalid};accepted.insert(id)
            case "retryable":guard r["durability"] is NSNull,code=="unavailable" else{throw Failure.invalid};held.insert(id)
            case "rejected":guard r["durability"] is NSNull,["invalid","scope","settingsChanged","suppressed","conflict","quota","unavailable"].contains(code) else{throw Failure.invalid};rejected[id]=code
            default:throw Failure.invalid
            }
        };return ResultSet(accepted:accepted,rejected:rejected,held:held)
    }
}
