import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createContext,SourceTextModule} from 'node:vm';
import test from 'node:test';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';

// Real local Auth, CSRF, User Context, HTTP serving and relationship owners.
// VM modules are the exact served bytes, without source or import rewriting.
// The small DOM/capture port is synthetic; rendered controls have separate
// browser evidence. No production data, real inference, native devices or grants.
test('served Daily relationship adapter joins the actual authenticated context transport and unchanged owners',{timeout:20000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'daily-relationship-http52-'));
 const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'data.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=randomUUID(),app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'safety'),installerToken}});
 t.after(async()=>{await app.shutdown();await rm(root,{recursive:true,force:true});});await app.start();
 const base=`http://127.0.0.1:${app.address().port}`;let cookie='',session,envelope;
 const request=(path,body,extra={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin:base,cookie,'content-type':'application/json',...(session?{'x-lifestream-csrf':session.csrfToken}:{}),...(envelope?{'x-lifestream-user-context':envelope.contextRef}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const json=async(path,body,extra)=>{const response=await request(path,body,extra);assert.ok(response.ok,`Synthetic API failed: ${path} (${response.status})`);return response.json();};
 const setup=await request('/api/auth/v1/setup',{username:'synthetic-owner',password:randomUUID()+randomUUID(),installerToken});assert.equal(setup.status,201);cookie=setup.headers.get('set-cookie').split(';')[0];session=(await setup.json()).session;
 envelope=await json('/api/auth/v1/user-context');
 const assistant=await json('/api/admin/v1/assistants',{displayName:'Synthetic relationship fixture'});
 await json(`/api/admin/v1/assistants/${assistant.assistantId}/activate`,{profileId:assistant.profile.profileId,expectedActiveRevision:null});
 const state=await json('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'});
 const profileBefore=await json(`/api/admin/v1/assistants/${assistant.assistantId}`),route=`/api/admin/v1/assistants/${assistant.assistantId}/relationships`;
 assert.equal((await json(route)).relationships.length,0);

 const document=new EventTarget();document.hidden=false;document.documentElement={dataset:{audienceProtected:'false'}};
 class Element extends EventTarget{
  constructor(tag){super();this.tagName=tag;this.children=[];this.hidden=false;this.disabled=false;this.text='';this.dataset={};}
  get isConnected(){return this===document.body||!!this.parent?.isConnected;}
  append(...nodes){for(const node of nodes){node.remove();node.parent=this;this.children.push(node);}}
  replaceChildren(...nodes){for(const node of this.children)node.parent=null;this.children=[];this.append(...nodes);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);this.parent=null;}
  set textContent(value){this.text=String(value);this.replaceChildren();}
  get textContent(){return this.text+this.children.map(node=>node.textContent).join(' ');}
  setAttribute(){}
  closest(){for(let node=this;node;node=node.parent)if(node.hidden||node.inert)return node;return null;}
  focus(){document.activeElement=this;}
 }
 document.createElement=tag=>new Element(tag);document.body=new Element('body');const anchor=new Element('section');document.body.append(anchor);
 const window=new EventTarget(),vm=createContext({window,document,console,URL,TextEncoder,TextDecoder,Event,EventTarget,CustomEvent,AbortController,AbortSignal,setTimeout,clearTimeout,performance,crypto:globalThis.crypto});
 const modules=new Map(),served=[];
 const load=url=>{
  if(!modules.has(url))modules.set(url,(async()=>{
   const path=new URL(url).pathname;assert.match(path,/^\/(?:daily\/owners|control)\/[A-Za-z0-9_-]+\.(?:js|mjs)$/);
   const response=await request(path);assert.equal(response.status,200);const body=await response.text();
   const local=path.startsWith('/daily/')?'../../daily-web/'+path.slice('/daily/'.length):'../../control-web/'+path.slice('/control/'.length);
   const original=await readFile(new URL(local,import.meta.url),'utf8');assert.equal(body,original);
   served.push({url:path,sha256:createHash('sha256').update(body).digest('hex')});return new SourceTextModule(body,{context:vm,identifier:url});
  })());return modules.get(url);
 };
 const evaluate=async path=>{const module=await load(base+path);if(module.status==='unlinked')await module.link((specifier,parent)=>load(new URL(specifier,parent.identifier).href));if(module.status!=='evaluated')await module.evaluate();return module.namespace;};
 const transport=await evaluate('/daily/owners/workspace-context.js');
 const ui=await evaluate('/daily/owners/relationship-setup-navigation.js');
 const auth={mode:'local-password',session,ready:Promise.resolve()},calls=[];let held=false,entered,release;
 const api=transport.createContextBoundApi({authentication:()=>auth,context:()=>envelope,fetch:async(path,options)=>{
  assert.equal(options.headers['x-lifestream-user-context'],envelope.contextRef);assert.equal(options.headers['x-lifestream-csrf'],session.csrfToken);
  calls.push({path,method:options.method??'GET'});
  const response=await fetch(base+path,{...options,headers:{...options.headers,origin:base,cookie}});
  if(held&&path===route){entered();await new Promise(resolve=>{release=resolve;});}
  return response;
 }});
 let owner={binding:auth,projection:{},principalId:session.principalId,effectiveUserId:envelope.context.effectiveUserId,sessionId:session.sessionId,endpointId:state.endpoint.endpointId,endpointRevision:state.endpoint.configurationRevision,sessionRevision:state.revision,assistantId:assistant.assistantId,profileId:assistant.profile.profileId,profileRevision:assistant.profile.revision,contextRef:envelope.contextRef,contextGeneration:envelope.context.generation,authorityRevision:envelope.context.authorityRevision,epoch:0};
 let changed=0;const adapter=ui.installDailyRelationshipSetupNavigation({anchor,api,capture:()=>auth.session?owner:null,isCurrentOwner:value=>!!auth.session&&value===owner,requestNavigation:async intent=>{intent.proceed();return true;},navigateConversation:async intent=>intent.isCurrent(),onChanged:()=>changed++,document,window});t.after(()=>adapter.dispose());
 const intent={isCurrent:()=>true};assert.equal(calls.length,0);assert.equal(adapter.available(),true);
 assert.equal(await adapter.open(intent),true);assert.equal(adapter.snapshot().state,'pending');assert.equal(calls.filter(call=>call.method==='POST').length,0);
 assert.equal(await adapter.startReview(),true);assert.equal(changed,1);assert.equal(calls.filter(call=>call.method==='POST').length,1);
 const existing=(await json(route)).relationships;assert.equal(existing.length,1);assert.equal(existing[0].userId,session.principalId);assert.equal(existing[0].status,'active');
 await adapter.refresh();assert.equal(await adapter.startReview(),false);assert.deepEqual((await json(route)).relationships,existing,'Existing active relationship is never rewritten by setup.');
 // Relationship routes intentionally retain their real-actor contract. Check
 // stale effective context on the original bound Daily read, not by inventing
 // an effective-subject contract for the old relationship API.
 const badContext=await request('/api/runtime/v1/daily-context?assistantId='+assistant.assistantId,undefined,{'x-lifestream-user-context':randomUUID()});assert.equal(badContext.status,409);await badContext.arrayBuffer();
 const badCsrf=await request(route,{}, {'x-lifestream-csrf':randomUUID()});assert.equal(badCsrf.status,403);await badCsrf.arrayBuffer();assert.deepEqual((await json(route)).relationships,existing);
 const reply=await api('/api/runtime/v1/messages',{method:'POST',body:JSON.stringify({assistantId:assistant.assistantId,relationshipId:existing[0].relationshipId,userInput:'A synthetic text turn after optional setup.'}),responseType:'response'});
 assert.equal(reply.status,200);assert.match(await reply.text(),/interaction.completed/);
 assert.deepEqual((await json(`/api/admin/v1/assistants/${assistant.assistantId}`)).profiles,profileBefore.profiles,'Setup does not edit the accepted synthetic profile/persona.');
 const asset='/daily/owners/relationship-setup-navigation.js',head=await fetch(base+asset,{method:'HEAD',headers:{origin:base,cookie}});assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
 const code=await (await request('/daily/app.js')).text();assert.match(code,/from '\/daily\/owners\/relationship-setup-navigation\.js'/);
 for(const path of ['/daily/test/relationship-setup-navigation.test.mjs','/daily/owners/relationship-setup-navigation.js/secret']){const denied=await request(path);assert.equal(denied.status,404);await denied.arrayBuffer();}

 held=true;const started=new Promise(resolve=>{entered=resolve;});const pending=adapter.refresh();await started;
 await json('/api/auth/v1/sign-out',{});auth.session=null;owner=null;release();
 assert.equal(await pending,false);assert.equal(adapter.snapshot().state,'unavailable');assert.equal(adapter.snapshot().available,false);assert.equal(await adapter.startReview(),false);
 assert.equal(calls.filter(call=>call.path===route&&call.method==='POST').length,1,'No stale or automatic start replay.');
 assert.equal(calls.some(call=>/\/skip|candidates|profile-builder|camera|microphone/.test(call.path)),false);
 console.log(JSON.stringify({qualification:'PASS_REAL_AUTH_CONTEXT_TRANSPORT_AND_SOURCE_SERVING',servedModules:served,relationshipStartPosts:1,stalePostReplay:0,syntheticTextTurns:1,realProviderOrDeviceActions:0,productionData:false,renderedAcceptance:'Separate UI worker browser fixture; this test uses a synthetic DOM and real local Auth/API owners.'}));
});
