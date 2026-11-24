import Foundation

/// Source-only typed preparation. These values neither authorize collection
/// nor establish presence, identity, solitude, or a server wire format.
enum MobileLocationEvidence:Equatable {
 case position(latitude:Double,longitude:Double,accuracyMeters:Double,observedAt:Date)
 case regionTransition(regionId:String,entered:Bool,observedAt:Date)
 static func positionIfValid(latitude:Double,longitude:Double,accuracyMeters:Double,observedAt:Date)->Self? {
  guard latitude.isFinite,longitude.isFinite,accuracyMeters.isFinite,(-90...90).contains(latitude),(-180...180).contains(longitude),accuracyMeters>=0,observedAt.timeIntervalSinceReferenceDate.isFinite else{return nil}
  return .position(latitude:latitude,longitude:longitude,accuracyMeters:accuracyMeters,observedAt:observedAt)
 }
 static func regionIfValid(regionId:String,entered:Bool,observedAt:Date)->Self? {
  guard !regionId.isEmpty,regionId.utf8.count<=1024,observedAt.timeIntervalSinceReferenceDate.isFinite else{return nil}
  return .regionTransition(regionId:regionId,entered:entered,observedAt:observedAt)
 }
 var observedAt:Date {switch self{case .position(_,_,_,let time),.regionTransition(_,_,let time):return time}}
 /// Future clock values are unknown, not converted to fresh observations.
 func age(at now:Date)->TimeInterval? {let age=now.timeIntervalSince(observedAt);return age.isFinite && age>=0 ? age:nil}
}
struct MobileActivityEvidence:Equatable {
 enum Confidence:String {case unknown,low,medium,high}
 let activity:String,source:String,observedAt:Date,confidence:Confidence
 init?(activity:String,source:String,observedAt:Date,confidence:Confidence){guard !activity.isEmpty,activity.utf8.count<=128,!source.isEmpty,source.utf8.count<=256,observedAt.timeIntervalSinceReferenceDate.isFinite else{return nil};self.activity=activity;self.source=source;self.observedAt=observedAt;self.confidence=confidence}
 func age(at now:Date)->TimeInterval? {let age=now.timeIntervalSince(observedAt);return age.isFinite && age>=0 ? age:nil}
}
