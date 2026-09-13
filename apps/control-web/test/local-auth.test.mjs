import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLifestreamServer } from '../../server/src/index.ts';
import { loadProfile } from '../../server/src/config/loader.ts';

test('rendered local setup, session, profile review and Owner provisioning use actual authentication', {skip: !process.env.PLAYWRIGHT_MODULE}, async t => {
  const { chromium }=await import(process.env.PLAYWRIGHT_MODULE);
  const root=await mkdtemp(join(tmpdir(),'ls-rendered-auth-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const config=loadProfile('test');config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};config.authority.authentication='local-password';
  const installerToken=randomBytes(32).toString('hex'),password=`synthetic-${randomBytes(24).toString('hex')}`;const app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'safety'),installerToken}});await app.start();t.after(()=>app.shutdown());
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${app.address().port}/control/`);await page.locator('#auth-setup').waitFor({state:'visible'});await page.locator('#auth-username').fill('owner');await page.locator('#auth-password').fill(password);await page.locator('#auth-installer-token').fill(installerToken);await page.locator('#auth-setup').click();await page.waitForFunction(()=>document.querySelector('#auth-status').textContent.includes('Owner enrolled'));assert.equal((await page.locator('#auth-recovery-codes').textContent()).trim().split('\n').length,10);
  await page.locator('#new-assistant').click();await page.waitForFunction(()=>document.querySelector('#result').textContent.includes('Assistant created'));await page.locator('#display-name').fill('Synthetic Browser Assistant');await page.locator('#identity').fill('A neutral synthetic administration example.');await page.locator('#preview').click();await page.waitForFunction(()=>document.querySelector('#result').textContent.includes('Nothing was activated or saved'));await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#revisions').textContent.includes('Revision 2'));await page.locator('#activate').click();await page.waitForFunction(()=>document.querySelector('#editor-status').textContent==='active');
  // Recovery values are cleared before screenshots or subsequent navigation.
  await page.locator('#auth-sign-out').click();await page.waitForFunction(()=>document.querySelector('.workspace').hidden);await page.locator('#auth-username').fill('owner');await page.locator('#auth-password').fill(password);await page.locator('#auth-sign-in').click();await page.waitForFunction(()=>document.querySelector('#auth-status').textContent.startsWith('Signed in'));await page.waitForFunction(()=>document.querySelector('#editor-title').textContent==='Synthetic Browser Assistant');
  await page.goto(`http://127.0.0.1:${app.address().port}/control/security.html`);await page.waitForFunction(()=>window.lifestreamAuth.session);await page.locator('#security-username').fill('member');await page.locator('#security-password').fill(`synthetic-${randomBytes(24).toString('hex')}`);await page.locator('#security-provision').click();await page.waitForFunction(()=>document.querySelector('#security-status').textContent.includes('no Assistant permissions'));await page.locator('#security-accounts').click();await page.waitForFunction(()=>document.querySelector('#security-account-list').textContent.includes('member'));assert.ok(!(await page.locator('#security-account-list').textContent()).includes('password'));
  await page.setViewportSize({width:390,height:844});assert.ok(await page.locator('#security-provision').isVisible());assert.deepEqual(errors,[]);
});
