import {personaComponent,PERSONA_BACKUP_PATH,PERSONA_BACKUP_REF} from './persona-backup.ts';
import {AssistantProfileRepository,ConversationHistoryRepository,type ConversationHistoryScope,type Database,type AssistantProfile} from '@lifestream/storage-sqlite';
import {LocalAuthentication,canonicalAuthSessionCustody,type LocalContext} from '../auth/local-auth.ts';
import {promptDocument} from './prompt-document.ts';
import {RecoveryJournal} from './recovery-journal.ts';
import {packContinuity,checkContinuity,continuityDigest,CONTINUITY_LIMITS,type ContinuityBinding,type ContinuityBundle} from './continuity-adapter.ts';

export type ContinuityPrivacyOwner={epoch:()=>string;current:(binding:ContinuityBinding)=>boolean;digestAllowed:(binding:ContinuityBinding,digest:string)=>boolean;sourceAllowed:(binding:ContinuityBinding,text:string,digest:string)=>boolean};
/** Internal host capture only. No request/imported object supplies these owners.
 * The server captures its existing repository; this adapter creates no store. */
export type ContinuityHistoryOwner={readonly database:Database;readonly authentication:LocalAuthentication;readonly context:LocalContext;readonly repository:ConversationHistoryRepository;readonly scope:Readonly<ConversationHistoryScope>;readonly current:()=>boolean;readonly ordinarySelf:()=>boolean};
/** Existing host must supply its actual recovery/suppression owner. This is a
 * bounded export/preview adapter, not a memory store or activation authority.
 * No request or imported data may construct owner callbacks. */
export class ContinuityAdministration{
 private readonly profiles:AssistantProfileRepository;
 constructor(private readonly options:{database:Database;authentication:LocalAuthentication;privacy:ContinuityPrivacyOwner;history?:ContinuityHistoryOwner;now?:()=>number;exportJournal?:RecoveryJournal}){
  if(!(options.authentication instanceof LocalAuthentication)||!canonicalAuthSessionCustody(options.authentication,options.database)||!options.privacy||!['epoch','current','digestAllowed','sourceAllowed'].every(k=>typeof options.privacy[k as keyof ContinuityPrivacyOwner]==='function'))throw Error('continuity_actual_owners_required');
  this.profiles=new AssistantProfileRepository(options.database);
 }
 private selected(context:LocalContext,target:ContinuityBinding,allowDraftTarget=false){
  const auth=this.options.authentication;auth.assertCurrent(context,false);if(!canonicalAuthSessionCustody(auth,this.options.database)||!auth.canAdminister(context,target.assistantId))throw Error('continuity_target_not_authorized');
  const map=this.options.database.connection.prepare('SELECT principal_id AS principalId FROM user_subject_mappings WHERE user_id=? AND deployment_id=?').get(target.userId,target.deploymentId) as {principalId:string}|undefined;
  const row=this.options.database.connection.prepare('SELECT payload_json AS json FROM assistant_relationships WHERE relationship_id=? AND assistant_id=? AND user_id=?').get(target.relationshipId,target.assistantId,target.userId) as {json:string}|undefined;
  const relationship=row?JSON.parse(row.json) as Record<string,unknown>:undefined;
  if(!map||map.principalId!==auth.effectiveUser(context)||!relationship||relationship.relationshipId!==target.relationshipId||relationship.assistantId!==target.assistantId||relationship.userId!==target.userId||relationship.deploymentId!==target.deploymentId||relationship.status!=='active'||!this.options.privacy.current({...target}))throw Error('continuity_relationship_unavailable');
  const profiles=this.profiles.list(target.assistantId),profile=profiles.find(p=>p.status==='active')??null;if(!profiles.length||!profile&&!allowDraftTarget)throw Error('continuity_active_profile_unavailable');
  const snapshot={target:{...target},profile,relationship,privacyEpoch:this.options.privacy.epoch()};auth.assertCurrent(context,false);return snapshot;
 }
 private pin(value:unknown){return continuityDigest(Buffer.from(JSON.stringify(value)));}
 export(context:LocalContext,target:ContinuityBinding):ContinuityBundle{
  const before=this.selected(context,target),binding=this.pin(before),files=[{path:'owner/assistant-profile.json',value:before.profile},{path:'owner/relationship.json',value:before.relationship}].map(f=>({path:f.path,mediaType:'application/json',classification:'ownerSnapshot' as const,bytes:Buffer.from(JSON.stringify(f.value))}));
  for(const f of files)if(!this.options.privacy.digestAllowed(target,continuityDigest(f.bytes))||!this.options.privacy.sourceAllowed(target,f.bytes.toString('utf8'),continuityDigest(f.bytes)))throw Error('continuity_export_source_withheld');
  const bundle=packContinuity({binding:target,sourceRef:'existing-owner-view',capturedAt:new Date(this.options.now?.()??Date.now()).toISOString(),basis:'ownerView',files,limitations:['Existing owner-view serialization; original authored text values are preserved, not original JSON whitespace.','No complete account history, external model/voice assets, grants or rebuildable indexes are exported by this first packet.']});
  if(this.pin(this.selected(context,target))!==binding)throw Error('continuity_scope_changed');return bundle;
 }
 /** Explicit active persona projection of the ORIGINAL existing owner export.
  * Full profile and relationship stay internal; selected output is still untrusted on import. */
 exportPersonaComponent(context:LocalContext,target:ContinuityBinding,input:{sourceProfileId:string;sourceRevision:number;expectedRevision:number},permitted:(profile:AssistantProfile)=>boolean):ContinuityBundle{
  const journal=this.options.exportJournal;if(!(journal instanceof RecoveryJournal))throw Error('persona_backup_source_withheld');
  const journalCurrent=RecoveryJournal.prototype.current.bind(journal),journalRevision=journal.revision;
  const profiles=this.profiles.list(target.assistantId),active=profiles.find(p=>p.status==='active'),latest=profiles.at(-1);
  if(!active||!latest||active.profileId!==input.sourceProfileId||active.revision!==input.sourceRevision||latest.revision!==input.expectedRevision)throw Error('revision_conflict');
  const rowsPin=this.pin(profiles),ownerPin=this.pin(this.selected(context,target)),epoch=this.options.privacy.epoch();
  const stamp=()=>this.pin([(this.options.database.connection.prepare('SELECT total_changes() AS n').get() as {n:number}).n,(this.options.database.connection.prepare('PRAGMA data_version').get() as {data_version:number}).data_version]);const sqlPin=stamp();
  const original=this.export(context,target),file=original.files.find(f=>f.path==='owner/assistant-profile.json');
  if(!file||file.classification!=='ownerSnapshot')throw Error('persona_backup_source_withheld');
  const profile=JSON.parse(Buffer.from(file.bytesBase64,'base64').toString('utf8')) as AssistantProfile;
  if(this.pin(profile)!==this.pin(active))throw Error('continuity_scope_changed');
  const bytes=Buffer.from(JSON.stringify(personaComponent(profile))),digest=continuityDigest(bytes);
  const bundle=packContinuity({binding:target,sourceRef:PERSONA_BACKUP_REF,basis:'ownerView',capturedAt:new Date(this.options.now?.()??Date.now()).toISOString(),files:[{path:PERSONA_BACKUP_PATH,classification:'ownerSnapshot',mediaType:'application/json',bytes}],limitations:['Selected active persona only, for the same existing private target. No account or clean-deployment restore.','Untrusted manual content on import: checksums prove bytes, not source authenticity or unknown offline withdrawal. No voice, provider, assets, history, memory or grants.']});
  if(!permitted(active)||!this.options.privacy.digestAllowed(target,digest)||!this.options.privacy.sourceAllowed(target,bytes.toString('utf8'),digest))throw Error('persona_backup_source_withheld');
  const observed=this.selected(context,target),observedEpoch=this.options.privacy.epoch();
  // Every extensible owner callback has finished. No callbacks after this guard.
  if(this.pin(observed)!==ownerPin||observedEpoch!==epoch||this.pin(this.profiles.list(target.assistantId))!==rowsPin||stamp()!==sqlPin||!journalCurrent()||journal.revision!==journalRevision)throw Error('continuity_scope_changed');
  return bundle;
 }
 /** Selected canonical authored strings only; no profile/relationship serialization.
  * The host supplies its existing profile-wide suppression check, never a request callback. */
 exportAuthoredSections(context:LocalContext,target:ContinuityBinding,input:{profileId:string;expectedRevision:number;sectionIds:string[]},permitted:(profile:AssistantProfile)=>boolean):ContinuityBundle{
  const journal=this.options.exportJournal;if(!(journal instanceof RecoveryJournal))throw Error('continuity_export_source_withheld');
  const journalCurrent=RecoveryJournal.prototype.current.bind(journal),journalRevision=journal.revision;
  const ownerPin=this.pin(this.selected(context,target)),profiles=this.profiles.list(target.assistantId),latest=profiles.at(-1);
  if(!latest||latest.profileId!==input.profileId||latest.revision!==input.expectedRevision||!['active','draft'].includes(latest.status))throw Error('continuity_profile_changed');
  const doc=promptDocument(latest);
  if(!doc||!Array.isArray(input.sectionIds)||input.sectionIds.length<1||input.sectionIds.length>16||new Set(input.sectionIds).size!==input.sectionIds.length||input.sectionIds.some(id=>typeof id!=='string'||!doc.sections.some(section=>section.sectionId===id)))throw Error('continuity_sections_invalid');
  const profilePin=this.pin(profiles),privacyEpoch=this.options.privacy.epoch();
  const databaseStamp=()=>this.pin([(this.options.database.connection.prepare('SELECT total_changes() AS n').get() as {n:number}).n,(this.options.database.connection.prepare('PRAGMA data_version').get() as {data_version:number}).data_version]);
  const databasePin=databaseStamp();
  const current=()=>{
   if(!permitted(latest)||!this.options.privacy.current(target))throw Error('continuity_export_source_withheld');
   // All supplied permission/currentness callbacks run before the final pure
   // independent journal and repository/stamp checks. The captured journal
   // method reads the real file, unlike the cached privacy epoch. No supplied
   // callback follows this guard.
   const owner=this.selected(context,target),epoch=this.options.privacy.epoch();
   if(!journalCurrent()||journal.revision!==journalRevision||this.pin(owner)!==ownerPin||epoch!==privacyEpoch||this.pin(this.profiles.list(target.assistantId))!==profilePin||databaseStamp()!==databasePin)throw Error('continuity_scope_changed');
  };
  current();
  const files=input.sectionIds.map((id,index)=>{
   const section=doc.sections.find(s=>s.sectionId===id)!,bytes=Buffer.from(section.text,'utf8'),digest=continuityDigest(bytes);
   if(!this.options.privacy.digestAllowed(target,digest)||!this.options.privacy.sourceAllowed(target,section.text,digest))throw Error('continuity_export_source_withheld');
   return {path:`authored/section-${index+1}.txt`,classification:'authoredPersona' as const,mediaType:'text/plain',bytes};
  });
  const bundle=packContinuity({binding:target,sourceRef:`profile:${latest.profileId}:${latest.revision}:document:${doc.documentId}:${doc.revision}`,capturedAt:new Date(this.options.now?.()??Date.now()).toISOString(),basis:'ownerView',files,limitations:['Only explicitly selected existing authored prompt sections; not a full profile, relationship, memory or account export.','UTF8 bytes preserve stored authored strings, not original JSON file formatting.','No grants, assets, activation, automatic import or restoration acceptance. Import requires separate explicit section/kind selection and target mapping.']});
  current();return bundle;
 }
 /** Export one explicit current conversation from the host's ordinary-self capture.
  * Catalogue/account provenance is preserved; it is not relationship attribution. */
 private retainedConversation(context:LocalContext,target:ContinuityBinding,conversationId:string){
  const h=this.options.history,effective=context.effectiveContext;
  if(!h||h.database!==this.options.database||h.authentication!==this.options.authentication||h.context!==context||!(h.repository instanceof ConversationHistoryRepository)||typeof h.current!=='function'||typeof h.ordinarySelf!=='function'||h.scope.authorityCurrent!==h.current||!effective||!context.contextRef||effective.actorId!==context.principalId||effective.authenticatedSessionId!==context.sessionId||effective.effectiveUserId!==context.principalId||h.scope.actorId!==context.principalId||h.scope.effectiveUserId!==context.principalId||h.scope.contextGeneration!==effective.generation)throw Error('continuity_history_owner_required');
  const access=()=>{this.options.authentication.assertCurrent(context,false);if(!h.current()||!h.ordinarySelf()||!h.repository.privacyCurrent())throw Error('continuity_history_private_scope_required');};
  access();const ownerPin=this.pin(this.selected(context,target));
  // Let the existing owner apply its own expiry fences before fixing the view.
  const boundary=h.repository.contentBoundary(h.scope,conversationId),conversation=h.repository.read(h.scope,conversationId);
  if(conversation.assistantId!==target.assistantId||conversation.effectiveUserId!==context.principalId)throw Error('continuity_history_target_not_owned');
  const historyPin=this.pin(conversation);
  // This is a conservative stability guard, never authority. Existing owner
  // callbacks run first; no callback or content read follows the final pin.
  // Recheck the actual independent history journal after callbacks, then include
  // other-connection commits without duplicating the history projection.
  const databaseWrites=()=>this.pin([(this.options.database.connection.prepare('SELECT total_changes() AS n').get() as {n:number}).n,(this.options.database.connection.prepare('PRAGMA data_version').get() as {data_version:number}).data_version]);
  const databasePin=databaseWrites();
  const current=()=>{access();if(h.repository.contentBoundary(h.scope,conversationId)!==boundary||this.pin(h.repository.read(h.scope,conversationId))!==historyPin||this.pin(this.selected(context,target))!==ownerPin||!h.repository.privacyCurrent()||databaseWrites()!==databasePin)throw Error('continuity_history_scope_changed');};
  const base=this.export(context,target);current();
  const projection={sourceScope:'authenticatedAssistantAccount' as const,conversation,entries:[] as unknown[]};
  let used=Buffer.byteLength(JSON.stringify(projection)),cursor:string|null=null,lastOrder=0;const cursors=new Set<string>();
  if(used>CONTINUITY_LIMITS.fileBytes)throw Error('continuity_history_bound');
  do {
   current();const page=h.repository.page(h.scope,conversationId,'newer',50,cursor);current();
   if(page.conversationId!==conversationId||page.contextGeneration!==h.scope.contextGeneration||(!page.entries.length&&page.nextCursor!==null))throw Error('continuity_history_projection_invalid');
   for(const entry of page.entries){
    if(!Number.isSafeInteger(entry.order)||entry.order<=lastOrder)throw Error('continuity_history_projection_invalid');
    const encoded=JSON.stringify(entry),size=Buffer.byteLength(encoded)+(projection.entries.length?1:0);
    if(used+size>CONTINUITY_LIMITS.fileBytes)throw Error('continuity_history_bound');
    projection.entries.push(JSON.parse(encoded));used+=size;lastOrder=entry.order;
   }
   cursor=page.nextCursor;
   if(cursor!==null){if(typeof cursor!=='string'||cursors.has(cursor))throw Error('continuity_history_projection_invalid');cursors.add(cursor);}
  }while(cursor!==null);
  const bytes=Buffer.from(JSON.stringify(projection));if(bytes.length>CONTINUITY_LIMITS.fileBytes)throw Error('continuity_history_bound');
  const digest=continuityDigest(bytes);if(!this.options.privacy.digestAllowed(target,digest)||!this.options.privacy.sourceAllowed(target,bytes.toString('utf8'),digest))throw Error('continuity_export_source_withheld');
  current();const bundle=packContinuity({binding:target,sourceRef:'existing-retained-conversation-owner-view',capturedAt:new Date(this.options.now?.()??Date.now()).toISOString(),basis:'ownerView',files:[...base.files.map(f=>({path:f.path,mediaType:f.mediaType,classification:f.classification,bytes:Buffer.from(f.bytesBase64,'base64')})),{path:'owner/retained-conversation.json',mediaType:'application/json',classification:'rawConversation',bytes}],limitations:[...base.coverage.limitations,'Only one explicitly selected currently owned retained conversation is projected, not a complete account/history export.','Conversation catalogue ownership is Assistant/account scoped; no original relationship attribution is inferred.','Current content states and tombstones remain observations; no memory, grants, source use, restore or activation is admitted.','Signed cursors, session tokens and host capability objects are not exported. Existing owner retention sweeps may apply expiry before projection.']});
  current();return {bundle,current};
 }
 exportRetainedConversation(context:LocalContext,target:ContinuityBinding,conversationId:string):ContinuityBundle{return this.retainedConversation(context,target,conversationId).bundle;}
 previewRetainedConversation(context:LocalContext,target:ContinuityBinding,conversationId:string){const selected=this.retainedConversation(context,target,conversationId),preview=this.preview(context,target,selected.bundle,{mapping:'sameIdentity'});selected.current();return preview;}
 preview(context:LocalContext,target:ContinuityBinding,raw:unknown,options:{mapping:'sameIdentity'|'explicitClonePreview';allowDraftTarget?:boolean}):{previewOnly:true;executionGrants:'notImported';target:ContinuityBinding;sourceBinding:ContinuityBinding|null;activeProfileId:string|null;ownerDigest:string;sourceDigest:string;files:{path:string;classification:string;byteLength:number;sha256:string}[];limitations:string[]}{
  const before=this.selected(context,target,options?.allowDraftTarget===true),binding=this.pin(before),bundle=checkContinuity(raw);
  if(!options||!['sameIdentity','explicitClonePreview'].includes(options.mapping)||options.mapping==='sameIdentity'&&JSON.stringify(bundle.binding&&[bundle.binding.assistantId,bundle.binding.userId,bundle.binding.relationshipId,bundle.binding.deploymentId])!==JSON.stringify([target.assistantId,target.userId,target.relationshipId,target.deploymentId]))throw Error('continuity_explicit_target_mapping_required');
  for(const file of bundle.files){const bytes=Buffer.from(file.bytesBase64,'base64');if(!this.options.privacy.digestAllowed(target,file.sha256))throw Error('continuity_source_revoked');let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{if(file.classification!=='reference')throw Error('continuity_text_encoding_invalid');continue;}if(!this.options.privacy.sourceAllowed(target,text,file.sha256))throw Error('continuity_source_revoked');}
  if(this.pin(this.selected(context,target,options?.allowDraftTarget===true))!==binding)throw Error('continuity_scope_changed');
  return {previewOnly:true,executionGrants:'notImported',target:{...target},sourceBinding:bundle.binding,activeProfileId:before.profile?.profileId??null,ownerDigest:binding,sourceDigest:this.pin(bundle),files:bundle.files.map(({path,classification,byteLength,sha256})=>({path,classification,byteLength,sha256})),limitations:[...bundle.coverage.limitations,'No persona, relationship, memory or source use is activated. Existing owner review/Save/activate operations must validate any later selected change.','Persona version rollback and memory correction are separate owning operations; preview cannot restore or undo either.']};
 }
}
