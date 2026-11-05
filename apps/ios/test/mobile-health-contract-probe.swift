import Foundation
let start=Date(timeIntervalSince1970:1790000000),enrollment=UUID(uuidString:"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")!
func make(_ category:String,_ quantity:Double? = nil,_ unit:String? = nil,_ native:Int = 4,_ end:Double = 3600)throws->HealthChange {
 let sample=NativeHealthObservation(upstreamId:"synthetic",category:category,start:start,end:start.addingTimeInterval(end),nativeSleep:category == "sleep" ? HealthSleepValue(nativeValue:native):nil,quantity:quantity,unit:unit,sourceBundle:"example.fixture",sourceVersion:"1",deviceName:nil,deviceModel:"fixture",sourceTimeZone:"America/Chicago")
 return HealthChange(upstreamId:"synthetic",operation:.upsert,body:try JSONEncoder().encode(sample),collectedAt:start,expectedPolicyRevision:7,mappingVersion:"healthkit-v1")
}
var cases:[[String:Any]]=[]
for (category,change) in [("sleep",try make("sleep",nil,nil,901)),("heartRate",try make("heartRate",72,"bpm",0,0)),("respiratoryRate",try make("respiratoryRate",13,"breathsPerMinute")),("hrvSDNN",try make("hrvSDNN",45,"ms",0,0)),("sleep",HealthChange(upstreamId:"synthetic",operation:.delete,body:nil,collectedAt:start,expectedPolicyRevision:7,mappingVersion:"healthkit-v1"))] {
 let batch=try MobileHealthEncoder.batch([change],enrollment:enrollment,sourceNamespace:"synthetic-source",category:category)
 cases.append(try JSONSerialization.jsonObject(with:batch.data) as! [String:Any])
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject:cases,options:[.sortedKeys]))
