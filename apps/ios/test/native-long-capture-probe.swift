import Foundation
import AVFoundation
import AssistantCore
let format=AVAudioFormat(standardFormatWithSampleRate:48000,channels:1)!
let capture=try! NativeCapture(inputFormat:format)
var gate=SpeechGate(),index=0,begins=0,frames=0,samples=0,commits=0
func next(){
 if index==317 {guard begins==1,commits==1,samples>480_000 else{exit(2)};print("synthetic 48k capture -> converter -> gate: begins=\(begins) commits=\(commits) frames=\(frames) samples=\(samples)");exit(0)}
 let buffer=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:4800)!;buffer.frameLength=4800
 let value:Float=index<310 ? 0.08:0;for i in 0..<4800{buffer.floatChannelData![0][i]=value};index += 1
 capture.consume(buffer,deliver:{values in
  for event in gate.push(values){switch event{case .began:begins += 1;case .frame(let bytes):frames += 1;samples += bytes.count/2;case .commit(let n,let total):guard n==frames,total==samples else{exit(3)};commits += 1;case .overflow:exit(4)}}
  DispatchQueue.main.async{next()}
 },failed:{_ in exit(5)})
}
DispatchQueue.main.async{next()};DispatchQueue.main.asyncAfter(deadline:.now()+20){exit(6)};RunLoop.main.run()
