import Foundation
import CryptoKit

/// Opaque values supplied by a trusted host adapter. No implementation here
/// constructs authority, identifies a human, or persists a receipt.
protocol SharedCaptureBinding: AnyObject {}
protocol SharedCaptureAttempt: AnyObject {}
protocol SharedCaptureReservation: AnyObject {}
protocol SharedCaptureReceipt: AnyObject {}

/// The host owns the source lifetime. Closing releases access only; it never
/// deletes the selected resource. No path or URL is resolved by this protocol.
protocol SharedCaptureReadLease: AnyObject {
    var originalSelectionContext:any SharedCaptureBinding {get}
    func check() throws
    /// nil is explicit EOF; empty non-EOF data is invalid.
    func read(maxBytes:Int) throws -> Data?
    func close()
}

enum SharedCaptureReconciliation {case absent, committed(any SharedCaptureReceipt), conflict, unavailable}
enum SharedCaptureReservationResult {case reserved(any SharedCaptureReservation, rawBudget:Int), held}
enum SharedCaptureCommitResult {case acknowledged(any SharedCaptureReceipt), unknown, held}

/// The actual owner must validate an independent Share policy and original
/// human/currentness. Its final commit must atomically recheck the exact lease,
/// reservation, binding, current policy and cancellation/expiry. No production
/// adapter is supplied by this source-only mechanics component.
protocol SharedCaptureOwner: AnyObject {
    func reconcile(attempt:any SharedCaptureAttempt,payloadDigest:String,item:MobileSharedItem.Value,context:any SharedCaptureBinding)throws->SharedCaptureReconciliation
    /// The owner quotes actual available raw bytes after accounting for the
    /// complete encoded legacy snapshot, metadata and Base64 overhead.
    func reserve(attempt:any SharedCaptureAttempt,payloadDigest:String,item:MobileSharedItem.Value,context:any SharedCaptureBinding)throws->SharedCaptureReservationResult
    func check(_ reservation:any SharedCaptureReservation)throws
    func commit(_ reservation:any SharedCaptureReservation,itemJSON:Data,capturedBytes:Data,integrity:[String:Any])throws->SharedCaptureCommitResult
    func abandon(_ reservation:any SharedCaptureReservation)
}

enum MobileSharedCapture {
    enum HeldReason {case invalidItem, unsupported, unavailable, conflict, capacity, source, integrity, owner}
    enum Outcome {case held(HeldReason), portAcknowledged(any SharedCaptureReceipt), commitUnknown(any SharedCaptureAttempt)}
    private static let maxRawBytes=8*1024*1024, chunkLimit=64*1024, maxReadCalls=4096
    /// `attempt` and lease binding are host-owned opaque identities. Recovery
    /// always precedes source access. Unknown commit must be reconciled by the
    /// same owner; this type maintains no ledger and never abandons afterward.
    static func capture(itemJSON:Data,attempt:any SharedCaptureAttempt,lease:any SharedCaptureReadLease,owner:(any SharedCaptureOwner)?)->Outcome {
        defer {lease.close()}
        guard let item=try? MobileSharedItem.decode(itemJSON) else{return .held(.invalidItem)}
        guard case .attachment(_,let artifact,_)=item.content else{return .held(.unsupported)}
        // Fix the exact decoder-retained JSON for this attempt; caller whitespace
        // and key order are not part of the frozen decoder's representation.
        let canonical=item.data.withUnsafeBytes{Data($0)},digest=SHA256.hash(data:canonical).map{String(format:"%02x",$0)}.joined()
        guard let owner else{return .held(.unavailable)}
        let context=lease.originalSelectionContext
        do {
            switch try owner.reconcile(attempt:attempt,payloadDigest:digest,item:item,context:context) {
            case .committed(let receipt):return .portAcknowledged(receipt)
            case .conflict:return .held(.conflict)
            case .unavailable:return .held(.unavailable)
            case .absent:break
            }
            let reservation:any SharedCaptureReservation, budget:Int
            switch try owner.reserve(attempt:attempt,payloadDigest:digest,item:item,context:context) {
            case .held:return .held(.unavailable)
            case .reserved(let r,let b):reservation=r;budget=b
            }
            guard budget>=0,budget<=maxRawBytes,artifact.byteLength<=budget,artifact.byteLength<=maxRawBytes else {owner.abandon(reservation);return .held(.capacity)}
            var captured=Data(),calls=0
            let integrity:[String:Any]
            do {
                while true {
                    guard calls<maxReadCalls else{throw ReadFailure.limit}
                    try lease.check();try owner.check(reservation)
                    let remaining=artifact.byteLength-captured.count,requested=min(chunkLimit,remaining+1)
                    let chunk=try lease.read(maxBytes:requested);calls += 1
                    try lease.check();try owner.check(reservation)
                    guard let chunk else {break}
                    guard !chunk.isEmpty,chunk.count<=requested,chunk.count<=remaining else{throw ReadFailure.invalid}
                    captured.append(chunk)
                }
                guard captured.count==artifact.byteLength,let checked=MobileSharedItem.verify(item,bytes:captured) else{owner.abandon(reservation);return .held(.integrity)}
                integrity=checked
                try lease.check();try owner.check(reservation)
            } catch {owner.abandon(reservation);return .held(.source)}
            // From the instant commit is invoked, even a thrown transport/error
            // is ambiguous: preserve the owner reservation and reconcile later.
            do {
                switch try owner.commit(reservation,itemJSON:canonical,capturedBytes:captured,integrity:integrity) {
                case .acknowledged(let receipt):return .portAcknowledged(receipt)
                case .unknown:return .commitUnknown(attempt)
                case .held:return .held(.owner)
                }
            } catch {return .commitUnknown(attempt)}
        } catch {return .held(.unavailable)}
    }
    private enum ReadFailure:Error {case limit,invalid}
}
