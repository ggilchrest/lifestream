// SPDX-License-Identifier: Apache-2.0
import AVFoundation
import Foundation

/// One instance per audio graph. Late callbacks retain only their own graph's
/// converter and queue accounting; no PCM or diagnostic metadata is persisted.
final class NativeCapture {
    struct Stats {
        let rawBuffers:Int,convertedBuffers:Int
        let lastRaw:TimeInterval?,lastConverted:TimeInterval?
        let sampleRate:Double,channels:UInt32
    }
    enum SetupError:Error {case invalidInputFormat}
    let bufferSize:AVAudioFrameCount
    private let inputFormat:AVAudioFormat,target:AVAudioFormat,converter:AVAudioConverter
    private let lock=NSLock(),conversionLock=NSLock()
    private var pending=0,rawBuffers=0,convertedBuffers=0,failureQueued=false
    private var lastRaw:TimeInterval?,lastConverted:TimeInterval?
    private var sampleRate:Double,channels:UInt32

    init(inputFormat:AVAudioFormat) throws {
        guard inputFormat.sampleRate.isFinite,inputFormat.sampleRate>0,inputFormat.sampleRate<=384000,inputFormat.channelCount>0,
              let target=AVAudioFormat(commonFormat:.pcmFormatFloat32,sampleRate:16000,channels:1,interleaved:false),
              let converter=AVAudioConverter(from:inputFormat,to:target) else{throw SetupError.invalidInputFormat}
        self.inputFormat=inputFormat;self.target=target;self.converter=converter
        sampleRate=inputFormat.sampleRate;channels=inputFormat.channelCount
        // The installed SDK documents a supported tap size of 100–400 ms.
        bufferSize=AVAudioFrameCount(ceil(inputFormat.sampleRate*0.1))
    }
    func snapshot()->Stats {
        lock.lock();defer{lock.unlock()}
        return Stats(rawBuffers:rawBuffers,convertedBuffers:convertedBuffers,lastRaw:lastRaw,lastConverted:lastConverted,sampleRate:sampleRate,channels:channels)
    }
    func consume(_ buffer:AVAudioPCMBuffer,deliver:@escaping([Float])->Void,failed:@escaping(String)->Void){
        lock.lock()
        rawBuffers += 1;lastRaw=ProcessInfo.processInfo.systemUptime;sampleRate=buffer.format.sampleRate;channels=buffer.format.channelCount
        let admitted=pending<8;if admitted{pending += 1};lock.unlock()
        guard admitted else{failure("Microphone processing could not keep up. Start listening again.",failed);return}
        guard buffer.frameLength>0 else{release();return}
        guard buffer.format.isEqual(inputFormat) else{release();failure("The microphone format changed. Start listening again with the selected audio device.",failed);return}
        let capacity=AVAudioFrameCount(ceil(Double(buffer.frameLength)*16000/inputFormat.sampleRate)+32)
        guard let converted=AVAudioPCMBuffer(pcmFormat:target,frameCapacity:capacity) else{release();failure("Microphone buffer allocation failed.",failed);return}
        var supplied=false,error:NSError?
        conversionLock.lock()
        let status=converter.convert(to:converted,error:&error){_,state in
            if supplied{state.pointee = .noDataNow;return nil}
            supplied=true;state.pointee = .haveData;return buffer
        }
        conversionLock.unlock()
        guard error==nil,status != .error else{release();failure("Microphone audio conversion failed. Select an audio device and start again.",failed);return}
        guard let channel=converted.floatChannelData?[0],converted.frameLength>0 else{release();return}
        let values=Array(UnsafeBufferPointer(start:channel,count:Int(converted.frameLength)))
        guard values.allSatisfy({$0.isFinite}) else{release();failure("Microphone produced invalid audio. Start listening again.",failed);return}
        lock.lock();convertedBuffers += 1;lastConverted=ProcessInfo.processInfo.systemUptime;lock.unlock()
        DispatchQueue.main.async{defer{self.release()};deliver(values)}
    }
    private func release(){lock.lock();pending -= 1;lock.unlock()}
    private func failure(_ message:String,_ failed:@escaping(String)->Void){
        lock.lock();let report = !failureQueued;failureQueued=true;lock.unlock()
        if report{DispatchQueue.main.async{failed(message)}}
    }
}
