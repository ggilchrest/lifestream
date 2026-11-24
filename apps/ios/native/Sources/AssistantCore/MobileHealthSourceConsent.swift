import Foundation
import CoreFoundation
import CryptoKit

/// Source-consent wire consumer. A recorded decision is never effective source
/// availability, an Assistant grant, system permission or permission to replay.
/// Dedicated literal Health producer11364/schema0d81; historical pins stay closed.
public enum MobileHealthSourceConsent {
    public static let schemaID="https://lifestream.dev/contracts/mobile-context-health-source-consent/1.0.0"
    public static let schemaDigest="0d81d750b4ef9d7c7f13f27f19e6caf9d35a9cf29fa9189b325d4df4932ae72a"
    public static var pin:[String:String]{["schemaId":schemaID,"schemaVersion":"1.0.0","digest":schemaDigest]}
    public enum Failure:Error{case invalid,held}
    public static let categories:Set<String>=["SleepSegment","heartRate","restingHeartRate","respiratoryRate","hrvSDNN","hrvRMSSD"]
    public static let collectors:Set<String>=["healthKit","healthConnect"]
    public enum Purpose:String {case collection,transmission,answers}
    public enum Kind:String {case request="requestSourceConsent",approve="approveSourceConsent",revoke="revokeSourceConsent"}
    public struct Scope:Equatable {
        public let principal:UUID,namespace:UUID,installation:UUID,environment:String,destination:String,collector:String,category:String,purpose:Purpose,recipient:UUID?,canonical:Data
        public var json:[String:Any]{try! JSONSerialization.jsonObject(with:canonical) as! [String:Any]}
        public static func ==(a:Self,b:Self)->Bool{a.canonical==b.canonical}
    }
    public struct Descriptor:Equatable {
        public let principal:UUID,endpoint:UUID,enrollment:UUID,namespace:UUID,sourceRevision:Int,installation:UUID,environment:String,destination:String,collector:String,category:String,canonical:Data
        public var json:[String:Any]{try! JSONSerialization.jsonObject(with:canonical) as! [String:Any]}
        public func scope(purpose:Purpose,recipient:UUID?=nil)throws->Scope{
            try MobileHealthSourceConsent.scope(["kind":"sourceConsent","principalId":principal.uuidString.lowercased(),"collector":collector,"sourceNamespace":namespace.uuidString.lowercased(),"category":category,"installationId":installation.uuidString.lowercased(),"environmentId":environment,"destinationId":destination,"purpose":purpose.rawValue,"recipient":recipient?.uuidString.lowercased() as Any? ?? NSNull()])
        }
        public static func ==(a:Self,b:Self)->Bool{a.canonical==b.canonical}
    }
    public enum Validity:Equatable {
        case untilRevoked,expiresAt(String)
        public var json:[String:Any]{switch self{case .untilRevoked:return ["kind":"untilRevoked"];case .expiresAt(let date):return ["kind":"expiresAt","expiresAt":date]}}
    }
    public struct Original {
        public let kind:Kind,operationID:UUID,revision:Int,scope:Scope,payload:Data,original:Data,digest:String,validity:Validity?,reviewDeadline:String?,request:Data?,confirmation:String?
        public var json:[String:Any]{try! JSONSerialization.jsonObject(with:payload) as! [String:Any]}
    }
    public struct Reserved {
        public let original:Original,response:Data,confirmation:String,sourceDigest:String,contextDigest:String,reservationDigest:String,approvalAvailable:Bool
    }
    public struct Terminal {
        public let original:Original,response:Data,revision:Int,decisionDigest:String,committedAt:String
    }
    public struct Status {
        public let scope:Scope,revision:Int,state:String,validity:Validity?,decision:Data,response:Data
        public var json:[String:Any]{try! JSONSerialization.jsonObject(with:response) as! [String:Any]}
    }
    public enum Response {
        case descriptor(Descriptor),status(Status),reserved(Reserved),terminal(Terminal),observed(UUID),held(String)
    }
    private static func keys(_ v:[String:Any],_ required:Set<String>,_ optional:Set<String>=[])->Bool{required.isSubset(of:Set(v.keys)) && Set(v.keys).isSubset(of:required.union(optional))}
    private static func id(_ v:Any?)->UUID?{MobileControlOriginal.uuid(v)}
    private static func integer(_ v:Any?,min:Int=0)->Int?{MobileControlOriginal.number(v,min:min,max:9007199254740991)}
    private static func boolean(_ v:Any?)->Bool?{guard let n=v as? NSNumber,CFGetTypeID(n)==CFBooleanGetTypeID() else{return nil};return n.boolValue}
    private static func text(_ v:Any?)->String?{guard let s=v as? String,!s.isEmpty,s.unicodeScalars.count<=256,s.utf8.count<=1024,!s.unicodeScalars.contains(where:{$0.value<32}) else{return nil};return s}
    private static func hex(_ v:Any?)->String?{guard let s=v as? String,s.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil else{return nil};return s}
    public static func date(_ v:Any?)->Date?{
        guard let s=v as? String,s.utf8.count<=128 else{return nil}
        let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
        if let date=f.date(from:s){return date};f.formatOptions=[.withInternetDateTime];return f.date(from:s)
    }
    public static func canonical(_ v:Any)throws->Data{try MobileCalendarDelivery.canonical(v)}
    public static func digest(_ v:Any)throws->String{SHA256.hash(data:try canonical(v)).map{String(format:"%02x",$0)}.joined()}
    private static func object(_ bytes:Data,max:Int=131072)throws->[String:Any]{guard bytes.count<=max else{throw Failure.invalid};return try MobileCalendarSettingsWire.object(bytes)}
    public static func scope(_ v:Any)throws->Scope{
        guard let v=v as? [String:Any],keys(v,["kind","principalId","collector","sourceNamespace","category","installationId","environmentId","destinationId","purpose","recipient"]),v["kind"] as? String=="sourceConsent",let collector=v["collector"] as? String,collectors.contains(collector),let category=v["category"] as? String,categories.contains(category),let principal=id(v["principalId"]),let ns=id(v["sourceNamespace"]),let installation=id(v["installationId"]),let env=text(v["environmentId"]),let dest=text(v["destinationId"]),let raw=v["purpose"] as? String,let purpose=Purpose(rawValue:raw) else{throw Failure.invalid}
        let recipient=id(v["recipient"])
        guard purpose == .answers ? recipient != nil:v["recipient"] is NSNull else{throw Failure.invalid}
        return .init(principal:principal,namespace:ns,installation:installation,environment:env,destination:dest,collector:collector,category:category,purpose:purpose,recipient:recipient,canonical:try canonical(v))
    }
    public static func validity(_ v:Any)throws->Validity{
        guard let v=v as? [String:Any] else{throw Failure.invalid}
        if keys(v,["kind"]),v["kind"] as? String=="untilRevoked"{return .untilRevoked}
        guard keys(v,["kind","expiresAt"]),v["kind"] as? String=="expiresAt",let raw=v["expiresAt"] as? String,date(raw) != nil else{throw Failure.invalid};return .expiresAt(raw)
    }
    private static func original(_ v:Any)throws->Original{
        guard let v=v as? [String:Any],let raw=v["command"] as? String,let kind=Kind(rawValue:raw),let op=id(v["operationId"]),let revision=integer(v["expectedRevision"]) else{throw Failure.invalid}
        let scope=try scope(v["scope"] as Any)
        var validity:Validity?,deadline:String?,request:Data?,confirmation:String?
        switch kind{
        case .request:
            guard keys(v,["operationId","expectedRevision","scope","command","validity","reviewDeadlineAt"]),let d=v["reviewDeadlineAt"] as? String,date(d) != nil else{throw Failure.invalid};validity=try self.validity(v["validity"] as Any);deadline=d
        case .approve:
            guard keys(v,["operationId","expectedRevision","scope","command","request","confirmationDigest","humanConfirmed"]),boolean(v["humanConfirmed"])==true,let c=hex(v["confirmationDigest"]) else{throw Failure.invalid}
            let r=try original(v["request"] as Any)
            guard r.kind == .request,r.operationID != op,r.revision==revision,r.scope==scope else{throw Failure.invalid};request=r.payload;confirmation=c;validity=r.validity;deadline=r.reviewDeadline
        case .revoke:guard keys(v,["operationId","expectedRevision","scope","command"]) else{throw Failure.invalid}
        }
        let payload=try canonical(v),operation=kind == .request ? "requestApproval":kind == .approve ? "approve":"revoke"
        return .init(kind:kind,operationID:op,revision:revision,scope:scope,payload:payload,original:try canonical(["producerPin":pin,"operation":operation,"payload":v]),digest:try digest(v),validity:validity,reviewDeadline:deadline,request:request,confirmation:confirmation)
    }
    public static func command(_ bytes:Data)throws->Original{
        let v=try object(bytes)
        guard keys(v,["producerPin","operation","payload"]),v["producerPin"] as? [String:String]==pin else{throw Failure.invalid}
        let r=try original(v["payload"] as Any),operation=r.kind == .request ? "requestApproval":r.kind == .approve ? "approve":"revoke"
        guard v["operation"] as? String==operation else{throw Failure.invalid};return r
    }
    public static func request(operationID:UUID,scope:Scope,revision:Int,validity:Validity,reviewDeadline:String)throws->Original{
        try original(["operationId":operationID.uuidString.lowercased(),"expectedRevision":revision,"scope":scope.json,"command":"requestSourceConsent","validity":validity.json,"reviewDeadlineAt":reviewDeadline])
    }
    public static func approval(operationID:UUID,review:Reserved,humanConfirmed:Bool)throws->Original{
        guard review.approvalAvailable,humanConfirmed else{throw Failure.invalid}
        return try original(["operationId":operationID.uuidString.lowercased(),"expectedRevision":review.original.revision,"scope":review.original.scope.json,"command":"approveSourceConsent","request":review.original.json,"confirmationDigest":review.confirmation,"humanConfirmed":true])
    }
    public static func revoke(operationID:UUID,scope:Scope,revision:Int)throws->Original{try original(["operationId":operationID.uuidString.lowercased(),"expectedRevision":revision,"scope":scope.json,"command":"revokeSourceConsent"])}
    public static func reconcile(_ original:Original)throws->Data{try canonical(["producerPin":pin,"operation":"reconcile","payload":original.json])}
    public static func describe(enrollment:UUID,category:String)throws->Data{guard categories.contains(category) else{throw Failure.invalid};return try canonical(["producerPin":pin,"operation":"describe","payload":["enrollmentId":enrollment.uuidString.lowercased(),"category":category]])}
    public static func inspect(_ scope:Scope)throws->Data{try canonical(["producerPin":pin,"operation":"inspect","payload":scope.json])}
    public static func response(_ bytes:Data,expected:Original?=nil,expectedScope:Scope?=nil)throws->Response{
        let root=try object(bytes,max:524288)
        guard keys(root,["producerPin","schemaVersion","result"]),root["producerPin"] as? [String:String]==pin,root["schemaVersion"] as? String=="1.0.0",let r=root["result"] as? [String:Any],let kind=r["kind"] as? String else{throw Failure.invalid}
        switch kind{
        case "held":guard keys(r,["kind","reason"]),let reason=r["reason"] as? String,["unknown","pending","unavailable","conflict","configuration","scope","quota"].contains(reason) else{throw Failure.invalid};return .held(reason)
        case "observed":guard keys(r,["kind","operationId"]),let op=id(r["operationId"]),expected==nil || expected?.operationID==op else{throw Failure.invalid};return .observed(op)
        case "descriptor":
            guard expected==nil,keys(r,["kind","principalId","endpointId","enrollmentId","sourceNamespace","sourceRevision","collector","category","installationId","environmentId","destinationId"]),let collector=r["collector"] as? String,collectors.contains(collector),let category=r["category"] as? String,categories.contains(category),let principal=id(r["principalId"]),let endpoint=id(r["endpointId"]),let enrollment=id(r["enrollmentId"]),let ns=id(r["sourceNamespace"]),let revision=integer(r["sourceRevision"],min:1),let installation=id(r["installationId"]),let env=text(r["environmentId"]),let dest=text(r["destinationId"]) else{throw Failure.invalid}
            return .descriptor(.init(principal:principal,endpoint:endpoint,enrollment:enrollment,namespace:ns,sourceRevision:revision,installation:installation,environment:env,destination:dest,collector:collector,category:category,canonical:try canonical(r)))
        case "status":
            guard expected==nil,keys(r,["kind","scope","revision","consentState","decision"]),let revision=integer(r["revision"]),let state=r["consentState"] as? String,let decision=r["decision"] as? [String:Any] else{throw Failure.invalid}
            let scope=try scope(r["scope"] as Any);guard expectedScope==nil || expectedScope==scope else{throw Failure.invalid}
            var validity:Validity?
            switch state{
            case "absent":guard revision==0,keys(decision,["kind"]),decision["kind"] as? String=="none" else{throw Failure.invalid}
            case "valid","expired":guard revision>=1,keys(decision,["kind","validity","requestDigest","operationId","decidedAt"]),decision["kind"] as? String=="approved",hex(decision["requestDigest"]) != nil,id(decision["operationId"]) != nil,date(decision["decidedAt"]) != nil else{throw Failure.invalid};validity=try self.validity(decision["validity"] as Any)
            case "revoked":guard revision>=1,keys(decision,["kind","operationId","decidedAt"]),decision["kind"] as? String=="revoked",id(decision["operationId"]) != nil,date(decision["decidedAt"]) != nil else{throw Failure.invalid}
            default:throw Failure.invalid
            }
            return .status(.init(scope:scope,revision:revision,state:state,validity:validity,decision:try canonical(decision),response:bytes))
        case "reserved","terminal":
            let original=try original(r["original"] as Any)
            guard let requestDigest=hex(r["requestDigest"]),requestDigest==original.digest,expected==nil || expected?.payload==original.payload,expectedScope==nil || expectedScope==original.scope else{throw Failure.invalid}
            let reservation=try digest(["requestDigest":requestDigest,"state":"pending","attemptStarted":0,"prepared":NSNull(),"outcome":NSNull()])
            if kind=="reserved"{
                guard keys(r,["kind","original","requestDigest","confirmationDigest","sourceDigest","reviewContextDigest","reservationDigest","approvalAvailable"]),original.kind == .request,let confirmation=hex(r["confirmationDigest"]),let source=hex(r["sourceDigest"]),let context=hex(r["reviewContextDigest"]),r["reservationDigest"] as? String==reservation,let available=boolean(r["approvalAvailable"]),confirmation == (try digest(["requestDigest":requestDigest,"sourceDigest":source,"reviewContextDigest":context,"reservationDigest":reservation])) else{throw Failure.invalid}
                return .reserved(.init(original:original,response:bytes,confirmation:confirmation,sourceDigest:source,contextDigest:context,reservationDigest:reservation,approvalAvailable:available))
            }
            guard keys(r,["kind","original","requestDigest","status","binding","receipt"]),original.kind != .request,r["status"] as? String=="applied",let binding=r["binding"] as? [String:Any],keys(binding,["family","reservationDigest","preparedDigest","terminalDigest"]),binding["family"] as? String=="healthSourceConsent",binding["reservationDigest"] as? String==reservation,hex(binding["preparedDigest"]) != nil,hex(binding["terminalDigest"]) != nil,let receipt=r["receipt"] as? [String:Any],keys(receipt,["receiptId","operationId","requestDigest","scopeDigest","revision","decisionDigest","committedAt","sqlCommit"]),id(receipt["receiptId"]) != nil,id(receipt["operationId"])==original.operationID,receipt["requestDigest"] as? String==requestDigest,receipt["scopeDigest"] as? String == (try digest(original.scope.json)),let revision=integer(receipt["revision"],min:1),revision==original.revision+1,let decision=hex(receipt["decisionDigest"]),let committed=receipt["committedAt"] as? String,date(committed) != nil,boolean(receipt["sqlCommit"])==true else{throw Failure.invalid}
            return .terminal(.init(original:original,response:bytes,revision:revision,decisionDigest:decision,committedAt:committed))
        default:throw Failure.invalid
        }
    }
}
