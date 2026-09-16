import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PwceGatewayClient} from '../packages/providers-pwce/src/client.ts';
const root=resolve(process.env.PWCE_PRODUCER_ROOT??'../PWCE');
const load=path=>import(pathToFileURL(join(root,path)).href);
const {StateStore,emptyState}=await load('src/runtime/state-store.js');
const {ActionService}=await load('src/actions/action-service.js');
const {ApprovalService,actionFingerprint}=await load('src/actions/approval-service.js');
const {GatewayService}=await load('src/gateway/gateway-service.js');
const {createGatewayHttpBinding}=await load('src/http/gateway-server.js');
const {dispatchBundle}=await load('src/gateway/dispatch-bundle.js');
const {approvalRecoveryContracts:bundle}=await load('src/gateway/approval-recovery-contracts.js');
async function fixture(t,{persistent=false,unknown=false}={}){
 let now=Date.now(),calls=0,checks=0,reconciles=0;
 const clock=()=>new Date(now),token='synthetic-recovery-agent',dispatcherToken='synthetic-recovery-trusted-dispatcher-token';
 const dir=persistent?await mkdtemp(join(tmpdir(),'pwce-admission-recovery-')):null,path=dir?join(dir,'state.json'):null;
 if(dir)t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new StateStore(path?{path}:{state:emptyState()});
 const target={identity:'synthetic.recovery-proof',async checkPreconditions(){checks++;return {allowed:true,observed:{synthetic:true},reasonCode:'synthetic_ready'};},async invoke(){calls++;return {status:unknown?'outcome_unknown':'succeeded',externalEffectOccurred:unknown?'unknown':true};},async getInvocation(){reconciles++;return {status:'succeeded',externalEffectOccurred:true};}};
 const approvals=new ApprovalService({store,clock});const actions=new ActionService({store,target,clock,approvalService:approvals});actions.registerGrant({principalRef:'agent.fixture',siteRefs:['home.one'],capabilityRefs:['home.light.set_level']});
 const gateway=new GatewayService({store,actionService:actions,clock}),binding=createGatewayHttpBinding({store,token,dispatcherToken,actionService:actions,gateway});
 const server=createServer((req,res)=>binding.handle(req,res,new URL(req.url,'http://127.0.0.1').pathname));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));gateway.close();});
 const send=async(route,body,headers={},method=body===undefined?'GET':'POST')=>{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/gateway/v1${route}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)}),signal:AbortSignal.timeout(3000)});
  return {status:response.status,headers:response.headers,body:await response.json()};
 };
 const identity={assistantRef:'assistant.synthetic',endpointRef:'endpoint.synthetic',participantRefs:['participant.one','participant.two'],audienceRef:'audience.synthetic'};
 const authority=await send('/authority',{...identity,siteRefs:['home.one']}),scope={...identity,authorityContextRef:authority.body.authorityContextRef,worldRef:'world.personal.v1',executionEnvironmentRef:'test'};
 const snapshot=(await send('/request',{...scope,operation:'capabilities.getSnapshot'})).body;
 const request={...scope,profileId:'pwce-agent-gateway.v1',profileVersion:'1.0.0',dispatchProfileId:dispatchBundle.dispatchProfileId,dispatchProfileVersion:dispatchBundle.dispatchProfileVersion,operation:'authority.authorizeDispatch',requestId:'synthetic-admission',correlationId:'synthetic-correlation',deadline:new Date(now+30000).toISOString(),snapshotRef:snapshot.snapshotRef,capabilityRef:'home.light.set_level',capabilityVersion:'1.0.0',capabilityOperation:'light.set_level',siteRef:'home.one',targetEntityId:'light.synthetic',parameters:{level:0.5},idempotencyKey:'synthetic-original-admission',approvalRequired:true,approvalRef:null};
 const dispatchHeaders={'x-pwce-dispatcher-token':dispatcherToken,'x-pwce-dispatch-contract':dispatchBundle.bundleDigest},headers={'x-pwce-approval-recovery-contract':bundle.bundleDigest};
 const fingerprint=actionFingerprint({...request,operation:request.capabilityOperation,principalRef:'agent.fixture',gatewayScope:{worldRef:request.worldRef,...identity}});
 const query=()=>({...structuredClone(scope),profileId:'pwce-agent-gateway.v1',profileVersion:'1.0.0',approvalProfileId:bundle.profileId,approvalProfileVersion:bundle.profileVersion,operation:'authority.recoverApproval',requestId:randomUUID(),correlationId:request.correlationId,deadline:new Date(now+30000).toISOString(),idempotencyKey:request.idempotencyKey,requestFingerprint:fingerprint,originalSnapshotRef:request.snapshotRef});
 return {baseUrl:`http://127.0.0.1:${server.address().port}`,approvals,token,path,target,store,actions,gateway,send,request,query,headers,dispatchHeaders,clock,advance:ms=>{now+=ms;},calls:()=>calls,checks:()=>checks,reconciles:()=>reconciles};
}
const cleanup=[];let checks=0;
try{
 const f=await fixture({after:fn=>cleanup.push(fn)});
 let posts=0,mutate=null;const client=new PwceGatewayClient({baseUrl:f.baseUrl,token:f.token,fetchImpl:async(url,init)=>{if(init.method==='POST'){posts++;assert.ok(String(url).endsWith('/approval-recovery'));assert.equal(init.headers['X-PWCE-Dispatcher-Token'],undefined);}const response=await fetch(url,init);if(mutate&&String(url).endsWith('/approval-recovery')){const body=await response.json();mutate(body.approvalEvidence);return Response.json(body);}return response;}});
 const read=async()=>{const {authorityContextRef,operation,profileId,profileVersion,approvalProfileId,approvalProfileVersion,...input}=f.query();return client.recoverApproval(authorityContextRef,input);};
 assert.equal((await read()).status,'unknown');checks++;
 const requested=await f.send('/dispatch',f.request,f.dispatchHeaders);assert.equal(requested.status,200,JSON.stringify(requested.body));
 const pending=(await read()).approvalEvidence;assert.equal(pending.status,'pending');assert.equal(pending.humanProof,null);assert.equal(pending.requestKey,f.request.idempotencyKey);checks++;
 const humanProof={principalRef:'human.synthetic',authenticationMethod:'password',authenticatedAt:f.clock().toISOString(),verifiedAt:f.clock().toISOString()};
 await f.approvals.approve({approvalRef:pending.approvalRef,approvedBy:humanProof.principalRef,confirmationDigest:pending.confirmationDigest,humanProof});
 const approved=(await read()).approvalEvidence;assert.equal(approved.status,'approved');assert.deepEqual(approved.humanProof,humanProof);assert.equal(approved.snapshot.snapshotJson,pending.snapshot.snapshotJson);assert.equal(approved.confirmationDigest,pending.confirmationDigest);checks++;
 f.advance(125000);const expired=(await read()).approvalEvidence;assert.deepEqual(expired,approved);assert.ok(Date.parse(expired.expiresAt)<f.clock().valueOf());checks++;
 for(const alter of [e=>e.requestKey='foreign',e=>e.requestFingerprint='foreign',e=>e.snapshot.snapshotRef=randomUUID(),e=>e.review.request.gatewayScope.worldRef='world.foreign',e=>e.review.request.gatewayScope.participantRefs.reverse(),e=>e.review.request.executionEnvironmentRef='live']){mutate=alter;await assert.rejects(read(),/original terms differ/);checks++;}mutate=null;
 const state=await f.store.load();assert.equal(Object.keys(state.approvals).length,1);assert.equal(Object.keys(state.actions).length,0);assert.equal(f.calls(),0);assert.equal(f.checks(),0);assert.equal(f.reconciles(),0);assert.equal(posts,10);checks++;
 console.log(JSON.stringify({fixture:true,liveEffects:false,checksPassed:checks,recoveryPosts:posts,targetCalls:f.calls(),scope:'Real PWCE HTTP producer with Lifestream approval recovery client; synthetic Human proof injected through producer service, no Studio or host acceptance'}));
}finally{for(const fn of cleanup.reverse())await fn();}
