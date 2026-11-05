import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {createDedicatedCtJobCore,validateDedicatedCtSelection} from '../dedicated-ct-job.mjs';

const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const jobId='c9d9b828-542e-4c3a-8c34-2ed070b3cb6a';
const sessionId='3be38958-982a-47fb-ae0f-4438b6947e65';
const requestId='1d31b29a-930b-48b1-aeda-d5e60beea745';
const nativeId='673405ee-7115-41fe-96a7-d1688931de3f';
const png=sha('synthetic PNG identity'),scene=sha('synthetic reviewed scene');
function fixture(options={}){
 let wall=Date.now(),started=false,approved=false,bridge,acceptBrowser,armed=false;const calls=[],publications=new Map(),reviews=new Map(),consumed=new Set();
 const configuration={sessionProfile:'supervised8',inferenceMode:'supervisedForeground',maximumRunMs:90000,campaign:{bounds:{actionBudget:8,modelCallBudget:8}}};
 const configurationBytes=Buffer.from(JSON.stringify(configuration));
 const selection={schemaVersion:'canonical-dedicated-ct-job/1',enabled:true,jobId,nonce:'a'.repeat(32),sessionId,jobRoot:`/srv/lifestream/workspace/runtime-state/ct-owner-job-${jobId}`,metadataDirectory:`/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-${jobId}`,configurationSha256:sha(configurationBytes.toString()),expiresAt:new Date(wall+90000).toISOString()};
 if(options.browser){selection.schemaVersion='canonical-dedicated-ct-job/2';delete selection.sessionId;selection.ownerBinding='originalBrowserRequest';}
 const input={selection,configuration,configurationBytes,evidenceOwner:{request(){},response(){}}};
 const owner={scope:{runId:jobId,sessionId:'TEST-secret-selector',ownerPermissionRef:'TEST-secret-permission'},
  reviewPermission:()=>{calls.push('permission');return {requestId,revision:1,confirmationDigest:sha('permission'),expiresAt:new Date(wall+80000).toISOString(),grantExpiresAt:new Date(wall+80000).toISOString(),requestedClass:'allowSession',reviewAfter:null,scope:{sessionId:'TEST-secret-selector'}};},
  reviewNative:()=>{calls.push('native-review');return {requestId:nativeId,revision:1,confirmationDigest:sha('native challenge'),expiresAt:new Date(wall+80000).toISOString(),scope:{sessionId:'TEST-secret-selector'}};},
  authority:async(method,url,body)=>{calls.push(['authority',method,url,body]);return {status:options.authorityDenied?403:200};},
  approveNative:body=>{calls.push(['native-approval',body]);},
  start:body=>{calls.push(['start',body]);started=true;},
  status:()=>{calls.push('status');return {state:approved?'stopped':'running',frameQualification:'waitingForHuman'};},
  reviewFrame:()=>{calls.push('frame-review');return {requestId,confirmationDigest:sha('frame challenge'),pngSha256:png,frameNumber:84569,sceneProfile:{manifestDigest:scene}};},
  approveFrame:body=>{calls.push(['frame-approval',body]);approved=true;},
  close:async()=>{calls.push('owner-close');if(options.cleanup)await options.cleanup;}
 };
 const app={registerDedicatedCtBrowserOwner:()=>{if(options.registerDenied)throw Error('TEST-register-refused');calls.push('register');let resolve,reject;const pending=new Promise((yes,no)=>{resolve=yes;reject=no;});void pending.catch(()=>{});let closing;acceptBrowser=()=>resolve(owner);bridge={arm(){armed=true;calls.push('arm');if(!options.deferBrowser)resolve(owner);},owner:()=>pending,close(){if(closing)return closing;reject(Error('TEST-closed'));return closing=owner.close();}};return bridge;},openDedicatedCtHostSession:(...args)=>{calls.push(['open',...args]);if(options.browser)assert.fail('New browser job cannot resolve a session selector');if(options.authDenied)throw Object.assign(Error('NEVER_EXPORT_PRIVATE_AUTH_BODY'),{code:'local_context_locked'});return owner;},shutdown:()=>{throw Error('Daily shutdown must never occur');}};
 const ports={now:()=>wall,
  publish:async(name,value)=>{const row={path:name,sha256:sha(JSON.stringify(value)+'\n')};publications.set(name,{...row,value});return row;},
  sleep:async()=>{wall+=100;if(options.expire)wall+=90000;},
  claim:async()=>{calls.push('claim');if(options.alreadyClaimed)throw Object.assign(Error('private irrelevant'),{code:'eexist'});},
  consumeDispatch:async stage=>{assert(!consumed.has(stage));consumed.add(stage);},
  readReview:async(name,pin)=>{const review=reviews.get(name);assert.equal(sha(review),pin);return structuredClone(review);},
  waitDispatch:async stage=>{
   calls.push(['worker-gate',stage]);
   if(options.denyStage===stage)throw Object.assign(Error('PRIVATE_GATE_ERROR'),{code:'ct_job_dispatch_deadline'});
   const pub=publications.get(stage==='owner'?'registered':stage==='start'?'staged-owner':stage).value;
   const publication=publications.get(stage==='owner'?'registered':stage==='start'?'staged-owner':stage);
   const reviewReferences=['main','independent'].map(role=>{
    const image=stage.startsWith('frame-')?{inspected:true,reviewerKind:options.kindByRole?.[role]??options.reviewerKind??'AGENT',screenshotSha256:png,frameNumber:84569,sceneProfileDigest:scene}:null;
    if(options.fakeAutomatic&&image)image.reviewerKind='AUTOMATIC';
    if(options.wrongHumanImage&&image)image.screenshotSha256=sha('wrong');
    const review={schemaVersion:'ct52-staged-review/2',jobId,stage,role,status:'PASS',selectionDigest:pub.selectionDigest,configurationSha256:selection.configurationSha256,publicationDigest:publication.sha256,imageReview:image};
    options.mutateReview?.(review,role,stage);
    const name=`review-${stage}-${role}.json`;reviews.set(name,review);return {name,sha256:sha(review),role};
   });
   const payload=stage==='owner'?{prepareOwner:true}:stage==='start'?{authorityBody:{expectedRevision:1},nativeBody:{requestId:nativeId,expectedRevision:1,confirmationDigest:sha('native challenge'),launchOwnedNative:true,memoryOnlyPairing:true},consent:{observations:true,campaignJournal:true,controllerInput:true,sharedInference:true}}:{frameBody:{requestId,confirmationDigest:sha('frame challenge'),ordinaryGameplay:true,noProtectedMenus:true},screenshotSha256:png,frameNumber:84569,sceneProfileDigest:scene};
   const result={schemaVersion:'ct52-worker-dispatch/1',jobId,nonce:selection.nonce,stage,selectionDigest:pub.selectionDigest,configurationSha256:selection.configurationSha256,publicationDigest:publication.sha256,expiresAt:selection.expiresAt,reviewReferences,payload};
   options.mutate?.(result,stage);return result;
  }
 };
 return {app,input,ports,calls,publications,owner,started:()=>started,acceptBrowser:()=>acceptBrowser(),armed:()=>armed};
}


// Actual job core, synthetic dispatch/owner/IO ports; no auth/native/provider.
const tick=()=>new Promise(r=>setImmediate(r));
test('legacy exact-session schema remains unchanged',async()=>{const f=fixture();await createDedicatedCtJobCore(f.app,f.input,f.ports).completion;assert(f.publications.has('terminal'));assert.equal(f.calls.at(-1),'owner-close');});
test('browser /2 binds only after two owner reviews, dispatch and claim; safe summaries retain complete approval inputs',async()=>{const f=fixture({browser:true});await createDedicatedCtJobCore(f.app,f.input,f.ports).completion;assert(f.publications.has('terminal'));assert(f.calls.indexOf('claim')<f.calls.indexOf('arm'));assert(!f.calls.some(c=>Array.isArray(c)&&c[0]==='open'));const pub=f.publications.get('staged-owner').value;assert.deepEqual(Object.keys(pub.permission).sort(),['requestId','revision','confirmationDigest','expiresAt','grantExpiresAt','requestedClass','reviewAfter'].sort());assert.equal(pub.permission.reviewAfter,null);assert.deepEqual(Object.keys(pub.native).sort(),['requestId','revision','confirmationDigest','expiresAt'].sort());for(const p of f.publications.values()){assert(!JSON.stringify(p).includes('TEST-secret'));assert(!Object.hasOwn(p.value,'scope'));}assert.equal(f.calls.filter(c=>c==='owner-close').length,1);});
for(const mutate of [s=>s.sessionId=sessionId,s=>delete s.ownerBinding,s=>s.ownerBinding='latest',s=>s.schemaVersion='canonical-dedicated-ct-job/3'])test('closed browser selection refuses identity selectors and ambiguous modes '+mutate,()=>{const f=fixture({browser:true});mutate(f.input.selection);assert.throws(()=>createDedicatedCtJobCore(f.app,f.input,f.ports));assert(!f.calls.includes('register'));});
test('denied owner review never arms or opens browser owner',async()=>{const f=fixture({browser:true,denyStage:'owner'});await createDedicatedCtJobCore(f.app,f.input,f.ports).completion;assert(!f.armed());assert(f.publications.has('failure'));});
test('external close and completion await same deferred owner cleanup exactly once',async()=>{let release;const cleanup=new Promise(r=>release=r),f=fixture({browser:true,deferBrowser:true,cleanup}),core=createDedicatedCtJobCore(f.app,f.input,f.ports);await tick();assert(f.armed());const first=core.close();assert.equal(core.close(),first);let settled=false;core.completion.then(()=>settled=true);await tick();assert.equal(settled,false);assert.equal(f.calls.filter(c=>c==='owner-close').length,1);release();await first;await core.completion;assert.equal(settled,true);});
test('registration refusal returns no core and releases its own deadline timer',()=>{const f=fixture({browser:true,registerDenied:true});const timers=process.getActiveResourcesInfo().filter(x=>x==='Timeout').length;assert.throws(()=>createDedicatedCtJobCore(f.app,f.input,f.ports),/TEST-register-refused/);assert.equal(process.getActiveResourcesInfo().filter(x=>x==='Timeout').length,timers);});

test('actual original native review producer supplies unchanged safe summary and approval ABI without launch',async()=>{
 const {readFileSync}=await import('node:fs'),{stripTypeScriptTypes}=await import('node:module'),{compileFunction}=await import('node:vm'),crypto=await import('node:crypto'),{isDeepStrictEqual}=await import('node:util');
 const source=readFileSync(new URL(import.meta.resolve('../../../apps/server/src/runtime/ubuntu-native-approval.ts')),'utf8');
 const selected=stripTypeScriptTypes(source.replace(/^import .*\n/gm,'').replace('export function createUbuntuNativeApproval','function createUbuntuNativeApproval'))+'\nreturn createUbuntuNativeApproval;';
 // Original COMPLETE producer; ONLY declared facts/plan IO and unused take ports
 // are synthetic. No actual native facts, filesystem, pairing, entropy or launch.
 const facts={expiresAt:new Date(Date.now()+60000).toISOString(),approvalRef:'TEST-native',pairing:{approvalRef:'TEST-pair'},image:'TEST-fixture-only',continuation:{},sources:{},imagePins:{}};
 class GameHostError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
 const create=compileFunction(selected,['createHash','randomBytes','randomUUID','isDeepStrictEqual','canonicalJson','readC72NativeConfiguration','c72NativePlan','scopeDigest','createRunScopedNativePairing','GameHostError'])(crypto.createHash,()=>assert.fail('No entropy'),crypto.randomUUID,isDeepStrictEqual,JSON.stringify,()=>facts,()=>({mounts:[]}),sha,()=>assert.fail('No native pairing'),GameHostError);
 const scope={principalId:jobId,assistantId:sessionId,contextBinding:{sessionId:'TEST-secret-selector',ownerPermissionRef:'TEST-secret-permission'}},actor={principalId:jobId,sessionId:'TEST-secret-selector',isCurrent:()=>true},context={assertCurrent(){}};
 const native=create({scope,pinsDigest:sha('TEST-pins'),configurationFile:'TEST-in-memory-port-only',startCurrent:()=>false});
 try{const pending=native.review(actor,context),runner=readFileSync(new URL('../dedicated-ct-job.mjs',import.meta.url),'utf8'),body=runner.slice(runner.indexOf(' const approvalSummary=value=>{'),runner.indexOf(' const frameSummary='));const safe=compileFunction(body+'return approvalSummary;',['uuid','hash','fail'])(x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x),x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),code=>{throw Error(code);})(pending);assert.deepEqual(Object.keys(safe).sort(),['requestId','revision','confirmationDigest','expiresAt'].sort());assert(!JSON.stringify(safe).includes('TEST-secret'));assert.equal(native.approve(actor,{requestId:safe.requestId,expectedRevision:safe.revision,confirmationDigest:safe.confirmationDigest,launchOwnedNative:true,memoryOnlyPairing:true},context).state,'approved');assert.equal(native.status(actor).state,'approved');}finally{native.close();}
});
