import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {INACTIVE_PERSONAL_DAILY_SESSION_POLICY} from '../src/auth/local-auth.ts';

async function fixture(t:TestContext){
 const root=mkdtempSync(join(tmpdir(),'ls-persistent-http-')),config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'test.sqlite'),artifactDirectory:join(root,'artifacts')};let now=Date.now();
 const options={config,host:'127.0.0.1',port:0,historyStateRoot:root,historyRetention:{mode:'localUserConsent' as const,retention:'untilDeletion' as const,journalInitialization:'initializeEmpty' as const},localAuth:{stateDirectory:join(root,'safety'),installerToken:randomBytes(32).toString('hex'),now:()=>now,personalSessionPolicy:{...INACTIVE_PERSONAL_DAILY_SESSION_POLICY,enabled:true}},audiencePrivacy:{sourceIds:[]}};
 const previousMask=process.umask(0o077);let app:ReturnType<typeof createLifestreamServer>|undefined; t.after(async()=>{try{await app?.shutdown();}finally{process.umask(previousMask);rmSync(root,{recursive:true,force:true});}});app=createLifestreamServer(options);await app.start();const port=app.address().port,origin=`http://127.0.0.1:${port}`;let cookie='',csrf='',contextRef='';const bindingKey=randomUUID();
 const request=(path:string,body?:unknown,extra:Record<string,string>={})=>fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',cookie,'x-lifestream-csrf':csrf,...(contextRef?{'x-lifestream-user-context':contextRef}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const json=async(path:string,body?:unknown,status=200)=>{const r=await request(path,body);assert.equal(r.status,status,await r.clone().text());return r.json() as Promise<any>;};
 const setup=await request('/api/auth/v1/setup',{username:'owner',password:randomBytes(32).toString('hex'),installerToken:options.localAuth.installerToken});assert.equal(setup.status,201);const setCookie=setup.headers.get('set-cookie')!;cookie=setCookie.split(';')[0]!;const session=(await setup.json() as any).session;csrf=session.csrfToken;
 const refreshContext=async()=>{contextRef=(await json('/api/auth/v1/user-context')).contextRef;};await refreshContext();
 const settings=()=>json('/api/runtime/v1/session-context');const privacy=()=>json('/api/runtime/v1/audience/personal-session');
 const command=async(operation:'unlock'|'lock')=>{const p=await privacy(),s=await settings();return json('/api/runtime/v1/audience/personal-session',{operation,operationId:randomUUID(),declarationId:randomUUID(),expectedAudienceRevision:p.revision,expectedPersonalSessionEpoch:p.personalSessionEpoch,expectedSessionRevision:s.revision,endpointId:s.endpoint.endpointId,expectedEndpointRevision:s.endpoint.configurationRevision});};
 const seed=async()=>{const a=await json('/api/admin/v1/assistants',{displayName:'TEST private assistant'},201);await json('/api/admin/v1/assistants/'+a.assistantId+'/activate',{profileId:a.profile.profileId,expectedActiveRevision:null});await json('/api/admin/v1/assistants/'+a.assistantId+'/relationships',{},201);const s=await settings();await json('/api/runtime/v1/session-context',{expectedRevision:s.revision,bindingKey,audienceScope:'authenticatedSession',mode:'text'});await command('unlock');};
 const restart=async()=>{await app!.shutdown();app=createLifestreamServer({...options,port,historyRetention:{...options.historyRetention,journalInitialization:'requireExisting'}});await app.start();await refreshContext();};
 return {request,json,session,setCookie,command,privacy,seed,restart,bindingKey,advance:(ms:number)=>{now+=ms;}};
}
test('original authenticated HTTP transport exposes explicit non-expiry and retains all request fences after long idle',async t=>{
 const f=await fixture(t);assert.match(f.setCookie,/HttpOnly/);assert.match(f.setCookie,/SameSite=Strict/);assert.doesNotMatch(f.setCookie,/Max-Age|Expires=/i);assert.equal(f.session.adminExpiresAt,null);
 f.advance(365*24*60*60*1000);
 for(const path of ['/api/auth/v1/daily-session','/api/auth/v1/session']){const s=await f.json(path);assert.equal(s.adminExpiresAt,null);assert.deepEqual(s.sessionPolicy,f.session.sessionPolicy);}
 const review=await f.json('/api/runtime/v1/ct-browser-owner');assert.deepEqual(review,{schemaVersion:'ct-browser-owner-review/1',state:'unavailable',canBind:false});
 assert.equal((await f.request('/api/runtime/v1/ct-browser-owner',undefined,{cookie:''})).status,401);
 assert.equal((await f.request('/api/runtime/v1/ct-browser-owner',{}, {'x-lifestream-csrf':'TEST-wrong'})).status,403);
 assert.equal((await f.request('/api/runtime/v1/ct-browser-owner',undefined,{origin:'http://localhost:1'})).status,403);
});
test('saved private intent restores after idle and backend restart while manual Lock remains effective across the next restart',async t=>{
 const f=await fixture(t);await f.seed();assert.equal((await f.privacy()).privateAllowed,true);f.advance(90*24*60*60*1000);assert.equal((await f.privacy()).privateAllowed,true);
 await f.restart();assert.equal((await f.privacy()).privateAllowed,false);assert.equal((await f.json('/api/auth/v1/resume-browser',{bindingKey:f.bindingKey,pendingLock:false})).returning.status,'restored');assert.equal((await f.privacy()).privateAllowed,true);
 await f.command('lock');assert.equal((await f.privacy()).privateAllowed,false);await f.restart();assert.equal((await f.json('/api/auth/v1/resume-browser',{bindingKey:f.bindingKey,pendingLock:false})).returning.status,'protected');assert.equal((await f.privacy()).privateAllowed,false);
});
test('explicit sign-out remains revoked after backend restart and cannot restore saved private intent',async t=>{
 const f=await fixture(t);await f.seed();await f.json('/api/auth/v1/sign-out',{});await assert.rejects(f.restart());
 assert.equal((await f.request('/api/auth/v1/daily-session')).status,401);assert.equal((await f.request('/api/auth/v1/resume-browser',{bindingKey:f.bindingKey,pendingLock:false})).status,401);
});
