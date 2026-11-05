// SPDX-License-Identifier: Apache-2.0
import Foundation

/// Parses the server's bounded preview stream without exposing reference audio,
/// credentials or arbitrary provider error text to the web view.
public struct VoicePreviewStream {
    public struct Result {public let pcm:Data;public let samples:Int;public let degraded:[String];public let previewId:String?}
    private var pending=Data(),pcm=Data(),samples=0,frames=0,events=0,terminal=false,receipt:String?,degraded=Set<String>()
    private let expectedVoiceRef:String?,expectedRevision:Int?,sampleRate:Int
    private let dimensions:Set<String>=["deliveryMode","pace","energy","urgency","affect"]
    public init(expectedVoiceRef:String?=nil,expectedRevision:Int?=nil,sampleRate:Int=48000){self.expectedVoiceRef=expectedVoiceRef;self.expectedRevision=expectedRevision;self.sampleRate=sampleRate}
    public mutating func append(_ data:Data)throws {
        guard !terminal || data.isEmpty else{throw VoiceError.invalidMessage}
        pending.append(data);guard pending.count<=262144 else{throw VoiceError.overflow}
        while let end=pending.firstIndex(of:10){let line=Data(pending[..<end]);pending.removeSubrange(...end);if !line.isEmpty{try consume(line)}}
    }
    private mutating func consume(_ data:Data)throws {
        events += 1;guard events<=4000,!terminal,let object=try JSONSerialization.jsonObject(with:data) as? [String:Any],let kind=object["kind"] as? String else{throw VoiceError.invalidMessage}
        if let values=object["degradedDimensions"] as? [String]{for value in values where dimensions.contains(value){degraded.insert(value)}}
        switch kind {
        case "preAudio":break
        case "data":
            guard [16000,48000].contains(sampleRate),let frame=object["frame"] as? [String:Any],let format=frame["format"] as? [String:Any],format["encoding"] as? String == "pcm_s16le",format["sampleRateHz"] as? Int == sampleRate,format["channels"] as? Int == 1,
                  let seq=frame["sequence"] as? Int,seq==frames,let offset=frame["sampleOffset"] as? Int,offset==samples,let count=frame["sampleCount"] as? Int,(1...4800).contains(count),samples+count<=sampleRate*60,
                  let encoded=frame["dataBase64"] as? String,encoded.utf8.count<=12800,let bytes=Data(base64Encoded:encoded),bytes.count==count*2 else{throw VoiceError.invalidFrame}
            samples += count;frames += 1;pcm.append(bytes)
        case "terminal":
            guard object["outcome"] as? String == "succeeded",object["outputSamples"] as? Int == samples,object["frameCount"] as? Int == frames,samples>0 else{throw VoiceError.invalidMessage}
            if let expectedVoiceRef {guard let view=object["voicePreview"] as? [String:Any],view["voiceRef"] as? String==expectedVoiceRef,view["revision"] as? Int==expectedRevision,let id=view["previewId"] as? String,UUID(uuidString:id) != nil else{throw VoiceError.invalidMessage};receipt=id}
            else if object["voicePreview"] != nil && !(object["voicePreview"] is NSNull){throw VoiceError.invalidMessage}
            terminal=true
        default:throw VoiceError.invalidMessage
        }
    }
    public mutating func finish()throws->Result {
        if !pending.isEmpty{let line=pending;pending=Data();try consume(line)}
        guard terminal,pending.isEmpty else{throw VoiceError.invalidMessage}
        return Result(pcm:pcm,samples:samples,degraded:degraded.sorted(),previewId:receipt)
    }
}
