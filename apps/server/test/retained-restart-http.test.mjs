import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const backendRoot=new URL(process.env.CT_BACKEND_ROOT??'../../../',import.meta.url);
const {createLifestreamServer}=await import(new URL('apps/server/dist/index.js',backendRoot));
const {loadProfile}=await import(new URL('apps/server/dist/config/loader.js',backendRoot));
const {unifiedDesktopContractPin}=await import(new URL('packages/contracts/dist/unified-desktop-contracts.js',backendRoot));
const pin=unifiedDesktopContractPin('conversation-history');
const historyRequest=(operation,payload)=>({producerPin:pin,request:{schemaVersion:'1.0.0',operation,operationId:randomUUID(),...(['create'].includes(operation)?{idempotencyKey:randomUUID()}:{}),payload}});
async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function fixture(t){
 const root=mkdtempSync(join(process.env.CT_SYNTHETIC_ROOT??tmpdir(),'retained-restart-http-'));chmodSync(root,0o700);const oldMask=process.umask(0o077);
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
 return {owner,request,settings,privacy,command,save,create,select,signin,startup,seed,calls,assistantId,bindingKey,password,app:()=>app,async restart(){await app.shutdown();app=createLifestreamServer({...options,port:Number(new URL(origin).port),historyRetention:{...options.historyRetention,journalInitialization:'requireExisting'}});await app.start();}};
}
test('retained original cookie plus UC reproof stays locked after new backend until existing saved-policy resume runs',async t=>{
 const f=await fixture(t),chat=await f.seed(),selected=await f.settings(f.owner),before=await f.privacy(f.owner);
 assert.equal(before.privateAllowed,true);const identity=f.owner,context=await json(await f.request(f.owner,'/api/auth/v1/user-context'));
 await f.restart();const mark=f.calls.length;
 const reproved=await json(await f.request(f.owner,'/api/auth/v1/user-context'));
 assert.equal(reproved.contextRef,context.contextRef);assert.deepEqual(reproved.context,context.context);
 const protectedView=await f.privacy(f.owner);assert.equal(protectedView.personalSessionState,'locked');assert.equal(protectedView.privateAllowed,false);
 assert.notEqual(protectedView.personalSessionEpoch,before.personalSessionEpoch);
 assert.equal((await f.startup(f.owner)).privateAllowed,false,'Transport UC reproof and personal GET do not restore durable permission');
 const resumed=await json(await f.request(f.owner,'/api/auth/v1/resume-browser',{bindingKey:f.bindingKey,pendingLock:false}));
 assert.equal(resumed.returning.status,'restored');const restored=await f.privacy(f.owner);
 assert.equal(restored.privateAllowed,true);assert.equal(restored.personalSessionBasis,'savedPreference');assert.equal(restored.personalSessionEpoch,protectedView.personalSessionEpoch);
 const ready=await f.startup(f.owner);assert.equal(ready.privateAllowed,true);assert.equal(ready.session.selectedConversation.conversationId,chat.conversationId);
 assert.equal(f.owner,identity,'Original authenticated owner object is retained');
 const after=await f.settings(f.owner);assert.equal(after.endpoint.endpointId,selected.endpoint.endpointId);assert.equal(after.endpoint.configurationRevision,selected.endpoint.configurationRevision);
 assert.deepEqual(f.calls.slice(mark).filter(c=>c.method==='POST').map(c=>c.path),['/api/auth/v1/resume-browser'],'No new sign-in, Unlock, Save, or selection after restart');
});
test('retained pending Lock is durable denial before resume and later clean resume cannot undo it',async t=>{
 const f=await fixture(t);await f.seed();await f.restart();
 const result=await json(await f.request(f.owner,'/api/auth/v1/resume-browser',{bindingKey:f.bindingKey,pendingLock:true}));assert.equal(result.returning.status,'protected');
 const later=await json(await f.request(f.owner,'/api/auth/v1/resume-browser',{bindingKey:f.bindingKey,pendingLock:false}));assert.equal(later.returning.status,'protected');assert.equal((await f.privacy(f.owner)).privateAllowed,false);
});
test('retained server-confirmed manual Lock survives backend recreation and existing resume route',async t=>{
 const f=await fixture(t);await f.seed();await f.command(f.owner,'lock');await f.restart();
 const result=await json(await f.request(f.owner,'/api/auth/v1/resume-browser',{bindingKey:f.bindingKey,pendingLock:false}));assert.equal(result.returning.status,'protected');assert.equal((await f.privacy(f.owner)).privateAllowed,false);
});
test('retained withheld endpoint is not restored by resume',async t=>{
 const f=await fixture(t);await f.seed();await f.save(f.owner,'unknown');await f.restart();
 const result=await json(await f.request(f.owner,'/api/auth/v1/resume-browser',{bindingKey:f.bindingKey,pendingLock:false}));assert.equal(result.returning.status,'protected');assert.equal((await f.startup(f.owner)).privateAllowed,false);
});
test('existing resume still rejects missing authentication and incorrect CSRF before readmission',async t=>{
 const f=await fixture(t);await f.seed();await f.restart();
 const body={bindingKey:f.bindingKey,pendingLock:false};
 assert.equal((await f.request(null,'/api/auth/v1/resume-browser',body)).status,401);
 assert.equal((await f.request({...f.owner,csrf:'synthetic-wrong-csrf'},'/api/auth/v1/resume-browser',body)).status,403);
 assert.equal((await f.privacy(f.owner)).privateAllowed,false);
});
test('missing saved preference remains protected for the original retained cookie',async t=>{
 const f=await fixture(t);await f.seed();
 const removed=f.app().database.connection.prepare('DELETE FROM returning_browser_preferences WHERE principal_id=? AND binding_key=?').run(f.owner.principalId,f.bindingKey);assert.equal(removed.changes,1,'Declared synthetic policy fixture only');
 await f.restart();
 const result=await json(await f.request(f.owner,'/api/auth/v1/resume-browser',{bindingKey:f.bindingKey,pendingLock:false}));assert.equal(result.returning.status,'protected');assert.equal((await f.privacy(f.owner)).privateAllowed,false);
});
test('explicitly revoked saved policy cannot be revived by retained recovery while authentication remains valid',async t=>{
 const f=await fixture(t);await f.seed();
 const revoked=f.app().database.connection.prepare("UPDATE returning_browser_preferences SET state='revoked',authority_epoch=authority_epoch+1 WHERE principal_id=? AND binding_key=?").run(f.owner.principalId,f.bindingKey);assert.equal(revoked.changes,1,'Declared synthetic policy fixture only');
 await f.restart();assert.equal((await json(await f.request(f.owner,'/api/auth/v1/user-context'))).context.authenticatedSessionId,f.owner.sessionId);
 const result=await json(await f.request(f.owner,'/api/auth/v1/resume-browser',{bindingKey:f.bindingKey,pendingLock:false}));assert.equal(result.returning.status,'protected');assert.equal((await f.privacy(f.owner)).privateAllowed,false);
});
