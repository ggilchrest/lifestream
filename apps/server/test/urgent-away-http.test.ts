import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {Database} from '@lifestream/storage-sqlite';
import {FixtureCapabilityProvider} from '../../../packages/providers-fixture/src/capability/provider.ts';
import type {PwceCondition,PwceConditionResponse} from '@lifestream/providers-pwce';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {LocalAuthentication} from '../src/auth/local-auth.ts';
import {URGENT_AWAY_INPUT_SCHEMA,URGENT_AWAY_OUTPUT_SCHEMA,URGENT_AWAY_SIMULATION_NOTICE} from '../src/runtime/urgent-away.ts';

const binding={sourceRef:'fixture.source',worldRef:'fixture.world',siteRef:'fixture.site',zoneRef:'fixture.zone',eventClass:'criticalDevice',label:'Private fixture label'};
const wait=async(check:()=>boolean|Promise<boolean>)=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw Error('Away observation timed out');};
async function fixture(t:any){
 const dir=await mkdtemp(join(tmpdir(),'ls-away-http-'));t.after(()=>rm(dir,{recursive:true,force:true}));const password=randomBytes(24).toString('hex'),installerToken=randomBytes(32).toString('hex');
 const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(dir,'data.sqlite'),artifactDirectory:join(dir,'artifacts')};const authOptions={stateDirectory:join(dir,'auth'),installerToken};
 let app=createLifestreamServer({config,localAuth:authOptions,audiencePrivacy:{sourceIds:[]}});await app.start();let port=app.address().port;const base=`http://127.0.0.1:${port}`;
 const login=async(setup=false)=>{const headers:Record<string,string>={origin:base,'content-type':'application/json'};const request=(path:string,body?:unknown,extra:Record<string,string>={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});const response=await request('/api/auth/v1/'+(setup?'setup':'sign-in'),{username:'owner',password,...(setup?{installerToken}:{})});assert.equal(response.status,setup?201:200);headers.cookie=response.headers.get('set-cookie')!.split(';')[0]!;const {session}=await response.json();headers['x-lifestream-csrf']=session.csrfToken;const read=async(path:string,body?:unknown,status=200)=>{const r=await request(path,body),v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v;};const endpoint=await read('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',bindingKey:randomUUID()});await read('/api/runtime/v1/audience',{mode:'solo',seconds:300});return {session,endpoint,headers,read,request,token:headers.cookie.slice(headers.cookie.indexOf('=')+1)};};
 const operator=await login(true),created=await operator.read('/api/admin/v1/assistants',{displayName:'Synthetic away verification'},201),assistantId=created.assistantId;await operator.read(`/api/admin/v1/assistants/${assistantId}/activate`,{profileId:created.profile.profileId,expectedActiveRevision:null});const destinationSession=await login();await app.shutdown();
 const database=new Database({path:config.storage.databasePath}),auth=new LocalAuthentication(database,authOptions);t.after(()=>database.close());const conditions:PwceCondition[]=[],calls:any[]=[];let snapshots=0,changes=0,available=true;
 const scope={principalId:operator.session.principalId,assistantId,endpointId:destinationSession.endpoint.endpoint.endpointId};
 const response=(operation:'snapshot'|'changes',after=0):PwceConditionResponse=>({profileId:'synthetic.conditions',profileVersion:'1.0.0',operation,status:'ok',evaluatedAt:new Date().toISOString(),conditions:structuredClone(conditions.slice(after)),nextCursor:conditions.length,hasMore:false,resyncReason:null,acknowledgment:null,replay:true});
 const source={snapshot:async()=>{snapshots++;return response('snapshot');},changes:async(cursor:number)=>{changes++;return response('changes',cursor);}};
 const provider=new FixtureCapabilityProvider([{id:'fixture.notice',version:'1.0.0',route:'fixture.private-notice',inputSchema:URGENT_AWAY_INPUT_SCHEMA,outputSchema:URGENT_AWAY_OUTPUT_SCHEMA,sideEffect:'irreversible',authorization:'required',idempotency:'idempotent',latencyClass:'fast',offlineAvailable:false,simulationSupported:true}]);
 provider.invoke=async(input,_definition,context)=>{assert.equal(context.executionMode,'live');assert.equal(input.dispatchReceipt?.status,'admitted');calls.push(structuredClone(input));return {invocationId:input.invocationId,lifecycle:'succeeded',output:{schemaVersion:'1.0.0',accepted:true,receiptRef:'fixture.receipt'}};};
 const capabilityScope={assistantId,endpointId:scope.endpointId,sessionId:destinationSession.session.sessionId,environment:'test',authorityContextRef:{providerRef:'fixture-authority',contextId:randomUUID(),revision:1}};
 const destination={destinationRef:'fixture.private-route',revision:1,scope,identity:{assistantRef:assistantId,endpointRef:scope.endpointId,participantRefs:[scope.principalId],audienceRef:'fixture.private-recipient'},capabilityScope,capabilityId:'fixture.notice',capabilityVersion:'1.0.0',capabilityRoute:'fixture.private-notice',provider,dispatch:async(input:any)=>({invocationId:input.invocationId,status:'admitted' as const,grantRevision:1}),authentication:()=>auth.context(destinationSession.token,base,false),current:()=>available,facts:()=>({scope,sessionId:capabilityScope.sessionId,sessionRevision:destinationSession.endpoint.revision,audienceRevision:1,authorizationRevision:1,authorized:available,privateAudience:available,attentionSuitable:true,outputReady:true})};
 const options={config,port,localAuth:authOptions,audiencePrivacy:{sourceIds:[]},urgentConditions:{baseUrl:'http://unused.fixture',token:'fixture',worldRef:binding.worldRef,siteRef:binding.siteRef,replay:true,bindings:[binding],fetchImpl:async()=>{throw Error('No network source permitted in fixture');}},urgentAway:{destinations:[destination],source,pollIntervalMs:250}};
 app=createLifestreamServer(options);await app.start();t.after(()=>app.shutdown());await operator.read('/api/runtime/v1/audience',{mode:'solo',seconds:300});
 const path='/api/runtime/v1/urgent/away?assistantId='+assistantId,settings=(revision=0)=>({operation:'configure',destinationRef:destination.destinationRef,expectedRevision:revision,modality:'text',rules:[{sourceRef:binding.sourceRef,eventClass:binding.eventClass,enabled:true,bypassQuietHours:false}],quietHours:null,snoozedUntil:null});
 const emit=()=>{const now=Date.now(),at=new Date(now).toISOString();conditions.push({conditionRef:'fixture.condition.'+(conditions.length+1),revision:1,sourceRef:binding.sourceRef,worldRef:binding.worldRef,siteRef:binding.siteRef,zoneRef:binding.zoneRef,eventClass:binding.eventClass,sourceRevision:1,status:'open',transition:'open',severity:'critical',summary:'PRIVATE SUMMARY MUST NEVER LEAVE',occurredAt:at,receivedAt:at,updatedAt:at,freshUntil:new Date(now+30000).toISOString(),expiresAt:new Date(now+60000).toISOString(),freshness:'fresh',basis:'synthetic',qualification:{state:'qualified',confidence:1,limitations:[],evidenceRefs:['private.evidence.ref']}});};
 return {operator,destinationSession,base,path,settings,scope,database,calls,emit,sourceCalls:()=>({snapshots,changes}),view:()=>operator.read(path),unavailable:()=>{available=false;},async restart(){await app.shutdown();app=createLifestreamServer(options);await app.start();await operator.read('/api/runtime/v1/audience',{mode:'solo',seconds:300});}};
}

test('host delivers without browser/SSE, protects destination policy, persists transport truth and never replays after restart',{timeout:20000},async t=>{
 const f=await fixture(t);assert.equal((await f.view()).destinations[0].settings.rules[0].enabled,false);assert.deepEqual(f.sourceCalls(),{snapshots:0,changes:0});
 assert.equal((await fetch(f.base+f.path)).status,403);assert.equal((await f.operator.request(f.path,f.settings(),{'x-lifestream-csrf':'wrong'})).status,403);assert.equal((await f.operator.request(f.path,f.settings(),{origin:'http://foreign.invalid'})).status,403);assert.equal((await f.operator.request(f.path,{...f.settings(),destinationRef:'foreign.route'})).status,404);
 await f.destinationSession.read('/api/runtime/v1/audience',{mode:'solo',seconds:300});
 assert.equal((await f.destinationSession.request(f.path.replace('/away',''))).status,409,'Reserved destination cannot inherit local class enablement');
 await f.operator.read(f.path,f.settings());await wait(()=>f.sourceCalls().snapshots===1);f.emit();await wait(()=>f.calls.length===1);await wait(async()=>(await f.view()).destinations[0].worker.deliveries[0]?.state==='accepted');
 assert.equal(f.calls[0].input.message,URGENT_AWAY_SIMULATION_NOTICE);assert.deepEqual(f.calls[0].input.evidenceRefs,[]);assert.doesNotMatch(JSON.stringify(f.calls),/PRIVATE SUMMARY|Private fixture label|private.evidence/);
 const accepted=(await f.view()).destinations[0].worker.deliveries[0];assert.ok(accepted.attemptedAt);assert.ok(accepted.acceptedAt);assert.equal(accepted.acknowledgedAt,null);
 await f.operator.read(f.path,{operation:'acknowledge',destinationRef:'fixture.private-route',deliveryId:accepted.id,expectedRevision:accepted.revision});assert.ok((await f.view()).destinations[0].worker.deliveries[0].acknowledgedAt);
 await f.restart();await wait(()=>f.sourceCalls().snapshots===2);await wait(()=>f.sourceCalls().changes>=2);assert.equal(f.calls.length,1);assert.ok((await f.view()).destinations[0].worker.deliveries[0].acknowledgedAt);
 await f.operator.read(f.path,{operation:'control',destinationRef:'fixture.private-route',action:'disable',expectedRevision:1});f.emit();await new Promise(r=>setTimeout(r,350));assert.equal(f.calls.length,1);
});

test('away trusted callback cannot survive actual session revocation or foreign identity',{timeout:15000},async t=>{
 const f=await fixture(t);await f.operator.read(f.path,f.settings());await wait(()=>f.sourceCalls().snapshots===1);
 await f.destinationSession.read('/api/auth/v1/sign-out',{});f.emit();await wait(async()=>(await f.view()).destinations[0].worker.destinations[0].reason==='scope_unavailable');assert.equal(f.calls.length,0);
 assert.equal((await f.operator.request(f.path,{...f.settings(1),modality:'speech'})).status,409);assert.equal((await f.operator.request(f.path,{...f.settings(1),principalId:'foreign'})).status,409);
});

test('delayed away configuration cannot retain consent after operator audience becomes shared',{timeout:15000},async t=>{
 const f=await fixture(t),body=JSON.stringify(f.settings());
 let request!:ReturnType<typeof httpRequest>;
 const response=new Promise<number|undefined>((resolve,reject)=>{
  request=httpRequest(f.base+f.path,{method:'POST',headers:{...f.operator.headers,'content-length':Buffer.byteLength(body)}},incoming=>{incoming.resume();incoming.on('end',()=>resolve(incoming.statusCode));incoming.on('error',reject);});
  request.on('error',reject);
 });
 t.after(()=>request.destroy());
 await new Promise<void>((resolve,reject)=>request.write(body.slice(0,1),error=>error?reject(error):resolve()));
 // Leave the handler awaiting the rest of the JSON while a separate request changes privacy.
 await new Promise(resolve=>setTimeout(resolve,50));
 await f.operator.read('/api/runtime/v1/audience',{mode:'shared',seconds:300});
 request.end(body.slice(1));
 assert.equal(await response,403);
 await f.operator.read('/api/runtime/v1/audience',{mode:'solo',seconds:300});
 const destination=(await f.view()).destinations[0];
 assert.equal(destination.settings.revision,0,'Rejected stale request must not persist remote notification consent');
 assert.equal(destination.settings.rules[0].enabled,false);
 assert.deepEqual(f.sourceCalls(),{snapshots:0,changes:0});
 assert.equal(f.calls.length,0);
});
