import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rmSync,writeFileSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {WebSocket} from '../../../node_modules/ws/wrapper.mjs';
import {fixture,auditFixtureRoot,isolatedAudit,settle,wait} from './fixtures/personal-phone-host.mjs';

async function personal(f,operation){
 const before=await f.request('/api/runtime/v1/audience/personal-session');assert.equal(before.status,200);const p=await before.json();if(!operation||operation==='unlock'&&p.privateAllowed===true)return p;
 const s=await (await f.request('/api/runtime/v1/session-context')).json();const res=await f.request('/api/runtime/v1/audience/personal-session',{operation,operationId:randomUUID(),declarationId:operation==='lock'?(p.personalSessionId??randomUUID()):randomUUID(),expectedAudienceRevision:p.revision,expectedPersonalSessionEpoch:p.personalSessionEpoch,expectedSessionRevision:s.revision,endpointId:s.endpoint.endpointId,expectedEndpointRevision:s.endpoint.configurationRevision});assert.equal(res.status,200,await res.clone().text());return res.json();
}
const closed=socket=>Promise.race([new Promise(resolve=>socket.readyState===3?resolve():socket.once('close',resolve)),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic socket failed to close')),2000);timer.unref();})]);
async function pending(f){const voice=await f.connect();await voice.start();voice.turn();await wait(()=>voice.events.some(e=>e.event?.payload.type==='textDelta'));voice.initialAudioCount=voice.events.filter(e=>e.type==='audio').length;return voice;}
test('owned personal phone GET remains locked; explicit open has no lease and ignores shared-room declaration',{timeout:20000},async()=>{
 const f=await fixture({endpointClass:'personalCompanion'});
 try{const p=f.initialPersonal;assert.equal(p.personalSessionPolicy,'personalDevice');assert.equal(p.privateAllowed,false);assert.equal(p.personalSessionState,'locked');f.app.audience.declare(f.app.audienceIdentity(f.app.localAuth.hostSessionContext(f.owner.sessionId)),'shared');const opened=await personal(f,'unlock');assert.equal(opened.privateAllowed,true);assert.equal(opened.expiresAt,null);assert.equal(opened.leaseId,null);assert.equal(opened.leaseExpiresAt,null);assert.equal(f.app.audience.snapshot(f.app.audienceIdentity(f.app.localAuth.hostSessionContext(f.owner.sessionId))).classification,'shared');
  assert.equal((await f.request('/api/runtime/v1/audience/lease',{operation:'begin',leaseId:randomUUID(),expectedAudienceRevision:opened.revision})).status,409);assert.equal((await f.request('/api/runtime/v1/audience',{mode:'solo',seconds:300})).status,409);assert.equal((await personal(f)).privateAllowed,true);
  const voice=await f.connect();await voice.start();voice.turn();await voice.complete();assert.ok(voice.events.some(e=>e.type==='audio'));
 }finally{await f.close();}
});
test('explicit Lock closes actual active socket and never implicitly reopens on GET',{timeout:20000},async()=>{
 const f=await fixture({endpointClass:'personalCompanion',holdGeneration:true});
 try{await personal(f,'unlock');const voice=await pending(f),done=closed(voice.socket);assert.equal((await personal(f,'lock')).privateAllowed,false);await done;f.release();await settle();assert.equal((await personal(f)).privateAllowed,false);assert.equal(voice.events.filter(e=>e.type==='audio').length,voice.initialAudioCount);assert.ok(!voice.events.some(e=>e.event?.payload.type==='terminal'&&e.event.payload.state==='completed'));
 }finally{await f.close();}
});
test('real permission revocation stops actual personal voice and fences held late output',{timeout:20000},async()=>{
 const f=await fixture({endpointClass:'personalCompanion',holdGeneration:true});
 try{await personal(f,'unlock');const voice=await pending(f),done=closed(voice.socket);const r=await f.request('/api/auth/v1/permissions',{principalId:f.owner.principalId,assistantId:f.assistantId,administer:false});assert.equal(r.status,200);await done;f.release();await settle();assert.ok(voice.events.some(e=>e.type==='error'&&e.problem.code==='audio_input_scope_changed'));assert.ok(voice.events.some(e=>e.type==='stopPlayback'&&e.reason==='audio_input_scope_changed'));assert.equal(voice.events.filter(e=>e.type==='audio').length,voice.initialAudioCount);
 }finally{await f.close();}
});
test('actual sign-out revokes session, closes socket and suppresses late provider output',{timeout:20000},async()=>{
 const f=await fixture({endpointClass:'personalCompanion',holdGeneration:true});
 try{await personal(f,'unlock');const voice=await pending(f),done=closed(voice.socket);assert.equal((await f.request('/api/auth/v1/sign-out',{})).status,200);await done;f.release();await settle();assert.equal((await f.request('/api/runtime/v1/audience/personal-session')).status,401);assert.equal(voice.events.filter(e=>e.type==='audio').length,voice.initialAudioCount);
 }finally{await f.close();}
});
test('invalid server authentication clock fences next generation without audience polling',{timeout:20000},async()=>{
 const f=await fixture({endpointClass:'personalCompanion',holdGeneration:true});
 try{await personal(f,'unlock');const voice=await pending(f),done=closed(voice.socket);f.advance(-366*24*3600000);f.release();await done;assert.equal((await f.request('/api/runtime/v1/audience/personal-session')).status,401);assert.equal(voice.events.filter(e=>e.type==='audio').length,voice.initialAudioCount);
 }finally{await f.close();}
});
test('an active phone cannot be silently rebound; registry withdrawal fences held output',{timeout:20000},async()=>{
 const f=await fixture({endpointClass:'personalCompanion',holdGeneration:true});
 try{await personal(f,'unlock');const voice=await pending(f),done=closed(voice.socket),s=await (await f.request('/api/runtime/v1/session-context')).json();const r=await f.request('/api/runtime/v1/session-context',{expectedRevision:s.revision,endpointClass:'desktopCompanion',bindingKey:randomUUID(),mode:'audio',audienceScope:'authenticatedSession'});assert.equal(r.status,409);
  f.app.database.connection.prepare("UPDATE interaction_endpoints SET health='unavailable' WHERE endpoint_id=?").run(s.endpoint.endpointId);f.app.invalidateRuntimeInputs('configurationChanged');await wait(()=>voice.events.some(e=>e.type==='stopPlayback'&&e.reason==='runtime_input_stale'));f.release();await settle();assert.equal((await f.request('/api/runtime/v1/audience/personal-session')).status,403);assert.equal(voice.events.filter(e=>e.type==='audio').length,voice.initialAudioCount);
 }finally{await f.close();}
});
test('WS header binding works; stale and conflicting references cannot admit microphone',{timeout:20000},async()=>{
 const f=await fixture({endpointClass:'personalCompanion'});
 try{await personal(f,'unlock');const base=`ws://127.0.0.1:${f.app.address().port}/api/runtime/v1/audio`;const connect=(query,reference)=>new Promise(resolve=>{const ws=new WebSocket(base+query,{headers:{origin:`http://127.0.0.1:${f.app.address().port}`,cookie:f.owner.cookie,'x-lifestream-user-context':reference}});ws.on('error',()=>{});ws.once('open',()=>resolve(ws));ws.once('close',()=>resolve(null));});
  const valid=await connect('',f.owner.contextRef);assert.ok(valid);valid.close();const conflict=await connect('?userContextRef='+randomUUID(),f.owner.contextRef);assert.equal(conflict,null);const stale=await connect('',randomUUID());assert.equal(stale,null);
 }finally{await f.close();}
});
test('nonzero own context requires current native reference; missing, stale and foreign references cannot borrow phone scope',{timeout:20000},async()=>{
 const f=await fixture({endpointClass:'personalCompanion'});let other;
 try{
  const old=f.owner.contextRef,actor=f.app.localAuth.hostSessionContext(f.owner.sessionId);f.app.localAuth.effectiveSubjects.execute(actor,{schemaVersion:'1.0.0',operationId:randomUUID(),operation:'endContext',expectedGeneration:0,payload:{}});
  assert.equal((await f.request('/api/runtime/v1/audience/personal-session')).status,409);
  const base='http://127.0.0.1:'+f.app.address().port,headers={origin:base,cookie:f.owner.cookie};const view=await fetch(base+'/api/auth/v1/user-context',{headers});assert.equal(view.status,200);const current=await view.json();assert.equal(current.context.generation,1);assert.equal(current.context.actorId,current.context.effectiveUserId);assert.notEqual(current.contextRef,old);f.owner.contextRef=current.contextRef;
  assert.equal((await fetch(base+'/api/runtime/v1/audience/personal-session',{headers})).status,409);assert.equal((await personal(f)).privateAllowed,false);await personal(f,'unlock');const voice=await f.connect();await voice.start();voice.turn();await voice.complete();
  other=await fixture({endpointClass:'personalCompanion'});assert.equal((await other.request('/api/runtime/v1/audience/personal-session',undefined,{'x-lifestream-user-context':f.owner.contextRef})).status,409);
 }finally{await other?.close();await f.close();}
});
test('personal-session discovery enrolls actual labeled consented phone voice and Stop leaves ordinary voice usable',{timeout:20000},async()=>{
 const f=await fixture({endpointClass:'personalCompanion'}),id=randomUUID(),attempt=randomUUID(),now=Date.now();
 try{
  writeFileSync(join(auditFixtureRoot,'control.json'),JSON.stringify({version:1,id,startedAtMs:now,expiresAtMs:now+300000,mode:'content'}),{mode:0o600});
  const advertised=await personal(f);assert.equal(advertised.personalSessionPolicy,'personalDevice');assert.equal(advertised.diagnostics?.version,1);assert.equal(advertised.diagnostics?.session,id);assert.equal(advertised.diagnostics?.contentEnabled,true);
  const voice=await f.connect(f.owner.contextRef,{}, {'x-lfs-audit-session':id,'x-lfs-audit-attempt':attempt,'x-lfs-audit-content':'speech-v1'});await voice.start();voice.socket.send(JSON.stringify({type:'diagnosticsConsent',diagnostics:{version:1,session:id,attempt,sequence:1,kind:'turn'}}));voice.turn();await voice.complete();
  const file=join(auditFixtureRoot,id,'capture.jsonl'),rows=()=>readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);const before=rows();for(const stage of ['turn_start','asr_end','admission','tts_pcm','server_pcm','socket_terminal'])assert.ok(before.some(x=>x.stage===stage),stage);assert.ok(voice.events.some(x=>x.type==='turnStarted'&&x.diagnostics?.session===id&&x.diagnostics?.attempt===attempt));assert.ok(before.length<=12000);assert.ok(statSync(file).size<=32*1024*1024);
  voice.socket.send(JSON.stringify({type:'diagnosticsStop',diagnostics:{version:1,session:id,attempt}}));await wait(()=>voice.events.some(x=>x.type==='diagnosticsStopped'&&x.diagnostics?.reason==='client_off'));const n=rows().length;assert.equal((await personal(f)).diagnostics,undefined);voice.turn();await voice.complete();assert.equal(rows().length,n,'Audit-only Stop never captures later ordinary turn');
 }finally{rmSync(join(auditFixtureRoot,'control.json'),{force:true});isolatedAudit.close();await f.close();}
});
after(()=>{isolatedAudit.close();rmSync(auditFixtureRoot,{recursive:true,force:true});});
