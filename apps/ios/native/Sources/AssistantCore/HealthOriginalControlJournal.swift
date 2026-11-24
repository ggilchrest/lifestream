import Foundation

/// Contract-only local custody. This type cannot dispatch or clear an entry.
/// Use an iOS ProtectedHealthFileStorage when a future host integrates it.
final class HealthOriginalControlJournal {
 enum Failure:Error {case invalid,unresolved,corrupt}
 struct Scope:Equatable {let serverDigest:String,principal:UUID,endpoint:UUID,session:UUID}
 enum Status {case none;case current(operationId:UUID,requestDigest:String);case heldElsewhere}
 private struct Record:Codable {let version:Int,schemaId:String,schemaDigest:String,serverDigest:String,principal:UUID,endpoint:UUID,session:UUID,original:Data,requestDigest:String}
 private static let lock=NSLock()
 private let storage:HealthSnapshotStorage
 init(storage:HealthSnapshotStorage){self.storage=storage}
 private func digestValid(_ s:String)->Bool{s.utf8.count==64 && s.utf8.allSatisfy{($0>=48 && $0<=57)||($0>=97 && $0<=102)}}
 private func read()throws->(Record,MobileControlOriginal.Request)? {
  guard let bytes=try storage.read() else{return nil}
  guard bytes.count<=100000,let r=try? JSONDecoder().decode(Record.self,from:bytes),r.version==1,r.schemaId==MobileControlOriginal.schemaId,r.schemaDigest==MobileControlOriginal.schemaSHA256,digestValid(r.serverDigest),let request=try? MobileControlOriginal.parse(r.original),request.canonical==r.original,request.digest==r.requestDigest,request.principal==r.principal,request.endpoint==r.endpoint else{throw Failure.corrupt}
  return (r,request)
 }
 func status(scope:Scope)throws->Status {
  Self.lock.lock();defer{Self.lock.unlock()};guard digestValid(scope.serverDigest) else{throw Failure.invalid};guard let (r,request)=try read() else{return .none}
  guard r.serverDigest==scope.serverDigest,r.principal==scope.principal,r.endpoint==scope.endpoint,r.session==scope.session else{return .heldElsewhere}
  return .current(operationId:request.operationId,requestDigest:request.digest)
 }
 /// Retrieval is limited to the exact stored server, owner, endpoint and session.
 func original(scope:Scope)throws->Data {
  Self.lock.lock();defer{Self.lock.unlock()};guard digestValid(scope.serverDigest),let (r,request)=try read(),r.serverDigest==scope.serverDigest,r.principal==scope.principal,r.endpoint==scope.endpoint,r.session==scope.session else{throw Failure.invalid}
  return request.canonical
 }
 /// Read-only reconciliation seam. A future native host MUST first verify a
 /// currently authenticated ordinary-self principal on the trusted server.
 /// This returns the unchanged original target and never authorizes dispatch,
 /// completion, policy restoration or journal clearing. Not wired to a host.
 func reconciliationOriginalAfterTrustedSelfCheck(serverDigest:String,principal:UUID)throws->Data {
  Self.lock.lock();defer{Self.lock.unlock()}
  guard digestValid(serverDigest),let (r,request)=try read(),r.serverDigest==serverDigest,r.principal==principal else{throw Failure.invalid}
  return request.canonical
 }
 /// Persist the entire immutable original request before a prospective dispatch.
 /// A successful write is not evidence that the server received or applied it.
 func prepare(scope:Scope,original:Data)throws {
  Self.lock.lock();defer{Self.lock.unlock()};guard digestValid(scope.serverDigest) else{throw Failure.invalid};let request=try MobileControlOriginal.parse(original)
  guard request.principal==scope.principal,request.endpoint==scope.endpoint else{throw Failure.invalid};guard try read()==nil else{throw Failure.unresolved}
  let r=Record(version:1,schemaId:MobileControlOriginal.schemaId,schemaDigest:MobileControlOriginal.schemaSHA256,serverDigest:scope.serverDigest,principal:scope.principal,endpoint:scope.endpoint,session:scope.session,original:request.canonical,requestDigest:request.digest)
  let encoder=JSONEncoder();encoder.outputFormatting=[.sortedKeys];try storage.replace(encoder.encode(r))
 }
}
