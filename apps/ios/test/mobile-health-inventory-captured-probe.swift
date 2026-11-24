import Foundation
import AssistantCore
var root=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [String:Any]
func parse(_ key:String)throws->MobileHealthInventoryPage {
 let payload=root[key] as! [String:Any],result=payload["result"] as! [String:Any]
 return try MobileHealthInventory.parse(JSONSerialization.data(withJSONObject:payload),expectedPrincipal:UUID(uuidString:result["principalId"] as! String)!,expectedEndpoint:UUID(uuidString:result["endpointId"] as! String)!)
}
let fresh=try parse("freshDevice")
guard fresh.sources.count==1,fresh.sources[0].currentEnrollment==nil,fresh.unboundEnrollments.count==1,fresh.unboundEnrollments[0].collector=="healthKit",fresh.unboundEnrollments[0].revision==1 else{exit(2)}
print("fresh-device source choice and unbound enrollment parsed")
do { _ = try parse("boundDevice"); print("bound state unexpectedly accepted");exit(3) } catch { print("inconsistent bound state rejected") }

root=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[2]))) as! [String:Any]
let correctedFresh=try parse("freshDevice"),correctedBound=try parse("boundDevice")
guard correctedFresh.sources.count==1,correctedFresh.sources[0].currentEnrollment==nil,correctedFresh.unboundEnrollments.count==1,correctedFresh.unboundEnrollments[0].collector=="healthKit",correctedFresh.unboundEnrollments[0].revision==1,correctedBound.sources.count==1,correctedBound.sources[0].currentEnrollment != nil,correctedBound.sources[0].currentState=="disconnected",correctedBound.unboundEnrollments.isEmpty,correctedBound.sources[0].namespace==correctedFresh.sources[0].namespace else{exit(4)}
print("corrected fresh and disconnected bound inventories accepted")
