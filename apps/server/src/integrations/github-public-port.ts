import {createHash,randomUUID} from 'node:crypto';
import {CloudSourceAdapter,SourceHttp} from '../knowledge-sources/cloud.ts';
import {GitHubPublicEnrollmentService,PUBLIC_REPOSITORY,PUBLIC_REPOSITORY_ID,PUBLIC_OWNER_ID} from '../knowledge-sources/github-public.ts';
import {digest,SourceError} from '../knowledge-sources/contracts.ts';
import type {Host,Request,Snapshot} from '../knowledge-sources/contracts.ts';
import type {CanonicalIntegrationOptions,IntegrationLease} from './canonical-integration.ts';
import {githubReadCommand} from './github-repository-port.ts';
type PublicResult={schemaVersion:'github-public-result:1.0.0';enrollmentRevision:number;ownerId:string;assistantId:string;relationshipId:string;repository:string;repositoryId:string;commit:string;paths:string[];evidenceRef:string;expiresAt:number;snapshots:Array<Omit<Snapshot,'text'>>;coverage:{kind:'selectedPaths';completeRepository:false;selected:number};sourceOnly:true;runtimeState:'unknown';profileAdmission:false;retention:'volatile60seconds'};
type Entry={holder?:symbol;bytes:Buffer;outputDigest:string;expiresAt:number;current:()=>void;timer:ReturnType<typeof setTimeout>};
/** Raw source has no disk representation. Buffer erasure is explicit; it is not
 * a claim about garbage-collected prompt strings, client copies or model KV. */
export class PublicEvidenceStore{
 private entries=new Map<string,Entry>();
 constructor(private now:()=>number=Date.now){}
 put(ref:string,value:Snapshot[],outputDigest:string,expiresAt:number,current:()=>void){const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>32000||this.entries.size>=64||this.entries.has(ref)){bytes.fill(0);throw new SourceError('github_public_retention_capacity');}const timer=setTimeout(()=>this.remove(ref),Math.max(1,expiresAt-this.now()));timer.unref();this.entries.set(ref,{bytes,outputDigest,expiresAt,current,timer});}
 remove(ref:string){const e=this.entries.get(ref);if(e){clearTimeout(e.timer);e.bytes.fill(0);this.entries.delete(ref);}}
 current(ref:string,outputDigest:string){const e=this.entries.get(ref);try{if(!e||e.expiresAt<=this.now()||e.outputDigest!==outputDigest)throw Error();e.current();return true;}catch{this.remove(ref);return false;}}
 /** Synchronous irreversible claim precedes any source admission. Only this
  * holder can inspect/release it; duplicate claims do not erase the holder. */
 claim(ref:string,outputDigest:string){
  if(!this.current(ref,outputDigest))throw new SourceError('github_public_evidence_expired');
  const entry=this.entries.get(ref)!;if(entry.holder)throw new SourceError('github_public_evidence_claimed');
  const holder=Symbol();entry.holder=holder;
  const owns=()=>this.entries.get(ref)===entry&&entry.holder===holder;
  const release=()=>{if(owns())this.remove(ref);};
  try{return {snapshots:JSON.parse(entry.bytes.toString('utf-8')) as Snapshot[],current:()=>owns()&&this.current(ref,outputDigest),release};}
  catch(error){release();throw error;}
 }
 prune(){for(const [ref,e]of this.entries){try{if(e.expiresAt<=this.now())throw Error();e.current();}catch{this.remove(ref);}}}
 close(){for(const ref of this.entries.keys())this.remove(ref);}
 get size(){return this.entries.size;}
}
function result(value:unknown):PublicResult{const v=value as PublicResult;if(!v||v.schemaVersion!=='github-public-result:1.0.0'||!Array.isArray(v.paths)||!Array.isArray(v.snapshots)||typeof v.evidenceRef!=='string'||!/^public-evidence:[a-f0-9-]{36}$/.test(v.evidenceRef)||v.repository!==PUBLIC_REPOSITORY||v.repositoryId!==PUBLIC_REPOSITORY_ID||!Number.isSafeInteger(v.expiresAt)||v.snapshots.some(s=>Object.hasOwn(s,'text')))throw new SourceError('github_public_result_invalid');return v;}
export function githubPublicRepositoryPort(service:GitHubPublicEnrollmentService,store=new PublicEvidenceStore(service.now)):NonNullable<CanonicalIntegrationOptions['repository']>{
 const unsubscribe=service.subscribeInvalidation(()=>store.close());
 const current=(value:unknown)=>{let v:PublicResult|undefined;try{v=result(value);const r=service.require(v.ownerId,v.assistantId,v.enrollmentRevision),valid=r.commit===v.commit&&v.paths.length===v.snapshots.length&&v.snapshots.every((s,i)=>s.item.id===v!.paths[i]&&service.sourceCurrent(r,s.item.id,s.sha256))&&store.current(v.evidenceRef,digest(v));if(!valid)store.remove(v.evidenceRef);return valid;}catch{if(v)store.remove(v.evidenceRef);return false;}};
 return {current,prune:()=>store.prune(),close:()=>{unsubscribe();store.close();},custodyRevision(value){const v=result(value),r=service.require(v.ownerId,v.assistantId,v.enrollmentRevision);return digest([r.id,r.revision,r.epoch,r.commit]);},
  async refresh(value,signal){const v=result(value);if(!current(v))throw new SourceError('github_public_evidence_expired');const r=service.require(v.ownerId,v.assistantId,v.enrollmentRevision);try{await service.verify(r,signal);}catch(error){store.remove(v.evidenceRef);throw error;}if(!current(v)||signal.aborted)throw new SourceError('github_public_evidence_expired');},
  evidence(value){const v=result(value);if(!current(v))throw new SourceError('github_public_evidence_expired');const claim=store.claim(v.evidenceRef,digest(v));try{return {text:JSON.stringify({type:'untrustedRepositoryObservation',repository:v.repository,commit:v.commit,coverage:v.coverage,sourceOnly:true,runtimeState:'unknown',profileAdmission:false,snapshots:claim.snapshots.map(s=>({path:s.item.id,citation:s.item.citation,sha256:s.sha256,text:s.text}))}),current:()=>claim.current()&&current(v),release:claim.release};}catch(error){claim.release();throw error;}},
  async read(input,lease:IntegrationLease){const c=githubReadCommand(input),s=c.scope,b=c.budget;
   if(c.retentionRef!=='finite:public-chat-60seconds'||s.userId!==lease.local.principalId||s.assistantId!==lease.invocation.scope.assistantId||!lease.retainedCurrent||!Number.isSafeInteger(lease.expiresAt)||!b||Object.keys(b).sort().join(',')!=='calls,durationMs,fileBytes,items,totalBytes'||Object.values(b).some(v=>!Number.isSafeInteger(v)||v<1)||b.calls<5||b.calls>60||b.items>20||b.fileBytes>8000||b.totalBytes>12000||b.durationMs>10000)throw new SourceError('github_public_scope_or_budget');
   const r=service.require(s.userId,s.assistantId,c.enrollmentRevision),signal=AbortSignal.any([lease.signal,AbortSignal.timeout(b.durationMs)]),started=Date.now(),check=()=>{signal.throwIfAborted();lease.current();};check();await service.verify(r,signal);check();
   const request:Request={key:lease.invocation.payload.invocationId,job:randomUUID(),actor:s.userId,source:r.sourceId,sourceRevision:r.revision,permissionRevision:r.revision,credentialEpoch:r.epoch,subject:s.userId,assistant:s.assistantId,relationship:s.relationshipId,audience:s.audience,context:s.context,operation:'snapshot',retentionRef:c.retentionRef,budget:{...b,calls:b.calls-4,durationMs:Math.max(1,b.durationMs-(Date.now()-started))}};
   const accepted=digest(request),source={id:r.sourceId,revision:r.revision,provider:'github-public' as const,account:r.id,principal:'public:github:'+PUBLIC_OWNER_ID,tenant:null,credentialRef:null,credentialEpoch:r.epoch,subject:s.userId,assistant:s.assistantId,relationship:s.relationshipId,audience:s.audience,context:s.context,items:c.paths,exclusions:[],container:PUBLIC_REPOSITORY,containerIdentity:PUBLIC_REPOSITORY_ID,commit:r.commit,localRepositoryRef:null,ready:service.current(r)};
   const host:Host={sources:()=>{lease.current();return [source];},binding:()=>null,family:(_source,path)=>digest([r.sourceId,PUBLIC_REPOSITORY_ID,path]),lifecycleCurrent:(_source,path,hash)=>service.sourceCurrent(r,path,hash),cancelled:()=>lease.signal.aborted,grant:q=>{lease.current();return digest(q)===accepted?{source:q.source,revision:q.permissionRevision,sourceRevision:q.sourceRevision,actor:q.actor,subject:q.subject,assistant:q.assistant,relationship:q.relationship,audience:q.audience,context:q.context,collect:true,process:true,retentionRef:q.retentionRef,downloadOrigins:[],expiresAt:Math.min(lease.expiresAt!,Date.parse(lease.invocation.deadlineAt)),revoked:false}:null;},authorize:(q,d)=>{lease.current();return d===accepted&&digest(q)===accepted?{digest:d,preparedInvocationRef:q.key,expiresAt:Date.parse(lease.invocation.deadlineAt)}:null;}};
   const snapshots=await new CloudSourceAdapter({host,http:new SourceHttp(service.http.fetch,null)}).readBatch(request,signal);check();await service.verify(r,signal);check();
   const expiresAt=Math.min(service.now()+60000,lease.expiresAt!),evidenceRef='public-evidence:'+randomUUID();const v:PublicResult={schemaVersion:'github-public-result:1.0.0',enrollmentRevision:r.revision,ownerId:s.userId,assistantId:s.assistantId,relationshipId:s.relationshipId,repository:PUBLIC_REPOSITORY,repositoryId:PUBLIC_REPOSITORY_ID,commit:r.commit,paths:c.paths,evidenceRef,expiresAt,snapshots:snapshots.map(({text:_text,...metadata})=>metadata),coverage:{kind:'selectedPaths',completeRepository:false,selected:snapshots.length},sourceOnly:true,runtimeState:'unknown',profileAdmission:false,retention:'volatile60seconds'};
   store.put(evidenceRef,snapshots,digest(v),expiresAt,lease.retainedCurrent);return v;
  }
 };
}
