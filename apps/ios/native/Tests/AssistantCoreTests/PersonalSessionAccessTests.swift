import XCTest
@testable import AssistantCore

final class PersonalSessionAccessTests:XCTestCase {
    func data(_ s:String)->Data{Data(s.utf8)}
    func testServerConfirmedPersonalUnlockAndTransientFailure(){
        var a=PersonalSessionAccess();let t=a.generation
        XCTAssertTrue(a.observe(status:200,data:data(#"{"personalSessionPolicy":"personalDevice","personalSessionState":"unlocked","privateAllowed":true}"#),ticket:t))
        XCTAssertTrue(a.observe(status:503,data:Data(),ticket:t))
        XCTAssertTrue(a.observe(status:409,data:data(#"{"code":"revision_conflict"}"#),ticket:t))
        XCTAssertFalse(a.observe(status:401,data:Data(),ticket:t))
    }
    func testOldUnlockCannotUndoExplicitLock(){
        var a=PersonalSessionAccess();let old=a.generation;a.withdraw()
        XCTAssertFalse(a.observe(status:200,data:data(#"{"personalSessionPolicy":"personalDevice","personalSessionState":"unlocked","privateAllowed":true}"#),ticket:old))
    }
    func testOtherPolicyLockedAndEffectiveContextChangesWithdraw(){
        var a=PersonalSessionAccess();let ok=data(#"{"personalSessionPolicy":"personalDevice","personalSessionState":"unlocked","privateAllowed":true}"#)
        XCTAssertTrue(a.observe(status:200,data:ok,ticket:a.generation))
        XCTAssertFalse(a.observe(status:200,data:data(#"{"personalSessionPolicy":"personalDesktop","personalSessionState":"unlocked","privateAllowed":true}"#),ticket:a.generation))
        XCTAssertTrue(a.observe(status:200,data:ok,ticket:a.generation))
        XCTAssertFalse(a.observe(status:409,data:data(#"{"code":"effective_context_changed"}"#),ticket:a.generation))
    }
    func testAuthenticatedPersonalAppRequiresExactCurrentOwner() {
        let principal="00000000-0000-4000-8000-000000000001",session="00000000-0000-4000-8000-000000000002"
        let raw=data("{\"personalSessionPolicy\":\"personalApp\",\"personalSessionState\":\"authenticated\",\"privateAllowed\":true,\"enforced\":true,\"expiresAt\":null,\"leaseId\":null,\"leaseExpiresAt\":null,\"revision\":1,\"principalId\":\"\(principal)\",\"authenticatedSessionId\":\"\(session)\"}")
        var good=PersonalSessionAccess();XCTAssertTrue(good.observe(status:200,data:raw,ticket:good.generation,expectedPrincipal:principal,expectedSession:session));XCTAssertEqual(good.policy,"personalApp")
        for (actor,sid) in [(nil as String?,nil as String?),("wrong",session),(principal,"wrong")] {
            var denied=PersonalSessionAccess();XCTAssertFalse(denied.observe(status:200,data:raw,ticket:denied.generation,expectedPrincipal:actor,expectedSession:sid))
        }
        let old=good.generation;good.withdraw();XCTAssertFalse(good.observe(status:200,data:raw,ticket:old,expectedPrincipal:principal,expectedSession:session))
    }
    func testAuthenticatedSessionExpiryAndLeaseMustRemainValid() {
        let principal="00000000-0000-4000-8000-000000000001",session="00000000-0000-4000-8000-000000000002"
        func body(_ expiry:Any,_ lease:Any=NSNull())->Data {try! JSONSerialization.data(withJSONObject:["personalSessionPolicy":"personalApp","personalSessionState":"authenticated","privateAllowed":true,"enforced":true,"expiresAt":expiry,"leaseId":lease,"leaseExpiresAt":NSNull(),"revision":1,"principalId":principal,"authenticatedSessionId":session])}
        for (value,allowed) in [("2099-01-01T00:00:00.000Z",true),("2000-01-01T00:00:00.000Z",false),("not-a-date",false)] {var state=PersonalSessionAccess();XCTAssertEqual(state.observe(status:200,data:body(value),ticket:state.generation,expectedPrincipal:principal,expectedSession:session),allowed)}
        var bad=PersonalSessionAccess();XCTAssertFalse(bad.observe(status:200,data:body(NSNull(),"foreign-lease"),ticket:bad.generation,expectedPrincipal:principal,expectedSession:session))
    }
}
