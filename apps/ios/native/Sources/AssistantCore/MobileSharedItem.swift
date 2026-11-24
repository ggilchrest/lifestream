import Foundation
import CoreFoundation
import CryptoKit
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// Untrusted declared metadata and in-memory integrity only. No URL is fetched,
/// reference resolved, file copied, source enrolled or protected custody proved.
enum MobileSharedItem {
    enum Failure:Error {case invalid}
    struct Artifact {let reference:String,sha256:String,mediaType:String,schemaRef:String,byteLength:Int}
    enum Content {case text(String),url(String,title:String?),attachment(kind:String,artifact:Artifact,displayName:String?),unavailable(reason:String,declaredMediaType:String?,displayName:String?)}
    struct Source {let collector:String,namespace:UUID,upstreamId:String?,originalApp:String?,originalDevice:String?}
    struct Value {let source:Source,sharedAt:String,collectedAt:String,originUrl:String?,note:String?,content:Content,data:Data}
    private static func dict(_ value:Any?)->[String:Any]? {value as? [String:Any]}
    private static func keys(_ d:[String:Any],_ expected:Set<String>)->Bool {Set(d.keys)==expected}
    private static func text(_ value:Any?,min:Int=1,max:Int)->Bool {guard let s=value as? String else{return false};return s.unicodeScalars.count>=min && s.unicodeScalars.count<=max}
    private static func nullable(_ value:Any?,min:Int=1,max:Int)->Bool {value is NSNull || text(value,min:min,max:max)}
    private static func integer(_ value:Any?)->Int? {guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue.rounded()==n.doubleValue,n.doubleValue>=0,n.doubleValue<=16777216 else{return nil};return n.intValue}
    private static func numericHostIsValid(_ host:String)->Bool {
        var parts=host.split(separator:".",omittingEmptySubsequences:false).map(String.init)
        if parts.last == "" {parts.removeLast()};guard let last=parts.last else{return false}
        func parse(_ value:String)->UInt64? {
            guard !value.isEmpty else{return nil};var digits=value,base=10
            if value.lowercased().hasPrefix("0x") {digits=String(value.dropFirst(2));base=16}
            else if value.count>1 && value.hasPrefix("0") {digits=String(value.dropFirst());base=8}
            if digits.isEmpty{return 0}
            guard digits.utf8.allSatisfy({byte in (48...57).contains(byte) || (base==16 && ((65...70).contains(byte) || (97...102).contains(byte)))}) else{return nil}
            return UInt64(digits,radix:base)
        }
        let numeric=last.range(of:"^[0-9]+$",options:.regularExpression) != nil || last.range(of:"^0[xX][0-9a-fA-F]*$",options:.regularExpression) != nil
        guard numeric else{return true};guard parts.count<=4 else{return false}
        var values=[UInt64]();for part in parts {guard let n=parse(part) else{return false};values.append(n)}
        guard values.dropLast().allSatisfy({$0<=255}),let final=values.last else{return false}
        let limit=UInt64(1) << (8*(5-values.count));return final<limit
    }
    private static func url(_ value:Any?)->Bool {
        guard let s=value as? String,!s.isEmpty,s.utf8.count<=8192,(s.hasPrefix("http://") || s.hasPrefix("https://")),s.utf8.allSatisfy({$0>=33 && $0<=126 && $0 != 92}),s.range(of:"^[A-Za-z0-9._~:/?#\\[\\]@!$&'()*+,;=%-]+$",options:.regularExpression) != nil,s.range(of:"%(?![0-9a-fA-F]{2})",options:.regularExpression)==nil else{return false}
        // Square brackets are URI host delimiters, not raw path/query data.
        let start=s.index(s.startIndex,offsetBy:s.hasPrefix("https://") ? 8:7),rest=s[start...],end=rest.firstIndex(where:{"/?#".contains($0)}) ?? s.endIndex
        guard !s[end...].contains("[") && !s[end...].contains("]"),s.filter({$0=="#"}).count<=1 else{return false}
        // WHATWG accepts extra leading slashes for special schemes. Use a
        // parsing-only form; preserve the caller's exact original URL bytes.
        let scheme=s.hasPrefix("https://") ? "https://":"http://",parsing=scheme+rest.drop(while:{$0=="/"})
        guard let components=URLComponents(string:parsing),["http","https"].contains(components.scheme ?? ""),let host=components.host,!host.isEmpty,(components.user ?? "").isEmpty,(components.password ?? "").isEmpty else{return false}
        if host.hasPrefix("[") {
            guard host.hasSuffix("]"),!host.contains("%") else{return false};let address=String(host.dropFirst().dropLast());var binary=in6_addr()
            guard address.withCString({inet_pton(AF_INET6,$0,&binary)})==1 else{return false}
        } else if !numericHostIsValid(host) {return false}
        if let port=components.port,!(0...65535).contains(port){return false};return true
    }
    private static func artifact(_ value:Any?)->Artifact? {
        guard let d=dict(value),keys(d,["reference","sha256","mediaType","schemaRef","byteLength"]),text(d["reference"],max:1000),let ref=d["reference"] as? String,let hash=d["sha256"] as? String,hash.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil,text(d["mediaType"],max:100),let mime=d["mediaType"] as? String,mime.range(of:"^[A-Za-z0-9!#$&^_.+\\-]+/[A-Za-z0-9!#$&^_.+\\-]+$",options:.regularExpression) != nil,text(d["schemaRef"],max:500),let schema=d["schemaRef"] as? String,let length=integer(d["byteLength"]) else{return nil};return .init(reference:ref,sha256:hash,mediaType:mime,schemaRef:schema,byteLength:length)
    }
    static func decode(_ data:Data)throws->Value {
        guard data.count<=65536,let root=try JSONSerialization.jsonObject(with:data) as? [String:Any],keys(root,["schemaVersion","source","sharedAt","collectedAt","originUrl","note","content"]),root["schemaVersion"] as? String == "1.0.0",let s=dict(root["source"]),keys(s,["collector","namespace","upstreamId","originalApp","originalDevice"]),let collector=s["collector"] as? String,["iosShareDeclaration","androidShareDeclaration"].contains(collector),let ns=s["namespace"] as? String,ns==ns.lowercased(),let namespace=UUID(uuidString:ns),namespace.uuidString.lowercased()==ns,nullable(s["upstreamId"],max:1024),nullable(s["originalApp"],max:1024),nullable(s["originalDevice"],max:1024),let shared=root["sharedAt"] as? String,MobileLocationObservation.Instant.parse(shared) != nil,let collected=root["collectedAt"] as? String,MobileLocationObservation.Instant.parse(collected) != nil,(root["originUrl"] is NSNull || url(root["originUrl"])),nullable(root["note"],min:0,max:8192),let c=dict(root["content"]),let kind=c["kind"] as? String else{throw Failure.invalid}
        let content:Content
        switch kind {
        case "text":guard keys(c,["kind","mediaType","text"]),c["mediaType"] as? String == "text/plain",text(c["text"],min:0,max:32768),let value=c["text"] as? String else{throw Failure.invalid};content = .text(value)
        case "url":guard keys(c,["kind","mediaType","url","title"]),c["mediaType"] as? String == "text/uri-list",url(c["url"]),let value=c["url"] as? String,nullable(c["title"],max:1024) else{throw Failure.invalid};content = .url(value,title:c["title"] as? String)
        case "attachmentReference":guard keys(c,["kind","contentKind","artifact","displayName"]),let type=c["contentKind"] as? String,["file","image"].contains(type),let a=artifact(c["artifact"]),type != "image" || a.mediaType.lowercased().hasPrefix("image/"),nullable(c["displayName"],max:1024) else{throw Failure.invalid};content = .attachment(kind:type,artifact:a,displayName:c["displayName"] as? String)
        case "unavailable":guard keys(c,["kind","reason","declaredMediaType","displayName"]),let reason=c["reason"] as? String,["unsupportedType","temporarilyUnavailable","notObservable","unknown"].contains(reason),nullable(c["declaredMediaType"],max:100),nullable(c["displayName"],max:1024) else{throw Failure.invalid};content = .unavailable(reason:reason,declaredMediaType:c["declaredMediaType"] as? String,displayName:c["displayName"] as? String)
        default:throw Failure.invalid
        }
        let source=Source(collector:collector,namespace:namespace,upstreamId:s["upstreamId"] as? String,originalApp:s["originalApp"] as? String,originalDevice:s["originalDevice"] as? String)
        return .init(source:source,sharedAt:shared,collectedAt:collected,originUrl:root["originUrl"] as? String,note:root["note"] as? String,content:content,data:try JSONSerialization.data(withJSONObject:root,options:[.sortedKeys,.withoutEscapingSlashes]))
    }
    /// Compare a bounded snapshot of supplied bytes; never interpret an opaque
    /// reference as a path or evidence of protected storage or ownership.
    static func verify(_ value:Value,bytes:Data?)->[String:Any]? {
        guard case .attachment(_,let artifact,_)=value.content,let bytes,bytes.count<=16777216,bytes.count==artifact.byteLength else{return nil}
        let copy=bytes.withUnsafeBytes {Data($0)},hash=SHA256.hash(data:copy).map{String(format:"%02x",$0)}.joined()
        guard hash==artifact.sha256 else{return nil};return ["qualification":"integrityOnly","sha256":hash,"byteLength":copy.count]
    }
}
