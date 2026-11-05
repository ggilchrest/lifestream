import Foundation

/// Contract-only assessment. It cannot clear the journal or grant a policy.
enum MobileControlReceipt {
 enum Settlement {case applied,rejected,held}
 private static let core=MobileControlOriginal.self
 private static func canonical(_ x:Any)->Data? {try? JSONSerialization.data(withJSONObject:x,options:[.sortedKeys,.withoutEscapingSlashes])}
 private static func date(_ x:Any?)->Bool {guard let s=x as? String else{return false};let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];if f.date(from:s) != nil{return true};f.formatOptions=[.withInternetDateTime];return f.date(from:s) != nil}
 static func assess(expected:Data,response:Data)->Settlement {
  guard response.count<=262144,let expected=try? core.parse(expected),let root=try? JSONSerialization.jsonObject(with:response) as? [String:Any],core.keys(root,["schemaVersion","producerPin","result"]),root["schemaVersion"] as? String == "1.0.0",let pin=root["producerPin"] as? [String:String],pin==["schemaId":core.schemaId,"schemaVersion":"1.0.0","digest":core.schemaSHA256],let result=root["result"] as? [String:Any],let raw=result["originalRequest"],let rawData=canonical(raw),let original=try? core.parse(rawData),original.canonical==expected.canonical,result["requestDigest"] as? String == expected.digest,let current=result["current"] as? [String:Any],core.keys(current,["state","policyRevision"]),let currentState=current["state"] as? String,["current","settingsChanged","unavailable"].contains(currentState) else{return .held}
  let currentRev=core.number(current["policyRevision"],min:1,max:9007199254740991);guard (currentState=="unavailable" && current["policyRevision"] is NSNull)||(currentState != "unavailable" && currentRev != nil) else{return .held}
  guard let status=result["status"] as? String else{return .held};if status=="pending" || status=="unknown" {return .held}
  guard core.keys(result,["originalRequest","requestDigest","current","status","receipt"]),let receipt=result["receipt"] as? [String:Any],core.uuid(receipt["receiptId"]) != nil,date(receipt["committedAt"]),receipt["durability"] as? String == "sqlCommit" else{return .held}
  if status=="rejected" {guard core.keys(receipt,["receiptId","committedAt","durability","effects","code"]),receipt["effects"] as? String == "none",let code=receipt["code"] as? String,["settingsChanged","scope","quota","conflict"].contains(code) else{return .held};return .rejected}
  guard status=="applied",core.keys(receipt,["receiptId","committedAt","durability","result"]),let applied=receipt["result"] as? [String:Any],let object=raw as? [String:Any],let target=object["target"] as? [String:Any],let action=object["action"] as? [String:Any],let kind=action["kind"] as? String,applied["kind"] as? String == kind,let e=applied["enrollment"] as? [String:Any],core.keys(e,["enrollmentId","principalId","endpointId","collector","sourceNamespace","revision","state","configuration"]),let eid=core.uuid(e["enrollmentId"]),core.uuid(e["principalId"])==expected.principal,core.uuid(e["endpointId"])==expected.endpoint,e["collector"] as? String == target["collector"] as? String,let rev=core.number(e["revision"],min:1,max:9007199254740991),let state=e["state"] as? String,["unbound","active","disconnected"].contains(state),core.configuration(e["configuration"]) else{return .held}
  let ns=core.uuid(e["sourceNamespace"]);guard (e["sourceNamespace"] is NSNull || ns != nil),(state=="unbound") == (ns==nil),(currentState != "current" || currentRev==rev),let targetRev=core.number(target["expectedRevision"],min:0,max:9007199254740991) else{return .held}
  if let targetId=core.uuid(target["enrollmentId"]),targetId != eid{return .held}
  switch kind {
  case "enroll":guard core.keys(applied,["kind","enrollment"]) else{return .held}
  case "bindSource":
   guard core.keys(applied,["kind","enrollment"]),state=="disconnected",ns != nil,let binding=action["binding"] as? [String:Any] else{return .held}
   if let selected=core.uuid(binding["sourceNamespace"]) {guard ns==selected,rev==core.number(binding["expectedSourceRevision"],min:1,max:9007199254740991) else{return .held}} else if rev != targetRev{return .held}
  case "configure":guard core.keys(applied,["kind","enrollment"]),ns==core.uuid(target["sourceNamespace"]),rev==targetRev+1,state==action["state"] as? String,canonical(e["configuration"]!)==canonical(action["configuration"]!) else{return .held}
  case "remove":
   guard core.keys(applied,["kind","scope","enrollment","removedCount","suppressionEpoch","suppressionCommitted"]),applied["scope"] as? String == "wholeSource",ns==core.uuid(target["sourceNamespace"]),rev==targetRev+1,let count=core.number(applied["removedCount"],min:0,max:9007199254740991),let epoch=core.number(applied["suppressionEpoch"],min:0,max:9007199254740991),core.boolean(applied["suppressionCommitted"]),(applied["suppressionCommitted"] as? NSNumber)?.boolValue==true,(count==0 || epoch>0) else{return .held}
  default:return .held
  }
  return .applied
 }
}
