import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLifestreamServer } from '../apps/server/src/index.ts';
import { loadProfile } from '../apps/server/src/config/loader.ts';
import { Database } from '../packages/storage-sqlite/src/database.ts';
import { PwceCapabilityDiscovery } from '../apps/server/src/composition/pwce-capabilities.ts';

const token=randomBytes(24).toString('hex'),dispatcherToken=randomBytes(24).toString('hex');
const producer=spawn(process.execPath,['scripts/gateway-dispatch-fixture.mjs'],{cwd:resolve(process.env.PWCE_PRODUCER_ROOT??'../PWCE'),env:{PATH:process.env.PATH,PWCE_FIXTURE_TOKEN:token,PWCE_FIXTURE_DISPATCHER_TOKEN:dispatcherToken},stdio:['pipe','pipe','pipe']});
const exited=once(producer,'exit'),lines=createInterface({input:producer.stdout}),iterator=lines[Symbol.asyncIterator]();let stderr='';
producer.stderr.on('data',chunk=>{stderr+=String(chunk);if(stderr.length>8192)producer.kill('SIGTERM');});
async function line(){let timer;try{const row=await Promise.race([iterator.next(),exited.then(()=>{throw new Error('synthetic producer exited');}),new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('fixture response deadline exceeded')),10000))]);assert.equal(row.done,false);return JSON.parse(row.value);}finally{clearTimeout(timer);}}
const root=mkdtempSync(join(tmpdir(),'pwce-host-discovery-')),secret='PWCE_SYNTHETIC_HOST_'+randomBytes(8).toString('hex'),checks=[];let app,db;
try{
 const ready=await line();assert.equal(ready.fixture,true);assert.equal(ready.liveEffects,false);assert.equal(new URL(ready.url).hostname,'127.0.0.1');
 const config=loadProfile('test');config.authority.authentication='local-password';config.authority.provider='pwce';config.providers.world='pwce';config.providers.capability='pwce';config.secretRefs={gateway:{kind:'env',name:secret}};process.env[secret]=token;
 config.pwceProfile={endpoint:ready.url,worldRef:'world.personal.v1',executionEnvironmentRef:'test',siteRefs:['home.one'],principalRef:'agent.fixture',lifestreamEnvironmentId:randomUUID(),tokenSecretRef:'gateway',timeoutMs:5000,maximumPromptBytes:4096};config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};
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
 const installerToken=randomBytes(24).toString('hex');app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'safety'),installerToken}});await app.start();db=new Database({path:config.storage.databasePath});
 const base=`http://127.0.0.1:${app.address().port}`,headers={origin:base,'content-type':'application/json'};
 const request=async(path,body,extra={})=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
 const setup=await request('/api/auth/v1/setup',{username:'owner',password:'Synthetic-'+randomBytes(24).toString('hex'),installerToken});assert.equal(setup.status,201);headers.cookie=setup.cookie;headers['x-lifestream-csrf']=setup.body.session.csrfToken;
 const assistant=await request('/api/admin/v1/assistants',{displayName:'Synthetic PWCE host'});assert.equal(assistant.status,201);const path=`/api/authority/v1/assistants/${assistant.body.assistantId}/tools`;
 assert.equal((await request(path)).status,503);checks.push('unknown audience does not disclose scoped capabilities');
 assert.equal((await request(path,undefined,{cookie:''})).status,401);checks.push('authentication required before discovery');
 assert.equal((await request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'})).status,200);
 const discovered=await request(path);assert.equal(discovered.status,200,JSON.stringify(discovered));assert.equal(discovered.body.tools[0].capabilityId,'pwce.home.light.set-level');assert.equal(discovered.body.tools[0].authorization,'invokeDecision');assert.equal(discovered.body.tools[0].inputSchema.properties.parameters.properties.level.maximum,1);assert.equal(discovered.body.actionAdministration,'unavailable');checks.push('authenticated host discovers actual producer catalog and exact input schema');
 assert.equal((await request(path)).status,200);checks.push('fresh read uses the same current owner with active invalidation coverage');
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
 assert.equal((await request('/api/authority/v1/grants')).status,503);assert.equal((await request(path+'/pwce.home.light.set-level/prepare',{})).status,503);checks.push('discovery cannot fall back to local grants or action preparation');
 producer.stdin.write('revoke\n');const revoked=await line();assert.equal(revoked.revoked,true);
 const after=await request(path);assert.ok(after.status===503||after.status===200&&after.body.tools.length===0,JSON.stringify(after));checks.push('producer revocation cannot return an earlier available capability');
 await request('/api/runtime/v1/session-context',{expectedRevision:1,mode:'text',audienceScope:'unknown'});assert.equal((await request(path)).status,503);checks.push('audience withdrawal removes discovery eligibility');
 await request('/api/auth/v1/sign-out',{});assert.equal((await request(path)).status,401);checks.push('logout removes access');
 producer.stdin.write('stats\n');const stats=await line();assert.equal(stats.fixtureStats,true);assert.equal(stats.calls,0);
 for(const table of ['canonical_grants','pwce_admission_custody','pwce_invocation_custody'])assert.equal(db.connection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,0);checks.push('zero action calls, grants, admission custody or invocation claims');
 console.log(JSON.stringify({fixtures:true,liveEffects:false,casesPassed:checks.length,targetCalls:0,checks,scope:'authenticated Lifestream HTTP discovery against a separate actual PWCE process; no saved configuration or action administration activation'}));
}finally{
 if(app)await app.shutdown();db?.close();delete process.env[secret];lines.close();producer.kill('SIGTERM');await exited;rmSync(root,{recursive:true,force:true});
}
