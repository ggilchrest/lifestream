// Compiles the actual NativeTransport against Foundation on macOS. No AVAudioEngine claim.
import Foundation
import AssistantCore
let configuration=(try! JSONSerialization.jsonObject(with:Data(readLine()!.utf8))) as! [String:String]
final class TestConnectionStore:ConnectionStore {var value:SavedConnection?;func load() throws -> SavedConnection?{value};func save(_ value:SavedConnection) throws{self.value=value}}
let transport=NativeTransport(store:TestConnectionStore())
func request(_ path:String,_ body:[String:Any]?=nil) async throws -> [String:Any] {
 let encoded=try body.map{String(data:try JSONSerialization.data(withJSONObject:$0),encoding:.utf8)!}
 let (bytes,response)=try await withCheckedThrowingContinuation { (c:CheckedContinuation<(Data,HTTPURLResponse),Error>) in
  transport.request(path,method:body==nil ? "GET":"POST",body:encoded){c.resume(with:$0)}
 }
 guard response.statusCode==200,let json=try JSONSerialization.jsonObject(with:bytes) as? [String:Any] else{throw VoiceError.invalidMessage};return json
}
Task { @MainActor in
 do {
  try transport.configure(configuration["endpoint"]!)
  let signed=try await request("/api/auth/v1/sign-in",["username":"ios-fixture","password":configuration["password"]!])
  guard let session=signed["session"] as? [String:Any],let sessionId=session["sessionId"] as? String,!transport.csrf.isEmpty else{throw VoiceError.invalidMessage}
  let context=try await request("/api/runtime/v1/session-context",["expectedRevision":0,"bindingKey":UUID().uuidString.lowercased(),"endpointClass":"personalCompanion","mode":"audio","audienceScope":"authenticatedSession"])
  let audience=try await request("/api/runtime/v1/audience",["mode":"solo","seconds":300]);_ = try AudienceLease(audience,now:Date())
  do { _ = try await request("/api/runtime/v1/presentation/resources/synthetic-model/model.gltf"); throw VoiceError.invalidMessage }
  catch VoiceError.invalidEndpoint { /* Assets are bundled, never fetched by native transport. */ }
  let ws=try transport.webSocket(),inputId=UUID().uuidString.lowercased()
  let start:[String:Any]=["type":"start","request":["schemaVersion":"1.0.0","requestId":UUID().uuidString.lowercased(),"correlationId":UUID().uuidString.lowercased(),"sessionId":sessionId,"endpointId":(context["endpoint"] as! [String:Any])["endpointId"]!,"expectedSessionRevision":context["revision"]!,"audioInputId":inputId,"assistantId":configuration["assistantId"]!,"format":["encoding":"pcm_s16le","sampleRateHz":16000,"channels":1]]]
  func send(_ message:[String:Any]) async throws {try await ws.send(.string(String(data:try JSONSerialization.data(withJSONObject:message),encoding:.utf8)!))}
  try await withCheckedThrowingContinuation { (c:CheckedContinuation<Void,Error>) in
   transport.socketOpened={task in guard task===ws else{return};c.resume()};ws.resume()
  }
  try await send(start)
  var reply=ReplyStream(),chunks=0,transcript=false,text=false,done=false
  while !done {
   let raw=try await ws.receive();let bytes:Data;switch raw{case .string(let s):bytes=Data(s.utf8);case .data(let d):bytes=d;@unknown default:throw VoiceError.invalidMessage}
   let m=try JSONSerialization.jsonObject(with:bytes) as! [String:Any],type=m["type"] as! String
   if type=="error"{throw VoiceError.invalidMessage}
   if type=="accepted" {
    for i in 0..<10 {try await send(["type":"frame","audioInputId":inputId,"frame":["frameId":UUID().uuidString.lowercased(),"sequence":i,"sampleOffset":i*1600,"sampleCount":1600,"dataBase64":Data(repeating:16,count:3200).base64EncodedString(),"format":["encoding":"pcm_s16le","sampleRateHz":16000,"channels":1]]])}
    try await send(["type":"commitTurn","audioInputId":inputId,"nextSequence":10,"sampleCount":16000])
   }
   if type=="turnStarted"{try reply.begin(m["interactionTraceId"] as! String)}
   if type=="transcript"{transcript=true}
   if type=="audio" {
    let chunk=m["chunk"] as! [String:Any],frame=chunk["frame"] as! [String:Any]
    try reply.accept(trace:m["interactionTraceId"] as! String,segment:chunk["segmentId"] as! String,sequence:frame["sequence"] as! Int,offset:frame["sampleOffset"] as! Int,count:frame["sampleCount"] as! Int,bytes:Data(base64Encoded:frame["dataBase64"] as! String)!,queuedSamples:0);chunks += 1
   }
   if type=="response",let event=m["event"] as? [String:Any],let payload=event["payload"] as? [String:Any] {
    if payload["type"] as? String=="textDelta"{text=true}
    if payload["type"] as? String=="terminal" {
     guard payload["state"] as? String=="completed",transcript,text,chunks>0 else{throw VoiceError.invalidMessage}
     try reply.finish(reply.trace!);try await send(["type":"playbackSettled","interactionTraceId":reply.trace!,"outcome":"completed","receivedSamples":reply.totalSamples]);done=true
    }
   }
  }
  ws.cancel(with:.normalClosure,reason:nil)
  _=try await request("/api/auth/v1/sign-out",[:])
  print("{\"nativeTransport\":\"pass\",\"fixtureAudioChunks\":\(chunks),\"fixtureSamples\":\(reply.totalSamples),\"physicalPlayback\":false}")
  exit(0)
 }catch{fputs("Native transport contract failed: \(error)\n",stderr);exit(1)}
}
DispatchQueue.main.asyncAfter(deadline:.now()+40){fputs("Native transport timed out\n",stderr);exit(2)}
RunLoop.main.run()
