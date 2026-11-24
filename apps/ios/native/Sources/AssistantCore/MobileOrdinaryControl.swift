import Foundation
import CryptoKit

private final class OrdinaryControlBundleAnchor {}

/// Pinned ordinary-control adjunct. Parsing never establishes authenticated
/// origin, current policy, the independent witness, or an exclusivity lease.
public enum MobileOrdinaryControl {
    public enum Operation: String { case control, reconcile }
    public enum Settlement: Equatable { case applied, rejected, held }
    public enum Failure: Error { case invalid }
    public static let schemaId = "https://lifestream.dev/contracts/mobile-context-control-settlement/1.0.0"
    public static let schemaDigest = "7819f41352b0c298c29a26c9e3939f9967b7bddf029ee008e4d6562fe3c8ebf4"
    private static let pin = ["schemaId": schemaId, "schemaVersion": "1.0.0", "digest": schemaDigest]
    private static let schemaAvailable: Bool = {
        // Bundle.module traps if the generated resource bundle is missing. Look
        // it up safely so an incomplete package fails closed instead of crashing.
        let candidates = [Bundle.main.resourceURL, Bundle(for: OrdinaryControlBundleAnchor.self).resourceURL, Bundle.main.bundleURL]
        let bundle = candidates.compactMap { $0?.appendingPathComponent("AssistantCore_AssistantCore.bundle") }.compactMap { Bundle(url: $0) }.first
        guard let url = bundle?.url(forResource: "mobile-context-control-settlement.schema", withExtension: "json"),
              let bytes = try? Data(contentsOf: url), bytes.count <= 262144,
              hash(bytes) == schemaDigest,
              let schema = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { return false }
        return schema["$id"] as? String == schemaId
    }()
    private static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func canonical(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) }
    private static func keys(_ object: [String: Any], _ expected: Set<String>) -> Bool { Set(object.keys) == expected }
    private static func validCollector(_ value: String) -> Bool {
        value.utf8.elementsEqual("healthKit".utf8) || value.utf8.elementsEqual("healthConnect".utf8)
    }
    private static func hex(_ value: Any?) -> String? {
        guard let value = value as? String, value.utf8.count == 64,
              value.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
        return value
    }
    private static func request(_ original: Data) throws -> MobileControlOriginal.Request {
        let value = try MobileControlOriginal.parse(original)
        guard let object = try JSONSerialization.jsonObject(with: value.canonical) as? [String: Any],
              let target = object["target"] as? [String: Any], let collector = target["collector"] as? String,
              validCollector(collector),
              let action = object["action"] as? [String: Any],
              let kind = action["kind"] as? String, ["enroll", "bindSource", "configure"].contains(kind) else { throw Failure.invalid }
        return value
    }
    public enum Kind:String {case enroll,bindSource,configure}
    /// Immutable validated original, not authenticated origin or a custody grant.
    public struct Original {
        public let canonical:Data,digest:String,operationID:UUID,principal:UUID,endpoint:UUID
        public let collector:String,enrollment:UUID?,namespace:UUID?,expectedRevision:Int,kind:Kind
    }
    public struct Terminal {
        public let original:Original,response:Data,settlement:Settlement,identity:String,currentness:String
    }
    public static func original(_ bytes:Data)throws->Original {
        let parsed=try request(bytes)
        guard parsed.canonical==bytes,let object=try JSONSerialization.jsonObject(with:bytes) as? [String:Any],
              let target=object["target"] as? [String:Any],let action=object["action"] as? [String:Any],
              let kind=Kind(rawValue:action["kind"] as? String ?? ""),let collector=target["collector"] as? String,
              let revision=target["expectedRevision"] as? NSNumber else{throw Failure.invalid}
        return Original(canonical:parsed.canonical,digest:parsed.digest,operationID:parsed.operationId,principal:parsed.principal,endpoint:parsed.endpoint,collector:collector,enrollment:(target["enrollmentId"] as? String).flatMap(UUID.init(uuidString:)),namespace:(target["sourceNamespace"] as? String).flatMap(UUID.init(uuidString:)),expectedRevision:revision.intValue,kind:kind)
    }
    public static func terminalValue(response:Data,original bytes:Data)throws->Terminal {
        let value=try terminal(response:response,original:bytes),original=try original(bytes)
        guard let root=try JSONSerialization.jsonObject(with:response) as? [String:Any],let result=root["result"] as? [String:Any],
              let control=result["control"] as? [String:Any],let outcome=control["result"] as? [String:Any],
              let current=outcome["current"] as? [String:Any],let state=current["state"] as? String else{throw Failure.invalid}
        return Terminal(original:original,response:response,settlement:value.0,identity:value.1,currentness:state)
    }
    /// A qualified settings receipt remains history, never effective policy.
    public struct HealthConfiguration {
        public let terminal:Terminal,principal:UUID,endpoint:UUID,enrollment:UUID,namespace:UUID
        public let expectedRemoteRevision:Int,revision:Int,state:String,categories:Set<String>
        public let collectionPaused:Bool
    }
    public static func healthConfiguration(_ value:Terminal)throws->HealthConfiguration {
        guard value.settlement == .applied,value.currentness=="current",value.original.kind == .configure,
              value.original.collector=="healthKit",try terminalIdentity(response:value.response,original:value.original.canonical)==value.identity,
              let root=try JSONSerialization.jsonObject(with:value.response) as? [String:Any],let result=root["result"] as? [String:Any],
              let control=result["control"] as? [String:Any],let outcome=control["result"] as? [String:Any],let receipt=outcome["receipt"] as? [String:Any],
              let applied=receipt["result"] as? [String:Any],let row=applied["enrollment"] as? [String:Any],let configuration=row["configuration"] as? [String:Any],
              let principal=(row["principalId"] as? String).flatMap(UUID.init(uuidString:)),let endpoint=(row["endpointId"] as? String).flatMap(UUID.init(uuidString:)),
              let enrollment=(row["enrollmentId"] as? String).flatMap(UUID.init(uuidString:)),let namespace=(row["sourceNamespace"] as? String).flatMap(UUID.init(uuidString:)),
              let revision=MobileControlOriginal.number(row["revision"],min:1,max:9007199254740991),let state=row["state"] as? String,
              let categories=configuration["categories"] as? [String],let paused=configuration["collectionPaused"] as? Bool,
              principal==value.original.principal,endpoint==value.original.endpoint,enrollment==value.original.enrollment,namespace==value.original.namespace,
              revision==value.original.expectedRevision+1 else{throw Failure.invalid}
        return .init(terminal:value,principal:principal,endpoint:endpoint,enrollment:enrollment,namespace:namespace,expectedRemoteRevision:value.original.expectedRevision,revision:revision,state:state,categories:Set(categories),collectionPaused:paused)
    }
    public static func envelope(original: Data, operation: Operation) throws -> Data {
        guard schemaAvailable else { throw Failure.invalid }
        let parsed = try request(original)
        let payload = try JSONSerialization.jsonObject(with: parsed.canonical)
        let bytes = try canonical(["producerPin": pin, "operation": operation.rawValue, "payload": payload])
        guard bytes.count <= 131072 else { throw Failure.invalid }; return bytes
    }
    private static func terminal(response: Data, original: Data) throws -> (Settlement, String) {
        guard schemaAvailable, response.count <= 524288, let expected = try? request(original),
              let root = try? JSONSerialization.jsonObject(with: response) as? [String: Any],
              keys(root, ["schemaVersion", "producerPin", "result"]), root["schemaVersion"] as? String == "1.0.0",
              let actualPin = root["producerPin"] as? [String: String], actualPin == pin,
              let result = root["result"] as? [String: Any], result["kind"] as? String == "terminal",
              keys(result, ["kind", "binding", "control"]), let binding = result["binding"] as? [String: Any],
              binding["family"] as? String == "ordinaryControl", let reservation = hex(binding["reservationDigest"]),
              hex(binding["terminalDigest"]) != nil, let control = result["control"] as? [String: Any],
              let outcome = control["result"] as? [String: Any], let status = outcome["status"] as? String,
              let requestDigest = outcome["requestDigest"] as? String, requestDigest == expected.digest,
              let receipt = outcome["receipt"] as? [String: Any], let rawOriginal = outcome["originalRequest"],
              let originalBytes = try? canonical(rawOriginal), originalBytes == expected.canonical else { throw Failure.invalid }
        let settlement: Settlement
        if status == "applied" {
            guard keys(binding, ["family", "reservationDigest", "terminalDigest", "preparedDigest"]), hex(binding["preparedDigest"]) != nil else { throw Failure.invalid }
            guard let applied = receipt["result"] as? [String: Any], let enrollment = applied["enrollment"] as? [String: Any],
                  let collector = enrollment["collector"] as? String, validCollector(collector),
                  let expectedObject = try? JSONSerialization.jsonObject(with: expected.canonical) as? [String: Any],
                  let target = expectedObject["target"] as? [String: Any], let expectedCollector = target["collector"] as? String,
                  collector.utf8.elementsEqual(expectedCollector.utf8) else { throw Failure.invalid }
            settlement = .applied
        } else if status == "rejected" {
            guard keys(binding, ["family", "reservationDigest", "terminalDigest"]) else { throw Failure.invalid }
            settlement = .rejected
        } else { throw Failure.invalid }
        let projection: [String: Any] = ["requestDigest": expected.digest, "state": "pending", "attemptStarted": 0, "selection": NSNull(), "outcome": NSNull()]
        guard hash(try canonical(projection)) == reservation else { throw Failure.invalid }
        let nested = try canonical(control)
        switch (settlement, MobileControlReceipt.assess(expected: expected.canonical, response: nested)) {
        case (.applied, .applied), (.rejected, .rejected): break
        default: throw Failure.invalid
        }
        let identity: [String: Any] = ["producerPin": pin, "binding": binding, "original": rawOriginal, "requestDigest": requestDigest, "status": status, "receipt": receipt]
        return (settlement, hash(try canonical(identity)))
    }
    public static func assessTerminal(response: Data, original: Data) -> Settlement { (try? terminal(response: response, original: original).0) ?? .held }
    public static func terminalIdentity(response: Data, original: Data) throws -> String { try terminal(response: response, original: original).1 }
}
