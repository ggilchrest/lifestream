import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CanonicalGrantRepository } from '@lifestream/storage-sqlite';
import type { Database, CanonicalHumanContext, CanonicalGrant } from '@lifestream/storage-sqlite';
import type { CapabilityInvocationRequest } from '@lifestream/contracts/provider-messages';
import type { ProviderCallContext } from '@lifestream/runtime/ports/provider-messages';
import { canonicalJson } from '@lifestream/runtime/capabilities/schema-validation';
import { AuthenticationError } from '../auth/local-auth.ts';
import type { LocalAuthentication, LocalContext } from '../auth/local-auth.ts';
import type { CanonicalCapabilityComposition, CanonicalCapabilityPreparation } from '../authority/capability-preparation.ts';

const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
function deny():never{throw new AuthenticationError(403,'integration_custody_unavailable');}
function frozen<T>(value:T):T{const copy=structuredClone(value);function freeze(v:unknown):void{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}}freeze(copy);return copy;}
export type IntegrationLease={invocation:Readonly<CapabilityInvocationRequest>;local:Readonly<LocalContext>;signal:AbortSignal;expiresAt?:number;retainedCurrent?:()=>void;current():void};
/** Trusted, explicitly selected provider ports. Imported text cannot implement
 * these interfaces. No ambient transport, polling or credential fallback. */
export type CanonicalIntegrationOptions={
  enabled:true;
  capabilities:{repositoryRead:string};
  repository:{read(input:unknown,lease:IntegrationLease):Promise<unknown>;current(output:unknown):boolean;custodyRevision(output:unknown):string;refresh?(output:unknown,signal:AbortSignal):Promise<void>;evidence?(output:unknown):{text:string;current():boolean;release():void};prune?():void;close?():void};
};

/** Projects existing, verified canonical authority into P26/P27/P28 owner
 * repository interface. It neither creates authority nor accepts a receipt from HTTP. */
export class CanonicalIntegration {
  private readonly local=new AsyncLocalStorage<LocalContext>();
  private preparation:CanonicalCapabilityPreparation|undefined;
  private readonly grants:CanonicalGrantRepository;
  private closed=false;
  private readonly retirement=new AbortController();
  private readonly verifiedGrants=new Map<string,{sha256:string;grant:CanonicalGrant}>();
  constructor(private readonly db:Database,private readonly auth:LocalAuthentication,private readonly options:CanonicalIntegrationOptions,private readonly selected:()=>boolean,private readonly privateScope:(local:LocalContext)=>boolean=()=>false,private readonly privateBinding:(local:LocalContext)=>string=local=>local.sessionId){
    this.grants=new CanonicalGrantRepository(db,'local-human');
    const ids=Object.values(options.capabilities);if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!id))throw new Error('Explicit distinct integration capabilities required');
    if(!options.capabilities.repositoryRead||!options.repository)throw new Error('Integration capability/port mismatch');
    db.exec('CREATE TABLE IF NOT EXISTS integration_repository_custody(invocation_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,sha256 TEXT NOT NULL); CREATE TABLE IF NOT EXISTS integration_provider_evidence(reference TEXT PRIMARY KEY,payload TEXT NOT NULL,sha256 TEXT NOT NULL)');
  }
  // Persistent owner contexts use null as their canonical expiry; authentication
  // still rechecks the current policy, owner, origin and session below.
  withLocal<T>(local:LocalContext,action:()=>T):T{const row=this.db.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE token_hash=?').get(local.tokenHash);const current={...local,expiresAt:local.expiresAt===null?null:new Date(Number(row?.admin_last_activity)+1800000).toISOString()};this.auth.assertCurrent(current);return this.local.run(current,action);}
  attach(preparation:CanonicalCapabilityPreparation):void{this.preparation=preparation;}
  private human(local:LocalContext):CanonicalHumanContext{return {principalId:local.principalId,providerRef:'local-human',authenticationEvidenceRef:'',now:()=>new Date().toISOString(),assertCurrent:binding=>{
    const session=this.db.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE token_hash=?').get(local.tokenHash);this.auth.assertCurrent({...local,expiresAt:new Date(Number(session?.admin_last_activity)+1800000).toISOString()});if(this.closed||!this.selected()||!this.preparation||binding.sessionId!==local.sessionId||!this.auth.canAdminister(local,binding.assistantId))deny();this.preparation.assertCurrent(binding,local.principalId);
  }};}
  private grant(id:string,local:LocalContext):CanonicalGrant {
    const human=this.human(local),row=this.db.connection.prepare('SELECT payload_json,sha256 FROM canonical_grants WHERE grant_id=?').get(id);
    if(this.db.connection.isTransaction){
      // Builder admission owns this same synchronous SQLite transaction. Reuse
      // only a repository-verified snapshot with byte-identical current storage;
      // never open a nested transaction or authenticate raw JSON as a grant.
      const cached=this.verifiedGrants.get(id);if(!cached||!row||row.sha256!==cached.sha256||createHash('sha256').update(String(row.payload_json)).digest('hex')!==cached.sha256||!isDeepStrictEqual(JSON.parse(String(row.payload_json)),cached.grant))deny();
      human.assertCurrent(cached.grant);return structuredClone(cached.grant);
    }
    const grant=this.grants.inspectGrant(id,human);if(!row||!isDeepStrictEqual(JSON.parse(String(row.payload_json)),grant))deny();
    if(this.verifiedGrants.size>=1024)this.verifiedGrants.clear();this.verifiedGrants.set(id,{sha256:String(row.sha256),grant:structuredClone(grant)});return grant;
  }
  pruneRetained():void{this.options.repository?.prune?.();}
  close():void{if(this.closed)return;this.closed=true;this.retirement.abort(new AuthenticationError(503,'integration_retiring'));this.options.repository?.close?.();}
  private async call<T>(context:ProviderCallContext,action:(context:ProviderCallContext)=>Promise<T>):Promise<T>{
    if(this.closed)deny();const signal=AbortSignal.any([context.signal,this.retirement.signal]);
    const current:ProviderCallContext={...context,signal,isCurrent:scope=>!this.closed&&!signal.aborted&&context.isCurrent(scope)};
    let abort=()=>{};
    try{return await Promise.race([Promise.resolve().then(()=>{if(signal.aborted)deny();return action(current);}),new Promise<never>((_,reject)=>{abort=()=>reject(new AuthenticationError(503,'integration_retiring'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}
    finally{signal.removeEventListener('abort',abort);}
  }
  private repositoryCurrent(invocationId:string,local:LocalContext):void{
    if(!this.privateScope(local))deny();
    const row=this.db.connection.prepare('SELECT payload_json,sha256 FROM integration_repository_custody WHERE invocation_id=?').get(invocationId);if(!row)deny();
    const c=JSON.parse(String(row.payload_json)) as {output:unknown;revision:string;grantId:string;local:LocalContext};if(hash(c)!==row.sha256||c.local.principalId!==local.principalId||c.local.sessionId!==local.sessionId||!this.options.repository?.current(c.output)||c.revision!==this.options.repository.custodyRevision(c.output))deny();
    const scope=c.output as {ownerId?:string;assistantId?:string;relationshipId?:string};if(scope.ownerId!==local.principalId||!this.db.connection.prepare("SELECT 1 FROM assistant_relationships WHERE relationship_id=? AND assistant_id=? AND user_id=? AND json_extract(payload_json,'$.status')='active'").get(scope.relationshipId??'',scope.assistantId??'',local.principalId))deny();
    const g=this.grant(c.grantId,local);if(g.status!=='active'||g.grantClass!=='allowSession'||Date.parse(g.expiresAt)<=Date.now()||g.reviewAfter!==null&&Date.parse(g.reviewAfter)<=Date.now())deny();
  }
  async refreshRetainedAccess(invocationId:string,local:LocalContext,signal:AbortSignal):Promise<void>{
    this.assertRetainedAccess(invocationId,local);const row=this.db.connection.prepare('SELECT payload_json FROM integration_repository_custody WHERE invocation_id=?').get(invocationId);if(row&&this.options.repository?.refresh){const c=JSON.parse(String(row.payload_json)) as {output:unknown};await this.options.repository.refresh(c.output,signal);if(signal.aborted)deny();this.assertRetainedAccess(invocationId,local);}
  }
  async repositoryEvidence(invocationId:string,local:LocalContext,assistantId:string,relationshipId:string,signal:AbortSignal,current:()=>boolean){
    if(!current()||signal.aborted||!this.options.repository?.evidence)deny();this.assertRetainedAccess(invocationId,local);
    const row=this.db.connection.prepare('SELECT payload_json FROM integration_repository_custody WHERE invocation_id=?').get(invocationId);if(!row)deny();const c=JSON.parse(String(row.payload_json)) as {output:{assistantId:string;relationshipId:string}};if(c.output.assistantId!==assistantId||c.output.relationshipId!==relationshipId)deny();
    // Claim after local authority/scope checks, before any asynchronous refresh.
    // A duplicate cannot enter refresh and erase or invalidate the active holder.
    const evidence=this.options.repository.evidence(c.output);
    try{await this.refreshRetainedAccess(invocationId,local,signal);if(!current()||signal.aborted||!evidence.current())deny();return {text:evidence.text,current:()=>{try{this.assertRetainedAccess(invocationId,local);return current()&&evidence.current();}catch{return false;}},release:evidence.release};}
    catch(error){evidence.release();throw error;}
  }
  assertRetainedAccess(invocationId:string,local:LocalContext):void{
    this.pruneRetained();
    if(!this.preparation)return;
    const retained=this.preparation.retainedForResult(invocationId,local.principalId);
    if(retained.definition.capabilityId===this.options.capabilities.repositoryRead){
      const evidence=this.db.connection.prepare('SELECT 1 FROM integration_provider_evidence WHERE reference=?').get('urn:lifestream:integration-evidence:'+invocationId);
      if(evidence)this.repositoryCurrent(invocationId,local);return;
    }
  }

  wrap(composition:CanonicalCapabilityComposition):CanonicalCapabilityComposition{
    const owner=this,provider=composition.provider,governance=composition.governance;if(!governance)throw new Error('Integration requires existing provider governance');
    for(const id of Object.values(this.options.capabilities))if(!composition.adapters.some(a=>a.capabilityId===id))throw new Error('Integration adapter missing');
    const repositoryAdapter=composition.adapters.find(a=>a.capabilityId===this.options.capabilities.repositoryRead);if(this.options.repository&&(!repositoryAdapter||JSON.stringify(repositoryAdapter.allowedGrantClasses)!=='["allowSession"]'))throw new Error('Repository reads require an explicit finite-session-only adapter');
    return {...composition,provider:{
      getSnapshot:(request,context)=>owner.call(context,c=>provider.getSnapshot(request,c)),subscribeInvalidations:provider.subscribeInvalidations.bind(provider),
      async getInvocation(request,context){
        const local=owner.local.getStore();if(!local||!owner.preparation)return provider.getInvocation(request,context);
        const record=owner.preparation.retainedForResult(request.payload.invocationId,local.principalId);
        if(!Object.values(owner.options.capabilities).includes(record.definition.capabilityId))return provider.getInvocation(request,context);
        if(context.signal.aborted||!context.isCurrent(request.scope))deny();
        const view=owner.grants.dispatchView(request.payload.invocationId,owner.human(local));if(!view?.initialCallClaimed)deny();
        const reference='urn:lifestream:integration-evidence:'+request.payload.invocationId,row=owner.db.connection.prepare('SELECT payload,sha256 FROM integration_provider_evidence WHERE reference=?').get(reference),completedAt=new Date().toISOString();
        if(row)owner.assertRetainedAccess(request.payload.invocationId,local);
        const payload=row?{type:'succeeded' as const,invocationId:request.payload.invocationId,output:JSON.parse(String(row.payload)),outputSchema:record.outputSchema,confirmedAt:completedAt,evidenceRef:{reference,sha256:String(row.sha256),mediaType:'application/json',schemaRef:'urn:lifestream:integration-evidence:1',byteLength:Buffer.byteLength(String(row.payload))}}:{type:'outcomeUnknown' as const,invocationId:request.payload.invocationId,reason:{code:'integration_unknown',summary:'No retained completion evidence; no initial call replay is permitted.'},receiptRef:view.admission.receipt,reconciliationRef:'urn:lifestream:integration-status:'+request.payload.invocationId};
        if(row&&createHash('sha256').update(String(row.payload)).digest('hex')!==row.sha256)deny();
        return {schemaVersion:'1.0.0',operation:request.operation,requestId:request.requestId,correlationId:request.correlationId,providerRef:composition.providerRef,completedAt,outcome:{status:'succeeded',payload,error:null}};
      },
      async invoke(request,context){
        return owner.call(context,async context=>{
        if(!Object.values(owner.options.capabilities).includes(request.payload.capabilityId))return provider.invoke(request,context);
        const output=await owner.execute(request,context);if(context.signal.aborted||!context.isCurrent(request.scope))deny();if(request.payload.capabilityId===owner.options.capabilities.repositoryRead){const local=owner.local.getStore();if(!local)deny();owner.repositoryCurrent(request.payload.invocationId,local);}const bytes=Buffer.from(JSON.stringify(output)),digest=createHash('sha256').update(bytes).digest('hex'),reference='urn:lifestream:integration-evidence:'+request.payload.invocationId;
        owner.db.durableTransaction(tx=>tx.run('INSERT INTO integration_provider_evidence VALUES (?,?,?)',reference,bytes.toString('utf8'),digest));
        const completedAt=new Date().toISOString(),adapter=composition.adapters.find(a=>a.capabilityId===request.payload.capabilityId&&a.version===request.payload.capabilityVersion)!;
        return {schemaVersion:'1.0.0',operation:request.operation,requestId:request.requestId,correlationId:request.correlationId,providerRef:composition.providerRef,completedAt,outcome:{status:'succeeded',payload:{type:'succeeded',invocationId:request.payload.invocationId,output:output as never,outputSchema:adapter.outputSchema,confirmedAt:completedAt,evidenceRef:{reference,sha256:digest,mediaType:'application/json',schemaRef:'urn:lifestream:integration-evidence:1',byteLength:bytes.length}},error:null}};
        });
      }
    },governance:{evaluate:(request,context)=>owner.call(context,c=>governance.evaluate(request,c)),assertCurrent:governance.assertCurrent.bind(governance),async readEvidence(ref,request,context){
      if(!ref.reference.startsWith('urn:lifestream:integration-evidence:'))return governance.readEvidence(ref,request,context);
      const row=owner.db.connection.prepare('SELECT payload,sha256 FROM integration_provider_evidence WHERE reference=?').get(ref.reference);if(!row||row.sha256!==ref.sha256||createHash('sha256').update(String(row.payload)).digest('hex')!==ref.sha256)deny();return Buffer.from(String(row.payload));
    }}};
  }
  private async execute(invocation:CapabilityInvocationRequest,context:ProviderCallContext):Promise<unknown>{
    const local=this.local.getStore();if(!local||!this.preparation)deny();
    const view=this.grants.dispatchView(invocation.payload.invocationId,this.human(local));
    const record=this.preparation.retainedForResult(invocation.payload.invocationId,local.principalId);
    if(!view?.initialCallClaimed||!isDeepStrictEqual(view.admission.receipt,invocation.payload.dispatchReceipt)||!isDeepStrictEqual(record.input,invocation.payload.input)||!isDeepStrictEqual(record.proposal.request.scope,invocation.payload.operationScope)||record.proposal.request.inputDigest!==invocation.payload.inputDigest||record.definition.capabilityId!==invocation.payload.capabilityId)deny();
    const grantId=view.admission.request.payload.grantId;if(!grantId)deny();
    const retainedBinding=this.privateBinding(local);
    const retainedCurrent=()=>{this.auth.assertCurrent(local);const g=this.grant(grantId,local);if(this.closed||!this.selected()||!this.privateScope(local)||this.privateBinding(local)!==retainedBinding||g.status!=='active'||g.grantClass!=='allowSession'||Date.parse(g.expiresAt)<=Date.now()||g.reviewAfter!==null&&Date.parse(g.reviewAfter)<=Date.now())deny();};
    const lease:IntegrationLease={invocation:frozen(invocation),local:frozen(local),signal:context.signal,expiresAt:Date.parse(this.grant(grantId,local).expiresAt),retainedCurrent,current:()=>{
      if(this.closed||context.signal.aborted||!context.isCurrent(invocation.scope)||invocation.payload.capabilityId===this.options.capabilities.repositoryRead&&(!this.privateScope(local)||this.privateBinding(local)!==retainedBinding))deny();const g=this.grant(grantId,local);if(g.status==='revoked'||Date.parse(g.expiresAt)<=Date.now()||g.reviewAfter!==null&&Date.parse(g.reviewAfter)<=Date.now())deny();
    }};lease.current();
    const preparedInput=frozen(record.input);
      if(invocation.payload.capabilityId===this.options.capabilities.repositoryRead){
        const grant=this.grant(grantId,local);if(grant.grantClass!=='allowSession'||grant.status!=='active')deny();
        const input=preparedInput as {scope?:{userId?:string;assistantId?:string;relationshipId?:string}};if(!input.scope||input.scope.userId!==local.principalId||input.scope.assistantId!==invocation.scope.assistantId||!this.db.connection.prepare("SELECT 1 FROM assistant_relationships WHERE relationship_id=? AND assistant_id=? AND user_id=? AND json_extract(payload_json,'$.status')='active'").get(input.scope.relationshipId??'',invocation.scope.assistantId,local.principalId))deny();
        const output=await this.options.repository!.read(preparedInput,lease);lease.current();if(!this.options.repository!.current(output))deny();
        const custody={output,revision:this.options.repository!.custodyRevision(output),grantId,local};
        this.db.durableTransaction(tx=>{lease.current();if(!this.options.repository!.current(output))deny();if(Number(tx.get<{n:number}>('SELECT COUNT(*) AS n FROM integration_repository_custody')?.n)>=4096)deny();tx.run('INSERT INTO integration_repository_custody VALUES (?,?,?)',invocation.payload.invocationId,JSON.stringify(custody),hash(custody));});
        return frozen(output);
      }
      deny();
  }
}
