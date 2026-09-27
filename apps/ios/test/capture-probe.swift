// Synthetic PCM only. Does not construct AVAudioEngine or activate a microphone.
import AVFoundation
import Foundation

func check(_ condition:@autoclosure()->Bool,_ message:String){if !condition(){fputs("Capture probe failed: \(message)\n",stderr);exit(1)}}
func buffer(_ frames:AVAudioFrameCount,format:AVAudioFormat)->AVAudioPCMBuffer {
    let value=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:max(1,frames))!;value.frameLength=frames
    if frames>0 {for index in 0..<Int(frames){value.floatChannelData![0][index]=Float(sin(Double(index)*0.05)*0.1)}}
    return value
}
let format=AVAudioFormat(commonFormat:.pcmFormatFloat32,sampleRate:48000,channels:1,interleaved:false)!
let capture=try NativeCapture(inputFormat:format)
check(capture.bufferSize==4800,"tap requests100ms at48k")
let before=ProcessInfo.processInfo.systemUptime
var firstDelivered=false
capture.consume(buffer(4800,format:format),deliver:{samples in
    check(Thread.isMainThread,"success callback on main")
    check(!samples.isEmpty&&samples.allSatisfy{$0.isFinite},"48k converts to finite PCM")
    firstDelivered=true
},failed:{_ in check(false,"valid capture unexpectedly failed")})
capture.consume(buffer(0,format:format),deliver:{_ in check(false,"empty callback produced samples")},failed:{_ in check(false,"empty callback failed")})
let first=capture.snapshot()
check(first.rawBuffers==2&&first.convertedBuffers==1,"raw and converted counters distinguish empty callback")
check(first.lastRaw != nil&&first.lastConverted != nil,"timestamps exist")
check(first.lastRaw!>=before&&first.lastConverted!>=before,"timestamps use monotonic system uptime")
check(first.sampleRate==48000&&first.channels==1,"observed format included")

// Saturate the old graph before its main callbacks drain, then replace it.
// Old completions must release the old helper's budget, never the new helper's.
let old=try NativeCapture(inputFormat:format),fresh=try NativeCapture(inputFormat:format)
var oldDelivered=0,freshDelivered=0,failures=0
for _ in 0..<10 {old.consume(buffer(4800,format:format),deliver:{_ in oldDelivered += 1},failed:{_ in check(Thread.isMainThread,"error callback on main");failures += 1})}
for _ in 0..<8 {fresh.consume(buffer(4800,format:format),deliver:{_ in freshDelivered += 1},failed:{_ in check(false,"old graph poisoned new graph budget")})}
check(old.snapshot().rawBuffers==10&&old.snapshot().convertedBuffers==8,"pending conversion is bounded")
check(fresh.snapshot().convertedBuffers==8,"new graph owns separate budget")
DispatchQueue.main.async {
    check(firstDelivered,"first callback delivered")
    check(oldDelivered==8&&freshDelivered==8,"main callbacks delivered")
    check(failures==1,"repeated overflow emits one failure")
    fresh.consume(buffer(4800,format:format),deliver:{_ in
        check(fresh.snapshot().convertedBuffers==9,"fresh budget releases after delivery")
        print("{\"nativeCapture\":\"pass\",\"rawBuffers\":2,\"convertedBuffers\":1,\"tapFrames\":4800,\"pendingBound\":8,\"physicalMicrophone\":false}")
        exit(0)
    },failed:{_ in check(false,"budget did not release")})
}
DispatchQueue.main.asyncAfter(deadline:.now()+10){check(false,"callbacks timed out")}
RunLoop.main.run()
