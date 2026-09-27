import XCTest
@testable import AssistantCore

final class AudioInputSelectionTests:XCTestCase {
    func testIdleDiscoveryStillOffersDeferredDefaultAndBuiltInChoices() throws {
        XCTAssertEqual(AudioInputSelection.options([]).map(\.id),["system","builtin"])
        XCTAssertEqual(AudioInputSelection.options([]).map(\.label),["System default (automatic)","iPhone microphone"])
        XCTAssertNil(try AudioInputSelection.resolve("system",ports:[]))
        XCTAssertThrowsError(try AudioInputSelection.resolve("builtin",ports:[]))
    }
    func testSelectionResolvesAgainstFreshInputsWithoutSilentFallback() throws {
        let builtIn=AudioInputPort(id:"built-in-uid",label:"Built-in",builtIn:true),headset=AudioInputPort(id:"headset-uid",label:"Headset microphone",builtIn:false)
        XCTAssertEqual(try AudioInputSelection.resolve("builtin",ports:[headset,builtIn]),"built-in-uid")
        XCTAssertEqual(try AudioInputSelection.resolve("headset-uid",ports:[builtIn,headset]),"headset-uid")
        XCTAssertThrowsError(try AudioInputSelection.resolve("headset-uid",ports:[builtIn]))
        XCTAssertThrowsError(try AudioInputSelection.resolve("builtin",ports:[headset]))
        XCTAssertNil(try AudioInputSelection.resolve("system",ports:[headset,builtIn]))
    }
    func testAvailablePreferenceWaitsForActualRouteAndNeverAcceptsFallback() {
        let ports=[AudioInputPort(id:"phone",label:"Phone",builtIn:true),AudioInputPort(id:"headset",label:"Headset",builtIn:false)]
        XCTAssertFalse(AudioInputSelection.isRouted("headset",ports:ports,currentIds:["phone"]))
        XCTAssertTrue(AudioInputSelection.isRouted("headset",ports:ports,currentIds:["headset"]))
        XCTAssertFalse(AudioInputSelection.isRouted("builtin",ports:ports,currentIds:["headset"]))
        XCTAssertTrue(AudioInputSelection.isRouted("builtin",ports:ports,currentIds:["phone"]))
        XCTAssertFalse(AudioInputSelection.isRouted("headset",ports:[ports[0]],currentIds:["phone"]))
        XCTAssertFalse(AudioInputSelection.isRouted("system",ports:ports,currentIds:[]))
        XCTAssertTrue(AudioInputSelection.isRouted("system",ports:ports,currentIds:["headset"]))
    }
    func testOptionsDeduplicateAndBoundExternalDevices() {
        let builtIn=AudioInputPort(id:"built-in-uid",label:"Internal microphone",builtIn:true)
        let external=(0..<20).map{AudioInputPort(id:"external-\($0)",label:"External microphone \($0)",builtIn:false)}
        let options=AudioInputSelection.options([builtIn,external[0],external[0]]+external)
        XCTAssertEqual(options.count,10)
        XCTAssertEqual(options.map(\.id),["system","builtin"]+(0..<8).map{"external-\($0)"})
        XCTAssertFalse(options.contains{$0.id==builtIn.id})
    }
    func testDisplayLabelsCannotInjectControlsOrGrowWithoutBound() {
        let options=AudioInputSelection.options([
            AudioInputPort(id:"a",label:"  Wired\n\tMicrophone\u{0}  ",builtIn:false),
            AudioInputPort(id:"b",label:String(repeating:"x",count:200),builtIn:false),
            AudioInputPort(id:"c",label:"\n\t\u{0}",builtIn:false)
        ])
        XCTAssertEqual(options[2].label,"Wired Microphone")
        XCTAssertEqual(options[3].label.count,80)
        XCTAssertEqual(options[4].label,"Microphone")
    }
    func testInvalidOrReservedExternalIdsAreNeitherListedNorResolved() {
        let invalid=["", "   ", "line\nbreak", String(repeating:"x",count:513), "system", "builtin"]
        let ports=invalid.map{AudioInputPort(id:$0,label:"Invalid",builtIn:false)}
        XCTAssertEqual(AudioInputSelection.options(ports).count,2)
        for id in invalid where id != "system" {XCTAssertThrowsError(try AudioInputSelection.resolve(id,ports:ports))}
        XCTAssertNil(try AudioInputSelection.resolve("system",ports:ports))
    }
}
