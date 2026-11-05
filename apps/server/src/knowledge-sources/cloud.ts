import { createHash } from 'node:crypto';
import { Collection,SourceAdmission } from './admission.ts';
import { SourceError,array,field,object,safeName,safePath,same,supportedMime,text } from './contracts.ts';
import type { Adapter,Binding,Host,Item,Request,Snapshot,Source } from './contracts.ts';

export type SourceToken={provider:Source['provider'];account:string;principal:string;tenant:string|null;credentialRef:string;credentialEpoch:number;expiresAt:number;token:string};
export type SourceBroker=(source:Source,binding:Binding,signal:AbortSignal)=>Promise<SourceToken>;
/** Scoped GET-only byte transport. Cloud/account APIs are separate from P27
 * consent. No ambient fetch, account discovery, POST, credential creation or
 * inference-provider egress exists. Signed download capabilities stay internal. */
export class SourceHttp {
  private readonly transport:typeof fetch;private readonly broker:SourceBroker|null;
  constructor(transport:typeof fetch,broker:SourceBroker|null){this.transport=transport;this.broker=broker;}
  async get(c:Collection,item:string,url:string,mode:'json'|'bytes',download=false,headers:Record<string,string>={}):Promise<unknown>{
    return this.acquire(c,item,url,mode,download,headers);
  }
  private async acquire(c:Collection,item:string,url:string,mode:'json'|'bytes',download:boolean,headers:Record<string,string>,parentSignal?:AbortSignal):Promise<unknown>{
    c.call(item);const {source:s,binding:b,downloadOrigins}=c.current(item),u=new URL(url),enc=encodeURIComponent;
    if(mode==='bytes'&&c.request.operation!=='snapshot')throw new SourceError('source_snapshot_operation');
    if(u.protocol!=='https:'||u.username||u.password||u.hash)throw new SourceError('source_url_invalid');
    const allowed=s.provider==='drive'?u.origin==='https://www.googleapis.com'&&(u.pathname==='/drive/v3/files/'+enc(item)||u.pathname==='/drive/v3/files/'+enc(item)+'/export'):s.provider==='onedrive'?u.origin==='https://graph.microsoft.com'&&(u.pathname==='/v1.0/drives/'+enc(s.container)+'/items/'+enc(item)||u.pathname==='/v1.0/drives/'+enc(s.container)+'/items/'+enc(item)+'/content'):(s.provider==='github'||s.provider==='github-public')?u.origin==='https://api.github.com'&&(u.pathname==='/repos/'+s.container||u.pathname==='/repos/'+s.container+'/contents/'+item.split('/').map(enc).join('/')&&u.searchParams.get('ref')===s.commit||u.pathname==='/repos/'+s.container+'/git/commits/'+s.commit&&u.search===''||u.pathname.startsWith('/repos/'+s.container+'/git/trees/')&&/^[0-9a-f]{40}$/.test(u.pathname.slice(('/repos/'+s.container+'/git/trees/').length))&&u.search===''):false;
    if(download){if(s.provider!=='onedrive'||!downloadOrigins.includes(u.origin)||mode!=='bytes')throw new SourceError('source_download_egress_unselected');}
    else if(!allowed||(s.provider!=='github-public'&&!b))throw new SourceError('source_provider_route');
    const controller=new AbortController(),signal=AbortSignal.any([c.signal,controller.signal,...(parentSignal?[parentSignal]:[])]);let timer:ReturnType<typeof setTimeout>|undefined;
    let response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,complete=false,closed=false;
    const cancelled=new WeakSet<ReadableStream<Uint8Array>>();
    // Cancel while the reader owns its lock. Cleanup cannot await a provider's
    // uncooperative cancel hook or mask the original current-denial/error.
    const discard=()=>{const body=response?.body;if(!body||complete||cancelled.has(body))return;cancelled.add(body);try{const pending=reader?reader.cancel():body.cancel();void pending.catch(()=>{});}catch{/* Abort still terminates a conforming transport. */}};
    let stop:((error:SourceError)=>void)|undefined,deadlineError:SourceError|undefined;
    const onAbort=()=>{closed=true;discard();stop?.(deadlineError??new SourceError('source_collection_cancelled_or_expired'));};
    const stopped=new Promise<never>((_,reject)=>{stop=reject;signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();timer=setTimeout(()=>{deadlineError=new SourceError('source_collection_deadline');controller.abort();},c.remainingMs());});
    const work=async():Promise<unknown>=>{
      const outgoing=new Headers(headers);if(Object.keys(headers).some(key=>key.toLowerCase()!=='accept'))throw new SourceError('source_headers_invalid');
      if(!download&&s.provider!=='github-public'){if(!this.broker)throw new SourceError('source_credential_binding');const token=await this.broker(s,b!,signal);c.current(item);
        if(signal.aborted||token.provider!==s.provider||token.account!==s.account||token.principal!==s.principal||token.tenant!==s.tenant||token.credentialRef!==s.credentialRef||token.credentialEpoch!==s.credentialEpoch||token.expiresAt<=c.admission.now()||!Number.isSafeInteger(token.expiresAt)||!text(token.token,4096))throw new SourceError('source_token_binding');outgoing.set('Authorization','Bearer '+token.token);
      }
      if(s.provider==='github-public'&&(b!==null||this.broker!==null||outgoing.has('authorization')))throw new SourceError('github_public_auth_refused');
      if((s.provider==='github'||s.provider==='github-public')){outgoing.set('X-GitHub-Api-Version','2022-11-28');if(!outgoing.has('Accept'))outgoing.set('Accept','application/vnd.github+json');}
      c.current(item);if(signal.aborted)throw new SourceError('source_collection_cancelled_or_expired');
      try{response=await this.transport(u,{method:'GET',headers:outgoing,redirect:'manual',signal});}catch{throw new SourceError('source_transport_unavailable');}
      // A transport can resolve after abort even if it ignored the signal.
      if(closed||signal.aborted){discard();throw new SourceError('source_collection_cancelled_or_expired');}
      c.current(item);if(signal.aborted)throw new SourceError('source_collection_cancelled_or_expired');
      if(response.status===302&&!download&&s.provider==='onedrive'&&u.pathname.endsWith('/content')){
        const location=response.headers.get('location');discard();if(!location)throw new SourceError('source_download_location_missing');
        // One explicit bounded redirect; no account token is forwarded to CDN.
        return this.acquire(c,item,location,'bytes',true,{},signal);
      }
      if(response.status>=300&&response.status<400)throw new SourceError('source_redirect_refused');
      if(!response.ok)throw new SourceError('source_http_'+response.status);
      const max=mode==='json'?Math.min(c.request.budget.fileBytes,64000):c.request.budget.fileBytes,length=response.headers.get('content-length');
      if(length!==null&&(!/^\d+$/.test(length)||Number(length)>max))throw new SourceError('source_response_bound');
      reader=response.body?.getReader();const chunks:Uint8Array[]=[];let count=0;
      if(reader)try{for(;;){const next=await reader.read();c.current(item);if(signal.aborted)throw new SourceError('source_collection_cancelled_or_expired');if(next.done){complete=true;break;}count+=next.value.byteLength;if(count>max)throw new SourceError('source_response_bound');chunks.push(next.value);}}finally{if(!complete)discard();reader.releaseLock();reader=undefined;}
      c.consume(count);const bytes=Buffer.concat(chunks);if(mode==='bytes')return bytes;
      if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))throw new SourceError('source_json_type');try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new SourceError('source_json_invalid');}
    };
    try{return await Promise.race([work(),stopped]);}catch(error){closed=true;controller.abort();discard();throw error;}finally{closed=true;if(timer)clearTimeout(timer);signal.removeEventListener('abort',onAbort);}
  }
}
const eventDate=(value:unknown):string|null=>{if(value===undefined||value===null)return null;const date=field(value,100);if(!Number.isFinite(Date.parse(date)))throw new SourceError('source_date_invalid');return date;};
const size=(value:unknown):number|null=>{if(value===undefined||value===null)return null;const n=typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;if(!Number.isSafeInteger(n)||Number(n)<0)throw new SourceError('source_size_invalid');return Number(n);};

export class CloudSourceAdapter implements Adapter {
  private readonly admission:SourceAdmission;private readonly http:SourceHttp;
  constructor(options:{host:Host;http:SourceHttp;now?:()=>number}){this.admission=new SourceAdmission(options.host,options.now);this.http=options.http;}
  private async githubBlob(c:Collection,id:string):Promise<{sha:string;bytes:number}>{
    const {source:s}=c.current(id),root='https://api.github.com/repos/'+s.container;
    const commit=object(await this.http.get(c,id,root+'/git/commits/'+s.commit,'json'));if(commit.sha!==s.commit)throw new SourceError('github_commit_identity');
    let tree=field(object(commit.tree).sha,40);if(!/^[0-9a-f]{40}$/.test(tree))throw new SourceError('github_tree_identity');const segments=id.split('/');
    for(let index=0;index<segments.length;index++){
      const response=object(await this.http.get(c,id,root+'/git/trees/'+tree,'json'));if(response.sha!==tree||response.truncated!==false)throw new SourceError('github_tree_unqualified');
      const entries=array(response.tree,1000).map(v=>object(v)),matches=entries.filter(v=>v.path===segments[index]);if(matches.length!==1)throw new SourceError('github_selected_tree_item');const entry=matches[0]!,sha=field(entry.sha,40);if(!/^[0-9a-f]{40}$/.test(sha))throw new SourceError('github_blob_identity');
      if(index===segments.length-1){const bytes=size(entry.size);if(entry.type!=='blob'||!['100644','100755'].includes(String(entry.mode))||bytes===null)throw new SourceError('github_link_or_item_unqualified');if(bytes>c.request.budget.fileBytes)throw new SourceError('source_format_or_size_unqualified');return {sha,bytes};}
      if(entry.type!=='tree'||entry.mode!=='040000')throw new SourceError('github_link_or_item_unqualified');tree=sha;
    }
    throw new SourceError('github_selected_tree_item');
  }
  private async item(c:Collection,id:string):Promise<{item:Item;raw:Record<string,unknown>}>{
    const {source:s}=c.current(id),enc=encodeURIComponent;let raw:Record<string,unknown>,item:Item;
    if(s.provider==='drive'){
      raw=object(await this.http.get(c,id,'https://www.googleapis.com/drive/v3/files/'+enc(id)+'?fields=id,name,mimeType,size,version,modifiedTime,parents,trashed,md5Checksum,capabilities','json'));
      if(raw.id!==id||raw.trashed===true||!array(raw.parents,20).includes(s.container)||object(raw.capabilities??{}).canDownload!==true)throw new SourceError('drive_item_identity_or_access');
      const name=field(raw.name,255),mime=field(raw.mimeType);if(!safeName(name)||!supportedMime(mime))throw new SourceError('source_item_name_or_format');
      item={id,name,revision:field(raw.version),mime,bytes:mime==='application/vnd.google-apps.document'?null:size(raw.size),eventAt:eventDate(raw.modifiedTime),citation:'drive:'+s.account+':'+id+'@'+field(raw.version),family:this.admission.family(s,id)};
    }else if(s.provider==='onedrive'){
      raw=object(await this.http.get(c,id,'https://graph.microsoft.com/v1.0/drives/'+enc(s.container)+'/items/'+enc(id)+'?$select=id,name,eTag,cTag,size,file,parentReference,lastModifiedDateTime','json'));
      if(raw.id!==id||raw.deleted||raw.remoteItem||object(raw.parentReference).driveId!==s.container||!raw.file)throw new SourceError('onedrive_item_identity_or_access');
      const name=field(raw.name,255),mime=field(object(raw.file).mimeType);if(!safeName(name)||!supportedMime(mime)||mime==='application/vnd.google-apps.document')throw new SourceError('source_item_name_or_format');
      item={id,name,revision:field(raw.eTag),mime,bytes:size(raw.size),eventAt:eventDate(raw.lastModifiedDateTime),citation:'onedrive:'+s.account+':'+s.container+'/'+id+'@'+field(raw.eTag),family:this.admission.family(s,id)};
    }else if((s.provider==='github'||s.provider==='github-public')){
      if(!safePath(id))throw new SourceError('git_path_excluded');const repo=object(await this.http.get(c,id,'https://api.github.com/repos/'+s.container,'json'));
      if(s.provider==='github-public'&&(repo.private!==false||repo.visibility!=='public'||String(object(repo.owner).id)!=='45693305'))throw new SourceError('github_public_identity_or_visibility');
      if(String(repo.id)!==s.containerIdentity||repo.full_name!==s.container)throw new SourceError('github_repository_identity');
      const blob=await this.githubBlob(c,id);
      raw=object(await this.http.get(c,id,'https://api.github.com/repos/'+s.container+'/contents/'+id.split('/').map(enc).join('/')+'?ref='+s.commit,'json'));
      if(raw.type!=='file'||raw.path!==id||raw.submodule_git_url||raw.target||raw.sha!==blob.sha||size(raw.size)!==blob.bytes)throw new SourceError('github_item_unqualified');
      item={id,name:id,revision:s.commit+':'+field(raw.sha),mime:id.endsWith('.json')?'application/json':id.endsWith('.md')?'text/markdown':'text/plain',bytes:size(raw.size),eventAt:null,citation:'https://github.com/'+s.container+'/blob/'+s.commit+'/'+id.split('/').map(enc).join('/'),family:this.admission.family(s,id)};
    }else throw new SourceError('cloud_source_provider_unavailable');
    c.item(item);return {item,raw};
  }
  async inventory(request:Request,signal:AbortSignal):Promise<Item[]>{
    if(request.operation!=='inventory')throw new SourceError('source_inventory_operation');const c=new Collection(this.admission,request,signal),s=c.current().source,result:Item[]=[];
    const ids=s.items.filter(id=>!s.exclusions.includes(id));if(ids.length>request.budget.items)throw new SourceError('source_item_count_budget');
    for(const id of ids){if(['git','github','github-public'].includes(s.provider)&&!safePath(id))continue;const found=await this.item(c,id);result.push(found.item);}c.current();return result;
  }
  /** One aggregate lease/counter set for a finite multi-file view. No per-file
   * budget reset, moving-ref fallback or partial whole-repository claim. */
  async readBatch(request:Request,signal:AbortSignal):Promise<Snapshot[]>{
    if(request.operation!=='snapshot')throw new SourceError('source_snapshot_operation');const c=new Collection(this.admission,request,signal),s=c.current().source;
    const ids=s.items.filter(id=>!s.exclusions.includes(id));if(ids.length>request.budget.items)throw new SourceError('source_item_count_budget');const result:Snapshot[]=[];
    for(const id of ids){const selected=(await this.item(c,id)).item;result.push(await this.snapshotCollection(c,selected));}c.current();return result;
  }
  async snapshot(request:Request,selected:Item,signal:AbortSignal):Promise<Snapshot>{
    if(request.operation!=='snapshot')throw new SourceError('source_snapshot_operation');return this.snapshotCollection(new Collection(this.admission,request,signal),selected);
  }
  private async snapshotCollection(c:Collection,selected:Item):Promise<Snapshot>{
    const {source:s}=c.current(selected.id),before=await this.item(c,selected.id);if(!same(before.item,selected))throw new SourceError('source_item_revision_changed');
    let bytes:Uint8Array;const enc=encodeURIComponent;
    if(s.provider==='drive'){
      const url='https://www.googleapis.com/drive/v3/files/'+enc(selected.id)+(selected.mime==='application/vnd.google-apps.document'?'/export?mimeType=text%2Fplain':'?alt=media');bytes=await this.http.get(c,selected.id,url,'bytes') as Uint8Array;
      if(before.raw.md5Checksum&&createHash('md5').update(bytes).digest('hex')!==before.raw.md5Checksum)throw new SourceError('drive_content_checksum_changed');
    }else if(s.provider==='onedrive')bytes=await this.http.get(c,selected.id,'https://graph.microsoft.com/v1.0/drives/'+enc(s.container)+'/items/'+enc(selected.id)+'/content','bytes') as Uint8Array;
    else if((s.provider==='github'||s.provider==='github-public')){
      if(before.raw.encoding!=='base64'||typeof before.raw.content!=='string'||!/^[A-Za-z0-9+/=\r\n]*$/.test(before.raw.content))throw new SourceError('github_content_encoding_unqualified');
      bytes=Buffer.from(before.raw.content.replace(/[\r\n]/g,''),'base64');const blob=createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');if(blob!==before.raw.sha)throw new SourceError('github_blob_digest_changed');
    }else throw new SourceError('cloud_source_provider_unavailable');
    if(selected.bytes!==null&&bytes.byteLength!==selected.bytes)throw new SourceError('source_content_size_changed');
    if(s.provider!=='github'&&s.provider!=='github-public'){const after=await this.item(c,selected.id);if(!same(before.item,after.item))throw new SourceError('source_changed_during_download');}
    return c.snapshot(selected,bytes);
  }
}
