import XCTest
@testable import AssistantCore

final class CaptureDiagnosticsTests:XCTestCase {
    private func record(_ log:inout CaptureDiagnostics,_ event:String="route-change",generation:Int=1,at:TimeInterval,raw:Int=0){
        log.record(event,generation:generation,at:at,engineRunning:true,inputPorts:["BluetoothHFP"],outputPorts:["BluetoothHFP"],inputRate:48000,outputRate:48000,inputChannels:1,outputChannels:1,raw:raw,converted:raw)
    }
    func testKeepsLatest24EventsInOrderWithRelativeMonotonicTime(){
        var log=CaptureDiagnostics()
        for index in 0..<30 {record(&log,"event-\(index)",at:100+Double(index),raw:index)}
        XCTAssertEqual(log.lines.count,24)
        XCTAssertTrue(log.lines.first!.hasPrefix("+6000ms g1 event-6 "))
        XCTAssertTrue(log.lines.last!.hasPrefix("+29000ms g1 event-29 "))
        XCTAssertTrue(log.lines.last!.contains("in=BluetoothHFP@48000Hz/1ch out=BluetoothHFP@48000Hz/1ch raw=29 converted=29"))
    }
    func testRecoveryKeepsHistoryAndExplicitClearResetsTimeOrigin(){
        var log=CaptureDiagnostics();record(&log,"start",at:200)
        record(&log,"recover",generation:2,at:201)
        XCTAssertEqual(log.lines.count,2);XCTAssertTrue(log.lines[1].hasPrefix("+1000ms g2 recover"))
        log.clear();XCTAssertTrue(log.lines.isEmpty)
        record(&log,"start",generation:3,at:500)
        XCTAssertTrue(log.lines[0].hasPrefix("+0ms g3 start"))
    }
    func testInvalidClocksNeverProduceNegativeOrOutOfOrderElapsedTime(){
        var log=CaptureDiagnostics()
        for time in [-1.0,.nan,.infinity] {record(&log,at:time)}
        XCTAssertTrue(log.lines.isEmpty)
        record(&log,at:20);record(&log,at:19);record(&log,at:.infinity);record(&log,at:20)
        XCTAssertEqual(log.lines.count,2)
        XCTAssertTrue(log.lines.allSatisfy{$0.hasPrefix("+0ms ")})
        record(&log,at:Double.greatestFiniteMagnitude)
        XCTAssertTrue(log.lines.last!.hasPrefix("+9999999999ms "))
    }
    func testSanitizesMetadataAndNeverIncludesUnknownPortNamesOrUIDs(){
        var log=CaptureDiagnostics()
        log.record("tap\nerror/"+String(repeating:"x",count:1000),generation:-1,at:1,engineRunning:false,inputPorts:["Alice AirPods","device-secret-uid","MicrophoneBuiltIn"],outputPorts:["Speaker"],inputRate:.nan,outputRate:-48000,inputChannels:-1,outputChannels:Int.max,raw:-1,converted:-4)
        let line=log.lines[0]
        XCTAssertFalse(line.contains("Alice"));XCTAssertFalse(line.contains("secret"));XCTAssertFalse(line.contains("\n"))
        XCTAssertTrue(line.contains("g0 tap_error_"));XCTAssertTrue(line.contains("engine=off"))
        XCTAssertTrue(line.contains("in=other,other,MicrophoneBuiltIn@0Hz/0ch out=Speaker@0Hz/0ch raw=0 converted=0"))
        XCTAssertLessThan(line.count,220)
    }
}
