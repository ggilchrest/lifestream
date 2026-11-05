import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {Database} from './database.ts';
import {validateConversationHistoryRecord} from '@lifestream/contracts/conversation-history';
import type {ConversationSummary,TimelineEntry,HistoryRequest,HistoryOperationResult,TimelinePage,ConversationPage,SearchPage} from '@lifestream/contracts/conversation-history';

export type ConversationHistoryScope={actorId:string;effectiveUserId:string;contextGeneration:number;authorityCurrent?:()=>boolean};
export type ObservedTimelineEntry={entryId:string;turnId:string;conversationId:string;speaker:TimelineEntry['speaker'];modality:TimelineEntry['modality'];state:TimelineEntry['state'];occurredAt:string;text?:string;expectedRevision:number;attribution?:'authenticatedTypedOwner'|'administrativeTypedActor'|'unknownSpeaker'|'observedAssistantOutput'};
/** An owning policy must approve the exact source and remain current at read time.
 * No default transcript retention exists; the host must supply its owning policy explicitly. */
export type ConversationRetentionApproval={policyRef:string;retention:'untilDeletion';expiresAt:null}|{policyRef:string;retention?:'untilExpiry';expiresAt:string};
export type ConversationRetentionPolicy={
 retain:(source:Readonly<ObservedTimelineEntry>,scope:Readonly<ConversationHistoryScope>)=>ConversationRetentionApproval|null;
 current:(policyRef:string,scope:Readonly<ConversationHistoryScope>)=>boolean;
 sourceApproval?:(source:Readonly<Omit<ObservedTimelineEntry,'text'>>,scope:Readonly<ConversationHistoryScope>)=>ConversationRetentionApproval|null;
};
/** Content-free denial evidence. No transcript digest, policy value or grant is recorded. */
export type ConversationPrivacyIntent={actorId:string;effectiveUserId:string;assistantId:string;conversationId:string;entryId:string;turnId:string;speaker:TimelineEntry['speaker'];modality:TimelineEntry['modality'];entryRevision:number;fenceRevision:number;reason:'redacted'|'unavailable';changedAt:string;operation:{operationId:string;idempotencyKey:string;requestDigest:string;resultRevision:number}|null};
type ConversationPrivacySafety={current:()=>boolean;admit:(intent:ConversationPrivacyIntent)=>void;blocked:(entryId:string)=>ConversationPrivacyIntent|null;blockedTurn?:(conversationId:string,turnId:string,speaker:TimelineEntry['speaker'])=>ConversationPrivacyIntent|null};
type CatalogRow={conversation_id:string;actor_id:string;effective_user_id:string;assistant_id:string;title:string;revision:number;created_at:string;last_activity_at:string;archived:number;pinned:number;event_sequence:number;last_order:number};
type EntryRow={entry_id:string;turn_id:string;conversation_id:string;ordinal:number;actor_id:string;effective_user_id:string;speaker:TimelineEntry['speaker'];modality:TimelineEntry['modality'];state:TimelineEntry['state'];content_state:TimelineEntry['content']['state'];retained_text:string|null;policy_ref:string|null;expires_at:string|null;retention_mode:'untilDeletion'|'untilExpiry'|null;revision:number;created_at:string;updated_at:string};
type OperationRow={assistant_id:string;operation_id:string;idempotency_key:string;request_digest:string;result_json:string};
type TimelinePosition={version:2;kind:'timelineKeyset';actor:string;effective:string;generation:number;assistant:string;conversation:string;direction:'older'|'newer';upper:number;boundary:number};
type Position={scope:string;assistant:string;kind:string;filter:string;revision:number;offset:number};
const uuid=(value:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}':JSON.stringify(value);
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const escapeExcerpt=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const excerpt=(value:string,query:string)=>{const match=value.toLowerCase().indexOf(query.toLowerCase()),start=Math.max(0,match-80);let result='';for(const character of value.slice(start,start+240)){const escaped=escapeExcerpt(character);if(result.length+escaped.length>1024)break;result+=escaped;}return result;};
const validTime=(value:string)=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value));
export class ConversationHistoryError extends Error {
 readonly code:'forbidden'|'invalidRequest'|'notFound'|'revisionConflict'|'idempotencyConflict'|'invalidCursor'|'restartPage'|'backpressure'|'unavailable';
 constructor(code:ConversationHistoryError['code'],message:string){super(message);this.code=code;}
}

export type ConversationSourceIdentity={actorId:string;effectiveUserId:string;assistantId:string;conversationId:string;entryId:string;turnId:string;speaker:'human'|'assistant';modality:'text'|'voice'};
export type ConversationSourceRetention={policyRef:string;retentionMode:'untilDeletion'|'untilExpiry';expiresAt:string|null};
export type ConversationSourceRef={kind:'queryScope';principalId:string;assistantId:string;collector:string;sourceNamespace:string;enrollmentId:string;enrollmentRevision:number;policyBindingDigest:string;purpose:'answers';queryDigest:string;asOf:string;resultScopeDigest:string}|{kind:'record';collector:string;sourceNamespace:string;enrollmentId:string;enrollmentRevision:number;sourceKey:string;suppressionKey:string;recordDigest:string;recordPolicyRefDigest:string;policyBindingDigest:string;firstImportDigest:string};
export type ConversationSourceParent=ConversationSourceIdentity&{journalIdentity:string;admissionId:string;admissionSequence:number;closureDigest:string;originalRetentionDigest:string;contentCommitId:string;contentCommitDigest:string;committedRevision:number};
export type CalendarConversationQueryRef={kind:'calendarQueryScope';snapshotVersion:'calendar-conversation-snapshot/1';principalId:string;assistantId:string;collector:'eventKit'|'androidCalendar'|'googleTasks';sourceNamespace:string;enrollmentId:string;enrollmentRevision:number;policyBindingDigest:string;purpose:'answers';window:{kind:'date';startDate:string;endDateExclusive:string};asOf:string;queryDigest:string;resultScopeDigest:string};
export type CalendarConversationRecordRef={kind:'calendarRecord';collector:CalendarConversationQueryRef['collector'];sourceNamespace:string;enrollmentId:string;enrollmentRevision:number;recordType:'CalendarEvent'|'Task';sourceKey:string;suppressionKey:string;recordDigest:string;recordPolicyRefDigest:string;policyBindingDigest:string;expiresAt:string|null;queryDigest:string};
export type CalendarConversationSourceRef=CalendarConversationQueryRef|CalendarConversationRecordRef;
export type ConversationAnySourceRef=ConversationSourceRef|CalendarConversationSourceRef;
export type ConversationSourceClosure={schemaVersion:'1.0.0';sourceRefs:ConversationSourceRef[];ancestorCommits:ConversationSourceParent[];directParents:string[]}|{schemaVersion:'2.0.0';sourceRefs:ConversationAnySourceRef[];ancestorCommits:ConversationSourceParent[];directParents:string[]};
export type ConversationSourceAdmission=ConversationSourceIdentity&{admissionId:string;originalRetentionDigest:string;closureDigest:string;sourceCount:number;parentCount:number};
export type ConversationSourceCommit={contentCommitId:string;admissionId:string;entryIdentityDigest:string;expectedPreviousRevision:number;committedRevision:number;bodyUTF8SHA256:string;byteLength:number;terminalState:'completed'|'failed'|'interrupted';occurredAt:string;originalRetentionDigest:string;closureDigest:string};
export type ConversationSourceBinding={admission:ConversationSourceAdmission;commit:ConversationSourceCommit;closure:ConversationSourceClosure;retention:ConversationSourceRetention;parent:ConversationSourceParent};
export type ConversationSourceRow=Readonly<EntryRow>;
export type ConversationSourceHooks={ordinaryCopy:(identity:ConversationSourceIdentity)=>void;ordinaryReadable:(row:ConversationSourceRow)=>boolean;linked:(row:ConversationSourceRow)=>boolean;readable:(row:ConversationSourceRow,scope:ConversationHistoryScope)=>boolean;binding:(row:ConversationSourceRow,scope:ConversationHistoryScope)=>ConversationSourceBinding|null};
export const conversationSourceCanonical=(value:unknown):string=>{if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(conversationSourceCanonical).join(',')+']';return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+conversationSourceCanonical((value as Record<string,unknown>)[key])).join(',')+'}';};
export const conversationSourceDigest=(value:unknown)=>createHash('sha256').update(conversationSourceCanonical(value)).digest('hex');
export const conversationSourceBodyDigest=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
export const conversationSourceIdentity=(row:ConversationSourceRow,assistantId:string):ConversationSourceIdentity=>({actorId:row.actor_id,effectiveUserId:row.effective_user_id,assistantId,conversationId:row.conversation_id,entryId:row.entry_id,turnId:row.turn_id,speaker:row.speaker as 'human'|'assistant',modality:row.modality});
export const conversationSourceLegacyMember=(row:ConversationSourceRow,assistantId:string)=>({identityDigest:conversationSourceDigest(conversationSourceIdentity(row,assistantId)),versionDigest:conversationSourceDigest({identity:conversationSourceIdentity(row,assistantId),revision:row.revision,policyRef:row.policy_ref,retentionMode:row.retention_mode,expiresAt:row.expires_at,bodyUTF8SHA256:conversationSourceBodyDigest(row.retained_text??'')})});

export class ConversationHistoryRepository {
 private readonly cursorSecret:string;
 private privacySafety:ConversationPrivacySafety|undefined;
 private sourceHooks:ConversationSourceHooks|undefined;
 private readonly database:Database;
 private readonly options:{retention?:ConversationRetentionPolicy;now?:()=>number};
 constructor(database:Database,options:{retention?:ConversationRetentionPolicy;now?:()=>number}={}){
  this.database=database;this.options=options;
  database.connection.prepare('INSERT OR IGNORE INTO conversation_cursor_key VALUES(1,?)').run(randomBytes(32).toString('hex'));
  this.cursorSecret=this.one<{secret:string}>('SELECT secret FROM conversation_cursor_key WHERE singleton=1')!.secret;
 }
 /** Internal source owner ports; never exposed by the history HTTP request parser. */
 sourceRow(id:string):ConversationSourceRow|undefined{return this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE entry_id=?',id);}
 sourceAssistant(conversationId:string):string|undefined{return this.one<CatalogRow>('SELECT * FROM conversation_catalog WHERE conversation_id=?',conversationId)?.assistant_id;}
 sourceScopeRow(scope:ConversationHistoryScope,id:string):ConversationSourceRow{const row=this.sourceRow(id);if(!row||row.effective_user_id!==scope.effectiveUserId||row.actor_id!==scope.actorId)throw new ConversationHistoryError('forbidden','Source entry scope unavailable.');this.catalog(scope,row.conversation_id);return row;}
 sourceProjection(id:string){return this.one<{admission_id:string;entry_id:string;entry_identity_digest:string;closure_json:string;closure_digest:string;original_retention_json:string;original_retention_digest:string}>('SELECT * FROM conversation_source_admissions WHERE admission_id=?',id);}
 sourceContentProjection(id:string){return this.one<{content_commit_id:string;admission_id:string;entry_id:string;commit_json:string;commit_digest:string}>('SELECT * FROM conversation_source_content_commits WHERE admission_id=?',id);}
 sourceTablesReady(){return ['conversation_source_admissions','conversation_source_content_commits'].every(name=>!!this.one("SELECT name FROM sqlite_master WHERE type='table' AND name=?",name));}
 private *sourceLegacyRows():Generator<EntryRow>{
  const count=this.one<{n:number}>('SELECT COUNT(*) AS n FROM (SELECT entry_id FROM conversation_timeline LIMIT 10001)')!.n;
  if(count>10000)throw new ConversationHistoryError('backpressure','Source cutover inventory exceeds its complete bound.');
  for(const row of this.database.connection.prepare('SELECT * FROM conversation_timeline ORDER BY entry_id LIMIT 10001').iterate()){yield row as unknown as EntryRow;}
 }
 sourceLegacyInventory(){
  const members:Array<{identityDigest:string;versionDigest:string}>=[];
  for(const row of this.sourceLegacyRows()){
   if(row.content_state!=='retained')continue;
   const assistant=this.sourceAssistant(row.conversation_id);
   // This is exact historical custody, never a permission or source-free claim.
   // The existing Auth and original retention owner still govern every read.
   if(!assistant||row.retained_text===null)throw new ConversationHistoryError('unavailable','Legacy custody snapshot is incomplete.');
   members.push(conversationSourceLegacyMember(row,assistant));
  }
  return members.sort((a,b)=>a.identityDigest.localeCompare(b.identityDigest));
 }
 sourceInventoryFingerprint(){const digest=createHash('sha256');for(const row of this.sourceLegacyRows())digest.update(conversationSourceCanonical(row)).update('\n');return digest.digest('hex');}
 sourceRetainCurrent(retention:ConversationSourceRetention,scope:ConversationHistoryScope){return !!this.options.retention&&this.options.retention.current(retention.policyRef,scope)&&(retention.retentionMode==='untilDeletion'&&retention.expiresAt===null||retention.retentionMode==='untilExpiry'&&retention.expiresAt!==null&&Date.parse(retention.expiresAt)>this.now());}
 sourceApproval(identity:ConversationSourceIdentity,occurredAt:string,scope:ConversationHistoryScope):ConversationSourceRetention|null{
  const port=this.options.retention?.sourceApproval;if(!port)return null;const value=port.call(this.options.retention,{...identity,occurredAt,state:'accepted',expectedRevision:0,attribution:identity.speaker==='assistant'?'observedAssistantOutput':'authenticatedTypedOwner'},scope);return value?{policyRef:value.policyRef,retentionMode:value.retention==='untilDeletion'?'untilDeletion':'untilExpiry',expiresAt:value.expiresAt}:null;
 }
 sourceBegin(scope:ConversationHistoryScope,identity:ConversationSourceIdentity,admission:ConversationSourceAdmission,closure:ConversationSourceClosure,retention:ConversationSourceRetention,occurredAt:string,guard:()=>boolean){
  this.adopt(scope,identity.assistantId,identity.conversationId,occurredAt);
  return this.database.transaction(()=>{if(!guard())throw new ConversationHistoryError('unavailable','Source admission is no longer current.');let row=this.sourceRow(identity.entryId);if(!row){const catalog=this.catalog(scope,identity.conversationId);if(catalog.last_order>=10000)throw new ConversationHistoryError('backpressure','Conversation capacity reached.');this.run("INSERT INTO conversation_timeline VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",identity.entryId,identity.turnId,identity.conversationId,catalog.last_order+1,identity.actorId,identity.effectiveUserId,identity.speaker,identity.modality,'accepted','unavailable',null,null,null,1,occurredAt,occurredAt,null);this.run('UPDATE conversation_catalog SET last_order=last_order+1,revision=revision+1,event_sequence=event_sequence+1 WHERE conversation_id=?',identity.conversationId);this.touch(scope,identity.assistantId);row=this.sourceRow(identity.entryId);}
   if(!row||row.retained_text!==null||conversationSourceDigest(conversationSourceIdentity(row,identity.assistantId))!==conversationSourceDigest(identity))throw new ConversationHistoryError('unavailable','Source admission identity changed.');
   const existing=this.sourceProjection(admission.admissionId),values=[admission.admissionId,identity.entryId,conversationSourceDigest(identity),conversationSourceCanonical(closure),admission.closureDigest,conversationSourceCanonical(retention),admission.originalRetentionDigest];
   if(existing){if(existing.entry_id!==identity.entryId||existing.closure_digest!==admission.closureDigest||existing.original_retention_digest!==admission.originalRetentionDigest)throw new ConversationHistoryError('unavailable','Source admission projection differs.');}
   else this.run('INSERT INTO conversation_source_admissions VALUES(?,?,?,?,?,?,?)',...values);
   if(!guard())throw new ConversationHistoryError('unavailable','Source admission changed before publication.');return this.sourceRow(identity.entryId)!;
  });
 }
 sourceCommit(scope:ConversationHistoryScope,admission:ConversationSourceAdmission,commit:ConversationSourceCommit,body:string,guard:()=>boolean,initial?:{closure:ConversationSourceClosure;retention:ConversationSourceRetention}){
  return this.database.transaction(()=>{if(!guard())throw new ConversationHistoryError('unavailable','Source content is no longer current.');if(!this.sourceRow(admission.entryId)&&initial){const catalog=this.catalog(scope,admission.conversationId);if(catalog.assistant_id!==admission.assistantId||catalog.last_order>=10000||commit.expectedPreviousRevision!==0)throw new ConversationHistoryError('unavailable','Initial source entry unavailable.');this.run('INSERT INTO conversation_timeline VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',admission.entryId,admission.turnId,admission.conversationId,catalog.last_order+1,admission.actorId,admission.effectiveUserId,admission.speaker,admission.modality,'accepted','unavailable',null,null,null,0,commit.occurredAt,commit.occurredAt,null);this.run('INSERT INTO conversation_source_admissions VALUES(?,?,?,?,?,?,?)',admission.admissionId,admission.entryId,conversationSourceDigest({actorId:admission.actorId,effectiveUserId:admission.effectiveUserId,assistantId:admission.assistantId,conversationId:admission.conversationId,entryId:admission.entryId,turnId:admission.turnId,speaker:admission.speaker,modality:admission.modality}),conversationSourceCanonical(initial.closure),admission.closureDigest,conversationSourceCanonical(initial.retention),admission.originalRetentionDigest);this.run('UPDATE conversation_catalog SET last_order=last_order+1 WHERE conversation_id=?',admission.conversationId);}const row=this.sourceScopeRow(scope,admission.entryId),existing=this.sourceContentProjection(admission.admissionId);
   if(existing){if(existing.commit_digest!==conversationSourceDigest(commit))throw new ConversationHistoryError('revisionConflict','Source terminal commit differs.');return row;}
   const projection=this.sourceProjection(admission.admissionId);if(!projection||row.revision!==commit.expectedPreviousRevision||row.retained_text!==null||commit.committedRevision!==row.revision+1||conversationSourceBodyDigest(body)!==commit.bodyUTF8SHA256||Buffer.byteLength(body)!==commit.byteLength)throw new ConversationHistoryError('revisionConflict','Source content projection changed.');
   const retention=JSON.parse(projection.original_retention_json)as ConversationSourceRetention;
   this.run('INSERT INTO conversation_source_content_commits VALUES(?,?,?,?,?)',commit.contentCommitId,admission.admissionId,row.entry_id,conversationSourceCanonical(commit),conversationSourceDigest(commit));
   this.run("UPDATE conversation_timeline SET state=?,content_state='retained',retained_text=?,policy_ref=?,expires_at=?,retention_mode=?,revision=?,updated_at=? WHERE entry_id=?",commit.terminalState,body,'source-lineage:'+admission.admissionId,retention.expiresAt,retention.retentionMode,commit.committedRevision,commit.occurredAt,row.entry_id);
   this.run('UPDATE conversation_catalog SET revision=revision+1,event_sequence=event_sequence+1,last_activity_at=MAX(last_activity_at,?) WHERE conversation_id=?',commit.occurredAt,row.conversation_id);this.touch(scope,admission.assistantId);
   if(!guard())throw new ConversationHistoryError('unavailable','Source content changed before publication.');const final=this.sourceRow(row.entry_id)!,finalProjection=this.sourceProjection(admission.admissionId),finalCommit=this.sourceContentProjection(admission.admissionId);if(conversationSourceCanonical(finalProjection)!==conversationSourceCanonical(projection)||finalCommit?.commit_digest!==conversationSourceDigest(commit)||final.content_state!=='retained'||final.retention_mode!==retention.retentionMode||final.expires_at!==retention.expiresAt||conversationSourceDigest(conversationSourceIdentity(final,admission.assistantId))!==commit.entryIdentityDigest||final.revision!==commit.committedRevision||final.retained_text!==body||final.state!==commit.terminalState||final.updated_at!==commit.occurredAt||final.policy_ref!=='source-lineage:'+admission.admissionId)throw new ConversationHistoryError('unavailable','Source publication changed.');return final;
  });
 }
 sourceContext(scope:ConversationHistoryScope,id:string,assistantId:string){this.catalog(scope,id);return this.all<EntryRow>("SELECT * FROM conversation_timeline WHERE conversation_id=? AND speaker='assistant' AND state IN ('completed','failed','interrupted') ORDER BY ordinal DESC LIMIT 20",id).reverse().flatMap(row=>{const binding=this.sourceHooks?.binding(row,scope);return binding?[{interactionId:row.turn_id,role:'assistant' as const,text:row.retained_text!,binding}]:[];});}
 /** Server-owned safety is optional only for independent SQLite owner fixtures. */
 bindPrivacySafety(safety:ConversationPrivacySafety){this.privacySafety=safety;}
 bindSourceHooks(hooks:ConversationSourceHooks){this.sourceHooks=hooks;}
 privacyCurrent(){return this.privacySafety?.current()??true;}
 privacyInventory(){return {identity:createHash('sha256').update(this.cursorSecret).digest('hex'),fresh:Number(this.one<{n:number}>('SELECT ((SELECT COUNT(*) FROM conversation_catalog)+(SELECT COUNT(*) FROM conversation_timeline)+(SELECT COUNT(*) FROM conversation_content_fences)+(SELECT COUNT(*) FROM conversation_operations)+(SELECT COUNT(*) FROM conversation_catalog_clock)) AS n')!.n)===0,fences:this.all<{entryId:string;conversationId:string;revision:number;reason:string}>('SELECT entry_id AS entryId,conversation_id AS conversationId,revision,reason FROM conversation_content_fences ORDER BY entry_id')};}
 /** Denial-only replay: absent targets stay in the independent journal; no
  * fabricated catalog/turn is inserted to satisfy foreign keys. */
 validPrivacyIntent(value:unknown):value is ConversationPrivacyIntent{
  if(!value||typeof value!=='object')return false;const intent=value as ConversationPrivacyIntent;
  if(Object.keys(intent).sort().join()!=='actorId,assistantId,changedAt,conversationId,effectiveUserId,entryId,entryRevision,fenceRevision,modality,operation,reason,speaker,turnId'||![intent.actorId,intent.effectiveUserId,intent.assistantId,intent.conversationId,intent.entryId,intent.turnId].every(id=>typeof id==='string'&&uuid(id))||!['human','assistant'].includes(intent.speaker)||!['text','voice'].includes(intent.modality)||!['redacted','unavailable'].includes(intent.reason)||!validTime(intent.changedAt)||![intent.entryRevision,intent.fenceRevision].every(n=>Number.isSafeInteger(n)&&n>0&&n<Number.MAX_SAFE_INTEGER))return false;
  if(intent.operation!==null){const operation=intent.operation;if(!operation||Object.keys(operation).sort().join()!=='idempotencyKey,operationId,requestDigest,resultRevision'||![operation.operationId,operation.idempotencyKey].every(id=>typeof id==='string'&&uuid(id))||!Number.isSafeInteger(operation.resultRevision)||operation.resultRevision<1||intent.reason!=='redacted'||operation.requestDigest!==hash({operation:'eraseEntry',operationId:operation.operationId,idempotencyKey:operation.idempotencyKey,conversationId:intent.conversationId,entryId:intent.entryId,expectedRevision:intent.entryRevision}))return false;}
  return true;
 }
 /** A pending independent intent immediately withholds access if its SQLite
  * projection or operation acknowledgement has not committed. */
 privacyProjected(intents:readonly ConversationPrivacyIntent[]):boolean{
  const latest=new Map<string,ConversationPrivacyIntent>();for(const intent of intents)latest.set(intent.entryId,intent);
  for(const intent of latest.values()){
   const row=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE entry_id=?',intent.entryId)??this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE conversation_id=? AND turn_id=? AND speaker=?',intent.conversationId,intent.turnId,intent.speaker);
   if(row&&this.one('SELECT 1 FROM conversation_message_revisions WHERE entry_id=? LIMIT 1',row.entry_id))return false;
   if(row&&(row.conversation_id!==intent.conversationId||row.turn_id!==intent.turnId||(row.entry_id===intent.entryId&&row.actor_id!==intent.actorId)||row.effective_user_id!==intent.effectiveUserId||row.speaker!==intent.speaker||row.modality!==intent.modality||row.retained_text!==null||row.policy_ref!==null||row.expires_at!==null||row.retention_mode!==null||(row.content_state!==intent.reason&&row.content_state!=='redacted')))return false;
   if(row?.entry_id===intent.entryId){const fence=this.one<{revision:number;reason:string}>('SELECT revision,reason FROM conversation_content_fences WHERE entry_id=?',intent.entryId);if(!fence||fence.revision<intent.fenceRevision||(fence.reason!==intent.reason&&fence.reason!=='redacted'))return false;}
  }
  for(const intent of intents)if(intent.operation){const operation=intent.operation,row=this.one<OperationRow>('SELECT * FROM conversation_operations WHERE effective_user_id=? AND operation_id=?',intent.effectiveUserId,operation.operationId);if(!row||row.idempotency_key!==operation.idempotencyKey||row.assistant_id!==intent.assistantId||row.request_digest!==operation.requestDigest||row.result_json!==JSON.stringify(this.privacyOperationResult(intent)))return false;}
  return true;
 }
 private privacyOperationResult(intent:ConversationPrivacyIntent):HistoryOperationResult{return {schemaVersion:'1.0.0',operationId:intent.operation!.operationId,status:'completed',conversationId:intent.conversationId,revision:intent.operation!.resultRevision,error:null};}
 replayPrivacyIntent(intent:ConversationPrivacyIntent){
  if(!this.validPrivacyIntent(intent))throw new ConversationHistoryError('unavailable','Invalid closed conversation safety intent.');
  const row=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE entry_id=?',intent.entryId),catalog=this.one<CatalogRow>('SELECT * FROM conversation_catalog WHERE conversation_id=?',intent.conversationId);
  if(catalog&&(catalog.effective_user_id!==intent.effectiveUserId||catalog.assistant_id!==intent.assistantId)||row&&(row.conversation_id!==intent.conversationId||row.turn_id!==intent.turnId||(row.entry_id===intent.entryId&&row.actor_id!==intent.actorId)||row.effective_user_id!==intent.effectiveUserId||row.speaker!==intent.speaker||row.modality!==intent.modality))throw new ConversationHistoryError('unavailable','Conversation safety target belongs to another owner.');
  this.database.transaction(()=>{
   if(row){this.run('DELETE FROM conversation_message_revisions WHERE entry_id=?',row.entry_id);this.run('DELETE FROM conversation_message_ratings WHERE entry_id=?',row.entry_id);const fence=this.one<{revision:number;reason:string}>('SELECT revision,reason FROM conversation_content_fences WHERE entry_id=?',intent.entryId);
    if(fence&&fence.revision>=intent.fenceRevision){if(row.retained_text!==null||row.policy_ref!==null||row.expires_at!==null||row.retention_mode!==null||row.content_state!==fence.reason)throw new ConversationHistoryError('unavailable','Conversation safety projection is incomplete.');}
    else{const state=fence?.reason==='redacted'||intent.reason==='redacted'?'redacted':'unavailable';this.run('INSERT INTO conversation_content_fences VALUES(?,?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET revision=excluded.revision,reason=excluded.reason,changed_at=excluded.changed_at',intent.entryId,intent.conversationId,intent.fenceRevision,state,intent.changedAt);this.run('UPDATE conversation_timeline SET content_state=?,retained_text=NULL,policy_ref=NULL,expires_at=NULL,retention_mode=NULL,revision=MAX(revision,?) WHERE entry_id=?',state,intent.entryRevision+1,intent.entryId);this.run('UPDATE conversation_catalog SET revision=MAX(revision+1,?),event_sequence=event_sequence+1 WHERE conversation_id=?',intent.operation?.resultRevision??0,intent.conversationId);this.touch({actorId:intent.actorId,effectiveUserId:intent.effectiveUserId,contextGeneration:0},intent.assistantId);}
   }
   if(intent.operation){const operation=intent.operation,existing=this.one<OperationRow>('SELECT * FROM conversation_operations WHERE effective_user_id=? AND (operation_id=? OR idempotency_key=?)',intent.effectiveUserId,operation.operationId,operation.idempotencyKey),result=JSON.stringify(this.privacyOperationResult(intent));if(existing&&(existing.operation_id!==operation.operationId||existing.idempotency_key!==operation.idempotencyKey||existing.assistant_id!==intent.assistantId||existing.request_digest!==operation.requestDigest||existing.result_json!==result))throw new ConversationHistoryError('unavailable','Conversation erase operation identity differs.');if(!existing)this.run('INSERT INTO conversation_operations VALUES(?,?,?,?,?,?)',intent.effectiveUserId,operation.operationId,operation.idempotencyKey,intent.assistantId,operation.requestDigest,result);}
  });
 }
 private one<T>(sql:string,...args:unknown[]):T|undefined{return this.database.connection.prepare(sql).get(...args as never[]) as T|undefined;}
 private all<T>(sql:string,...args:unknown[]):T[]{return this.database.connection.prepare(sql).all(...args as never[]) as T[];}
 private run(sql:string,...args:unknown[]):void{this.database.connection.prepare(sql).run(...args as never[]);}
 private now(){return this.options.now?.()??Date.now();}
 private scope(scope:ConversationHistoryScope){if(scope.authorityCurrent&&!scope.authorityCurrent())throw new ConversationHistoryError('forbidden','Effective authority changed.');if(!this.privacyCurrent())throw new ConversationHistoryError('unavailable','Current independent conversation safety evidence is required.');if(!uuid(scope.actorId)||!uuid(scope.effectiveUserId)||(scope.actorId!==scope.effectiveUserId&&!scope.authorityCurrent?.())||!Number.isSafeInteger(scope.contextGeneration)||scope.contextGeneration<0)throw new ConversationHistoryError('forbidden','Current authenticated actor and effective account scope required.');}
 private catalog(scope:ConversationHistoryScope,id:string):CatalogRow{
  this.scope(scope);const row=this.one<CatalogRow>('SELECT * FROM conversation_catalog WHERE conversation_id=? AND effective_user_id=?',id,scope.effectiveUserId);
  if(!row)throw new ConversationHistoryError('notFound','Conversation unavailable in the current account.');return row;
 }
 private summary(row:CatalogRow):ConversationSummary{return {schemaVersion:'1.0.0',conversationId:row.conversation_id,assistantId:row.assistant_id,effectiveUserId:row.effective_user_id,title:row.title,revision:row.revision,createdAt:row.created_at,lastActivityAt:row.last_activity_at,archived:!!row.archived,pinned:!!row.pinned};}
 private clock(scope:ConversationHistoryScope,assistant:string){return this.one<{revision:number}>('SELECT revision FROM conversation_catalog_clock WHERE effective_user_id=? AND assistant_id=?',scope.effectiveUserId,assistant)?.revision??0;}
 private touch(scope:ConversationHistoryScope,assistant:string){this.run('INSERT INTO conversation_catalog_clock VALUES(?,?,1) ON CONFLICT(effective_user_id,assistant_id) DO UPDATE SET revision=revision+1',scope.effectiveUserId,assistant);}
 assistantForConversation(scope:ConversationHistoryScope,id:string){return this.catalog(scope,id).assistant_id;}
 assistantForOperation(scope:ConversationHistoryScope,id:string){this.scope(scope);return this.one<{assistant_id:string}>('SELECT assistant_id FROM conversation_operations WHERE effective_user_id=? AND operation_id=?',scope.effectiveUserId,id)?.assistant_id??null;}
 read(scope:ConversationHistoryScope,id:string):ConversationSummary{return this.summary(this.catalog(scope,id));}
 entryForTurn(scope:ConversationHistoryScope,id:string,turnId:string,speaker:TimelineEntry['speaker']):TimelineEntry|null{this.catalog(scope,id);let row=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE conversation_id=? AND turn_id=? AND speaker=?',id,turnId,speaker);if(row){this.expireContent(scope,row);row=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE entry_id=?',row.entry_id);}return row?this.entry(row,scope):null;}
 contentBoundary(scope:ConversationHistoryScope,id:string):string{
  if(!this.privacyCurrent())return hash(['conversationSafetyUnknown']);
  try{this.catalog(scope,id);}catch(error){if(error instanceof ConversationHistoryError&&error.code==='notFound')return hash([[],[]]);throw error;}
  for(const row of this.all<EntryRow>("SELECT * FROM conversation_timeline WHERE conversation_id=? AND content_state='retained'",id))this.expireContent(scope,row);
  const fences=this.all<{entry_id:string;revision:number}>('SELECT entry_id,revision FROM conversation_content_fences WHERE conversation_id=? ORDER BY entry_id',id);
  return hash([fences,this.one<{revision:number}>('SELECT revision FROM conversation_message_clock WHERE conversation_id=?',id)?.revision??0]);
 }
 /** Adopt only the genuine session conversation identity supplied by its host.
  * Neither volatile fallback identities nor historic text are imported. */
 adopt(scope:ConversationHistoryScope,assistant:string,id:string,occurredAt:string,admit?:()=>boolean):ConversationSummary{
  this.scope(scope);if(!uuid(assistant)||!uuid(id)||!validTime(occurredAt))throw new ConversationHistoryError('invalidRequest','Canonical session identity and source time required.');
  return this.database.transaction(()=>{if(admit&&!admit())throw new ConversationHistoryError('forbidden','Session conversation changed before adoption.');this.scope(scope);const existing=this.one<CatalogRow>('SELECT * FROM conversation_catalog WHERE conversation_id=?',id);if(existing){if(existing.effective_user_id!==scope.effectiveUserId||existing.assistant_id!==assistant)throw new ConversationHistoryError('notFound','Conversation identity unavailable in this Assistant/account.');return this.summary(existing);}
   if(this.one<{n:number}>('SELECT COUNT(*) AS n FROM conversation_catalog WHERE effective_user_id=?',scope.effectiveUserId)!.n>=1000)throw new ConversationHistoryError('backpressure','Conversation catalog capacity reached.');
   const at=new Date(occurredAt).toISOString();this.run('INSERT INTO conversation_catalog VALUES(?,?,?,?,?,1,?,?,0,0,0,0)',id,scope.actorId,scope.effectiveUserId,assistant,'Conversation',at,at);this.touch(scope,assistant);return this.read(scope,id);
  });
 }
 /** Host retirement of an already observed entry. This changes no plaintext,
  * speaker identity or policy and cannot create an entry after scope loss. */
 finish(scope:ConversationHistoryScope,conversationId:string,entryId:string,state:'completed'|'failed'|'interrupted',occurredAt:string,expectedRevision:number):TimelineEntry{
  const catalog=this.catalog(scope,conversationId);const existing=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE conversation_id=? AND entry_id=?',conversationId,entryId);if(existing)this.expireContent(scope,existing);if(!['completed','failed','interrupted'].includes(state)||!validTime(occurredAt))throw new ConversationHistoryError('invalidRequest','Observed terminal required.');
  return this.database.transaction(()=>{const row=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE conversation_id=? AND entry_id=?',conversationId,entryId);if(!row)throw new ConversationHistoryError('notFound','Observed entry unavailable.');if(row.revision!==expectedRevision)throw new ConversationHistoryError('revisionConflict','Timeline entry changed.');if(['completed','failed','interrupted'].includes(row.state)){if(row.state!==state)throw new ConversationHistoryError('invalidRequest','Terminal cannot reverse.');return this.entry(row,scope);}
   if(Date.parse(occurredAt)<Date.parse(row.updated_at))throw new ConversationHistoryError('invalidRequest','Source time cannot reverse.');const at=new Date(occurredAt).toISOString();this.run('UPDATE conversation_timeline SET state=?,updated_at=?,revision=revision+1 WHERE entry_id=?',state,at,entryId);this.run('UPDATE conversation_catalog SET last_activity_at=MAX(last_activity_at,?),revision=revision+1,event_sequence=event_sequence+1 WHERE conversation_id=?',at,conversationId);this.touch(scope,catalog.assistant_id);return this.entry(this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE entry_id=?',entryId)!,scope);
  });
 }
 /** An unexportable host closure admitted against one current originating entry.
  * Scope loss may only retire that exact existing metadata; no content is read,
  * created, returned or changed and a terminal can never be reversed. */
 metadataRetirement(scope:ConversationHistoryScope,conversationId:string,entryId:string,turnId:string,speaker:TimelineEntry['speaker']):(state:'failed'|'interrupted',at:string)=>void{
  const catalog=this.catalog(scope,conversationId),row=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE entry_id=?',entryId);
  if(!row||row.conversation_id!==conversationId||row.turn_id!==turnId||row.speaker!==speaker||row.actor_id!==scope.actorId||row.effective_user_id!==scope.effectiveUserId)throw new ConversationHistoryError('notFound','Originating entry unavailable.');
  return(state,at)=>{if(!['failed','interrupted'].includes(state)||!validTime(at))throw new ConversationHistoryError('invalidRequest','Denial terminal required.');this.database.transaction(tx=>{
   const current=tx.get<{state:string;revision:number;updated_at:string}>('SELECT state,revision,updated_at FROM conversation_timeline WHERE entry_id=? AND conversation_id=? AND turn_id=? AND speaker=? AND actor_id=? AND effective_user_id=?',entryId,conversationId,turnId,speaker,scope.actorId,scope.effectiveUserId);
   if(!current||['completed','failed','interrupted'].includes(current.state))return;const timestamp=new Date(Math.max(Date.parse(at),Date.parse(current.updated_at))).toISOString();
   tx.run('UPDATE conversation_timeline SET state=?,updated_at=?,revision=revision+1 WHERE entry_id=?',state,timestamp,entryId);tx.run('UPDATE conversation_catalog SET revision=revision+1,event_sequence=event_sequence+1 WHERE conversation_id=?',conversationId);this.touch(scope,catalog.assistant_id);
   tx.recordOwnerChange({owner:'conversationOriginRetirement',ownerId:entryId,principalId:scope.effectiveUserId,assistantId:catalog.assistant_id,beforeRevision:current.revision,afterRevision:current.revision+1});
  });};
 }
 private cursor(position:Position){const body=Buffer.from(JSON.stringify(position)).toString('base64url'),signature=createHmac('sha256',this.cursorSecret).update(body).digest('base64url');return body+'.'+signature;}
 private position(cursor:string|null|undefined,expected:Omit<Position,'offset'>):number{
  if(!cursor)return 0;
  try{
   if(cursor.length>2048||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor))throw Error();
   const [body,signature]=cursor.split('.'),actual=Buffer.from(signature!,'base64url'),known=createHmac('sha256',this.cursorSecret).update(body!).digest();if(actual.length!==known.length||!timingSafeEqual(actual,known))throw Error();
   const value=JSON.parse(Buffer.from(body!,'base64url').toString('utf8')) as Position;
   if(Object.keys(value).sort().join()!=='assistant,filter,kind,offset,revision,scope'||!Number.isSafeInteger(value.offset)||value.offset<0||value.offset>10000||['scope','assistant','kind','filter'].some(key=>value[key as keyof Position]!==expected[key as keyof typeof expected]))throw Error();
   if(value.revision!==expected.revision)throw new ConversationHistoryError('restartPage','The catalog changed; restart from its current snapshot.');return value.offset;
  }catch(error){if(error instanceof ConversationHistoryError)throw error;throw new ConversationHistoryError('invalidCursor','Cursor does not match this authorized query.');}
 }
 private pageSize(value:number|undefined,maximum=100){if(value!==undefined&&(!Number.isSafeInteger(value)||value<1||value>maximum))throw new ConversationHistoryError('invalidRequest','Page size outside the producing-owner bound.');return value??Math.min(50,maximum);}
 list(scope:ConversationHistoryScope,assistant:string,filter:'recent'|'pinned'|'archived',pageSize?:number,cursor?:string|null):ConversationPage{
  this.scope(scope);if(!uuid(assistant)||!['recent','pinned','archived'].includes(filter))throw new ConversationHistoryError('invalidRequest','Assistant and list filter required.');
  const expected={scope:scope.effectiveUserId,assistant,kind:'list',filter,revision:this.clock(scope,assistant)},offset=this.position(cursor,expected),limit=this.pageSize(pageSize);
  const clause=filter==='archived'?'archived=1':filter==='pinned'?'archived=0 AND pinned=1':'archived=0 AND pinned=0';
  const rows=this.all<CatalogRow>(`SELECT * FROM conversation_catalog WHERE effective_user_id=? AND assistant_id=? AND ${clause} ORDER BY last_activity_at DESC,conversation_id DESC LIMIT ? OFFSET ?`,scope.effectiveUserId,assistant,limit+1,offset);
  return {schemaVersion:'1.0.0',conversations:rows.slice(0,limit).map(row=>this.summary(row)),nextCursor:rows.length>limit?this.cursor({...expected,offset:offset+limit}):null};
 }
 operation(scope:ConversationHistoryScope,id:string):HistoryOperationResult{
  this.scope(scope);if(!uuid(id))throw new ConversationHistoryError('invalidRequest','Operation identity required.');const row=this.one<OperationRow>('SELECT * FROM conversation_operations WHERE effective_user_id=? AND operation_id=?',scope.effectiveUserId,id);
  return row?JSON.parse(row.result_json) as HistoryOperationResult:{schemaVersion:'1.0.0',operationId:id,status:'unknown',conversationId:null,error:null,revision:null};
 }
 mutate(scope:ConversationHistoryScope,request:Extract<HistoryRequest,{idempotencyKey:string}>):HistoryOperationResult{
  this.scope(scope);if(!validateConversationHistoryRecord('HistoryRequest',request).valid)throw new ConversationHistoryError('invalidRequest','Invalid producing-owner request.');
  const digest=hash(request);
  return this.database.transaction(tx=>{
   const existing=this.one<OperationRow>('SELECT * FROM conversation_operations WHERE effective_user_id=? AND (operation_id=? OR idempotency_key=?)',scope.effectiveUserId,request.operationId,request.idempotencyKey);
   if(existing){if(existing.operation_id!==request.operationId||existing.idempotency_key!==request.idempotencyKey||existing.request_digest!==digest)throw new ConversationHistoryError('idempotencyConflict','Operation identity is already bound to another request.');return JSON.parse(existing.result_json) as HistoryOperationResult;}
   let row:CatalogRow;
   if(request.operation==='create'){
    if(this.one<{n:number}>('SELECT COUNT(*) AS n FROM conversation_catalog WHERE effective_user_id=?',scope.effectiveUserId)!.n>=1000)throw new ConversationHistoryError('backpressure','Conversation catalog capacity reached.');
    const id=randomUUID(),at=new Date(this.now()).toISOString();this.run('INSERT INTO conversation_catalog VALUES(?,?,?,?,?,1,?,?,0,0,0,0)',id,scope.actorId,scope.effectiveUserId,request.payload.assistantId,request.payload.title,at,at);row=this.catalog(scope,id);
   }else{
    row=this.catalog(scope,request.payload.conversationId);if(row.revision!==request.payload.expectedRevision)throw new ConversationHistoryError('revisionConflict','Conversation changed; refresh before applying.');
    if(row.revision===Number.MAX_SAFE_INTEGER)throw new ConversationHistoryError('backpressure','Conversation revision exhausted.');
    const title=request.operation==='rename'?request.payload.title:row.title,archived=request.operation==='archive'?1:request.operation==='restore'?0:row.archived;
    const pinned=request.operation==='archive'||request.operation==='restore'||request.operation==='unpin'?0:request.operation==='pin'?1:row.pinned;
    if(request.operation==='pin'&&row.archived)throw new ConversationHistoryError('invalidRequest','Restore an archived conversation before pinning.');
    this.run('UPDATE conversation_catalog SET title=?,archived=?,pinned=?,revision=revision+1,event_sequence=event_sequence+1 WHERE conversation_id=? AND revision=?',title,archived,pinned,row.conversation_id,row.revision);row=this.catalog(scope,row.conversation_id);
   }
   tx.recordOwnerChange({owner:'conversationCatalog',ownerId:row.conversation_id,principalId:scope.effectiveUserId,assistantId:row.assistant_id,beforeRevision:row.revision-1,afterRevision:row.revision});this.touch(scope,row.assistant_id);const result:HistoryOperationResult={schemaVersion:'1.0.0',operationId:request.operationId,status:'completed',conversationId:row.conversation_id,error:null,revision:row.revision};
   this.run('INSERT INTO conversation_operations VALUES(?,?,?,?,?,?)',scope.effectiveUserId,request.operationId,request.idempotencyKey,row.assistant_id,digest,JSON.stringify(result));return result;
  });
 }
 /** Host-observed entry API for authorized canonical text/voice producers.
  * No source text is stored unless its exact injected owning policy approves it. */
 observe(scope:ConversationHistoryScope,source:ObservedTimelineEntry,expectedAssistantId?:string):TimelineEntry{
  source=Object.freeze({...source});
  const row=this.catalog(scope,source.conversationId);if(expectedAssistantId!==undefined&&row.assistant_id!==expectedAssistantId)throw new ConversationHistoryError('notFound','Conversation identity unavailable in this Assistant/account.');if(!uuid(source.entryId)||!uuid(source.turnId)||!validTime(source.occurredAt)||Date.parse(source.occurredAt)<Date.parse(row.created_at)||!Number.isSafeInteger(source.expectedRevision)||source.expectedRevision<0)throw new ConversationHistoryError('invalidRequest','Stable entry identities, revision and genuine source time required.');
  const proposed:TimelineEntry={schemaVersion:'1.0.0',entryId:source.entryId,turnId:source.turnId,conversationId:source.conversationId,order:1,actorId:scope.actorId,effectiveUserId:scope.effectiveUserId,speaker:source.speaker,modality:source.modality,state:source.state,content:{state:'unavailable'},revision:1,createdAt:source.occurredAt,updatedAt:source.occurredAt,artifactRefs:[]};
  if(!validateConversationHistoryRecord('TimelineEntry',proposed).valid||source.text!==undefined&&(typeof source.text!=='string'||source.text.length>32768))throw new ConversationHistoryError('invalidRequest','Invalid observed timeline metadata.');
  const at=new Date(source.occurredAt).toISOString();
  const retained=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE conversation_id=? AND entry_id=?',source.conversationId,source.entryId);if(retained)this.expireContent(scope,retained);
  return this.database.transaction(()=>{
   const existing=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE entry_id=?',source.entryId);if(existing&&(existing.conversation_id!==source.conversationId||existing.turn_id!==source.turnId||existing.actor_id!==scope.actorId||existing.speaker!==source.speaker||existing.modality!==source.modality))throw new ConversationHistoryError('notFound','Entry identity unavailable.');
   if((existing?.revision??0)!==source.expectedRevision)throw new ConversationHistoryError('revisionConflict','Timeline entry changed.');
   if(existing&&(this.sourceHooks?.linked(existing)||existing.policy_ref?.startsWith('source-lineage:'))&&source.text!==undefined)throw new ConversationHistoryError('unavailable','Source content requires its terminal witness.');
   const rank={submitted:0,accepted:1,generating:2,completed:3,failed:3,interrupted:3};
   if(existing&&(Date.parse(source.occurredAt)<Date.parse(existing.updated_at)||rank[source.state]<rank[existing.state]||rank[existing.state]===3&&existing.state!==source.state))throw new ConversationHistoryError('invalidRequest','Source lifecycle cannot reverse an entry state or its time.');
   if(!existing&&row.last_order>=10000)throw new ConversationHistoryError('backpressure','Conversation timeline capacity reached.');
   const denial=this.privacySafety?.blocked(source.entryId)??this.privacySafety?.blockedTurn?.(source.conversationId,source.turnId,source.speaker);if(denial&&((denial.entryId===source.entryId&&denial.actorId!==scope.actorId)||denial.effectiveUserId!==scope.effectiveUserId||denial.assistantId!==row.assistant_id||denial.conversationId!==source.conversationId||denial.turnId!==source.turnId||denial.speaker!==source.speaker||denial.modality!==source.modality))throw new ConversationHistoryError('unavailable','Denied entry identity belongs to another scope.');
   const fenced=!!denial||!!this.one('SELECT 1 FROM conversation_content_fences WHERE entry_id=?',source.entryId);
   let approval:ConversationRetentionApproval|null=null;
   if(!fenced&&existing?.content_state!=='redacted'&&source.text!==undefined&&this.options.retention){const candidate=this.options.retention.retain(Object.freeze({...source}),Object.freeze({...scope}));if(candidate&&typeof candidate.policyRef==='string'&&candidate.policyRef.length>0&&candidate.policyRef.length<=256&&((candidate.retention==='untilDeletion'&&candidate.expiresAt===null)||((candidate.retention===undefined||candidate.retention==='untilExpiry')&&typeof candidate.expiresAt==='string'&&validTime(candidate.expiresAt)&&Date.parse(candidate.expiresAt)>this.now()))&&this.options.retention.current(candidate.policyRef,scope))approval=candidate;}
   // Optional policy retirement or an unavailable approval must not erase an until-deletion body. Explicit independent denial fences/redaction remain authoritative.
   if(existing?.content_state==='retained'&&existing.retention_mode==='untilDeletion'&&!approval&&!fenced)throw new ConversationHistoryError('unavailable','The current retention owner cannot replace saved content.');
   const state=existing?.content_state==='redacted'||denial?.reason==='redacted'?'redacted':fenced?'unavailable':approval?'retained':'unavailable',order=existing?.ordinal??row.last_order+1,revision=Math.max(existing?.revision??0,denial?.entryId===source.entryId?denial.entryRevision:0)+1;
   // A denied entry absent from a restored snapshot must acquire its fence
   // atomically with re-observation, without changing original actor custody.
   if(denial?.entryId===source.entryId)this.run("INSERT INTO conversation_content_fences VALUES(?,?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET revision=MAX(revision,excluded.revision),reason=CASE WHEN reason='redacted' THEN reason ELSE excluded.reason END",source.entryId,source.conversationId,denial.fenceRevision,denial.reason,denial.changedAt);
   this.run('INSERT INTO conversation_timeline (entry_id,turn_id,conversation_id,ordinal,actor_id,effective_user_id,speaker,modality,state,content_state,retained_text,policy_ref,expires_at,revision,created_at,updated_at,retention_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET state=excluded.state,content_state=excluded.content_state,retained_text=excluded.retained_text,policy_ref=excluded.policy_ref,expires_at=excluded.expires_at,retention_mode=excluded.retention_mode,revision=excluded.revision,updated_at=excluded.updated_at',source.entryId,source.turnId,source.conversationId,order,scope.actorId,scope.effectiveUserId,source.speaker,source.modality,source.state,state,approval?source.text:null,approval?.policyRef??null,approval?.expiresAt??null,revision,existing?.created_at??at,at,approval?(approval.retention==='untilDeletion'?'untilDeletion':'untilExpiry'):null);
   this.run('UPDATE conversation_catalog SET last_order=MAX(last_order,?),last_activity_at=MAX(last_activity_at,?),revision=revision+1,event_sequence=event_sequence+1 WHERE conversation_id=?',order,at,source.conversationId);this.touch(scope,row.assistant_id);return this.entry(this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE entry_id=?',source.entryId)!,scope);
  });
 }
 private entry(row:EntryRow,scope:ConversationHistoryScope):TimelineEntry{let readable=row.content_state==='retained';const linked=this.sourceHooks?.linked(row)||row.policy_ref?.startsWith('source-lineage:');if(readable&&linked){try{readable=this.sourceHooks?.readable(row,scope)===true;}catch{readable=false;}}else if(readable&&this.sourceHooks&&!this.sourceHooks.ordinaryReadable(row)){readable=false;}else if(readable&&row.retention_mode==='untilDeletion')try{readable=!!this.options.retention&&this.options.retention.current(row.policy_ref!,scope);}catch{readable=false;}return {schemaVersion:'1.0.0',entryId:row.entry_id,turnId:row.turn_id,conversationId:row.conversation_id,order:row.ordinal,actorId:row.actor_id,effectiveUserId:row.effective_user_id,speaker:row.speaker,modality:row.modality,state:row.state,content:readable?{state:'retained',text:row.retained_text!}:{state:row.content_state==='retained'?'unavailable':row.content_state},revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at,artifactRefs:[]};}
 /** Fence an old grant before any replacement/read/retirement. Its erasure is
  * committed separately so a later stale CAS rejection cannot roll it back. */
 private expireContent(scope:ConversationHistoryScope,row:EntryRow){
  if(row.content_state!=='retained'||row.retention_mode==='untilDeletion')return;
  let permitted=false;try{permitted=!!this.options.retention&&(row.retention_mode==='untilExpiry'&&Date.parse(row.expires_at!)>this.now())&&(this.sourceHooks?.linked(row)?this.sourceHooks.readable(row,scope):this.options.retention.current(row.policy_ref!,scope));}catch{/* An unavailable owning policy cannot preserve plaintext. */}
  if(!permitted)this.redact(scope,row.conversation_id,row.entry_id,row.revision,'unavailable');
 }
 private sweep(scope:ConversationHistoryScope,assistant:string){
  const retained=this.all<EntryRow>('SELECT t.* FROM conversation_timeline t JOIN conversation_catalog c ON c.conversation_id=t.conversation_id WHERE c.effective_user_id=? AND c.assistant_id=? AND t.content_state=?',scope.effectiveUserId,assistant,'retained');
  for(const row of retained)this.expireContent(scope,row);
 }
 /** Explicit retention withdrawal only. Access/identity/audience loss never invokes this erasure. */
 withdrawPolicy(scope:ConversationHistoryScope,assistantId:string,policyRef:string){
  this.scope(scope);if(!uuid(assistantId)||typeof policyRef!=='string'||policyRef.length>256)throw new ConversationHistoryError('invalidRequest','An exact owning policy reference is required.');
  const rows=this.all<EntryRow>('SELECT t.* FROM conversation_timeline t JOIN conversation_catalog c ON c.conversation_id=t.conversation_id WHERE c.effective_user_id=? AND c.assistant_id=? AND t.policy_ref=? AND t.content_state=?',scope.effectiveUserId,assistantId,policyRef,'retained');
  for(const row of rows)this.redact(scope,row.conversation_id,row.entry_id,row.revision,'unavailable');
 }
 redact(scope:ConversationHistoryScope,conversationId:string,entryId:string,expectedRevision:number,state:'redacted'|'unavailable'='redacted'){
  return this.database.transaction(()=>this.redactContent(scope,conversationId,entryId,expectedRevision,state));
 }
 private redactContent(scope:ConversationHistoryScope,conversationId:string,entryId:string,expectedRevision:number,state:'redacted'|'unavailable',operation:ConversationPrivacyIntent['operation']=null){
  if(!['redacted','unavailable'].includes(state)||!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw new ConversationHistoryError('invalidRequest','Valid redaction state and revision required.');const catalog=this.catalog(scope,conversationId);const entry=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE conversation_id=? AND entry_id=?',conversationId,entryId);if(!entry)throw new ConversationHistoryError('notFound','Timeline entry unavailable.');if(entry.revision!==expectedRevision)throw new ConversationHistoryError('revisionConflict','Timeline entry changed.');
  if(entry.content_state==='redacted')state='redacted';
  this.run('DELETE FROM conversation_message_revisions WHERE entry_id=?',entryId);this.run('DELETE FROM conversation_message_ratings WHERE entry_id=?',entryId);
  const fenceRevision=(this.one<{revision:number}>('SELECT revision FROM conversation_content_fences WHERE entry_id=?',entryId)?.revision??0)+1,changedAt=new Date(this.now()).toISOString();
  this.privacySafety?.admit({actorId:entry.actor_id,effectiveUserId:scope.effectiveUserId,assistantId:catalog.assistant_id,conversationId,entryId,turnId:entry.turn_id,speaker:entry.speaker,modality:entry.modality,entryRevision:entry.revision,fenceRevision,reason:state,changedAt,operation});
   this.run('INSERT INTO conversation_content_fences VALUES(?,?,1,?,?) ON CONFLICT(entry_id) DO UPDATE SET revision=revision+1,reason=excluded.reason,changed_at=excluded.changed_at',entryId,conversationId,state,new Date(this.now()).toISOString());
   this.run('UPDATE conversation_timeline SET content_state=?,retained_text=NULL,policy_ref=NULL,expires_at=NULL,retention_mode=NULL,revision=revision+1 WHERE entry_id=?',state,entryId);this.run('UPDATE conversation_catalog SET revision=revision+1,event_sequence=event_sequence+1 WHERE conversation_id=?',conversationId);this.touch(scope,catalog.assistant_id);return this.entry(this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE entry_id=?',entryId)!,scope);
 
 }
 erase(scope:ConversationHistoryScope,input:{operationId:string;idempotencyKey:string;conversationId:string;entryId:string;expectedRevision:number}):HistoryOperationResult{
  this.scope(scope);if(Object.keys(input).sort().join()!=='conversationId,entryId,expectedRevision,idempotencyKey,operationId'||!uuid(input.operationId)||!uuid(input.idempotencyKey)||!uuid(input.conversationId)||!uuid(input.entryId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)throw new ConversationHistoryError('invalidRequest','Closed revision-bound entry erasure required.');const digest=hash({operation:'eraseEntry',...input});
  return this.database.transaction(tx=>{const row=this.catalog(scope,input.conversationId),existing=this.one<OperationRow>('SELECT * FROM conversation_operations WHERE effective_user_id=? AND (operation_id=? OR idempotency_key=?)',scope.effectiveUserId,input.operationId,input.idempotencyKey);if(existing){if(existing.operation_id!==input.operationId||existing.idempotency_key!==input.idempotencyKey||existing.request_digest!==digest)throw new ConversationHistoryError('idempotencyConflict','Operation identity already used.');return JSON.parse(existing.result_json) as HistoryOperationResult;}
   this.redactContent(scope,input.conversationId,input.entryId,input.expectedRevision,'redacted',{operationId:input.operationId,idempotencyKey:input.idempotencyKey,requestDigest:digest,resultRevision:row.revision+1});const result:HistoryOperationResult={schemaVersion:'1.0.0',operationId:input.operationId,status:'completed',conversationId:input.conversationId,revision:row.revision+1,error:null};tx.recordOwnerChange({owner:'conversationEntryErasure',ownerId:input.entryId,principalId:scope.effectiveUserId,assistantId:row.assistant_id,beforeRevision:input.expectedRevision,afterRevision:input.expectedRevision+1});this.run('INSERT INTO conversation_operations VALUES(?,?,?,?,?,?)',scope.effectiveUserId,input.operationId,input.idempotencyKey,row.assistant_id,digest,JSON.stringify(result));return result;
  });
 }
 messageForSpeech(scope:ConversationHistoryScope,id:string,entryId:string,revision:number):string{this.catalog(scope,id);const row=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE conversation_id=? AND entry_id=?',id,entryId);if(!row)throw new ConversationHistoryError('notFound','Message unavailable.');this.expireContent(scope,row);const fresh=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE entry_id=?',entryId)!,entry=this.entry(fresh,scope);if(scope.actorId!==scope.effectiveUserId||entry.speaker!=='assistant'||!['completed','failed','interrupted'].includes(entry.state)||entry.revision!==revision||entry.content.state!=='retained'||this.privacySafety?.blocked(entryId))throw new ConversationHistoryError('forbidden','Current retained Assistant reply required.');return entry.content.text;}
 feedbackContext(scope:ConversationHistoryScope,id:string){this.catalog(scope,id);const rows=this.all<{entry_id:string;rating:'good'|'bad'}>("SELECT r.entry_id,r.rating FROM conversation_message_ratings r JOIN conversation_timeline t ON t.entry_id=r.entry_id WHERE t.conversation_id=? AND r.effective_user_id=? ORDER BY t.ordinal DESC LIMIT 20",id,scope.effectiveUserId);return rows.flatMap(value=>{const row=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE entry_id=?',value.entry_id)!;this.expireContent(scope,row);const fresh=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE entry_id=?',row.entry_id)!,entry=this.entry(fresh,scope);return entry.content.state==='retained'?[{entryId:entry.entryId,interactionId:entry.turnId,state:entry.state,rating:value.rating,assistantResponseExcerpt:entry.content.text.slice(0,500),excerptTruncated:entry.content.text.length>500}]:[];});}

 /** Explicit owner annotations never promote transcript content into durable memory. */
 ratings(scope:ConversationHistoryScope,id:string){this.catalog(scope,id);return this.all<{entryId:string;rating:'good'|'bad'}>("SELECT r.entry_id AS entryId,r.rating FROM conversation_message_ratings r JOIN conversation_timeline t ON t.entry_id=r.entry_id WHERE t.conversation_id=? AND r.effective_user_id=? AND t.content_state='retained' ORDER BY t.ordinal",id,scope.effectiveUserId).filter(r=>{const row=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE entry_id=?',r.entryId)!;this.expireContent(scope,row);return this.entry(this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE entry_id=?',r.entryId)!,scope).content.state==='retained';});}
 message(scope:ConversationHistoryScope,input:{schemaVersion:'1.0.0';operation:'edit'|'rate'|'fork';conversationId:string;entryId:string;expectedRevision:number;operationId:string;idempotencyKey:string;text?:string;rating?:'good'|'bad'|null}):HistoryOperationResult{
  this.scope(scope);const expected=['schemaVersion','operation','conversationId','entryId','expectedRevision','operationId','idempotencyKey',...(input.operation==='edit'?['text']:input.operation==='rate'?['rating']:[])].sort().join();
  if(scope.actorId!==scope.effectiveUserId)throw new ConversationHistoryError('forbidden','Message changes require the authenticated owner.');
  if(Object.keys(input).sort().join()!==expected||input.schemaVersion!=='1.0.0'||!['edit','rate','fork'].includes(input.operation)||![input.conversationId,input.entryId,input.operationId,input.idempotencyKey].every(uuid)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||input.operation==='edit'&&(typeof input.text!=='string'||!input.text.trim()||input.text.length>32768)||input.operation==='rate'&&input.rating!==null&&!['good','bad'].includes(input.rating!))throw new ConversationHistoryError('invalidRequest','Closed revision-bound message request required.');
  const catalog=this.catalog(scope,input.conversationId),digest=hash(input);
  const target=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE conversation_id=? AND entry_id=?',input.conversationId,input.entryId);if(target)this.expireContent(scope,target);
  return this.database.transaction(tx=>{
   const existing=this.one<OperationRow>('SELECT * FROM conversation_operations WHERE effective_user_id=? AND (operation_id=? OR idempotency_key=?)',scope.effectiveUserId,input.operationId,input.idempotencyKey);
   if(existing){if(existing.operation_id!==input.operationId||existing.idempotency_key!==input.idempotencyKey||existing.request_digest!==digest||existing.assistant_id!==catalog.assistant_id)throw new ConversationHistoryError('idempotencyConflict','Message operation identity already used.');return JSON.parse(existing.result_json) as HistoryOperationResult;}
   const row=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE conversation_id=? AND entry_id=?',input.conversationId,input.entryId);if(!row)throw new ConversationHistoryError('notFound','Message unavailable.');
   if(row.revision!==input.expectedRevision)throw new ConversationHistoryError('revisionConflict','Message changed.');
   if((row.speaker==='assistant'?!['completed','failed','interrupted'].includes(row.state):row.state!=='completed')||this.entry(row,scope).content.state!=='retained'||this.privacySafety?.blocked(row.entry_id)||this.one('SELECT 1 FROM conversation_content_fences WHERE entry_id=?',row.entry_id))throw new ConversationHistoryError('forbidden','A terminal currently retained Assistant reply or completed human message is required.');
   const at=new Date(Math.max(this.now(),Date.parse(row.updated_at))).toISOString();let conversationId=input.conversationId;
   if((input.operation==='rate'||input.operation==='edit')&&(this.sourceHooks?.linked(row)||row.policy_ref?.startsWith('source-lineage:')))throw new ConversationHistoryError('forbidden','Source-linked replies cannot yet be edited or rated.');
   if(input.operation==='edit'){
    if(this.one<{n:number}>('SELECT COUNT(*) AS n FROM conversation_message_revisions WHERE entry_id=?',row.entry_id)!.n>=1000)throw new ConversationHistoryError('backpressure','Message revision capacity reached.');
    if(row.speaker!=='human'||row.actor_id!==scope.actorId||row.state!=='completed')throw new ConversationHistoryError('forbidden','Only your own human message may be edited.');
    // Admit only after every operation-specific authorization/capacity check.
    this.sourceHooks?.ordinaryCopy(conversationSourceIdentity(row,catalog.assistant_id));
    this.run('INSERT INTO conversation_message_revisions VALUES(?,?,?,?)',row.entry_id,row.revision,row.retained_text,at);
    this.run('UPDATE conversation_timeline SET retained_text=?,revision=revision+1,updated_at=? WHERE entry_id=?',input.text,at,row.entry_id);
   }else if(input.operation==='rate'){
    if(row.speaker!=='assistant')throw new ConversationHistoryError('forbidden','Only Assistant replies may be rated.');
    this.sourceHooks?.ordinaryCopy(conversationSourceIdentity(row,catalog.assistant_id));
    if(input.rating===null)this.run('DELETE FROM conversation_message_ratings WHERE entry_id=?',row.entry_id);
    else this.run('INSERT INTO conversation_message_ratings VALUES(?,?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET rating=excluded.rating,updated_at=excluded.updated_at',row.entry_id,scope.actorId,scope.effectiveUserId,input.rating,at);
    this.run('UPDATE conversation_timeline SET revision=revision+1,updated_at=? WHERE entry_id=?',at,row.entry_id);
   }else{
    const rows=this.all<EntryRow>('SELECT * FROM conversation_timeline WHERE conversation_id=? AND ordinal<=? ORDER BY ordinal',input.conversationId,row.ordinal);
    if(rows.some(item=>this.sourceHooks?.linked(item)||item.policy_ref?.startsWith('source-lineage:')))throw new ConversationHistoryError('forbidden','A fork containing source-linked replies is unavailable.');
    if(this.one<{n:number}>('SELECT COUNT(*) AS n FROM conversation_catalog WHERE effective_user_id=?',scope.effectiveUserId)!.n>=1000)throw new ConversationHistoryError('backpressure','Conversation capacity reached.');
    conversationId=randomUUID();this.run('INSERT INTO conversation_catalog VALUES(?,?,?,?,?,1,?,?,0,0,0,?)',conversationId,scope.actorId,scope.effectiveUserId,catalog.assistant_id,('Fork: '+catalog.title).slice(0,160),at,at,rows.length);
    const turns=new Map<string,string>();let ordinal=0;
    for(const source of rows){this.expireContent(scope,source);const fresh=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE entry_id=?',source.entry_id)!;const readable=this.entry(fresh,scope).content.state==='retained'&&!this.privacySafety?.blocked(fresh.entry_id);if(!turns.has(fresh.turn_id))turns.set(fresh.turn_id,randomUUID());const copiedId=randomUUID();if(readable&&this.sourceHooks)this.sourceHooks.ordinaryCopy({actorId:fresh.actor_id,effectiveUserId:scope.effectiveUserId,assistantId:catalog.assistant_id,conversationId,entryId:copiedId,turnId:turns.get(fresh.turn_id)!,speaker:fresh.speaker as 'human'|'assistant',modality:fresh.modality});this.run('INSERT INTO conversation_timeline VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',copiedId,turns.get(fresh.turn_id),conversationId,++ordinal,fresh.actor_id,scope.effectiveUserId,fresh.speaker,fresh.modality,fresh.state,readable?'retained':fresh.content_state==='redacted'?'redacted':'unavailable',readable?fresh.retained_text:null,readable?fresh.policy_ref:null,readable?fresh.expires_at:null,1,fresh.created_at,fresh.updated_at,readable?fresh.retention_mode:null);}
    this.run('INSERT INTO conversation_forks VALUES(?,?,?,?)',conversationId,input.conversationId,input.entryId,row.ordinal);
   }
   this.run('UPDATE conversation_catalog SET revision=revision+1,event_sequence=event_sequence+1 WHERE conversation_id=?',input.conversationId);this.touch(scope,catalog.assistant_id);this.run('INSERT INTO conversation_message_clock VALUES(?,1) ON CONFLICT(conversation_id) DO UPDATE SET revision=revision+1',input.conversationId);this.scope(scope);
   const result:HistoryOperationResult={schemaVersion:'1.0.0',operationId:input.operationId,status:'completed',conversationId,revision:this.catalog(scope,conversationId).revision,error:null};
   tx.recordOwnerChange({owner:'conversationMessage'+input.operation,ownerId:row.entry_id,principalId:scope.effectiveUserId,assistantId:catalog.assistant_id,beforeRevision:row.revision,afterRevision:input.operation==='fork'?row.revision:row.revision+1});
   this.run('INSERT INTO conversation_operations VALUES(?,?,?,?,?,?)',scope.effectiveUserId,input.operationId,input.idempotencyKey,catalog.assistant_id,digest,JSON.stringify(result));return result;
  });
 }
 /** Host-only retained context for the selected self-owned conversation.
  * Host checks selection/Assistant authority before and after this bounded read.
  */
 selectedContext(scope:ConversationHistoryScope,id:string,assistantId:string){
  const catalog=this.catalog(scope,id);
  if(scope.actorId!==scope.effectiveUserId||catalog.assistant_id!==assistantId)throw new ConversationHistoryError('forbidden','Selected self-owned conversation scope required.');
  if(catalog.actor_id!==scope.actorId)return [];
  const rows=this.all<EntryRow>("SELECT * FROM conversation_timeline WHERE conversation_id=? AND actor_id=? AND effective_user_id=? AND ((speaker='human' AND state='completed') OR (speaker='assistant' AND state IN ('completed','failed','interrupted'))) ORDER BY ordinal DESC LIMIT 20",id,scope.actorId,scope.effectiveUserId).reverse();
  const turns=rows.flatMap(row=>{this.expireContent(scope,row);this.scope(scope);const fresh=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE entry_id=?',row.entry_id)!;const entry=this.entry(fresh,scope);return entry.content.state==='retained'&&!this.privacySafety?.blocked(entry.entryId)?[{interactionId:entry.turnId,role:entry.speaker==='human'?'user' as const:'assistant' as const,text:entry.content.text}]:[];});
  this.scope(scope);return turns;
 }
 /** Only explicit forks import retained cutoff context. Ordinary history is not backfilled. */
 forkContext(scope:ConversationHistoryScope,id:string){this.catalog(scope,id);if(!this.one('SELECT 1 FROM conversation_forks WHERE conversation_id=?',id))return [];const rows=this.all<EntryRow>("SELECT * FROM conversation_timeline WHERE conversation_id=? AND ((speaker='human' AND state='completed') OR (speaker='assistant' AND state IN ('completed','failed','interrupted'))) ORDER BY ordinal DESC LIMIT 20",id).reverse();return rows.flatMap(row=>{this.expireContent(scope,row);const fresh=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE entry_id=?',row.entry_id)!,entry=this.entry(fresh,scope);return entry.content.state==='retained'?[{interactionId:entry.turnId,role:entry.speaker==='human'?'user' as const:'assistant' as const,state:entry.state,text:entry.content.text}]:[];});}
 private timelineCursor(position:TimelinePosition){
  const body=Buffer.from(JSON.stringify(position)).toString('base64url'),signature=createHmac('sha256',this.cursorSecret).update(body).digest('base64url');return body+'.'+signature;
 }
 private timelinePosition(cursor:string|null|undefined,scope:ConversationHistoryScope,row:CatalogRow,direction:'older'|'newer'):TimelinePosition{
  const expected={version:2 as const,kind:'timelineKeyset' as const,actor:scope.actorId,effective:scope.effectiveUserId,generation:scope.contextGeneration,assistant:row.assistant_id,conversation:row.conversation_id,direction};
  if(!Number.isSafeInteger(row.last_order)||row.last_order<0||row.last_order>=Number.MAX_SAFE_INTEGER)throw new ConversationHistoryError('backpressure','Timeline ordinal boundary is unavailable.');
  if(cursor===null||cursor===undefined)return {...expected,upper:row.last_order,boundary:direction==='older'?row.last_order+1:0};
  try{
   if(typeof cursor!=='string'||cursor.length>2048||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor))throw Error();
   const [body,signature]=cursor.split('.'),actual=Buffer.from(signature!,'base64url'),known=createHmac('sha256',this.cursorSecret).update(body!).digest();
   if(actual.length!==known.length||!timingSafeEqual(actual,known))throw Error();
   const value=JSON.parse(Buffer.from(body!,'base64url').toString('utf8')) as TimelinePosition;
   if(!value||Object.keys(value).sort().join()!=='actor,assistant,boundary,conversation,direction,effective,generation,kind,upper,version'||Object.keys(expected).some(key=>value[key as keyof TimelinePosition]!==expected[key as keyof typeof expected])||!Number.isSafeInteger(value.upper)||value.upper<0||value.upper>row.last_order||!Number.isSafeInteger(value.boundary)||value.boundary<0||value.boundary>value.upper+1)throw Error();
   return value;
  }catch{throw new ConversationHistoryError('invalidCursor','Cursor does not match this authenticated timeline snapshot.');}
 }
 page(scope:ConversationHistoryScope,id:string,direction:'older'|'newer',pageSize?:number,cursor?:string|null):TimelinePage{
  let row=this.catalog(scope,id);if(!['older','newer'].includes(direction))throw new ConversationHistoryError('invalidRequest','Timeline direction required.');this.sweep(scope,row.assistant_id);row=this.catalog(scope,id);
  const position=this.timelinePosition(cursor,scope,row,direction),limit=this.pageSize(pageSize,50);
  // Unique per-conversation ordinals, not timestamps or offsets, are the stable
  // key. The first page captures an immutable upper bound; later appends stay
  // outside this snapshot until an explicit owner refresh.
  const selected=this.all<EntryRow>(`SELECT * FROM conversation_timeline WHERE conversation_id=? AND ordinal<=? AND ordinal ${direction==='older'?'<':'>'} ? ORDER BY ordinal ${direction==='older'?'DESC':'ASC'} LIMIT ?`,id,position.upper,position.boundary,limit+1);
  const entries:TimelineEntry[]=[];let entryBytes=2;
  // Reserve16KiB for the native producer envelope/limitations and4KiB for the
  // closed page fields plus both signed cursors. Never truncate a stored body.
  for(const value of selected.slice(0,limit)){
   const entry=this.entry(value,scope),bytes=Buffer.byteLength(JSON.stringify(entry),'utf8')+(entries.length?1:0);
   if(entryBytes+bytes>262144-16384-4096){if(!entries.length)throw new ConversationHistoryError('backpressure','A timeline entry exceeds the response byte bound.');break;}
   entries.push(entry);entryBytes+=bytes;
  }
  if(direction==='older')entries.reverse();
  let olderCursor:string|null=null,newerCursor:string|null=null;
  if(entries.length){
   const low=entries[0]!.order,high=entries.at(-1)!.order;
   if(this.one('SELECT 1 FROM conversation_timeline WHERE conversation_id=? AND ordinal<=? AND ordinal<? LIMIT 1',id,position.upper,low))olderCursor=this.timelineCursor({...position,direction:'older',boundary:low});
   if(this.one('SELECT 1 FROM conversation_timeline WHERE conversation_id=? AND ordinal<=? AND ordinal>? LIMIT 1',id,position.upper,high))newerCursor=this.timelineCursor({...position,direction:'newer',boundary:high});
  }
  const result:TimelinePage={schemaVersion:'1.0.0',conversationId:id,entries,nextCursor:direction==='older'?olderCursor:newerCursor,previousCursor:direction==='older'?newerCursor:olderCursor,eventSequence:row.event_sequence,contextGeneration:scope.contextGeneration};
  if(Buffer.byteLength(JSON.stringify(result),'utf8')+16384>262144)throw new ConversationHistoryError('backpressure','Timeline response exceeds the producer envelope bound.');
  this.scope(scope);if(position.actor!==scope.actorId||position.effective!==scope.effectiveUserId||position.generation!==scope.contextGeneration)throw new ConversationHistoryError('forbidden','Timeline scope changed during projection.');return result;
 }
 search(scope:ConversationHistoryScope,assistant:string,query:string,pageSize?:number,cursor?:string|null):SearchPage{
  this.scope(scope);if(!uuid(assistant)||typeof query!=='string'||query.length>512)throw new ConversationHistoryError('invalidRequest','Authorized bounded search required.');this.sweep(scope,assistant);
  const expected={scope:scope.effectiveUserId,assistant,kind:'search',filter:hash(query),revision:this.clock(scope,assistant)},offset=this.position(cursor,expected),limit=this.pageSize(pageSize,50);
  if(!query.trim())return {schemaVersion:'1.0.0',state:'available',results:[],nextCursor:null};
  const hits=this.all<{conversationId:string;entryId:string|null;excerpt:string;occurredAt:string}>(`SELECT conversation_id AS conversationId,NULL AS entryId,title AS excerpt,last_activity_at AS occurredAt FROM conversation_catalog WHERE effective_user_id=? AND assistant_id=? AND instr(lower(title),lower(?))>0 UNION ALL SELECT t.conversation_id,t.entry_id,t.retained_text,t.created_at FROM conversation_timeline t JOIN conversation_catalog c ON c.conversation_id=t.conversation_id WHERE c.effective_user_id=? AND c.assistant_id=? AND t.content_state='retained' AND instr(lower(t.retained_text),lower(?))>0 ORDER BY occurredAt DESC,conversationId DESC,entryId DESC LIMIT ? OFFSET ?`,scope.effectiveUserId,assistant,query,scope.effectiveUserId,assistant,query,limit+1,offset);
  return {schemaVersion:'1.0.0',state:'available',results:hits.slice(0,limit).filter(hit=>{if(hit.entryId===null)return true;const entry=this.one<EntryRow>('SELECT * FROM conversation_timeline WHERE entry_id=?',hit.entryId);return !!entry&&this.entry(entry,scope).content.state==='retained';}).map(hit=>({...hit,excerpt:excerpt(hit.excerpt,query)})),nextCursor:hits.length>limit?this.cursor({...expected,offset:offset+limit}):null};
 }
}
