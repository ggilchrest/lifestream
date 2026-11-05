import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rmSync} from 'node:fs';
import {fixture,auditFixtureRoot,isolatedAudit,wait,settle} from './fixtures/personal-phone-host.mjs';
import {capturePersonalPhoneAccess} from '../src/runtime/personal-phone-access.ts';
after(()=>{isolatedAudit.close();rmSync(auditFixtureRoot,{recursive:true,force:true});});
const policy=authenticatedAfterMs=>({mode:'authenticatedSession',authenticatedAfterMs});
const personal='/api/runtime/v1/audience/personal-session';
const command=(f,session,operation='lock')=>({operation,operationId:randomUUID(),declarationId:randomUUID(),expectedAudienceRevision:f.initialPersonal.revision,expectedPersonalSessionEpoch:f.initialPersonal.personalSessionEpoch??randomUUID(),expectedSessionRevision:session.revision,endpointId:session.endpoint.endpointId,expectedEndpointRevision:session.endpoint.configurationRevision});

test('trusted policy is closed, copied and disabled by default',()=>{
 assert.equal(capturePersonalPhoneAccess(undefined),undefined);
 for(const value of [{},policy(-1),policy(NaN),{...policy(0),clientControlled:true}])assert.throws(()=>capturePersonalPhoneAccess(value));
 const input=policy(3),captured=capturePersonalPhoneAccess(input);input.authenticatedAfterMs=8;assert.equal(captured.authenticatedAfterMs,3);assert.ok(Object.isFrozen(captured));
});
test('real Auth HTTP and WS work without Unlock and retain exact session identity after restart',async()=>{
 const f=await fixture({endpointClass:'personalCompanion',personalPhoneAccess:policy(0)});
 try{
  const value=await (await f.request(personal)).json();assert.equal(value.personalSessionPolicy,'personalApp');assert.equal(value.personalSessionState,'authenticated');assert.equal(value.privateAllowed,true);assert.equal(value.authenticatedSessionId,f.owner.sessionId);assert.equal(value.principalId,f.owner.principalId);assert.equal(value.leaseId,null);assert.equal(value.leaseExpiresAt,null);assert.equal(typeof value.expiresAt,'string');
  assert.equal(f.app.personalAudienceSessions.size,0);assert.equal(f.app.personalPhoneSessions.size,0);
  const audio=await f.connect();await audio.start();audio.turn();await audio.complete();assert.equal(f.calls.stt,1);assert.equal(f.calls.tts,1);
  const cookie=f.owner.cookie;await f.restart();assert.equal(f.owner.cookie,cookie);const restored=await f.request(personal);assert.equal(restored.status,200);assert.equal((await restored.json()).authenticatedSessionId,value.authenticatedSessionId);await f.page();
  const session=await (await f.request('/api/runtime/v1/session-context')).json();for(const operation of ['lock','unlock']){const result=await f.request(personal,command(f,session,operation));assert.equal(result.status,409);assert.equal((await result.json()).code,'personal_session_policy_changed');}
  assert.equal((await f.request(personal)).status,200);
  const out=await f.request('/api/auth/v1/sign-out',{});assert.equal(out.status,200);assert.equal((await f.request(personal)).status,401);
 }finally{await f.close();}
});
test('fixed cutover denies old-session private access; explicit password successor signs in independently',async()=>{
 const f=await fixture({endpointClass:'personalCompanion'});
 try{
  const session=await (await f.request('/api/runtime/v1/session-context')).json(),oldSession=f.owner.sessionId,cutoff=Date.now()+1000;
  await f.restart(policy(cutoff));let response=await f.request(personal);assert.equal(response.status,403);assert.equal((await response.json()).code,'personal_session_reauthentication_required');
  assert.equal(f.app.audiencePermits(f.app.localAuth.hostSessionContext(oldSession)),false);
  response=await f.request(personal,command(f,session,'unlock'));assert.equal(response.status,409);
  // The old epoch cannot be manufactured after restart: leave the original pending Lock unresolved.
  response=await f.request(personal,command(f,session));assert.equal(response.status,409);assert.equal((await response.json()).code,'personal_session_source_changed');
  f.advance(2000);await f.signIn();assert.notEqual(f.owner.sessionId,oldSession);
  const initial=await (await f.request('/api/runtime/v1/session-context')).json();response=await f.request('/api/runtime/v1/session-context',{expectedRevision:initial.revision,mode:'audio',audienceScope:'authenticatedSession',endpointClass:'personalCompanion',bindingKey:randomUUID()});assert.equal(response.status,200);
  response=await f.request(personal);assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).personalSessionState,'authenticated');
  assert.equal(f.app.localAuth.hostSessionContext(oldSession).sessionId,oldSession,'Legacy Lock is not represented as actual auth revocation');
 }finally{await f.close();}
});
test('server-owned endpoint binding, effective actor, health and revocation remain fences',async()=>{
 const f=await fixture({endpointClass:'personalCompanion',personalPhoneAccess:policy(0)});
 try{
  const context=f.app.localAuth.hostSessionContext(f.owner.sessionId),db=f.app.database;
  assert.ok(f.app.audiencePermits(context));
  assert.equal(f.app.audiencePermits({...context,effectiveContext:{...context.effectiveContext,effectiveUserId:randomUUID()}}),false);
  assert.equal(f.app.audiencePermits({...context,authenticatedAt:context.authenticatedAt+1}),false);
  const endpoint=(await (await f.request('/api/runtime/v1/session-context')).json()).endpoint;
  const registered=db.connection.prepare('SELECT * FROM interaction_endpoints WHERE endpoint_id=?').get(endpoint.endpointId);
  db.connection.prepare('UPDATE interaction_endpoints SET health=? WHERE endpoint_id=?').run('unavailable',endpoint.endpointId);assert.equal((await f.request(personal)).status,403);assert.equal(f.app.audiencePermits(context),false);
  db.connection.prepare('UPDATE interaction_endpoints SET health=?,configuration_revision=configuration_revision+1 WHERE endpoint_id=?').run('healthy',endpoint.endpointId);assert.equal((await f.request(personal)).status,403);
  db.connection.prepare('UPDATE interaction_endpoints SET configuration_revision=? WHERE endpoint_id=?').run(registered.configuration_revision,endpoint.endpointId);
  assert.equal((await f.request(personal)).status,200);
  const profile=JSON.parse(registered.profile_json);profile.endpointClass='sharedRoom';profile.ownership='shared';
  db.connection.prepare('UPDATE interaction_endpoints SET endpoint_class=?,ownership=?,profile_json=? WHERE endpoint_id=?').run('sharedRoom','shared',JSON.stringify(profile),endpoint.endpointId);assert.equal((await f.request(personal)).status,403);assert.equal(f.app.audiencePermits(context),false,'Phone auth policy cannot grant shared-room access');
  db.connection.prepare('UPDATE interaction_endpoints SET endpoint_class=?,ownership=?,profile_json=? WHERE endpoint_id=?').run(registered.endpoint_class,registered.ownership,registered.profile_json,endpoint.endpointId);
  db.connection.prepare('DELETE FROM endpoint_bindings WHERE principal_id=? AND endpoint_id=?').run(context.principalId,endpoint.endpointId);assert.equal((await f.request(personal)).status,403);assert.equal(f.app.audiencePermits(context),false);
 }finally{await f.close();}
});
test('desktop retains explicit legacy Lock/Unlock even when phone policy is enabled',async()=>{
 const f=await fixture({personalPhoneAccess:policy(0)});
 try{assert.equal((await (await f.request(personal)).json()).personalSessionPolicy,'personalDesktop');const session=await (await f.request('/api/runtime/v1/session-context')).json();const response=await f.request(personal,command(f,session));assert.equal(response.status,200);assert.equal((await response.json()).privateAllowed,false);assert.equal(f.app.audiencePermits(f.app.localAuth.hostSessionContext(f.owner.sessionId)),false);}finally{await f.close();}
});

test('personalApp keeps Assistant revocation and in-flight output cancellation effective',async()=>{
 const f=await fixture({endpointClass:'personalCompanion',personalPhoneAccess:policy(0),holdGeneration:true});
 try{
  const wrong=await f.connect(f.owner.contextRef,{assistantId:randomUUID()});await wait(()=>wrong.events.some(e=>e.type==='error'));assert.ok(!wrong.events.some(e=>e.type==='accepted'));
  const voice=await f.connect();await voice.start();voice.turn();await wait(()=>voice.events.some(e=>e.event?.payload.type==='textDelta'));const audioCount=voice.events.filter(e=>e.type==='audio').length;
  const revoked=await f.request('/api/auth/v1/permissions',{principalId:f.owner.principalId,assistantId:f.assistantId,administer:false});assert.equal(revoked.status,200);await wait(()=>voice.socket.readyState===3);f.release();await settle();assert.equal(voice.events.filter(e=>e.type==='audio').length,audioCount);assert.ok(voice.events.some(e=>e.type==='stopPlayback'));assert.ok(!voice.events.some(e=>e.event?.payload.type==='terminal'&&e.event.payload.state==='completed'));
 }finally{await f.close();}
});

test('existing persistent-owner policy retains null expiry across long idle and restart',async()=>{
 const f=await fixture({endpointClass:'personalCompanion',personalPhoneAccess:policy(0),persistentSession:true});
 try{const original=await (await f.request(personal)).json();assert.equal(original.expiresAt,null);f.advance(90*24*60*60*1000);await f.restart();const response=await f.request(personal);assert.equal(response.status,200);const restored=await response.json();assert.equal(restored.expiresAt,null);assert.equal(restored.authenticatedSessionId,original.authenticatedSessionId);assert.equal((await f.request('/api/auth/v1/sign-out',{})).status,200);await f.restart();assert.equal((await f.request(personal)).status,401);}finally{await f.close();}
});
