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
 window.delivery={state:'emptyPending'};window.permission={attemptId:'00000000-0000-4000-8000-000000000011',requestState:'requestCompleted',readAccess:'fullRead'};
 window.reply=(operation,request)=>({schemaVersion:'1.0.0',operation,catalogId:request.catalogId,choice:request.choice,reason:'ready',result:operation==='requestReadPermission'?structuredClone(permission):operation==='reconnect'?{operation:'reconnect',attemptId:'00000000-0000-4000-8000-000000000010',outcome:'reconnected',snapshotWrite:'notRequested',availability:'available'}:structuredClone(window.delivery)});
 window.invoke=(operation,request)=>{calls.push({operation,request:structuredClone(request)});const value=operation==='list'?structuredClone(catalog):reply(operation,request);if(window.transform&&operation!=='list')window.transform(value);return window.wait?new Promise(resolve=>pending.push({operation,request,resolve})):Promise.resolve(value)};
 const methods={calendarSavedChoices:r=>invoke('list',r),calendarReconnectChoice:r=>invoke('reconnect',r),calendarDeliverPendingChoice:r=>invoke('deliverPending',r),calendarRequestReadPermissionChoice:r=>invoke('requestReadPermission',r)};
 window.methods=methods;window.native=new Proxy(methods,{get:(o,k)=>{if(!Object.hasOwn(o,k))throw Error('Forbidden native port '+String(k));return o[k]}});
 window.ui=createCalendarReconnectView({root:document.querySelector('#root'),native,owner:()=>allowed&&visible?{version:ownerVersion,endpoint,revision}:null,current:o=>allowed&&visible&&o.version===ownerVersion&&o.endpoint===endpoint&&o.revision===revision});`);
 await build({entryPoints:[entry],outfile:join(dir,'bundle.js'),bundle:true,platform:'browser'});
 const browser=await chromium.launch({channel:'chrome'});t.after(async()=>{await browser.close();await rm(dir,{recursive:true,force:true})});
 const page=await browser.newPage();await page.route('**/*',route=>route.abort());await page.setContent('<div id="root"></div>');await page.addScriptTag({path:join(dir,'bundle.js')});return page;
}
async function choose(page){await page.getByRole('button',{name:'Load saved Calendar connections',exact:true}).click();await page.getByLabel('Saved Calendar connection',{exact:true}).selectOption('0')}
const request=page=>page.getByRole('button',{name:'Request Calendar reading',exact:true});
const reconnect=page=>page.getByRole('button',{name:'Reconnect saved connection',exact:true});
const deliver=page=>page.getByRole('button',{name:'Deliver retained pending items',exact:true});
async function connect(page){await choose(page);await reconnect(page).click();await page.getByText('Saved connection reconnected. No data was collected or delivered.',{exact:true}).waitFor()}
test('explicit reading request uses current saved choice and never follows on automatically',{timeout:30000},async t=>{
 const page=await fixture(t);assert.equal(await page.evaluate(()=>calls.length),0);await choose(page);assert.equal(await request(page).isDisabled(),true);assert.deepEqual(await page.evaluate(()=>calls.map(c=>c.operation)),['list']);
 await page.getByText('System permission is separate from your saved connection and source settings. Apple requests full access, which also permits changes. This Lifestream feature contains no event or reminder write operations. Requesting permission does not collect or send data.',{exact:true}).waitFor();
 await reconnect(page).click();await request(page).click();await page.getByText(/System request completed; full access was observed/).waitFor();
 assert.deepEqual(await page.evaluate(()=>calls.map(c=>c.operation)),['list','reconnect','requestReadPermission']);assert.deepEqual(await page.evaluate(()=>Object.keys(calls[2].request).sort()),['catalogId','choice','schemaVersion']);assert.equal(await deliver(page).isDisabled(),false,'only prior saved readiness preserved');
 await page.waitForTimeout(20);assert.equal(await page.evaluate(()=>calls.length),3,'no automatic status, second request, capture or delivery');
});
test('honest system observations deferred and closed replies never become new authority',{timeout:30000},async t=>{
 const page=await fixture(t);
 for(const state of ['fullRead','denied','restricted','writeOnly','notDetermined','unknown','deferred','extra','wrong-handle','false-state']){
  await page.evaluate(state=>{ui.invalidate();catalog=structuredClone(template);calls=[];permission={attemptId:'00000000-0000-4000-8000-000000000011',requestState:state==='deferred'?'deferred':state==='fullRead'?'notInvoked':'requestCompleted',readAccess:['extra','wrong-handle','false-state','deferred'].includes(state)?'unknown':state};window.transform=v=>{if(v.operation!=='requestReadPermission')return;if(state==='deferred'){v.reason='context_changed';v.catalogId=null;v.choice=null}if(state==='extra')v.result.sourceNamespace='forbidden';if(state==='wrong-handle')v.choice=template.catalogId;if(state==='false-state')v.result.requestState=true}},state);
  await connect(page);await request(page).click();
  const text=state==='fullRead'?'Full system access was observed; no new request was made. This is a system capability observation, not source approval or data coverage. Nothing was collected or delivered.':state==='denied'?'System reading access is denied. You can review permission in iPhone Settings. Nothing was collected or delivered.':state==='restricted'?'System reading access is restricted. Nothing was collected or delivered.':state==='writeOnly'?'System access is write-only; reading access was not confirmed. Nothing was collected or delivered.':state==='notDetermined'?'System reading access has not been decided. Nothing was collected or delivered.':state==='unknown'?'The system request completed, but reading access could not be confirmed. Nothing was collected or delivered.':state==='deferred'?'The system request is deferred or no longer current. Its original callback remains owned; no further action has been started.':'The result could not be confirmed. No further action has been started.';
  await page.getByText(text,{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>calls.map(c=>c.operation)),['list','reconnect','requestReadPermission']);if(['deferred','extra','wrong-handle','false-state'].includes(state))assert.equal(await deliver(page).isDisabled(),true);
 }
});
test('permission owner catalog selection ABA duplicate and late reply fences',{timeout:30000},async t=>{
 const page=await fixture(t);
 for(const drift of ['duplicate','selection-ABA','owner','endpoint','revision','visibility','settings-exit']){
  await page.evaluate(()=>{ui.invalidate();catalog=structuredClone(template);calls=[];pending=[];wait=false;allowed=true;visible=true;window.transform=null});await connect(page);await page.evaluate(()=>wait=true);await request(page).click();await page.waitForFunction(()=>pending.length===1);await request(page).evaluate(b=>b.dispatchEvent(new Event('click')));assert.equal(await page.evaluate(()=>calls.filter(c=>c.operation==='requestReadPermission').length),1);
  await page.evaluate(drift=>{if(drift==='selection-ABA'){const s=document.querySelector('select');s.value='1';s.dispatchEvent(new Event('change'));s.value='0';s.dispatchEvent(new Event('change'))}if(drift==='owner')ownerVersion++;if(drift==='endpoint')endpoint+='-changed';if(drift==='revision')revision++;if(drift==='visibility')visible=false;if(drift==='settings-exit')ui.invalidate();pending[0].resolve(reply('requestReadPermission',pending[0].request));wait=false},drift);
  if(drift==='duplicate')await page.getByText(/System request completed; full access was observed/).waitFor();else{await page.waitForTimeout(20);assert.equal(await page.getByText(/System request completed; full access was observed/).count(),0,drift)}assert.equal(await page.evaluate(()=>calls.filter(c=>c.operation==='deliverPending').length),0);
 }
});
test('missing method unavailable native owner and separate Reminders action',{timeout:30000},async t=>{
 const page=await fixture(t);await connect(page);await page.evaluate(()=>methods.calendarRequestReadPermissionChoice=undefined);await request(page).click();await page.getByText('System reading requests are unavailable in this app version.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>calls.length),2);
 await page.evaluate(()=>{methods.calendarRequestReadPermissionChoice=r=>invoke('requestReadPermission',r);window.transform=v=>{if(v.operation==='requestReadPermission'){v.reason='unavailable';v.catalogId=null;v.choice=null;v.result={attemptId:null,requestState:'notInvoked',readAccess:'unknown'}}}});await request(page).click();await page.getByText('Reading access is unavailable or unknown. No system request was made; nothing was collected or delivered.',{exact:true}).waitFor();assert.equal(await deliver(page).isDisabled(),false,'unavailable permission port cannot invent or erase prior native-owned admission hint');
 await page.evaluate(()=>{ui.invalidate();catalog=structuredClone(template);calls=[];window.transform=null});await page.getByRole('button',{name:'Load saved Calendar connections',exact:true}).click();await page.getByLabel('Saved Calendar connection',{exact:true}).selectOption('1');assert.equal(await page.getByRole('button',{name:'Request Reminders reading',exact:true}).isDisabled(),true);assert.deepEqual(await page.evaluate(()=>calls.map(c=>c.operation)),['list']);
});
