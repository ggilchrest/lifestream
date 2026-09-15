import {createHash} from 'node:crypto';
import {resolveCapabilitySchema} from './schema-artifacts.ts';
import type {CapabilitySchemaStore} from './schema-artifacts.js';
import {boundedJson,canonicalJson,validateCapabilitySchema} from './schema-validation.ts';
import type { DispatchReceipt } from '../authority/authorize-dispatch.js';
import type {CapabilityDefinition,CapabilityInvocation,CapabilityInvocationResult,CapabilityProvider,CapabilityScope,CapabilitySnapshot,CapabilityCallContext,CapabilityStatusRequest} from './ports.js';
import {CapabilitySnapshotCache} from './cache.ts';
import {CapabilityCall,CapabilityCallError} from './call.ts';
export type AuthorityDispatcher=(invocation:CapabilityInvocation,capability:CapabilityDefinition,context:CapabilityCallContext)=>Promise<DispatchReceipt|undefined>;
export function capabilityInputDigest(input: unknown): string {
  if (!boundedJson(input)) throw new CapabilityCallError('invalidResponse');
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}
const scopeKey=(scope:CapabilityScope)=>JSON.stringify([scope.assistantId,scope.endpointId,scope.sessionId,scope.environment,scope.authorityContextRef.providerRef,scope.authorityContextRef.contextId,scope.authorityContextRef.revision]);
const statusRequest=(scope:CapabilityScope,invocationId:string):CapabilityStatusRequest=>({assistantId:scope.assistantId,endpointId:scope.endpointId,sessionId:scope.sessionId,environment:scope.environment,authorityContextRef:structuredClone(scope.authorityContextRef),invocationId});
type Attempt={fingerprint:string;attempted:boolean;capability?:CapabilityDefinition;pending?:Promise<CapabilityInvocationResult>};
async function checkedCapabilityResult(result:CapabilityInvocationResult,request:CapabilityStatusRequest,call:CapabilityCall,schemaStore?:CapabilitySchemaStore,capability?:CapabilityDefinition):Promise<CapabilityInvocationResult>{
    if(result.invocationId!==request.invocationId||!['authorized','denied','approvalRequired','started','succeeded','failed','outcomeUnknown'].includes(result.lifecycle))throw new CapabilityCallError('invalidResponse');
    if(!boundedJson(result)||result.lifecycle!=='succeeded'&&(Object.hasOwn(result,'output')||Object.hasOwn(result,'outputSchema')))throw new CapabilityCallError('invalidResponse');
    const copy=structuredClone(result);
    if(copy.lifecycle==='succeeded'){
      let schema=capability?.outputSchema;
      if(copy.outputSchema!==undefined){
        if(capability?.outputSchemaRef&&canonicalJson(copy.outputSchema)!==canonicalJson(capability.outputSchemaRef))throw new CapabilityCallError('invalidResponse');
        const resolved=await resolveCapabilitySchema(copy.outputSchema,request,call,schemaStore);
        if(schema!==undefined&&canonicalJson(schema)!==canonicalJson(resolved))throw new CapabilityCallError('invalidResponse');
        schema=resolved;
      }else if(capability?.outputSchemaRef)throw new CapabilityCallError('invalidResponse');
      if(schema===undefined||!await call.wait(()=>validateCapabilitySchema(schema,copy.output,call.context.signal)))throw new CapabilityCallError('invalidResponse');
    }
    call.check();return copy;

}
/** Revalidate recorded output under current scope without rediscovery or I/O. */
export async function validateRecordedCapabilityResult(result:CapabilityInvocationResult,request:CapabilityStatusRequest,context:CapabilityCallContext,schemaStore?:CapabilitySchemaStore):Promise<CapabilityInvocationResult>{
  const call=new CapabilityCall(context);
  try{return await checkedCapabilityResult(result,request,call,schemaStore);}finally{call.close();}
}

export class CapabilityResolver {
  private readonly provider:CapabilityProvider;
  private readonly cache:CapabilitySnapshotCache;
  private readonly dispatch:AuthorityDispatcher;
  private readonly now:()=>string;
  private readonly schemaStore:CapabilitySchemaStore|undefined;
  private epoch=0;
  private readonly reads=new Map<string,symbol>();
  private readonly modes=new Map<string,CapabilityCallContext["executionMode"]>();
  private readonly attempts=new Map<string,Attempt>();
  constructor(provider:CapabilityProvider,cache=new CapabilitySnapshotCache(),dispatch:AuthorityDispatcher=async()=>undefined,now:()=>string=()=>new Date().toISOString(),schemaStore?:CapabilitySchemaStore){
    this.provider=provider;this.cache=cache;this.dispatch=dispatch;this.now=now;this.schemaStore=schemaStore;
  }
  async snapshot(scope:CapabilityScope,context:CapabilityCallContext):Promise<CapabilitySnapshot>{
    const owned=structuredClone(scope),key=scopeKey(owned),ticket=Symbol(),call=new CapabilityCall(context);
    if(this.reads.size>=32&&!this.reads.has(key))this.invalidate();
    this.reads.set(key,ticket);const epoch=this.epoch;
    try{
      const result=await call.wait(()=>this.provider.getSnapshot({...owned,now:this.now()},call.context));
      if(epoch!==this.epoch||this.reads.get(key)!==ticket)throw new CapabilityCallError('scopeChanged');
      if(typeof result.snapshotId!=="string"||!result.snapshotId||!Number.isInteger(result.revision)||result.revision<0||Buffer.byteLength(JSON.stringify(result))>262144||scopeKey(result)!==key||!Number.isFinite(Date.parse(result.expiresAt))||Date.parse(result.expiresAt)<=Date.parse(this.now())||!Array.isArray(result.capabilities)||result.capabilities.length>100)throw new CapabilityCallError('invalidResponse');
      const definitions = structuredClone(result);
      const identities = new Set<string>();
      for (const capability of definitions.capabilities) {
        const identity = capability.id + ':' + capability.version;
        if((capability.inputSchemaRef!==undefined)!==(capability.outputSchemaRef!==undefined))throw new CapabilityCallError('invalidResponse');
        await this.checkSchemaBinding(capability.inputSchemaRef,capability.inputSchema,owned,call);
        await this.checkSchemaBinding(capability.outputSchemaRef,capability.outputSchema,owned,call);
        if (identities.has(identity) || !await call.wait(() => validateCapabilitySchema(capability.inputSchema, null, call.context.signal, true)) || !await call.wait(() => validateCapabilitySchema(capability.outputSchema, null, call.context.signal, true))) throw new CapabilityCallError('invalidResponse');
        identities.add(identity);
      }
      if(epoch!==this.epoch||this.reads.get(key)!==ticket)throw new CapabilityCallError('scopeChanged');
      this.modes.set(key,call.context.executionMode);return this.cache.put(definitions,this.now());
    }catch(error){if(this.reads.get(key)===ticket)this.invalidate(owned);throw error;}finally{call.close();}
  }
  invalidate(scope?:CapabilityScope):void{this.epoch++;this.cache.invalidate(scope);if(scope){this.reads.delete(scopeKey(scope));this.modes.delete(scopeKey(scope));}else{this.reads.clear();this.modes.clear();}}
  async invoke(invocation:CapabilityInvocation,context:CapabilityCallContext):Promise<CapabilityInvocationResult>{
    if (!boundedJson(invocation.input)) return this.result(invocation,'denied','capability_or_arguments_invalid');
    const owned=structuredClone(invocation),key=scopeKey(owned)+':'+owned.invocationId;
    const fingerprint=createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(owned)))).digest('hex');
    let entry=this.attempts.get(key);
    if(entry&&entry.fingerprint!==fingerprint)return this.result(owned,'denied','invocation_identity_reused');
    if(!entry){if(this.attempts.size>=1024)return this.result(owned,'denied','invocation_tracking_full');entry={fingerprint,attempted:false};this.attempts.set(key,entry);}
    const call=new CapabilityCall(context);
    try{
      call.check();
      if(entry.pending)return await call.wait(()=>entry!.pending!);
      const pending=this.perform(owned,entry,call);entry.pending=pending;
      try{return await pending;}finally{delete entry.pending;}
    }catch(error){return this.result(owned,entry.attempted?'outcomeUnknown':'denied',error instanceof CapabilityCallError?error.code:'providerUnavailable');}
    finally{call.close();}
  }
  private async perform(invocation:CapabilityInvocation,entry:Attempt,call:CapabilityCall):Promise<CapabilityInvocationResult>{
    const epoch=this.epoch,snapshot=this.cache.get(invocation,this.now());
    const fresh=()=>{call.check();const latest=this.cache.get(invocation,this.now());if(epoch!==this.epoch||!latest||latest.snapshotId!==snapshot?.snapshotId||latest.revision!==snapshot?.revision)throw new CapabilityCallError('scopeChanged');};
    if(this.modes.get(scopeKey(invocation))!==call.context.executionMode||!snapshot||snapshot.snapshotId!==invocation.snapshotId||snapshot.revision!==invocation.snapshotRevision)return this.result(invocation,'denied','capability_snapshot_stale_or_unbound');
    if(call.context.executionMode!=='live')return this.result(invocation,'denied','non_live_dispatch_denied');
    const capability=snapshot.capabilities.find(item=>item.id===invocation.capabilityId&&item.version===invocation.capabilityVersion);
    if(!capability||!await call.wait(()=>validateCapabilitySchema(capability.inputSchema,invocation.input,call.context.signal)))return this.result(invocation,'denied','capability_or_arguments_invalid');
    await this.checkSchemaBinding(capability.inputSchemaRef,capability.inputSchema,invocation,call);
    fresh();entry.capability=capability;
    // Status is read under current scope before consuming any one-use admission.
    const prior=await call.wait(()=>this.provider.getInvocation(statusRequest(invocation,invocation.invocationId),call.context));fresh();
    if(prior){entry.attempted||=['started','succeeded','outcomeUnknown'].includes(prior.lifecycle);const checked=await this.checkedResult(prior,invocation,call,capability);fresh();return checked;}
    if(entry.attempted)return this.result(invocation,'outcomeUnknown','prior_dispatch_requires_reconciliation');
    let dispatchReceipt:DispatchReceipt|null=null;
    if(capability.sideEffect!=='none'||capability.authorization==='required'){
      const receipt=await call.wait(()=>this.dispatch(structuredClone(invocation),structuredClone(capability),call.context));fresh();
      if(!receipt)return this.result(invocation,'approvalRequired','current_authority_decision_required');
      if(receipt.invocationId===invocation.invocationId&&receipt.status==='unknown'){
        entry.attempted=true;
        return this.result(invocation,'outcomeUnknown','prior_dispatch_requires_reconciliation');
      }
      if(receipt.invocationId!==invocation.invocationId||receipt.status!=='admitted'||!Number.isInteger(receipt.grantRevision)||receipt.grantRevision<0)return this.result(invocation,'denied','dispatch_not_admitted');
      dispatchReceipt=structuredClone(receipt);
    }
    fresh();
    const outcome=await call.wait(()=>{entry.attempted=true;return this.provider.invoke({...structuredClone(invocation),dispatchReceipt},structuredClone(capability),call.context);});
    fresh();const checked=await this.checkedResult(outcome,invocation,call,capability);fresh();return checked;
  }
  async getInvocation(request:CapabilityStatusRequest,context:CapabilityCallContext):Promise<CapabilityInvocationResult|undefined>{
    const owned=statusRequest(request,request.invocationId),call=new CapabilityCall(context);
    try{const result=await call.wait(()=>this.provider.getInvocation(owned,call.context));return result?await this.checkedResult(result,owned,call,this.attempts.get(scopeKey(owned)+':'+owned.invocationId)?.capability):undefined;}finally{call.close();}
  }
  private async checkedResult(result:CapabilityInvocationResult,request:CapabilityStatusRequest,call:CapabilityCall,capability?:CapabilityDefinition):Promise<CapabilityInvocationResult>{
    return checkedCapabilityResult(result,request,call,this.schemaStore,capability);
  }
  private async checkSchemaBinding(reference:CapabilityDefinition['inputSchemaRef'],schema:CapabilityDefinition['inputSchema'],scope:CapabilityScope,call:CapabilityCall):Promise<void>{
    if(reference!==undefined&&canonicalJson(await resolveCapabilitySchema(reference,scope,call,this.schemaStore))!==canonicalJson(schema))throw new CapabilityCallError('invalidResponse');
  }
  private result(invocation:CapabilityStatusRequest,lifecycle:CapabilityInvocationResult['lifecycle'],reason:string):CapabilityInvocationResult{return {invocationId:invocation.invocationId,lifecycle,reason};}
}
