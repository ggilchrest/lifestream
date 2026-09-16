import {createLifestreamServer} from '../apps/server/src/index.ts';
import {loadProfile} from '../apps/server/src/config/loader.ts';
import {PwceActionJournal} from '../apps/server/src/authority/pwce-action-journal.ts';
import {verifyPwceApprovalEvidence} from '../packages/providers-pwce/src/approval-evidence.ts';
import {canonicalJson} from '../packages/runtime/src/capabilities/schema-validation.ts';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
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
 const clock=()=>new Date(),token='synthetic-recovery-agent',dispatcherToken='synthetic-recovery-trusted-dispatcher-token';
 const dir=persistent?await mkdtemp(join(tmpdir(),'pwce-admission-recovery-')):null,path=dir?join(dir,'state.json'):null;
 if(dir)t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new StateStore(path?{path}:{state:emptyState()});
 const target={identity:'synthetic.recovery-proof',async checkPreconditions(){checks++;return {allowed:true,observed:{synthetic:true},reasonCode:'synthetic_ready'};},async invoke(){calls++;return {status:unknown?'outcome_unknown':'succeeded',externalEffectOccurred:unknown?'unknown':true};},async getInvocation(){reconciles++;return {status:'succeeded',externalEffectOccurred:true};}};
 const approvals=new ApprovalService({store,clock});const actions=new ActionService({store,target,clock,approvalService:approvals,liveEffectsEnabled:true});actions.registerGrant({principalRef:'agent.fixture',siteRefs:['home.one'],capabilityRefs:['home.light.set_level']});
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
 return {dispatcherToken,snapshot,scope,baseUrl:`http://127.0.0.1:${server.address().port}`,approvals,token,path,target,store,actions,gateway,send,request,query,headers,dispatchHeaders,clock,advance:ms=>{now+=ms;},calls:()=>calls,checks:()=>checks,reconciles:()=>reconciles};
}
const resumeEnabled=process.env.PWCE_HOST_APPROVAL_RESUME==='1';
const cleanup=[],secret='PWCE_APPROVAL_HOST_'+randomBytes(8).toString('hex');let app,checks=0,posts=0,drop=false,before=false,uiPosts=0,uiTargets=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,init={})=>{const dispatch=String(url).endsWith('/gateway/v1/dispatch');if(dispatch&&before){before=false;throw new Error('synthetic approval never reached producer');}if(dispatch)posts++;const response=await originalFetch(url,init);if(dispatch&&drop){drop=false;await response.arrayBuffer();throw new Error('synthetic lost approval reply');}return response;};
try{
 const f=await fixture({after:fn=>cleanup.push(fn)}),root=await mkdtemp(join(tmpdir(),'pwce-host-approval-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const config=loadProfile('test');config.authority.authentication='local-password';config.authority.provider='pwce';config.providers.world='pwce';config.providers.capability='pwce';config.secretRefs={gateway:{kind:'env',name:secret},dispatcher:{kind:'env',name:secret+'_DISPATCHER'}};process.env[secret]=f.token;process.env[secret+'_DISPATCHER']=f.dispatcherToken;
 config.pwceProfile={endpoint:f.baseUrl,worldRef:'world.personal.v1',executionEnvironmentRef:'live',siteRefs:['home.one'],principalRef:'agent.fixture',lifestreamEnvironmentId:randomUUID(),tokenSecretRef:'gateway',dispatcherTokenSecretRef:'dispatcher',timeoutMs:5000,maximumPromptBytes:4096};config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=randomBytes(24).toString('hex'),auth={stateDirectory:join(root,'safety'),installerToken};app=createLifestreamServer({config,pwceActionJournal:{create:true},localAuth:auth});await app.start();
 let base=`http://127.0.0.1:${app.address().port}`;const headers={origin:base,'content-type':'application/json'};
 const request=async(path,body,extra={})=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
 const setup=await request('/api/auth/v1/setup',{username:'owner',password:'Synthetic-'+randomBytes(24).toString('hex'),installerToken});assert.equal(setup.status,201);headers.cookie=setup.cookie;headers['x-lifestream-csrf']=setup.body.session.csrfToken;
 const assistant=await request('/api/admin/v1/assistants',{displayName:'Synthetic approval host'});assert.equal(assistant.status,201);assert.equal((await request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'})).status,200);
 const path=`/api/authority/v1/assistants/${assistant.body.assistantId}/tools`;
 const prepare=async()=>{const result=await request(path+'/pwce.home.light.set-level/prepare',{idempotencyKey:randomUUID(),capabilityVersion:'1.0.0',input:{siteRef:'home.one',targetEntityId:'light.synthetic',parameters:{level:0.4}}});assert.equal(result.status,201,JSON.stringify(result));assert.equal(result.body.preparation.currentPreview.disposition,'approvalRequired');return result.body;};
 const p=await prepare(),item=path+'/invocations/'+p.preparation.invocationId,body={idempotencyKey:p.idempotencyKey,confirmationDigest:p.preparation.confirmationDigest};checks++;
 assert.equal((await request(item+'/request-approval',body,{cookie:''})).status,401);assert.equal((await request(item+'/request-approval',body,{'x-lifestream-csrf':'bad'})).status,403);assert.equal((await request(item+'/request-approval',{...body,approvalRef:'forged'})).status,422);assert.equal(posts,0);checks++;
 assert.equal((await request(item+'/request-approval')).status,405);assert.equal((await request(item+'/request-approval?override=true',body)).status,422);assert.equal((await request(item+'/request-approval',{...body,confirmationDigest:'0'.repeat(64)})).status,409);assert.equal((await request(item.replace(/assistants\/[^/]+/,'assistants/'+randomUUID())+'/request-approval',body)).status,403);assert.equal(posts,0);checks++;
 const pending=await request(item+'/request-approval',body);assert.equal(pending.status,200,JSON.stringify(pending));assert.equal(pending.body.state,'pending');assert.equal(pending.body.dispatchStarted,false);assert.equal(posts,1);checks++;
 const repeat=await request(item+'/request-approval',body);assert.equal(repeat.status,200,JSON.stringify(repeat));assert.equal(repeat.body.approval.approvalRef,pending.body.approval.approvalRef);assert.equal(posts,1);checks++;
 assert.equal((await request(item+'/confirm',body)).status,409);assert.equal((await request(item+'/review-approval',body)).status,409);assert.equal(posts,1);checks++;
 const lost=await prepare(),lostItem=path+'/invocations/'+lost.preparation.invocationId,lostBody={idempotencyKey:lost.idempotencyKey,confirmationDigest:lost.preparation.confirmationDigest};drop=true;assert.notEqual((await request(lostItem+'/request-approval',lostBody)).status,200);assert.equal(posts,2);
 const recovered=await request(lostItem+'/status');assert.equal(recovered.status,200,JSON.stringify(recovered));assert.equal(recovered.body.approval.state,'pending');assert.equal(posts,2);checks++;
 const unknown=await prepare(),unknownItem=path+'/invocations/'+unknown.preparation.invocationId,unknownBody={idempotencyKey:unknown.idempotencyKey,confirmationDigest:unknown.preparation.confirmationDigest};before=true;assert.notEqual((await request(unknownItem+'/request-approval',unknownBody)).status,200);const unknownRead=await request(unknownItem+'/status');assert.equal(unknownRead.status,200,JSON.stringify(unknownRead));assert.equal(unknownRead.body.approval.state,'outcomeUnknown');assert.equal((await request(unknownItem+'/request-approval',unknownBody)).body.state,'outcomeUnknown');assert.equal(posts,2);checks++;
 const proof=pending.body.approval,now=f.clock().toISOString();await f.approvals.approve({approvalRef:proof.approvalRef,approvedBy:'human.synthetic',confirmationDigest:proof.confirmationDigest,humanProof:{principalRef:'human.synthetic',authenticationMethod:'password',authenticatedAt:now,verifiedAt:now}});
 const approved=await request(item+'/status');assert.equal(approved.status,200,JSON.stringify(approved));assert.equal(approved.body.approval.state,'approved');assert.equal(posts,2);checks++;
 if(resumeEnabled){
  const reviewed=await request(item+'/review-approval',body);assert.equal(reviewed.status,200,JSON.stringify(reviewed));assert.equal(reviewed.body.grantsAuthority,false);assert.equal(reviewed.body.dispatchStarted,false);assert.equal(posts,2);checks++;
  const resumeBody={...body,approvalReviewDigest:reviewed.body.approvalReviewDigest};assert.equal((await request(item+'/resume-approved',{...resumeBody,approvalReviewDigest:'0'.repeat(64)})).status,409);assert.equal(posts,2);checks++;
  drop=true;const lostAdmission=await request(item+'/resume-approved',resumeBody);assert.notEqual(lostAdmission.status,200);assert.equal(posts,3);assert.equal(f.calls(),0);
  const resumed=await request(item+'/resume-approved',resumeBody);assert.equal(resumed.status,200,JSON.stringify(resumed));assert.equal(resumed.body.invocation.type,'succeeded');assert.equal(posts,4);assert.equal(f.calls(),1);checks++;
  const again=await request(item+'/resume-approved',resumeBody);assert.equal(again.status,200,JSON.stringify(again));assert.equal(again.body.invocation.type,'succeeded');assert.equal(posts,4);assert.equal(f.calls(),1);checks++;
  if(process.env.PWCE_HOST_APPROVAL_EXPIRY==='1'){
   const until=Math.max(Date.parse(reviewed.body.expiresAt),Date.parse(reviewed.body.approval.expiresAt))+25;
   while(Date.now()<until)await new Promise(resolve=>setTimeout(resolve,Math.min(30000,until-Date.now())));
   assert.equal((await request(item+'/resume-approved',resumeBody)).status,409);const historical=await request(item+'/status');assert.equal(historical.status,200,JSON.stringify(historical));assert.equal(historical.body.invocation.type,'succeeded');assert.equal(posts,4);assert.equal(f.calls(),1);checks++;
  }

 }
 if(process.env.PWCE_HOST_UI==='1'){
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({channel:'chrome',headless:true});
  try{
   const context=await browser.newContext({viewport:{width:1440,height:1000}}),split=headers.cookie.indexOf('=');await context.addCookies([{name:headers.cookie.slice(0,split),value:headers.cookie.slice(split+1),url:base,httpOnly:true,sameSite:'Strict'}]);const page=await context.newPage();page.setDefaultTimeout(10000);
   const enter=async()=>{await page.goto(base+'/control/security.html');await page.waitForFunction(()=>window.lifestreamAuth?.session);await page.locator('#security-reload-assistants').click();await page.locator('#security-assistant').selectOption(assistant.body.assistantId);if(!await page.getByRole('link',{name:'Capabilities & actions',exact:true}).isVisible())await page.getByText('Navigate permissions',{exact:true}).click();await page.getByRole('link',{name:'Capabilities & actions',exact:true}).click();await page.locator('#cap-refresh').click();await page.waitForFunction(()=>document.querySelector('#cap-select')?.options.length>1);};
   await enter();await page.locator('#cap-select').selectOption('0');await page.locator('[data-argument=siteRef]').fill('home.one');await page.locator('[data-argument=targetEntityId]').fill('light.browser');await page.locator('[data-argument=level]').fill('0.3');await page.locator('#cap-prepare').click();await page.getByRole('heading',{name:'2. Review the exact action',exact:true}).waitFor();
   assert.equal(await page.getByRole('button',{name:'Request PWCE approval',exact:true}).isDisabled(),true);assert.ok((await page.locator('#cap-pwce-workflow').textContent()).includes('light.browser'));checks++;
   if(process.env.PWCE_UI_CAPTURE_DIR){await page.screenshot({path:join(process.env.PWCE_UI_CAPTURE_DIR,'pwce-review-desktop.png'),fullPage:true});}
   await page.locator('#cap-pwce-workflow input[type=checkbox]').check();await page.getByRole('button',{name:'Request PWCE approval',exact:true}).click();await page.getByRole('heading',{name:'3. Original action status',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('#cap-pwce-workflow')?.textContent.includes('PWCE Studio'));uiPosts++;
   await enter();await page.locator('#cap-pwce-recent summary').click();await page.getByRole('button',{name:'Open original action',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#cap-pwce-workflow')?.textContent.includes('PWCE Studio'));assert.equal(f.calls(),resumeEnabled?1:0);checks++;
   const proof=Object.values((await f.store.load()).approvals).find(a=>a.gatewayReview.request.targetEntityId==='light.browser');assert.ok(proof);const now=f.clock().toISOString();await f.approvals.approve({approvalRef:proof.approvalRef,approvedBy:'human.synthetic',confirmationDigest:proof.confirmationDigest,humanProof:{principalRef:'human.synthetic',authenticationMethod:'password',authenticatedAt:now,verifiedAt:now}});
   await page.getByRole('button',{name:'Check original result',exact:true}).click();await page.getByRole('button',{name:'Review approved action',exact:true}).click();await page.getByRole('heading',{name:'3. Review approved action',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Run approved action',exact:true}).isDisabled(),true);checks++;
   for(const width of [390,320]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);if(process.env.PWCE_UI_CAPTURE_DIR)await page.screenshot({path:join(process.env.PWCE_UI_CAPTURE_DIR,`pwce-approved-${width}.png`),fullPage:true});}checks++;
   await page.route('**/resume-approved',async route=>{await route.fetch();await route.abort('failed');});
   await page.locator('#cap-pwce-workflow input[type=checkbox]').focus();await page.keyboard.press('Space');await page.keyboard.press('Tab');assert.equal(await page.getByRole('button',{name:'Run approved action',exact:true}).evaluate(node=>node===document.activeElement),true);await page.keyboard.press('Enter');await page.getByRole('heading',{name:'3. Check the original attempt',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Run approved action',exact:true}).count(),0);await page.getByRole('button',{name:'Check original result',exact:true}).click();await page.locator('#cap-pwce-workflow').getByText('succeeded',{exact:true}).waitFor();checks++;uiPosts+=2;uiTargets++;checks++;
   await enter();await page.locator('#cap-pwce-recent summary').click();await page.getByRole('button',{name:'Open original action',exact:true}).click();await page.locator('#cap-pwce-workflow').getByText('succeeded',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Run approved action',exact:true}).count(),0);checks++;
   await page.locator('#security-assistant').selectOption('');assert.equal(await page.locator('#cap-pwce-workflow').isHidden(),true);checks++;
  }finally{await browser.close();}
 }
 const port=app.address().port;await app.shutdown();const restart=structuredClone(config);delete restart.pwceProfile.dispatcherTokenSecretRef;delete restart.secretRefs.dispatcher;app=createLifestreamServer({config:restart,port,pwceActionJournal:{create:false},localAuth:auth});await app.start();base=`http://127.0.0.1:${app.address().port}`;headers.origin=base;
 const reopened=await request(item+'/status');assert.equal(reopened.status,200,JSON.stringify(reopened));if(resumeEnabled)assert.equal(reopened.body.invocation.type,'succeeded');else assert.equal(reopened.body.approval.state,'approved');assert.equal(posts,(resumeEnabled?4:2)+uiPosts);checks++;
 assert.equal(f.calls(),(resumeEnabled?1:0)+uiTargets);const state=await f.store.load();assert.equal(Object.keys(state.actions).length,(resumeEnabled?1:0)+uiTargets);assert.equal(Object.keys(state.approvals).length,2+(uiTargets?1:0));checks++;
 console.log(JSON.stringify({fixture:true,physicalEffects:false,checksPassed:checks,dispatchPosts:posts,resumeEnabled,targetCalls:f.calls(),scope:'Authenticated actual host HTTP approval request, lost-reply recovery and credential-free status after restart; synthetic PWCE target and Human proof; exact reviewed resume when enabled; Studio acceptance not claimed'}));
}finally{await app?.shutdown();for(const fn of cleanup.reverse())await fn();delete process.env[secret];delete process.env[secret+'_DISPATCHER'];globalThis.fetch=originalFetch;}
