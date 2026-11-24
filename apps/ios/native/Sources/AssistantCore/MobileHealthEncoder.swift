import Foundation

/// Consumer of the server-owned mobile-context/1.0.0 schema; no authority derives from these fields.
/// Every batch is encoded once from protected queued records, not logged or captured in diagnostics.
public enum MobileHealthEncoder {
    public static let schemaId = "https://lifestream.dev/contracts/mobile-context/1.0.0"
    public static let schemaSHA256 = "67ed5d813f35f5f62f209e3ce5b3d3bd050df5b3604eb72d91d9e5e368063dd2"
    // NativeTransport accepts at most 64 KiB; this is stricter than the schema maximum.
    public static let transportBatchBytes = 65000
    public enum Failure: Error, Equatable { case invalid, oversized }
    public struct Batch { public let data: Data; public let eventIds: [UUID] }
    private static func timestamp(_ date: Date) throws -> String {
        guard date.timeIntervalSince1970.isFinite else { throw Failure.invalid }
        let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];f.timeZone=TimeZone(secondsFromGMT:0)
        return f.string(from:date)
    }
    private static func bounded(_ value: String?, max: Int) throws -> String? {
        guard let value, !value.isEmpty else { return nil }
        guard value.utf8.count <= max, !value.unicodeScalars.contains(where:{$0.value < 32}) else { throw Failure.invalid }
        return value
    }
    private static func recordType(_ category: String) throws -> String {
        switch category { case "sleep":return "SleepSegment";case "heartRate","restingHeartRate","respiratoryRate","hrvSDNN":return "HealthMeasurement";default:throw Failure.invalid }
    }
    /// `category` must be the same enabled source type used to acquire the collection ticket.
    private static func change(_ queued: HealthChange, enrollment: UUID, sourceNamespace: String, category: String) throws -> [String:Any] {
        let kind=try recordType(category),enrollmentId=enrollment.uuidString.lowercased(),namespace=try bounded(sourceNamespace,max:256),upstream=try bounded(queued.upstreamId,max:256)
        guard let upstream, let namespace, (0...9007199254740991).contains(queued.expectedPolicyRevision), let mapping=try bounded(queued.mappingVersion,max:64) else { throw Failure.invalid }
        var source:[String:Any]=["collector":"healthKit","namespace":namespace,"upstreamId":upstream]
        var result:[String:Any]=["schemaVersion":"1.0.0","eventId":queued.eventId.uuidString.lowercased(),"enrollmentId":enrollmentId,"expectedPolicyRevision":queued.expectedPolicyRevision,"source":source,"collectedAt":try timestamp(queued.collectedAt),"mappingVersion":mapping,"operation":queued.operation.rawValue,"recordType":kind]
        if queued.operation == .delete { guard queued.body == nil else { throw Failure.invalid };return result }
        guard let bytes=queued.body, let sample=try? JSONDecoder().decode(NativeHealthObservation.self,from:bytes),sample.upstreamId == upstream,sample.category == category else { throw Failure.invalid }
        guard let bundle=try bounded(sample.sourceBundle,max:256) else { throw Failure.invalid };source["originalApp"]=bundle
        if let version=try bounded(sample.sourceVersion,max:128){source["originalAppVersion"]=version}
        if let device=try bounded(sample.deviceName,max:256){source["originalDevice"]=device}
        if let model=try bounded(sample.deviceModel,max:128){source["originalDeviceModel"]=model}
        result["source"]=source
        let start=try timestamp(sample.start),end=try timestamp(sample.end)
        guard sample.end >= sample.start else { throw Failure.invalid }
        var record:[String:Any]=["schemaVersion":"1.0.0","startAt":start]
        if let zone=try bounded(sample.sourceTimeZone,max:128){guard TimeZone(identifier:zone) != nil else { throw Failure.invalid };record["timeZone"]=zone}
        if kind == "SleepSegment" {
            guard sample.end > sample.start, let sleep=sample.nativeSleep, HealthSleepValue(nativeValue:sleep.nativeValue).stage == sleep.stage, sample.quantity == nil, sample.unit == nil else { throw Failure.invalid }
            record["endAt"]=end;record["stage"]=sleep.stage.rawValue;record["classification"]="unknown"
            if sleep.stage == .unknown { record["nativeValue"]=String(sleep.nativeValue) }
        } else {
            guard sample.nativeSleep == nil, let value=sample.quantity,value.isFinite,value >= 0,value <= 1000000 else { throw Failure.invalid }
            let unit:String
            switch category {
            case "heartRate","restingHeartRate":guard sample.unit == "bpm" else { throw Failure.invalid };unit="beatsPerMinute"
            case "respiratoryRate":guard sample.unit == "breathsPerMinute" else { throw Failure.invalid };unit="breathsPerMinute"
            case "hrvSDNN":guard sample.unit == "ms" else { throw Failure.invalid };unit="milliseconds"
            default:throw Failure.invalid
            }
            record["measure"]=category;record["unit"]=unit;record["value"]=value;record["origin"]="unknown";record["coverage"]="unknown"
            if sample.end == sample.start { record["representation"]="point" } else { record["representation"]="interval";record["endAt"]=end }
        }
        result["record"]=record;return result
    }
    /// Batches are bounded by the producing contract's count and encoded bytes.
    /// A single unencodable or oversized record must be quarantined by the caller.
    public static func batch(_ queue: [HealthChange], enrollment: UUID, sourceNamespace: String, category: String) throws -> Batch {
        guard !queue.isEmpty else { throw Failure.invalid }
        var changes=[[String:Any]](),ids=[UUID](),last=Data()
        for item in queue.prefix(64) {
            guard !ids.contains(item.eventId) else { throw Failure.invalid }
            let next=try change(item,enrollment:enrollment,sourceNamespace:sourceNamespace,category:category)
            let data=try JSONSerialization.data(withJSONObject:["schemaVersion":"1.0.0","changes":changes+[next]],options:[.sortedKeys])
            if data.count > transportBatchBytes { if changes.isEmpty { throw Failure.oversized };break }
            changes.append(next);ids.append(item.eventId);last=data
        }
        return Batch(data:last,eventIds:ids)
    }
}
