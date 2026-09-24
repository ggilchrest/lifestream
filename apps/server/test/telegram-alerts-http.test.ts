import {URGENT_AWAY_SIMULATION_NOTICE} from '../src/runtime/urgent-away.ts';
import type {PwceCondition,PwceConditionResponse} from '@lifestream/providers-pwce';
import {Database,TelegramPairingRepository} from '@lifestream/storage-sqlite';
import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import {createLifestreamServer,type TelegramHostOptions} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';

async function fixture(t:TestContext,telegram?:TelegramHostOptions,urgentConditions?:any){
 const dir=await mkdtemp(join(tmpdir(),'ls-subscribers-')),password=randomBytes(24).toString('hex'),installerToken=randomBytes(32).toString('hex');t.after(()=>rm(dir,{recursive:true,force:true}));const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(dir,'data.sqlite'),artifactDirectory:join(dir,'artifacts')};
 let app=createLifestreamServer({config,urgentConditions,...(telegram?{telegram}:{}),localAuth:{stateDirectory:join(dir,'auth'),installerToken},audiencePrivacy:{sourceIds:[]}});await app.start();const port=app.address().port,base=`http://127.0.0.1:${port}`;t.after(()=>app.shutdown());
 const headers:Record<string,string>={origin:base,'content-type':'application/json'},request=(path:string,body?:unknown,override:Record<string,string>={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...headers,...override},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const setup=await request('/api/auth/v1/setup',{username:'owner',password,installerToken});assert.equal(setup.status,201);headers.cookie=setup.headers.get('set-cookie')!.split(';')[0]!;const {session}=await setup.json();headers['x-lifestream-csrf']=session.csrfToken;
 const read=async(path:string,body?:unknown,status=200)=>{const r=await request(path,body),d=await r.json();assert.equal(r.status,status,JSON.stringify(d));return d;};
 await read('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',bindingKey:randomUUID()});await read('/api/runtime/v1/audience',{mode:'solo',seconds:300});
 const assistant=await read('/api/admin/v1/assistants',{displayName:'Synthetic subscriber verification'},201),assistantId=assistant.assistantId;await read(`/api/admin/v1/assistants/${assistantId}/activate`,{profileId:assistant.profile.profileId,expectedActiveRevision:null});
 await read('/api/auth/v1/accounts',{username:'second',password},201);const {accounts}=await read('/api/auth/v1/accounts'),person=accounts.find((a:{username:string})=>a.username==='second').principalId;
 const path='/api/runtime/v1/channel-subscriptions?assistantId='+assistantId,draft=(principalId=person)=>({operation:'create',principalId,channel:'telegram',label:'Synthetic private chat',requestedConversations:true,requestedAlerts:true});
 return {assistantId,base,headers,request,read,path,draft,person,session,password,databasePath:config.storage.databasePath,async restart(){await app.shutdown();app=createLifestreamServer({config,port,urgentConditions,...(telegram?{telegram}:{}),localAuth:{stateDirectory:join(dir,'auth'),installerToken},audiencePrivacy:{sourceIds:[]}});await app.start();await read('/api/runtime/v1/audience',{mode:'solo',seconds:300});}};
}
const wait=async(check:()=>boolean|Promise<boolean>)=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw Error('Telegram alert observation timed out');};
test('non-admin subscriber consents to redacted alerts; owner controls classes and only recipient acknowledges',{timeout:30000},async t=>{
 const binding={sourceRef:'source',eventClass:'critical-condition',worldRef:'world',siteRef:'site',zoneRef:'zone',label:'Private zone'},conditions:PwceCondition[]=[],sent:{chat:string;text:string}[]=[];let snapshots=0,authority=true,enabled=true;
 const response=(operation:'snapshot'|'changes',cursor=0):PwceConditionResponse=>({profileId:'synthetic',profileVersion:'1.0.0',operation,status:'ok',evaluatedAt:new Date().toISOString(),conditions:structuredClone(conditions.slice(cursor)),nextCursor:conditions.length,hasMore:false,resyncReason:null,acknowledgment:null,replay:true});
 const telegram:TelegramHostOptions={botId:'9999',token:()=>undefined,enabled:()=>enabled,transport:{verify:async()=>{},updates:async offset=>({messages:[],nextOffset:offset}),send:async(chat,text)=>{sent.push({chat,text});return {status:'accepted',messageId:sent.length};}},alerts:{pollIntervalMs:250,source:{snapshot:async()=>{snapshots++;return response('snapshot');},changes:async cursor=>response('changes',cursor)},authority:(b,s)=>({scope:{assistantId:b.assistantId,endpointId:s.endpointId,sessionId:s.sessionId,environment:'synthetic',authorityContextRef:{providerRef:'synthetic-authority',contextId:b.subscriptionId,revision:1}},current:()=>authority,dispatch:async r=>({invocationId:r.invocationId,status:authority?'admitted':'denied',grantRevision:1})})}};
 const f=await fixture(t,telegram,{baseUrl:'http://unused.fixture',token:'fixture',worldRef:binding.worldRef,siteRef:binding.siteRef,replay:true,bindings:[binding],fetchImpl:async()=>{throw Error('No external network permitted');}}),mine='/api/runtime/v1/my-channel-pairings',away='/api/runtime/v1/urgent/away?assistantId='+f.assistantId,ownerHeaders={...f.headers};
 const ownerRead=async(body?:unknown,status=200)=>{const r=await f.request(away,body,ownerHeaders),d=await r.json();assert.equal(r.status,status,JSON.stringify(d));return d;};
 const subscription=(await f.read(f.path,f.draft())).subscriptions[0],id=subscription.id;
 const login=await f.request('/api/auth/v1/sign-in',{username:'second',password:f.password}),member=await login.json();f.headers.cookie=login.headers.get('set-cookie')!.split(';')[0]!;f.headers['x-lifestream-csrf']=member.session.csrfToken;
 const db=new Database({path:f.databasePath});t.after(()=>db.close());const pairs=new TelegramPairingRepository(db);
 const issued=await f.read(mine,{operation:'issue',id,expectedRevision:1,pairingRevision:0,botId:'9999'});assert.ok(pairs.claim('9999',issued.issued.challenge,{chatId:'1234',userId:'1234',privateChat:true,isBot:false,sentAt:Date.now()}));let p=(await f.read(mine)).subscriptions[0].pairing;
 p=(await f.read(mine,{operation:'confirm',id,expectedRevision:p.revision,claimId:p.claimId})).subscriptions[0].pairing;
 assert.deepEqual((await ownerRead()).destinations,[]);assert.equal((await f.request(away)).status,403);assert.equal((await f.request(mine,{operation:'alerts',id,expectedRevision:p.revision,alerts:true},{'x-lifestream-csrf':'bad'})).status,403);
 await wait(async()=>(await f.read(mine)).alertsAvailable);
 const enabledResult=await f.read(mine,{operation:'alerts',id,expectedRevision:p.revision,alerts:true});p=enabledResult.subscriptions[0].pairing;assert.equal(p.conversationsEnabled,false);assert.equal(p.alertsEnabled,true);assert.equal(enabledResult.subscriptions[0].alert.requiresOwnerPolicy,true);
 assert.equal(db.connection.prepare('SELECT COUNT(*) AS n FROM local_assistant_permissions WHERE principal_id=?').get(f.person)!.n,0);
 let d=(await ownerRead()).destinations[0];assert.ok(d);assert.equal(d.acknowledgmentAllowed,false);assert.equal(snapshots,0);
 const configure=(revision:number,quietHours:unknown=null)=>({operation:'configure',destinationRef:id,expectedRevision:revision,modality:'text',rules:[{sourceRef:binding.sourceRef,eventClass:binding.eventClass,enabled:true,bypassQuietHours:false}],quietHours,snoozedUntil:null});
 await ownerRead(configure(d.settings.revision));await wait(()=>snapshots===1);
 const emit=()=>{const at=new Date().toISOString();conditions.push({sourceRef:binding.sourceRef,eventClass:binding.eventClass,worldRef:binding.worldRef,siteRef:binding.siteRef,zoneRef:binding.zoneRef,conditionRef:'condition.'+conditions.length,revision:1,sourceRevision:1,status:'open',transition:'open',severity:'critical',summary:'PRIVATE INCIDENT CONTENT',occurredAt:at,receivedAt:at,updatedAt:at,freshUntil:new Date(Date.now()+60000).toISOString(),expiresAt:new Date(Date.now()+120000).toISOString(),freshness:'fresh',basis:'synthetic',qualification:{state:'qualified',confidence:1,limitations:[],evidenceRefs:['private:incident']}});};
 emit();await wait(async()=>(await f.read(mine)).subscriptions[0].alert.deliveries[0]?.state==='accepted');assert.deepEqual(sent,[{chat:'1234',text:URGENT_AWAY_SIMULATION_NOTICE}]);
 const alert=(await f.read(mine)).subscriptions[0].alert,delivery=alert.deliveries[0];assert.doesNotMatch(JSON.stringify(alert),/condition\.|private:incident|PRIVATE INCIDENT|sourceRef|conditionRef/);assert.equal(delivery.acknowledgedAt,null);
 await ownerRead({operation:'acknowledge',destinationRef:id,deliveryId:delivery.id,expectedRevision:delivery.revision},409);
 assert.equal((await f.request(mine,{operation:'acknowledge',id,deliveryId:delivery.id,expectedRevision:delivery.revision},ownerHeaders)).status,404);
 const acknowledged=await f.read(mine,{operation:'acknowledge',id,deliveryId:delivery.id,expectedRevision:delivery.revision});assert.ok(acknowledged.subscriptions[0].alert.deliveries[0].acknowledgedAt);await f.read(mine,{operation:'acknowledge',id,deliveryId:delivery.id,expectedRevision:delivery.revision},409);
 // A restart establishes a new source baseline and never resends an old condition.
 // Use owner headers while restoring the owner-only audience override.
 Object.assign(f.headers,ownerHeaders);await f.restart();const newOwnerHeaders={...f.headers};Object.assign(f.headers,{...newOwnerHeaders,cookie:login.headers.get('set-cookie')!.split(';')[0]!,'x-lifestream-csrf':member.session.csrfToken});await wait(()=>snapshots===2);await new Promise(r=>setTimeout(r,300));assert.equal(sent.length,1);
 authority=false;await wait(async()=>(await ownerRead()).destinations.length===0);emit();await new Promise(r=>setTimeout(r,300));assert.equal(sent.length,1);
 authority=true;await wait(async()=>(await ownerRead()).destinations.length===1);
 // Disabling one feature preserves the other; offline consent can still be withdrawn.
 p=(await f.read(mine)).subscriptions[0].pairing;p=(await f.read(mine,{operation:'enable',id,expectedRevision:p.revision,conversations:true})).subscriptions[0].pairing;assert.equal(p.alertsEnabled,true);
 enabled=false;await wait(async()=>!(await f.read(mine)).transportReady);p=(await f.read(mine,{operation:'alerts',id,expectedRevision:p.revision,alerts:false})).subscriptions[0].pairing;assert.equal(p.conversationsEnabled,true);assert.equal(p.alertsEnabled,false);p=(await f.read(mine,{operation:'enable',id,expectedRevision:p.revision,conversations:false})).subscriptions[0].pairing;assert.equal(p.conversationsEnabled,false);assert.equal(sent.length,1);
});
