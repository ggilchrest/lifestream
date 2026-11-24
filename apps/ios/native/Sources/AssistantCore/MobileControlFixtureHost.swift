import Foundation

/// Injectable source-only host for disposable tests. It has no runtime bridge,
/// does not start a platform SDK, cannot clear a journal, and does not retry.
/// Future production integration must provide native-authenticated context and
/// durable restriction enforcement; none is provided by this type.
final class MobileControlFixtureHost {
 enum Failure:Error {case currentness,restrictionRequired,transport,invalid}
 typealias Scope=HealthOriginalControlJournal.Scope
 struct Context:Equatable {let scope:Scope,transportEpoch:Int,contextRevision:Int,ordinarySelf:Bool}
 typealias Exchange=(Data)throws->(status:Int,body:Data)
 private let journal:HealthOriginalControlJournal
 private let current:()->Context?
 private let restrict:(MobileHealthLocalRestriction.Plan)throws->Void
 private let exchange:Exchange
 init(journal:HealthOriginalControlJournal,current:@escaping()->Context?,restrict:@escaping(MobileHealthLocalRestriction.Plan)throws->Void,exchange:@escaping Exchange){self.journal=journal;self.current=current;self.restrict=restrict;self.exchange=exchange}
 /// A terminal response is observation only; persisted uncertainty remains.
 func apply(original:Data,context:Context,proof:MobileHealthPolicyProof?)throws->MobileControlReceipt.Settlement {
  guard context.ordinarySelf,context.transportEpoch>=0,context.contextRevision>=0,current()==context else{throw Failure.currentness};let scope=context.scope,request=try MobileControlOriginal.parse(original)
  guard request.principal==scope.principal,request.endpoint==scope.endpoint,let object=try JSONSerialization.jsonObject(with:request.canonical) as? [String:Any],let target=object["target"] as? [String:Any],target["collector"] as? String == "healthKit",let action=object["action"] as? [String:Any],let kind=action["kind"] as? String else{throw Failure.invalid}
  if kind=="configure" || kind=="remove" {guard let proof else{throw Failure.restrictionRequired};let plan=try MobileHealthLocalRestriction.plan(original:request.canonical,proof:proof);try restrict(plan)}
  guard current()==context else{throw Failure.currentness}
  try journal.prepare(scope:scope,original:request.canonical)
  let retained=try journal.original(scope:scope);guard current()==context else{throw Failure.currentness}
  let encoded=try MobileControlOriginal.envelope(MobileControlOriginal.parse(retained),reconciliation:false)
  let response=try exchange(encoded);guard current()==context else{return .held};guard response.status==200 else{return .held}
  return MobileControlReceipt.assess(expected:retained,response:response.body)
 }
 /// Caller supplies a freshly verified ordinary-self scope. This never rewrites
 /// the original endpoint or session and never grants or clears anything.
 func reconcile(context:Context)throws->MobileControlReceipt.Settlement {
  guard context.ordinarySelf,context.transportEpoch>=0,context.contextRevision>=0,current()==context else{throw Failure.currentness}
  let retained=try journal.reconciliationOriginalAfterTrustedSelfCheck(serverDigest:context.scope.serverDigest,principal:context.scope.principal)
  guard current()==context else{throw Failure.currentness}
  let response=try exchange(MobileControlOriginal.envelope(MobileControlOriginal.parse(retained),reconciliation:true))
  guard current()==context,response.status==200 else{return .held};return MobileControlReceipt.assess(expected:retained,response:response.body)
 }
}
