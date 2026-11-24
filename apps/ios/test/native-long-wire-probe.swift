import Foundation
import AssistantCore
func fixture(name:String,voicedWindows:Int,silenceWindows:Int,residual:Int,finish:Bool)->[String:Any]{
 var gate=SpeechGate(),frames=[[String:Any]](),events=[String](),sequence=0,offset=0,commits=[[String:Int]]()
 func append(_ result:[SpeechGate.Event]){for e in result{switch e{
 case .began:events.append("began")
 case .frame(let bytes):frames.append(["sequence":sequence,"sampleOffset":offset,"sampleCount":bytes.count/2,"dataBase64":bytes.base64EncodedString()]);offset += bytes.count/2;sequence += 1
 case .commit(let n,let samples):commits.append(["nextSequence":n,"sampleCount":samples]);events.append("commit")
 case .overflow:events.append("overflow")
 }}}
 for _ in 0..<voicedWindows{append(gate.push(Array(repeating:0.08,count:320)))}
 for _ in 0..<silenceWindows{append(gate.push(Array(repeating:0,count:320)))}
 if residual>0{append(gate.push(Array(repeating:0.08,count:residual)))}
 if finish{append(gate.finish())}
 return ["name":name,"frames":frames,"events":events,"commits":commits,"totalSamples":offset]
}
let all=[fixture(name:"natural31",voicedWindows:1550,silenceWindows:30,residual:0,finish:false),fixture(name:"finish31",voicedWindows:1550,silenceWindows:0,residual:123,finish:true),fixture(name:"exact90",voicedWindows:4470,silenceWindows:30,residual:0,finish:false),fixture(name:"overflow90",voicedWindows:4501,silenceWindows:0,residual:0,finish:false)]
let data=try! JSONSerialization.data(withJSONObject:all,options:.sortedKeys);FileHandle.standardOutput.write(data)
