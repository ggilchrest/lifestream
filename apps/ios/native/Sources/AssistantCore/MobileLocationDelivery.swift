import Foundation
import CoreFoundation
import CryptoKit

/// Inert byte conformance only. No collection, issuer, queue or acknowledgement.
enum MobileLocationDelivery {
    static let pin:[String:String] = ["schemaId":"https://lifestream.dev/contracts/mobile-context-location-delivery/1.0.0","schemaVersion":"1.0.0","digest":"7396b3c01e76a93d8a7e46f0c4c87edfe9baee1b2ab7b0226342da2c823d8b5b"]
    static let rawPin="d517c97de632e1fdc83280d5978d83bf460d83f6f6965b966e09b79b84010a47"
    private static let bindingKeys=["humanId","endpointId","enrollmentId","enrollmentRevision","collector","sourceNamespace","sourceEpoch","policyRevision","policyBindingDigest","policyRef","classificationRuleRef","retentionPolicyRef","useScopeRef"]
    private static let refs=["sourceEpoch","policyRef","classificationRuleRef","retentionPolicyRef","useScopeRef"]
    struct Item {let originalObservationData:Data,observationSHA256:String,requestPreimage:Data,requestSHA256:String,identity:[Data]}
    struct Carrier {let originalWireData:Data,items:[Item],receiptPreimage:Data?,receiptSHA256:String?,receiptIdentity:[Data]?,outcome:String?}
    struct Result {let carrier:Carrier?,base64DecodeAttempts:Int}
    private static func sha(_ data:Data)->String {SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined()}
    private static func object(_ x:Any?)->[String:Any]? {x as? [String:Any]}
    private static func keys(_ x:[String:Any],_ k:[String])->Bool {Set(x.keys.map{Data($0.utf8)})==Set(k.map{Data($0.utf8)})}
    private static func str(_ x:Any?)->String? {x as? String}
    private static func uuid(_ x:Any?)->Bool {guard let x=x as? String,let u=UUID(uuidString:x) else{return false};return u.uuidString.lowercased()==x}
    private static func hash(_ x:Any?)->Bool {guard let x=x as? String,x.utf8.count==64 else{return false};return x.utf8.allSatisfy{(48...57).contains($0)||(97...102).contains($0)}}
    private static func num(_ x:Any?)->String? {guard let n=x as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue.rounded()==n.doubleValue,n.doubleValue>=1,n.doubleValue<=9007199254740991 else{return nil};return String(n.int64Value)}
    private static func boolean(_ x:Any?)->Bool {guard let n=x as? NSNumber else{return false};return CFGetTypeID(n)==CFBooleanGetTypeID()}
    private static func same(_ a:String,_ b:String)->Bool {Data(a.utf8)==Data(b.utf8)}
    private static func frame(_ domain:String,_ fields:[String])->Data {var d=Data(domain.utf8);for value in fields {let b=Data(value.utf8);var n=UInt32(b.count).bigEndian;withUnsafeBytes(of:&n){d.append(contentsOf:$0)};d.append(b)};return d}
    private static func binding(_ x:Any?)->[String:Any]? {guard let b=object(x),keys(b,bindingKeys),["humanId","endpointId","enrollmentId","sourceNamespace"].allSatisfy({uuid(b[$0])}),num(b["enrollmentRevision"]) != nil,num(b["policyRevision"]) != nil,hash(b["policyBindingDigest"]),let collector=str(b["collector"]),["coreLocation","androidLocation"].contains(collector),refs.allSatisfy({if let t=str(b[$0]){return !t.utf8.isEmpty && t.utf8.count<=256};return false}) else{return nil};return b}
    private static func bindingValues(_ b:[String:Any])->[String] {bindingKeys.map{key in if key=="enrollmentRevision" || key=="policyRevision" {return num(b[key])!};return b[key] as! String}}
    private static func request(_ b:[String:Any],_ event:String,_ attempt:String,_ observation:String)->Data {frame("lifestream/mobile-context-location-delivery-request/1\n",[rawPin]+bindingValues(b)+[event,attempt,observation])}
    private static func rawProducer(_ x:Any?)->Bool {guard let p=object(x),keys(p,["schemaId","schemaVersion","digest"]) else{return false};return str(p["schemaId"])=="https://lifestream.dev/contracts/mobile-context-location/1.0.0" && str(p["schemaVersion"])=="1.0.0" && str(p["digest"])==rawPin}
    private static func item(_ x:Any?,attempts:inout Int)->Item? {
        guard let d=object(x),keys(d,["schemaVersion","binding","eventId","attemptId","rawProducerPin","observationUtf8Base64","observationSha256","requestDigest"]),str(d["schemaVersion"])=="1.0.0",let b=binding(d["binding"]),uuid(d["eventId"]),uuid(d["attemptId"]),rawProducer(d["rawProducerPin"]),hash(d["observationSha256"]),hash(d["requestDigest"]),let encoded=str(d["observationUtf8Base64"]),encoded.utf8.count>=4,encoded.utf8.count<=87384 else{return nil}
        attempts += 1;guard let raw=Data(base64Encoded:encoded),!raw.isEmpty,raw.count<=65536,raw.base64EncodedString()==encoded,sha(raw)==str(d["observationSha256"]),lexical(raw,wire:false),let value=try? MobileLocationObservation.decode(raw),same(value.source.collector,b["collector"] as! String),value.source.namespace.uuidString.lowercased()==str(b["sourceNamespace"]) else{return nil}
        let event=d["eventId"] as! String,attempt=d["attemptId"] as! String,obs=d["observationSha256"] as! String,p=request(b,event,attempt,obs),digest=sha(p);guard digest==str(d["requestDigest"]) else{return nil}
        return Item(originalObservationData:Data(raw),observationSHA256:obs,requestPreimage:p,requestSHA256:digest,identity:(bindingValues(b)+[event,attempt,obs,digest]).map{Data($0.utf8)})
    }
    private static func receipt(_ d:[String:Any])->(Data,String,[Data],String)? {
        guard keys(d,["schemaVersion","binding","eventId","attemptId","observationSha256","requestDigest","outcome","code","durability","receiptDigest"]),str(d["schemaVersion"])=="1.0.0",let b=binding(d["binding"]),uuid(d["eventId"]),uuid(d["attemptId"]),hash(d["observationSha256"]),hash(d["requestDigest"]),hash(d["receiptDigest"]),let out=str(d["outcome"]),let code=str(d["code"]) else{return nil}
        let durability:String;if d["durability"] is NSNull {durability=""} else if let v=str(d["durability"]){durability=v}else{return nil}
        guard (out=="accepted" && code=="stored" && durability=="sqlCommit") || (out=="duplicate" && code=="sameOriginal" && durability=="sqlCommit") || (out=="unknown" && code=="unavailable" && durability.isEmpty) || (out=="rejected" && ["invalid","scope","policyChanged","suppressed","conflict","quota","unavailable"].contains(code) && durability.isEmpty) else{return nil}
        let event=d["eventId"] as! String,attempt=d["attemptId"] as! String,obs=d["observationSha256"] as! String,rd=d["requestDigest"] as! String;guard sha(request(b,event,attempt,obs))==rd else{return nil};let p=frame("lifestream/mobile-context-location-delivery-receipt/1\n",[rd,out,code,durability]),digest=sha(p);guard digest==str(d["receiptDigest"]) else{return nil};return (p,digest,(bindingValues(b)+[event,attempt,obs,rd]).map{Data($0.utf8)},out)
    }
    static func parse(_ data:Data,kind:String)->Result {
        var attempts=0;guard !data.isEmpty,data.count<=262144,let normalized=normalizedWire(data),let d=(try? JSONSerialization.jsonObject(with:normalized)) as? [String:Any] else{return Result(carrier:nil,base64DecodeAttempts:0)}
        var items=[Item](),rp:Data?,rh:String?,ri:[Data]?,out:String?,ok=false
        switch kind {
        case "LocationDeliveryBinding":ok=binding(d) != nil
        case "LocationDeliveryItem":if let i=item(d,attempts:&attempts){items=[i];ok=true}
        case "LocationDeliveryBatch":if keys(d,["schemaVersion","items"]),str(d["schemaVersion"])=="1.0.0",let arr=d["items"] as? [Any],(1...64).contains(arr.count){var identities=Set<[Data]>();ok=true;for entry in arr {guard let i=item(entry,attempts:&attempts) else{ok=false;break};let scope=Array(i.identity.prefix(3))+Array(i.identity[4...5])+Array(i.identity[13...14]);if !identities.insert(scope).inserted{ok=false;break};items.append(i)}}
        case "LocationDeliveryReceipt":if let result=receipt(d){rp=result.0;rh=result.1;ri=result.2;out=result.3;ok=true}
        case "LocationEnrollmentDescriptor":if keys(d,["schemaVersion","enrollmentId","humanId","endpointId","collector","sourceNamespace","revision","state"]),str(d["schemaVersion"])=="1.0.0",["enrollmentId","humanId","endpointId"].allSatisfy({uuid(d[$0])}),let c=str(d["collector"]),["coreLocation","androidLocation"].contains(c),num(d["revision"]) != nil,let state=str(d["state"]){ok = state=="unbound" ? d["sourceNamespace"] is NSNull : (["active","disconnected"].contains(state) && uuid(d["sourceNamespace"]))}
        case "LocationPolicyDescriptor":if keys(d,["schemaVersion","binding","allowedObservationKinds","collectionAllowed","useAllowed"]),str(d["schemaVersion"])=="1.0.0",binding(d["binding"]) != nil,boolean(d["collectionAllowed"]),boolean(d["useAllowed"]),let kinds=d["allowedObservationKinds"] as? [String],kinds.count<=3,Set(kinds).count==kinds.count,kinds.allSatisfy({["position","regionTransition","unavailable"].contains($0)}) {ok=true}
        default:break
        }
        guard ok else{return Result(carrier:nil,base64DecodeAttempts:attempts)};return Result(carrier:Carrier(originalWireData:Data(data),items:items,receiptPreimage:rp,receiptSHA256:rh,receiptIdentity:ri,outcome:out),base64DecodeAttempts:attempts)
    }
    static func match(_ item:Item,_ receipt:Carrier)->String {guard let identity=receipt.receiptIdentity,identity==item.identity,let outcome=receipt.outcome else{return "mismatch"};return ["accepted":"matchingAcceptedData","duplicate":"matchingDuplicateData","rejected":"matchingRejectedData","unknown":"matchingUnknownData"][outcome] ?? "mismatch"}
    static func consumerPin(_ data:Data)->Bool {guard let bytes=normalizedWire(data),let p=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any],keys(p,Array(pin.keys)) else{return false};return pin.allSatisfy{(p[$0.key] as? String)==$0.value}}
    private static func normalizedWire(_ data:Data)->Data? {
        guard !data.isEmpty,data.count<=262144,!data.starts(with:[0xef,0xbb,0xbf]),String(data:data,encoding:.utf8) != nil else{return nil};var parser=Strict(bytes:Array(data),wire:true,asciiKeysOnly:true);guard parser.run() else{return nil};var out=Data(),cursor=0;for (range,value) in parser.replacements {out.append(contentsOf:parser.bytes[cursor..<range.lowerBound]);out.append(contentsOf:value.utf8);cursor=range.upperBound};out.append(contentsOf:parser.bytes[cursor...]);return out
    }
    static func lexical(_ data:Data,wire:Bool)->Bool {guard !data.isEmpty,data.count <= (wire ? 262144:65536),!data.starts(with:[0xef,0xbb,0xbf]),String(data:data,encoding:.utf8) != nil else{return false};var s=Strict(bytes:Array(data),wire:wire);return s.run()}
    private struct Strict {
        let bytes:[UInt8],wire:Bool;var asciiKeysOnly=false;var at=0,nodes=0,replacements=[(Range<Int>,String)]()
        mutating func ws(){while at<bytes.count && [9,10,13,32].contains(bytes[at]){at += 1}}
        mutating func take(_ b:UInt8)->Bool {guard at<bytes.count,bytes[at]==b else{return false};at += 1;return true}
        mutating func hex4()->Int? {guard at+4<=bytes.count else{return nil};var n=0;for _ in 0..<4 {let c=bytes[at];at += 1;let v:Int;if (48...57).contains(c){v=Int(c-48)}else if (65...70).contains(c){v=Int(c-65)+10}else if (97...102).contains(c){v=Int(c-97)+10}else{return nil};n=n*16+v};return n}
        mutating func string()->Data? {
            let start=at;guard take(34) else{return nil}
            while at<bytes.count {let c=bytes[at];at += 1;if c==34 {var wrapped=Data([91]);wrapped.append(contentsOf:bytes[start..<at]);wrapped.append(93);guard let a=(try? JSONSerialization.jsonObject(with:wrapped)) as? [String],let v=a.first else{return nil};return Data(v.utf8)}
                if c<32{return nil};if c==92 {guard at<bytes.count else{return nil};let e=bytes[at];at += 1;if e==117 {guard let u=hex4() else{return nil};if (0xd800...0xdbff).contains(u){guard take(92),take(117),let low=hex4(),(0xdc00...0xdfff).contains(low) else{return nil}}else if (0xdc00...0xdfff).contains(u){return nil}}else if ![34,92,47,98,102,110,114,116].contains(e){return nil}}
            };return nil
        }
        mutating func number()->Bool {
            let start=at;_ = take(45);guard at<bytes.count else{return false};if take(48){}else {guard at<bytes.count,(49...57).contains(bytes[at]) else{return false};at += 1;while at<bytes.count,(48...57).contains(bytes[at]){at += 1}}
            if take(46){let before=at;while at<bytes.count,(48...57).contains(bytes[at]){at += 1};if at==before{return false}}
            if at<bytes.count,bytes[at]==101 || bytes[at]==69 {at += 1;if at<bytes.count,bytes[at]==43 || bytes[at]==45{at += 1};let before=at;while at<bytes.count,(48...57).contains(bytes[at]){at += 1};if at==before{return false}}
            if wire {guard let number=Self.revisionValue(String(decoding:bytes[start..<at],as:UTF8.self)) else{return false};replacements.append((start..<at,number))};return true
        }
        static func revisionValue(_ token:String)->String? {
            guard !token.hasPrefix("-") else{return nil};let pieces=token.lowercased().split(separator:"e",omittingEmptySubsequences:false),mantissa=String(pieces[0]),digitsParts=mantissa.split(separator:".",omittingEmptySubsequences:false),fraction=digitsParts.count>1 ? String(digitsParts[1]):"";var digits=String(digitsParts[0])+fraction;while digits.first=="0"{digits.removeFirst()};guard !digits.isEmpty else{return nil}
            let rawExp=pieces.count>1 ? String(pieces[1]):"0",negative=rawExp.hasPrefix("-"),expDigits=rawExp.drop(while:{$0=="+" || $0=="-" || $0=="0"});guard expDigits.count<=6,let exponent=Int(expDigits.isEmpty ? "0":String(expDigits)) else{return nil};let shift=(negative ? -exponent:exponent)-fraction.count;let integer:String
            if shift>=0 {guard digits.count+shift<=16 else{return nil};integer=digits+String(repeating:"0",count:shift)}else{let cut=digits.count+shift;guard cut>=1,cut<=16 else{return nil};let split=digits.index(digits.startIndex,offsetBy:cut);guard digits[split...].allSatisfy({$0=="0"}) else{return nil};integer=String(digits[..<split])}
            return integer.count<16 || integer<="9007199254740991" ? integer:nil
        }
        mutating func value(_ depth:Int)->Bool {
            nodes += 1;guard nodes<=65536 else{return false};ws();guard at<bytes.count else{return false};let c=bytes[at]
            if c==123 || c==91 {guard depth<32 else{return false};at += 1;ws();let end:UInt8 = c==123 ? 125:93;if take(end){return true};var names=Set<Data>();while true {if c==123 {guard let k=string(),(!asciiKeysOnly || k.allSatisfy({$0<128})),names.insert(k).inserted else{return false};ws();guard take(58) else{return false}};guard value(depth+1) else{return false};ws();if take(end){return true};guard take(44) else{return false};ws()}}
            if c==34{return string() != nil};for literal in ["null","true","false"] {let b=Array(literal.utf8);if bytes[at...].starts(with:b){at += b.count;return true}};return number()
        }
        mutating func run()->Bool {guard value(0) else{return false};ws();return at==bytes.count}
    }
}
