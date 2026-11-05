import { SourceError,digest,field,positive,sha256,supportedMime,text,uuid } from './contracts.ts';
import type { Binding,Host,Item,Request,Snapshot,Source } from './contracts.ts';

export class SourceAdmission {
  private readonly host:Host;readonly now:()=>number;
  constructor(host:Host,now:()=>number=Date.now){this.host=host;this.now=now;}
  current(r:Request,item:string|null=null,hash:string|null=null):{source:Source;binding:Binding|null;downloadOrigins:string[]}{
    const sources=this.host.sources(),ids=new Set<string>();if(!Array.isArray(sources)||sources.length>1000)throw new SourceError('source_registry_invalid');
    for(const s of sources){if(!uuid(s.id)||ids.has(s.id)||!positive(s.revision)||!uuid(s.account)||!text(s.principal)||!positive(s.credentialEpoch)||!uuid(s.subject)||!uuid(s.assistant)||!uuid(s.relationship)||!text(s.audience)||!text(s.context)||!text(s.container)||!text(s.containerIdentity)||!['drive','onedrive','github','github-public','git'].includes(s.provider)||!Array.isArray(s.items)||s.items.length>20||s.items.some(v=>!text(v,300))||new Set(s.items).size!==s.items.length||!Array.isArray(s.exclusions)||s.exclusions.length>1000||s.exclusions.some(v=>!text(v,300)))throw new SourceError('source_registry_invalid');ids.add(s.id);}
    const s=sources.find(s=>s.id===r.source),now=this.now();
    if(!s||!s.ready||!Number.isSafeInteger(now)||!text(r.key)||!uuid(r.job)||!uuid(r.actor)||!uuid(r.subject)||!uuid(r.assistant)||!uuid(r.relationship)||!text(r.audience)||!text(r.context)||!['inventory','snapshot'].includes(r.operation)||s.revision!==r.sourceRevision||s.credentialEpoch!==r.credentialEpoch||s.subject!==r.subject||s.assistant!==r.assistant||s.relationship!==r.relationship||s.audience!==r.audience||s.context!==r.context)throw new SourceError('source_scope_binding');
    const g=this.host.grant(r);if(!g||g.revoked||!positive(g.expiresAt)||g.expiresAt<=now||g.source!==s.id||g.sourceRevision!==s.revision||g.revision!==r.permissionRevision||g.actor!==r.actor||g.subject!==r.subject||g.assistant!==r.assistant||g.relationship!==r.relationship||g.audience!==r.audience||g.context!==r.context||g.collect!==true)throw new SourceError('source_collection_denied');
    if(r.operation==='snapshot'&&(g.process!==true||!text(r.retentionRef)||g.retentionRef!==r.retentionRef))throw new SourceError('source_process_retention_denied');
    if(r.operation==='inventory'&&r.retentionRef!==null)throw new SourceError('inventory_retention_unselected');
    if(this.host.cancelled(r.job,r.key)||!this.host.lifecycleCurrent(s,item,hash))throw new SourceError('source_lifecycle_closed');
    if(item!==null&&(!s.items.includes(item)||s.exclusions.includes(item)))throw new SourceError('source_item_excluded');
    const a=this.host.authorize(r,digest(r));if(!a||a.digest!==digest(r)||!text(a.preparedInvocationRef)||!positive(a.expiresAt)||a.expiresAt<=now)throw new SourceError('source_canonical_authority');
    const budget=r.budget;if(!positive(budget.items)||budget.items>20||!positive(budget.fileBytes)||budget.fileBytes>256000||!positive(budget.totalBytes)||budget.totalBytes>1_000_000||!positive(budget.calls)||budget.calls>100||!positive(budget.durationMs)||budget.durationMs>10000)throw new SourceError('source_budget_invalid');
    let binding:Binding|null=null;
    if(s.provider==='git'){if(s.credentialRef!==null||!text(s.localRepositoryRef)||!s.commit||!/^[0-9a-f]{40}$/.test(s.commit))throw new SourceError('local_git_route_unselected');}
    else if(s.provider==='github-public'){if(s.credentialRef!==null||this.host.binding(s)!==null||s.localRepositoryRef!==null||s.container!=='ggilchrest/lifestream'||s.containerIdentity!=='1343370271'||s.principal!=='public:github:45693305'||s.tenant!==null||!s.commit||!/^[a-f0-9]{40}$/.test(s.commit))throw new SourceError('github_public_binding');}
    else{binding=this.host.binding(s);if(!text(s.credentialRef)||!binding||binding.account!==s.account||binding.principal!==s.principal||binding.tenant!==s.tenant||binding.credentialRef!==s.credentialRef||binding.credentialEpoch!==s.credentialEpoch||!positive(binding.expiresAt)||binding.expiresAt<=now)throw new SourceError('source_credential_binding');
      const scopes=s.provider==='drive'?['https://www.googleapis.com/auth/drive.readonly','https://www.googleapis.com/auth/drive.file']:s.provider==='onedrive'?['Files.Read','Files.Read.All','Files.ReadWrite','Files.ReadWrite.All']:['contents:read'];
      if(!scopes.some(v=>binding!.scopes.includes(v)))throw new SourceError('source_provider_scope');
      if(s.provider==='github'&&(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.container)||!s.commit||!/^[0-9a-f]{40}$/.test(s.commit)))throw new SourceError('github_immutable_route');
    }
    if(!Array.isArray(g.downloadOrigins)||g.downloadOrigins.some(v=>{try{const u=new URL(v);return u.protocol!=='https:'||u.origin!==v||u.username!==''||u.password!=='';}catch{return true;}}))throw new SourceError('source_download_origins_invalid');
    return {source:structuredClone(s),binding:binding?structuredClone(binding):null,downloadOrigins:[...g.downloadOrigins]};
  }
  family(source:Source,item:string):string{const family=this.host.family(source,item);if(!text(family))throw new SourceError('source_lineage_unavailable');return family;}
}
/** Per-call collection lease and counters are outside source/model control. */
export class Collection {
  readonly admission:SourceAdmission;readonly request:Request;readonly signal:AbortSignal;private readonly started:number;private readonly realStarted=Date.now();private readonly sourceDigest:string;private calls=0;private bytes=0;
  constructor(admission:SourceAdmission,request:Request,signal:AbortSignal){this.admission=admission;this.request=structuredClone(request);this.signal=signal;this.started=admission.now();this.sourceDigest=digest(admission.current(request).source);}
  current(item:string|null=null,hash:string|null=null):ReturnType<SourceAdmission['current']>{
    if(this.signal.aborted||this.admission.now()-this.started>=this.request.budget.durationMs||Date.now()-this.realStarted>=this.request.budget.durationMs)throw new SourceError('source_collection_cancelled_or_expired');
    const state=this.admission.current(this.request,item,hash);if(digest(state.source)!==this.sourceDigest)throw new SourceError('source_registry_changed');return state;
  }
  remainingMs():number{return Math.max(1,this.request.budget.durationMs-Math.max(this.admission.now()-this.started,Date.now()-this.realStarted));}
  call(item:string|null=null):void{this.current(item);if(++this.calls>this.request.budget.calls)throw new SourceError('source_call_budget');}
  consume(count:number):void{if(!Number.isSafeInteger(count)||count<0||count>this.request.budget.fileBytes||this.bytes+count>this.request.budget.totalBytes)throw new SourceError('source_byte_budget');this.bytes+=count;}
  item(item:Item):void{this.current(item.id);if(!supportedMime(item.mime)||!text(item.revision)||!text(item.name,255)||item.bytes!==null&&(!Number.isSafeInteger(item.bytes)||item.bytes<0||item.bytes>this.request.budget.fileBytes))throw new SourceError('source_format_or_size_unqualified');}
  snapshot(item:Item,bytes:Uint8Array):Snapshot{
    if(this.request.operation!=='snapshot')throw new SourceError('source_snapshot_operation');this.item(item);this.consume(bytes.byteLength);let content:string;try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new SourceError('source_utf8_unqualified');}
    if(content.includes('\0')||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|(?:^|\n)\s*(?:password|api[-_]?key|access[-_]?token|private[-_]?key|credential|secret)\s*[:=]\s*\S+/i.test(content))throw new SourceError('source_sensitive_content_excluded');
    const hash=sha256(bytes),state=this.current(item.id,hash),family=this.admission.family(state.source,item.id);if(family!==item.family)throw new SourceError('source_lineage_changed');
    return {protocol:'source-snapshot-v1',job:this.request.job,collectionKey:this.request.key,source:state.source.id,sourceRevision:state.source.revision,permissionRevision:this.request.permissionRevision,credentialEpoch:this.request.credentialEpoch,provider:state.source.provider,account:state.source.account,subject:this.request.subject,assistant:this.request.assistant,relationship:this.request.relationship,audience:this.request.audience,context:this.request.context,item:structuredClone(item),sha256:hash,collectedAt:new Date(this.admission.now()).toISOString(),parser:'utf8-selected-v1',text:content,evidenceBasis:'observation',authoredBy:'unknown',untrusted:true,active:false,approvedUse:null,retentionRef:field(this.request.retentionRef)};
  }
}
