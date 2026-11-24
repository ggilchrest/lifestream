import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
async function fixture(t){
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
 const dir=await mkdtemp(join(tmpdir(),'calendar-saved-ui-')),entry=join(dir,'entry.js');
 await writeFile(entry,`import {createCalendarReconnectView} from ${JSON.stringify(fileURLToPath(new URL('../web/calendar-reconnect-view.js',import.meta.url)))};
 window.calls=[];window.pending=[];window.wait=false;window.allowed=true;window.visible=true;window.ownerVersion=1;window.endpoint='synthetic-endpoint';window.revision=1;
 window.template={schemaVersion:'1.0.0',state:'available',reason:'ready',catalogId:'00000000-0000-4000-8000-000000000001',choices:[1,2].map(i=>({choice:'00000000-0000-4000-8000-00000000000'+(i+1),label:'Synthetic saved connection '+i,destinationLabel:'Synthetic destination',dataLabel:i===1?'Calendar events':'Reminders',scope:'existingSavedOnly',pendingDeliveryReady:false}))};window.catalog=structuredClone(template);
 window.delivery={state:'emptyPending'};window.details={state:'configured',scope:'collectAndDeliver',destinationLabel:'Synthetic destination',dataLabel:'Calendar events',coverageStart:'2026-10-31T00:00:00.000Z',coverageEnd:'2026-11-01T00:00:00.000Z',timeZone:'UTC'};window.sync={state:'settledPrefix',acquired:1,acceptedOrDuplicate:2,rejected:0,retryable:0,mayHaveMore:true};
 window.reply=(operation,request)=>({schemaVersion:'1.0.0',operation,catalogId:request.catalogId,choice:request.choice,reason:'ready',result:operation==='reviewCollection'?{...structuredClone(details),dataLabel:template.choices.find(c=>c.choice===request.choice).dataLabel}:operation==='collectAndDeliver'?structuredClone(window.sync):operation==='reconnect'?{operation:'reconnect',attemptId:'00000000-0000-4000-8000-000000000010',outcome:'reconnected',snapshotWrite:'notRequested',availability:'available'}:structuredClone(window.delivery)});
 window.invoke=(operation,request)=>{calls.push({operation,request:structuredClone(request)});const value=operation==='list'?structuredClone(catalog):reply(operation,request);if(window.transform&&operation!=='list')window.transform(value);return window.wait?new Promise(resolve=>pending.push({operation,request,resolve})):Promise.resolve(value)};
 const methods={calendarSavedChoices:r=>invoke('list',r),calendarReconnectChoice:r=>invoke('reconnect',r),calendarDeliverPendingChoice:r=>invoke('deliverPending',r),calendarCollectionDetailsChoice:r=>invoke('reviewCollection',r),calendarCollectAndDeliverChoice:r=>invoke('collectAndDeliver',r)};
 window.methods=methods;window.native=new Proxy(methods,{get:(o,k)=>{if(!Object.hasOwn(o,k))throw Error('Forbidden native port '+String(k));return o[k]}});
 window.ui=createCalendarReconnectView({root:document.querySelector('#root'),native,owner:()=>allowed&&visible?{version:ownerVersion,endpoint,revision}:null,current:o=>allowed&&visible&&o.version===ownerVersion&&o.endpoint===endpoint&&o.revision===revision});`);
 await build({entryPoints:[entry],outfile:join(dir,'bundle.js'),bundle:true,platform:'browser'});
 const browser=await chromium.launch({channel:'chrome'});t.after(async()=>{await browser.close();await rm(dir,{recursive:true,force:true})});
 const page=await browser.newPage();await page.route('**/*',route=>route.abort());await page.setContent('<div id="root"></div>');await page.addScriptTag({path:join(dir,'bundle.js')});return page;
}
async function choose(page,index='0'){await page.getByRole('button',{name:'Load saved Calendar connections',exact:true}).click();await page.getByLabel('Saved Calendar connection',{exact:true}).selectOption(index)}
const review=page=>page.getByRole('button',{name:'Review collection and send details',exact:true});
const sync=page=>page.getByRole('button',{name:'Sync now (collect and send)',exact:true});
const reconnect=page=>page.getByRole('button',{name:'Reconnect saved connection',exact:true});
async function connect(page,index='0'){await choose(page,index);await reconnect(page).click();await page.getByText('Saved connection reconnected. No data was collected or delivered.',{exact:true}).waitFor()}
async function prepared(page){await connect(page);await review(page).click();await page.getByText('Review the fixed category, interval and destination, then explicitly choose to collect and send.',{exact:true}).waitFor()}
test('explicit original details precede separate collect AND send, never automatic',{timeout:30000},async t=>{
 const page=await fixture(t);assert.equal(await page.evaluate(()=>calls.length),0);await choose(page);assert.equal(await review(page).isDisabled(),true);assert.equal(await sync(page).count(),0);
 await reconnect(page).click();await review(page).click();await page.getByText('Collect and transmit to: Synthetic destination',{exact:true}).waitFor();await page.getByText('Configured scan interval (partial): 2026-10-31T00:00:00.000Z to 2026-11-01T00:00:00.000Z. Captured time zone: UTC.',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>calls.map(c=>c.operation)),['list','reconnect','reviewCollection']);
 await sync(page).click();await page.getByText('Collection committed 1 item(s). Delivery: 2 accepted or already received, 0 rejected, 0 retained for retry. More may remain. This is a partial result, not a complete sync.',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>calls.map(c=>c.operation)),['list','reconnect','reviewCollection','collectAndDeliver']);assert.equal(await sync(page).count(),0,'review consumed');
 assert.deepEqual(await page.evaluate(()=>Object.keys(calls[3].request).sort()),['catalogId','choice','schemaVersion']);await page.waitForTimeout(20);assert.equal(await page.evaluate(()=>calls.length),4,'no automatic retry, status, permission, capture or delivery');
});
test('closed fixed metadata and original partial result stages are honest',{timeout:30000},async t=>{
 const page=await fixture(t);
 for(const bad of ['extra','window','scope','wrong-category']){
  await page.evaluate(bad=>{ui.invalidate();catalog=structuredClone(template);window.transform=v=>{if(v.operation!=='reviewCollection')return;if(bad==='extra')v.result.enrollmentId='forbidden';if(bad==='window')v.result.coverageEnd='2027-01-01T00:00:00.000Z';if(bad==='scope')v.result.scope='newGrant';if(bad==='wrong-category')v.result.dataLabel='Reminders'}},bad);await connect(page);await review(page).click();assert.equal(await sync(page).count(),0,bad);
 }
 for(const state of ['empty','transport','receipt','acquisition','delivery','unknown-acquisition','unknown-settlement','malformed']){
  await page.evaluate(state=>{ui.invalidate();catalog=structuredClone(template);calls=[];window.sync=state==='empty'?{state:'emptyPending',acquired:0}:['transport','receipt'].includes(state)?{state:'retained',reason:state}:state.startsWith('unknown')?{state:'unconfirmed',stage:state==='unknown-acquisition'?'acquisition':'settlement',attemptId:'00000000-0000-4000-8000-000000000020'}:{state:'notApplied',stage:state==='delivery'?'delivery':'acquisition',reason:'cancelled'};window.transform=v=>{if(v.operation!=='collectAndDeliver')return;if(state.startsWith('unknown')){v.reason='unavailable';v.catalogId=null;v.choice=null}if(state==='malformed')v.result.acquired=999}},state);
  await prepared(page);await sync(page).click();
  const text=state==='empty'?'Collection committed 0 item(s); no retained items were available to send. This is a partial scan result.':['transport','receipt'].includes(state)?'Delivery is unconfirmed. Collection or transmission may have occurred; retained work remains held. No automatic retry was started.':state==='acquisition'?'Collection commit was not applied; no delivery result was confirmed. Reading may already have occurred.':state==='delivery'?'Collection or transmission may already have occurred; delivery completion was not confirmed. No automatic retry was started.':state.startsWith('unknown')?(state==='unknown-acquisition'?'Collection commit':'Delivery settlement')+' is unconfirmed. The original attempt remains held; do not retry or assume no work occurred.':'The result could not be confirmed. No further action has been started.';
  await page.getByText(text,{exact:true}).waitFor();if(state==='malformed'){assert.equal(await sync(page).isDisabled(),true,'unconfirmed reply keeps capture disabled');await sync(page).evaluate(b=>b.dispatchEvent(new Event('click')))}else assert.equal(await sync(page).count(),0,'review consumed');assert.equal(await page.evaluate(()=>calls.filter(c=>c.operation==='collectAndDeliver').length),1,'no repeated capture even on forced stale click');if(state.startsWith('unknown'))assert.equal(await review(page).isDisabled(),true);
 }
});
test('manual owner view selection ABA duplicate and late fences',{timeout:30000},async t=>{
 const page=await fixture(t);
 for(const drift of ['duplicate','selection-ABA','owner','endpoint','revision','visibility','settings-exit']){
  await page.evaluate(()=>{ui.invalidate();catalog=structuredClone(template);calls=[];pending=[];wait=false;allowed=true;visible=true;window.transform=null});await prepared(page);await page.evaluate(()=>wait=true);await sync(page).click();await page.waitForFunction(()=>pending.length===1);await sync(page).evaluate(b=>b.dispatchEvent(new Event('click')));assert.equal(await page.evaluate(()=>calls.filter(c=>c.operation==='collectAndDeliver').length),1);
  await page.evaluate(drift=>{if(drift==='selection-ABA'){const s=document.querySelector('select');s.value='1';s.dispatchEvent(new Event('change'));s.value='0';s.dispatchEvent(new Event('change'))}if(drift==='owner')ownerVersion++;if(drift==='endpoint')endpoint+='-changed';if(drift==='revision')revision++;if(drift==='visibility')visible=false;if(drift==='settings-exit')ui.invalidate();pending[0].resolve(reply('collectAndDeliver',pending[0].request));wait=false},drift);
  if(drift==='duplicate')await page.getByText(/Collection committed 1 item/).waitFor();else{await page.waitForTimeout(20);assert.equal(await page.getByText(/Collection committed 1 item/).count(),0,drift)}
 }
});
test('absent method/composition stays unavailable and Reminders interval is not a due filter',{timeout:30000},async t=>{
 const page=await fixture(t);await connect(page);await page.evaluate(()=>methods.calendarCollectionDetailsChoice=undefined);await review(page).click();await page.getByText('Manual collection and sending are unavailable in this app version.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>calls.length),2);assert.equal(await sync(page).count(),0);
 await page.evaluate(()=>{methods.calendarCollectionDetailsChoice=r=>invoke('reviewCollection',r);window.transform=v=>{if(v.operation==='reviewCollection'){v.reason='unavailable';v.catalogId=null;v.choice=null;v.result={state:'unavailable'}}}});await review(page).click();await page.getByText('Collection and sending are unavailable or busy. No collection request has been started.',{exact:true}).waitFor();assert.equal(await sync(page).count(),0);
 await page.evaluate(()=>{ui.invalidate();catalog=structuredClone(template);calls=[];window.transform=null});await connect(page,'1');await review(page).click();await page.getByText('Data to collect: Reminders',{exact:true}).waitFor();await page.getByText('Reminders are read from the configured lists; this scan interval is not a due-date filter. This is a bounded partial scan, not a complete sync.',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>calls.map(c=>c.operation)),['list','reconnect','reviewCollection']);
});
