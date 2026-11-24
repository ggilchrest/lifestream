import Foundation
import AssistantCore
@main struct Probe {
 static func main() async throws {
  let session=URLSession(configuration:.ephemeral),socket=session.webSocketTask(with:URL(string:CommandLine.arguments[1])!);socket.resume()
  var state=OrderedVoiceInput();_ = state.commit();_ = state.commit();var order=[String](),texts=[String]()
  let gap=CommandLine.arguments.count>2 && CommandLine.arguments[2]=="gap"
  for _ in 0..<(gap ? 5 : 8) {
   let msg=try await socket.receive();let raw:Data
   switch msg {case .string(let s):raw=Data(s.utf8);case .data(let d):raw=d;@unknown default:fatalError("unexpected")}
   guard let event=try JSONSerialization.jsonObject(with:raw) as? [String:Any] else{fatalError("invalid JSON")}
   if event["type"] as? String == "transcript" {guard let final=OrderedVoiceFinal(message:event),state.acceptFinal(sequence:final.inputSequence,revision:final.revision) else{fatalError("bad final")};texts.append(final.text);order.append("final:\(final.inputSequence)")}
   if event["type"] as? String == "inputSettled" {guard let n=event["inputSequence"] as? Int,let committed=event["transcriptCommitted"] as? Bool,committed ? state.isResolved(n) : state.settleWithoutFinal(sequence:n) else{fatalError("bad settled")};order.append("settled:\(n)")}
  }
  if gap { guard texts.count==1,order == ["settled:1","final:2","settled:2"] else{fatalError("incorrect gap order")} }
  else {guard texts == ["Synthetic earlier Voynich context","What do you think?"],order == ["final:1","settled:1","final:2","settled:2"] else{fatalError("incorrect order")}}
  socket.cancel(with:.normalClosure,reason:nil);session.invalidateAndCancel();print("Foundation URLSessionWebSocketTask decoded actual server fixture through production decoder and sequence state")
 }
}
