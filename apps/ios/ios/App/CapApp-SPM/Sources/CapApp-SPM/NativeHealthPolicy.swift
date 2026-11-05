import Foundation
import AssistantCore

protocol NativeHealthPolicySuspending { func suspendForPolicyRefresh(enrollment: UUID) }

/// Native-only policy refresh. Its caller supplies the endpoint only from trusted
/// native session context; it is checked again against the server on both sides of the request.
/// No method here requests HealthKit permission or starts collection.
final class NativeHealthPolicy {
    enum Failure: Error { case currentness, unavailable, denied }
    private let transport: NativeTransport
    private let outbox: HealthOutbox
    private let collector: NativeHealthPolicySuspending
    init(transport:NativeTransport,outbox:HealthOutbox,collector:NativeHealthPolicySuspending) { self.transport=transport;self.outbox=outbox;self.collector=collector }
    func reconcile(enrollment:UUID, expectedEndpoint:UUID, completion:@escaping(Result<MobileHealthPolicyProof,Error>)->Void) {
        fetch(enrollment:enrollment,expectedEndpoint:expectedEndpoint,confirmForCollection:true,completion:completion)
    }
    /// Read current policy for an explicit owner control while keeping the local
    /// collector and outbox fenced. This never admits or resumes collection.
    func readForControl(enrollment:UUID, expectedEndpoint:UUID, completion:@escaping(Result<MobileHealthPolicyProof,Error>)->Void) {
        fetch(enrollment:enrollment,expectedEndpoint:expectedEndpoint,confirmForCollection:false,completion:completion)
    }
    private func fetch(enrollment:UUID, expectedEndpoint:UUID, confirmForCollection:Bool, completion:@escaping(Result<MobileHealthPolicyProof,Error>)->Void) {
        DispatchQueue.main.async { [self] in
            collector.suspendForPolicyRefresh(enrollment:enrollment)
            guard transport.effectiveIsSelf,let owner=transport.currentEffectiveOwner,let principal=UUID(uuidString:owner.principal) else { completion(.failure(Failure.currentness));return }
            let epoch=transport.epoch
            func current()->Bool { guard transport.epoch==epoch,transport.effectiveIsSelf,let now=transport.currentEffectiveOwner else{return false};return now.principal==owner.principal && now.session==owner.session }
            func context(_ done:@escaping(Result<Int,Error>)->Void) {
                transport.request("/api/runtime/v1/session-context",maxBytes:65536) { response in
                    guard current() else { done(.failure(Failure.currentness));return }
                    guard case .success(let (bytes,http))=response,http.statusCode==200,
                          let json=try? JSONSerialization.jsonObject(with:bytes) as? [String:Any],let revision=json["revision"] as? Int,revision>=0,
                          let endpoint=json["endpoint"] as? [String:Any],let id=endpoint["endpointId"] as? String,UUID(uuidString:id)==expectedEndpoint else { done(.failure(Failure.unavailable));return }
                    done(.success(revision))
                }
            }
            context { first in
                guard case .success(let initialRevision)=first,current() else { completion(.failure(Failure.currentness));return }
                do {
                    let bytes=try MobileHealthWire.policyRequest(enrollment:enrollment)
                    guard let body=String(data:bytes,encoding:.utf8) else { throw Failure.unavailable }
                    transport.request(MobileHealthWire.path,method:"POST",body:body,internalHealth:true,maxBytes:65536) { response in
                        guard current(),case .success(let (data,http))=response,http.statusCode==200,
                              let proof=try? MobileHealthPolicyParser.parse(data,expectedPrincipal:principal,expectedEndpoint:expectedEndpoint,expectedEnrollment:enrollment) else { completion(.failure(Failure.unavailable));return }
                        context { second in
                            guard current(),case .success(let finalRevision)=second,finalRevision==initialRevision else { completion(.failure(Failure.currentness));return }
                            // A valid inactive/unbound policy is displayable but never grants a ticket.
                            guard confirmForCollection,proof.permitsCollection else { completion(.success(proof));return }
                            do { try outbox.confirmEffectivePolicy(proof:proof);completion(.success(proof)) }
                            catch { completion(.failure(error)) }
                        }
                    }
                } catch { completion(.failure(error)) }
            }
        }
    }
}
