import XCTest
@testable import AssistantCore
final class HealthSleepMappingTests:XCTestCase {
 func testAllNativeSleepStagesAndUnknownArePreserved(){
  let stages:[HealthSleepStage]=[.inBed,.asleepUnspecified,.awake,.coreLight,.deep,.rem,.unknown]
  for (i,stage) in stages.enumerated(){let value=HealthSleepValue(nativeValue:i==6 ? 901 : i);XCTAssertEqual(value.stage,stage);if i==6{XCTAssertEqual(value.nativeValue,901)}}
 }
}
