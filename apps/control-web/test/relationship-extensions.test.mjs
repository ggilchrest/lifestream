import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLifestreamServer } from '../../server/src/index.ts';
import { loadProfile } from '../../server/src/config/loader.ts';

test('extension review pages keep draft, preview and activation in order with scoped readable records',{skip:!process.env.PLAYWRIGHT_MODULE,timeout:90000},async t=>{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE),root=await mkdtemp(join(tmpdir(),'ls-extensions-browser-'));t.after(()=>rm(root,{recursive:true,force:true}));const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};const installerToken=randomBytes(32).toString('hex');const app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'safety'),installerToken}});await app.start();t.after(()=>app.shutdown());const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1360,height:960}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/control/contracts/initiative-api.schema.json',route=>route.fulfill({status:404,contentType:'application/json',body:'{}'}));
 await page.goto(`http://127.0.0.1:${app.address().port}/control/`);await page.waitForFunction(()=>!!window.lifestreamUI);
 assert.match(await page.locator('.relationship-initiative').textContent(),/updated runtime/);
 await page.unroute('**/control/contracts/initiative-api.schema.json');await page.reload();await page.waitForFunction(()=>!!window.lifestreamUI);
 await page.locator('#auth-username').fill('owner');await page.locator('#auth-password').fill(randomBytes(32).toString('hex'));await page.locator('#auth-installer-token').fill(installerToken);await page.locator('#auth-setup').click();await page.waitForFunction(()=>!!window.lifestreamAuth.session);
 await page.locator('#new-assistant').click();await page.waitForFunction(()=>document.querySelector('#result').textContent.includes('Assistant created'));
 const nav=async id=>{const link=page.locator(`[data-destination="${id}"]`);if(!await link.isVisible())await page.locator('.nav-toggle').click();await link.click();};
 await nav('relationship');await page.locator('#relationship-create').click();await page.waitForFunction(()=>document.querySelector('#relationship-results').textContent.includes('revision 1'));
 for(const [view,kind] of [['initiative','initiative'],['discovery','understanding']]){
  await nav(view);const panel=page.locator(`.relationship-${kind}`);await panel.locator('[data-action=refresh]').click();await panel.locator('[data-role=status]').filter({hasText:'Settings loaded'}).waitFor();
  if(kind==='initiative')await panel.locator('[data-path=preset]').selectOption('reserved');
  await panel.getByRole('button',{name:'Save review draft',exact:true}).click();await panel.locator('[data-role=status]').filter({hasText:'Draft saved'}).waitFor();
  assert.equal(await panel.locator('[data-role=review]').isVisible(),true);assert.equal(await panel.locator('[data-action=activate]').isEnabled(),true);assert.ok(await panel.locator('[data-role=history] th').count()>=4);
  await panel.locator('[data-action=activate]').click();await panel.locator('[data-role=status]').filter({hasText:'Reviewed settings activated'}).waitFor();assert.match(await panel.locator('[data-role=active]').textContent(),/Revision/);
  await page.screenshot({path:`/private/tmp/lifestream-${view}-desktop.png`,fullPage:true});
 }
 await nav('initiative');const panel=page.locator('.relationship-initiative');await panel.locator('[data-action=refresh]').click();await panel.locator('[data-role=status]').filter({hasText:'Settings loaded'}).waitFor();
 await panel.getByRole('button',{name:'Preview revision 1',exact:true}).click();await panel.locator('[data-action=rollback]').waitFor();await panel.locator('[data-action=rollback]').click();await panel.locator('[data-role=status]').filter({hasText:'Rollback prepared'}).waitFor();assert.equal(await panel.locator('[data-action=activate]').isEnabled(),true);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/private/tmp/lifestream-initiative-mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await nav('account');await page.locator('#auth-sign-out').click();await page.waitForFunction(()=>!window.lifestreamAuth.session);assert.equal(await panel.locator('[data-role=history]').textContent(),'');assert.deepEqual(errors,[]);
});
