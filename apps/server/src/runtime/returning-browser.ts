import {randomUUID} from 'node:crypto';
import type {Database} from '@lifestream/storage-sqlite';

type Actor={principalId:string;sessionId:string;effectiveContext?:{effectiveUserId:string}};
type Preference={principal_id:string;binding_key:string;endpoint_id:string;account_epoch:number;revision:number;authority_epoch:number;state:'enabled'|'withheld'|'locked'|'revoked';mode:'text'|'audio';audience_scope:'unknown'|'authenticatedSession';endpoint_revision:number;privacy_profile:string;assistant_id:string|null;conversation_id:string|null;provenance:string;source_session_id:string};
type Ports={assertCurrent:(actor:Actor)=>void;canUseAssistant:(actor:Actor,id:string)=>boolean;invalidate:(principalId:string,endpointId:string,withdraw:boolean)=>void};
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function returningBrowserInput(value:unknown):{bindingKey:string|null;pendingLock:boolean}{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!=='bindingKey,pendingLock')return {bindingKey:null,pendingLock:true};
 const input=value as Record<string,unknown>;
 return {bindingKey:uuid(input.bindingKey)?input.bindingKey:null,pendingLock:input.pendingLock!==false};
}

/** Server-only durable owner. All policy writes use WAL-fsynced transactions.
 * No endpoint creation/reconfiguration, old token/session revival, history/body
 * query, device start, retention change or inferred legacy disclosure occurs.
 */
export class ReturningBrowserPreferences{
 private readonly database:Database;private readonly ports:Ports;
 constructor(database:Database,ports:Ports){this.database=database;this.ports=ports;}
 private actor(actor:Actor):number{
  this.ports.assertCurrent(actor);
  if(actor.effectiveContext&&actor.effectiveContext.effectiveUserId!==actor.principalId)throw Error('returning_self_context_required');
  const account=this.database.connection.prepare('SELECT epoch,disabled FROM local_accounts WHERE principal_id=?').get(actor.principalId) as {epoch:number;disabled:number}|undefined;
  const local=this.database.connection.prepare('SELECT principal_id,epoch,revoked FROM local_sessions WHERE session_id=?').get(actor.sessionId) as {principal_id:string;epoch:number;revoked:number}|undefined;
  if(!account||account.disabled||!local||local.revoked||local.principal_id!==actor.principalId||local.epoch!==account.epoch)throw Error('returning_authentication_changed');
  return account.epoch;
 }
 private binding(actor:Actor,key:string){
  if(!uuid(key))throw Error('returning_binding_invalid');
  return this.database.connection.prepare('SELECT b.endpoint_id,e.configuration_revision,e.endpoint_class,e.ownership,e.health,e.profile_json FROM endpoint_bindings b JOIN interaction_endpoints e ON e.endpoint_id=b.endpoint_id WHERE b.principal_id=? AND b.binding_key=?').get(actor.principalId,key) as {endpoint_id:string;configuration_revision:number;endpoint_class:string;ownership:string;health:string;profile_json:string}|undefined;
 }
 private privacyProfile(binding:NonNullable<ReturnType<ReturningBrowserPreferences['binding']>>):string{
  const profile=JSON.parse(binding.profile_json);
  const modalities=(value:unknown)=>Array.isArray(value)&&value.includes('text')&&value.length<=2&&new Set(value).size===value.length&&value.every(item=>item==='text'||item==='audio');
  if(!modalities(profile.inputModalities)||!modalities(profile.outputModalities))throw Error('returning_invalid_modalities');
  delete profile.inputModalities;delete profile.outputModalities;delete profile.configurationRevision;
  return JSON.stringify(profile);
 }
 private suitable(binding:ReturnType<ReturningBrowserPreferences['binding']>):boolean{
  if(!binding||binding.endpoint_class!=='desktopCompanion'||binding.ownership!=='personal'||binding.health!=='healthy')return false;
  const p=JSON.parse(binding.profile_json);
  return p.endpointId===binding.endpoint_id&&p.configurationRevision===binding.configuration_revision&&p.endpointClass==='desktopCompanion'&&p.ownership==='personal'&&p.health==='healthy';
 }
 read(actor:Actor,key:string):Preference|null{this.actor(actor);return this.database.connection.prepare('SELECT * FROM returning_browser_preferences WHERE principal_id=? AND binding_key=?').get(actor.principalId,key) as Preference|undefined??null;}
 private selection(actor:Actor,conversationId:string|null){
  if(!conversationId||!uuid(conversationId))return null;
  const row=this.database.connection.prepare('SELECT assistant_id,conversation_id FROM conversation_catalog WHERE conversation_id=? AND actor_id=? AND effective_user_id=? AND archived=0').get(conversationId,actor.principalId,actor.principalId) as {assistant_id:string;conversation_id:string}|undefined;
  return row&&this.ports.canUseAssistant(actor,row.assistant_id)&&this.database.connection.prepare("SELECT 1 FROM assistant_profiles WHERE assistant_id=? AND status='active'").get(row.assistant_id)?row:null;
 }
 /** Called after a successful authenticated Session disclosure Save, or explicit
  * Unlock. Save alone cannot remove a previous durable Lock or revocation. */
 save(actor:Actor,key:string,explicitUnlock=false):Preference{
  const accountEpoch=this.actor(actor);let endpoint='';
  const saved=this.database.durableTransaction(tx=>{
   const binding=this.binding(actor,key);if(!this.suitable(binding))throw Error('returning_personal_endpoint_required');endpoint=binding!.endpoint_id;
   const session=tx.get<{conversation_id:string;endpoint_id:string;mode:'text'|'audio';audience_scope:'unknown'|'authenticatedSession';configuration_revision:number}>("SELECT s.conversation_id,s.endpoint_id,c.mode,c.audience_scope,c.configuration_revision FROM sessions s JOIN session_endpoint_settings c ON c.session_id=s.id AND c.endpoint_id=s.endpoint_id WHERE s.id=? AND s.status='active'",actor.sessionId);
   if(!session||session.endpoint_id!==endpoint||session.configuration_revision!==binding!.configuration_revision)throw Error('returning_current_settings_required');
   const old=tx.get<Preference>('SELECT * FROM returning_browser_preferences WHERE principal_id=? AND binding_key=?',actor.principalId,key);
   const privacyProfile=this.privacyProfile(binding!);
   const state=session.audience_scope==='unknown'?'withheld':explicitUnlock?'enabled':old?.state==='enabled'&&old.privacy_profile===privacyProfile?'enabled':old?.state==='revoked'?'revoked':'locked';
   if(explicitUnlock&&(session.audience_scope!=='authenticatedSession'||JSON.parse(binding!.profile_json).privacyClass!=='personal'))throw Error('returning_unlock_requires_personal_settings');
   const choice=this.selection(actor,session.conversation_id);
   const next:Preference={principal_id:actor.principalId,binding_key:key,endpoint_id:endpoint,account_epoch:accountEpoch,revision:(old?.revision??0)+1,authority_epoch:(old?.authority_epoch??0)+(state!=='enabled'||old?.state!=='enabled'?1:0),state,mode:session.mode,audience_scope:session.audience_scope,endpoint_revision:binding!.configuration_revision,privacy_profile:privacyProfile,assistant_id:choice?.assistant_id??old?.assistant_id??null,conversation_id:choice?.conversation_id??null,provenance:explicitUnlock?'explicitUnlock':state==='enabled'&&old?old.provenance:state==='withheld'?'withhold':'savedContext',source_session_id:state==='enabled'&&!explicitUnlock&&old?old.source_session_id:actor.sessionId};
   this.put(tx,next);this.actor(actor);return next;
  });
  this.ports.invalidate(actor.principalId,endpoint,saved.state!=='enabled');return saved;
 }
 private put(tx:any,value:Preference):void{
  tx.run('INSERT INTO returning_browser_preferences(principal_id,binding_key,endpoint_id,account_epoch,revision,authority_epoch,state,mode,audience_scope,endpoint_revision,privacy_profile,assistant_id,conversation_id,provenance,source_session_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(principal_id,binding_key) DO UPDATE SET endpoint_id=excluded.endpoint_id,account_epoch=excluded.account_epoch,revision=excluded.revision,authority_epoch=excluded.authority_epoch,state=excluded.state,mode=excluded.mode,audience_scope=excluded.audience_scope,endpoint_revision=excluded.endpoint_revision,privacy_profile=excluded.privacy_profile,assistant_id=excluded.assistant_id,conversation_id=excluded.conversation_id,provenance=excluded.provenance,source_session_id=excluded.source_session_id',value.principal_id,value.binding_key,value.endpoint_id,value.account_epoch,value.revision,value.authority_epoch,value.state,value.mode,value.audience_scope,value.endpoint_revision,value.privacy_profile,value.assistant_id,value.conversation_id,value.provenance,value.source_session_id);
 }
 /** A pending browser Lock is applied BEFORE returning settings or authority.
  * It is denial-only, including for legacy bindings with no preference row. */
 lock(actor:Actor,key:string,pending=false):Preference|null{
  const accountEpoch=this.actor(actor);let endpoint='';
  const locked=this.database.durableTransaction(tx=>{
   const binding=this.binding(actor,key);if(!binding)return null;endpoint=binding.endpoint_id;
   const old=tx.get<Preference>('SELECT * FROM returning_browser_preferences WHERE principal_id=? AND binding_key=?',actor.principalId,key);
   if(old?.state==='locked'&&old.account_epoch===accountEpoch)return old;
   const next:Preference={principal_id:actor.principalId,binding_key:key,endpoint_id:endpoint,account_epoch:accountEpoch,revision:(old?.revision??0)+1,authority_epoch:(old?.authority_epoch??0)+1,state:'locked',mode:old?.mode??'text',audience_scope:old?.audience_scope??'unknown',endpoint_revision:binding.configuration_revision,privacy_profile:old?.privacy_profile??this.privacyProfile(binding),assistant_id:old?.assistant_id??null,conversation_id:old?.conversation_id??null,provenance:pending?'pendingLock':'explicitLock',source_session_id:actor.sessionId};
   this.put(tx,next);this.actor(actor);return next;
  });
  if(endpoint)this.ports.invalidate(actor.principalId,endpoint,true);return locked;
 }
 /** Detach/withhold is a durable denial even though settings were removed. */
 withholdEndpoint(actor:Actor,endpointId:string):void{
  this.actor(actor);
  this.database.durableTransaction(tx=>{
   if(!tx.get('SELECT 1 FROM endpoint_bindings WHERE principal_id=? AND endpoint_id=?',actor.principalId,endpointId))throw Error('returning_owned_endpoint_required');
   tx.run("UPDATE returning_browser_preferences SET state='withheld',audience_scope='unknown',revision=revision+1,authority_epoch=authority_epoch+1,provenance='withhold',source_session_id=? WHERE principal_id=? AND endpoint_id=?",actor.sessionId,actor.principalId,endpointId);
   this.actor(actor);
  });
  this.ports.invalidate(actor.principalId,endpointId,true);
 }
 keyForSession(actor:Actor):string|null{
  this.actor(actor);
  const rows=this.database.connection.prepare("SELECT b.binding_key FROM endpoint_bindings b JOIN sessions s ON s.endpoint_id=b.endpoint_id WHERE b.principal_id=? AND s.id=? AND s.status='active'").all(actor.principalId,actor.sessionId) as {binding_key:string}[];
  return rows.length===1?rows[0]!.binding_key:null;
 }
 restore(actor:Actor,input:unknown,audioConfigured:boolean){
  const parsed=returningBrowserInput(input);this.actor(actor);
  if(!parsed.bindingKey)return {status:'protected' as const,reason:'no_saved_browser_binding'};
  if(parsed.pendingLock)this.lock(actor,parsed.bindingKey,true);
  return this.database.durableTransaction(tx=>{
   const accountEpoch=this.actor(actor),binding=this.binding(actor,parsed.bindingKey!);
   if(!this.suitable(binding))return {status:'protected' as const,reason:'binding_unavailable'};
   const policy=tx.get<Preference>('SELECT * FROM returning_browser_preferences WHERE principal_id=? AND binding_key=?',actor.principalId,parsed.bindingKey!);
   if(!policy||policy.endpoint_id!==binding!.endpoint_id||policy.account_epoch!==accountEpoch||policy.state==='revoked'||policy.endpoint_revision!==binding!.configuration_revision||policy.privacy_profile!==this.privacyProfile(binding!))return {status:'protected' as const,reason:'no_current_saved_policy'};
   if(tx.get('SELECT 1 FROM sessions WHERE id=?',actor.sessionId))return {status:'protected' as const,reason:'runtime_already_established'};
   const choice=this.selection(actor,policy.conversation_id),mode=policy.mode==='audio'&&!audioConfigured?'text':policy.mode;
   tx.run("INSERT INTO sessions(id,conversation_id,revision,status,endpoint_id,interaction_id) VALUES(?,?,1,'active',?,?)",actor.sessionId,choice?.conversation_id??randomUUID(),binding!.endpoint_id,randomUUID());
   tx.run('INSERT INTO session_endpoint_settings VALUES(?,?,?,?,?)',actor.sessionId,binding!.endpoint_id,mode,policy.audience_scope,binding!.configuration_revision);
   this.actor(actor);
   return {status:'restored' as const,endpointId:binding!.endpoint_id,policyRevision:policy.revision,authorityEpoch:policy.authority_epoch,privacyProfile:this.privacyProfile(binding!),bindingKey:parsed.bindingKey!,personalEligible:!parsed.pendingLock&&policy.state==='enabled'&&policy.audience_scope==='authenticatedSession',assistantId:choice?.assistant_id??null,conversationId:choice?.conversation_id??null};
  });
 }
 /** Cookie resume never changes established runtime selection or settings.
  * Only absence of a runtime row may use the ordinary saved restoration path. */
 resume(actor:Actor,input:unknown,audioConfigured:boolean){
  const parsed=returningBrowserInput(input);this.actor(actor);
  if(!parsed.bindingKey)return {status:'protected' as const,reason:'no_saved_browser_binding'};
  if(parsed.pendingLock)this.lock(actor,parsed.bindingKey,true);
  const established=this.database.connection.prepare('SELECT 1 FROM sessions WHERE id=?').get(actor.sessionId);
  if(!established)return this.restore(actor,{...parsed,pendingLock:false},audioConfigured);
  return this.database.durableTransaction(tx=>{
   const accountEpoch=this.actor(actor),binding=this.binding(actor,parsed.bindingKey!);
   const policy=tx.get<Preference>('SELECT * FROM returning_browser_preferences WHERE principal_id=? AND binding_key=?',actor.principalId,parsed.bindingKey!);
   const session=tx.get<{conversation_id:string;endpoint_id:string;audience_scope:string;configuration_revision:number}>("SELECT s.conversation_id,s.endpoint_id,c.audience_scope,c.configuration_revision FROM sessions s JOIN session_endpoint_settings c ON c.session_id=s.id AND c.endpoint_id=s.endpoint_id WHERE s.id=? AND s.status='active'",actor.sessionId);
   if(!this.suitable(binding)||!policy||!session||policy.state!=='enabled'||policy.account_epoch!==accountEpoch||policy.endpoint_id!==binding!.endpoint_id||session.endpoint_id!==binding!.endpoint_id||policy.endpoint_revision!==binding!.configuration_revision||session.configuration_revision!==binding!.configuration_revision||policy.audience_scope!=='authenticatedSession'||session.audience_scope!=='authenticatedSession'||JSON.parse(binding!.profile_json).privacyClass!=='personal'||policy.privacy_profile!==this.privacyProfile(binding!))return {status:'protected' as const,reason:'existing_runtime_not_eligible'};
   this.actor(actor);const choice=this.selection(actor,session.conversation_id);
   return {status:'restored' as const,endpointId:binding!.endpoint_id,policyRevision:policy.revision,authorityEpoch:policy.authority_epoch,privacyProfile:this.privacyProfile(binding!),bindingKey:parsed.bindingKey!,personalEligible:!parsed.pendingLock,assistantId:choice?.assistant_id??null,conversationId:choice?.conversation_id??null};
  });
 }
 current(actor:Actor,key:string,revision:number,endpointId:string,privacyProfile:string,authorityEpoch:number):boolean{
  try{const accountEpoch=this.actor(actor),binding=this.binding(actor,key),policy=this.read(actor,key);
   const session=this.database.connection.prepare("SELECT s.endpoint_id,c.audience_scope,c.configuration_revision FROM sessions s JOIN session_endpoint_settings c ON c.session_id=s.id AND c.endpoint_id=s.endpoint_id WHERE s.id=? AND s.status='active'").get(actor.sessionId) as {endpoint_id:string;audience_scope:string;configuration_revision:number}|undefined;
   return !!session&&session.endpoint_id===endpointId&&session.audience_scope==='authenticatedSession'&&session.configuration_revision===binding?.configuration_revision&& this.suitable(binding)&&!!policy&&policy.state==='enabled'&&policy.audience_scope==='authenticatedSession'&&policy.account_epoch===accountEpoch&&policy.revision>=revision&&policy.authority_epoch===authorityEpoch&&JSON.parse(binding!.profile_json).privacyClass==='personal'&&policy.privacy_profile===privacyProfile&&this.privacyProfile(binding!)===privacyProfile&&policy.endpoint_id===endpointId&&binding!.endpoint_id===endpointId&&binding!.configuration_revision===policy.endpoint_revision;
  }catch{return false;}
 }
}
