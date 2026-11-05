import Foundation
import CoreFoundation
import CryptoKit

/// Contract-only validation and durable custody; neither dispatch nor receipt clearing is implemented.
enum MobileControlOriginal {
 static let schemaId="https://lifestream.dev/contracts/mobile-context-control/1.0.0"
 static let schemaSHA256="fb854a621ce9fa2985047ded9ebeea6c094b108563e761fef431b02eec5853e3"
 enum Failure:Error {case invalid}
 struct Request {let canonical:Data,digest:String,principal:UUID,endpoint:UUID,operationId:UUID}
 static func keys(_ d:[String:Any],_ required:Set<String>,_ optional:Set<String>=[])->Bool {required.isSubset(of:Set(d.keys)) && Set(d.keys).isSubset(of:required.union(optional))}
 static func uuid(_ v:Any?)->UUID? {guard let s=v as? String,let u=UUID(uuidString:s),u.uuidString.lowercased()==s else{return nil};return u}
 static func sharedUUID(_ v:String)->Bool {v.range(of:"^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$",options:[.regularExpression,.caseInsensitive]) != nil}
 static func number(_ v:Any?,min:Int,max:Int)->Int? {guard let n=v as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue.rounded()==n.doubleValue,n.doubleValue>=Double(min),n.doubleValue<=Double(max) else{return nil};return n.intValue}
 static func boolean(_ v:Any?)->Bool {guard let n=v as? NSNumber else{return false};return CFGetTypeID(n)==CFBooleanGetTypeID()}
 /// Contract-only encoding of the same immutable original for control or
 /// read-only reconciliation. This function performs no I/O or dispatch.
 static func envelope(_ request:Request,reconciliation:Bool)throws->Data {
  guard let original=try? JSONSerialization.jsonObject(with:request.canonical),let verified=try? parse(request.canonical),verified.digest==request.digest,verified.canonical==request.canonical else{throw Failure.invalid}
  let object:[String:Any]=["producerPin":["schemaId":schemaId,"schemaVersion":"1.0.0","digest":schemaSHA256],"operation":reconciliation ? "reconcileControl":"control","payload":original]
  let bytes=try JSONSerialization.data(withJSONObject:object,options:[.sortedKeys,.withoutEscapingSlashes]);guard bytes.count<=65536 else{throw Failure.invalid};return bytes
 }
 private static func items(_ v:Any?,_ allowed:Set<String>,_ limit:Int)->Bool {guard let a=v as? [String],a.count<=limit,Set(a).count==a.count else{return false};return Set(a).isSubset(of:allowed)}
 static func configuration(_ v:Any?)->Bool {
  guard let c=v as? [String:Any],keys(c,["categories","uses","assistantIds","collectionPaused","usePaused"],["preferredSource"]),items(c["categories"],["SleepSegment","heartRate","restingHeartRate","respiratoryRate","hrvSDNN","hrvRMSSD"],6),items(c["uses"],["answers","summaries","memory","proactive"],4),let ids=c["assistantIds"] as? [String],ids.count<=32,Set(ids).count==ids.count,ids.allSatisfy({sharedUUID($0)}),boolean(c["collectionPaused"]),boolean(c["usePaused"]) else{return false}
  if let preferred=c["preferredSource"] {guard let text=preferred as? String,!text.isEmpty,text.unicodeScalars.count<=1024 else{return false}}
  return true
 }
 static func parse(_ bytes:Data)throws->Request {
  guard bytes.count<=65536,let d=try? JSONSerialization.jsonObject(with:bytes) as? [String:Any],keys(d,["schemaVersion","operationId","target","action"]),d["schemaVersion"] as? String == "1.0.0",let op=uuid(d["operationId"]),let t=d["target"] as? [String:Any],keys(t,["principalId","endpointId","collector","enrollmentId","sourceNamespace","expectedRevision"]),let principal=uuid(t["principalId"]),let endpoint=uuid(t["endpointId"]),let collector=t["collector"] as? String,["healthKit","healthConnect"].contains(collector),let revision=number(t["expectedRevision"],min:0,max:9007199254740991),let a=d["action"] as? [String:Any],let kind=a["kind"] as? String else{throw Failure.invalid}
  let enrollment=uuid(t["enrollmentId"]),source=uuid(t["sourceNamespace"]);guard t["enrollmentId"] is NSNull || enrollment != nil,t["sourceNamespace"] is NSNull || source != nil else{throw Failure.invalid}
  switch kind {
  case "enroll":guard keys(a,["kind"]),enrollment==nil,source==nil,revision==0 else{throw Failure.invalid}
  case "bindSource":
   guard keys(a,["kind","binding"]),enrollment != nil,source==nil,revision>=1,let b=a["binding"] as? [String:Any] else{throw Failure.invalid}
   if keys(b,["createNew"]) {guard boolean(b["createNew"]),(b["createNew"] as? NSNumber)?.boolValue==true else{throw Failure.invalid}}
   else {guard keys(b,["sourceNamespace","expectedSourceRevision"]),uuid(b["sourceNamespace"]) != nil,number(b["expectedSourceRevision"],min:1,max:9007199254740991) != nil else{throw Failure.invalid}}
  case "configure":guard keys(a,["kind","state","configuration"]),enrollment != nil,source != nil,revision>=1,revision<9007199254740991,let state=a["state"] as? String,["active","disconnected"].contains(state),configuration(a["configuration"]) else{throw Failure.invalid}
  case "remove":guard keys(a,["kind","scope"]),a["scope"] as? String == "wholeSource",enrollment != nil,source != nil,revision>=1,revision<9007199254740991 else{throw Failure.invalid}
  default:throw Failure.invalid
  }
  let canonical=try JSONSerialization.data(withJSONObject:d,options:[.sortedKeys,.withoutEscapingSlashes]);guard canonical.count<=65536 else{throw Failure.invalid}
  return Request(canonical:canonical,digest:SHA256.hash(data:canonical).map{String(format:"%02x",$0)}.joined(),principal:principal,endpoint:endpoint,operationId:op)
 }
}
