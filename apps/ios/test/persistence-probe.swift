import Foundation
import AssistantCore
// Test adapter proves transport persistence across executable launches; production uses Keychain.
final class FileConnectionStore: ConnectionStore {
 let path:URL
 init(_ path:String){self.path=URL(fileURLWithPath:path)}
 func load() throws -> SavedConnection? {guard FileManager.default.fileExists(atPath:path.path) else{return nil};return try JSONDecoder().decode(SavedConnection.self,from:Data(contentsOf:path))}
 func save(_ value:SavedConnection) throws {try JSONEncoder().encode(value).write(to:path,options:.atomic)}
}
let input=(try! JSONSerialization.jsonObject(with:Data(readLine()!.utf8))) as! [String:String]
let transport=NativeTransport(store:FileConnectionStore(input["storePath"]!))
func request(_ path:String,_ body:[String:Any]?=nil) async throws -> Int {
 let encoded=try body.map{String(data:try JSONSerialization.data(withJSONObject:$0),encoding:.utf8)!}
 let (_,response)=try await withCheckedThrowingContinuation {(c:CheckedContinuation<(Data,HTTPURLResponse),Error>) in transport.request(path,method:body==nil ? "GET":"POST",body:encoded){c.resume(with:$0)}}
 return response.statusCode
}
Task { @MainActor in
 do {
  var status=0,restored:[String:Any]=[:]
  if input["mode"]=="signin" {try transport.configure(input["endpoint"]!,username:"ios-fixture");var body:[String:Any]=["username":"ios-fixture","password":input["password"]!];if let totp=input["totp"]{body["totp"]=totp};status=try await request("/api/auth/v1/sign-in",body)}
  else {let result=try await withCheckedThrowingContinuation{(c:CheckedContinuation<NativeTransport.RestoredConnection,Error>) in transport.restoreSession{c.resume(with:$0)}};restored=result.payload;status=result.authState=="authenticated" ? 200:0}
  if input["mode"]=="signout"{_ = try await request("/api/auth/v1/sign-out",[:]);try transport.forgetSession()}
  if input["mode"]=="change"{try transport.configure(input["endpoint"]!,username:"other")}
  let saved=try FileConnectionStore(input["storePath"]!).load()
  let result:[String:Any]=["status":status,"saved":saved != nil,"endpoint":saved?.endpoint ?? "","username":saved?.username ?? "","hasSession":saved?.hasSession ?? false,"hasSavedCredentials":saved?.hasSavedCredentials ?? false,"csrfAvailable": !transport.csrf.isEmpty,"restored":restored]
  print(String(data:try JSONSerialization.data(withJSONObject:result),encoding:.utf8)!);exit(0)
 }catch{fputs("Persistence probe failed: \(error)\n",stderr);exit(1)}
}
DispatchQueue.main.asyncAfter(deadline:.now()+25){exit(2)}
RunLoop.main.run()
