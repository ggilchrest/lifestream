import Foundation

/// Local pre-dispatch fence. An entry means the outcome is unconfirmed, even if
/// the process stopped before the request left the device. No health values or
/// request body are stored. Clearing requires a future authoritative outcome
/// contract and is intentionally unavailable here. This preliminary fence
/// lacks the complete original request and must not be used for dispatch.
final class HealthControlJournal {
 public enum Operation:String,Codable {case enroll,bindSource,configure,remove}
 public struct Scope:Equatable {
  public let serverDigest:String,principal:UUID,endpoint:UUID
  public init(serverDigest:String,principal:UUID,endpoint:UUID){self.serverDigest=serverDigest;self.principal=principal;self.endpoint=endpoint}
 }
 public enum Status:Equatable {case none;case current(Operation);case heldElsewhere}
 public enum Failure:Error {case invalid,unresolved,corrupt}
 private struct Record:Codable {
  let version:Int,serverDigest:String,principal:UUID,endpoint:UUID,session:UUID,operation:Operation,enrollment:UUID?,revision:Int?,nonce:UUID
 }
 private static let lock=NSLock()
 private let storage:HealthSnapshotStorage
 public init(storage:HealthSnapshotStorage){self.storage=storage}
 private func validDigest(_ s:String)->Bool {s.utf8.count==64 && s.utf8.allSatisfy{($0>=48 && $0<=57)||($0>=97 && $0<=102)}}
 private func read()throws->Record? {
  guard let bytes=try storage.read() else{return nil};guard bytes.count<=4096,let r=try? JSONDecoder().decode(Record.self,from:bytes),r.version==1,validDigest(r.serverDigest),((r.operation == .enroll && r.enrollment == nil && r.revision == nil)||(r.operation != .enroll && r.enrollment != nil && (1...9007199254740991).contains(r.revision ?? 0))) else{throw Failure.corrupt};return r
 }
 public func status(scope:Scope)throws->Status {
  Self.lock.lock();defer{Self.lock.unlock()};guard validDigest(scope.serverDigest) else{throw Failure.invalid};guard let r=try read() else{return .none}
  guard r.serverDigest==scope.serverDigest,r.principal==scope.principal,r.endpoint==scope.endpoint else{return .heldElsewhere};return .current(r.operation)
 }
 /// This must succeed durably before a caller may dispatch. The nonce is local
 /// fencing metadata, not a server operation ID or an idempotency guarantee.
 public func prepare(scope:Scope,session:UUID,operation:Operation,enrollment:UUID?,revision:Int?)throws->UUID {
  Self.lock.lock();defer{Self.lock.unlock()};guard validDigest(scope.serverDigest),((operation == .enroll && enrollment == nil && revision == nil)||(operation != .enroll && enrollment != nil && (1...9007199254740991).contains(revision ?? 0))) else{throw Failure.invalid}
  guard try read()==nil else{throw Failure.unresolved};let nonce=UUID(),r=Record(version:1,serverDigest:scope.serverDigest,principal:scope.principal,endpoint:scope.endpoint,session:session,operation:operation,enrollment:enrollment,revision:revision,nonce:nonce)
  let encoder=JSONEncoder();encoder.outputFormatting=[.sortedKeys];try storage.replace(encoder.encode(r));return nonce
 }
}
