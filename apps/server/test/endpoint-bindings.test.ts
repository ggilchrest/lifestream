import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadMigrations} from '../../../packages/storage-sqlite/src/migrations/index.ts';
import {randomUUID} from 'node:crypto';
import {Database} from '../../../packages/storage-sqlite/src/database.ts';
import {readSessionEndpoint,reviseSessionEndpoint} from '../src/runtime/session-context.ts';
import {PresentationPackages,PresentationSelection} from '../src/admin/presentation-packages.ts';
test('logical endpoint defaults survive sign-in while session overrides and audience declarations do not',t=>{
 const db=new Database({path:':memory:'});db.migrate();t.after(()=>db.close());const key=randomUUID(),input={expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',bindingKey:key};
 const first=reviseSessionEndpoint(db,'session1',input,false,'owner'),selection=new PresentationSelection(db);const catalog=new PresentationPackages();selection.select('owner',first.endpoint!.endpointId,'session1',{scope:'default',id:'neutral',digest:'neutral-v1',expectedRevision:0},catalog);selection.select('owner',first.endpoint!.endpointId,'session1',{scope:'session',id:'neutral',digest:'neutral-v1',expectedRevision:0},catalog);
 const next=reviseSessionEndpoint(db,'session2',{...input,audienceScope:'unknown'},false,'owner');assert.equal(next.endpoint!.endpointId,first.endpoint!.endpointId);assert.equal(next.endpoint!.privacyClass,'public');assert.ok(selection.read('owner',next.endpoint!.endpointId,'session2').default);assert.equal(selection.read('owner',next.endpoint!.endpointId,'session2').override,null);
 const other=reviseSessionEndpoint(db,'session3',input,false,'other');assert.notEqual(other.endpoint!.endpointId,first.endpoint!.endpointId);assert.throws(()=>reviseSessionEndpoint(db,'session4',{...input,bindingKey:'../not-a-binding'},false,'owner'));
});


test('sessions sharing an endpoint cannot change one another disclosure or negotiated modalities',t=>{
 const db=new Database({path:':memory:'});db.migrate();t.after(()=>db.close());const bindingKey=randomUUID();
 const first=reviseSessionEndpoint(db,'public-session',{expectedRevision:0,mode:'text',audienceScope:'unknown',bindingKey},true,'owner');
 const second=reviseSessionEndpoint(db,'private-session',{expectedRevision:0,mode:'audio',audienceScope:'authenticatedSession',bindingKey},true,'owner');
 assert.equal(first.endpoint!.endpointId,second.endpoint!.endpointId,'the logical endpoint and its appearance default are intentionally shared');
 const publicState=readSessionEndpoint(db,'public-session');assert.equal(publicState.endpoint!.privacyClass,'public','another session cannot grant this session private disclosure');assert.deepEqual(publicState.endpoint!.inputModalities,['text']);assert.deepEqual(publicState.endpoint!.outputModalities,['text']);assert.equal(publicState.revision,1);assert.equal(publicState.endpoint!.configurationRevision,first.endpoint!.configurationRevision);
 reviseSessionEndpoint(db,'public-session',{expectedRevision:1,mode:'text',audienceScope:'unknown',bindingKey},true,'owner');
 const privateState=readSessionEndpoint(db,'private-session');assert.equal(privateState.endpoint!.privacyClass,'personal');assert.deepEqual(privateState.endpoint!.inputModalities,['text','audio']);assert.equal(privateState.revision,1);assert.equal(privateState.endpoint!.configurationRevision,second.endpoint!.configurationRevision);
});


test('legacy shared endpoint metadata cannot invent session consent; explicit settings survive restart and clear on unbinding',t=>{
 const root=mkdtempSync(join(tmpdir(),'ls-session-upgrade-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'state.sqlite'),endpointId=randomUUID(),bindingKey=randomUUID();
 const legacy=new Database({path,migrations:loadMigrations().filter(m=>m.id<50)});legacy.migrate();
 const profile={schemaVersion:'1.0.0',endpointId,endpointClass:'desktopCompanion',locationRef:null,ownership:'personal',inputModalities:['text','audio'],outputModalities:['text','audio'],privacyClass:'personal',presenceCapabilities:[],rendererCapabilities:null,handoffSupport:'sameSession',speakerIdentity:'unavailable',health:'healthy',configurationRevision:7};
 legacy.connection.prepare('INSERT INTO interaction_endpoints VALUES (?,?,?,?,?,?)').run(endpointId,7,'desktopCompanion','personal',JSON.stringify(profile),'healthy');legacy.connection.prepare('INSERT INTO endpoint_bindings VALUES (?,?,?)').run('owner',bindingKey,endpointId);
 for(const id of ['legacy-a','legacy-b'])legacy.connection.prepare("INSERT INTO sessions VALUES (?,?,1,'active',?,?)").run(id,randomUUID(),endpointId,randomUUID());legacy.close();
 let db=new Database({path});db.migrate();assert.equal(readSessionEndpoint(db,'legacy-a').endpoint!.privacyClass,'public');assert.deepEqual(readSessionEndpoint(db,'legacy-b').endpoint!.outputModalities,['text']);assert.equal(db.connection.prepare('SELECT COUNT(*) AS n FROM session_endpoint_settings').get()!.n,0);
 const chosen=reviseSessionEndpoint(db,'legacy-a',{expectedRevision:1,mode:'audio',audienceScope:'authenticatedSession',bindingKey},true,'owner');assert.equal(chosen.endpoint!.configurationRevision,8);db.close();db=new Database({path});t.after(()=>db.close());db.migrate();
 assert.equal(readSessionEndpoint(db,'legacy-a').endpoint!.privacyClass,'personal');assert.deepEqual(readSessionEndpoint(db,'legacy-a').endpoint!.inputModalities,['text','audio']);assert.equal(readSessionEndpoint(db,'legacy-b').endpoint!.privacyClass,'public');
 reviseSessionEndpoint(db,'legacy-b',{expectedRevision:1,mode:'text',audienceScope:'unknown',bindingKey},true,'owner');assert.equal(readSessionEndpoint(db,'legacy-a').endpoint!.configurationRevision,8);assert.equal(readSessionEndpoint(db,'legacy-b').endpoint!.configurationRevision,9);
 assert.throws(()=>reviseSessionEndpoint(db,'legacy-a',{expectedRevision:1,mode:'text',audienceScope:'unknown'},true,'owner'),/conflict/);assert.equal(readSessionEndpoint(db,'legacy-a').endpoint!.privacyClass,'personal');
 reviseSessionEndpoint(db,'legacy-a',{expectedRevision:2,mode:'none',audienceScope:'unknown'},true,'owner');assert.equal(readSessionEndpoint(db,'legacy-a').endpoint,null);assert.equal(db.connection.prepare('SELECT COUNT(*) AS n FROM session_endpoint_settings WHERE session_id=?').get('legacy-a')!.n,0);assert.equal(readSessionEndpoint(db,'legacy-b').endpoint!.privacyClass,'public');
});


test('session endpoint settings reject coerced values without storing disclosure or unconfigured audio',t=>{
 const db=new Database({path:':memory:'});db.migrate();t.after(()=>db.close());
 const original=reviseSessionEndpoint(db,'existing',{expectedRevision:0,mode:'text',audienceScope:'unknown'},false,'owner');
 for(const fields of [{mode:['audio']},{audienceScope:['authenticatedSession']},{mode:[['text']]},{audienceScope:[['unknown']]},{mode:{toString:()=> 'text'}},{expectedRevision:-1},{expectedRevision:Number.MAX_SAFE_INTEGER+1}]){
  for(const sessionId of ['new','existing']){
   assert.throws(()=>reviseSessionEndpoint(db,sessionId,{expectedRevision:sessionId==='new'?0:1,mode:'text',audienceScope:'unknown',...fields},false,'owner'),/revision|supported|scope/i);
   assert.deepEqual(readSessionEndpoint(db,'new'),{revision:0,endpoint:null});assert.deepEqual(readSessionEndpoint(db,'existing'),original);
  }
 }
 assert.throws(()=>reviseSessionEndpoint(db,'new',{expectedRevision:0,mode:'audio',audienceScope:'unknown'},false,'owner'),/not configured/);
 const audio=reviseSessionEndpoint(db,'configured',{expectedRevision:0,mode:'audio',audienceScope:'authenticatedSession'},true,'owner');assert.deepEqual(readSessionEndpoint(db,'configured'),audio);
});
