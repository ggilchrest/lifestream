import Foundation
import AssistantCore
let config=(try! JSONSerialization.jsonObject(with:Data(readLine()!.utf8))) as! [String:Any],endpoint=config["endpoint"] as! String,count=config["count"] as! Int
final class ProbeStore:ConnectionStore{var value:SavedConnection?;func load()throws->SavedConnection?{value};func save(_ value:SavedConnection)throws{self.value=value}}
let transport=NativeTransport(store:ProbeStore())
func output(_ value:[String:Any]){print(String(data:try! JSONSerialization.data(withJSONObject:value),encoding:.utf8)!);exit(0)}
try! transport.configure(endpoint)
func run(){
for _ in 0..<count {transport.request("/api/runtime/v1/audience",timeout:15){_ in}}
DispatchQueue.main.asyncAfter(deadline:.now()+0.25){let began=ProcessInfo.processInfo.systemUptime;transport.request("/api/runtime/v1/audience/lease",method:"POST",body:"{}",timeout:1.2){result in
 let elapsed=Int((ProcessInfo.processInfo.systemUptime-began)*1000);switch result{case .success(_,let response):output(["status":response.statusCode,"elapsedMs":elapsed]);case .failure(let error):let ns=error as NSError;output(["timedOut":ns.domain==NSURLErrorDomain && ns.code==NSURLErrorTimedOut,"elapsedMs":elapsed])}
}}
}
var socket:URLSessionWebSocketTask?
if config["socket"] as? Bool == true {socket=try! transport.webSocket();transport.socketOpened={_ in run()};socket!.resume()}else{run()}
DispatchQueue.main.asyncAfter(deadline:.now()+8){exit(2)};RunLoop.main.run()
