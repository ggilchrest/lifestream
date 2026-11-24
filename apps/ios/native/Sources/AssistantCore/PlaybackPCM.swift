// SPDX-License-Identifier: Apache-2.0
import Foundation

/// The wire format is always 48 kHz mono signed little-endian PCM16.
/// Decode amplitude only; AVAudioEngine's mixer performs route-rate conversion.
public enum PlaybackPCM {
    public static func decode(_ bytes:Data,samples:Int) throws -> [Float] {
        guard samples>0,samples<=4800,bytes.count==samples*2 else{throw VoiceError.invalidFrame}
        let octets=[UInt8](bytes)
        return (0..<samples).map { index in
            Float(Int16(bitPattern:UInt16(octets[index*2]) | UInt16(octets[index*2+1])<<8))/32768
        }
    }
}
