import Foundation
import XCTest
@testable import AssistantCore
final class HealthObserverCompletionTests:XCTestCase {
 func testCompletionIsOnceWhenCancellationAndDeliveryRace(){let lock=NSLock();var count=0;let finish=HealthObserverCompletion{lock.lock();count+=1;lock.unlock()};DispatchQueue.concurrentPerform(iterations:64){_ in finish.finish()};XCTAssertEqual(count,1);finish.finish();XCTAssertEqual(count,1)}
}
