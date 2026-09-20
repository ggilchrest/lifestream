import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
test('memory mode reflects durable policy and preserves an unsaved choice across an unchanged refresh',{skip:!process.env.PLAYWRIGHT_MODULE},async t=>{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 const source=await readFile(new URL('../automatic-memory.js',import.meta.url),'utf8');
 await page.route('http://127.0.0.1:9/**',route=>route.fulfill({contentType:route.request().url().endsWith('.js')?'text/javascript':'text/html',body:route.request().url().endsWith('.js')?source:'<main></main>'}));await page.goto('http://127.0.0.1:9/');
 await page.evaluate(async()=>{window.lifestreamAuth={session:{sessionId:'synthetic'}};window.policy={enabled:false,revision:1};const {installAutomaticMemory}=await import('/automatic-memory.js');installAutomaticMemory({anchor:document.querySelector('main'),context:()=>({assistantId:'synthetic',relationship:{relationshipId:'synthetic'}}),api:async(_path,options)=>{if(options){const body=JSON.parse(options.body);if(body.expectedRevision!==window.policy.revision)throw Error('conflict');window.policy={enabled:body.enabled,revision:window.policy.revision+1};}return {policy:{...window.policy},jobs:window.jobs??[]};}});});
 await page.evaluate(()=>{window.jobs=[{state:'saved',result:JSON.stringify({rejectedItemCount:1})}];});
 const checkbox=page.locator('[data-memory-enabled]'),refresh=page.getByRole('button',{name:'Refresh memory status'});
 await refresh.click();await page.waitForFunction(()=>document.querySelector('.room-memory [role="status"]').textContent.includes('Automatic memory off'));assert.equal(await checkbox.isChecked(),false);assert.match(await page.locator('.room-memory [role="status"]').textContent(),/1 unsafe or malformed extracted item rejected; valid items were handled separately/);
 await checkbox.check();await refresh.click();assert.equal(await checkbox.isChecked(),true,'an unchanged background read must not erase an unsaved edit');
 await page.getByRole('button',{name:'Apply memory mode'}).click();await page.waitForFunction(()=>document.querySelector('.room-memory [role="status"]').textContent.includes('Automatic memory enabled'));await refresh.click();assert.equal(await checkbox.isChecked(),true);
 await page.evaluate(()=>{window.policy={enabled:false,revision:3};});await refresh.click();await page.waitForFunction(()=>!document.querySelector('[data-memory-enabled]').checked);assert.match(await page.locator('.room-memory [role="status"]').textContent(),/Automatic memory off/);
});
