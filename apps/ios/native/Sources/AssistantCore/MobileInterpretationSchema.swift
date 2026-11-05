import Foundation
import CoreFoundation
import CryptoKit

/// Validates only the bounded, pinned producing schema bundled with this module.
/// The control-response reference is checked later by the existing receipt owner.
enum MobileInterpretationSchema {
    static let digest = "5ed2ee913fc647ba453be4be302f5701e0d6f3c3072d76a7c49c2736048ee141"
    static let schemaId = "https://lifestream.dev/contracts/mobile-context-interpretation/1.0.0"
    static let controlId = "https://lifestream.dev/contracts/mobile-context-control/1.0.0#/$defs/"
    static let definitions: [String: Any]? = {
        guard let url = Bundle.module.url(forResource:"mobile-context-interpretation.schema", withExtension:"json"),
              let bytes = try? Data(contentsOf:url), bytes.count < 262144,
              SHA256.hash(data:bytes).map({String(format:"%02x",$0)}).joined() == digest,
              let schema = try? JSONSerialization.jsonObject(with:bytes) as? [String: Any],
              schema["$id"] as? String == schemaId else { return nil }
        return schema["$defs"] as? [String: Any]
    }()
    static func validate(_ value: Any, definition: String) -> Bool {
        guard let definitions, let schema = definitions[definition] as? [String: Any] else { return false }
        return check(value,schema,definitions,0)
    }
    private static func equal(_ a: Any,_ b: Any) -> Bool {
        guard JSONSerialization.isValidJSONObject([a]), JSONSerialization.isValidJSONObject([b]),
              let x = try? JSONSerialization.data(withJSONObject:[a],options:[.sortedKeys,.withoutEscapingSlashes]),
              let y = try? JSONSerialization.data(withJSONObject:[b],options:[.sortedKeys,.withoutEscapingSlashes]) else { return false }
        return x == y
    }
    private static func check(_ value:Any,_ schema:[String:Any],_ definitions:[String:Any],_ depth:Int) -> Bool {
        guard depth < 48 else { return false }
        if let ref=schema["$ref"] as? String {
            if ref == controlId + "MobileControlRequest" {
                guard value is [String:Any], JSONSerialization.isValidJSONObject(value), let b=try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes]), b.count<=65536 else{return false}
                return (try? MobileControlOriginal.parse(b)) != nil
            }
            if ref == controlId + "MobileControlResponse" {
                guard value is [String:Any],let b=try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes]) else{return false};return b.count<=65536
            }
            let prefix="#/$defs/";guard ref.hasPrefix(prefix),let nested=definitions[String(ref.dropFirst(prefix.count))] as? [String:Any] else{return false}
            return check(value,nested,definitions,depth+1)
        }
        if let alternatives=schema["oneOf"] as? [[String:Any]] { return alternatives.filter{check(value,$0,definitions,depth+1)}.count==1 }
        if let constant=schema["const"], !equal(value,constant) {return false}
        if let choices=schema["enum"] as? [Any], !choices.contains(where:{equal(value,$0)}) {return false}
        guard let type=schema["type"] as? String else { return true }
        switch type {
        case "null": return value is NSNull
        case "boolean": guard let n=value as? NSNumber else{return false}; return CFGetTypeID(n)==CFBooleanGetTypeID()
        case "integer", "number":
            guard let n=value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite else{return false}
            let v=n.doubleValue; if type=="integer" && v.rounded() != v{return false}
            if let min=schema["minimum"] as? NSNumber, v<min.doubleValue{return false};if let max=schema["maximum"] as? NSNumber,v>max.doubleValue{return false};return true
        case "string":
            guard let s=value as? String else{return false};let length=s.unicodeScalars.count
            if let min=schema["minLength"] as? Int,length<min{return false};if let max=schema["maxLength"] as? Int,length>max{return false}
            if let p=schema["pattern"] as? String, s.range(of:p,options:.regularExpression)==nil{return false}
            if schema["format"] as? String == "date-time" {let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];if f.date(from:s)==nil {f.formatOptions=[.withInternetDateTime];if f.date(from:s)==nil{return false}}};return true
        case "array":
            guard let a=value as? [Any] else{return false};if let min=schema["minItems"] as? Int,a.count<min{return false};if let max=schema["maxItems"] as? Int,a.count>max{return false}
            if let item=schema["items"] as? [String:Any], !a.allSatisfy({check($0,item,definitions,depth+1)}){return false}
            if schema["uniqueItems"] as? Bool == true {var seen=Set<Data>();for v in a {guard let d=try? JSONSerialization.data(withJSONObject:[v],options:[.sortedKeys,.withoutEscapingSlashes]),seen.insert(d).inserted else{return false}}};return true
        case "object":
            guard let o=value as? [String:Any],let properties=schema["properties"] as? [String:Any] else{return false}
            if let required=schema["required"] as? [String],!Set(required).isSubset(of:Set(o.keys)){return false}
            if schema["additionalProperties"] as? Bool == false,!Set(o.keys).isSubset(of:Set(properties.keys)){return false}
            for (k,v) in o {if let nested=properties[k] as? [String:Any],!check(v,nested,definitions,depth+1){return false}};return true
        default:return false
        }
    }
}
