import Foundation

/// Separate selected-delivery producer. Selection narrows original authority;
/// only the original native SDK path can qualify what was actually read.
/// Frozen implemented producer manifest e8ea5501 (source-only qualification).
public enum MobileCalendarSelectedDelivery {
    public enum Contract:Equatable {case settingsScoped,selected}
    public static let schemaID="https://lifestream.dev/contracts/mobile-context-calendar-selected-delivery/1.0.0"
    public static let schemaDigest="27688770ff658204fac6198f17b6d8e09b482d33bc1abf282cafac751f59fc35"
    public static var pin:[String:String]{["schemaId":schemaID,"schemaVersion":"1.0.0","digest":schemaDigest]}
    public static func batch(_ items:[MobileCalendarDelivery.Item],run:MobileCalendarSettingsWire.Run)throws->Data{
        // Reuse the immutable original item and existing scoped-run validator.
        let scoped=try MobileCalendarSettingsWire.object(MobileCalendarSettingsWire.batch(items,run:run))
        guard var payload=scoped["payload"] as? [String:Any] else{throw MobileCalendarSettingsWire.Failure.invalid}
        payload["selection"]=try MobileCalendarSettingsWire.object(run.selection.canonical)
        return try MobileCalendarDelivery.canonical(["producerPin":pin,"operation":"ingestSelected","payload":payload])
    }
    /// Parser-only compatibility buffer; callers retain the ACTUAL new-pin raw
    /// response separately through settlement/uncertainty. No response rewrite at
    /// the network seam, no terminal/control/authority inferred by this adapter.
    public static func originalReceiptEnvelope(_ bytes:Data,expected:[MobileCalendarDelivery.Item])throws->Data{
        let root=try MobileCalendarSettingsWire.object(bytes)
        guard MobileCalendarSettingsWire.keys(root,["schemaVersion","producerPin","result"]),root["schemaVersion"] as? String=="1.0.0",root["producerPin"] as? [String:String]==pin,let result=root["result"] as? [String:Any],MobileCalendarSettingsWire.keys(result,["kind","receipts"]),result["kind"] as? String=="sync" else{throw MobileCalendarSettingsWire.Failure.invalid}
        let original=try MobileCalendarDelivery.canonical(["schemaVersion":"1.0.0","producerPin":["schemaId":MobileCalendarDelivery.schemaId,"schemaVersion":"1.0.0","digest":MobileCalendarDelivery.schemaDigest],"result":result])
        _ = try MobileCalendarDelivery.receipts(original,expected:expected);return original
    }
}
