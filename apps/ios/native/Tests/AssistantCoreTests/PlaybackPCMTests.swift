// SPDX-License-Identifier: Apache-2.0
import XCTest
@testable import AssistantCore

final class PlaybackPCMTests:XCTestCase {
    func testLittleEndianSignedPCMHasNoGainOrPolarityChange() throws {
        let bytes=Data([0,0,0,128,255,127,0,64,0,192,1,0,255,255])
        XCTAssertEqual(try PlaybackPCM.decode(bytes,samples:7),[0,-1,32767.0/32768,0.5,-0.5,1.0/32768,-1.0/32768])
    }
    func testMalformedAndOversizedFramesAreRejectedBeforeAllocation() {
        for count in [0,-1,4801,Int.max] {XCTAssertThrowsError(try PlaybackPCM.decode(Data(),samples:count))}
        XCTAssertThrowsError(try PlaybackPCM.decode(Data([0,0,0]),samples:2))
        XCTAssertThrowsError(try PlaybackPCM.decode(Data([0,0,0,0]),samples:1))
    }
}
