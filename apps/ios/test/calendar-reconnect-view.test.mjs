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
 window.delivery={state:'emptyPending'};
 window.reply=(operation,request)=>({schemaVersion:'1.0.0',operation,catalogId:request.catalogId,choice:request.choice,reason:'ready',result:operation==='reconnect'?{operation:'reconnect',attemptId:'00000000-0000-4000-8000-000000000010',outcome:'reconnected',snapshotWrite:'notRequested',availability:'available'}:structuredClone(window.delivery)});
 window.invoke=(operation,request)=>{calls.push({operation,request:structuredClone(request)});const value=operation==='list'?structuredClone(catalog):reply(operation,request);if(window.transform&&operation!=='list')window.transform(value);return window.wait?new Promise(resolve=>pending.push({operation,request,resolve})):Promise.resolve(value)};
 const methods={calendarSavedChoices:r=>invoke('list',r),calendarReconnectChoice:r=>invoke('reconnect',r),calendarDeliverPendingChoice:r=>invoke('deliverPending',r)};
 window.native=new Proxy(methods,{get:(o,k)=>{if(!Object.hasOwn(o,k))throw Error('Forbidden native port '+String(k));return o[k]}});
 window.ui=createCalendarReconnectView({root:document.querySelector('#root'),native,owner:()=>allowed&&visible?{version:ownerVersion,endpoint,revision}:null,current:o=>allowed&&visible&&o.version===ownerVersion&&o.endpoint===endpoint&&o.revision===revision});`);
 await build({entryPoints:[entry],outfile:join(dir,'bundle.js'),bundle:true,platform:'browser'});
 const browser=await chromium.launch({channel:'chrome'});t.after(async()=>{await browser.close();await rm(dir,{recursive:true,force:true})});
 const page=await browser.newPage();await page.route('**/*',route=>route.abort());await page.setContent('<div id="root"></div>');await page.addScriptTag({path:join(dir,'bundle.js')});return page;
}
async function choose(page){await page.getByRole('button',{name:'Load saved Calendar connections',exact:true}).click();await page.getByLabel('Saved Calendar connection',{exact:true}).selectOption('0')}
const reconnect=page=>page.getByRole('button',{name:'Reconnect saved connection',exact:true});
const deliver=page=>page.getByRole('button',{name:'Deliver retained pending items',exact:true});
test('explicit saved reconnect and separate retained delivery only',{timeout:30000},async t=>{
 const page=await fixture(t);assert.equal(await page.evaluate(()=>calls.length),0,'constructing view invokes no native port');
 await choose(page);assert.equal(await page.evaluate(()=>calls.length),1,'select does not reconnect');assert.equal(await deliver(page).isDisabled(),true);
 await reconnect(page).click();await page.getByText('Saved connection reconnected. No data was collected or delivered.',{exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>calls.map(x=>x.operation)),['list','reconnect']);assert.equal(await deliver(page).isDisabled(),false);
 assert.deepEqual(await page.evaluate(()=>Object.keys(calls[1].request).sort()),['catalogId','choice','schemaVersion']);
 await deliver(page).click();await page.getByText('No retained Calendar items to deliver.',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>calls.map(x=>x.operation)),['list','reconnect','deliverPending']);
 await page.getByRole('button',{name:'Load saved Calendar connections',exact:true}).click();await page.getByLabel('Saved Calendar connection',{exact:true}).selectOption('0');assert.equal(await deliver(page).isDisabled(),true,'new catalog never borrows previous success');
});
test('closed unavailable and malformed native replies cannot advertise readiness',{timeout:30000},async t=>{
 const page=await fixture(t);
 for(const bad of ['unavailable','extra','native-id','long-label','overflow','scope','forged-ready','bad-handle']){
  await page.evaluate(bad=>{ui.invalidate();catalog=structuredClone(template);if(bad==='unavailable')catalog={schemaVersion:'1.0.0',state:'unavailable',reason:'no_configuration',catalogId:null,choices:[]};if(bad==='extra')catalog.extra=true;if(bad==='native-id')catalog.choices[0].enrollmentId='forbidden';if(bad==='long-label')catalog.choices[0].label='x'.repeat(121);if(bad==='overflow')catalog.choices=Array.from({length:9},()=>template.choices[0]);if(bad==='scope')catalog.choices[0].scope='newEnrollment';if(bad==='forged-ready')catalog.choices[0].pendingDeliveryReady=true;if(bad==='bad-handle')catalog.catalogId='native-selector'},bad);
  await page.getByRole('button',{name:'Load saved Calendar connections',exact:true}).click();assert.equal(await page.getByLabel('Saved Calendar connection',{exact:true}).isVisible(),false,bad);
 }
 for(const bad of ['availability','notApplied','null-attempt','context-ready','extra-result','wrong-choice']){
  await page.evaluate(bad=>{ui.invalidate();catalog=structuredClone(template);window.transform=v=>{if(bad==='availability')v.result.availability='unavailable';if(bad==='notApplied')v.result.outcome='notApplied';if(bad==='null-attempt')v.result.attemptId=null;if(bad==='context-ready')v.reason='context_changed';if(bad==='extra-result')v.result.sourceNamespace='forbidden';if(bad==='wrong-choice')v.choice=template.catalogId}},bad);
  await choose(page);await reconnect(page).click();await page.getByText('The result could not be confirmed. No further action has been started.',{exact:true}).waitFor();assert.equal(await deliver(page).isDisabled(),true,bad);
 }
 assert.equal(await page.evaluate(()=>calls.some(c=>!['list','reconnect'].includes(c.operation))),false);
});
test('owner view selection ABA and duplicate fences discard stale results',{timeout:30000},async t=>{
 const page=await fixture(t);
 for(const drift of ['duplicate','selection-ABA','owner','endpoint','revision','visibility','settings-exit']){
  await page.evaluate(()=>{ui.invalidate();catalog=structuredClone(template);calls=[];pending=[];wait=false;allowed=true;visible=true;window.transform=null});await choose(page);await page.evaluate(()=>wait=true);await reconnect(page).click();await page.waitForFunction(()=>pending.length===1);
  await reconnect(page).evaluate(b=>b.dispatchEvent(new Event('click')));assert.equal(await page.evaluate(()=>calls.filter(x=>x.operation==='reconnect').length),1,'duplicate suppressed');
  await page.evaluate(drift=>{if(drift==='selection-ABA'){const s=document.querySelector('select');s.value='1';s.dispatchEvent(new Event('change'));s.value='0';s.dispatchEvent(new Event('change'))}if(drift==='owner')ownerVersion++;if(drift==='endpoint')endpoint+='-changed';if(drift==='revision')revision++;if(drift==='visibility')visible=false;if(drift==='settings-exit')ui.invalidate();pending[0].resolve(reply('reconnect',pending[0].request));wait=false},drift);
  if(drift==='duplicate')await page.getByText('Saved connection reconnected. No data was collected or delivered.',{exact:true}).waitFor();
  else{await page.waitForTimeout(20);assert.equal(await page.getByText('Saved connection reconnected. No data was collected or delivered.',{exact:true}).count(),0,drift);if(drift!=='settings-exit')assert.equal(await deliver(page).isDisabled(),true,drift)}
 }
});
test('retained empty settled and unknown delivery stay distinct without automatic retry',{timeout:30000},async t=>{
 const page=await fixture(t);
 for(const state of ['empty','settled','transport','receipt','unconfirmed']){
  await page.evaluate(state=>{ui.invalidate();catalog=structuredClone(template);calls=[];wait=false;window.transform=null;delivery=state==='empty'?{state:'emptyPending'}:state==='settled'?{state:'settledPrefix',acceptedOrDuplicate:2,rejected:0,retryable:1,mayHaveMore:true,acquired:null}:state==='unconfirmed'?{state:'unconfirmed'}:{state:'retained',reason:state};if(state==='unconfirmed')window.transform=v=>{if(v.operation==='deliverPending'){v.reason='unavailable';v.catalogId=null;v.choice=null}}},state);
  await choose(page);await reconnect(page).click();await page.getByText('Saved connection reconnected. No data was collected or delivered.',{exact:true}).waitFor();await deliver(page).click();
  const text=state==='empty'?'No retained Calendar items to deliver.':state==='settled'?'Retained delivery: 2 accepted or already received, 0 rejected, 1 retained for retry. More retained items may remain.':state==='unconfirmed'?'Delivery is unconfirmed. Retained work remains held; no further action has been started.':'Retained items are still queued. Delivery was not confirmed; retry only when ready.';
  await page.getByText(text,{exact:true}).waitFor();await page.waitForTimeout(20);assert.equal(await page.evaluate(()=>calls.filter(c=>c.operation==='deliverPending').length),1);
  if(state==='unconfirmed'){assert.equal(await deliver(page).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Load saved Calendar connections',exact:true}).isDisabled(),true);await deliver(page).evaluate(b=>b.dispatchEvent(new Event('click')));assert.equal(await page.evaluate(()=>calls.filter(c=>c.operation==='deliverPending').length),1)}
 }
});
