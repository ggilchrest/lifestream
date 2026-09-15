import { createContractValidator } from "@lifestream/contracts";
import { isDeepStrictEqual } from "node:util";
import type { InitiativeOpportunity, InitiativeDeliveryRepository, InitiativeInferenceLimits, Transaction } from "@lifestream/storage-sqlite";
import type { InferenceProvider, InferenceRequest, InferenceChunk } from "@lifestream/runtime/inference";
import { buildCanonicalPrompt, type InitiativePrompt } from "@lifestream/runtime/inference/prompt";
import type { HostRuntimeInput } from "./inference.ts";

export type InitiativeGenerationInput = {
  opportunity: InitiativeOpportunity; prepared: HostRuntimeInput; interactionId: string;
  dimensions: Omit<InitiativePrompt,"opportunityId"|"kind">; maximumOutputTokens: number; deadlineMs: number;
  conversation: string; voiceMode: boolean; signal: AbortSignal;
  /** Durable one-call admission, inference budgets and pinned owner scope. No body grants. */
  admit: (request: InferenceRequest) => boolean;
  /** Host cleanup, after the provider iterator actually settles, never just on abort. */
  settled?: () => void;
};
export type InitiativeCandidate = { status: "generated"; text: string; request: InferenceRequest; outputBytes: number } | { status: "noCandidate"; request: InferenceRequest; outputBytes: number };
const validator=createContractValidator();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** One existing-provider call at a time. This produces a volatile candidate, never
 * output or a user turn. The host still owns policy, durable admission and delivery. */
export class InitiativeCandidateGenerator {
  private busy=false;
  private releaseFailure:unknown;
  get active():boolean{return this.busy;}
  get settlementFailure():unknown{return this.releaseFailure;}
  /** Host-facing path: the same ledger serializes different generators/SQLite clients.
   * The caller owns eligible-state preparation and final delivery policy. */
  generateDurably(provider:InferenceProvider,input:Omit<InitiativeGenerationInput,"admit"|"settled">,admission:{ledger:InitiativeDeliveryRepository;expectedVersion:number;limits:InitiativeInferenceLimits;current:(tx:Transaction)=>boolean}):Promise<InitiativeCandidate>{
    let claimId:string|undefined;
    return this.generate(provider,{...input,admit:()=>{
      if(!isDeepStrictEqual(admission.ledger.get(input.opportunity,input.opportunity.opportunityId)?.opportunity,input.opportunity))throw new Error("Initiative opportunity does not match its admitted record");
      claimId=admission.ledger.reserveInference(input.opportunity,input.opportunity.opportunityId,admission.expectedVersion,admission.limits,admission.current);
      return true;
    },settled:()=>{
      if(claimId)admission.ledger.settleInference(input.opportunity,input.opportunity.opportunityId,claimId);
    }});
  }
  async generate(provider:InferenceProvider,input:InitiativeGenerationInput):Promise<InitiativeCandidate>{
    if(this.busy)throw new Error("Initiative generation is occupied");
    const {opportunity,prepared}=input,view=prepared.preparedRelationshipContext,self=prepared.runtimeSelfContext;
    if(!validator.validate("https://lifestream.dev/contracts/relational-initiative/1.0.0#/$defs/RelationalOpportunity",opportunity).valid||!uuid.test(input.interactionId)||opportunity.executionMode==="replay")throw new Error("Invalid Initiative generation scope");
    if(input.signal.aborted||prepared.isCurrent()!==true||prepared.assistantId!==opportunity.assistantId||prepared.endpointId!==opportunity.endpointId||self.endpointId!==opportunity.endpointId||self.endpointScope!=="sessionEndpoint"||self.audienceScope!=="authenticatedSession"||self.permissionState!=="authenticatedSession"||!prepared.profileProjection||!view)throw new Error("Current scoped Initiative context is required");
    // Binding formats are those emitted by the existing relationship owner.
    if(!view.relationshipRevision.startsWith(`${opportunity.relationshipId}:`)||view.configurationRevision!==`${opportunity.configurationId}:${opportunity.configurationRevision}`)throw new Error("Initiative prepared relationship or configuration mismatch");
    if(!Number.isInteger(input.maximumOutputTokens)||input.maximumOutputTokens<32||input.maximumOutputTokens>256||!Number.isInteger(input.deadlineMs)||input.deadlineMs<1000||input.deadlineMs>15000)throw new Error("Invalid Initiative generation limits");
    const now=Date.now(),expires=Date.parse(opportunity.expiresAt),viewExpiry=Date.parse(String("freshUntil" in view?view.freshUntil:""));
    if(!Number.isFinite(viewExpiry)||viewExpiry<=now)throw new Error("Initiative prepared context expired");
    const deadline=Math.min(now+input.deadlineMs,expires,viewExpiry);
    if(Date.parse(opportunity.observedAt)>now||Date.parse(opportunity.receivedAt)>now||deadline<=now)throw new Error("Initiative opportunity expired");
    const request=buildCanonicalPrompt({assistantId:opportunity.assistantId,sessionId:opportunity.sessionId,interactionId:input.interactionId,endpointId:opportunity.endpointId,origin:"relationalOpportunity",initiative:{...input.dimensions,opportunityId:opportunity.opportunityId,kind:opportunity.kind},runtimeSelfContext:self,profileProjection:prepared.profileProjection,preparedRelationshipContext:view,conversation:input.conversation,capabilities:"No tools, acquisition, configuration changes or additional contact are available for this social opening.",voiceMode:input.voiceMode,maximumOutputTokens:input.maximumOutputTokens,deadlineAt:new Date(deadline).toISOString()});
    this.busy=true;
    const controller=new AbortController(),signal=AbortSignal.any([input.signal,controller.signal]);
    let iterator:AsyncIterator<InferenceChunk>|undefined,pending:Promise<IteratorResult<InferenceChunk>>|undefined,admitted=false;
    let timeout:ReturnType<typeof setTimeout>|undefined,abortListener:(()=>void)|undefined;
    try{
      if(input.admit(request)!==true)throw new Error("Initiative durable generation admission denied");
      admitted=true;
      if(signal.aborted||prepared.isCurrent()!==true||Date.now()>=deadline)throw new Error("Initiative context changed before inference");
      const aborted=new Promise<never>((_,reject)=>{abortListener=()=>reject(new Error("Initiative generation cancelled or timed out"));signal.addEventListener("abort",abortListener,{once:true});});
      // Admission bookkeeping can itself abort before the first iterator wait.
      void aborted.catch(()=>undefined);
      timeout=setTimeout(()=>controller.abort(),Math.max(1,deadline-Date.now()));
      try{prepared.onInferenceRequest?.(request);}catch{/* Optional inclusion bookkeeping grants no delivery authority. */}
      if(signal.aborted||prepared.isCurrent()!==true)throw new Error("Initiative context changed before inference");
      iterator=provider.generate(request,{signal})[Symbol.asyncIterator]();
      let text="",done=false;
      while(true){
        pending=Promise.resolve(iterator.next());const item=await Promise.race([pending,aborted]);
        if(signal.aborted||prepared.isCurrent()!==true||Date.now()>=deadline)throw new Error("Initiative context changed during generation");
        if(item.done)break;
        if(done)throw new Error("Initiative output after terminal event");
        const chunk=item.value;
        if(chunk.kind==="text"){
          text+=chunk.text??"";
          // Same conservative UTF-8 upper-bound estimator as the canonical manifest.
          if(Buffer.byteLength(text)>input.maximumOutputTokens)throw new Error("Initiative output exceeds conservative token budget");
        }else if(chunk.kind==="done")done=true;
        else throw new Error("Initiative generation failed or requested a capability");
      }
      if(!done)throw new Error("Initiative generation has no successful terminal");
      if(!text.trim())return {status:"noCandidate",request,outputBytes:Buffer.byteLength(text)};
      return {status:"generated",text,request,outputBytes:Buffer.byteLength(text)};
    }finally{
      if(timeout)clearTimeout(timeout);if(abortListener)signal.removeEventListener("abort",abortListener);controller.abort();
      // An uncooperative provider must not free the shared social slot merely because
      // the caller's deadline elapsed. Release only after actual iterator settlement.
      const release=()=>{
        try{if(admitted)input.settled?.();this.busy=false;}
        catch(error){this.releaseFailure=error;/* Keep the slot occupied if durable settlement failed. */}
      };
      if(iterator){const stream=iterator;void (pending??Promise.resolve()).catch(()=>undefined).then(()=>stream.return?.()).catch(()=>undefined).then(release);}
      else release();
    }
  }
}
