import Foundation
import CoreFoundation

/// Owner-scoped inventory contains source choices and unknown coverage, never health measurements.
public struct MobileHealthInventoryPage {
    public struct Source {
        public let namespace: UUID
        public let collector: String
        public let policyRevision: Int
        public let enrollmentCount: Int
        public let currentEnrollment: UUID?
        public let currentState: String?
        public let categories: Set<String>
        public let uses: Set<String>
        public let assistants: Set<String>
        public let preferredSource: String?
        public let collectionPaused: Bool
        public let usePaused: Bool
    }
    public struct UnboundEnrollment: Equatable { public let id: UUID; public let collector: String; public let revision: Int }
    public let sources: [Source]
    public let unboundEnrollments: [UnboundEnrollment]
    public let nextCursor: String?
}
public enum MobileHealthInventory {
    public static let schemaId="https://lifestream.dev/contracts/mobile-context-inventory/1.0.0"
    public static let schemaSHA256="e1acb99e91e92807ec2846f893c364ad7f1120b9d34d16e96836a6ea864d2954"
    public enum Failure: Error { case invalid }
    private static var pin:[String:String] { ["schemaId":schemaId,"schemaVersion":"1.0.0","digest":schemaSHA256] }
    private static let categorySet:Set<String>=["SleepSegment","heartRate","restingHeartRate","respiratoryRate","hrvSDNN","hrvRMSSD"]
    private static let useSet:Set<String>=["answers","summaries","memory","proactive"]
    private static func keys(_ x:[String:Any],_ required:Set<String>,_ optional:Set<String>=[]) -> Bool { required.isSubset(of:Set(x.keys)) && Set(x.keys).isSubset(of:required.union(optional)) }
    private static func uuid(_ x:Any?) -> UUID? { guard let s=x as? String,let id=UUID(uuidString:s),id.uuidString.lowercased()==s.lowercased() else{return nil};return id }
    private static func bool(_ x:Any?) -> Bool? { guard let n=x as? NSNumber,CFGetTypeID(n)==CFBooleanGetTypeID() else{return nil};return n.boolValue }
    private static func number(_ x:Any?,minimum:Int,maximum:Int) -> Int? { guard let n=x as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue >= Double(minimum),n.doubleValue <= Double(maximum),n.doubleValue.rounded()==n.doubleValue else{return nil};return n.intValue }
    private static func values(_ x:Any?,allowed:Set<String>,max:Int) -> Set<String>? { guard let a=x as? [String],a.count<=max,Set(a).count==a.count,Set(a).isSubset(of:allowed) else{return nil};return Set(a) }
    private static func ids(_ x:Any?) -> Set<String>? { guard let a=x as? [String],a.count<=32,Set(a).count==a.count,a.allSatisfy({$0.range(of:"^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$",options:[.regularExpression,.caseInsensitive]) != nil}) else{return nil};return Set(a) }
    private struct Config { let categories:Set<String>;let uses:Set<String>;let assistants:Set<String>;let preferredSource:String?;let collectionPaused:Bool;let usePaused:Bool }
    private static func config(_ x:Any?) -> Config? {
        guard let d=x as? [String:Any],keys(d,["categories","uses","assistantIds","collectionPaused","usePaused"],["preferredSource"]),let cats=values(d["categories"],allowed:categorySet,max:6),let uses=values(d["uses"],allowed:useSet,max:4),let assistants=ids(d["assistantIds"]),let collection=bool(d["collectionPaused"]),let use=bool(d["usePaused"]) else{return nil}
        if let value=d["preferredSource"] { guard let s=value as? String,!s.isEmpty,s.unicodeScalars.count<=1024 else{return nil} }
        return Config(categories:cats,uses:uses,assistants:assistants,preferredSource:d["preferredSource"] as? String,collectionPaused:collection,usePaused:use)
    }
    private static func enrollment(_ x:Any?,principal:UUID,endpoint:UUID) -> (UUID,String,UUID?,String,Int,Config)? {
        guard let d=x as? [String:Any],keys(d,["enrollmentId","principalId","endpointId","collector","sourceNamespace","revision","state","configuration"]),let id=uuid(d["enrollmentId"]),uuid(d["principalId"])==principal,uuid(d["endpointId"])==endpoint,let collector=d["collector"] as? String,["healthKit","healthConnect"].contains(collector),let rev=number(d["revision"],minimum:1,maximum:9007199254740991),let state=d["state"] as? String,["unbound","active","disconnected"].contains(state),let cfg=config(d["configuration"]) else{return nil}
        let ns=uuid(d["sourceNamespace"]);guard d["sourceNamespace"] is NSNull || ns != nil else{return nil}
        if state == "unbound" && ns != nil{return nil};if state != "unbound" && ns == nil{return nil}
        return (id,collector,ns,state,rev,cfg)
    }
    public static func request(cursor:String?=nil) throws -> Data {
        var payload:[String:Any]=["schemaVersion":"1.0.0","pageSize":25]
        if let cursor { guard !cursor.isEmpty,cursor.utf8.count<=256,!cursor.unicodeScalars.contains(where:{$0.value<32}) else { throw Failure.invalid };payload["cursor"]=cursor }
        return try JSONSerialization.data(withJSONObject:["producerPin":pin,"operation":"inventory","payload":payload],options:[.sortedKeys])
    }
    public static func parse(_ data:Data,expectedPrincipal:UUID,expectedEndpoint:UUID) throws -> MobileHealthInventoryPage {
        guard data.count<=65536,let root=try? JSONSerialization.jsonObject(with:data) as? [String:Any],keys(root,["schemaVersion","producerPin","result"]),root["schemaVersion"] as? String == "1.0.0",let actual=root["producerPin"] as? [String:String],actual==pin,let result=root["result"] as? [String:Any],keys(result,["principalId","endpointId","sources","unboundEnrollments","nextCursor"]),uuid(result["principalId"])==expectedPrincipal,uuid(result["endpointId"])==expectedEndpoint,let raw=result["sources"] as? [[String:Any]],raw.count<=50,let unbound=result["unboundEnrollments"] as? [[String:Any]],unbound.count<=2 else { throw Failure.invalid }
        var sources=[MobileHealthInventoryPage.Source](),seen=Set<UUID>()
        for item in raw {
            guard keys(item,["sourceNamespace","collector","policyRevision","configuration","enrollmentCount","currentEndpointEnrollment","coverage"]),let ns=uuid(item["sourceNamespace"]),seen.insert(ns).inserted,let collector=item["collector"] as? String,["healthKit","healthConnect"].contains(collector),let revision=number(item["policyRevision"],minimum:1,maximum:9007199254740991),let count=number(item["enrollmentCount"],minimum:0,maximum:1000000),let cfg=config(item["configuration"]),let coverage=item["coverage"] as? [String:Any],keys(coverage,["state"]),coverage["state"] as? String == "unknown" else { throw Failure.invalid }
            var id:UUID?,state:String?
            if !(item["currentEndpointEnrollment"] is NSNull) {
                guard let e=enrollment(item["currentEndpointEnrollment"],principal:expectedPrincipal,endpoint:expectedEndpoint),e.1==collector,e.2==ns,e.3 != "unbound",e.4==revision else { throw Failure.invalid }
                id=e.0;state=e.3
            }
            sources.append(.init(namespace:ns,collector:collector,policyRevision:revision,enrollmentCount:count,currentEnrollment:id,currentState:state,categories:cfg.categories,uses:cfg.uses,assistants:cfg.assistants,preferredSource:cfg.preferredSource,collectionPaused:cfg.collectionPaused,usePaused:cfg.usePaused))
        }
        var pending=[MobileHealthInventoryPage.UnboundEnrollment](), pendingIds=Set<UUID>()
        for item in unbound {guard let e=enrollment(item,principal:expectedPrincipal,endpoint:expectedEndpoint),e.3 == "unbound",e.2 == nil,pendingIds.insert(e.0).inserted else { throw Failure.invalid };pending.append(.init(id:e.0,collector:e.1,revision:e.4))}
        let cursor:String?
        if result["nextCursor"] is NSNull { cursor=nil } else { guard let c=result["nextCursor"] as? String,!c.isEmpty,c.utf8.count<=256,!c.unicodeScalars.contains(where:{$0.value<32}) else { throw Failure.invalid };cursor=c }
        return MobileHealthInventoryPage(sources:sources,unboundEnrollments:pending,nextCursor:cursor)
    }
}
