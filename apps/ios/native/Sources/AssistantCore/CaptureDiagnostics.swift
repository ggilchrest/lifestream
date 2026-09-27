// SPDX-License-Identifier: Apache-2.0
import Foundation

/// Bounded foreground diagnostics. Contains stage tags and numeric observations,
/// never audio, transcript, credentials, route names or device identifiers.
/// The owner clears only for a deliberate new start, preserving recovery history.
public struct CaptureDiagnostics {
    public private(set) var lines=[String]()
    private var origin:TimeInterval?,latest:TimeInterval?
    public init(){}
    public mutating func clear(){lines.removeAll(keepingCapacity:true);origin=nil;latest=nil}
    public mutating func record(_ event:String,generation:Int,at:TimeInterval,engineRunning:Bool,inputPorts:[String],outputPorts:[String],inputRate:Double,outputRate:Double,inputChannels:Int=0,outputChannels:Int=0,raw:Int,converted:Int){
        guard at.isFinite,at>=0,latest.map({at >= $0}) ?? true else{return}
        if origin==nil{origin=at};latest=at
        let elapsed=Int(min(9_999_999_999,max(0,(at-origin!)*1000)).rounded(.down))
        let tag=String(event.unicodeScalars.prefix(32).map{scalar->Character in
            let value=scalar.value
            return (48...57).contains(value)||(65...90).contains(value)||(97...122).contains(value)||[45,46,95].contains(value) ? Character(String(scalar)):"_"
        })
        lines.append("+\(elapsed)ms g\(max(0,generation)) \(tag.isEmpty ? "event":tag) engine=\(engineRunning ? "on":"off") in=\(Self.ports(inputPorts))@\(Self.rate(inputRate))Hz/\(Self.channels(inputChannels))ch out=\(Self.ports(outputPorts))@\(Self.rate(outputRate))Hz/\(Self.channels(outputChannels))ch raw=\(max(0,raw)) converted=\(max(0,converted))")
        if lines.count>24{lines.removeFirst(lines.count-24)}
    }
    private static func rate(_ value:Double)->Int{value.isFinite&&value>=0&&value<=384000 ? Int(value.rounded()):0}
    private static func channels(_ value:Int)->Int{(0...128).contains(value) ? value:0}
    private static func ports(_ values:[String])->String{
        // AVAudioSession.Port raw values only; accidental names/UIDs cannot pass.
        let known:Set<String>=["MicrophoneBuiltIn","MicrophoneWired","HeadsetMic","LineIn","LineOut","BluetoothHFP","BluetoothLE","BluetoothA2DPOutput","Speaker","Receiver","Headphones","USBAudio","HDMIOutput","AirPlay","CarAudio","AVB","DisplayPort","PCI","FireWire","Virtual","ContinuityMicrophone"]
        return values.isEmpty ? "none":values.prefix(4).map{known.contains($0) ? $0:"other"}.joined(separator:",")
    }
}
