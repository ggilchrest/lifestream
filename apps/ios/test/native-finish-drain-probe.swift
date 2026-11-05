import Foundation
import AVFoundation
let format=AVAudioFormat(standardFormatWithSampleRate:16000,channels:1)!,capture=try! NativeCapture(inputFormat:format)
func buffer()->AVAudioPCMBuffer{let b=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:1600)!;b.frameLength=1600;for i in 0..<1600{b.floatChannelData![0][i]=0.08};return b}
var delivered=0,drained=false
capture.consume(buffer(),deliver:{_ in delivered += 1},failed:{_ in exit(2)})
capture.pauseAndDrain{
 guard delivered==1 else{exit(3)};drained=true;capture.resume()
 capture.consume(buffer(),deliver:{_ in guard drained,delivered==1 else{exit(4)};delivered += 1;print("ok");exit(0)},failed:{_ in exit(5)})
}
capture.consume(buffer(),deliver:{_ in exit(6)},failed:{_ in exit(7)})
DispatchQueue.main.asyncAfter(deadline:.now()+8){exit(8)};RunLoop.main.run()
