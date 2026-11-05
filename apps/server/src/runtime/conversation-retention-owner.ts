import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {constants,existsSync,lstatSync,mkdirSync,openSync,readFileSync,fstatSync,closeSync,writeFileSync,fsyncSync,renameSync,unlinkSync} from 'node:fs';
import {join,dirname,isAbsolute,normalize} from 'node:path';
import type {Database,ConversationRetentionPolicy,ConversationHistoryScope,ObservedTimelineEntry} from '@lifestream/storage-sqlite';
import {canonicalAuthSessionCustody,canonicalAuthStateDirectory,AuthenticationError,type LocalAuthentication,type LocalContext} from '../auth/local-auth.ts';

export type HistoryRetentionConfiguration={mode:'disabled'}|{mode:'syntheticOnly';retention:'untilDeletion'}|{mode:'localUserConsent';retention:'untilDeletion';journalInitialization:'requireExisting'|'initializeEmpty'};
type Grant={actorId:string;effectiveUserId:string;assistantId:string;revision:number;enabled:boolean;retention:'untilDeletion';bodyScope:'textAndTranscripts';grantId:string;grantedAt:string;changedAt:string};
type State={schemaVersion:'1.0.0';identity:string;epoch:number;grants:Grant[]};
type FutureDefault={schemaVersion:'1.0.0';identity:string;policyId:string;activatedAt:string;withdrawnScopes?:string[]};
type SetRequest={schemaVersion:'1.0.0';operation:'set';assistantId:string;expectedRevision:number;enabled:boolean;retention:'untilDeletion';bodyScope:'textAndTranscripts'};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v));
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const keys=(v:object)=>Object.keys(v).sort().join(',');
const same=(a:ReturnType<typeof lstatSync>,b:ReturnType<typeof lstatSync>)=>['dev','ino','mode','uid','gid','nlink','size','mtimeMs','ctimeMs'].every(k=>(a as any)[k]===(b as any)[k]);
export class HistoryRetentionError extends Error{
 constructor(readonly code:'invalidRequest'|'revisionConflict'|'forbidden'|'unavailable'){super(code);}
}
function need(v:unknown,code:ConstructorParameters<typeof HistoryRetentionError>[0]='unavailable'):asserts v {if(!v)throw new HistoryRetentionError(code);}

/** Native application-owned policy. Local future messages are saved by default;
 * an independent cutoff never reconstructs old bodies or rewrites consent grants.
 * The independent content-free journal is preserved when SQLite is rolled back;
 * it is never reconstructed from historical database approvals. */
export class ConversationRetentionOwner implements ConversationRetentionPolicy{
 private state:State;
 private readonly directory:string;
 private readonly authDirectory:string;
 private readonly stateRoot:string;
 private readonly ownerUid:number;
 private readonly ownerGid:number;
 private readonly database:Database;
 private readonly authentication:LocalAuthentication;
 private readonly now:()=>number;
 private closed=false;
 private readonly mode:'syntheticOnly'|'localUserConsent';
 private futureDefault?:FutureDefault;
 close(){this.closed=true;}
 constructor(input:{database:Database;authentication:LocalAuthentication;authDirectory:string;stateRoot:string;configuration:Exclude<HistoryRetentionConfiguration,{mode:'disabled'}>;now?:()=>number}){
  const cfg=input.configuration;
  this.mode=cfg.mode;
  if(cfg.mode==='syntheticOnly'){
   need(keys(cfg)==='mode,retention'&&cfg.retention==='untilDeletion','invalidRequest');
   // Test-profile/fixture-provider and isolated-namespace admission belongs to
   // the constructing host. This owner still requires its genuine Auth/DB pair.
  }else{
   need(cfg.mode==='localUserConsent'&&keys(cfg)==='journalInitialization,mode,retention'&&cfg.retention==='untilDeletion'&&['requireExisting','initializeEmpty'].includes(cfg.journalInitialization),'invalidRequest');
  }
  need(canonicalAuthSessionCustody(input.authentication,input.database)!==null,'forbidden');
  need(typeof process.geteuid==='function'&&typeof process.getegid==='function','forbidden');
  this.ownerUid=process.geteuid();this.ownerGid=process.getegid();
  need(Number.isSafeInteger(this.ownerUid)&&this.ownerUid>=0&&Number.isSafeInteger(this.ownerGid)&&this.ownerGid>=0,'forbidden');
  const clean=(path:unknown):path is string=>typeof path==='string'&&isAbsolute(path)&&normalize(path)===path&&path!=='/'&&!path.endsWith('/')&&path.length<=4096;
  need(clean(input.stateRoot)&&clean(input.authDirectory)&&clean(input.database.path),'forbidden');
  need(dirname(input.authDirectory)===input.stateRoot&&dirname(input.database.path)===input.stateRoot&&canonicalAuthStateDirectory(input.authentication,input.database)===input.authDirectory,'forbidden');
  this.authDirectory=input.authDirectory;this.stateRoot=input.stateRoot;
  // Ancestors must remain actual directories. The host's private state root
  // and original authentication directory are owned 0700 boundaries.
  let ancestor='/';for(const part of input.authDirectory.split('/').filter(Boolean)){ancestor=join(ancestor,part);const stat=lstatSync(ancestor);need(stat.isDirectory()&&!stat.isSymbolicLink());if(ancestor===input.stateRoot||ancestor===input.authDirectory)need(stat.uid===this.ownerUid&&stat.gid===this.ownerGid&&(stat.mode&0o777)===0o700);}
  const databaseFile=lstatSync(input.database.path);need(databaseFile.isFile()&&!databaseFile.isSymbolicLink()&&databaseFile.uid===this.ownerUid&&databaseFile.gid===this.ownerGid&&databaseFile.nlink===1&&(databaseFile.mode&0o777)===0o600,'forbidden');
  this.database=input.database;this.authentication=input.authentication;this.now=input.now??Date.now;
  this.directory=join(input.authDirectory,'conversation-retention-policy');
  this.database.connection.prepare('INSERT OR IGNORE INTO conversation_cursor_key VALUES(1,?)').run(randomBytes(32).toString('hex'));
  const secret=this.database.connection.prepare('SELECT secret FROM conversation_cursor_key WHERE singleton=1').get()!.secret;
  need(typeof secret==='string');const identity=createHash('sha256').update(secret).digest('hex');
  if(!existsSync(this.directory)){
   if(cfg.mode==='syntheticOnly'){
    // Existing accounts/history cannot be relabelled synthetic by a config flag.
    need(Number(this.database.connection.prepare('SELECT COUNT(*) AS n FROM local_accounts').get()!.n)===0&&Number(this.database.connection.prepare('SELECT COUNT(*) AS n FROM conversation_catalog').get()!.n)===0&&Number(this.database.connection.prepare('SELECT COUNT(*) AS n FROM conversation_timeline').get()!.n)===0);
   }else{
    // A missing journal is never reconstructed from old approvals or retained
    // bodies. Reviewed first provisioning starts with no grants and no backfill.
    need(cfg.journalInitialization==='initializeEmpty');
    need(Number(this.database.connection.prepare("SELECT COUNT(*) AS n FROM conversation_timeline WHERE content_state='retained'").get()!.n)===0);
   }
   mkdirSync(this.directory,{mode:0o700});this.state={schemaVersion:'1.0.0',identity,epoch:0,grants:[]};this.persist(this.state);
  }else{
   this.state=this.validate(this.read('owner.json'));need(this.state.identity===identity);this.verifyHead(this.state);
  }
  this.directoryCurrent();
  if(this.mode==='localUserConsent'){
   const path=join(this.directory,'future-default.json');
   if(existsSync(path))this.futureDefault=this.validateDefault(this.read('future-default.json'));
   else{
    const now=this.now();need(Number.isFinite(now));
    const value:FutureDefault={schemaVersion:'1.0.0',identity:this.state.identity,policyId:randomUUID(),activatedAt:new Date(now).toISOString(),withdrawnScopes:[]};
    this.atomic('future-default.json',value);this.futureDefault=value;
   }
  }
 }
 private validateDefault(v:unknown):FutureDefault{
  need(v&&typeof v==='object'&&!Array.isArray(v));const d=v as FutureDefault;
  need(['activatedAt,identity,policyId,schemaVersion','activatedAt,identity,policyId,schemaVersion,withdrawnScopes'].includes(keys(d))&&d.schemaVersion==='1.0.0'&&d.identity===this.state.identity&&uuid(d.policyId)&&date(d.activatedAt));
  if(Object.hasOwn(d,'withdrawnScopes'))need(Array.isArray(d.withdrawnScopes)&&d.withdrawnScopes.length<=128&&new Set(d.withdrawnScopes).size===d.withdrawnScopes.length&&d.withdrawnScopes.every(key=>typeof key==='string'&&key.split(':').length===2&&key.split(':').every(uuid)));return d;
 }
 private defaultCurrent(){try{return !this.futureDefault||digest(this.validateDefault(this.read('future-default.json')))===digest(this.futureDefault);}catch{return false;}}
 private defaultReference(scope:Readonly<ConversationHistoryScope>,assistantId:string){return this.futureDefault?`future-chat:${this.futureDefault.policyId}:${scope.effectiveUserId}:${assistantId}`:null;}
 private defaultWithdrawn(scope:Readonly<ConversationHistoryScope>,assistantId:string){return this.futureDefault?.withdrawnScopes?.includes(`${scope.effectiveUserId}:${assistantId}`)===true;}
 private withdrawDefault(scope:Readonly<ConversationHistoryScope>,assistantId:string){
  if(!this.futureDefault||this.defaultWithdrawn(scope,assistantId))return;
  const withdrawnScopes=[...(this.futureDefault.withdrawnScopes??[]),`${scope.effectiveUserId}:${assistantId}`],next={...this.futureDefault,withdrawnScopes};
  this.validateDefault(next);this.atomic('future-default.json',next);this.futureDefault=next;
 }
 private directoryCurrent(){
  need(process.geteuid?.()===this.ownerUid&&process.getegid?.()===this.ownerGid&&canonicalAuthSessionCustody(this.authentication,this.database)!==null&&canonicalAuthStateDirectory(this.authentication,this.database)===this.authDirectory);
  let ancestor='/';for(const part of this.authDirectory.split('/').filter(Boolean)){ancestor=join(ancestor,part);const stat=lstatSync(ancestor);need(stat.isDirectory()&&!stat.isSymbolicLink());if(ancestor===this.stateRoot||ancestor===this.authDirectory)need(stat.uid===this.ownerUid&&stat.gid===this.ownerGid&&(stat.mode&0o777)===0o700);}
  const s=lstatSync(this.directory);need(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===this.ownerUid&&s.gid===this.ownerGid&&(s.mode&0o777)===0o700);
 }
 private read(name:string):unknown{
  this.directoryCurrent();const path=join(this.directory,name),before=lstatSync(path);
  need(before.isFile()&&!before.isSymbolicLink()&&before.uid===this.ownerUid&&before.gid===this.ownerGid&&before.nlink===1&&(before.mode&0o777)===0o600&&before.size<=65536);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const opened=fstatSync(fd);need(same(before,opened));const body=readFileSync(fd);need(body.length===before.size&&body.length<=65536&&same(opened,fstatSync(fd))&&same(opened,lstatSync(path)));return JSON.parse(body.toString('utf8'));}finally{closeSync(fd);}
 }
 private validate(v:unknown):State{
  need(v&&typeof v==='object'&&!Array.isArray(v));const s=v as State;
  need(keys(s)==='epoch,grants,identity,schemaVersion'&&s.schemaVersion==='1.0.0'&&/^[0-9a-f]{64}$/.test(s.identity)&&Number.isSafeInteger(s.epoch)&&s.epoch>=0&&Array.isArray(s.grants)&&s.grants.length<=128);
  const scopes=new Set<string>();for(const g of s.grants){
   need(g&&keys(g)==='actorId,assistantId,bodyScope,changedAt,effectiveUserId,enabled,grantId,grantedAt,retention,revision'&&uuid(g.actorId)&&g.actorId===g.effectiveUserId&&uuid(g.assistantId)&&uuid(g.grantId)&&Number.isSafeInteger(g.revision)&&g.revision>=1&&typeof g.enabled==='boolean'&&g.bodyScope==='textAndTranscripts'&&g.retention==='untilDeletion'&&date(g.grantedAt)&&date(g.changedAt)&&Date.parse(g.grantedAt)<=Date.parse(g.changedAt));
   const scope=g.actorId+':'+g.assistantId;need(!scopes.has(scope));scopes.add(scope);
  }return s;
 }
 private verifyHead(s:State){const head=this.read('head.json') as {identity:string;epoch:number;sha256:string};need(head&&keys(head)==='epoch,identity,sha256'&&head.identity===s.identity&&head.epoch===s.epoch&&head.sha256===digest(s));}
 private journalCurrent(){try{const s=this.validate(this.read('owner.json'));this.verifyHead(s);return digest(s)===digest(this.state);}catch{return false;}}
 private atomic(name:string,v:unknown){
  this.directoryCurrent();const body=JSON.stringify(v);need(Buffer.byteLength(body)<=65536);const temporary=join(this.directory,'pending-'+randomUUID());const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,body);fsyncSync(fd);}finally{closeSync(fd);}
  try{renameSync(temporary,join(this.directory,name));const directory=openSync(this.directory,constants.O_RDONLY|constants.O_DIRECTORY);try{fsyncSync(directory);}finally{closeSync(directory);}}catch(error){try{unlinkSync(temporary);}catch{}throw error;}
 }
 private persist(s:State){this.validate(s);this.atomic('owner.json',s);this.atomic('head.json',{identity:s.identity,epoch:s.epoch,sha256:digest(s)});}
 private accessCurrent(scope:ConversationHistoryScope){return !this.closed&&uuid(scope.actorId)&&uuid(scope.effectiveUserId)&&typeof scope.authorityCurrent==='function'&&scope.authorityCurrent()===true&&this.journalCurrent()&&this.defaultCurrent();}
 private authorized(scope:ConversationHistoryScope){return scope.actorId===scope.effectiveUserId&&this.accessCurrent(scope);}
 private grant(scope:ConversationHistoryScope,assistantId:string){return this.state.grants.find(g=>g.effectiveUserId===scope.effectiveUserId&&g.assistantId===assistantId);}
 // Host-only volatile-context fence; it grants no retention or disclosure.
 boundary(scope:ConversationHistoryScope,assistantId:string){
  try{if(!uuid(assistantId)||!this.accessCurrent(scope))return null;return digest({identity:this.state.identity,epoch:this.state.epoch,effectiveUserId:scope.effectiveUserId,assistantId,...(this.futureDefault?{futureDefault:this.futureDefault}: {})});}catch{return null;}
 }
 inspect(scope:ConversationHistoryScope,assistantId:string){
  need(uuid(assistantId)&&this.authorized(scope),'forbidden');const g=this.grant(scope,assistantId),enabled=g?g.enabled:!!this.futureDefault&&!this.defaultWithdrawn(scope,assistantId);
  return Object.freeze({schemaVersion:'1.0.0',mode:this.mode,assistantId,revision:g?.revision??0,enabled,retention:'untilDeletion',bodyScope:'textAndTranscripts',realDataEnabled:this.mode==='localUserConsent'&&enabled,reason:enabled?(g?(this.mode==='syntheticOnly'?'explicitSyntheticUntilDeletionPolicy':'explicitLocalUserUntilDeletionPolicy'):'futureMessagesUntilDeletionByDefault'):'policyDisabled'});
 }
 set(context:LocalContext,scope:ConversationHistoryScope,input:unknown,ordinaryDailyCurrent:()=>boolean=()=>false){
  this.authentication.assertCurrent(context,false);need(context.principalId===scope.actorId&&(context.effectiveContext?.effectiveUserId??context.principalId)===scope.effectiveUserId&&this.authorized(scope),'forbidden');
  need(input&&typeof input==='object'&&!Array.isArray(input),'invalidRequest');const r=input as SetRequest;
  need(keys(r)==='assistantId,bodyScope,enabled,expectedRevision,operation,retention,schemaVersion'&&r.schemaVersion==='1.0.0'&&r.operation==='set'&&uuid(r.assistantId)&&Number.isSafeInteger(r.expectedRevision)&&r.expectedRevision>=0&&typeof r.enabled==='boolean'&&r.bodyScope==='textAndTranscripts'&&r.retention==='untilDeletion','invalidRequest');
  // Only the host's original current Daily scope can admit the ordinary
  // self-consent fallback. No request field or default grant supplies it.
  const consentCurrent=()=>{
   this.authentication.assertCurrent(context,false);
   need(context.principalId===scope.actorId&&(context.effectiveContext?.effectiveUserId??context.principalId)===scope.effectiveUserId&&this.authorized(scope),'forbidden');
   try{need(this.authentication.canAdminister(context,r.assistantId),'forbidden');}
   catch(error){if(!(error instanceof AuthenticationError)||error.code!=='administration_freshness_required')throw error;need(ordinaryDailyCurrent()===true&&this.authentication.canUseAssistant(context,r.assistantId),'forbidden');}
   need(context.principalId===scope.actorId&&(context.effectiveContext?.effectiveUserId??context.principalId)===scope.effectiveUserId&&this.authorized(scope),'forbidden');
   this.authentication.assertCurrent(context,false);
  };consentCurrent();
  const capturedState=this.state,previous=this.grant(scope,r.assistantId);need((previous?.revision??0)===r.expectedRevision,'revisionConflict');need(this.state.epoch<Number.MAX_SAFE_INTEGER&&(!previous||previous.revision<Number.MAX_SAFE_INTEGER));
  const now=this.now();need(Number.isFinite(now)&&(!previous||now>=Date.parse(previous.changedAt)));const newGrant=!previous||r.enabled&&!previous.enabled,birth=newGrant?new Date(now).toISOString():previous!.grantedAt;const next:Grant={actorId:scope.actorId,effectiveUserId:scope.effectiveUserId,assistantId:r.assistantId,revision:(previous?.revision??0)+1,enabled:r.enabled,retention:'untilDeletion',bodyScope:r.bodyScope,grantId:newGrant?randomUUID():previous!.grantId,grantedAt:birth,changedAt:new Date(now).toISOString()};
  const grants=this.state.grants.filter(g=>g!==previous);need(grants.length<128);grants.push(next);
  const state:State={...this.state,epoch:this.state.epoch+1,grants};consentCurrent();need(this.state===capturedState&&this.grant(scope,r.assistantId)===previous&&(previous?.revision??0)===r.expectedRevision,'revisionConflict');need(this.authorized(scope),'forbidden');
  // Denial precedes optional payload cleanup and is never undone by a later
  // grant. A failed cleanup must not make old default-backed text reappear.
  if(!r.enabled)this.withdrawDefault(scope,r.assistantId);
  this.persist(state);this.state=state;return this.inspect(scope,r.assistantId);
 }
 reference(scope:ConversationHistoryScope,assistantId:string){need(this.authorized(scope),'forbidden');return this.grant(scope,assistantId)?.grantId??null;}
 references(scope:ConversationHistoryScope,assistantId:string){need(uuid(assistantId)&&this.authorized(scope),'forbidden');return [this.reference(scope,assistantId),this.defaultReference(scope,assistantId)].filter((value):value is string=>value!==null);}
 retain(source:Readonly<ObservedTimelineEntry>,scope:Readonly<ConversationHistoryScope>){if(typeof source.text!=='string')return null;return this.sourceApproval(source,scope);}
 sourceApproval(source:Readonly<Omit<ObservedTimelineEntry,'text'>>,scope:Readonly<ConversationHistoryScope>){
  try{
   if(!this.accessCurrent(scope)||!uuid(source.entryId)||!uuid(source.conversationId)||!['text','voice'].includes(source.modality)||!['human','assistant'].includes(source.speaker))return null;
   if(source.speaker==='assistant'?source.attribution!=='observedAssistantOutput':source.modality==='text'?!['authenticatedTypedOwner','administrativeTypedActor'].includes(source.attribution??''):source.attribution!=='unknownSpeaker')return null;
   const row=this.database.connection.prepare('SELECT assistant_id,effective_user_id FROM conversation_catalog WHERE conversation_id=?').get(source.conversationId);
   if(!row||row.effective_user_id!==scope.effectiveUserId||typeof row.assistant_id!=='string')return null;
   const g=this.grant(scope,row.assistant_id),fallback=!g&&this.futureDefault&&!this.defaultWithdrawn(scope,row.assistant_id)&&scope.actorId===scope.effectiveUserId?this.futureDefault:undefined;
   if(g?!g.enabled:!fallback)return null;
   const born=g?.grantedAt??fallback!.activatedAt,policyRef=g?.grantId??this.defaultReference(scope,row.assistant_id)!;
   if(!date(source.occurredAt)||Date.parse(source.occurredAt)<=Date.parse(born))return null;
   // Grant birth is an admission boundary, never an expiry. A later lifecycle
   // event cannot reapprove a pre-grant entry after an interrupted withdrawal.
   const previous=this.database.connection.prepare('SELECT created_at FROM conversation_timeline WHERE entry_id=?').get(source.entryId);
   if(previous&&(typeof previous.created_at!=='string'||!Number.isFinite(Date.parse(previous.created_at))||Date.parse(previous.created_at)<=Date.parse(born)))return null;
   return {policyRef,retention:'untilDeletion' as const,expiresAt:null};
  }catch{return null;}
 }
 current(policyRef:string,scope:Readonly<ConversationHistoryScope>){
   try{
    if(!this.accessCurrent(scope))return false;
    if(this.futureDefault&&scope.actorId===scope.effectiveUserId){
     const parts=policyRef.split(':');
     if(parts.length===4&&parts[0]==='future-chat'&&parts[1]===this.futureDefault.policyId&&parts[2]===scope.effectiveUserId&&uuid(parts[3]))return !this.defaultWithdrawn(scope,parts[3])&&this.grant(scope,parts[3])?.enabled!==false;
    }
    const g=this.state.grants.find(g=>g.grantId===policyRef);return !!g?.enabled&&g.effectiveUserId===scope.effectiveUserId&&g.retention==='untilDeletion';
   }catch{return false;}
 }
}
