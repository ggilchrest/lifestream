import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createLifestreamServer} from '../dist/index.js';
import {loadProfile} from '../dist/config/loader.js';
import {unifiedDesktopContractPin} from '@lifestream/contracts/unified-desktop-contracts';
const pin=unifiedDesktopContractPin('conversation-history');
const historyRequest=(operation,payload)=>({producerPin:pin,request:{schemaVersion:'1.0.0',operation,operationId:randomUUID(),...(['create'].includes(operation)?{idempotencyKey:randomUUID()}:{}),payload}});
async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'returning-browser-http-'));chmodSync(root,0o700);const oldMask=process.umask(0o077);
 const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'state.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=randomBytes(24).toString('hex'),password=randomBytes(24).toString('hex'),bindingKey=randomUUID();
 const options={config,host:'127.0.0.1',port:0,localAuth:{stateDirectory:join(root,'safety'),installerToken},audiencePrivacy:{sourceIds:[]},historyStateRoot:root,historyRetention:{mode:'localUserConsent',retention:'untilDeletion',journalInitialization:'initializeEmpty'}};
 let app=createLifestreamServer(options);t.after(async()=>{await app.shutdown();process.umask(oldMask);rmSync(root,{recursive:true,force:true});});await app.start();
 const origin='http://127.0.0.1:'+app.address().port,calls=[];
 const request=(owner,path,body)=>{calls.push({path,method:body===undefined?'GET':'POST'});return fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',...(owner?{cookie:owner.cookie,'x-lifestream-csrf':owner.csrf,...(owner.contextRef?{'x-lifestream-user-context':owner.contextRef}:{})}: {})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});};
 const bind=async response=>{const value=await json(response,response.status===201?201:200),s=value.session,owner={cookie:response.headers.get('set-cookie').split(';')[0],csrf:s.csrfToken,sessionId:s.sessionId,principalId:s.principalId,contextRef:''};owner.contextRef=(await json(await request(owner,'/api/auth/v1/user-context'))).contextRef;return {...owner,returning:value.returning};};
 const owner=await bind(await request(null,'/api/auth/v1/setup',{username:'synthetic-returning',password,installerToken}));
 const assistant=await json(await request(owner,'/api/admin/v1/assistants',{displayName:'Synthetic returning Assistant'}),201),assistantId=assistant.assistantId;
 await json(await request(owner,'/api/admin/v1/assistants/'+assistantId+'/activate',{profileId:assistant.profile.profileId,expectedActiveRevision:null}));
 await json(await request(owner,'/api/admin/v1/assistants/'+assistantId+'/relationships',{}),201);
 const settings=async who=>json(await request(who,'/api/runtime/v1/session-context'));
 const privacy=async who=>json(await request(who,'/api/runtime/v1/audience/personal-session'));
 const command=async(who,operation)=>{const view=await privacy(who),selected=await settings(who);return json(await request(who,'/api/runtime/v1/audience/personal-session',{operation,operationId:randomUUID(),declarationId:randomUUID(),expectedAudienceRevision:view.revision,expectedPersonalSessionEpoch:view.personalSessionEpoch,expectedSessionRevision:selected.revision,endpointId:selected.endpoint.endpointId,expectedEndpointRevision:selected.endpoint.configurationRevision}));};
 const save=async(who,audienceScope='authenticatedSession',mode='text')=>{const view=await settings(who);return json(await request(who,'/api/runtime/v1/session-context',{expectedRevision:view.revision,bindingKey,audienceScope,mode}));};
 const create=async who=>(await json(await request(who,'/api/runtime/v1/conversations',historyRequest('create',{assistantId,title:'Synthetic saved conversation'})))).result;
 const select=async(who,conversationId)=>json(await request(who,'/api/runtime/v1/conversations/select',{producerPin:pin,assistantId,conversationId,expectedSessionRevision:(await settings(who)).revision}));
 const signin=async(extra={bindingKey,pendingLock:false})=>bind(await request(null,'/api/auth/v1/sign-in',{username:'synthetic-returning',password,...(extra===null?{}:{returningBrowser:extra})}));
 const startup=async who=>json(await request(who,'/api/runtime/v1/daily-startup'));
 const seed=async()=>{await save(owner);await command(owner,'unlock');const chat=await create(owner);await select(owner,chat.conversationId);return chat;};
 return {root,owner,request,settings,privacy,command,save,create,select,signin,startup,seed,calls,assistantId,bindingKey,password,app:()=>app,async restart(){await app.shutdown();app=createLifestreamServer({...options,port:Number(new URL(origin).port),historyRetention:{...options.historyRetention,journalInitialization:'requireExisting'}});await app.start();}};
}
async function bootstrapCookie(f,owner=f.owner){const raw={...owner,contextRef:''};const session=await json(await f.request(raw,'/api/auth/v1/daily-session'));assert.equal(session.sessionId,owner.sessionId);assert.equal(session.csrfToken,owner.csrf);owner.contextRef=(await json(await f.request(raw,'/api/auth/v1/user-context'))).contextRef;return session;}
async function resume(f,owner=f.owner,input={bindingKey:f.bindingKey,pendingLock:false}){return json(await f.request(owner,'/api/auth/v1/resume-browser',input));}
test('same valid cookie after restart resumes exact existing runtime and canonical chat without Save, Unlock or sign-in',async t=>{
 const f=await fixture(t),chat=await f.seed(),before=await f.settings(f.owner),originalCookie=f.owner.cookie,csrf=f.owner.csrf;
 await f.restart();await bootstrapCookie(f);assert.equal((await f.privacy(f.owner)).privateAllowed,false,'GET does not grant');const mark=f.calls.length;
 assert.equal((await resume(f)).returning.status,'restored');assert.equal(f.owner.cookie,originalCookie);assert.equal(f.owner.csrf,csrf);
 const after=await f.settings(f.owner);assert.equal(after.revision,before.revision);assert.equal(after.endpoint.configurationRevision,before.endpoint.configurationRevision);assert.equal(after.endpoint.endpointId,before.endpoint.endpointId);assert.equal(after.selectedConversation.conversationId,chat.conversationId);assert.equal((await f.startup(f.owner)).privateAllowed,true);
 assert.equal(f.calls.slice(mark).some(c=>c.method==='POST'&&['/api/auth/v1/sign-in','/api/runtime/v1/session-context','/api/runtime/v1/audience/personal-session'].includes(c.path)),false);
});
test('already healthy explicit declaration is retained by resume, while explicit Lock and Withhold cannot reopen',async t=>{
 const f=await fixture(t);await f.seed();const before=await f.privacy(f.owner);assert.equal((await resume(f)).returning.status,'restored');const after=await f.privacy(f.owner);assert.equal(after.personalSessionId,before.personalSessionId);assert.equal(after.personalSessionEpoch,before.personalSessionEpoch);
 await f.command(f.owner,'lock');assert.equal((await resume(f)).returning.status,'protected');assert.equal((await f.startup(f.owner)).privateAllowed,false);
 await f.command(f.owner,'unlock');await f.save(f.owner,'unknown');assert.equal((await resume(f)).returning.status,'protected');assert.equal((await f.startup(f.owner)).privateAllowed,false);
});
test('pending older-session Lock is durable before resume can expose private startup and survives another restart',async t=>{
 const f=await fixture(t);await f.seed();await f.restart();await bootstrapCookie(f);
 assert.equal((await resume(f,f.owner,{bindingKey:f.bindingKey,pendingLock:true})).returning.status,'protected');assert.equal((await f.startup(f.owner)).privateAllowed,false);
 await f.restart();await bootstrapCookie(f);assert.equal((await resume(f)).returning.status,'protected');assert.equal((await f.startup(f.owner)).privateAllowed,false);
});
test('resume is ordinary CSRF-protected POST; GET, foreign binding, malformed input and revoked cookie never grant',async t=>{
 const f=await fixture(t);await f.seed();await f.restart();await bootstrapCookie(f);
 assert.equal((await f.request(f.owner,'/api/auth/v1/resume-browser')).status,405);
 assert.equal((await f.request({...f.owner,csrf:'wrong'},'/api/auth/v1/resume-browser',{bindingKey:f.bindingKey,pendingLock:false})).status,403);
 assert.equal((await resume(f,f.owner,{bindingKey:randomUUID(),pendingLock:false})).returning.status,'protected');
 assert.equal((await resume(f,f.owner,{bindingKey:f.bindingKey})).returning.status,'protected');assert.equal((await f.startup(f.owner)).privateAllowed,false);
 await json(await f.request(f.owner,'/api/auth/v1/sign-out',{}));assert.equal((await f.request(f.owner,'/api/auth/v1/resume-browser',{bindingKey:f.bindingKey,pendingLock:false})).status,401);
});
test('valid cookie with absent runtime may restore, but existing nonpersonal or stale runtime is never replaced',async t=>{
 const f=await fixture(t);await f.seed();const legacy=await f.signin(null);assert.equal((await f.settings(legacy)).endpoint,null);assert.equal((await resume(f,legacy)).returning.status,'restored');assert.equal((await f.startup(legacy)).privateAllowed,true);
 await f.save(legacy,'unknown');const before=await f.settings(legacy);assert.equal((await resume(f,legacy)).returning.status,'protected');const after=await f.settings(legacy);assert.equal(after.revision,before.revision);assert.equal(after.endpoint.endpointId,before.endpoint.endpointId);assert.equal(after.endpoint.configurationRevision,before.endpoint.configurationRevision);
});
test('same scalar endpoint revision cannot admit a changed privacy fingerprint through cookie resume',async t=>{
 const f=await fixture(t);await f.seed();await f.restart();await bootstrapCookie(f);
 const db=new DatabaseSync(join(f.root,'state.sqlite'));try{const row=db.prepare('SELECT endpoint_id,profile_json FROM interaction_endpoints').get(),profile=JSON.parse(row.profile_json);profile.privacyClass='public';db.prepare('UPDATE interaction_endpoints SET profile_json=? WHERE endpoint_id=?').run(JSON.stringify(profile),row.endpoint_id);}finally{db.close();}
 assert.equal((await resume(f)).returning.status,'protected');assert.equal((await f.startup(f.owner)).privateAllowed,false);
});
test('resumed contribution is pinned to effective-context generation; proxy context cannot resume self policy',async t=>{
 const f=await fixture(t);await f.seed();await f.restart();await bootstrapCookie(f);assert.equal((await resume(f)).returning.status,'restored');
 const auth=f.app().localAuth,origin='http://127.0.0.1:'+f.app().address().port,actor=auth.context(f.owner.cookie.split('=')[1],origin,false),before=auth.effectiveSubjects.resolve(actor);
 auth.effectiveSubjects.execute(actor,{schemaVersion:'1.0.0',operationId:randomUUID(),operation:'endContext',expectedGeneration:before.context.generation,payload:{}});
 assert.equal((await f.request(f.owner,'/api/auth/v1/resume-browser',{bindingKey:f.bindingKey,pendingLock:false})).status,409,'Old context reference rejected');
 const fresh=auth.effectiveSubjects.resolve(actor);f.owner.contextRef=fresh.contextRef;assert.equal((await f.startup(f.owner)).privateAllowed,false,'Old saved contribution retired on new context generation');assert.equal((await resume(f)).returning.status,'protected','Cannot dynamically adopt successor authority');
 const target=await json(await f.request(f.owner,'/api/auth/v1/accounts',{username:'synthetic-proxy-target',password:randomBytes(24).toString('hex')}),201),current=auth.effectiveSubjects.resolve(actor);
 auth.effectiveSubjects.execute(actor,{schemaVersion:'1.0.0',operationId:randomUUID(),operation:'startContext',expectedGeneration:current.context.generation,payload:{targetUserId:target.principalId}});f.owner.contextRef=auth.effectiveSubjects.resolve(actor).contextRef;
 assert.equal((await f.request(f.owner,'/api/auth/v1/resume-browser',{bindingKey:f.bindingKey,pendingLock:false})).status,403);
});
