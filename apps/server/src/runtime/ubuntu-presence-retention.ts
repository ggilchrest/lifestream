import {createPresenceTerminalCustodyOwner,type PresenceTerminalCustodyHandle} from './presence-terminal-custody.ts';
import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,lstatSync,realpathSync,readSync,writeSync,fsyncSync,opendirSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import type {LocalAuthentication,LocalContext} from '../auth/local-auth.ts';
import type {UbuntuPresenceGrant} from './ubuntu-presence-composition.ts';

type Transient='purpose'|'sessionId'|'captureLeaseId'|'captureFence'|'authorityExpiresAt';
export type UbuntuRetentionAssociation=Omit<UbuntuPresenceGrant,Transient>;
export type UbuntuRemovalAuthorization={mode:'removalOnly';grant:UbuntuPresenceGrant;current:()=>boolean};
export type UbuntuRetentionOptions={
 /** Existing canonical private0700 directory; never provisioned here. */
 directory:string;
 authentication:Pick<LocalAuthentication,'hostSessionContext'|'assertCurrent'>;
 /** Original configured association/consent owner, not request-body claims. */
 enrollmentCurrent:(context:LocalContext,association:UbuntuRetentionAssociation)=>boolean;
 /** Independently current deletion-only host authority. No capture acquisition. */
 authorizeRemoval:(context:LocalContext,association:UbuntuRetentionAssociation)=>UbuntuRemovalAuthorization|null;
 enrollment:Pick<import('./ubuntu-presence-composition.ts').UbuntuEnrollmentPort,'revoke'>;
 fence:(association:UbuntuRetentionAssociation)=>void;
 now?:()=>number;monotonicMs?:()=>number;
};
type Entry={version:1;association:UbuntuRetentionAssociation;registeredAt:number};
type Pending={version:1;associationHash:string;cause:'expiry'|'withdrawal';fencedAt:number};
type Deleted={version:1;associationHash:string;deletedAt:number};
type Kind='record'|'pending'|'deleted';
type Removal={entry:Entry;context:LocalContext;authorization:UbuntuRemovalAuthorization;until:number};
const fields=['actorId','endpointId','resourceId','siteRef','zoneRef','enrollmentRef','enrollmentRevision','consentRevision','registrationRevision','modelRevision','calibrationRevision','expiresAt'] as const;
const transient=['purpose','sessionId','captureLeaseId','captureFence','authorityExpiresAt'] as const;
const canonical=(v:unknown):string=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical((v as Record<string,unknown>)[k])}`).join(',')}}`:JSON.stringify(v);
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const closed=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const text=(v:unknown)=>typeof v==='string'&&v.length>0&&Buffer.byteLength(v)<=256;
const association=(g:UbuntuPresenceGrant):UbuntuRetentionAssociation=>Object.fromEntries(fields.map(k=>[k,g[k]])) as UbuntuRetentionAssociation;
const valid=(a:unknown):a is UbuntuRetentionAssociation=>closed(a,fields)&&fields.filter(k=>!['enrollmentRevision','consentRevision','registrationRevision','expiresAt'].includes(k)).every(k=>text(a[k]))&&['enrollmentRevision','consentRevision','registrationRevision'].every(k=>Number.isSafeInteger(a[k])&&(a[k] as number)>0)&&Number.isFinite(a.expiresAt);
const fail:()=>never=()=>{throw Error('RETENTION_UNAVAILABLE');};

const canonicalRetentions=new WeakMap<object,{owner:ReturnType<typeof createPresenceTerminalCustodyOwner>;closed:boolean}>();
/** Actual source-owned ledger instance only; never a supplied authority token. */
export function canonicalUbuntuPresenceRetentionCustody(value:unknown):PresenceTerminalCustodyHandle|null{if(!value||typeof value!=='object')return null;const entry=canonicalRetentions.get(value);return entry&&!entry.closed?entry.owner.handle:null;}

/** Nonbiometric retention ledger. Private metadata does not authorize capture,
 * template load, enrollment, keys or a recognizer. No default duration, automatic
 * retry, migration or directory provisioning. Same-UID/snapshot rollback cannot
 * be attested here; clock monotonicity is only for this process lifetime. */
export class UbuntuPresenceRetention {
 #custody=createPresenceTerminalCustodyOwner('retention');private readonly options:UbuntuRetentionOptions|null;
 private root:{dev:number;ino:number}|undefined;private closed=false;
 private busy=false;private removal:Removal|undefined;
 private lastUtc=-Infinity;private lastMono=-Infinity;
 constructor(options:UbuntuRetentionOptions|null=null){canonicalRetentions.set(this,{owner:this.#custody,closed:false});this.options=options;}
 private clocks(){try{const utc=(this.options?.now??Date.now)(),mono=(this.options?.monotonicMs??(()=>performance.now()))();
  if(!Number.isFinite(utc)||!Number.isFinite(mono)||utc<this.lastUtc||mono<this.lastMono)fail();this.lastUtc=utc;this.lastMono=mono;return {utc,mono};
  }catch(error){this.#custody.invalidate();throw error;}}
 private directory():string{
  const path=this.options?.directory;if(!path||!isAbsolute(path)||realpathSync(path)!==path)fail();const s=lstatSync(path!);
  if(!s.isDirectory()||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o700||this.root&&(s.dev!==this.root.dev||s.ino!==this.root.ino))fail();this.root??={dev:s.dev,ino:s.ino};return path!;
 }
 private read(root:string,name:string):unknown{
  const path=join(root,name),before=lstatSync(path);let fd:number|undefined;
  try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const s=fstatSync(fd);
   if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o600||s.size<1||s.size>4096||s.dev!==before.dev||s.ino!==before.ino)fail();
   const bytes=Buffer.alloc(s.size);try{let at=0;while(at<bytes.length){const n=readSync(fd,bytes,at,bytes.length-at,null);if(!n)fail();at+=n;}
    const end=fstatSync(fd),after=lstatSync(path);if([end,after].some(x=>x.dev!==s.dev||x.ino!==s.ino||x.mode!==s.mode||x.size!==s.size||x.mtimeMs!==s.mtimeMs)||this.directory()!==root)fail();return JSON.parse(bytes.toString());
   }finally{bytes.fill(0);}
  }finally{if(fd!==undefined)closeSync(fd);}
 }
 private inventory():Map<string,{entry:Entry;pending?:Pending;deleted?:Deleted}>{
  const root=this.directory(),entries=new Map<string,Partial<{entry:Entry;pending:Pending;deleted:Deleted}>>(),d=opendirSync(root);let count=0;
  try{for(let e;(e=d.readSync());){const match=/^([a-f0-9]{64})\.(record|pending|deleted)$/.exec(e.name);if(!match||++count>48)fail();const id=match![1]!,kind=match![2] as Kind,value=this.read(root,e.name),row=entries.get(id)??{};entries.set(id,row);if(entries.size>16)fail();
   if(kind==='record'){if(!closed(value,['version','association','registeredAt'])||value.version!==1||!valid(value.association)||hash(value.association)!==id||!Number.isFinite(value.registeredAt)||(value.registeredAt as number)>=value.association.expiresAt)fail();row.entry=value as Entry;}
   else if(kind==='pending'){if(!closed(value,['version','associationHash','cause','fencedAt'])||value.version!==1||value.associationHash!==id||!['expiry','withdrawal'].includes(String(value.cause))||!Number.isFinite(value.fencedAt))fail();row.pending=value as Pending;}
   else{if(!closed(value,['version','associationHash','deletedAt'])||value.version!==1||value.associationHash!==id||!Number.isFinite(value.deletedAt))fail();row.deleted=value as Deleted;}
  }}finally{d.closeSync();}
  for(const row of entries.values())if(!row.entry||row.deleted&&!row.pending||row.pending&&row.pending.fencedAt<row.entry.registeredAt||row.deleted&&row.deleted.deletedAt<row.pending!.fencedAt)fail();
  return entries as Map<string,{entry:Entry;pending?:Pending;deleted?:Deleted}>;
 }
 private sync(root:string){const fd=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{const s=fstatSync(fd);if(!this.root||s.dev!==this.root.dev||s.ino!==this.root.ino)fail();fsyncSync(fd);}finally{closeSync(fd);}}
 private publish(id:string,kind:Kind,value:Entry|Pending|Deleted):void{
  const entries=this.inventory(),root=this.directory();if(!entries.has(id)&&entries.size>=16)fail();const path=join(root,`${id}.${kind}`),bytes=Buffer.from(canonical(value));if(bytes.length>4096)fail();let fd:number|undefined;
  try{const existing=entries.get(id),already=kind==='record'?existing?.entry:kind==='pending'?existing?.pending:existing?.deleted;if(!already)this.#custody.invalidate();fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);let at=0;while(at<bytes.length){const n=writeSync(fd,bytes,at,bytes.length-at,null);if(!n)fail();at+=n;}fsyncSync(fd);closeSync(fd);fd=undefined;this.sync(root);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||canonical(this.read(root,`${id}.${kind}`))!==canonical(value))throw error;this.sync(root);}
  finally{if(fd!==undefined)closeSync(fd);bytes.fill(0);}
  // Partial publication remains fail-closed; never repair or erase unknown files.
  if(this.directory()!==root)fail();this.inventory();
 }
 private context(sessionId:string,actorId:string):LocalContext{
  if(!this.options||this.closed)fail();const c=this.options!.authentication.hostSessionContext(sessionId);if(!c||c.principalId!==actorId)fail();this.options!.authentication.assertCurrent(c,false);return structuredClone(c!);
 }
 private originalContext(c:LocalContext):boolean{
  try{if(!this.options||this.closed)return false;const fresh=this.context(c.sessionId,c.principalId);return hash(fresh)===hash(c);}catch{return false;}
 }
 private latch(entry:Entry,cause:Pending['cause']):void{
  const id=hash(entry.association),rows=this.inventory(),row=rows.get(id);if(!row||hash(row.entry)!==hash(entry))fail();if(row.pending)return;
  const now=this.clocks();if(now.utc<entry.registeredAt)fail();this.publish(id,'pending',{version:1,associationHash:id,cause,fencedAt:now.utc});
  // File and parent fsync are complete BEFORE withdrawal callback cascades.
  try{this.options?.fence(structuredClone(entry.association));}catch{}
 }
 /** No publication/key effect. The factory checks BEFORE original enrollment and
  * again after its current callbacks. This is not a cross-process reservation:
  * any final registration failure requires exact owner cleanup, not success. */
 canRecord(grant:UbuntuPresenceGrant,current:()=>boolean):boolean{
  if(!this.options||this.closed||this.busy)return false;this.busy=true;
  try{if(!closed(grant,[...fields,...transient])||grant.purpose!=='identityEnrollment'||!valid(association(grant))||typeof current!=='function')return false;
   const g=structuredClone(grant),a=association(g),start=this.clocks(),c=this.context(g.sessionId,g.actorId);
   if(!text(g.captureLeaseId)||!text(g.captureFence)||!Number.isFinite(g.authorityExpiresAt)||g.authorityExpiresAt<=start.utc||g.authorityExpiresAt>start.utc+5000||a.expiresAt<=start.utc)return false;
   const ready=()=>{const entries=this.inventory(),row=entries.get(hash(a));return !row?.pending&&!row?.deleted&&(!!row||entries.size<16);};
   if(!ready()||current()!==true||!this.originalContext(c)||this.options.enrollmentCurrent(structuredClone(c),structuredClone(a))!==true||!this.originalContext(c))return false;
   const end=this.clocks();return !this.closed&&end.utc<Math.min(g.authorityExpiresAt,a.expiresAt)&&end.mono<start.mono+g.authorityExpiresAt-start.utc&&ready();
  }catch{return false;}finally{this.busy=false;}
 }
 /** Only after the original explicit confirmed owner returned stored. Ephemeral
  * session/lease authority is checked but is not persisted as reusable authority. */
 recordStored(grant:UbuntuPresenceGrant,result:unknown,current:()=>boolean):boolean{
  if(!this.options||this.closed||this.busy)return false;this.busy=true;let entry:Entry|undefined;
  try{if(!closed(grant,[...fields,...transient])||grant.purpose!=='identityEnrollment'||!valid(association(grant))||!closed(result,['status'])||result.status!=='stored'||typeof current!=='function')return false;
   const g=structuredClone(grant),a=association(g),start=this.clocks(),c=this.context(g.sessionId,g.actorId);
   const okay=()=>current()===true&&this.originalContext(c)&&this.options!.enrollmentCurrent(structuredClone(c),structuredClone(a))===true&&this.originalContext(c);
   if(!text(g.captureLeaseId)||!text(g.captureFence)||!Number.isFinite(g.authorityExpiresAt)||g.authorityExpiresAt<=start.utc||g.authorityExpiresAt>start.utc+5000||a.expiresAt<=start.utc||!okay())return false;
   const admitted=this.clocks();if(this.closed||admitted.utc>=Math.min(a.expiresAt,g.authorityExpiresAt)||admitted.mono>=start.mono+g.authorityExpiresAt-start.utc)return false;
   const id=hash(a),old=this.inventory().get(id);if(old?.pending||old?.deleted)return false;if(old){const accepted=okay(),end=this.clocks();return accepted&&end.utc<Math.min(a.expiresAt,g.authorityExpiresAt)&&end.mono<start.mono+g.authorityExpiresAt-start.utc&&!this.closed&&hash(this.inventory().get(id))===hash(old);}
   entry={version:1,association:a,registeredAt:start.utc};this.publish(id,'record',entry);
   const accepted=okay(),end=this.clocks();if(!accepted||this.closed||end.utc>=Math.min(a.expiresAt,g.authorityExpiresAt)||end.mono>=start.mono+g.authorityExpiresAt-start.utc||hash(this.inventory().get(id))!==hash({entry})){this.latch(entry,'withdrawal');return false;}return true;
  }catch{if(entry)try{this.latch(entry,'withdrawal');}catch{}return false;}finally{this.busy=false;}
 }
 /** Fresh authenticated association check, never template loading. Expiry fences
  * even when a removal authority is unavailable; deletion remains pending. */
 eligible(sessionId:string,raw:UbuntuRetentionAssociation):boolean{
  if(!this.options||this.closed||this.busy)return false;this.busy=true;
  try{if(!valid(raw))return false;const a=structuredClone(raw),row=this.inventory().get(hash(a));if(!row||hash(row.entry.association)!==hash(a)||row.pending)return false;
   const start=this.clocks();if(start.utc<row.entry.registeredAt)return false;if(start.utc>=a.expiresAt){this.latch(row.entry,'expiry');return false;}
   const c=this.context(sessionId,a.actorId),okay=this.options.enrollmentCurrent(structuredClone(c),structuredClone(a))===true&&this.originalContext(c);
   const end=this.clocks();return okay&&!this.closed&&end.utc<a.expiresAt&&hash(this.inventory().get(hash(a)))===hash(row);
  }catch{return false;}finally{this.busy=false;}
 }
 /** Private host maintenance inventory; no wire export, no automatic work. */
 due():UbuntuRetentionAssociation[]{
  if(!this.options||this.closed||this.busy)return [];this.busy=true;
  try{const now=this.clocks(),rows=this.inventory(),due:UbuntuRetentionAssociation[]=[];for(const row of rows.values()){if(now.utc<row.entry.registeredAt)fail();if(row.deleted)continue;if(row.pending||now.utc>=row.entry.association.expiresAt){if(!row.pending)this.latch(row.entry,'expiry');due.push(structuredClone(row.entry.association));}}return this.closed?[]:due;}catch{return [];}finally{this.busy=false;}
 }
 private removalCurrent(op:Removal):boolean{
  try{if(!this.options||this.closed||this.removal!==op)return false;const start=this.clocks();if(start.utc>=op.authorization.grant.authorityExpiresAt||start.mono>=op.until||!this.originalContext(op.context)||op.authorization.current()!==true||!this.originalContext(op.context))return false;
   const row=this.inventory().get(hash(op.entry.association)),end=this.clocks();return !!row?.pending&&hash(row.entry)===hash(op.entry)&&!row.deleted&&!this.closed&&this.removal===op&&end.utc<op.authorization.grant.authorityExpiresAt&&end.mono<op.until;
  }catch{return false;}
 }
 async erase(sessionId:string,raw:UbuntuRetentionAssociation,reason:'expiry'|'withdrawal'|'retry'):Promise<{status:'deleted'|'pending'|'unavailable'}>{
  if(!this.options||this.closed||this.busy||this.removal)return {status:'unavailable'};this.busy=true;let op:Removal|undefined,started=false,timer:ReturnType<typeof setTimeout>|undefined;
  try{if(!valid(raw)||!['expiry','withdrawal','retry'].includes(reason))return {status:'unavailable'};const a=structuredClone(raw),row=this.inventory().get(hash(a)),start=this.clocks();if(!row||hash(row.entry.association)!==hash(a)||start.utc<row.entry.registeredAt||reason==='expiry'&&start.utc<a.expiresAt||reason==='retry'&&!row.pending)return {status:'unavailable'};
   if(reason==='expiry'&&!row.pending)this.latch(row.entry,'expiry');
   const context=this.context(sessionId,a.actorId),authorization=this.options.authorizeRemoval(structuredClone(context),structuredClone(a));
   if(!authorization||authorization.mode!=='removalOnly'||typeof authorization.current!=='function'||!closed(authorization.grant,[...fields,...transient]))return {status:row.pending||reason==='expiry'?'pending':'unavailable'};
   const g=structuredClone(authorization.grant);if(!valid(association(g))||hash(association(g))!==hash(a)||g.sessionId!==context.sessionId||g.purpose!=='identityEnrollment'||!text(g.captureLeaseId)||!text(g.captureFence)||!Number.isFinite(g.authorityExpiresAt)||g.authorityExpiresAt<=start.utc||g.authorityExpiresAt>start.utc+5000||!this.originalContext(context)||authorization.current()!==true||!this.originalContext(context))return {status:row.pending||reason==='expiry'?'pending':'unavailable'};
   const admitted=this.clocks();if(this.closed||admitted.utc>=g.authorityExpiresAt||admitted.mono>=start.mono+g.authorityExpiresAt-start.utc)return {status:row.pending?'pending':'unavailable'};
   if(row.deleted)return {status:'deleted'};this.latch(row.entry,reason==='expiry'?'expiry':'withdrawal');
   op={entry:structuredClone(row.entry),context,authorization:{mode:'removalOnly',grant:g,current:authorization.current},until:start.mono+g.authorityExpiresAt-start.utc};this.removal=op;
   if(!this.removalCurrent(op))return {status:'pending'};const captured=op;started=true;
   const work=(async()=>{try{const result=await this.options!.enrollment.revoke(structuredClone(g),()=>this.removalCurrent(captured));
     if(!closed(result,['status'])||result.status!=='removed'||!this.removalCurrent(captured))return {status:'pending'} as const;
     this.publish(hash(a),'deleted',{version:1,associationHash:hash(a),deletedAt:this.clocks().utc});return {status:'deleted'} as const;
    }catch{return {status:'pending'} as const;}finally{if(this.removal===captured)this.removal=undefined;this.busy=false;}})();
   // Bounded verdict does not release an unsettled original owner's custody.
   const bound=Math.max(1,Math.min(g.authorityExpiresAt-this.clocks().utc,captured.until-this.clocks().mono));
   return await Promise.race([work,new Promise<{status:'pending'}>(resolve=>{timer=setTimeout(()=>resolve({status:'pending'}),bound);})]);
  }catch{return {status:'unavailable'};}finally{if(timer)clearTimeout(timer);if(!started&&this.removal===op)this.removal=undefined;if(!op||this.removal!==op)this.busy=false;}
 }
 close():void{this.#custody.close();const entry=canonicalRetentions.get(this);if(entry)entry.closed=true;this.closed=true;}
}
