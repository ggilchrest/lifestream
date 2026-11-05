import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
async function fixture(t){
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
 const dir=await mkdtemp(join(tmpdir(),'calendar-local-setup-ui-')),entry=join(dir,'entry.js');
 await writeFile(entry,`import {createCalendarLocalSetupView} from ${JSON.stringify(fileURLToPath(new URL('../web/calendar-local-setup-view.js',import.meta.url)))};
 window.calls=[];window.pending=[];window.wait=false;window.allowed=true;window.visible=true;window.ownerVersion=1;window.endpoint='synthetic-endpoint';window.revision=1;
 window.template={schemaVersion:'1.0.0',state:'available',reason:'ready',catalogId:'00000000-0000-4000-8000-000000000001',choices:[1,2].map(i=>({choice:'00000000-0000-4000-8000-00000000000'+(i+1),label:'Synthetic saved connection '+i,destinationLabel:'Synthetic destination',dataLabel:i===1?'Calendar events':'Reminders',scope:'existingRemoteLocalSetupOnly'}))};window.catalog=structuredClone(template);
 window.delivery={state:'emptyPending'};
 window.reply=(operation,request)=>({schemaVersion:'1.0.0',operation:'setupLocal',catalogId:request.catalogId,choice:request.choice,reason:'ready',result:{attemptId:'00000000-0000-4000-8000-000000000010',persistence:'saved',availability:'available'}});
 window.invoke=(operation,request)=>{calls.push({operation,request:structuredClone(request)});const value=operation==='list'?structuredClone(catalog):reply(operation,request);if(window.transform&&operation!=='list')window.transform(value);return window.wait?new Promise(resolve=>pending.push({operation,request,resolve})):Promise.resolve(value)};
 const methods={calendarLocalSetupChoices:r=>invoke('list',r),calendarSetupExistingChoice:r=>invoke('setup',r)};
 window.native=new Proxy(methods,{get:(o,k)=>{if(!Object.hasOwn(o,k))throw Error('Forbidden native port '+String(k));return o[k]}});
 window.ui=createCalendarLocalSetupView({root:document.querySelector('#root'),native,owner:()=>allowed&&visible?{version:ownerVersion,endpoint,revision}:null,current:o=>allowed&&visible&&o.version===ownerVersion&&o.endpoint===endpoint&&o.revision===revision});`);
 await build({entryPoints:[entry],outfile:join(dir,'bundle.js'),bundle:true,platform:'browser'});
 const browser=await chromium.launch({channel:'chrome'});t.after(async()=>{await browser.close();await rm(dir,{recursive:true,force:true})});
 const page=await browser.newPage();await page.route('**/*',route=>route.abort());await page.setContent('<div id="root"></div>');await page.addScriptTag({path:join(dir,'bundle.js')});return page;
}
async function choose(page){await page.getByRole('button',{name:'Review approved Calendar connection',exact:true}).click();await page.getByLabel('Approved Calendar connection',{exact:true}).selectOption('0')}
const setup=page=>page.getByRole('button',{name:'Set up on this phone',exact:true});
const load=page=>page.getByRole('button',{name:'Review approved Calendar connection',exact:true});
test('first local setup is explicit opaque and never reconnects or delivers',{timeout:30000},async t=>{
 const page=await fixture(t);assert.equal(await page.evaluate(()=>calls.length),0);
 await choose(page);assert.equal(await page.evaluate(()=>calls.length),1,'selection is inert');await setup(page).click();
 await page.getByText('Local setup saved. Reconnect the saved connection separately when ready. No data was collected or delivered.',{exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>calls.map(c=>c.operation)),['list','setup']);assert.deepEqual(await page.evaluate(()=>calls[0].request),{});
 assert.deepEqual(await page.evaluate(()=>Object.keys(calls[1].request).sort()),['catalogId','choice','schemaVersion']);assert.equal(await setup(page).isDisabled(),true);assert.equal(await load(page).isDisabled(),true);
 await setup(page).evaluate(b=>b.dispatchEvent(new Event('click')));assert.equal(await page.evaluate(()=>calls.length),2,'saved setup never automatically repeated');
});
test('closed local replies preserve saved unknown and notApplied truthfully',{timeout:30000},async t=>{
 const page=await fixture(t);
 for(const bad of ['unavailable','extra','native-id','long-label','overflow','wrong-kind','bad-handle','duplicate']){
  await page.evaluate(bad=>{ui.invalidate();catalog=structuredClone(template);if(bad==='unavailable')catalog={schemaVersion:'1.0.0',state:'unavailable',reason:'no_configuration',catalogId:null,choices:[]};if(bad==='extra')catalog.extra=true;if(bad==='native-id')catalog.choices[0].enrollmentId='forbidden';if(bad==='long-label')catalog.choices[0].label='x'.repeat(121);if(bad==='overflow')catalog.choices=Array.from({length:9},()=>template.choices[0]);if(bad==='wrong-kind')catalog.choices[0].scope='existingSavedOnly';if(bad==='bad-handle')catalog.catalogId='native-selector';if(bad==='duplicate')catalog.choices[1].choice=catalog.choices[0].choice},bad);
  await load(page).click();assert.equal(await page.getByLabel('Approved Calendar connection',{exact:true}).isVisible(),false,bad);
 }
 for(const state of ['saved','saved-unavailable','unconfirmed','notApplied','extra','null-attempt','wrong-choice','unknown-available']){
  await page.evaluate(state=>{ui.invalidate();catalog=structuredClone(template);calls=[];window.transform=v=>{
   if(['saved-unavailable','unconfirmed','notApplied'].includes(state)){v.reason='unavailable';v.catalogId=null;v.choice=null;v.result.availability='unavailable';if(state!=='saved-unavailable')v.result.persistence=state;if(state==='notApplied')v.result.attemptId=null}
   if(state==='extra')v.result.enrollmentId='forbidden';if(state==='null-attempt')v.result.attemptId=null;if(state==='wrong-choice')v.choice=template.catalogId;if(state==='unknown-available')v.result.persistence='unconfirmed';
  }},state);
  await choose(page);await setup(page).click();
  const text=state==='saved'?'Local setup saved. Reconnect the saved connection separately when ready. No data was collected or delivered.':state==='saved-unavailable'?'Local setup was saved, but this connection is now unavailable. No further action has been started.':state==='unconfirmed'?'Local setup is unconfirmed. The original attempt remains held; no further action has been started.':state==='notApplied'?'Local setup was not applied. Review the connection before trying again.':'The setup result could not be confirmed. No further action has been started.';
  await page.getByText(text,{exact:true}).waitFor();assert.equal(await setup(page).isDisabled(),state!=='notApplied',state);assert.deepEqual(await page.evaluate(()=>calls.map(c=>c.operation)),['list','setup']);
 }
});
test('local setup owner view selection ABA duplicate and late fences',{timeout:30000},async t=>{
 const page=await fixture(t);
 for(const drift of ['duplicate','selection-ABA','owner','endpoint','revision','visibility','settings-exit']){
  await page.evaluate(()=>{ui.invalidate();catalog=structuredClone(template);calls=[];pending=[];wait=false;allowed=true;visible=true;window.transform=null});await choose(page);await page.evaluate(()=>wait=true);await setup(page).click();await page.waitForFunction(()=>pending.length===1);
  await setup(page).evaluate(b=>b.dispatchEvent(new Event('click')));assert.equal(await page.evaluate(()=>calls.filter(c=>c.operation==='setup').length),1);
  await page.evaluate(drift=>{if(drift==='selection-ABA'){const s=document.querySelector('select');s.value='1';s.dispatchEvent(new Event('change'));s.value='0';s.dispatchEvent(new Event('change'))}if(drift==='owner')ownerVersion++;if(drift==='endpoint')endpoint+='-changed';if(drift==='revision')revision++;if(drift==='visibility')visible=false;if(drift==='settings-exit')ui.invalidate();pending[0].resolve(reply('setup',pending[0].request));wait=false},drift);
  const text='Local setup saved. Reconnect the saved connection separately when ready. No data was collected or delivered.';
  if(drift==='duplicate')await page.getByText(text,{exact:true}).waitFor();else{await page.waitForTimeout(20);assert.equal(await page.getByText(text,{exact:true}).count(),0,drift)}
  assert.deepEqual(await page.evaluate(()=>calls.map(c=>c.operation)),['list','setup']);
 }
 await page.evaluate(()=>{ui.invalidate();allowed=false;calls=[]});await load(page).click();assert.equal(await page.evaluate(()=>calls.length),0,'unavailable owner makes no native call');
});
