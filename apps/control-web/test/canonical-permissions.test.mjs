import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLifestreamServer } from '../../server/src/index.ts';
import { loadProfile } from '../../server/src/config/loader.ts';
import { Database } from '../../../packages/storage-sqlite/dist/index.js';

const enabled = !!process.env.PLAYWRIGHT_MODULE;
test('canonical permissions: real authenticated startup, exact review, stable retries, durable results and scoped navigation', { skip: !enabled, timeout: 120000 }, async t => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
  const root = await mkdtemp(join(tmpdir(),'ls-canonical-ui-')); t.after(() => rm(root,{recursive:true,force:true}));
  const config = loadProfile('test'); config.authority.authentication='local-password'; config.storage={ databasePath:join(root,'state.sqlite'),artifactDirectory:join(root,'artifacts') };
  const installerToken=randomBytes(32).toString('hex'), password=randomBytes(32).toString('hex'); let offset=0;
  const options={config,localAuth:{stateDirectory:join(root,'safety'),installerToken,now:()=>Date.now()+offset}};
  let app=createLifestreamServer(options); await app.start(); const port=app.address().port; t.after(()=>app.shutdown());
  const db=new Database({path:config.storage.databasePath}); t.after(()=>db.close());
  const browser=await chromium.launch({channel:'chrome',headless:true}); t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:900}}), errors=[];
  page.setDefaultTimeout(8000); page.on('pageerror',e=>{errors.push(e.message);t.diagnostic(e.message);});
  const base=`http://127.0.0.1:${port}`;
  const api=(path,body)=>page.evaluate(async ({path,body})=>window.lifestreamAuth.request(path,body,body!==undefined),{path,body});
  await page.goto(base+'/control/security.html'); await page.waitForFunction(()=>window.lifestreamAuth?.mode==='local-password');
  await api('/api/auth/v1/setup',{username:'owner',password,installerToken}); await page.reload(); await page.waitForFunction(()=>window.lifestreamAuth?.session);
  const a=await api('/api/admin/v1/assistants',{displayName:'Synthetic Review Assistant'}), other=await api('/api/admin/v1/assistants',{displayName:'Other Synthetic Assistant'});
  await page.locator('#security-reload-assistants').click(); await page.locator('#security-assistant').selectOption(a.assistantId);
  await page.locator('#cap-refresh').click(); await page.waitForFunction(()=>document.querySelector('#cap-status').textContent.includes('authority scope changed'));
  assert.equal(await page.locator('#cap-prepare').isEnabled(),false);
  await page.locator('#cap-disclosure').click(); await page.locator('#session-audience').selectOption('authenticatedSession'); await page.locator('#session-context-apply').click();
  await page.waitForFunction(()=>document.querySelector('#session-context-status').textContent.includes('Approved context allowed'));
  await page.locator('#security-context>summary').click();
  const prepare=async (text='SYNTHETIC_LITERAL',grantClass='allowOnce')=>{
    await page.locator('[data-cap-view=prepare]').click(); const loaded=page.waitForResponse(r=>r.url().endsWith('/tools')); await page.locator('#cap-refresh').click(); const response=await loaded;assert.equal(response.status(),200,JSON.stringify(await response.json()));await page.waitForFunction(()=>document.querySelector('#cap-status')?.textContent==='Choose a capability and enter the exact action arguments.');
    await page.locator('#cap-select').selectOption('0'); await page.locator('[data-argument=text]').fill(text);
    await page.locator('#cap-class').selectOption(grantClass); await page.locator('#cap-form').dispatchEvent('change');
    await page.locator('#cap-prepare').click(); await page.locator('#cap-request-detail').waitFor({state:'visible'});
    await page.locator('#cap-request-detail input[type=checkbox]').waitFor({state:'visible'});
  };
  await prepare('<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('#cap-request-detail img').count(),0);
  assert.match(await page.locator('#cap-request-detail').textContent(),/<img src=x onerror=alert\(1\)>/);
  assert.equal(await page.getByRole('button',{name:'Approve once',exact:true}).isEnabled(),false);
  assert.equal(db.connection.prepare('SELECT COUNT(*) AS n FROM canonical_grants').get().n,0);
  const capture=async name=>{ if(process.env.CANONICAL_CONTROL_CAPTURE_DIR){await mkdir(process.env.CANONICAL_CONTROL_CAPTURE_DIR,{recursive:true});await page.screenshot({path:join(process.env.CANONICAL_CONTROL_CAPTURE_DIR,name+'.png'),fullPage:true});} };
  await capture('pending-once-desktop');
  // A real reload reads the original prepared input/key; it does not synthesize a replacement.
  await page.goto(base+'/control/security.html'); try {await page.waitForFunction(()=>window.lifestreamAuth?.session);}catch(error){t.diagnostic(await page.locator('body').textContent());t.diagnostic(JSON.stringify(await page.evaluate(()=>({url:location.href,auth:window.lifestreamAuth?.mode,session:!!window.lifestreamAuth?.session}))));throw error;} await page.locator('#security-assistant').selectOption(a.assistantId);
  await page.locator('[data-cap-view=requests]').click(); await page.locator('#cap-requests-refresh').click(); await page.locator('#cap-requests button').first().click();
  await page.locator('#cap-request-detail input[type=checkbox]').check();
  const commands=[]; let interrupt=true;
  await page.route('**/api/authority/v1/requests/*/approve',async route=>{ commands.push(route.request().postDataJSON()); if(interrupt){interrupt=false; await route.fetch(); await route.abort('failed');}else await route.continue(); });
  await page.getByRole('button',{name:'Approve once',exact:true}).focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('#cap-status').textContent.includes('Outcome unconfirmed'));
  await capture('unknown-approval-outcome');
  assert.equal(db.connection.prepare('SELECT COUNT(*) AS n FROM canonical_grants').get().n,1);
  await page.getByRole('button',{name:'Retry same command: Approve once',exact:true}).click();
  await page.getByRole('button',{name:'Run approved action',exact:true}).waitFor(); assert.deepEqual(commands[0],commands[1]);
  assert.equal(db.connection.prepare('SELECT COUNT(*) AS n FROM canonical_dispatch_claims').get().n,0);
  const grant=db.connection.prepare('SELECT grant_id FROM canonical_grants').get().grant_id;
  let loseDispatch=true; const dispatchCommands=[];
  await page.route('**/tools/invocations/*/dispatch',async route=>{dispatchCommands.push(route.request().postDataJSON());if(loseDispatch){loseDispatch=false;await route.fetch();await route.abort('failed');}else await route.continue();});
  await page.getByRole('button',{name:'Run approved action',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#cap-status').textContent.includes('Outcome unconfirmed'));
  assert.equal(db.connection.prepare('SELECT COUNT(*) AS n FROM canonical_dispatch_claims').get().n,1);
  await page.getByRole('button',{name:'Retry same command: Run approved action',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-action-result]')?.textContent.includes('succeeded'));
  assert.deepEqual(dispatchCommands[0],dispatchCommands[1]);
  assert.equal(db.connection.prepare('SELECT COUNT(*) AS n FROM canonical_dispatch_claims').get().n,1);
  await capture('admitted-result');
  await app.shutdown(); app=createLifestreamServer({...options,port}); await app.start();
  await page.goto(base+'/control/security.html'); try {await page.waitForFunction(()=>window.lifestreamAuth?.session);}catch(error){t.diagnostic(await page.locator('body').textContent());t.diagnostic(JSON.stringify(await page.evaluate(()=>({url:location.href,auth:window.lifestreamAuth?.mode,session:!!window.lifestreamAuth?.session}))));throw error;} await page.locator('#security-assistant').selectOption(a.assistantId);
  await page.locator('[data-cap-view=grants]').click(); await page.locator('#cap-grants-refresh').click(); await page.getByRole('button',{name:grant,exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Run approved action',exact:true}).count(),0);
  await page.getByRole('button',{name:'Read original result',exact:true}).click(); await page.waitForFunction(()=>document.querySelector('[data-action-result]')?.textContent.includes('succeeded'));
  assert.equal(db.connection.prepare('SELECT COUNT(*) AS n FROM canonical_dispatch_claims').get().n,1);
  // Persistent terms and revocation stay distinct from execution.
  await prepare('SYNTHETIC_PERSISTENT','allowPersistent'); await capture('persistent-review');
  await page.locator('#cap-request-detail input[type=checkbox]').check(); await page.getByRole('button',{name:/^Approve until/}).click();
  await page.getByRole('button',{name:'Run approved action',exact:true}).waitFor();
  const persistentId=db.connection.prepare("SELECT grant_id FROM canonical_grants WHERE json_extract(payload_json,'$.grantClass')='allowPersistent'").get().grant_id;
  await prepare('SYNTHETIC_FRESH_ACTION','allowPersistent');await page.getByRole('button',{name:'Check existing reusable permissions',exact:true}).click();
  await page.getByRole('button',{name:'Persistent, until expiry or revocation · '+persistentId,exact:true}).click();
  await page.getByRole('button',{name:'Run approved action',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-action-result]')?.textContent.includes('SYNTHETIC_FRESH_ACTION'));
  assert.equal(db.connection.prepare('SELECT COUNT(*) AS n FROM canonical_dispatch_claims').get().n,2);
  assert.equal(db.connection.prepare('SELECT COUNT(*) AS n FROM canonical_grants').get().n,2,'Reusing the existing permission issues no new grant');
  await page.locator('#cap-grants-refresh').click();await page.getByRole('button',{name:persistentId,exact:true}).click();
  await page.locator('#cap-grant-detail input[type=checkbox]').check(); await page.getByRole('button',{name:'Revoke permission',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#cap-status').textContent.includes('Revocation recorded'));
  assert.match(await page.locator('#cap-grant-detail').textContent(),/revoked/); await capture('revocation');
  await prepare('SYNTHETIC_DENIAL'); await page.getByRole('button',{name:'Deny request',exact:true}).click(); await page.waitForFunction(()=>document.querySelector('#cap-status').textContent.includes('Request denied'));
  await capture('denied');
  // Server denial wins even when a previously rendered approval control still looks eligible.
  await prepare('SYNTHETIC_STALE'); const pending=JSON.parse(db.connection.prepare("SELECT payload_json FROM canonical_grant_requests WHERE json_extract(payload_json,'$.state')='pending' ORDER BY rowid DESC LIMIT 1").get().payload_json);
  await api(`/api/authority/v1/requests/${pending.requestId}/deny`,{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),payload:{requestId:pending.requestId,expectedRevision:pending.revision,confirmationDigest:pending.confirmationDigest,reason:{code:'synthetic_stale',summary:'Synthetic second review'}}});
  await page.locator('#cap-request-detail input[type=checkbox]').check(); await page.getByRole('button',{name:'Approve once',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#cap-status').textContent.includes('no longer actionable')); assert.equal(await page.getByRole('button',{name:'Approve once',exact:true}).isEnabled(),false); await capture('stale');
  // Phone layouts retain full identifiers and one current destination.
  for(const width of [390,320]){await page.setViewportSize({width,height:844}); await page.evaluate(()=>document.fonts.ready); const size=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})); assert.ok(size.scroll<=size.width+1,JSON.stringify(size)); await capture('pending-'+width);}
  await page.setViewportSize({width:720,height:450}); assert.equal(await page.locator('#cap-request-detail').isVisible(),true); await capture('desktop-200-percent-equivalent');
  // Pagination reads bounded server pages and state filtering never hides history by default.
  const toolBase=`/api/authority/v1/assistants/${a.assistantId}/tools`, catalog=await api(toolBase);
  for(let i=0;i<21;i++){
    const now=Date.now(),body={idempotencyKey:randomUUID(),capabilityVersion:'1.0.0',input:{target:'synthetic:one',text:'PAGINATION_'+i},requestedClass:'allowOnce',grantExpiresAt:new Date(now+60000).toISOString(),reviewAfter:null,expiresAt:new Date(Math.min(now+30000,Date.parse(catalog.expiresAt)-1000)).toISOString(),untrustedRationale:null};
    const p=(await api(toolBase+'/synthetic.echo/prepare',body)).preparation;
    const {environmentId:_environment,sideEffectClass:_effect,...payload}=p.request;
    await api('/api/authority/v1/requests',{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),payload});
  }
  await page.locator('#cap-requests-refresh').click();await page.waitForFunction(()=>document.querySelectorAll('#cap-requests button').length===20);
  await page.locator('#cap-requests-more').click();await page.waitForFunction(()=>document.querySelectorAll('#cap-requests button').length>20);
  const ids=await page.locator('#cap-requests button').allTextContents();assert.equal(new Set(ids).size,ids.length);
  await page.locator('#cap-requests-state').selectOption('denied');await page.waitForFunction(()=>document.querySelectorAll('#cap-requests button').length===2);
  assert.equal(await page.locator('#cap-requests-more').isVisible(),false);
  await page.locator('#security-assistant').selectOption(other.assistantId); assert.equal(await page.locator('#cap-request-detail').isVisible(),false); assert.equal(await page.locator('#cap-grants').textContent(),'');
  if(await page.locator('#security-navigation>summary').isVisible() && !await page.locator('#security-navigation').evaluate(d=>d.open)) await page.locator('#security-navigation>summary').click();await page.getByRole('link',{name:'People & access',exact:true}).click(); assert.equal(await page.locator('#security-provision').isVisible(),true); assert.equal(await page.locator('#cap-form').isVisible(),false);
  // Revoked/expired authentication clears all private detail and pending confirmations.
  offset=31*60000; await page.locator('#security-accounts').click(); await page.waitForFunction(()=>!window.lifestreamAuth?.session);
  assert.equal(await page.locator('.workspace').isVisible(),false); assert.equal(await page.locator('#cap-request-detail').textContent(),''); await capture('expired-authentication');
  assert.deepEqual(errors,[]);
});
