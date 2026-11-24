import XCTest
@testable import AssistantCore
final class MobileContextTemporalTests:XCTestCase {
 func testAllDayRangePreservesExclusiveDatesAcrossDSTAndYear() {
  let spring=MobileCalendarAllDayRange(start:"2026-03-08",endExclusive:"2026-03-09");XCTAssertEqual(spring?.start.text,"2026-03-08");XCTAssertEqual(spring?.endExclusive.text,"2026-03-09")
  XCTAssertNotNil(MobileCalendarAllDayRange(start:"2026-12-31",endExclusive:"2027-01-01"));XCTAssertNil(MobileCalendarAllDayRange(start:"2026-03-08",endExclusive:"2026-03-08"));XCTAssertNil(MobileCalendarAllDayRange(start:"2026-03-09",endExclusive:"2026-03-08"))
 }
 func testDatesRejectInvalidAndKeepLeapRules() {
  XCTAssertEqual(MobileCalendarDate("2024-02-29")?.text,"2024-02-29");XCTAssertNil(MobileCalendarDate("2023-02-29"));XCTAssertNil(MobileCalendarDate("1900-02-29"));XCTAssertNotNil(MobileCalendarDate("2000-02-29"));XCTAssertNil(MobileCalendarDate("2024-2-01"));XCTAssertNil(MobileCalendarDate("0000-01-01"))
 }
 func testTimezoneIsSuppliedOrExplicitlyUnknown() {
  XCTAssertEqual(MobileSourceTimeZone(supplied:nil),.unknown);XCTAssertEqual(MobileSourceTimeZone(supplied:"America/New_York"),.supplied("America/New_York"));XCTAssertNil(MobileSourceTimeZone(supplied:"not-a-zone"))
 }
}
