import Foundation

/// Local preparation only; no provider access, producer schema or transport.
/// All-day events are date ranges, not midnight instants.
struct MobileCalendarDate: Equatable,Comparable {
 let year:Int,month:Int,day:Int
 init?(_ text:String) {
  guard text.utf8.count==10,text.range(of:"^[0-9]{4}-[0-9]{2}-[0-9]{2}$",options:.regularExpression) != nil else{return nil}
  let parts=text.split(separator:"-").compactMap{Int($0)};guard parts.count==3,(1...9999).contains(parts[0]),(1...12).contains(parts[1]) else{return nil}
  let leap=parts[0]%4==0 && (parts[0]%100 != 0 || parts[0]%400==0),days=[31,leap ? 29:28,31,30,31,30,31,31,30,31,30,31];guard (1...days[parts[1]-1]).contains(parts[2]) else{return nil}
  year=parts[0];month=parts[1];day=parts[2]
 }
 var text:String {String(format:"%04d-%02d-%02d",year,month,day)}
 static func <(a:Self,b:Self)->Bool {(a.year,a.month,a.day)<(b.year,b.month,b.day)}
}
struct MobileCalendarAllDayRange:Equatable {
 let start:MobileCalendarDate,endExclusive:MobileCalendarDate
 init?(start:String,endExclusive:String){guard let a=MobileCalendarDate(start),let b=MobileCalendarDate(endExclusive),a<b else{return nil};self.start=a;self.endExclusive=b}
}
/// Preserve unknown separately; never create a timezone from device defaults.
enum MobileSourceTimeZone:Equatable {
 case unknown
 case supplied(String)
 init?(supplied value:String?) {guard let value else{self = .unknown;return};guard !value.isEmpty,TimeZone(identifier:value) != nil else{return nil};self = .supplied(value)}
}
