import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLifestreamServer } from '../apps/server/src/index.ts';
import { loadProfile } from '../apps/server/src/config/loader.ts';
import { Database } from '../packages/storage-sqlite/src/database.ts';
import { PwceCapabilityDiscovery } from '../apps/server/src/composition/pwce-capabilities.ts';

const historicalEnabled=process.env.PWCE_HOST_HISTORICAL==='1',dispatchEnabled=process.env.PWCE_HOST_DISPATCH==='1'||historicalEnabled;
const token=randomBytes(24).toString('hex'),dispatcherToken=randomBytes(24).toString('hex');
const producer=spawn(process.execPath,['scripts/gateway-dispatch-fixture.mjs'],{cwd:resolve(process.env.PWCE_PRODUCER_ROOT??'../PWCE'),env:{PATH:process.env.PATH,PWCE_FIXTURE_TOKEN:token,PWCE_FIXTURE_DISPATCHER_TOKEN:dispatcherToken},stdio:['pipe','pipe','pipe']});
const exited=once(producer,'exit'),lines=createInterface({input:producer.stdout}),iterator=lines[Symbol.asyncIterator]();let stderr='';
producer.stderr.on('data',chunk=>{stderr+=String(chunk);if(stderr.length>8192)producer.kill('SIGTERM');});
async function line(){let timer;try{const row=await Promise.race([iterator.next(),exited.then(()=>{throw new Error('synthetic producer exited');}),new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('fixture response deadline exceeded')),10000))]);assert.equal(row.done,false);return JSON.parse(row.value);}finally{clearTimeout(timer);}}
const root=mkdtempSync(join(tmpdir(),'pwce-host-discovery-')),secret='PWCE_SYNTHETIC_HOST_'+randomBytes(8).toString('hex'),checks=[];let app,db;let expectedTargetCalls=0,dropInvocationReply=false,dropAdmissionReply=false,dropBeforeAdmission=false,dispatchPosts=0,authorityCreates=0,catalogReads=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,init={})=>{const isDispatch=String(url).endsWith('/gateway/v1/dispatch'),body=(isDispatch||String(url).endsWith('/gateway/v1/request'))?JSON.parse(String(init.body)):null;if(String(url).endsWith('/gateway/v1/authority'))authorityCreates++;if(body?.operation==='capabilities.getSnapshot')catalogReads++;if(dropBeforeAdmission&&body?.operation==='authority.authorizeDispatch'){dropBeforeAdmission=false;throw new Error('synthetic admission never reached producer');}if(isDispatch)dispatchPosts++;const response=await originalFetch(url,init);if(dropAdmissionReply&&body?.operation==='authority.authorizeDispatch'){dropAdmissionReply=false;await response.arrayBuffer();throw new Error('synthetic lost admission reply');}if(dropInvocationReply&&body?.operation==='capabilities.invoke'){dropInvocationReply=false;await response.arrayBuffer();throw new Error('synthetic lost invocation reply');}return response;};
try{
 const ready=await line();assert.equal(ready.fixture,true);assert.equal(ready.liveEffects,false);assert.equal(new URL(ready.url).hostname,'127.0.0.1');
 const config=loadProfile('test');config.authority.authentication='local-password';config.authority.provider='pwce';config.providers.world='pwce';config.providers.capability='pwce';config.secretRefs={gateway:{kind:'env',name:secret}};process.env[secret]=token;
 config.pwceProfile={endpoint:ready.url,worldRef:'world.personal.v1',executionEnvironmentRef:'test',siteRefs:['home.one'],principalRef:'agent.fixture',lifestreamEnvironmentId:randomUUID(),tokenSecretRef:'gateway',timeoutMs:5000,maximumPromptBytes:4096};config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};
 if(dispatchEnabled){config.secretRefs.dispatcher={kind:'env',name:secret+'_DISPATCHER'};process.env[secret+'_DISPATCHER']=dispatcherToken;config.pwceProfile.dispatcherTokenSecretRef='dispatcher';}
 const scopeOwner={assistantId:randomUUID(),endpointId:randomUUID(),sessionId:randomUUID(),principalId:randomUUID(),conversationId:randomUUID(),interactionTraceId:randomUUID(),revision:'synthetic-original-review',audienceKnown:true,isCurrent:()=>true};
 const scopeCall=()=>({requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:new Date(Date.now()+5000).toISOString(),executionMode:'live',signal:new AbortController().signal,isCurrent:()=>true});
 let scopeHost=new PwceCapabilityDiscovery(config.pwceProfile,token);
 try{
  const original=await scopeHost.withCatalog(scopeOwner,scopeCall(),async lease=>structuredClone(lease.record));scopeHost.close();scopeHost=new PwceCapabilityDiscovery(config.pwceProfile,token);
  const restored=await scopeHost.withCatalog(scopeOwner,scopeCall(),async lease=>lease.record,original);assert.deepEqual(restored,original);checks.push('fresh authenticated streams reattach the exact original producer scope after host closure');
  await assert.rejects(scopeHost.withCatalog({...scopeOwner,principalId:randomUUID()},scopeCall(),async()=>assert.fail('foreign owner reached original catalog'),original));
  const missing=structuredClone(original),unknown=randomUUID();missing.scope.authorityContextRef.contextId=unknown;missing.binding.authorityContextRef=unknown;
  await assert.rejects(scopeHost.withCatalog(scopeOwner,scopeCall(),async()=>assert.fail('lost authority reached original catalog'),missing));checks.push('foreign owner and missing producer authority cannot be replaced during reconnection');
 }finally{scopeHost.close();}
 const installerToken=randomBytes(24).toString('hex');app=createLifestreamServer({config,...(dispatchEnabled?{pwceActionJournal:{create:true}}:{}),localAuth:{stateDirectory:join(root,'safety'),installerToken}});await app.start();db=new Database({path:config.storage.databasePath});
 const base=`http://127.0.0.1:${app.address().port}`,headers={origin:base,'content-type':'application/json'};
 const request=async(path,body,extra={})=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
 const setup=await request('/api/auth/v1/setup',{username:'owner',password:'Synthetic-'+randomBytes(24).toString('hex'),installerToken});assert.equal(setup.status,201);headers.cookie=setup.cookie;headers['x-lifestream-csrf']=setup.body.session.csrfToken;
 const assistant=await request('/api/admin/v1/assistants',{displayName:'Synthetic PWCE host'});assert.equal(assistant.status,201);const path=`/api/authority/v1/assistants/${assistant.body.assistantId}/tools`;
 assert.equal((await request(path)).status,503);checks.push('unknown audience does not disclose scoped capabilities');
 assert.equal((await request(path,undefined,{cookie:''})).status,401);checks.push('authentication required before discovery');
 assert.equal((await request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'})).status,200);
 const discovered=await request(path);assert.equal(discovered.status,200,JSON.stringify(discovered));assert.equal(discovered.body.tools[0].capabilityId,'pwce.home.light.set-level');assert.equal(discovered.body.tools[0].authorization,'invokeDecision');assert.equal(discovered.body.tools[0].inputSchema.properties.parameters.properties.level.maximum,1);assert.equal(discovered.body.actionAdministration,'unavailable');checks.push('authenticated host discovers actual producer catalog and exact input schema');
 assert.equal((await request(path)).status,200);checks.push('fresh read uses the same current owner with active invalidation coverage');
 const prepareBody={idempotencyKey:randomUUID(),capabilityVersion:'1.0.0',input:{siteRef:'home.one',targetEntityId:'light.synthetic',parameters:{level:0.4}}};
 const prepared=await request(path+'/pwce.home.light.set-level/prepare',prepareBody);assert.equal(prepared.status,201,JSON.stringify(prepared));assert.equal(prepared.body.preparation.currentPreview.disposition,'authorized');assert.equal(prepared.body.preparation.currentPreview.authorityKind,'external');assert.equal(prepared.body.grantsAuthority,false);assert.equal(prepared.body.dispatchStarted,false);assert.equal(prepared.body.confirmationAvailable,dispatchEnabled);
 assert.equal(createHash('sha256').update(prepared.body.preparation.originalPreviewEvidence).digest('hex'),prepared.body.preparation.originalPreview.evidenceRef.sha256);checks.push('actual PWCE non-consuming preview and exact input are retained with their original proof bytes');
 const repeated=await request(path+'/pwce.home.light.set-level/prepare',prepareBody);assert.equal(repeated.status,200,JSON.stringify(repeated));assert.equal(repeated.body.preparation.invocationId,prepared.body.preparation.invocationId);assert.equal(repeated.body.preparation.confirmationDigest,prepared.body.preparation.confirmationDigest);checks.push('same preparation key retains one original review and no action claim');
 const inspected=await request(path+'/invocations/'+prepared.body.preparation.invocationId+'/preparation');assert.equal(inspected.status,200);assert.equal(inspected.body.preparation.confirmationDigest,prepared.body.preparation.confirmationDigest);
 assert.equal(db.connection.prepare('SELECT COUNT(*) AS n FROM pwce_action_preparations').get().n,1);checks.push('authenticated preparation inspection checks the original catalog and obtains a fresh preview');
 if(process.env.PLAYWRIGHT_MODULE){
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({channel:'chrome',headless:true});
  try{
   const context=await browser.newContext({viewport:{width:1440,height:900}});const split=headers.cookie.indexOf('=');await context.addCookies([{name:headers.cookie.slice(0,split),value:headers.cookie.slice(split+1),url:base,httpOnly:true,sameSite:'Strict'}]);
   const page=await context.newPage();page.setDefaultTimeout(10000);await page.goto(base+'/control/security.html');await page.waitForFunction(()=>window.lifestreamAuth?.session);
   await page.locator('#security-reload-assistants').click();await page.locator('#security-assistant').selectOption(assistant.body.assistantId);await page.getByRole('link',{name:'Capabilities & actions',exact:true}).click();
   await page.locator('#cap-refresh').click();await page.waitForFunction(()=>document.querySelector('#cap-status')?.textContent.includes('PWCE capability discovery is available'));
   await page.locator('#cap-select').selectOption('0');assert.equal(await page.locator('#cap-prepare').isEnabled(),false);assert.ok((await page.locator('#cap-arguments').textContent()).includes('Input schema'));
   assert.ok((await page.locator('#cap-status').textContent()).includes('not yet connected'));checks.push('actual Chrome exposes PWCE schema inspection with action preparation disabled');
  }finally{await browser.close();}
 }
 assert.equal((await request(path+'?scope=foreign')).status,422);assert.equal((await request(path.replace(/assistants\/[^/]+/,'assistants/'+randomUUID()))).status,403);checks.push('foreign scope and query injection rejected');
 assert.equal((await request('/api/authority/v1/grants')).status,503);assert.equal((await request(path+'/pwce.home.light.set-level/prepare',{})).status,422);checks.push('PWCE cannot fall back to local grants and invalid preparation is rejected');
 if(dispatchEnabled){
  const prepare=async()=>{const result=await request(path+'/pwce.home.light.set-level/prepare',{...prepareBody,idempotencyKey:randomUUID()});assert.equal(result.status,201,JSON.stringify(result));return result.body;};
  const confirmation=prepared=>({idempotencyKey:prepared.idempotencyKey,confirmationDigest:prepared.preparation.confirmationDigest});
  const confirmPath=prepared=>path+'/invocations/'+prepared.preparation.invocationId+'/confirm';
  const first=await prepare(),before=dispatchPosts;
  assert.equal((await request(confirmPath(first),{...confirmation(first),confirmationDigest:'0'.repeat(64)})).status,409);assert.equal(dispatchPosts,before);
  assert.equal((await request(confirmPath(first),confirmation(first),{'x-lifestream-csrf':'wrong'})).status,403);assert.equal(dispatchPosts,before);checks.push('changed review and invalid CSRF cannot send admission or invocation');
  const completed=await request(confirmPath(first),confirmation(first));assert.equal(completed.status,200,JSON.stringify(completed));assert.equal(completed.body.invocation.type,'succeeded');expectedTargetCalls++;
  const after=dispatchPosts,repeated=await request(confirmPath(first),confirmation(first));assert.equal(repeated.status,200,JSON.stringify(repeated));assert.equal(repeated.body.invocation.type,'succeeded');assert.equal(dispatchPosts,after);checks.push('authenticated exact-review confirmation admits and invokes once; retry reads original status');
  const port=app.address().port;await app.shutdown();app=createLifestreamServer({config,port,localAuth:{stateDirectory:join(root,'safety')}});await app.start();
  const restarted=await request(confirmPath(first),confirmation(first));assert.equal(restarted.status,200,JSON.stringify(restarted));assert.equal(restarted.body.invocation.type,'succeeded');assert.equal(dispatchPosts,after);checks.push('actual host restart reopens separate journal and cannot resend a completed action');
  const lostAdmission=await prepare();dropAdmissionReply=true;const missingAdmission=await request(confirmPath(lostAdmission),confirmation(lostAdmission));assert.ok(missingAdmission.status>=500,JSON.stringify(missingAdmission));assert.equal(dropAdmissionReply,false);
  const afterAdmission=dispatchPosts,resumed=await request(confirmPath(lostAdmission),confirmation(lostAdmission));assert.equal(resumed.status,200,JSON.stringify(resumed));assert.equal(resumed.body.invocation.type,'succeeded');assert.equal(dispatchPosts,afterAdmission+1);expectedTargetCalls++;checks.push('lost admission reply recovers original producer admission before one invocation');
  const lost=await prepare();dropInvocationReply=true;const missing=await request(confirmPath(lost),confirmation(lost));assert.ok(missing.status>=500,JSON.stringify(missing));assert.equal(dropInvocationReply,false);expectedTargetCalls++;
  const afterLost=dispatchPosts,recovered=await request(confirmPath(lost),confirmation(lost));assert.equal(recovered.status,200,JSON.stringify(recovered));assert.equal(recovered.body.invocation.type,'succeeded');assert.equal(dispatchPosts,afterLost);checks.push('lost actual producer invocation reply recovers through original status without another dispatch POST');
  const concurrent=await prepare(),beforeConcurrent=dispatchPosts,twice=await Promise.all([request(confirmPath(concurrent),confirmation(concurrent)),request(confirmPath(concurrent),confirmation(concurrent))]);
  assert.ok(twice.some(r=>r.status===200),JSON.stringify(twice));assert.ok(twice.every(r=>r.status===200||r.status>=400));assert.equal(dispatchPosts,beforeConcurrent+2);expectedTargetCalls++;
  const afterConcurrent=await request(confirmPath(concurrent),confirmation(concurrent));assert.equal(afterConcurrent.status,200,JSON.stringify(afterConcurrent));assert.equal(dispatchPosts,beforeConcurrent+2);checks.push('concurrent confirmation retains one admission and one invocation; later retry only reconciles');
  if(historicalEnabled){
   const unresolved=await prepare(),beforeUnresolved=dispatchPosts;dropBeforeAdmission=true;const notSent=await request(confirmPath(unresolved),confirmation(unresolved));assert.ok(notSent.status>=500);assert.equal(dropBeforeAdmission,false);assert.equal(dispatchPosts,beforeUnresolved);
   const unknownStatusPath=path+'/invocations/'+unresolved.preparation.invocationId+'/status',unknown=await request(unknownStatusPath);assert.equal(unknown.status,200,JSON.stringify(unknown));assert.equal(unknown.body.state,'outcomeUnknown');assert.equal(dispatchPosts,beforeUnresolved);checks.push('unresolved original admission stays unknown without any resend');
   const readsBefore={authorityCreates,catalogReads};
   const statusPath=path+'/invocations/'+first.preparation.invocationId+'/status';
   const currentStatus=await request(statusPath);assert.equal(currentStatus.status,200,JSON.stringify(currentStatus));assert.equal(currentStatus.body.invocation.type,'succeeded');assert.equal(dispatchPosts,beforeConcurrent+2);
   while(Date.now()<=Date.parse(first.preparation.expiresAt))await new Promise(resolve=>setTimeout(resolve,Math.min(30000,Date.parse(first.preparation.expiresAt)-Date.now()+25)));
   const expiredConfirm=await request(confirmPath(first),confirmation(first));assert.equal(expiredConfirm.status,409,JSON.stringify(expiredConfirm));assert.equal(dispatchPosts,beforeConcurrent+2);
   const historical=await request(statusPath);assert.equal(historical.status,200,JSON.stringify(historical));assert.equal(historical.body.readOnly,true);assert.equal(historical.body.invocation.type,'succeeded');assert.equal(createHash('sha256').update(historical.body.invocationEvidence).digest('hex'),historical.body.invocation.evidenceRef.sha256);assert.equal(createHash('sha256').update(historical.body.admissionEvidence).digest('hex'),historical.body.admission.evidenceRef.sha256);checks.push('actual review expiry prevents confirmation but preserves read-only original invocation and evidence');
   const noDispatcher=structuredClone(config);delete noDispatcher.pwceProfile.dispatcherTokenSecretRef;delete process.env[secret+'_DISPATCHER'];const statusPort=app.address().port;await app.shutdown();app=createLifestreamServer({config:noDispatcher,port:statusPort,pwceActionJournal:{create:false},localAuth:{stateDirectory:join(root,'safety')}});await app.start();
   const reopenedStatus=await request(statusPath);assert.equal(reopenedStatus.status,200,JSON.stringify(reopenedStatus));assert.equal(reopenedStatus.body.invocation.type,'succeeded');assert.equal(dispatchPosts,beforeConcurrent+2);checks.push('status survives restart with retained journal and no dispatcher configuration or credential');
   assert.equal((await request(statusPath+'?replace=true')).status,422);assert.equal((await request(statusPath,{})).status,405);assert.equal((await request(statusPath.replace(/assistants\/[^/]+/,'assistants/'+randomUUID()))).status,403);checks.push('historical status rejects scope injection, mutations and foreign Assistant access');const stillUnknown=await request(unknownStatusPath);assert.equal(stillUnknown.status,200,JSON.stringify(stillUnknown));assert.equal(stillUnknown.body.state,'outcomeUnknown');assert.equal(dispatchPosts,beforeConcurrent+2);assert.deepEqual({authorityCreates,catalogReads},readsBefore);checks.push('historical reads and credential-free restart never create authority or refresh a catalog');
  }
  const fenced=await prepare(),beforeFence=dispatchPosts;app.pwceJournal.close();const rejected=historicalEnabled?await request(path+'/invocations/'+first.preparation.invocationId+'/status'):await request(confirmPath(fenced),confirmation(fenced));assert.ok(rejected.status>=500,JSON.stringify(rejected));assert.equal(dispatchPosts,beforeFence);checks.push(historicalEnabled?'unavailable journal withholds historical status and evidence':'unavailable durable journal prevents any admission or invocation POST');

 }
 producer.stdin.write('revoke\n');const revoked=await line();assert.equal(revoked.revoked,true);
 const after=await request(path);assert.ok(after.status===503||after.status===200&&after.body.tools.length===0,JSON.stringify(after));checks.push('producer revocation cannot return an earlier available capability');
 await request('/api/runtime/v1/session-context',{expectedRevision:1,mode:'text',audienceScope:'unknown'});assert.equal((await request(path)).status,503);checks.push('audience withdrawal removes discovery eligibility');
 await request('/api/auth/v1/sign-out',{});assert.equal((await request(path)).status,401);checks.push('logout removes access');
 producer.stdin.write('stats\n');const stats=await line();assert.equal(stats.fixtureStats,true);assert.equal(stats.calls,expectedTargetCalls);
 for(const table of ['canonical_grants','pwce_admission_custody','pwce_invocation_custody'])assert.equal(db.connection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,0);checks.push(dispatchEnabled?'ordinary database holds no action custody; effects match exact confirmed attempts':'zero action calls, grants, admission custody or invocation claims');
 console.log(JSON.stringify({fixtures:true,liveEffects:false,casesPassed:checks.length,targetCalls:expectedTargetCalls,dispatchPosts,checks,scope:historicalEnabled?'authenticated historical status after actual review expiry and credential-free restart; no new execution authority':dispatchEnabled?'authenticated HTTP confirmation, admission, invocation and retry/restart recovery against actual isolated PWCE; synthetic effects only, no saved configuration activation':'authenticated Lifestream HTTP discovery against a separate actual PWCE process; non-consuming preparations only; no saved configuration or action dispatch activation'}));
}finally{
 if(app)await app.shutdown();db?.close();delete process.env[secret];delete process.env[secret+'_DISPATCHER'];globalThis.fetch=originalFetch;lines.close();producer.kill('SIGTERM');await exited;rmSync(root,{recursive:true,force:true});
}
