import XCTest
import Foundation
@testable import AssistantCore

final class VoicePreviewStreamTests:XCTestCase {
    func line(_ value:[String:Any])->Data{var d=try! JSONSerialization.data(withJSONObject:value,options:.sortedKeys);d.append(10);return d}
    func frame(_ sequence:Int=0,_ offset:Int=0,_ count:Int=3)->[String:Any]{["kind":"data","frame":["sequence":sequence,"sampleOffset":offset,"sampleCount":count,"dataBase64":Data(count:count*2).base64EncodedString(),"format":["encoding":"pcm_s16le","sampleRateHz":48000,"channels":1]]]}
    func testChunkedPreviewRequiresExactFrameOrderTerminalAndReceipt() throws {
        let ref="saved-voice:"+UUID().uuidString.lowercased(),id=UUID().uuidString.lowercased();var stream=VoicePreviewStream(expectedVoiceRef:ref,expectedRevision:7)
        var wire=line(["kind":"preAudio","degradedDimensions":["pace","PRIVATE_SECRET"]]);wire.append(line(frame()));wire.append(line(["kind":"terminal","outcome":"succeeded","outputSamples":3,"frameCount":1,"voicePreview":["previewId":id,"voiceRef":ref,"revision":7]]))
        for byte in wire{try stream.append(Data([byte]))};let result=try stream.finish();XCTAssertEqual(result.samples,3);XCTAssertEqual(result.pcm.count,6);XCTAssertEqual(result.degraded,["pace"]);XCTAssertEqual(result.previewId,id)
        var mismatch=VoicePreviewStream(expectedVoiceRef:ref,expectedRevision:8);try mismatch.append(line(frame()));XCTAssertThrowsError(try mismatch.append(line(["kind":"terminal","outcome":"succeeded","outputSamples":3,"frameCount":1,"voicePreview":["previewId":id,"voiceRef":ref,"revision":7]])))
    }
    func testRejectsBadFramesMissingTerminalAndFailedTerminal() throws {
        for bad in [frame(1),frame(0,1),frame(0,0,4801)]{var stream=VoicePreviewStream();XCTAssertThrowsError(try stream.append(line(bad)))}
        var incomplete=VoicePreviewStream();try incomplete.append(line(frame()));XCTAssertThrowsError(try incomplete.finish())
        var failed=VoicePreviewStream();try failed.append(line(frame()));XCTAssertThrowsError(try failed.append(line(["kind":"terminal","outcome":"failed","outputSamples":3,"frameCount":1])))
        var oversized=VoicePreviewStream();XCTAssertThrowsError(try oversized.append(Data(repeating:65,count:262145)))
    }
    func testOriginalReferenceAcceptsOnlyItsDeclaredSampleRate()throws{
        var event=frame(),frameValue=event["frame"] as! [String:Any],format=frameValue["format"] as! [String:Any];format["sampleRateHz"]=16000;frameValue["format"]=format;event["frame"]=frameValue
        var original=VoicePreviewStream(sampleRate:16000);try original.append(line(event));try original.append(line(["kind":"terminal","outcome":"succeeded","outputSamples":3,"frameCount":1]));XCTAssertEqual(try original.finish().samples,3)
        var synthesized=VoicePreviewStream();XCTAssertThrowsError(try synthesized.append(line(event)))
    }
}
