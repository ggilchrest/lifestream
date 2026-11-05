import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database,loadMigrations} from '@lifestream/storage-sqlite';
import {LocalAuthentication,invalidateCanonicalSessionCustody} from '../dist/auth/local-auth.js';
import {reviseSessionEndpoint,selectSessionConversation} from '../dist/runtime/session-context.js';
import {AudienceCoordinator} from '../dist/runtime/audience.js';
import {ReturningBrowserPreferences,returningBrowserInput} from '../dist/runtime/returning-browser.js';
const origin='http://127.0.0.1:33333'; // Label only: no listener or HTTP is created.
const migrations=loadMigrations();
async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'returning58-synthetic-')),path=join(root,'state.sqlite'),password='synthetic-only-password-58';
 let db=new Database({path,migrations});db.migrate();
 const options={stateDirectory:join(root,'safety'),installerToken:randomUUID()};let auth=new LocalAuthentication(db,options);
 const initial=await auth.setup('owner',password,options.installerToken,origin);
 const audience=new AudienceCoordinator();
 const bind=session=>auth.bindContext(auth.context(session.token,origin,false),undefined);
 const actor=bind(initial.session),key=randomUUID(),assistantId=randomUUID(),profileId=randomUUID();
 db.connection.prepare('INSERT INTO assistant_profiles VALUES(?,?,1,?,?,?)').run(assistantId,profileId,'active','{}',new Date().toISOString());
 const endpoint=reviseSessionEndpoint(db,actor.sessionId,{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',bindingKey:key},false,actor.principalId).endpoint;
 const conversationId=randomUUID();db.connection.prepare('INSERT INTO conversation_catalog(conversation_id,actor_id,effective_user_id,assistant_id,title,revision,created_at,last_activity_at,archived,pinned) VALUES(?,?,?,?,?,1,?,?,0,0)').run(conversationId,actor.principalId,actor.principalId,assistantId,'SYNTHETIC',new Date().toISOString(),new Date().toISOString());
 selectSessionConversation(db,actor.sessionId,conversationId,1);
 db.connection.prepare('INSERT INTO presentation_selections VALUES(?,?,?,?,?,1)').run(actor.principalId,endpoint.endpointId,'default','synthetic-package','synthetic-digest');
 db.connection.prepare('INSERT INTO presentation_selections VALUES(?,?,?,?,?,1)').run(actor.principalId,endpoint.endpointId,actor.sessionId,'session-only-package','session-only-digest');
 const store=()=>new ReturningBrowserPreferences(db,{
  assertCurrent:actor=>auth.assertCurrent(actor,false),canUseAssistant:(actor,id)=>auth.canUseAssistant(actor,id),
  invalidate:(principal,endpoint,withdraw)=>{invalidateCanonicalSessionCustody(db);if(withdraw)audience.withdrawSavedBinding(principal,endpoint);}
 });
 const identity=actor=>({principalId:actor.principalId,sessionId:actor.sessionId,endpointId:endpoint.endpointId});
 const unlock=actor=>{const snapshot=audience.personalSnapshot(identity(actor)),selected=db.connection.prepare('SELECT revision FROM sessions WHERE id=?').get(actor.sessionId);
  const currentEndpoint=db.connection.prepare('SELECT configuration_revision FROM interaction_endpoints WHERE endpoint_id=?').get(endpoint.endpointId);
  audience.personalSession(identity(actor),{operation:'unlock',operationId:randomUUID(),declarationId:randomUUID(),expectedAudienceRevision:snapshot.revision,expectedPersonalSessionEpoch:snapshot.personalSessionEpoch,expectedSessionRevision:selected.revision,endpointId:endpoint.endpointId,expectedEndpointRevision:currentEndpoint.configuration_revision},()=>{try{auth.assertCurrent(actor,false);return true;}catch{return false;}});
  return store().save(actor,key,true);
 };
 const signin=async(pendingLock=false)=>{const session=await auth.signIn('owner',password,'',origin,'SYNTHETIC');const actor=bind(session);const value=store().restore(actor,{bindingKey:key,pendingLock},false);return {actor,session,value};};
 const admit=({actor,value})=>{assert.equal(value.status,'restored');audience.personalSnapshot(identity(actor));return audience.restoreSavedPersonal(identity(actor),value.policyRevision,()=>store().current(actor,key,value.policyRevision,value.endpointId,value.privacyProfile,value.authorityEpoch));};
 t.after(()=>{audience.close();db.close();rmSync(root,{recursive:true,force:true});});
 return {root,path,options,actor,key,assistantId,conversationId,endpoint,audience,store,unlock,signin,admit,identity,
  db:()=>db,auth:()=>auth,bind,reopen:()=>{db.close();db=new Database({path,migrations});db.migrate();auth=new LocalAuthentication(db,options);},password};
}

test('genuine sign-in restores canonical owned conversation/presentation without Save or Unlock and no endpoint revision change',async t=>{
 const f=await fixture(t);assert.equal(f.store().save(f.actor,f.key).state,'locked');f.unlock(f.actor);
 const before=f.db().connection.prepare('SELECT * FROM interaction_endpoints').all();
 const presentation=f.db().connection.prepare('SELECT * FROM presentation_selections').all();
 f.auth().logout(f.actor);f.reopen();const returned=await f.signin();const snapshot=f.admit(returned);
 assert.equal(snapshot.privateAllowed,true);assert.equal(snapshot.personalSessionBasis,'savedPreference');
 assert.equal(returned.value.conversationId,f.conversationId);assert.equal(returned.value.assistantId,f.assistantId);
 assert.deepEqual(f.db().connection.prepare('SELECT * FROM interaction_endpoints').all(),before);
 assert.deepEqual(f.db().connection.prepare('SELECT * FROM presentation_selections').all(),presentation);
 assert.equal(f.db().connection.prepare('SELECT count(*) AS n FROM presentation_selections WHERE scope_id=?').get(returned.actor.sessionId).n,0);
 assert.equal(f.db().connection.prepare('SELECT MAX(id) AS id FROM schema_migrations').get().id,74);
});

test('legacy and first Save remain protected; Save after Withhold cannot infer a new clearance',async t=>{
 const f=await fixture(t);const legacy=await f.signin();assert.equal(legacy.value.status,'protected');
 assert.equal(f.store().save(f.actor,f.key).state,'locked');const first=await f.signin();assert.equal(first.value.personalEligible,false);
 f.unlock(f.actor);f.store().withholdEndpoint(f.actor,f.endpoint.endpointId);
 assert.equal(f.store().save(f.actor,f.key).state,'locked');const after=await f.signin();assert.equal(after.value.personalEligible,false);
});

test('pending Lock persists before return and remains denied at the next clean genuine sign-in',async t=>{
 const f=await fixture(t);f.unlock(f.actor);const denied=await f.signin(true);
 assert.equal(denied.value.personalEligible,false);assert.equal(f.store().read(denied.actor,f.key).state,'locked');
 assert.throws(()=>f.admit(denied));const later=await f.signin(false);assert.equal(later.value.personalEligible,false);
});

test('ordinary canonical conversation selection and text/audio preference revisions preserve same authority epoch',async t=>{
 const f=await fixture(t);f.unlock(f.actor);const returned=await f.signin();f.admit(returned);
 const second=randomUUID();f.db().connection.prepare('INSERT INTO conversation_catalog(conversation_id,actor_id,effective_user_id,assistant_id,title,revision,created_at,last_activity_at,archived,pinned) SELECT ?,actor_id,effective_user_id,assistant_id,title,1,created_at,last_activity_at,0,0 FROM conversation_catalog WHERE conversation_id=?').run(second,f.conversationId);
 selectSessionConversation(f.db(),returned.actor.sessionId,second,1);const saved=f.store().save(returned.actor,f.key);
 assert.equal(saved.authority_epoch,returned.value.authorityEpoch);assert.equal(f.audience.snapshot(f.identity(returned.actor)).privateAllowed,true);
 const selected=f.db().connection.prepare('SELECT revision FROM sessions WHERE id=?').get(returned.actor.sessionId);
 reviseSessionEndpoint(f.db(),returned.actor.sessionId,{expectedRevision:selected.revision,mode:'audio',audienceScope:'authenticatedSession',bindingKey:f.key},true,returned.actor.principalId);
 f.store().save(returned.actor,f.key);assert.equal(f.audience.snapshot(f.identity(returned.actor)).privateAllowed,true);
 f.store().lock(returned.actor,f.key);assert.equal(f.audience.snapshot(f.identity(returned.actor)).privateAllowed,false);
});

test('public profile at the same scalar revision retires restored contribution',async t=>{
 const f=await fixture(t);f.unlock(f.actor);const returned=await f.signin();f.admit(returned);
 const row=f.db().connection.prepare('SELECT profile_json FROM interaction_endpoints WHERE endpoint_id=?').get(f.endpoint.endpointId),profile=JSON.parse(row.profile_json);profile.privacyClass='public';
 f.db().connection.prepare('UPDATE interaction_endpoints SET profile_json=? WHERE endpoint_id=?').run(JSON.stringify(profile),f.endpoint.endpointId);
 assert.equal(f.audience.snapshot(f.identity(returned.actor)).privateAllowed,false);
});

test('persisted privacy fingerprint rejects same-revision non-modality mutation before a new genuine sign-in',async t=>{
 const f=await fixture(t);f.unlock(f.actor);
 const row=f.db().connection.prepare('SELECT profile_json FROM interaction_endpoints WHERE endpoint_id=?').get(f.endpoint.endpointId),profile=JSON.parse(row.profile_json);
 profile.locationRef='SYNTHETIC-different-location';
 f.db().connection.prepare('UPDATE interaction_endpoints SET profile_json=? WHERE endpoint_id=?').run(JSON.stringify(profile),f.endpoint.endpointId);
 f.reopen();const returned=await f.signin();assert.equal(returned.value.status,'protected');
});

test('fresh bound effective context is captured once and generation change retires saved contribution',async t=>{
 const f=await fixture(t);f.unlock(f.actor);const returned=await f.signin();f.admit(returned);
 f.auth().effectiveSubjects.execute(returned.actor,{schemaVersion:'1.0.0',operationId:randomUUID(),operation:'endContext',expectedGeneration:returned.actor.effectiveContext.generation,payload:{}});
 assert.equal(f.audience.snapshot(f.identity(returned.actor)).privateAllowed,false);
});

test('ended runtime and foreign actor binding never restore or preserve private contribution',async t=>{
 const f=await fixture(t);f.unlock(f.actor);const returned=await f.signin();f.admit(returned);
 f.db().connection.prepare("UPDATE sessions SET status='ended' WHERE id=?").run(returned.actor.sessionId);
 assert.equal(f.audience.snapshot(f.identity(returned.actor)).privateAllowed,false);
 const member=await f.auth().provision(f.actor,'member','synthetic-other-password-58');
 const session=await f.auth().signIn('member','synthetic-other-password-58','',origin,'SYNTHETIC');
 const actor=f.bind(session),count=f.db().connection.prepare('SELECT count(*) AS n FROM endpoint_bindings').get().n;
 const result=f.store().restore(actor,{bindingKey:f.key,pendingLock:false},false);
 assert.equal(result.status,'protected');assert.equal(member.principalId,actor.principalId);
 assert.equal(f.db().connection.prepare('SELECT count(*) AS n FROM endpoint_bindings').get().n,count);
});

test('archived or unavailable saved conversation is never resurrected or replaced with another owned conversation',async t=>{
 const f=await fixture(t);f.unlock(f.actor);
 f.db().connection.prepare('UPDATE conversation_catalog SET archived=1 WHERE conversation_id=?').run(f.conversationId);
 const returned=await f.signin();assert.equal(returned.value.status,'restored');assert.equal(returned.value.conversationId,null);
 assert.notEqual(f.db().connection.prepare('SELECT conversation_id FROM sessions WHERE id=?').get(returned.actor.sessionId).conversation_id,f.conversationId);
});

test('generic explicit Lock cannot be overridden by a saved-policy host admission',()=>{
 const audience=new AudienceCoordinator();try{const identity={principalId:randomUUID(),sessionId:randomUUID(),endpointId:randomUUID()};
  audience.declare(identity,'lock');assert.throws(()=>audience.restoreSavedPersonal(identity,1,()=>true));assert.equal(audience.snapshot(identity).privateAllowed,false);
 }finally{audience.close();}
});

test('credential epoch revokes durable policy and old restored authority',async t=>{
 const f=await fixture(t);f.unlock(f.actor);const returned=await f.signin();f.admit(returned);
 await f.auth().rotateRecoveryCodes(returned.actor,f.password);
 assert.equal(f.audience.snapshot(f.identity(returned.actor)).privateAllowed,false);
 const later=await f.signin();assert.equal(later.value.status,'protected');assert.equal(f.store().read(later.actor,f.key).state,'revoked');
});

test('detaching settings commits a durable withhold rather than a post-mutation save conflict',async t=>{
 const f=await fixture(t);f.unlock(f.actor);const returned=await f.signin();f.admit(returned);
 reviseSessionEndpoint(f.db(),returned.actor.sessionId,{expectedRevision:1,mode:'none',audienceScope:'unknown'},false,returned.actor.principalId);
 f.store().withholdEndpoint(returned.actor,f.endpoint.endpointId);
 assert.equal(f.store().read(returned.actor,f.key).state,'withheld');assert.equal(f.audience.snapshot(f.identity(returned.actor)).privateAllowed,false);
});

test('returning input is denial-only for malformed or absent storage and never creates a binding',()=>{
 assert.deepEqual(returningBrowserInput(undefined),{bindingKey:null,pendingLock:true});
 assert.deepEqual(returningBrowserInput({bindingKey:randomUUID(),pendingLock:'false'}).pendingLock,true);
 assert.deepEqual(returningBrowserInput({bindingKey:randomUUID(),pendingLock:false,endpointId:randomUUID()}),{bindingKey:null,pendingLock:true});
});
