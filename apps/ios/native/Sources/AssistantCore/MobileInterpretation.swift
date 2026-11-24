import Foundation

/// Contract decoding only. Native authentication, currentness and dispatch are
/// independently owned by the unregistered native host.
public enum MobileInterpretation {
    public enum Failure: Error { case invalid }
    public enum Settlement { case applied(revision:Int), rejected, held }
    public struct Preview {
        public let original: Data
        fileprivate let payload: [String:Any]
        fileprivate let operationId: UUID
        public let nextRevision: Int
    }
    public struct ReadResult {
        public let state: String
        /// The validated response is returned for presentation, never logged here.
        public let response: Data
        public let preview: Preview?
    }
    private static let pin:[String:String] = ["schemaId":MobileInterpretationSchema.schemaId,"schemaVersion":"1.0.0","digest":MobileInterpretationSchema.digest]
    private static func object(_ data:Data, limit:Int=262144) throws -> [String:Any] {
        guard data.count<=limit, let value=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else{throw Failure.invalid};return value
    }
    private static func bytes(_ value:Any)throws->Data {try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes])}
    private static func same(_ a:Any,_ b:Any)->Bool { guard let x = try? bytes([a]), let y = try? bytes([b]) else { return false }; return x == y }
    private static func utc(_ value:Any?)->Date? {
        guard let s=value as? String,s.hasSuffix("Z") else{return nil};let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];if let d=f.date(from:s){return d};f.formatOptions=[.withInternetDateTime];return f.date(from:s)
    }
    private static func window(_ q:[String:Any])->Bool {guard let a=utc(q["startAt"]),let b=utc(q["endAt"]) else{return false};return b>a && b.timeIntervalSince(a)<=31*86400}
    private static func validSummary(_ s:[String:Any])->Bool {
        guard let sessions=s["sessions"] as? [[String:Any]] else{return false};var total=0.0, known=false
        for x in sessions {
            guard window(x),let start=utc(x["startAt"]),let end=utc(x["endAt"]),let stages=x["stageMs"] as? [String:Any] else{return false}
            let duration=end.timeIntervalSince(start)*1000
            for v in [x["inBedMs"],x["asleepMs"],x["awakeMs"],x["gapMs"]].compactMap({$0})+Array(stages.values) {
                if v is NSNull {continue};guard let n=v as? NSNumber,n.doubleValue<=duration else{return false}
            }
            if let n=x["asleepMs"] as? NSNumber {known=true;total += n.doubleValue}
        }
        if !known{return s["totalAsleepMs"] is NSNull};guard let n=s["totalAsleepMs"] as? NSNumber else{return false};return n.doubleValue==total
    }
    private static func pinResponse(_ data:Data)throws->[String:Any] {
        let root=try object(data);guard MobileInterpretationSchema.validate(root,definition:"MobileInterpretationResponse"),let actual=root["producerPin"] as? [String:String],actual==pin,let result=root["result"] as? [String:Any] else{throw Failure.invalid};return result
    }
    /// Encodes a schema-valid inspect/preview request. This grants no authority.
    public static func readEnvelope(payload:Data)throws->Data {
        let p=try object(payload,limit:65536);guard MobileInterpretationSchema.validate(p,definition:"MobileInterpretationRequest"),let operation=p["operation"] as? String,["inspect","preview"].contains(operation),let query=p["query"] as? [String:Any],window(query) else{throw Failure.invalid}
        if operation=="preview" {guard let source=MobileControlOriginal.number(p["expectedSourceRevision"],min:1,max:9007199254740990),let revision=MobileControlOriginal.number(p["expectedInterpretationRevision"],min:0,max:9007199254740990),source>0,revision>=0 else{throw Failure.invalid}}
        let data=try bytes(["producerPin":pin,"operation":"interpretation","payload":p]);guard data.count<=65536 else{throw Failure.invalid};return data
    }
    /// Expected request and owner scope must come from the authenticated host.
    public static func decodeRead(_ data:Data, expectedPayload:Data, principal:UUID, endpoint:UUID)throws->ReadResult {
        let expected=try object(expectedPayload,limit:65536);_ = try readEnvelope(payload:expectedPayload)
        let result=try pinResponse(data);guard let state=result["state"] as? String else{throw Failure.invalid}
        if state=="unavailable" || state=="incomplete" {return ReadResult(state:state,response:data,preview:nil)}
        guard let query=result["query"] as? [String:Any],let expectedQuery=expected["query"],same(query,expectedQuery),window(query),let target=result["target"] as? [String:Any],let scope=target["scope"] as? [String:Any],MobileControlOriginal.uuid(scope["principalId"])==principal,MobileControlOriginal.uuid(target["endpointId"])==endpoint,same(target["enrollmentId"]!,query["enrollmentId"]!),same(target["assistantId"]!,query["assistantId"]!),scope["collector"] as? String == "healthKit",let provenance=result["provenance"] as? [String:Any],let records=provenance["records"] as? [[String:Any]],Set(records.compactMap{$0["recordId"] as? String}).count==records.count else{throw Failure.invalid}
        if state=="inspected" {
            guard expected["operation"] as? String == "inspect",let summary=result["summary"] as? [String:Any],validSummary(summary),let candidates=result["candidates"] as? [[String:Any]],Set(candidates.compactMap{$0["choiceDigest"] as? String}).count==candidates.count else{throw Failure.invalid}
            return ReadResult(state:state,response:data,preview:nil)
        }
        guard state=="ready",expected["operation"] as? String == "preview",same(result["operationId"]!,expected["operationId"]!),same(result["change"]!,expected["change"]!),same(result["sourceRevision"]!,expected["expectedSourceRevision"]!),same(result["interpretationRevision"]!,expected["expectedInterpretationRevision"]!),let revision=MobileControlOriginal.number(result["interpretationRevision"],min:0,max:9007199254740990),MobileControlOriginal.number(result["nextInterpretationRevision"],min:1,max:9007199254740991)==revision+1,let before=result["before"] as? [String:Any],let after=result["after"] as? [String:Any],validSummary(before),validSummary(after),let raw=result["controlOriginal"],let original=try? bytes(raw),let request=try? MobileControlOriginal.parse(original),let action=(raw as? [String:Any])?["action"] as? [String:Any],action["kind"] as? String == "configure",request.principal==principal,request.endpoint==endpoint,request.operationId==MobileControlOriginal.uuid(result["operationId"]),let t=(raw as? [String:Any])?["target"] as? [String:Any],same(t["enrollmentId"]!,query["enrollmentId"]!),same(t["expectedRevision"]!,result["sourceRevision"]!),same(t["sourceNamespace"]!,scope["sourceNamespace"]!),same(t["collector"]!,scope["collector"]!),let config=action["configuration"] as? [String:Any],let ids=config["assistantIds"] as? [String],let assistant=query["assistantId"] as? String,ids.contains(assistant),let change=result["change"] as? [String:Any],let kind=change["kind"] as? String,["select","reverse"].contains(kind) else{throw Failure.invalid}
        var mutation:[String:Any]=["schemaVersion":"1.0.0","operation":kind=="reverse" ? "reverse":"apply","operationId":result["operationId"]!,"query":query,"expectedSourceRevision":result["sourceRevision"]!,"expectedInterpretationRevision":result["interpretationRevision"]!,"change":change,"reviewDigest":result["reviewDigest"]!,"controlOriginal":raw]
        guard MobileInterpretationSchema.validate(mutation,definition:"MobileInterpretationMutationRequest") else{throw Failure.invalid};mutation["controlOriginal"] = try JSONSerialization.jsonObject(with:request.canonical)
        return ReadResult(state:state,response:data,preview:Preview(original:request.canonical,payload:mutation,operationId:request.operationId,nextRevision:revision+1))
    }
    public static func reviewedEnvelope(preview:Preview, stagedOriginal:Data)throws->Data {
        guard let staged=try? MobileControlOriginal.parse(stagedOriginal),staged.canonical==preview.original else{throw Failure.invalid}
        let data=try bytes(["producerPin":pin,"operation":"interpretation","payload":preview.payload]);guard data.count<=65536 else{throw Failure.invalid};return data
    }
    public static func reconciliationEnvelope(original:Data)throws->Data {
        let request=try MobileControlOriginal.parse(original),raw=try JSONSerialization.jsonObject(with:request.canonical)
        guard let action=(raw as? [String:Any])?["action"] as? [String:Any],action["kind"] as? String == "configure" else{throw Failure.invalid}
        let payload:[String:Any]=["schemaVersion":"1.0.0","operation":"reconcile","controlOriginal":raw];guard MobileInterpretationSchema.validate(payload,definition:"MobileInterpretationReconcileRequest") else{throw Failure.invalid};return try bytes(["producerPin":pin,"operation":"interpretation","payload":payload])
    }
    /// Control settlement alone never proves the interpretation revision.
    public static func assessMutation(_ data:Data, original:Data, expectedRevision:Int? = nil)->Settlement {
        guard let r=try? pinResponse(data),r["state"] as? String == "mutation",let request=try? MobileControlOriginal.parse(original),MobileControlOriginal.uuid(r["operationId"])==request.operationId,let nested=r["controlResponse"],let nestedData=try? bytes(nested),nestedData.count<=65536,let status=r["interpretationStatus"] as? String else{return .held}
        let control=MobileControlReceipt.assess(expected:request.canonical,response:nestedData)
        if status=="applied",case .applied=control,let rev=MobileControlOriginal.number(r["interpretationRevision"],min:1,max:9007199254740991),expectedRevision == nil || expectedRevision==rev{return .applied(revision:rev)}
        if status=="rejected",r["interpretationRevision"] is NSNull,case .rejected=control{return .rejected}
        return .held
    }
}
