import Foundation

/// Strict local adapter for the producer-owned mobile-context wire contract.
public enum MobileHealthWire {
    public enum Failure: Error { case invalidRequest, invalidResponse }
    public static let path="/api/runtime/v1/mobile-context"
    private static var pin:[String:String] { ["schemaId":MobileHealthEncoder.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthEncoder.schemaSHA256] }
    public static func request(batch: Data) throws -> Data {
        guard let payload=try? JSONSerialization.jsonObject(with:batch) as? [String:Any],payload["schemaVersion"] as? String == "1.0.0",payload["changes"] is [[String:Any]] else { throw Failure.invalidRequest }
        let bytes=try JSONSerialization.data(withJSONObject:["producerPin":pin,"operation":"ingest","payload":payload],options:[.sortedKeys])
        guard bytes.count <= 65536 else { throw Failure.invalidRequest };return bytes
    }
    public static func policyRequest(enrollment:UUID) throws -> Data {
        let bytes=try JSONSerialization.data(withJSONObject:["producerPin":pin,"operation":"policy","payload":["enrollmentId":enrollment.uuidString.lowercased()]],options:[.sortedKeys])
        guard bytes.count<=65536 else { throw Failure.invalidRequest };return bytes
    }
    /// Parse without emitting response content into logs. Any ambiguity leaves the queue intact.
    public static func receipt(_ data:Data) throws -> [HealthDeliveryResult] {
        guard data.count <= 65536,let object=try? JSONSerialization.jsonObject(with:data) as? [String:Any],Set(object.keys)==Set(["schemaVersion","producerPin","result"]),object["schemaVersion"] as? String == "1.0.0",let actual=object["producerPin"] as? [String:String],actual==pin,let items=object["result"] as? [[String:Any]],!items.isEmpty,items.count<=64 else { throw Failure.invalidResponse }
        return try items.map { item in
            guard Set(item.keys)==Set(["eventId","outcome","code"]),let text=item["eventId"] as? String,let id=UUID(uuidString:text),id.uuidString.lowercased()==text,let raw=item["outcome"] as? String,let code=item["code"] as? String else { throw Failure.invalidResponse }
            let outcome:HealthDeliveryResult.Outcome
            switch (raw,code) {
            case ("accepted","applied"),("accepted","deleted"):outcome = .accepted
            case ("duplicate","applied"),("duplicate","deleted"):outcome = .duplicate
            case ("retryable","unavailable"):outcome = .retryable
            case ("rejected","invalid"),("rejected","scope"),("rejected","settingsChanged"),("rejected","suppressed"),("rejected","conflict"),("rejected","quota"):outcome = .rejected
            default: throw Failure.invalidResponse
            }
            guard let parsedCode=HealthDeliveryCode(rawValue:code) else { throw Failure.invalidResponse }
            return HealthDeliveryResult(eventId:id,outcome:outcome,code:parsedCode)
        }
    }
}
