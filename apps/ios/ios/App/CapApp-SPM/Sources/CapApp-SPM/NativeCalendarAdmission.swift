import Foundation
import CoreFoundation
import AssistantCore

enum NativeCalendarAdmissionError:Error {case invalid, stale, unavailable}

/// Read numeric lexemes before Foundation can round a fractional token to
/// an integral Double. No arbitrary-precision arithmetic or floating point.
struct NativeCalendarSnapshotNumbers {
    let values: [[String]:String]
    init(_ data: Data) throws {var reader=Reader(bytes:Array(data));values=try reader.read()}
    func integer(_ path: [String]) -> Int? {
        guard let raw=values[path],raw.range(of:"^-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?$",options:.regularExpression) != nil else{return nil}
        let exponentParts=raw.lowercased().split(separator:"e",maxSplits:1,omittingEmptySubsequences:false)
        var mantissa=String(exponentParts[0]);let negative=mantissa.hasPrefix("-");if negative{mantissa.removeFirst()}
        let parts=mantissa.split(separator:".",maxSplits:1,omittingEmptySubsequences:false),fraction=parts.count==2 ? String(parts[1]):""
        var digits=Array((String(parts[0])+fraction).utf8).drop(while:{$0==48}).map{$0}
        if digits.isEmpty{return 0}
        guard !negative else{return nil}
        var exponent=0
        if exponentParts.count==2 {
            var text=String(exponentParts[1]);let minus=text.hasPrefix("-")
            if text.hasPrefix("-") || text.hasPrefix("+"){text.removeFirst()}
            text=String(text.drop(while:{$0=="0"}))
            let magnitude=text.count>6 ? 1000000:(Int(text) ?? 0);exponent=minus ? -magnitude:magnitude
        }
        let scale=exponent-fraction.utf8.count
        if scale>=0 {guard digits.count+scale<=16 else{return nil};digits.append(contentsOf:repeatElement(UInt8(48),count:scale))}
        else {let remove = -scale;guard remove<=digits.count,digits.suffix(remove).allSatisfy({$0==48}) else{return nil};digits.removeLast(remove)}
        guard !digits.isEmpty,digits.count<=16,let value=Int(String(decoding:digits,as:UTF8.self)),value<=9007199254740991 else{return nil};return value
    }
    private struct Reader {
        let bytes: [UInt8]
        var index=0,values: [[String]:String]=[:]
        mutating func spaces(){while index<bytes.count,[9,10,13,32].contains(bytes[index]){index+=1}}
        mutating func take(_ byte: UInt8) -> Bool {spaces();if index<bytes.count,bytes[index]==byte{index+=1;return true};return false}
        mutating func string() throws -> String {
            spaces();let start=index;guard take(34) else{throw NativeCalendarAdmissionError.invalid}
            while index<bytes.count {
                let byte=bytes[index];index+=1
                if byte==34 {guard let text=try JSONSerialization.jsonObject(with:Data(bytes[start..<index]),options:.fragmentsAllowed) as? String else{throw NativeCalendarAdmissionError.invalid};return text}
                if byte==92 {guard index<bytes.count else{throw NativeCalendarAdmissionError.invalid};index+=1}
                else if byte<32 {throw NativeCalendarAdmissionError.invalid}
            }
            throw NativeCalendarAdmissionError.invalid
        }
        mutating func value(_ path: [String],_ depth: Int) throws {
            guard depth<64 else{throw NativeCalendarAdmissionError.invalid};spaces();guard index<bytes.count else{throw NativeCalendarAdmissionError.invalid}
            if take(123) {
                if take(125){return};var seen=Set<Data>()
                repeat {let key=try string();guard seen.insert(Data(key.utf8)).inserted,take(58) else{throw NativeCalendarAdmissionError.invalid};try value(path+[key],depth+1);if take(125){return};guard take(44) else{throw NativeCalendarAdmissionError.invalid}}while true
            }
            if take(91) {
                if take(93){return};var count=0
                repeat {try value(path+["[\(count)]"],depth+1);count+=1;if take(93){return};guard take(44) else{throw NativeCalendarAdmissionError.invalid}}while true
            }
            if bytes[index]==34 {_=try string();return}
            for text in ["true","false","null"] {
                let literal=Array(text.utf8)
                if bytes[index...].starts(with:literal){index+=literal.count;return}
            }
            let start=index
            while index<bytes.count,![9,10,13,32,44,93,125].contains(bytes[index]){index+=1}
            guard index>start else{throw NativeCalendarAdmissionError.invalid}
            let token=String(decoding:bytes[start..<index],as:UTF8.self)
            guard token.range(of:"^-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?$",options:.regularExpression) != nil else{throw NativeCalendarAdmissionError.invalid}
            values[path]=token
        }
        mutating func read() throws -> [[String]:String] {try value([],0);spaces();guard index==bytes.count else{throw NativeCalendarAdmissionError.invalid};return values}
    }
}

/// Shared exact Auth/session parser. It performs no I/O and creates no grant.
enum NativeCalendarContext {
    struct Auth:Equatable {let subject:Data,reference:String}
    struct Snapshot:Equatable {let epoch:Int,subject:Data,reference:String,revision:Int,generation:Int,endpointRevision:Int}
    static func number(_ value:Any?,_ tokens:NativeCalendarSnapshotNumbers,_ path:[String])->Int? {
        guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),let exact=tokens.integer(path),n.int64Value==Int64(exact) else{return nil};return exact
    }
    static func bool(_ value:Any?,_ expected:Bool)->Bool{guard let n=value as? NSNumber,CFGetTypeID(n)==CFBooleanGetTypeID() else{return false};return n.boolValue==expected}
    static func auth(_ data:Data,human:UUID,session:UUID)throws->Auth {
        guard data.count<=65536,let value=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let numbers=try? NativeCalendarSnapshotNumbers(data),
              let pin=value["producerPin"] as? [String:String],pin==["schemaId":"https://lifestream.dev/contracts/effective-subject/1.0.0","schemaVersion":"1.0.0","digest":"ed098cad970a310a807881ea7a833b96f1c980e8377ee3cfcbdffd68f2bd0cf9"],
              bool(value["impersonating"],false),let subject=value["context"] as? [String:Any],Set(subject.keys)==Set(["schemaVersion","actorId","effectiveUserId","authenticatedSessionId","installationId","authorityRevision","generation","issuedAt"]),subject["schemaVersion"] as? String=="1.0.0",
              UUID(uuidString:subject["actorId"] as? String ?? "")==human,UUID(uuidString:subject["effectiveUserId"] as? String ?? "")==human,UUID(uuidString:subject["authenticatedSessionId"] as? String ?? "")==session,UUID(uuidString:subject["installationId"] as? String ?? "") != nil,
              number(subject["authorityRevision"],numbers,["context","authorityRevision"]) != nil,number(subject["generation"],numbers,["context","generation"]) != nil,
              let actor=value["actor"] as? [String:Any],let effective=value["effectiveUser"] as? [String:Any],UUID(uuidString:actor["principalId"] as? String ?? "")==human,UUID(uuidString:effective["principalId"] as? String ?? "")==human,
              let reference=value["contextRef"] as? String,!reference.isEmpty,reference.utf8.count<=512,let issued=subject["issuedAt"] as? String,issued.hasSuffix("Z"),
              let canonical=try? JSONSerialization.data(withJSONObject:subject,options:[.sortedKeys,.withoutEscapingSlashes]) else{throw NativeCalendarAdmissionError.invalid}
        let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
        if f.date(from:issued)==nil{f.formatOptions=[.withInternetDateTime];guard f.date(from:issued) != nil else{throw NativeCalendarAdmissionError.invalid}}
        return Auth(subject:canonical,reference:reference)
    }
    static func session(_ data:Data,auth:Auth,endpoint:UUID,epoch:Int)throws->Snapshot {
        guard data.count<=65536,let value=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let numbers=try? NativeCalendarSnapshotNumbers(data),bool(value["ended"],false),let revision=number(value["revision"],numbers,["revision"]),let generation=number(value["contextGeneration"],numbers,["contextGeneration"]),let e=value["endpoint"] as? [String:Any],UUID(uuidString:e["endpointId"] as? String ?? "")==endpoint,e["privacyClass"] as? String=="personal",let er=number(e["configurationRevision"],numbers,["endpoint","configurationRevision"]) else{throw NativeCalendarAdmissionError.invalid}
        return Snapshot(epoch:epoch,subject:auth.subject,reference:auth.reference,revision:revision,generation:generation,endpointRevision:er)
    }
    static func policy(_ data:Data,human:UUID,endpoint:UUID,enrollment:UUID)throws->MobileCalendarPolicyProof {
        let tokens=try NativeCalendarSnapshotNumbers(data)
        guard let r=tokens.integer(["result","enrollment","revision"]),r>0,tokens.integer(["result","effective","policyRevision"])==r else{throw NativeCalendarAdmissionError.invalid}
        return try MobileCalendarPolicyParser.parse(data,expectedPrincipal:human,expectedEndpoint:endpoint,expectedEnrollment:enrollment)
    }
}

/// Pure policy read owner: no box, admission, confirmation, SDK or storage input.
final class NativeCalendarAdmission {
    private let transport:NativeTransport
    private let config:NativeCalendarAcquisitionOwner.Configuration
    private let current:()->Bool
    private let epoch:Int
    private var terminal=false,cancelled=false,started=false
    private var pending=0,drainScheduled=false,drainPublished=false,drainRegistered=false
    private var drain:(()->Void)?
    init(transport:NativeTransport,configuration:NativeCalendarAcquisitionOwner.Configuration,current:@escaping()->Bool){self.transport=transport;config=configuration;self.current=current;epoch=transport.epoch}
    func cancel(){precondition(Thread.isMainThread);cancelled=true}
    /// Exactly one owning Runtime observes the real request-handler retirement.
    func whenDrained(_ done:@escaping()->Void){
        precondition(Thread.isMainThread);precondition(!drainRegistered)
        drainRegistered=true;drain=done;publishDrain()
    }
    private func begin(){pending+=1}
    private func end(){pending-=1;precondition(pending>=0);publishDrain()}
    private func publishDrain(){
        guard terminal,pending==0,drainRegistered,!drainScheduled,!drainPublished else{return}
        drainScheduled=true
        // Pending reaches zero from a handler's defer. Publication must follow
        // the COMPLETE original handler return, not just its nested completion.
        DispatchQueue.main.async{[self] in
            drainScheduled=false
            guard terminal,pending==0,!drainPublished else{return}
            drainPublished=true;let done=drain;drain=nil;done?()
        }
    }
    private func complete(_ result:Result<MobileCalendarPolicyProof,Error>,done:(Result<MobileCalendarPolicyProof,Error>)->Void){
        guard !terminal else{return};terminal=true;done(result);publishDrain()
    }
    private func live()->Bool {
        guard !terminal,!cancelled,current(),transport.epoch==epoch,transport.endpoint?.absoluteString==config.origin,transport.effectiveIsSelf,let owner=transport.currentEffectiveOwner else{return false}
        return !terminal && !cancelled && UUID(uuidString:owner.principal)==config.human && UUID(uuidString:owner.session)==config.session
    }
    private func snapshot(_ done:@escaping(Result<NativeCalendarContext.Snapshot,Error>)->Void){
        guard live() else{done(.failure(NativeCalendarAdmissionError.stale));return}
        var claimed=false
        begin()
        transport.request("/api/auth/v1/user-context",maxBytes:65536){[self] result in
            guard !claimed else{return};claimed=true;defer{end()}
            guard live(),case .success(let(data,http))=result,http.statusCode==200,let auth=try? NativeCalendarContext.auth(data,human:config.human,session:config.session) else{done(.failure(NativeCalendarAdmissionError.stale));return}
            var sessionClaimed=false
            begin()
            transport.request("/api/runtime/v1/session-context",maxBytes:65536){[self] result in
                guard !sessionClaimed else{return};sessionClaimed=true;defer{end()}
                guard live(),case .success(let(data,http))=result,http.statusCode==200,let snapshot=try? NativeCalendarContext.session(data,auth:auth,endpoint:config.endpoint,epoch:epoch) else{done(.failure(NativeCalendarAdmissionError.stale));return}
                done(.success(snapshot))
            }
        }
    }
    func read(_ done:@escaping(Result<MobileCalendarPolicyProof,Error>)->Void){
        precondition(Thread.isMainThread)
        guard !started else{done(.failure(NativeCalendarAdmissionError.invalid));return};started=true
        snapshot{[self] initial in
            guard live(),case .success(let first)=initial else{complete(.failure(NativeCalendarAdmissionError.stale),done:done);return}
            let request:[String:Any]=["producerPin":["schemaId":MobileCalendarDelivery.schemaId,"schemaVersion":"1.0.0","digest":MobileCalendarDelivery.schemaDigest],"operation":"calendar","payload":["schemaVersion":"1.0.0","operation":"policy","enrollmentId":config.enrollment.uuidString.lowercased()]]
            guard let data=try? JSONSerialization.data(withJSONObject:request),let body=String(data:data,encoding:.utf8) else{complete(.failure(NativeCalendarAdmissionError.invalid),done:done);return}
            var claimed=false
            begin()
            transport.request("/api/runtime/v1/mobile-context",method:"POST",body:body,internalHealth:true,maxBytes:65536){[self] result in
                guard !claimed else{return};claimed=true;defer{end()}
                guard live(),case .success(let(data,http))=result,http.statusCode==200,let proof=try? NativeCalendarContext.policy(data,human:config.human,endpoint:config.endpoint,enrollment:config.enrollment),proof.namespace==config.namespace,proof.collector=="eventKit" else{complete(.failure(NativeCalendarAdmissionError.unavailable),done:done);return}
                snapshot{[self] final in
                    guard live(),case .success(let second)=final,second==first else{complete(.failure(NativeCalendarAdmissionError.stale),done:done);return}
                    complete(.success(proof),done:done)
                }
            }
        }
    }
}

