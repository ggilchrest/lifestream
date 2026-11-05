// Real original host owners and temporary local account state; no production inputs.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,chmodSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {Database} from '@lifestream/storage-sqlite';
import {createLifestreamServer} from '../dist/index.js';
import {loadProfile} from '../dist/config/loader.js';
import {LocalAuthentication} from '../dist/auth/local-auth.js';
import {readSessionEndpoint,reviseSessionEndpoint} from '../dist/runtime/session-context.js';
const secret=()=> 'Synthetic-'+randomBytes(24).toString('hex');

async function fixture(endpointClass='desktopCompanion'){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'daily-uc-stream-'));chmodSync(root,0o700);const mask=process.umask(0o077);let now=Date.now();
 const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'test.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=secret(),app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'auth'),installerToken,now:()=>now}});await app.start();const base=`http://127.0.0.1:${app.address().port}`;let cookie='',csrf='',reference='';
 const request=(route:string,body?:unknown,headers:Record<string,string>={})=>fetch(base+route,{method:body===undefined?'GET':'POST',headers:{origin:base,'content-type':'application/json',cookie,'x-lifestream-csrf':csrf,...(reference?{'x-lifestream-user-context':reference}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
 const setup=await request('/api/auth/v1/setup',{username:'synthetic-owner',password:secret(),installerToken});assert.equal(setup.status,201);cookie=setup.headers.get('set-cookie')!.split(';')[0]!;const {session}=await setup.json();csrf=session.csrfToken;
 const current=await(await request('/api/auth/v1/user-context')).json();reference=current.contextRef;
 const selected=await request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',endpointClass,bindingKey:randomUUID()});assert.equal(selected.status,200);
 const internal=app as unknown as {database:Database;localAuth:LocalAuthentication;durableConversationRepository?:unknown};
 return {app,base,session,sessionCookie:cookie,internal,request,advance:(ms:number)=>{now+=ms;},reference:()=>reference,setReference:(value:string)=>{reference=value;},current:async()=>{const response=await fetch(base+'/api/auth/v1/user-context',{headers:{origin:base,cookie},signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);return response.json();},close:async()=>{await app.shutdown();process.umask(mask);rmSync(root,{recursive:true,force:true});}};
}

const actualControllerURL=new URL('../../daily-web/owners/user-context.js',import.meta.url),actualPinsURL=new URL('../../daily-web/owners/unified-desktop-contracts.js',import.meta.url);
const controllerSource=readFileSync(actualControllerURL,'utf8'),specifier="'/daily/owners/unified-desktop-contracts.js'";assert.equal(controllerSource.split(specifier).length,2);
// Only the actual published-contract module URL changes for Node import. Every
// original controller function and its source-state machine run unchanged.
const {createUserContextController}=await import('data:text/javascript;base64,'+Buffer.from(controllerSource.replace(specifier,JSON.stringify(actualPinsURL.href))).toString('base64'));
const appSource=readFileSync(new URL('../../daily-web/app.js',import.meta.url),'utf8'),applyStart=appSource.indexOf('async function loadWorkspace('),applyEnd=appSource.indexOf('\n// Read-only startup metadata',applyStart);assert(applyStart>=0&&applyEnd>applyStart);
const applySource=appSource.slice(applyStart,applyEnd);
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
async function waitFor(check:()=>boolean){const until=Date.now()+2000;while(!check()){if(Date.now()>until)assert.fail('Original controller state did not settle');await new Promise(resolve=>setTimeout(resolve,5));}}

test('whole Daily controller and apply accept actual hosted current snapshots without inventing events or reviving changed/revoked scope',{timeout:15000},async()=>{
 const f=await fixture();let controller:any,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,watch:any,protects=0,applies=0,apiReads=0;const streamAbort=new AbortController();
 try{
  const authentication={mode:'local-password',session:f.session};
  const api=async(path:string)=>{apiReads++;const ref=path.startsWith('/api/runtime/')?controller?.read()?.contextRef:undefined;const response=await f.request(path,undefined,ref?{'x-lifestream-user-context':ref}:path==='/api/auth/v1/user-context'?{'x-lifestream-user-context':''}:{});if(!response.ok)throw Object.assign(Error('Actual host read denied'),{status:response.status});return response.json();};
  // The actual Auth request omits UC-reference on its source-owned bootstrap
  // GET; the fixture request helper adds one, so bypass that helper for UC only.
  const transport=async(path:string)=>{if(path==='/api/auth/v1/user-context'){apiReads++;return f.current();}return api(path);};
  const nodes=new Map<string,{textContent:string;hidden:boolean}>(),get=(id:string)=>{if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:false});return nodes.get(id);};
  const originalApply=runInNewContext('let current=null,assistants=[],relationship=null,epoch=0,closed=false; const auth=authentication; const uuid=id=>typeof id===\"string\"; const validAssistant=item=>!!item; const renderIdentity=()=>{}; const report=()=>{}; const room={protectScope(){}}; const $=get; '+applySource+'; loadWorkspace',{authentication,api:transport,get});
  controller=createUserContextController({authentication:()=>authentication,api:transport,protect:()=>{protects++;},apply:async(...args:any[])=>{applies++;await originalApply(...args);},watch:(callbacks:any)=>{watch=callbacks;return()=>{};},window:{addEventListener(){},removeEventListener(){}}});
  assert.equal(await controller.ready,true);assert.equal(controller.snapshot().phase,'ready');assert.equal(applies,1);const admitted=controller.read();assert.equal(protects,1);
  const stream=await fetch(f.base+'/api/auth/v1/user-context/events?transport=shared-v1',{headers:{origin:f.base,cookie:f.sessionCookie},signal:AbortSignal.any([streamAbort.signal,AbortSignal.timeout(10000)])});
  assert.equal(stream.status,200);reader=stream.body!.getReader();let buffer='';const decoder=new TextDecoder();
  const next=async(predicate:(value:any)=>boolean=()=>true)=>{const until=Date.now()+2000;for(;;){let boundary=buffer.indexOf('\n\n');while(boundary>=0){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const line=frame.split('\n').find(row=>row.startsWith('data: '));if(line){const value=JSON.parse(line.slice(6));if(predicate(value))return value;}boundary=buffer.indexOf('\n\n');}if(Date.now()>until)assert.fail('Original host SSE frame unavailable');const value=await reader!.read();assert.equal(value.done,false);buffer+=decoder.decode(value.value,{stream:true});}};
  const initial=await next();assert.equal(Object.hasOwn(initial,'event'),false);assert.equal(initial.contextRef,admitted.contextRef);watch.onContext(initial);await settle();assert.equal(controller.snapshot().phase,'ready');assert.equal(controller.read(),admitted);assert.equal(applies,1);assert.equal(protects,1);
  const heartbeat=await next();assert.equal(Object.hasOwn(heartbeat,'event'),false);watch.onContext(heartbeat);await settle();assert.equal(controller.snapshot().phase,'ready');assert.equal(applies,1);assert.equal(protects,1);
  const created=await f.request('/api/auth/v1/accounts',{username:'synthetic-stream-target',password:secret()});assert.equal(created.status,201);const target=await created.json(),auth=f.internal.localAuth,before=auth.hostSessionContext(f.session.sessionId);
  auth.effectiveSubjects.execute(before,{schemaVersion:'1.0.0',operation:'startContext',operationId:randomUUID(),expectedGeneration:before.effectiveContext!.generation,payload:{targetUserId:target.principalId}});
  const changedSnapshot=await f.current();assert.equal(Object.hasOwn(changedSnapshot,'event'),false);watch.onContext(changedSnapshot);await waitFor(()=>controller.snapshot().phase==='protected');assert.equal(controller.read(),null,'Changed unsequenced source snapshot must retire the old view');
  const changed=await next(value=>value.event?.type==='contextChanged');assert.equal(changed.event.context.effectiveUserId,target.principalId);watch.onContext(changed);await waitFor(()=>controller.snapshot().phase==='ready');assert.equal(controller.read().context.effectiveUserId,target.principalId);const applyAfterChange=applies;
  watch.onContext(initial);watch.onContext(changed);await settle();assert.equal(controller.read().context.effectiveUserId,target.principalId);assert.equal(applies,applyAfterChange,'Old snapshot and event replay cannot reapply');
  const currentSnapshot=await f.current();watch.onContext({...currentSnapshot,event:null});await waitFor(()=>controller.snapshot().phase==='protected');assert.equal(controller.read(),null,'Malformed event-bearing payload is not a heartbeat');
  watch.onContext(currentSnapshot);await settle();assert.equal(controller.snapshot().phase,'protected','No-event snapshot cannot restore a retired view');
  watch.onReconnect();await waitFor(()=>controller.snapshot().phase==='ready');assert.equal(controller.read().context.effectiveUserId,target.principalId);
  f.advance(31*60*1000);const returned=await f.current();assert.equal(returned.impersonating,false);const revoked=await next(value=>value.event?.type==='authorizationRevoked');watch.onContext(revoked);await waitFor(()=>controller.snapshot().phase==='protected');const afterRevocation=applies;watch.onContext(returned);watch.onContext(changed);await settle();assert.equal(controller.snapshot().phase,'protected');assert.equal(applies,afterRevocation);
  assert.ok(apiReads<12,'Unsequenced snapshots must not create an HTTP retry loop');
 }finally{controller?.dispose();streamAbort.abort();try{await reader?.cancel();}catch{}await f.close();}
});

test('actual same-source heartbeat cannot cancel a held legitimate HTTP recheck or loading apply', {timeout:15000},async()=>{
 const f=await fixture();let controller:any,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,watch:any,protects=0,held=false,hold:'none'|'http'|'apply'='none',release!:()=>void;const streamAbort=new AbortController();
 try{
  const authentication={mode:'local-password',session:f.session};let gate=Promise.resolve();
  const transport=async(path:string)=>{
   if(path==='/api/auth/v1/user-context'){const value=await f.current();if(hold==='http'){held=true;await gate;}return value;}
   const response=await f.request(path,undefined,{'x-lifestream-user-context':controller.read().contextRef});assert.equal(response.status,200);return response.json();
  };
  const nodes=new Map(),get=(id:string)=>{if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:false});return nodes.get(id);};
  const originalApply=runInNewContext('let current=null,assistants=[],relationship=null,epoch=0,closed=false; const auth=authentication; const uuid=id=>typeof id===\"string\"; const validAssistant=item=>!!item; const renderIdentity=()=>{}; const report=()=>{}; const room={protectScope(){}}; const $=get; '+applySource+'; loadWorkspace',{authentication,api:transport,get});
  controller=createUserContextController({authentication:()=>authentication,api:transport,protect:()=>{protects++;},apply:async(...args:any[])=>{await originalApply(...args);if(hold==='apply'){held=true;await gate;}},watch:(callbacks:any)=>{watch=callbacks;return()=>{};},window:{addEventListener(){},removeEventListener(){}}});
  assert.equal(await controller.ready,true);const original=controller.read();
  const stream=await fetch(f.base+'/api/auth/v1/user-context/events?transport=shared-v1',{headers:{origin:f.base,cookie:f.sessionCookie},signal:AbortSignal.any([streamAbort.signal,AbortSignal.timeout(10000)])});assert.equal(stream.status,200);reader=stream.body!.getReader();let buffer='';const decoder=new TextDecoder();
  const frame=async()=>{for(;;){const boundary=buffer.indexOf('\n\n');if(boundary>=0){const value=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const line=value.split('\n').find(row=>row.startsWith('data: '));if(line)return JSON.parse(line.slice(6));continue;}const value=await reader!.read();assert.equal(value.done,false);buffer+=decoder.decode(value.value,{stream:true});}};
  const initial=await frame();assert.equal(Object.hasOwn(initial,'event'),false);assert.equal(initial.contextRef,original.contextRef);
  for(const stage of ['http','apply'] as const){
   hold=stage;held=false;gate=new Promise<void>(resolve=>{release=resolve;});const recheck=controller.refresh();await waitFor(()=>held);const phase=stage==='http'?'checking':'loading';assert.equal(controller.snapshot().phase,phase);const before=protects;
   const heartbeat=await frame();assert.equal(Object.hasOwn(heartbeat,'event'),false);assert.equal(heartbeat.contextRef,original.contextRef);watch.onContext(heartbeat);await settle();assert.equal(controller.snapshot().phase,phase,'Identical heartbeat cannot retire an in-flight original owner recheck');assert.equal(protects,before);
   hold='none';release();assert.equal(await recheck,true);assert.equal(controller.snapshot().phase,'ready');assert.equal(controller.read().contextRef,original.contextRef);
  }
 }finally{release?.();controller?.dispose();streamAbort.abort();try{await reader?.cancel();}catch{}await f.close();}
});
