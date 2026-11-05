import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
 return {owner,request,settings,privacy,command,save,create,select,signin,startup,seed,calls,assistantId,bindingKey,password,app:()=>app,async restart(){await app.shutdown();app=createLifestreamServer({...options,port:Number(new URL(origin).port),historyRetention:{...options.historyRetention,journalInitialization:'requireExisting'}});await app.start();}};
}
test('genuine returning HTTP sign-in restores chat after logout and restart without a Save or Unlock request',async t=>{
 const f=await fixture(t),chat=await f.seed(),before=await f.settings(f.owner);
 await json(await f.request(f.owner,'/api/auth/v1/sign-out',{}));await f.restart();const mark=f.calls.length,returned=await f.signin();
 assert.notEqual(returned.sessionId,f.owner.sessionId);assert.notEqual(returned.csrf,f.owner.csrf);assert.notEqual(returned.contextRef,f.owner.contextRef);
 const ready=await f.startup(returned);assert.equal(ready.privateAllowed,true);assert.equal(ready.assistant.assistantId,f.assistantId);assert.equal(ready.session.selectedConversation.conversationId,chat.conversationId);
 const selected=await f.settings(returned);assert.equal(selected.endpoint.endpointId,before.endpoint.endpointId);assert.equal(selected.endpoint.configurationRevision,before.endpoint.configurationRevision);
 assert.equal(f.calls.slice(mark).some(c=>c.method==='POST'&&['/api/runtime/v1/session-context','/api/runtime/v1/audience/personal-session'].includes(c.path)),false);
 const another=await f.create(returned);await f.select(returned,another.conversationId);assert.equal((await f.startup(returned)).privateAllowed,true,'Ordinary selection preserves restored authority');
 const reply=await f.request(returned,'/api/runtime/v1/messages',{assistantId:f.assistantId,conversationId:another.conversationId,userInput:'SYNTHETIC returning HTTP message'});assert.equal(reply.status,200,await reply.clone().text());assert.match(await reply.text(),/interaction.completed/);
 const retention=await json(await f.request(returned,'/api/runtime/v1/conversation-retention?assistantId='+f.assistantId));assert.equal(retention.enabled,true);
});
test('manual Lock, explicit Withhold and pending older-session Lock survive genuine HTTP sign-in',async t=>{
 for(const kind of ['manual','withhold','pending'])await t.test(kind,async t=>{
  const f=await fixture(t);await f.seed();if(kind==='manual')await f.command(f.owner,'lock');if(kind==='withhold')await f.save(f.owner,'unknown');
  const returned=await f.signin({bindingKey:f.bindingKey,pendingLock:kind==='pending'});assert.equal((await f.startup(returned)).privateAllowed,false);
  if(kind==='withhold')assert.equal((await f.settings(returned)).endpoint.privacyClass,'public');
  const later=await f.signin();assert.equal((await f.startup(later)).privateAllowed,false,'Denial persists beyond the pending request');
 });
});
test('a Lock accepted while password verification is in flight prevents returning admission',async t=>{
 const f=await fixture(t);await f.seed();const pending=f.signin();await new Promise(resolve=>setImmediate(resolve));await f.command(f.owner,'lock');const returned=await pending;assert.equal((await f.startup(returned)).privateAllowed,false);
});
test('an original cookie can withdraw its saved browser policy after restart without reenrollment',async t=>{
 const f=await fixture(t);await f.seed();await f.restart();await f.save(f.owner,'unknown','none');
 const returned=await f.signin();assert.equal((await f.startup(returned)).privateAllowed,false);
});
test('absent and foreign browser bindings cannot select another device or alter legacy sign-in behavior',async t=>{
 const f=await fixture(t);await f.seed();const legacy=await f.signin(null);assert.equal(legacy.returning,undefined);assert.equal((await f.settings(legacy)).endpoint,null);
 const unknown=await f.signin({bindingKey:randomUUID(),pendingLock:false});assert.equal((await f.startup(unknown)).privateAllowed,false);assert.equal((await f.settings(unknown)).endpoint,null);
 const denied=await f.request(null,'/api/auth/v1/sign-in',{username:'synthetic-returning',password:'synthetic incorrect password',returningBrowser:{bindingKey:f.bindingKey,pendingLock:true}});assert.equal(denied.status,401);
 assert.equal((await f.startup(f.owner)).privateAllowed,true,'A failed password cannot write a pending Lock');
});
