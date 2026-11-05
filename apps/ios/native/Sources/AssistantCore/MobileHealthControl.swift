import Foundation
/// Builds explicit owner controls; does not send, retry, or infer outcomes.
public enum MobileHealthControl {
 public enum Failure:Error {case invalid}
 public enum Binding {case createNew;case existing(UUID)}
 public enum State:String {case active,disconnected,unbound}
 public struct Configuration {
  public let categories:Set<String>,uses:Set<String>,assistants:Set<UUID>
  public let collectionPaused:Bool,usePaused:Bool,preferredSource:String?
  public init(categories:Set<String>,uses:Set<String>,assistants:Set<UUID>,collectionPaused:Bool,usePaused:Bool,preferredSource:String?=nil){self.categories=categories;self.uses=uses;self.assistants=assistants;self.collectionPaused=collectionPaused;self.usePaused=usePaused;self.preferredSource=preferredSource}
  fileprivate func object()throws->[String:Any]{
   let allowedCategories:Set<String>=["SleepSegment","heartRate","restingHeartRate","respiratoryRate","hrvSDNN","hrvRMSSD"],allowedUses:Set<String>=["answers","summaries","memory","proactive"]
   guard categories.isSubset(of:allowedCategories),uses.isSubset(of:allowedUses),assistants.count<=32 else{throw Failure.invalid}
   var r:[String:Any]=["categories":categories.sorted(),"uses":uses.sorted(),"assistantIds":assistants.map{$0.uuidString.lowercased()}.sorted(),"collectionPaused":collectionPaused,"usePaused":usePaused]
   if let preferredSource {guard !preferredSource.isEmpty,preferredSource.unicodeScalars.count<=1024 else{throw Failure.invalid};r["preferredSource"]=preferredSource};return r
  }
 }
 private static func envelope(_ operation:String,_ payload:[String:Any])throws->Data{let b=try JSONSerialization.data(withJSONObject:["producerPin":["schemaId":MobileHealthEncoder.schemaId,"schemaVersion":"1.0.0","digest":MobileHealthEncoder.schemaSHA256],"operation":operation,"payload":payload],options:[.sortedKeys]);guard b.count<=65536 else{throw Failure.invalid};return b}
 private static func base(_ enrollment:UUID,_ revision:Int)throws->[String:Any]{guard revision>=1,revision<=9007199254740991 else{throw Failure.invalid};return ["enrollmentId":enrollment.uuidString.lowercased(),"expectedRevision":revision]}
 public static func enrollHealthKit()throws->Data{try envelope("enroll",["collector":"healthKit"])}
 public static func bind(enrollment:UUID,revision:Int,binding:Binding)throws->Data{var p=try base(enrollment,revision);switch binding{case .createNew:p["binding"]=["createNew":true];case .existing(let source):p["binding"]=["sourceNamespace":source.uuidString.lowercased()]};return try envelope("bindSource",p)}
 public static func configure(enrollment:UUID,revision:Int,state:State,configuration:Configuration)throws->Data{var p=try base(enrollment,revision);p["state"]=state.rawValue;p["configuration"]=try configuration.object();return try envelope("configure",p)}
 public static func removeAllImported(enrollment:UUID,revision:Int)throws->Data{try envelope("remove",base(enrollment,revision))}
}
