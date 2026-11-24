import Foundation
import CoreFoundation

/// Parsed producer policy is evidence of server response, never sufficient alone for user enrollment.
public struct MobileHealthPolicyProof {
    public let enrollment: UUID
    public let principal: UUID
    public let endpoint: UUID
    public let sourceNamespace: String?
    public let revision: Int
    public let state: String
    public let sourceBound: Bool
    public let collectionAllowed: Bool
    public let categories: Set<String>
    public let uses: Set<String>
    public let assistants: Set<String>
    public let collectionPaused: Bool
    public let usePaused: Bool
    public var permitsCollection: Bool { state == "active" && sourceBound && collectionAllowed && !collectionPaused && sourceNamespace != nil }
    /// HealthKit cannot collect RMSSD via SDNN; unsupported categories are never substituted.
    public var healthKitTypes: Set<String> { Set(categories.compactMap { $0 == "SleepSegment" ? "sleep" : ["heartRate","restingHeartRate","respiratoryRate","hrvSDNN"].contains($0) ? $0 : nil }) }
}

public enum MobileHealthPolicyParser {
    public enum Failure: Error { case invalid }
    private static let categorySet:Set<String> = ["SleepSegment","heartRate","restingHeartRate","respiratoryRate","hrvSDNN","hrvRMSSD"]
    private static let useSet:Set<String> = ["answers","summaries","memory","proactive"]
    private static func keys(_ value:[String:Any],required:Set<String>,optional:Set<String> = []) -> Bool { required.isSubset(of:Set(value.keys)) && Set(value.keys).isSubset(of:required.union(optional)) }
    private static func uuid(_ value:Any?) -> UUID? { guard let s=value as? String,let id=UUID(uuidString:s),id.uuidString.lowercased()==s.lowercased() else{return nil};return id }
    private static func boolean(_ value:Any?) -> Bool? { guard let n=value as? NSNumber,CFGetTypeID(n)==CFBooleanGetTypeID() else{return nil};return n.boolValue }
    private static func revision(_ value:Any?) -> Int? { guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue >= 1,n.doubleValue <= 9007199254740991,n.doubleValue.rounded()==n.doubleValue else{return nil};return n.intValue }
    private static func strings(_ value:Any?,allowed:Set<String>,max:Int) -> Set<String>? { guard let a=value as? [String],a.count<=max,Set(a).count==a.count,Set(a).isSubset(of:allowed) else{return nil};return Set(a) }
    private static func ids(_ value:Any?) -> Set<String>? { guard let a=value as? [String],a.count<=32,Set(a).count==a.count,a.allSatisfy({$0.range(of:"^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$",options:[.regularExpression,.caseInsensitive]) != nil}) else{return nil};return Set(a) }
    private static func namespace(_ value:Any?) -> String? { guard let u=uuid(value) else{return nil};return u.uuidString.lowercased() }
    public static func parse(_ data:Data, expectedPrincipal:UUID, expectedEndpoint:UUID, expectedEnrollment:UUID) throws -> MobileHealthPolicyProof {
        guard data.count<=65536,let root=try? JSONSerialization.jsonObject(with:data) as? [String:Any],keys(root,required:["schemaVersion","producerPin","result"]),root["schemaVersion"] as? String == "1.0.0",
              let pin=root["producerPin"] as? [String:String],pin == ["schemaId":MobileHealthEncoder.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthEncoder.schemaSHA256],
              let result=root["result"] as? [String:Any],keys(result,required:["enrollment","effective"]),let e=result["enrollment"] as? [String:Any],let f=result["effective"] as? [String:Any],
              keys(e,required:["enrollmentId","principalId","endpointId","collector","sourceNamespace","revision","state","configuration"]),keys(f,required:["policyRevision","sourceBound","collectionAllowed","categories","uses","assistantIds","sourceNamespace"]),
              let enrollment=uuid(e["enrollmentId"]),enrollment==expectedEnrollment,let principal=uuid(e["principalId"]),principal==expectedPrincipal,let endpoint=uuid(e["endpointId"]),endpoint==expectedEndpoint,e["collector"] as? String == "healthKit",
              let rev=revision(e["revision"]),rev==revision(f["policyRevision"]),let state=e["state"] as? String,["unbound","active","disconnected"].contains(state),
              let config=e["configuration"] as? [String:Any],keys(config,required:["categories","uses","assistantIds","collectionPaused","usePaused"],optional:["preferredSource"]),
              let cc=strings(config["categories"],allowed:categorySet,max:6),let cu=strings(config["uses"],allowed:useSet,max:4),let ca=ids(config["assistantIds"]),let paused=boolean(config["collectionPaused"]),let usePaused=boolean(config["usePaused"]),
              let cats=strings(f["categories"],allowed:categorySet,max:6),cats.isSubset(of:cc),let uses=strings(f["uses"],allowed:useSet,max:4),uses.isSubset(of:cu),let assistants=ids(f["assistantIds"]),assistants.isSubset(of:ca),
              let bound=boolean(f["sourceBound"]),let allowed=boolean(f["collectionAllowed"]) else { throw Failure.invalid }
        if let preferred=config["preferredSource"] { guard let p=preferred as? String,!p.isEmpty,p.unicodeScalars.count<=1024 else{throw Failure.invalid} }
        let eNS=namespace(e["sourceNamespace"]),fNS=namespace(f["sourceNamespace"])
        guard (e["sourceNamespace"] is NSNull || eNS != nil),(f["sourceNamespace"] is NSNull || fNS != nil),eNS==fNS,
              (bound == (eNS != nil)),((state == "unbound") == (eNS == nil)),(!allowed || (bound && state == "active" && !paused)) else{throw Failure.invalid}
        return MobileHealthPolicyProof(enrollment:enrollment,principal:principal,endpoint:endpoint,sourceNamespace:eNS,revision:rev,state:state,sourceBound:bound,collectionAllowed:allowed,categories:cats,uses:uses,assistants:assistants,collectionPaused:paused,usePaused:usePaused)
    }
}
