import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {savedVoiceFixture} from './saved-voice-fixture.ts';
import {PreviewPlayback} from '../src/runtime/preview-playback.ts';

test('HTTP preview retains endpoint ownership after synthesis and requires scoped playback settlement',async t=>{
 const root=mkdtempSync(join(tmpdir(),'preview-playback-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const provider=await savedVoiceFixture();t.after(provider.close);const config=loadProfile('test');config.providers.tts='voxcpm';config.ttsProfile=provider.profile;config.authority.authentication='local-password';config.storage={databasePath:join(root,'state.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex'),app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'safety'),installerToken}});await app.start();t.after(()=>app.shutdown());const base=`http://127.0.0.1:${app.address().port}`;
 const sign=async(path:string,body:unknown)=>{const r=await fetch(base+path,{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,path.endsWith('/setup')?201:200);const data=await r.json();return {cookie:r.headers.get('set-cookie')!.split(';')[0]!,csrf:data.session.csrfToken,sessionId:data.session.sessionId};};
 const owner=await sign('/api/auth/v1/setup',{username:'synthetic-owner',password,installerToken});const other=await sign('/api/auth/v1/sign-in',{username:'synthetic-owner',password});
 const post=(path:string,body:unknown,who=owner,csrf=who.csrf)=>fetch(base+path,{method:'POST',headers:{origin:base,cookie:who.cookie,'content-type':'application/json','x-lifestream-csrf':csrf},body:JSON.stringify(body)});
 const preview=await post('/api/runtime/v1/tts',{text:'Synthetic preview.'});assert.equal(preview.status,200);const events=(await preview.text()).trim().split('\n').map(JSON.parse);assert.equal(events.at(-1).outcome,'succeeded');
 assert.ok((app as any).audioOwnership.currentLease(owner.sessionId),'HTTP EOF is not endpoint playback completion');
 assert.equal((await post('/api/runtime/v1/tts',{text:'Competing preview.'})).status,409);
 const trace=preview.headers.get('x-lifestream-playback-trace'),samples=events.filter(e=>e.kind==='data').reduce((sum,e)=>sum+e.frame.sampleCount,0),report={type:'playbackSettled',interactionTraceId:trace,outcome:'completed',receivedSamples:samples};assert.ok(trace);
 for(const [body,who,csrf,status] of [[report,other,other.csrf,409],[report,owner,'wrong',403],[{...report,interactionTraceId:randomUUID()},owner,owner.csrf,409],[{...report,receivedSamples:samples-1},owner,owner.csrf,409],[{...report,extra:true},owner,owner.csrf,409]] as const)assert.equal((await post('/api/runtime/v1/tts/playback',body,who,csrf)).status,status);
 assert.ok((app as any).audioOwnership.currentLease(owner.sessionId));assert.equal((await post('/api/runtime/v1/tts/playback',report)).status,200);assert.equal((app as any).audioOwnership.currentLease(owner.sessionId),undefined);
 const second=await post('/api/runtime/v1/tts',{text:'Another preview.'});assert.equal(second.status,200);await second.text();assert.equal((await post('/api/runtime/v1/tts/playback',report)).status,409,'old report cannot release a successor');assert.ok((app as any).audioOwnership.currentLease(owner.sessionId));assert.equal((await post('/api/runtime/v1/tts/playback',{...report,interactionTraceId:second.headers.get('x-lifestream-playback-trace'),outcome:'stopped',receivedSamples:0})).status,200);assert.equal((app as any).audioOwnership.currentLease(owner.sessionId),undefined);
});

test('missing preview reports expire without releasing an unsettled producer early',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const previews=new PreviewPlayback(),owner={principalId:'owner',sessionId:'session'},trace=randomUUID();let releases=0,stops=0;
 const playback=previews.begin(trace,owner,new Date(Date.now()+180000).toISOString(),()=>stops++,()=>releases++);playback.emittedOutput(4800);playback.synthesized();
 assert.equal(previews.acknowledge(owner,{type:'playbackSettled',interactionTraceId:trace,outcome:'completed',receivedSamples:1}),false);
 t.mock.timers.tick(180000);await new Promise(r=>setImmediate(r));assert.equal(stops,1);assert.equal(releases,0,'actual producer cleanup is still pending');playback.producerSettled();await new Promise(r=>setImmediate(r));assert.equal(releases,1);assert.equal(previews.acknowledge(owner,{type:'playbackSettled',interactionTraceId:trace,outcome:'stopped',receivedSamples:0}),false);
});
