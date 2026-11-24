import Foundation
import CryptoKit
import XCTest
@testable import AssistantCore
private final class Binding:SharedCaptureBinding {let human:String,epoch:Int;init(_ human:String="original",_ epoch:Int=1){self.human=human;self.epoch=epoch}}
private final class Attempt:SharedCaptureAttempt {let id:String;init(_ id:String="attempt"){self.id=id}}
private final class Reservation:SharedCaptureReservation {let id:String,digest:String,binding:Binding;init(_ id:String,_ digest:String,_ binding:Binding){self.id=id;self.digest=digest;self.binding=binding}}
private final class Receipt:SharedCaptureReceipt {let id:String;init(_ id:String){self.id=id}}
private final class State {var committed=[String:(String,String,Data,Data)]()}
private final class Lease:SharedCaptureReadLease {
    let originalSelectionContext:any SharedCaptureBinding;var chunks:[Data?];var readCount=0,checkCount=0,closeCount=0;var valid=true;var onRead:(()->Void)?
    init(binding:Binding=Binding(),chunks:[Data?]){self.originalSelectionContext=binding;self.chunks=chunks}
    func check()throws {checkCount += 1;if !valid{throw CocoaError(.fileReadNoPermission)}}
    func read(maxBytes:Int)throws->Data? {readCount += 1;onRead?();guard !chunks.isEmpty else{throw CocoaError(.fileReadUnknown)};return chunks.removeFirst()}
    func close(){closeCount += 1}
}
private final class Owner:SharedCaptureOwner {
    let state:State;var currentHuman="original",epoch=1,policy=true,target=true,cancelled=false,revision=1,commitCalls=0,abandonCalls=0,reserveCalls=0,legacyBytes=128,unknownAfterCommit=false,throwAfterCommit=false,failAtCommit=false,lockAtCommit=false
    init(_ state:State=State()){self.state=state}
    func reconcile(attempt:any SharedCaptureAttempt,payloadDigest:String,item:MobileSharedItem.Value,context:any SharedCaptureBinding)throws->SharedCaptureReconciliation {
        guard let attempt=attempt as? Attempt,let binding=context as? Binding,policy,currentHuman==binding.human else{return .unavailable}
        guard let row=state.committed[attempt.id] else{return .absent};guard row.1==binding.human,row.0==payloadDigest else{return .conflict};return .committed(Receipt(attempt.id))
    }
    func reserve(attempt:any SharedCaptureAttempt,payloadDigest:String,item:MobileSharedItem.Value,context:any SharedCaptureBinding)throws->SharedCaptureReservationResult {
        reserveCalls += 1;guard let attempt=attempt as? Attempt,let binding=context as? Binding,policy,target,!cancelled,currentHuman==binding.human,epoch==binding.epoch,case .attachment(_,let a,_)=item.content else{return .held}
        let metadata=item.data.count+legacyBytes+128,limit=8*1024*1024,encoded=((a.byteLength+2)/3)*4;guard metadata<=limit,encoded<=limit-metadata else{return .held}
        let budget=min(8*1024*1024,((limit-metadata)/4)*3);return .reserved(Reservation(attempt.id,payloadDigest,binding),rawBudget:budget)
    }
    func check(_ reservation:any SharedCaptureReservation)throws {guard let r=reservation as? Reservation,policy,target,!cancelled,currentHuman==r.binding.human,epoch==r.binding.epoch,revision==1 else{throw CocoaError(.fileReadNoPermission)}}
    func commit(_ reservation:any SharedCaptureReservation,itemJSON:Data,capturedBytes:Data,integrity:[String:Any])throws->SharedCaptureCommitResult {
        commitCalls += 1;guard let r=reservation as? Reservation else{return .held};if failAtCommit{revision += 1};if lockAtCommit{target=false};guard (try? check(r)) != nil else{return .held}
        state.committed[r.id]=(r.digest,r.binding.human,itemJSON,capturedBytes);if throwAfterCommit{throw CocoaError(.fileWriteUnknown)};if unknownAfterCommit{return .unknown};return .acknowledged(Receipt(r.id))
    }
    func abandon(_ reservation:any SharedCaptureReservation){abandonCalls += 1}
}
final class MobileSharedCaptureTests:XCTestCase {
    private func fixture()throws->([String:Any],[String:Any]) {let ios=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent(),capture=try XCTUnwrap(JSONSerialization.jsonObject(with:Data(contentsOf:ios.appendingPathComponent("test/mobile-shared-capture-fixtures/capture-lifecycle.json"))) as? [String:Any]),raw=try String(contentsOf:ios.appendingPathComponent("test/mobile-shared-item-fixtures/shared-item-pairs.json"),encoding:.utf8),shared=try XCTUnwrap(JSONSerialization.jsonObject(with:Data(raw.replacingOccurrences(of:"\\ud800",with:"__UNPAIRED__").utf8)) as? [String:Any]);XCTAssertEqual(capture["syntheticOnly"] as? Bool,true);return(capture,shared)}
    private func item(_ bytes:Data?=nil)throws->Data {let (_,f)=try fixture(),pairs=try XCTUnwrap(f["pairs"] as? [[String:Any]]),pair=try XCTUnwrap(pairs.first{($0["case"] as? String)=="file-reference"});var item=try XCTUnwrap(pair["ios"] as? [String:Any]);if let bytes {var content=try XCTUnwrap(item["content"] as? [String:Any]),artifact=try XCTUnwrap(content["artifact"] as? [String:Any]);artifact["byteLength"]=bytes.count;artifact["sha256"]=SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined();content["artifact"]=artifact;item["content"]=content};return try JSONSerialization.data(withJSONObject:item,options:[.sortedKeys,.withoutEscapingSlashes])}
    private func held(_ result:MobileSharedCapture.Outcome,file:StaticString=#filePath,line:UInt=#line){if case .held = result {} else{XCTFail("expected held",file:file,line:line)}}
    private func ack(_ result:MobileSharedCapture.Outcome,file:StaticString=#filePath,line:UInt=#line){if case .portAcknowledged = result {} else{XCTFail("expected synthetic acknowledgement",file:file,line:line)}}
    func testMissingOwnerPolicyAndTargetNeverRead()throws {
        let data=try item(),missing=Lease(chunks:[nil]);held(MobileSharedCapture.capture(itemJSON:data,attempt:Attempt(),lease:missing,owner:nil));XCTAssertEqual(missing.readCount,0);XCTAssertEqual(missing.closeCount,1)
        for mode in 0..<2 {let owner=Owner();if mode==0{owner.policy=false}else{owner.target=false};let lease=Lease(chunks:[nil]);held(MobileSharedCapture.capture(itemJSON:data,attempt:Attempt(),lease:lease,owner:owner));XCTAssertEqual(lease.readCount,0);XCTAssertEqual(owner.commitCalls,0);XCTAssertEqual(lease.closeCount,1)}
        let invalid=Lease(chunks:[nil]);held(MobileSharedCapture.capture(itemJSON:Data("{}".utf8),attempt:Attempt(),lease:invalid,owner:Owner()));XCTAssertEqual(invalid.readCount,0);XCTAssertEqual(invalid.closeCount,1)
        let (_,fixture)=try fixture(),pairs=try XCTUnwrap(fixture["pairs"] as? [[String:Any]]),text=try XCTUnwrap(pairs.first{($0["case"] as? String)=="quoted-text"}?["ios"]),nonattachment=Lease(chunks:[nil]);held(MobileSharedCapture.capture(itemJSON:try JSONSerialization.data(withJSONObject:text),attempt:Attempt(),lease:nonattachment,owner:Owner()));XCTAssertEqual(nonattachment.readCount,0);XCTAssertEqual(nonattachment.closeCount,1)
        for mode in 0..<2 {let owner=Owner();if mode==0{owner.currentHuman="other"}else{owner.epoch=2};let lease=Lease(chunks:[nil]);held(MobileSharedCapture.capture(itemJSON:data,attempt:Attempt(),lease:lease,owner:owner));XCTAssertEqual(lease.readCount,0);XCTAssertEqual(owner.commitCalls,0);XCTAssertEqual(lease.closeCount,1)}
    }
    func testCorrectAndEmptyAttachment()throws {
        let bytes=Data([0,1,2,3,255]);for value in [bytes,Data()] {let owner=Owner(),lease=Lease(chunks:value.isEmpty ? [nil]:[value,nil]),result=MobileSharedCapture.capture(itemJSON:try item(value),attempt:Attempt(),lease:lease,owner:owner);ack(result);XCTAssertEqual(owner.commitCalls,1);XCTAssertEqual(owner.state.committed["attempt"]?.3,value);XCTAssertEqual(lease.closeCount,1);XCTAssertEqual(lease.checkCount,lease.readCount*2+1)}
    }
    func testEarlyEOFExtraBytesEmptyChunkWrongDigestAndReadLimit()throws {
        let bytes=Data([0,1,2,3,255]),cases:[[Data?]]=[[Data([0]),nil],[bytes,Data([9])],[Data()], [Data([1,2,3,4,5]),nil]]
        for chunks in cases {let owner=Owner(),lease=Lease(chunks:chunks);held(MobileSharedCapture.capture(itemJSON:try item(bytes),attempt:Attempt(),lease:lease,owner:owner));XCTAssertEqual(owner.commitCalls,0);XCTAssertEqual(owner.abandonCalls,1);XCTAssertEqual(lease.closeCount,1)}
        let many=Data(repeating:7,count:4096),owner=Owner(),lease=Lease(chunks:Array(repeating:Data([7]),count:4096));held(MobileSharedCapture.capture(itemJSON:try item(many),attempt:Attempt(),lease:lease,owner:owner));XCTAssertEqual(lease.readCount,4096);XCTAssertEqual(owner.commitCalls,0);XCTAssertEqual(owner.abandonCalls,1)
    }
    func testCancellationHumanEpochPolicyAndLeaseLossDuringRead()throws {
        let bytes=Data([0,1,2,3,255]);for mode in 0..<5 {let owner=Owner(),lease=Lease(chunks:[bytes,nil]);lease.onRead={switch mode {case 0:owner.currentHuman="other";case 1:owner.epoch=2;case 2:owner.policy=false;case 3:owner.cancelled=true;default:lease.valid=false}}
            held(MobileSharedCapture.capture(itemJSON:try item(bytes),attempt:Attempt(),lease:lease,owner:owner));XCTAssertEqual(owner.commitCalls,0);XCTAssertEqual(owner.abandonCalls,1);XCTAssertEqual(lease.closeCount,1);XCTAssertTrue(owner.state.committed.isEmpty)}
    }
    func testQuotaBeforeReadAndFinalOwnerRecheck()throws {
        let bytes=Data([0,1,2,3,255]),owner=Owner();owner.legacyBytes=8*1024*1024;let lease=Lease(chunks:[bytes,nil]);held(MobileSharedCapture.capture(itemJSON:try item(bytes),attempt:Attempt(),lease:lease,owner:owner));XCTAssertEqual(lease.readCount,0);XCTAssertEqual(owner.commitCalls,0)
        let failing=Owner();failing.failAtCommit=true;let source=Lease(chunks:[bytes,nil]);held(MobileSharedCapture.capture(itemJSON:try item(bytes),attempt:Attempt(),lease:source,owner:failing));XCTAssertEqual(failing.commitCalls,1);XCTAssertEqual(failing.abandonCalls,0);XCTAssertTrue(failing.state.committed.isEmpty)
        let locked=Owner();locked.lockAtCommit=true;let lockedSource=Lease(chunks:[bytes,nil]);held(MobileSharedCapture.capture(itemJSON:try item(bytes),attempt:Attempt(),lease:lockedSource,owner:locked));XCTAssertEqual(locked.commitCalls,1);XCTAssertEqual(locked.abandonCalls,0);XCTAssertTrue(locked.state.committed.isEmpty)
        var huge=try XCTUnwrap(JSONSerialization.jsonObject(with:item()) as? [String:Any]),content=try XCTUnwrap(huge["content"] as? [String:Any]),artifact=try XCTUnwrap(content["artifact"] as? [String:Any]);artifact["byteLength"]=16777216;content["artifact"]=artifact;huge["content"]=content
        let capacity=Owner(),unread=Lease(chunks:[nil]);held(MobileSharedCapture.capture(itemJSON:try JSONSerialization.data(withJSONObject:huge),attempt:Attempt(),lease:unread,owner:capacity));XCTAssertEqual(unread.readCount,0);XCTAssertEqual(capacity.commitCalls,0)
        let expired=Lease(chunks:[bytes,nil]);expired.valid=false;let expiryOwner=Owner();held(MobileSharedCapture.capture(itemJSON:try item(bytes),attempt:Attempt(),lease:expired,owner:expiryOwner));XCTAssertEqual(expired.readCount,0);XCTAssertEqual(expiryOwner.commitCalls,0)
    }
    func testUnknownCommitRecoveryWithoutReusingExpiredLeaseAndWrongHuman()throws {
        let bytes=Data([0,1,2,3,255]),state=State(),owner=Owner(state);owner.unknownAfterCommit=true;let attempt=Attempt(),first=Lease(chunks:[bytes,nil]),input=try item(bytes)
        if case .commitUnknown = MobileSharedCapture.capture(itemJSON:input,attempt:attempt,lease:first,owner:owner) {} else {XCTFail("expected unknown")};XCTAssertEqual(owner.abandonCalls,0);XCTAssertEqual(owner.commitCalls,1)
        let restarted=Owner(state),expired=Lease(chunks:[]);expired.valid=false;ack(MobileSharedCapture.capture(itemJSON:input,attempt:attempt,lease:expired,owner:restarted));XCTAssertEqual(expired.readCount,0);XCTAssertEqual(expired.checkCount,0);XCTAssertEqual(expired.closeCount,1);XCTAssertEqual(restarted.commitCalls,0)
        let wrong=Owner(state);wrong.currentHuman="other";let denied=Lease(chunks:[]);held(MobileSharedCapture.capture(itemJSON:input,attempt:attempt,lease:denied,owner:wrong));XCTAssertEqual(denied.readCount,0);XCTAssertEqual(wrong.commitCalls,0)
        let noPolicy=Owner(state);noPolicy.policy=false;let denied2=Lease(chunks:[]);held(MobileSharedCapture.capture(itemJSON:input,attempt:attempt,lease:denied2,owner:noPolicy));XCTAssertEqual(denied2.readCount,0)
        let conflict=Lease(chunks:[]);held(MobileSharedCapture.capture(itemJSON:try item(Data([1])),attempt:attempt,lease:conflict,owner:restarted));XCTAssertEqual(conflict.readCount,0)
        let throwing=Owner();throwing.throwAfterCommit=true;let thrown=Lease(chunks:[bytes,nil]);if case .commitUnknown = MobileSharedCapture.capture(itemJSON:input,attempt:Attempt("throw"),lease:thrown,owner:throwing) {} else {XCTFail("throw after commit is unknown")};XCTAssertEqual(throwing.abandonCalls,0);XCTAssertEqual(throwing.state.committed.count,1)
    }
}
