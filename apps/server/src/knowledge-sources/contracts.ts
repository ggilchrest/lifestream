import { createHash } from 'node:crypto';

export type Provider='drive'|'onedrive'|'github'|'github-public'|'git';
export type Source={id:string;revision:number;provider:Provider;account:string;principal:string;tenant:string|null;credentialRef:string|null;credentialEpoch:number;subject:string;assistant:string;relationship:string;audience:string;context:string;items:string[];exclusions:string[];container:string;containerIdentity:string;commit:string|null;localRepositoryRef:string|null;ready:boolean};
export type Grant={source:string;revision:number;sourceRevision:number;actor:string;subject:string;assistant:string;relationship:string;audience:string;context:string;collect:boolean;process:boolean;retentionRef:string|null;downloadOrigins:string[];expiresAt:number;revoked:boolean};
export type Binding={account:string;principal:string;tenant:string|null;credentialRef:string;credentialEpoch:number;scopes:string[];expiresAt:number};
export type Request={key:string;job:string;actor:string;source:string;sourceRevision:number;permissionRevision:number;credentialEpoch:number;subject:string;assistant:string;relationship:string;audience:string;context:string;operation:'inventory'|'snapshot';retentionRef:string|null;budget:{items:number;fileBytes:number;totalBytes:number;calls:number;durationMs:number}};
export type Item={id:string;name:string;revision:string;mime:string;bytes:number|null;eventAt:string|null;citation:string;family:string};
export type Snapshot={protocol:'source-snapshot-v1';job:string;collectionKey:string;source:string;sourceRevision:number;permissionRevision:number;credentialEpoch:number;provider:Provider;account:string;subject:string;assistant:string;relationship:string;audience:string;context:string;item:Item;sha256:string;collectedAt:string;parser:'utf8-selected-v1';text:string;evidenceBasis:'observation';authoredBy:'unknown';untrusted:true;active:false;approvedUse:null;retentionRef:string};
/** Host owns authentication, canonical preparation, source exclusions/forgetting
 * and independent current state. Source text and provider responses supply none. */
export type Host={
  sources():Source[];grant(request:Request):Grant|null;binding(source:Source):Binding|null;
  authorize(request:Request,digest:string):{digest:string;preparedInvocationRef:string;expiresAt:number}|null;
  cancelled(job:string,key:string):boolean;
  lifecycleCurrent(source:Source,item:string|null,digest:string|null):boolean;
  family(source:Source,item:string):string|null;
};
export type Adapter={inventory(request:Request,signal:AbortSignal):Promise<Item[]>;snapshot(request:Request,item:Item,signal:AbortSignal):Promise<Snapshot>};
export class SourceError extends Error {constructor(code:string){super(code);}}
export const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export function uuid(v:unknown):v is string{return typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);}
export function text(v:unknown,max=200):v is string{return typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);}
export function field(v:unknown,max=200):string{if(!text(v,max))throw new SourceError('source_field_invalid');return v;}
export function object(v:unknown):Record<string,unknown>{if(v===null||typeof v!=='object'||Array.isArray(v))throw new SourceError('source_shape_invalid');return v as Record<string,unknown>;}
export function array(v:unknown,max=200):unknown[]{if(!Array.isArray(v)||v.length>max)throw new SourceError('source_array_bound');return v;}
export function positive(v:unknown):v is number{return Number.isSafeInteger(v)&&Number(v)>0;}
export const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
export function safePath(path:string):boolean{return text(path,300)&&!path.startsWith('/')&&!path.includes('\\')&&!/[<>:"|?*\[\]]/.test(path)&&!path.split('/').some(x=>x==='.'||x==='..'||x==='')&&!path.split('/').some(x=>/^(?:\.git|\.ssh|\.aws|\.codex|\.env(?:\..*)?|\.npmrc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i.test(x));}
export function safeName(name:string):boolean{return text(name,255)&&safePath(name);}
export const supportedMime=(mime:string)=>['text/plain','text/markdown','application/json','application/vnd.google-apps.document'].includes(mime);
