import Foundation

/// Pure preparation only. A future host must verify current authenticated scope,
/// apply these restrictions before dispatch, and report failed persistence.
/// This cannot widen access, send requests, or acknowledge a mutation.
enum MobileHealthLocalRestriction {
 enum Failure:Error {case invalidScope,unsupported}
 struct Plan:Equatable {let stopCollection:Bool;let keepCategories:Set<String>;let keepHealthKitTypes:Set<String>;let keepUses:Set<String>;let keepAssistants:Set<String>}
 static func plan(original:Data,proof:MobileHealthPolicyProof)throws->Plan {
  let request=try MobileControlOriginal.parse(original)
  guard request.principal==proof.principal,request.endpoint==proof.endpoint,let raw=try JSONSerialization.jsonObject(with:request.canonical) as? [String:Any],let target=raw["target"] as? [String:Any],target["collector"] as? String == "healthKit",MobileControlOriginal.uuid(target["enrollmentId"])==proof.enrollment,MobileControlOriginal.uuid(target["sourceNamespace"])?.uuidString.lowercased()==proof.sourceNamespace,MobileControlOriginal.number(target["expectedRevision"],min:1,max:9007199254740991)==proof.revision,let action=raw["action"] as? [String:Any],let kind=action["kind"] as? String else{throw Failure.invalidScope}
  if kind=="remove" {return Plan(stopCollection:true,keepCategories:[],keepHealthKitTypes:[],keepUses:[],keepAssistants:[])}
  guard kind=="configure",let state=action["state"] as? String,let c=action["configuration"] as? [String:Any],let categories=c["categories"] as? [String],let uses=c["uses"] as? [String],let assistants=c["assistantIds"] as? [String],let collection=c["collectionPaused"] as? Bool,let use=c["usePaused"] as? Bool else{throw Failure.unsupported}
  let proposed=Set(categories.compactMap{$0=="SleepSegment" ? "sleep" : ["heartRate","restingHeartRate","respiratoryRate","hrvSDNN"].contains($0) ? $0 : nil})
  let keepCategories=proof.categories.intersection(categories),types=proof.healthKitTypes.intersection(proposed),stop=state != "active" || collection || !proof.permitsCollection || types.isEmpty
  return Plan(stopCollection:stop,keepCategories:keepCategories,keepHealthKitTypes:stop ? []:types,keepUses:use || proof.usePaused ? []:proof.uses.intersection(uses),keepAssistants:proof.assistants.intersection(assistants))
 }
}
