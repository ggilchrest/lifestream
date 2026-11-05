import XCTest
import Foundation
@testable import AssistantCore

final class DiagnosticBufferTests:XCTestCase {
    func testAuditBreadcrumbsAreClosedAndDoNotAcceptUserStrings() throws {
        let log=DiagnosticBuffer();log.setEnabled(true);log.record(.auditDiscoveryAbsent);log.record(.auditUnlabeledStart);log.record(.auditTurnEnrolled);log.record(.auditShareEmpty)
        let text=String(data:try XCTUnwrap(log.encoded()),encoding:.utf8)!
        XCTAssertTrue(text.contains("audit_discovery_absent"));XCTAssertTrue(text.contains("audit_unlabeled_start"));XCTAssertTrue(text.contains("audit_turn_enrolled"));XCTAssertTrue(text.contains("audit_share_empty"));XCTAssertFalse(text.contains("credential-sentinel"))
    }

    func testVoiceTerminalAndEmptyTranscriptUseClosedCodesAndLocalTurn() throws {
        XCTAssertEqual(VoiceDiagnostic.transcript("  \n"),.voiceTranscriptEmpty)
        XCTAssertEqual(VoiceDiagnostic.transcript("synthetic secret transcript"),.voiceTranscribed)
        XCTAssertEqual(VoiceDiagnostic.terminalCode("audio_turn_failed"),.audioTurnFailed)
        XCTAssertEqual(VoiceDiagnostic.terminalCode("audio_interrupted"),.audioInterrupted)
        XCTAssertEqual(VoiceDiagnostic.terminalCode("audio_deadline_exceeded"),.audioDeadlineExceeded)
        XCTAssertEqual(VoiceDiagnostic.terminalCode("synthetic secret transcript"),.unknown)
        XCTAssertNil(VoiceDiagnostic.terminal(state:"completed",code:nil))
        XCTAssertEqual(VoiceDiagnostic.terminal(state:"interrupted",code:"audio_interrupted")?.0,.voiceTerminalInterrupted)
        XCTAssertEqual(VoiceDiagnostic.terminal(state:"failed",code:"untrusted private message")?.1,.unknown)
        let log=DiagnosticBuffer();log.setEnabled(true)
        log.record(.voiceSpeech,turn:12);log.record(.voiceTranscriptEmpty,turn:12)
        log.record(.voiceTerminalFailed,code:.audioTurnFailed,turn:12)
        log.record(.textContextChanged,code:.contextPreparation,turn:13)
        log.record(.voiceSpeech,turn:384_001)
        let entries=log.snapshot();XCTAssertEqual(entries.prefix(3).map(\.turn),[12,12,12]);XCTAssertEqual(entries[3].turn,13);XCTAssertNil(entries[4].turn)
        let encoded=try XCTUnwrap(log.encoded());XCTAssertFalse(String(decoding:encoded,as:UTF8.self).contains("synthetic secret transcript"))
        let restored=DiagnosticBuffer();restored.restore(encoded);XCTAssertEqual(restored.snapshot(),entries)
        let old=Data("[{\"sequence\":1,\"timestampMs\":1,\"event\":\"voice_start\"}]".utf8);restored.restore(old);XCTAssertNil(restored.snapshot().first?.turn)
        let full=DiagnosticBuffer();full.setEnabled(true);for _ in 0..<DiagnosticBuffer.maxEntries{full.record(.voiceTerminalInterrupted,status:599,durationMs:3_600_000,value:384_000,code:.audioDeadlineExceeded,turn:384_000)}
        let encoder=JSONEncoder();encoder.outputFormatting=[.prettyPrinted,.sortedKeys];XCTAssertLessThanOrEqual(try encoder.encode(full.snapshot()).count,DiagnosticBuffer.maxBytes)
    }
    func testOffByDefaultAndDisableStopsImmediately(){
        let log=DiagnosticBuffer();XCTAssertFalse(log.enabled);XCTAssertFalse(log.record(.voiceStart));XCTAssertEqual(log.count,0)
        log.setEnabled(true);XCTAssertTrue(log.record(.voiceStart));log.setEnabled(false);XCTAssertFalse(log.record(.voiceStop));XCTAssertEqual(log.snapshot().map(\.event),[.voiceStart])
        log.clear();XCTAssertEqual(log.count,0)
    }
    func testClosedEventsAndNumbersRejectSentinelsAndBounds() throws {
        let sentinel="SENTINEL_password_transcript_cookie_secret";XCTAssertNil(DiagnosticEvent(rawValue:sentinel));XCTAssertNil(DiagnosticCode(rawValue:sentinel))
        let log=DiagnosticBuffer();log.setEnabled(true);log.record(.httpHistory,status:403,durationMs:7,value:42,code:.historyPrivateScopeRequired);log.record(.httpOther,status:999,durationMs:-1,value:900000)
        let data=try XCTUnwrap(log.encoded()),text=try XCTUnwrap(String(data:data,encoding:.utf8));XCTAssertFalse(text.contains(sentinel));XCTAssertTrue(text.contains("history_private_scope_required"));let second=log.snapshot()[1];XCTAssertNil(second.status);XCTAssertNil(second.durationMs);XCTAssertNil(second.value)
    }
    func testBoundedConcurrentEventsAndPersistenceRejectMalformedData() throws {
        let log=DiagnosticBuffer();log.setEnabled(true);DispatchQueue.concurrentPerform(iterations:1200){_ in log.record(.cameraChanged)}
        let entries=log.snapshot();XCTAssertEqual(entries.count,DiagnosticBuffer.maxEntries);XCTAssertEqual(Set(entries.map(\.sequence)).count,entries.count);XCTAssertTrue(zip(entries,entries.dropFirst()).allSatisfy{$0.sequence<$1.sequence})
        let data=try XCTUnwrap(log.encoded());XCTAssertLessThanOrEqual(data.count,DiagnosticBuffer.maxBytes);let restored=DiagnosticBuffer();restored.restore(data);XCTAssertEqual(restored.snapshot(),entries);restored.restore(Data("[{\"event\":\"secret\"}]".utf8));XCTAssertEqual(restored.snapshot(),entries);restored.restore(Data(repeating:1,count:DiagnosticBuffer.maxBytes+1));XCTAssertEqual(restored.snapshot(),entries)
    }
    func testExportIsImmutableUntilShareCompletionAndCleanup() throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString,isDirectory:true);defer{try? FileManager.default.removeItem(at:root)}
        let log=DiagnosticBuffer();log.setEnabled(true);log.record(.historyCreate);let snapshot=try XCTUnwrap(log.encoded());let url=try DiagnosticExportFile.create(data:snapshot,in:root)
        log.record(.historySelect);XCTAssertEqual(try Data(contentsOf:url),snapshot);XCTAssertTrue(FileManager.default.fileExists(atPath:url.path));let mode=try XCTUnwrap(try FileManager.default.attributesOfItem(atPath:url.path)[.posixPermissions] as? NSNumber);XCTAssertEqual(mode.intValue & 0o777,0o600)
        DiagnosticExportFile.finish(url);XCTAssertFalse(FileManager.default.fileExists(atPath:url.path));XCTAssertThrowsError(try DiagnosticExportFile.create(data:Data(),in:root));XCTAssertThrowsError(try DiagnosticExportFile.create(data:Data(repeating:1,count:DiagnosticBuffer.maxBytes+2049),in:root))
    }
}
